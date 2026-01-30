/**
 * SlackInitializer - Handles Slack service initialization and dependencies
 * Extracted from extension.ts to reduce file size and eliminate code duplication
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logExtension, logError } from '../shared/utils/Logger';
import { filterTranscriptNoise } from '../shared/utils/PowerShellTranscriptFilter';
import { SlackService, SlackCommandHandler, SlackCommandDependencies, buildHelpBlocks } from '../infrastructure/slack';
import { CLIAgentLauncher } from './CLIAgentLauncher';
import { SimplifiedWorkflowCanvasProvider } from './providers/SimplifiedWorkflowCanvasProvider';
import { FeatureMapStorage } from '../infrastructure/storage/FeatureMapStorage';
import { getFeatureFilePath } from '../shared/utils/nodePathUtils';
import { Node } from '../shared/types';

/**
 * Create SlackCommandDependencies object for a given workspace
 */
export function createSlackCommandDependencies(workspacePath: string): SlackCommandDependencies {
    return {
        // Node retrieval
        getNodes: () => {
            try {
                const storage = new FeatureMapStorage();
                return storage.loadAll();
            } catch {
                return [];
            }
        },
        addNode: (node: Partial<Node>) => {
            SimplifiedWorkflowCanvasProvider.currentPanel?.addNodeFromSlack(node as Node);
        },

        // Node management
        updateNode: (node: Node) => {
            try {
                const storage = new FeatureMapStorage();
                storage.updateNodeById(node);
                logExtension(`updateNode: Saved node ${node.id} (${node.title}) to storage`);
            } catch (error) {
                logError('EXTENSION', `updateNode: Failed to save node ${node.id}`, error);
            }
            SimplifiedWorkflowCanvasProvider.currentPanel?.updateNodeFromSlack(node);
        },
        getNodeById: (nodeId: string) => {
            try {
                const storage = new FeatureMapStorage();
                return storage.loadAll().find(n => n.id === nodeId);
            } catch {
                return undefined;
            }
        },

        // Plan management
        getPlanSpec: async (nodeId: string) => {
            try {
                const storage = new FeatureMapStorage();
                const nodes = storage.loadAll();
                const node = nodes.find(n => n.id === nodeId);
                if (!node) {
                    logExtension(`getPlanSpec: Node not found: ${nodeId}`);
                    return null;
                }

                logExtension(`getPlanSpec: Node ${node.title}, workflowId=${node.workflowId}, fileName=${(node as any).fileName}`);

                const planFile = (node as any).planFile;
                if (!planFile) {
                    const featurePath = getFeatureFilePath(node.workflowId || '', (node as any).fileName || node.title);
                    const fullPath = path.join(workspacePath, featurePath);
                    logExtension(`getPlanSpec: Looking for Plan at: ${fullPath}`);
                    if (fs.existsSync(fullPath)) {
                        logExtension(`getPlanSpec: Found Plan file`);
                        return fs.readFileSync(fullPath, 'utf-8');
                    }
                    logExtension(`getPlanSpec: Plan file not found`);
                    return null;
                }

                const fullPath = path.join(workspacePath, planFile);
                logExtension(`getPlanSpec: Using planFile: ${fullPath}`);
                if (fs.existsSync(fullPath)) {
                    return fs.readFileSync(fullPath, 'utf-8');
                }
                return null;
            } catch (error) {
                logError('EXTENSION', 'getPlanSpec failed', error);
                return null;
            }
        },
        savePlanSpec: async (nodeId: string, spec: string) => {
            const storage = new FeatureMapStorage();
            const nodes = storage.loadAll();
            const node = nodes.find(n => n.id === nodeId);
            if (!node) {
                logExtension(`savePlanSpec: Node not found: ${nodeId}`);
                throw new Error(`Node not found: ${nodeId}`);
            }

            logExtension(`savePlanSpec: Node ${node.title}, workflowId=${node.workflowId}, fileName=${(node as any).fileName}`);

            const featurePath = getFeatureFilePath(node.workflowId || '', (node as any).fileName || node.title);
            const fullPath = path.join(workspacePath, featurePath);

            logExtension(`savePlanSpec: Saving to: ${fullPath}`);

            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(fullPath, spec, 'utf-8');
            logExtension(`savePlanSpec: Saved Plan for ${node.title} to ${featurePath}`);
        },

        // Automation
        startAutomation: async () => {
            if (!SimplifiedWorkflowCanvasProvider.currentPanel) {
                logExtension('startAutomation: Canvas panel not open');
                throw new Error('Please open the TDAD Canvas first (Ctrl+Shift+P > TDAD: Open Canvas)');
            }
            SimplifiedWorkflowCanvasProvider.currentPanel.sendMessage({ command: 'startAutomation' });
        },
        stopAutomation: () => {
            const cliLauncher = CLIAgentLauncher.getInstance(workspacePath);
            cliLauncher.killTerminal();

            if (SimplifiedWorkflowCanvasProvider.currentPanel) {
                SimplifiedWorkflowCanvasProvider.currentPanel.stopAllAutomation();
            }

            const stateFile = path.join(workspacePath, '.tdad', 'automation-state.json');
            if (fs.existsSync(stateFile)) {
                fs.unlinkSync(stateFile);
                logExtension('Cleared automation-state.json');
            }
            logExtension('stopAutomation: All automation stopped');
        },
        getAutomationStatus: () => {
            if (!SimplifiedWorkflowCanvasProvider.currentPanel) {
                return { status: 'canvas_not_open', message: 'Open TDAD Canvas to see status' };
            }
            return SimplifiedWorkflowCanvasProvider.currentPanel.getAutomationStatus() || { status: 'unknown' };
        },
        runNodeTests: async (nodeId: string) => {
            if (!SimplifiedWorkflowCanvasProvider.currentPanel) {
                logExtension('runNodeTests: Canvas panel not open');
                throw new Error('Please open the TDAD Canvas first (Ctrl+Shift+P > TDAD: Open Canvas)');
            }
            SimplifiedWorkflowCanvasProvider.currentPanel.sendMessage({ command: 'runTests', nodeId });
        },
        runSingleNode: async (nodeId: string, modes: string[]) => {
            if (!SimplifiedWorkflowCanvasProvider.currentPanel) {
                logExtension('runSingleNode: Canvas panel not open');
                return { started: false, error: 'Please open the TDAD Canvas first (Ctrl+Shift+P > TDAD: Open Canvas)' };
            }
            logExtension(`runSingleNode: Calling direct automation for ${nodeId} with modes [${modes.join(', ')}]`);
            return await SimplifiedWorkflowCanvasProvider.currentPanel.runSingleNodeAutomation(nodeId, modes as ('bdd' | 'test' | 'run-fix')[]);
        },
        runFolderNodes: async (folderId: string | null, modes?: ('bdd' | 'test' | 'run-fix')[]) => {
            if (!SimplifiedWorkflowCanvasProvider.currentPanel) {
                logExtension('runFolderNodes: Canvas panel not open');
                throw new Error('Please open the TDAD Canvas first (Ctrl+Shift+P > TDAD: Open Canvas)');
            }
            logExtension(`runFolderNodes: folderId=${folderId}, modes=${modes?.join(', ') || 'default'}`);
            await SimplifiedWorkflowCanvasProvider.currentPanel.runAllNodesAutomation(
                folderId,
                modes || ['bdd', 'test', 'run-fix']
            );
        },

        // CLI
        getCliOutput: (lines: number) => {
            try {
                const logPath = path.join(workspacePath, '.tdad', 'logs', 'cli-output.log');
                if (!fs.existsSync(logPath)) return '';

                const content = fs.readFileSync(logPath, 'utf-8');
                const filtered = filterTranscriptNoise(content);
                const allLines = filtered.split('\n');
                return allLines.slice(-lines).join('\n');
            } catch {
                return '';
            }
        },
        captureCliOutput: async () => {
            const cliLauncher = CLIAgentLauncher.getInstance(workspacePath);
            return cliLauncher.captureTerminalOutput();
        },
        killCliTerminal: () => {
            const cliLauncher = CLIAgentLauncher.getInstance(workspacePath);
            return cliLauncher.killTerminal();
        },
        clearAutomationState: () => {
            const stateFile = path.join(workspacePath, '.tdad', 'automation-state.json');
            if (fs.existsSync(stateFile)) {
                fs.unlinkSync(stateFile);
                logExtension('Cleared automation-state.json');
            }
        },

        // Progress callback for Slack notifications
        setAutomationProgressCallback: (callback) => {
            if (SimplifiedWorkflowCanvasProvider.currentPanel) {
                SimplifiedWorkflowCanvasProvider.currentPanel.setAutomationProgressCallback(callback);
                logExtension(`setAutomationProgressCallback: ${callback ? 'set' : 'cleared'}`);
            } else {
                logExtension('setAutomationProgressCallback: Canvas panel not open');
            }
        },

        workspacePath
    };
}

export interface SlackState {
    service: SlackService | null;
    commandHandler: SlackCommandHandler | null;
}

/**
 * Connect to Slack with provided tokens
 */
export async function connectSlack(
    botToken: string,
    appToken: string,
    workspacePath: string,
    state: SlackState
): Promise<void> {
    state.service = SlackService.getInstance();
    await state.service.connect(botToken, appToken);

    logExtension('Slack service connected');

    // Enable Slack output capture
    const cliLauncher = CLIAgentLauncher.getInstance(workspacePath);
    cliLauncher.setSlackOutputEnabled(true);

    // Set up command handler
    const deps = createSlackCommandDependencies(workspacePath);
    state.commandHandler = new SlackCommandHandler(state.service, deps);

    // Register slash command handler
    state.service.onSlashCommand(async () => {
        return {
            text: 'TDAD Commands',
            blocks: buildHelpBlocks()
        };
    });

    logExtension('Slack command handler initialized');
}

/**
 * Disconnect from Slack
 */
export async function disconnectSlack(
    workspacePath: string,
    state: SlackState
): Promise<void> {
    if (state.service) {
        await state.service.disconnect();
        state.service = null;
        state.commandHandler = null;

        // Disable Slack output capture
        const cliLauncher = CLIAgentLauncher.getInstance(workspacePath);
        cliLauncher.setSlackOutputEnabled(false);

        logExtension('Slack disconnected');
    }
}

/**
 * Auto-connect to Slack on startup if enabled
 */
export async function autoConnectSlack(
    context: vscode.ExtensionContext,
    workspacePath: string,
    state: SlackState
): Promise<void> {
    const slackEnabled = vscode.workspace.getConfiguration('tdad').get('slack.enabled');
    if (!slackEnabled) return;

    const botToken = await context.secrets.get('tdad.slack.botToken');
    const appToken = await context.secrets.get('tdad.slack.appToken');

    if (botToken && appToken) {
        try {
            await connectSlack(botToken, appToken, workspacePath, state);
            logExtension('Slack auto-connected on startup');
        } catch (error) {
            logError('EXTENSION', 'Failed to auto-connect Slack', error);
        }
    }
}
