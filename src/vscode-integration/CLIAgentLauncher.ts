import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { logger } from '../shared/utils/Logger';
import { CLIPermissionFlags, DEFAULT_PERMISSION_FLAGS } from '../shared/types';

/**
 * CLIAgentLauncher - Hands-Free Automation for CLI Agents
 *
 * Launches any CLI-based AI agent via VS Code terminal.
 * Supports multiple concurrent terminals for parallel node execution.
 * Supports configurable command templates for different agents:
 * - Claude Code: claude "{prompt}"
 * - Aider: aider --message "{prompt}"
 * - Custom: any CLI command with {prompt} and {file} placeholders
 */

export interface CLIAgentConfig {
    enabled: boolean;
    command: string;  // e.g., 'claude "{prompt}"' or 'aider --message "{prompt}"'
    permissionFlags: CLIPermissionFlags;
}

export class CLIAgentLauncher {
    private static instance: CLIAgentLauncher | null = null;
    private terminals: Map<string, vscode.Terminal> = new Map();
    private readonly defaultTerminalId = '__default__';
    private workspacePath: string;
    private slackOutputEnabled: boolean = false;

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
     * Get configuration from VS Code settings
     */
    public getConfig(): CLIAgentConfig {
        const config = vscode.workspace.getConfiguration('tdad');
        const savedFlags = config.get<CLIPermissionFlags>('agent.cli.permissionFlags');
        return {
            enabled: config.get('agent.cli.enabled', true),
            command: config.get('agent.cli.command', 'claude "{prompt}"'),
            permissionFlags: savedFlags ? { ...DEFAULT_PERMISSION_FLAGS, ...savedFlags } : DEFAULT_PERMISSION_FLAGS
        };
    }

    /**
     * Check if CLI agent is enabled
     */
    public isEnabled(): boolean {
        return this.getConfig().enabled;
    }

    /**
     * Create a fresh terminal for a given ID.
     * Each CLI agent invocation needs its own terminal session.
     * On Windows with Slack output enabled, forces PowerShell for tee compatibility.
     * @param terminalId - Unique identifier for this terminal (nodeId or default)
     */
    private createFreshTerminal(terminalId?: string): vscode.Terminal {
        const id = terminalId || this.defaultTerminalId;

        // Dispose of existing terminal with same ID if it exists
        const existing = this.terminals.get(id);
        if (existing) {
            try {
                existing.dispose();
                logger.log('CLI-AGENT-LAUNCHER', `Disposed previous terminal: ${id}`);
            } catch {
                // Terminal might already be closed
            }
            this.terminals.delete(id);
        }

        const isWindows = os.platform() === 'win32';
        const terminalName = terminalId ? `TDAD Agent - ${terminalId}` : 'TDAD Agent';
        const terminalOptions: vscode.TerminalOptions = {
            name: terminalName,
            cwd: this.workspacePath
        };

        // On Windows with Slack output capture, use PowerShell
        if (isWindows && this.slackOutputEnabled) {
            terminalOptions.shellPath = 'powershell.exe';
            logger.log('CLI-AGENT-LAUNCHER', 'Using PowerShell for Slack output capture');
        }

        const terminal = vscode.window.createTerminal(terminalOptions);
        this.terminals.set(id, terminal);
        logger.log('CLI-AGENT-LAUNCHER', `Created terminal: ${terminalName}`);

        return terminal;
    }

    /**
     * Trigger the CLI agent to read and execute the task
     * Always creates a fresh terminal - sendText to existing terminal doesn't work
     * reliably with CLI agents like Claude Code
     * @param taskFile - Path to the task file (relative to workspace)
     * @param taskDescription - Optional description for logging
     * @param terminalId - Optional terminal ID for parallel execution (e.g., nodeId)
     */
    public triggerAgent(taskFile = '.tdad/NEXT_TASK.md', taskDescription?: string, terminalId?: string): void {
        const config = this.getConfig();

        if (!config.enabled) {
            logger.log('CLI-AGENT-LAUNCHER', 'CLI agent disabled, skipping trigger');
            return;
        }

        // Always create fresh terminal - CLI agents need their own session
        const terminal = this.createFreshTerminal(terminalId);
        terminal.show(true); // Show terminal, preserve focus on editor

        // Build the command by replacing placeholders and applying permission flags
        let command = this.buildCommand(config.command, taskFile, config.permissionFlags);

        // Wrap with tee for Slack output capture if enabled
        if (this.slackOutputEnabled) {
            command = this.wrapCommandWithOutputCapture(command);
        }

        // Send command to terminal
        terminal.sendText(command);

        logger.log('CLI-AGENT-LAUNCHER', `Triggered agent (terminal=${terminalId || 'default'}): ${taskDescription || taskFile}`);
        logger.log('CLI-AGENT-LAUNCHER', `Command: ${command}`);
    }

    /**
     * Build the command by replacing placeholders and applying permission flags
     * Derives AGENT_DONE path from taskFile path for per-node isolation.
     * Supported placeholders:
     * - {file} - Path to the task file
     * - {prompt} - Default prompt text
     */
    private buildCommand(commandTemplate: string, taskFile: string, permissionFlags: CLIPermissionFlags): string {
        // Derive AGENT_DONE path from task file path (supports per-node isolation)
        // Use both / and \ to handle Windows paths (path.sep produces backslashes)
        const lastSep = Math.max(taskFile.lastIndexOf('/'), taskFile.lastIndexOf('\\'));
        const taskDir = lastSep > 0 ? taskFile.substring(0, lastSep) : '';
        const sep = taskFile.includes('\\') ? '\\' : '/';
        const agentDoneFile = taskDir ? `${taskDir}${sep}AGENT_DONE.md` : '.tdad/AGENT_DONE.md';

        const defaultPrompt = `Read ${taskFile} and execute the task. When done, write DONE to ${agentDoneFile}. If stuck, write STUCK: [reason] instead.`;

        let command = commandTemplate;
        command = command.replace(/\{file\}/g, taskFile);
        command = command.replace(/\{prompt\}/g, defaultPrompt);

        // Replace hardcoded legacy paths for backward compatibility with existing saved settings
        // This ensures per-node paths work even when the command template has no {prompt}/{file} placeholders
        // Handle both / and \ path separators (Windows vs Unix)
        command = command.replace(/\.tdad[/\\]NEXT_TASK\.md/g, taskFile);
        command = command.replace(/\.tdad[/\\]AGENT_DONE\.md/g, agentDoneFile);

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
            if (flags.codex.dangerouslyBypassApprovalsAndSandbox && !command.includes('--dangerously-bypass-approvals-and-sandbox')) {
                command = command.replace(/^codex\s+/, 'codex --dangerously-bypass-approvals-and-sandbox ');
            }
        } else if (command.startsWith('gemini ') || command.includes(' gemini ')) {
            if (flags.gemini.yolo && !command.includes('--yolo')) {
                command = command.replace(/^gemini\s+/, 'gemini --yolo ');
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
                command: 'claude "{prompt}"'
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
     * @param terminalId - Optional terminal ID to capture from
     * @returns The terminal content or null if capture failed
     */
    public async captureTerminalOutput(terminalId?: string): Promise<string | null> {
        const id = terminalId || this.defaultTerminalId;
        const terminal = this.terminals.get(id) || vscode.window.terminals.find(t => t.name === 'TDAD Agent');
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
     * @param terminalId - Optional: kill specific terminal. If omitted, kills all TDAD terminals.
     * @returns true if terminal was found and disposed
     */
    public killTerminal(terminalId?: string): boolean {
        if (terminalId) {
            // Kill specific terminal
            const terminal = this.terminals.get(terminalId);
            if (terminal) {
                terminal.dispose();
                this.terminals.delete(terminalId);
                logger.log('CLI-AGENT-LAUNCHER', `Disposed terminal: ${terminalId}`);
                return true;
            }
            return false;
        }

        // Kill all TDAD terminals
        if (this.terminals.size > 0) {
            const count = this.terminals.size;
            for (const [, terminal] of this.terminals) {
                try {
                    terminal.dispose();
                } catch {
                    // Terminal might already be closed
                }
            }
            this.terminals.clear();
            logger.log('CLI-AGENT-LAUNCHER', `Disposed all ${count} TDAD terminals`);
            return true;
        }

        // Fallback: find and dispose any TDAD Agent terminal by name
        const terminal = vscode.window.terminals.find(t => t.name.startsWith('TDAD Agent'));
        if (terminal) {
            terminal.dispose();
            logger.log('CLI-AGENT-LAUNCHER', 'Disposed found TDAD Agent terminal');
            return true;
        }

        logger.log('CLI-AGENT-LAUNCHER', 'No TDAD Agent terminal found to kill');
        return false;
    }

    /**
     * Dispose of all terminals and clean up
     */
    public dispose(): void {
        for (const [, terminal] of this.terminals) {
            try {
                terminal.dispose();
            } catch {
                // Terminal might already be closed
            }
        }
        this.terminals.clear();
        CLIAgentLauncher.instance = null;
        logger.log('CLI-AGENT-LAUNCHER', 'Disposed');
    }
}
