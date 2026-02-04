import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { logger } from '../shared/utils/Logger';
import { FeatureGating } from '../shared/utils/FeatureGating';

/**
 * CLIAgentLauncher - Sprint 14: Hands-Free Automation for CLI Agents
 *
 * Launches any CLI-based AI agent via VS Code terminal.
 * Supports configurable command templates for different agents:
 * - Claude Code: claude "{prompt}"
 * - Aider: aider --message "{prompt}"
 * - Custom: any CLI command with {prompt} and {file} placeholders
 */

export interface CLIPermissionFlags {
    claude: {
        dangerouslySkipPermissions: boolean;
    };
    aider: {
        yesAlways: boolean;
        autoCommit: boolean;
    };
    codex: {
        autoApprove: boolean;
    };
}

const DEFAULT_PERMISSION_FLAGS: CLIPermissionFlags = {
    claude: { dangerouslySkipPermissions: false },
    aider: { yesAlways: false, autoCommit: false },
    codex: { autoApprove: false }
};

export interface CLIAgentConfig {
    enabled: boolean;
    command: string;  // e.g., 'claude "{prompt}"' or 'aider --message "{prompt}"'
    permissionFlags: CLIPermissionFlags;
}

export interface CLIOverrides {
    preset: string;
    skipPermissions: boolean;
}

export class CLIAgentLauncher {
    private static instance: CLIAgentLauncher | null = null;
    private terminal: vscode.Terminal | null = null;
    private readonly terminalName = 'TDAD Agent';
    private workspacePath: string;
    private slackOutputEnabled: boolean = false;
    private cliOverrides: CLIOverrides | null = null;

    private constructor(workspacePath: string) {
        this.workspacePath = workspacePath;
    }

    /**
     * Enable/disable Slack output capture
     * When enabled, CLI output is tee'd to a log file for Slack streaming
     */
    public setSlackOutputEnabled(enabled: boolean): void {
        this.slackOutputEnabled = enabled;
        logger.log('CLI-AGENT-LAUNCHER', `Slack output capture: ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Get the path to the CLI output log file
     */
    public getOutputLogPath(): string {
        return path.join(this.workspacePath, '.tdad', 'logs', 'cli-output.log');
    }

    /**
     * Ensure logs directory exists and clear the log file
     * Handles EBUSY errors on Windows when file is locked by Start-Transcript
     */
    private prepareLogFile(): void {
        const logPath = this.getOutputLogPath();
        const logsDir = path.dirname(logPath);

        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        // Clear the log file - handle EBUSY if file is locked by previous transcript
        try {
            fs.writeFileSync(logPath, '');
        } catch (error: unknown) {
            const err = error as NodeJS.ErrnoException;
            if (err.code === 'EBUSY') {
                logger.log('CLI-AGENT-LAUNCHER', 'Log file is busy (locked by previous transcript), continuing anyway');
            } else {
                throw error;
            }
        }
    }

    public static getInstance(workspacePath?: string): CLIAgentLauncher {
        if (!CLIAgentLauncher.instance && workspacePath) {
            CLIAgentLauncher.instance = new CLIAgentLauncher(workspacePath);
        }
        return CLIAgentLauncher.instance!;
    }

    /**
     * Set CLI overrides for the next automation run
     * These override the saved settings temporarily
     */
    public setCliOverrides(overrides: CLIOverrides | null): void {
        this.cliOverrides = overrides;
        logger.log('CLI-AGENT-LAUNCHER', `CLI overrides set: ${overrides ? JSON.stringify(overrides) : 'cleared'}`);
    }

    /**
     * Clear CLI overrides
     */
    public clearCliOverrides(): void {
        this.cliOverrides = null;
    }

    /**
     * Get configuration from VS Code settings, with optional overrides applied
     */
    public getConfig(): CLIAgentConfig {
        const config = vscode.workspace.getConfiguration('tdad');
        const savedFlags = config.get<CLIPermissionFlags>('agent.cli.permissionFlags');

        let baseConfig: CLIAgentConfig = {
            enabled: config.get('agent.cli.enabled', true),
            command: config.get('agent.cli.command', 'claude "Read .tdad/NEXT_TASK.md and execute the task. When done, write DONE to .tdad/AGENT_DONE.md"'),
            permissionFlags: savedFlags ? { ...DEFAULT_PERMISSION_FLAGS, ...savedFlags } : { ...DEFAULT_PERMISSION_FLAGS }
        };

        // Apply overrides if set
        if (this.cliOverrides) {
            const presetCommands: Record<string, string> = {
                'claude': 'claude "Read .tdad/NEXT_TASK.md and execute the task. When done, write DONE to .tdad/AGENT_DONE.md"',
                'aider': 'aider --message "{prompt}"',
                'codex': 'codex "{prompt}"'
            };

            // Override command based on preset
            if (this.cliOverrides.preset !== 'custom' && presetCommands[this.cliOverrides.preset]) {
                baseConfig.command = presetCommands[this.cliOverrides.preset];
            }

            // Override skip permissions for Claude
            if (this.cliOverrides.preset === 'claude') {
                baseConfig.permissionFlags = {
                    ...baseConfig.permissionFlags,
                    claude: { dangerouslySkipPermissions: this.cliOverrides.skipPermissions }
                };
            }

            logger.log('CLI-AGENT-LAUNCHER', `Applied overrides: preset=${this.cliOverrides.preset}, skipPermissions=${this.cliOverrides.skipPermissions}`);
        }

        return baseConfig;
    }

    /**
     * Check if CLI agent is enabled
     */
    public isEnabled(): boolean {
        return this.getConfig().enabled;
    }

    /**
     * Create a fresh terminal for each task
     * Each CLI agent invocation needs its own terminal session
     * On Windows with Slack output enabled, forces PowerShell for tee compatibility
     */
    private createFreshTerminal(): vscode.Terminal {
        // Dispose of existing terminal if it exists
        if (this.terminal) {
            try {
                this.terminal.dispose();
                logger.log('CLI-AGENT-LAUNCHER', 'Disposed previous terminal');
            } catch {
                // Terminal might already be closed
            }
            this.terminal = null;
        }

        const isWindows = os.platform() === 'win32';
        const terminalOptions: vscode.TerminalOptions = {
            name: this.terminalName,
            cwd: this.workspacePath
        };

        // On Windows with Slack output capture, use PowerShell
        // Note: Start-Transcript has limited capture for interactive TUIs
        if (isWindows && this.slackOutputEnabled) {
            terminalOptions.shellPath = 'powershell.exe';
            logger.log('CLI-AGENT-LAUNCHER', 'Using PowerShell for Slack output capture');
        }

        this.terminal = vscode.window.createTerminal(terminalOptions);
        logger.log('CLI-AGENT-LAUNCHER', `Created new TDAD Agent terminal${isWindows && this.slackOutputEnabled ? ' (PowerShell)' : ''}`);

        return this.terminal;
    }

    /**
     * Trigger the CLI agent to read and execute the task
     * Always creates a fresh terminal - sendText to existing terminal doesn't work
     * reliably with CLI agents like Claude Code
     * @param taskFile - Path to the task file (relative to workspace)
     * @param taskDescription - Optional description for logging
     */
    public triggerAgent(taskFile = '.tdad/NEXT_TASK.md', taskDescription?: string): void {
        const config = this.getConfig();

        if (!config.enabled) {
            logger.log('CLI-AGENT-LAUNCHER', 'CLI agent disabled, skipping trigger');
            return;
        }

        // Always create fresh terminal - CLI agents need their own session
        const terminal = this.createFreshTerminal();
        terminal.show(true); // Show terminal, preserve focus on editor

        // Build the command by replacing placeholders and applying permission flags
        let command = this.buildCommand(config.command, taskFile, config.permissionFlags);

        // Wrap with tee for Slack output capture if enabled
        if (this.slackOutputEnabled) {
            command = this.wrapCommandWithOutputCapture(command);
        }

        // Send command to terminal
        terminal.sendText(command);

        logger.log('CLI-AGENT-LAUNCHER', `Triggered agent: ${taskDescription || taskFile}`);
        logger.log('CLI-AGENT-LAUNCHER', `Command: ${command}`);
    }

    /**
     * Build the command by replacing placeholders and applying permission flags
     * Supported placeholders:
     * - {file} - Path to the task file
     * - {prompt} - Default prompt text
     */
    private buildCommand(commandTemplate: string, taskFile: string, permissionFlags: CLIPermissionFlags): string {
        const defaultPrompt = `Read ${taskFile} and execute the task. When done, write DONE to .tdad/AGENT_DONE.md. If stuck, write STUCK: [reason] instead.`;

        let command = commandTemplate;
        command = command.replace(/\{file\}/g, taskFile);
        command = command.replace(/\{prompt\}/g, defaultPrompt);

        // Apply permission flags based on detected CLI
        command = this.applyPermissionFlags(command, permissionFlags);

        return command;
    }

    /**
     * Apply permission flags to command based on detected CLI tool
     */
    private applyPermissionFlags(command: string, flags: CLIPermissionFlags): string {
        // Detect CLI and apply appropriate flags
        if (command.startsWith('claude ') || command.includes(' claude ')) {
            if (flags.claude.dangerouslySkipPermissions && !command.includes('--dangerously-skip-permissions')) {
                command = command.replace(/^claude\s+/, 'claude --dangerously-skip-permissions ');
            }
        } else if (command.startsWith('aider ') || command.includes(' aider ')) {
            let flagsToAdd = '';
            if (flags.aider.yesAlways && !command.includes('--yes')) {
                flagsToAdd += '--yes ';
            }
            if (flags.aider.autoCommit && !command.includes('--auto-commits')) {
                flagsToAdd += '--auto-commits ';
            }
            if (flagsToAdd) {
                command = command.replace(/^aider\s+/, 'aider ' + flagsToAdd);
            }
        } else if (command.startsWith('codex ') || command.includes(' codex ')) {
            if (flags.codex.autoApprove && !command.includes('--auto-approve')) {
                command = command.replace(/^codex\s+/, 'codex --auto-approve ');
            }
        }

        return command;
    }

    /**
     * Wrap command with output capture for Slack streaming
     * Handles different shell environments:
     * - Unix (bash/zsh): Uses tee command
     * - Windows: Runs interactively, uses clipboard capture for Slack output
     */
    private wrapCommandWithOutputCapture(command: string): string {
        this.prepareLogFile();
        const logPath = this.getOutputLogPath();
        const isWindows = os.platform() === 'win32';

        logger.log('CLI-AGENT-LAUNCHER', `Output log path: ${logPath}`);

        if (!isWindows) {
            // Unix: Use tee for output capture
            logger.log('CLI-AGENT-LAUNCHER', 'Unix - using tee');
            return `${command} 2>&1 | tee "${logPath}"`;
        }

        // Windows: Run Claude interactively (preserves TUI)
        // Output capture is done via clipboard snapshot (captureTerminalOutput method)
        // Write a marker to log file so we know capture method is clipboard-based
        logger.log('CLI-AGENT-LAUNCHER', 'Windows - running interactively, using clipboard capture');

        const timestamp = new Date().toISOString();
        return `@"
[TDAD] Started at ${timestamp}
[TDAD] Use 'Snapshot CLI' in Slack to capture current output
"@ | Out-File -FilePath "${logPath}" -Encoding utf8; ${command}`;
    }

    /**
     * Send a raw command to a fresh terminal
     */
    public sendRawCommand(command: string): void {
        if (!this.isEnabled()) {
            logger.log('CLI-AGENT-LAUNCHER', 'CLI agent disabled, skipping command');
            return;
        }

        const terminal = this.createFreshTerminal();
        terminal.show(true);
        terminal.sendText(command);

        logger.log('CLI-AGENT-LAUNCHER', `Sent raw command: ${command.substring(0, 80)}...`);
    }

    /**
     * Show configuration dialog before starting automation
     * Returns true if user confirms, false if cancelled
     */
    public async showConfigurationDialog(): Promise<boolean> {
        const config = this.getConfig();

        // Define agent presets
        const presets: { label: string; description: string; command: string }[] = [
            {
                label: '$(terminal) Claude Code',
                description: 'Anthropic Claude Code CLI',
                command: 'claude "Read .tdad/NEXT_TASK.md and execute the task. When done, write DONE to .tdad/AGENT_DONE.md"'
            },
            {
                label: '$(terminal) Aider',
                description: 'Aider AI pair programming',
                command: 'aider --message "{prompt}"'
            },
            {
                label: '$(terminal) Codex CLI',
                description: 'OpenAI Codex CLI',
                command: 'codex "{prompt}"'
            },
            {
                label: '$(edit) Custom Command',
                description: 'Enter your own CLI command',
                command: 'CUSTOM'
            }
        ];

        // Determine current selection
        const currentCommand = config.command;
        const currentPreset = presets.find(p => p.command === currentCommand && p.command !== 'CUSTOM');
        const currentLabel = currentPreset ? currentPreset.label : '$(edit) Custom Command';

        // Show quick pick
        const selected = await vscode.window.showQuickPick(presets, {
            placeHolder: `Current: ${currentLabel.replace('$(terminal) ', '').replace('$(edit) ', '')}`,
            title: 'Select AI Agent for Automation'
        });

        if (!selected) {
            return false; // User cancelled
        }

        let finalCommand = selected.command;

        // Handle custom command
        if (selected.command === 'CUSTOM') {
            const customCommand = await vscode.window.showInputBox({
                prompt: 'Enter CLI command (use {prompt} or {file} as placeholders)',
                value: currentCommand,
                placeHolder: 'e.g., my-agent --message "{prompt}"'
            });

            if (!customCommand) {
                return false; // User cancelled
            }

            finalCommand = customCommand;
        }

        // Save the command to settings
        const vsConfig = vscode.workspace.getConfiguration('tdad');
        await vsConfig.update('agent.cli.command', finalCommand, vscode.ConfigurationTarget.Workspace);

        logger.log('CLI-AGENT-LAUNCHER', `Agent configured: ${finalCommand}`);

        return true;
    }

    /**
     * Show a quick pick to let user choose trigger mode
     * Returns true if user wants to trigger CLI agent
     */
    public async promptForTrigger(): Promise<boolean> {
        const config = this.getConfig();

        if (config.enabled) {
            return true; // Auto-trigger if enabled
        }

        // If not enabled, ask user what to do
        const choice = await vscode.window.showInformationMessage(
            'Task written to .tdad/NEXT_TASK.md. How would you like to proceed?',
            'Trigger CLI Agent',
            'Open File',
            'Manual'
        );

        if (choice === 'Trigger CLI Agent') {
            // Enable for this session and trigger
            return true;
        } else if (choice === 'Open File') {
            // Open the NEXT_TASK.md file
            const taskFilePath = path.join(this.workspacePath, '.tdad', 'NEXT_TASK.md');
            const doc = await vscode.workspace.openTextDocument(taskFilePath);
            await vscode.window.showTextDocument(doc);
        }

        return false;
    }

    /**
     * Capture terminal output via clipboard (for Windows interactive mode)
     * Uses keyboard shortcuts to select all and copy terminal content
     * @returns The terminal content or null if capture failed
     */
    public async captureTerminalOutput(): Promise<string | null> {
        const terminal = this.terminal || vscode.window.terminals.find(t => t.name === this.terminalName);
        if (!terminal) {
            logger.log('CLI-AGENT-LAUNCHER', 'No terminal found for capture');
            return null;
        }

        try {
            // Show terminal and give it focus
            terminal.show(false); // false = take focus

            // Small delay to ensure terminal is focused
            await new Promise(resolve => setTimeout(resolve, 100));

            // Select all text in terminal (Ctrl+Shift+A on Windows, Cmd+A on Mac)
            await vscode.commands.executeCommand('workbench.action.terminal.selectAll');

            // Small delay for selection
            await new Promise(resolve => setTimeout(resolve, 50));

            // Copy selection to clipboard
            await vscode.commands.executeCommand('workbench.action.terminal.copySelection');

            // Small delay for clipboard
            await new Promise(resolve => setTimeout(resolve, 50));

            // Read from clipboard
            const content = await vscode.env.clipboard.readText();

            // Clear selection to restore terminal state
            await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');

            logger.log('CLI-AGENT-LAUNCHER', `Captured ${content.length} chars from terminal`);
            return content;

        } catch (error) {
            logger.error('CLI-AGENT-LAUNCHER', 'Failed to capture terminal output', error);
            return null;
        }
    }

    /**
     * Kill the running CLI agent by disposing the terminal
     * Disposing is more reliable than Ctrl+C, especially for Claude Code
     * @returns true if terminal was found and disposed
     */
    public killTerminal(): boolean {
        // Try our managed terminal first
        if (this.terminal) {
            this.terminal.dispose();
            this.terminal = null;
            logger.log('CLI-AGENT-LAUNCHER', 'Disposed managed terminal');
            return true;
        }

        // Fallback: find and dispose any TDAD Agent terminal
        const terminal = vscode.window.terminals.find(t => t.name === this.terminalName);
        if (terminal) {
            terminal.dispose();
            logger.log('CLI-AGENT-LAUNCHER', 'Disposed found TDAD Agent terminal');
            return true;
        }

        logger.log('CLI-AGENT-LAUNCHER', 'No TDAD Agent terminal found to kill');
        return false;
    }

    /**
     * Dispose of the terminal
     */
    public dispose(): void {
        if (this.terminal) {
            this.terminal.dispose();
            this.terminal = null;
        }
        CLIAgentLauncher.instance = null;
        logger.log('CLI-AGENT-LAUNCHER', 'Disposed');
    }
}
