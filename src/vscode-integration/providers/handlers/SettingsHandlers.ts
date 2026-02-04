/**
 * SettingsHandlers - Handles settings and configuration operations
 *
 * Extracted from SimplifiedWorkflowCanvasProvider to comply with CLAUDE.md file size limits
 * MVP: Manages configuration without AI provider manager (prompt platform approach)
 */

import * as vscode from 'vscode';
import { logCanvas, logError } from '../../../shared/utils/Logger';
import { TestSettings, CLISettings, ProjectContext } from '../../../shared/types';
import { ScaffoldingService } from '../../../core/workflows/ScaffoldingService';

export class SettingsHandlers {
    constructor(
        private readonly webview: vscode.Webview,
        private readonly context: vscode.ExtensionContext
    ) {}

    /**
     * Update models and embedding configuration
     */
    async handleUpdateModels(models: any[], strategy: any, embedding?: any): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('tdad');

            await config.update('models', models, vscode.ConfigurationTarget.Global);
            logCanvas('Models configuration updated');

            if (strategy) {
                await config.update('strategy', strategy, vscode.ConfigurationTarget.Global);
                logCanvas('Retry strategy updated');
            }

            if (embedding) {
                await config.update('embedding', embedding, vscode.ConfigurationTarget.Global);
                logCanvas(`Embedding configuration updated: ${embedding.provider}/${embedding.model}`);
            }

            vscode.window.showInformationMessage('Settings saved successfully!');
        } catch (error) {
            logError('CANVAS', 'Failed to update models configuration', error);
            vscode.window.showErrorMessage('Failed to save settings: ' + (error instanceof Error ? error.message : 'Unknown error'));
        }
    }

    /**
     * MVP: Save API key (for user's external AI assistant usage)
     */
    async handleSaveApiKey(provider: string, apiKey: string): Promise<void> {
        try {
            await this.context.secrets.store(`tdad.${provider}.apiKey`, apiKey);
            vscode.window.showInformationMessage(`${provider.toUpperCase()} API key saved successfully!`);
        } catch (error) {
            logError('CANVAS', `Failed to save API key for ${provider}`, error);
            vscode.window.showErrorMessage(`Failed to save API key: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * MVP: Test AI connection (no direct connection - user uses external AI assistants)
     */
    async handleTestAIConnection(provider: string): Promise<void> {
        try {
            const hasKey = !!(await this.context.secrets.get(`tdad.${provider}.apiKey`));
            if (hasKey) {
                vscode.window.showInformationMessage(`${provider.toUpperCase()} API key is stored. Use it in your AI assistant (Claude Code, Cursor, etc.)`);
            } else {
                vscode.window.showWarningMessage(`No ${provider.toUpperCase()} API key found. Please save it first.`);
            }
        } catch (error) {
            logError('CANVAS', `Failed to test connection for ${provider}`, error);
            vscode.window.showErrorMessage(`Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Update project context (Tech Stack, Project Type, Database)
     */
    async handleUpdateProjectContext(projectContext: ProjectContext): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('tdad');

            await config.update('project.techStack', projectContext.techStack, vscode.ConfigurationTarget.Workspace);
            if (projectContext.techStackCustom !== undefined) {await config.update('project.techStackCustom', projectContext.techStackCustom, vscode.ConfigurationTarget.Workspace);}
            
            await config.update('project.projectType', projectContext.projectType, vscode.ConfigurationTarget.Workspace);
            if (projectContext.projectTypeCustom !== undefined) {await config.update('project.projectTypeCustom', projectContext.projectTypeCustom, vscode.ConfigurationTarget.Workspace);}
            
            await config.update('project.database', projectContext.database, vscode.ConfigurationTarget.Workspace);
            if (projectContext.databaseCustom !== undefined) {await config.update('project.databaseCustom', projectContext.databaseCustom, vscode.ConfigurationTarget.Workspace);}
            
            await config.update('project.sourceRoot', projectContext.sourceRoot, vscode.ConfigurationTarget.Workspace);
            await config.update('project.docsRoot', projectContext.docsRoot, vscode.ConfigurationTarget.Workspace);

            logCanvas('Project context updated');
            vscode.window.showInformationMessage('Project settings saved successfully!');
        } catch (error) {
            logError('CANVAS', 'Failed to update project context', error);
            vscode.window.showErrorMessage('Failed to save project settings: ' + (error instanceof Error ? error.message : 'Unknown error'));
        }
    }

    /**
     * Update test settings (uses Playwright for E2E/integration tests)
     */
    async handleUpdateTestSettings(testSettings: TestSettings, urls?: Record<string, string>): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('tdad');

            await config.update('testTypes', testSettings.types, vscode.ConfigurationTarget.Workspace);
            await config.update('testCoverage', testSettings.coverage, vscode.ConfigurationTarget.Workspace);

            // Save workers setting (default: 1 to prevent race conditions)
            const workers = testSettings.workers ?? 1;
            await config.update('test.workers', workers, vscode.ConfigurationTarget.Workspace);

            // Save URLs if provided and regenerate playwright.config.js
            if (urls) {
                await config.update('test.urls', urls, vscode.ConfigurationTarget.Workspace);
            }

            // Regenerate .tdad/playwright.config.js with updated URLs and workers
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                const workspacePath = workspaceFolders[0].uri.fsPath;
                const scaffoldingService = new ScaffoldingService();
                const currentUrls = urls ?? config.get<Record<string, string>>('test.urls') ?? {};
                scaffoldingService.scaffoldPlaywrightConfig(workspacePath, currentUrls, workers);
                logCanvas(`.tdad/playwright.config.js regenerated with workers: ${workers}`);
            }

            logCanvas('Test settings updated');
            vscode.window.showInformationMessage('Test settings saved successfully!');
        } catch (error) {
            logError('CANVAS', 'Failed to update test settings', error);
            vscode.window.showErrorMessage('Failed to save test settings: ' + (error instanceof Error ? error.message : 'Unknown error'));
        }
    }

    /**
     * Update CLI/Autopilot settings
     */
    async handleUpdateCLISettings(cliSettings: CLISettings): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('tdad');

            await config.update('agent.cli.enabled', cliSettings.enabled, vscode.ConfigurationTarget.Workspace);
            await config.update('agent.cli.command', cliSettings.command, vscode.ConfigurationTarget.Workspace);

            // Save permission flags for each CLI
            if (cliSettings.permissionFlags) {
                await config.update('agent.cli.permissionFlags', cliSettings.permissionFlags, vscode.ConfigurationTarget.Workspace);
            }

            logCanvas('CLI/Autopilot settings updated');
            vscode.window.showInformationMessage('Autopilot settings saved successfully!');
        } catch (error) {
            logError('CANVAS', 'Failed to update CLI settings', error);
            vscode.window.showErrorMessage('Failed to save autopilot settings: ' + (error instanceof Error ? error.message : 'Unknown error'));
        }
    }

    /**
     * Update CLI settings from Autopilot dialog (preset + skipPermissions)
     * Saves permanently like Settings modal
     */
    async handleUpdateCLISettingsFromDialog(preset: string, skipPermissions: boolean): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('tdad');

            // Map preset to command
            const presetCommands: Record<string, string> = {
                'claude': 'claude "Read .tdad/NEXT_TASK.md and execute the task. When done, write DONE to .tdad/AGENT_DONE.md"',
                'aider': 'aider --message "{prompt}"',
                'codex': 'codex "{prompt}"'
            };

            // Only update command if not custom
            if (preset !== 'custom' && presetCommands[preset]) {
                await config.update('agent.cli.command', presetCommands[preset], vscode.ConfigurationTarget.Workspace);
            }

            // Update permission flags
            const currentFlags = config.get<any>('agent.cli.permissionFlags') || {};
            const updatedFlags = {
                ...currentFlags,
                claude: { dangerouslySkipPermissions: skipPermissions },
                aider: currentFlags.aider || { yesAlways: false, autoCommit: false },
                codex: currentFlags.codex || { autoApprove: false }
            };
            await config.update('agent.cli.permissionFlags', updatedFlags, vscode.ConfigurationTarget.Workspace);

            logCanvas(`CLI settings saved from dialog: preset=${preset}, skipPermissions=${skipPermissions}`);
        } catch (error) {
            logError('CANVAS', 'Failed to update CLI settings from dialog', error);
        }
    }

}
