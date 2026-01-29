/**
 * SlackCommandHandler - Routes Slack slash commands to TDAD functionality
 * Sprint 15: Remote Control via Slack
 * Refactored: Split into multiple modules for maintainability
 */

import * as vscode from 'vscode';
import { SlackService } from './SlackService';
import { SlackMessageContext, SlackCommandDependencies, HomeTabView } from '../../shared/types/slack';
import { logger } from '../../shared/utils/Logger';
import { CLIOutputWatcher } from './CLIOutputWatcher';
import { routeAction, ActionRouterContext } from './SlackActionRouter';
import {
    buildPlanViewBlocks,
    buildTerminalPanelWithOutput,
    buildTerminalModal,
    buildHomeTabDashboard,
    buildHomeTabFolderView,
    buildHomeTabNodeView
} from './SlackBlockBuilders';

// Re-export types for backward compatibility
export type { AutomationStatus, SlackCommandDependencies } from '../../shared/types/slack';

export class SlackCommandHandler {
    private activeThreads: Map<string, CLIOutputWatcher> = new Map();
    private pendingPlanEdits: Map<string, { nodeId: string; nodeName: string }> = new Map();
    // Store active automation thread - all notifications go to this thread
    private activeAutomationThread: { channelId: string; threadTs: string } | null = null;
    // Track each user's current Home Tab view state
    private userViewStates: Map<string, HomeTabView> = new Map();
    // Track users who have opened the Home Tab (for auto-refresh)
    private knownUsers: Set<string> = new Set();
    // Status polling for Home Tab auto-refresh
    private statusPollInterval: NodeJS.Timeout | null = null;
    private lastKnownStatus: string = 'idle';
    private static readonly STATUS_POLL_INTERVAL_MS = 3000; // Check every 3 seconds

    constructor(
        private readonly slackService: SlackService,
        private readonly deps: SlackCommandDependencies
    ) {
        this.slackService.onMessage(async (text, context) => {
            await this.handleThreadReply(text, context);
        });

        this.slackService.onAction(async (actionId, value, context) => {
            // Track user for auto-refresh
            if (context.userId) {
                this.knownUsers.add(context.userId);
            }
            await routeAction(actionId, value, context, this.getActionContext());
        });

        this.slackService.onViewSubmission(async (callbackId, values, privateMetadata, context) => {
            await this.handleViewSubmission(callbackId, values, privateMetadata, context);
        });

        this.slackService.onAppHomeOpened(async (context) => {
            await this.handleAppHomeOpened(context);
        });

        // Start status polling for Home Tab auto-refresh
        this.startStatusPolling();
    }

    /**
     * Start polling for status changes to auto-refresh Home Tabs
     */
    private startStatusPolling(): void {
        this.statusPollInterval = setInterval(async () => {
            await this.checkAndRefreshHomeTabs();
        }, SlackCommandHandler.STATUS_POLL_INTERVAL_MS);
    }

    /**
     * Check if automation status changed and refresh all users' Home Tabs
     */
    private async checkAndRefreshHomeTabs(): Promise<void> {
        const currentStatus = this.deps.getAutomationStatus();
        const statusChanged = currentStatus.status !== this.lastKnownStatus;

        // Refresh if status changed OR if currently running (to show progress updates)
        if (statusChanged || currentStatus.status === 'running') {
            this.lastKnownStatus = currentStatus.status;

            // Refresh all known users' Home Tabs
            for (const userId of this.knownUsers) {
                try {
                    await this.updateAppHome(userId);
                } catch (error: any) {
                    // User might have revoked access or left - don't spam logs
                    if (!error.message?.includes('user_not_found')) {
                        logger.log('SLACK-CMD', `Failed to refresh Home Tab for ${userId}: ${error.message}`);
                    }
                }
            }
        }
    }

    /**
     * Stop status polling (call on dispose)
     */
    public stopStatusPolling(): void {
        if (this.statusPollInterval) {
            clearInterval(this.statusPollInterval);
            this.statusPollInterval = null;
        }
    }

    private async handleAppHomeOpened(context: SlackMessageContext): Promise<void> {
        const userId = context.userId;
        if (!userId) return;

        // Track this user for auto-refresh
        this.knownUsers.add(userId);
        await this.updateAppHome(userId);
    }

    public async updateAppHome(userId: string, newView?: HomeTabView): Promise<void> {
        logger.log('SLACK-CMD', `Updating App Home for user ${userId}`);

        // Update view state if provided
        if (newView) {
            this.userViewStates.set(userId, newView);
        }

        // Get current view state (default to dashboard)
        const viewState = this.userViewStates.get(userId) || { type: 'dashboard' as const };

        // Gather common state
        const status = this.deps.getAutomationStatus();
        const nodes = this.deps.getNodes();

        logger.log('SLACK-CMD', `Status: ${status.status}, Nodes: ${nodes.length}, View: ${viewState.type}`);

        let blocks: any[];

        if (viewState.type === 'node') {
            // Node details view
            const node = this.deps.getNodeById(viewState.nodeId);
            if (node) {
                const planSpec = await this.deps.getPlanSpec(node.id);
                blocks = buildHomeTabNodeView(node, !!planSpec, status);
            } else {
                // Node not found, go back to dashboard
                this.userViewStates.set(userId, { type: 'dashboard' });
                blocks = buildHomeTabDashboard(status, nodes);
            }
        } else if (viewState.type === 'folder') {
            // Folder browser view
            blocks = buildHomeTabFolderView(viewState.folderId, nodes, status);
        } else {
            // Dashboard view (default)
            blocks = buildHomeTabDashboard(status, nodes);
        }

        logger.log('SLACK-CMD', `Publishing ${blocks.length} blocks to Home View`);
        await this.slackService.publishHomeView(userId, blocks);
        logger.log('SLACK-CMD', `App Home updated successfully`);
    }

    /**
     * Set user's Home Tab view and refresh
     */
    public async setUserView(userId: string, view: HomeTabView): Promise<void> {
        await this.updateAppHome(userId, view);
    }

    /**
     * Get user's current Home Tab view
     */
    public getUserView(userId: string): HomeTabView {
        return this.userViewStates.get(userId) || { type: 'dashboard' };
    }

    private getActionContext(): ActionRouterContext {
        return {
            slackService: this.slackService,
            deps: this.deps,
            activeThreads: this.activeThreads,
            reply: this.reply.bind(this),
            replyWithBlocks: this.replyWithBlocks.bind(this),
            getActiveThread: () => this.activeAutomationThread,
            setActiveThread: (thread) => { this.activeAutomationThread = thread; },
            clearActiveThread: () => { this.activeAutomationThread = null; },
            setLastKnownChannel: (channelId) => {
                if (channelId && this.deps.setDefaultChannelId) {
                    this.deps.setDefaultChannelId(channelId);
                }
            },
            getLastKnownChannel: () => this.deps.getDefaultChannelId?.() || '',
            updateHomeTab: this.updateAppHome.bind(this),
            setUserView: this.setUserView.bind(this),
            getUserView: this.getUserView.bind(this)
        };
    }

    private async handleViewSubmission(
        callbackId: string,
        values: Record<string, any>,
        privateMetadata: string,
        context: SlackMessageContext
    ): Promise<void> {
        logger.log('SLACK-CMD', `View submission: ${callbackId}, metadata: ${privateMetadata}`);

        // Parse metadata - can be JSON with nodeId+channelId+parentId or just nodeId string
        let nodeId: string = '';
        let channelId: string = context.channelId || '';
        let parentId: string = '';
        try {
            const parsed = JSON.parse(privateMetadata);
            nodeId = parsed.nodeId || '';
            channelId = parsed.channelId || channelId;
            parentId = parsed.parentId || '';
        } catch {
            // Fallback: treat metadata as plain nodeId string
            nodeId = privateMetadata;
        }

        if (callbackId === 'tdad_edit_plan_modal') {
            const newPlanSpec = values['plan_input'];

            if (nodeId && newPlanSpec) {
                try {
                    await this.deps.savePlanSpec(nodeId, newPlanSpec);
                    logger.log('SLACK-CMD', `Saved Plan for node ${nodeId}`);

                    // Show updated plan view after save
                    const node = this.deps.getNodeById(nodeId);
                    if (node && channelId) {
                        const blocks = buildPlanViewBlocks(node, newPlanSpec);
                        await this.slackService.sendBlockMessage(
                            channelId,
                            `Plan saved for *${node.title}*`,
                            blocks
                        );
                    }
                } catch (error: any) {
                    logger.error('SLACK-CMD', `Failed to save Plan: ${error.message}`, error);
                }
            }
        } else if (callbackId === 'tdad_add_node_modal') {
            const nodeName = values['node_name_input'];
            const nodeDescription = values['node_description_input'] || '';

            if (nodeName) {
                const newNode: Partial<import('../../shared/types').Node> = {
                    id: `node-${Date.now()}`,
                    nodeType: 'file',
                    title: nodeName,
                    description: nodeDescription || `Created via Slack`,
                    position: { x: 100, y: 100 },
                    parentId: parentId || undefined
                };

                this.deps.addNode(newNode);
                logger.log('SLACK-CMD', `Created node via modal: ${nodeName}, parentId: ${parentId || 'root'}`);

                if (channelId) {
                    try {
                        await this.slackService.sendMessage(
                            channelId,
                            `✅ Created node: *${nodeName}*`
                        );
                    } catch {
                        // Ignore message send errors
                    }
                }
            }
        } else if (callbackId === 'tdad_add_folder_modal') {
            const folderName = values['folder_name_input'];

            if (folderName) {
                const newFolder: Partial<import('../../shared/types').Node> = {
                    id: `folder-${Date.now()}`,
                    nodeType: 'folder',
                    title: folderName,
                    description: '',
                    position: { x: 100, y: 100 },
                    parentId: parentId || undefined
                };

                this.deps.addNode(newFolder);
                logger.log('SLACK-CMD', `Created folder via modal: ${folderName}, parentId: ${parentId || 'root'}`);

                if (channelId) {
                    try {
                        await this.slackService.sendMessage(
                            channelId,
                            `✅ Created folder: *${folderName}*`
                        );
                    } catch {
                        // Ignore message send errors
                    }
                }
            }
        } else if (callbackId === 'tdad_auto_generate_plan_modal') {
            const newDescription = values['description_input'];

            if (nodeId) {
                const node = this.deps.getNodeById(nodeId);
                if (!node) {
                    logger.error('SLACK-CMD', `Node not found: ${nodeId}`);
                    return;
                }

                // Update the node description if changed
                if (newDescription && newDescription !== node.description) {
                    node.description = newDescription;
                    this.deps.updateNode(node);
                    logger.log('SLACK-CMD', `Updated description for node ${node.title}`);
                }

                // Notify user that auto-generation is starting (don't fail if message fails)
                if (channelId) {
                    try {
                        await this.slackService.sendMessage(
                            channelId,
                            `Auto-generating Plan for *${node.title}*...\n_This will use AI to create a Plan based on the node description._`
                        );
                    } catch (msgError: any) {
                        logger.log('SLACK-CMD', `Could not send notification: ${msgError.message}`);
                    }
                }

                // Run autopilot with only Plan mode ('bdd')
                try {
                    const result = await this.deps.runSingleNode(nodeId, ['bdd']);
                    if (result.started) {
                        logger.log('SLACK-CMD', `Started Plan auto-generation for ${node.title}`);
                        if (channelId) {
                            try {
                                await this.slackService.sendMessage(channelId, `✅ Started Plan generation for *${node.title}*`);
                            } catch { /* ignore */ }
                        }
                    } else {
                        logger.log('SLACK-CMD', `Plan auto-generation blocked: ${result.error}`);
                        if (channelId) {
                            try {
                                await this.slackService.sendMessage(channelId, `⚠️ Could not start: ${result.error}`);
                            } catch { /* ignore */ }
                        }
                    }
                } catch (error: any) {
                    logger.error('SLACK-CMD', `Failed to auto-generate Plan: ${error.message}`, error);
                    if (channelId) {
                        try {
                            await this.slackService.sendMessage(
                                channelId,
                                `❌ Failed to start auto-generation: ${error.message}`
                            );
                        } catch {
                            // Ignore message send errors
                        }
                    }
                }
            }
        } else if (callbackId === 'tdad_auto_generate_tests_modal') {
            const newDescription = values['description_input'];

            if (nodeId) {
                const node = this.deps.getNodeById(nodeId);
                if (!node) {
                    logger.error('SLACK-CMD', `Node not found: ${nodeId}`);
                    return;
                }

                // Update the node description if changed
                if (newDescription && newDescription !== node.description) {
                    node.description = newDescription;
                    this.deps.updateNode(node);
                    logger.log('SLACK-CMD', `Updated description for node ${node.title}`);
                }

                // Notify user that auto-generation is starting (don't fail if message fails)
                if (channelId) {
                    try {
                        await this.slackService.sendMessage(
                            channelId,
                            `Auto-generating Tests for *${node.title}*...\n_This will use AI to create Tests based on the Plan._`
                        );
                    } catch (msgError: any) {
                        logger.log('SLACK-CMD', `Could not send notification: ${msgError.message}`);
                    }
                }

                // Run autopilot with only Test mode ('test')
                try {
                    const result = await this.deps.runSingleNode(nodeId, ['test']);
                    if (result.started) {
                        logger.log('SLACK-CMD', `Started Tests auto-generation for ${node.title}`);
                        if (channelId) {
                            try {
                                await this.slackService.sendMessage(channelId, `✅ Started Test generation for *${node.title}*`);
                            } catch { /* ignore */ }
                        }
                    } else {
                        logger.log('SLACK-CMD', `Tests auto-generation blocked: ${result.error}`);
                        if (channelId) {
                            try {
                                await this.slackService.sendMessage(channelId, `⚠️ Could not start: ${result.error}`);
                            } catch { /* ignore */ }
                        }
                    }
                } catch (error: any) {
                    logger.error('SLACK-CMD', `Failed to auto-generate Tests: ${error.message}`, error);
                    if (channelId) {
                        try {
                            await this.slackService.sendMessage(
                                channelId,
                                `❌ Failed to start auto-generation: ${error.message}`
                            );
                        } catch {
                            // Ignore message send errors
                        }
                    }
                }
            }
        } else if (callbackId === 'tdad_terminal_modal') {
            // Terminal modal submission - send message to CLI and keep modal open
            const message = values['message_input'];
            let statusMessage = '';

            if (message) {
                const terminal = vscode.window.terminals.find(t => t.name === 'TDAD Agent');
                if (terminal) {
                    terminal.show(false);

                    // Use clipboard paste method (most reliable for Claude Code)
                    await vscode.env.clipboard.writeText(message);
                    await vscode.commands.executeCommand('workbench.action.terminal.paste');

                    // Send Enter to submit after paste completes
                    await new Promise(resolve => setTimeout(resolve, 100));
                    await vscode.commands.executeCommand(
                        'workbench.action.terminal.sendSequence',
                        { text: '\r' }
                    );

                    logger.log('SLACK-CMD', `Sent to terminal from modal: ${message}`);
                    statusMessage = `Sent: ${message}`;
                } else {
                    logger.log('SLACK-CMD', 'No TDAD Agent terminal found');
                    statusMessage = 'No active terminal found. Start automation first.';
                }
            }

            // Wait a moment for terminal to process, then capture fresh output
            await new Promise(resolve => setTimeout(resolve, 300));
            const output = await this.deps.captureCliOutput() || 'No output captured.';

            // Add status message to output if we sent something
            const displayOutput = statusMessage
                ? `[${statusMessage}]\n\n${output}`
                : output;

            // Return updated modal view to keep it open
            return buildTerminalModal(channelId, displayOutput);
        } else if (callbackId === 'tdad_send_to_cli_modal') {
            const message = values['message_input'];
            const method = values['method_input'] || 'clipboard_paste'; // Default to clipboard (most reliable)

            if (message) {
                const terminal = vscode.window.terminals.find(t => t.name === 'TDAD Agent');
                if (terminal) {
                    terminal.show(false);

                    // Build the sequence based on selected method
                    let sequence = message;
                    let useClipboard = false;

                    switch (method) {
                        case 'clipboard_paste':
                            useClipboard = true;
                            // We don't use sequence for clipboard paste, we use the clipboard
                            break;
                        case 'shift2_enter2':
                            // Shift+Enter x2 (newlines), Enter x2 (submit)
                            // \n = newline (like Shift+Enter), \r = carriage return (Enter)
                            sequence = message + '\n\n\r\r';
                            break;
                        case 'enter':
                            // Just Enter
                            sequence = message + '\r';
                            break;
                        case 'ctrl_d':
                            // Ctrl+D (EOF)
                            sequence = message + '\x04';
                            break;
                        case 'enter2':
                            // Enter x2
                            sequence = message + '\r\r';
                            break;
                        default:
                            sequence = message + '\n\n\r\r';
                    }

                    if (useClipboard) {
                        // Clipboard Paste Strategy
                        // 1. Write to clipboard
                        await vscode.env.clipboard.writeText(message);

                        // 2. Paste
                        await vscode.commands.executeCommand('workbench.action.terminal.paste');

                        // 3. Send Enter to submit (wait a tiny bit for paste to complete)
                        setTimeout(async () => {
                            await vscode.commands.executeCommand(
                                'workbench.action.terminal.sendSequence',
                                { text: '\r' }
                            );
                        }, 100);

                        logger.log('SLACK-CMD', `Sent to terminal (clipboard): ${message}`);
                    } else {
                        await vscode.commands.executeCommand(
                            'workbench.action.terminal.sendSequence',
                            { text: sequence }
                        );

                        // Debug logging for sequence
                        const debugSequence = sequence
                            .replace(/\n/g, '[LF]')
                            .replace(/\r/g, '[CR]')
                            .replace(/\x04/g, '[EOF]');
                        logger.log('SLACK-CMD', `Sent to terminal (${method}): ${message} | Sequence: ${debugSequence}`);
                    }

                    if (channelId) {
                        try {
                            const blocks = buildTerminalPanelWithOutput(`Sent: \`${message}\``);
                            await this.slackService.sendBlockMessage(channelId, 'Terminal', blocks);
                        } catch { /* ignore */ }
                    }
                } else {
                    logger.log('SLACK-CMD', 'No TDAD Agent terminal found');
                    if (channelId) {
                        try {
                            const blocks = buildTerminalPanelWithOutput('No active terminal found. Start automation first.');
                            await this.slackService.sendBlockMessage(channelId, 'Terminal', blocks);
                        } catch { /* ignore */ }
                    }
                }
            }
        } else if (callbackId === 'tdad_run_options_modal') {
            // Run options modal - user selected which phases to run (unified UX with canvas)
            const selectedModes = values['modes_input'] as string[] || [];
            logger.log('SLACK-CMD', `Run options: selectedModes=${JSON.stringify(selectedModes)}, raw values=${JSON.stringify(values)}`);

            // Parse metadata to get targetId and isFolder
            let targetId: string = '';
            let isFolder: boolean = false;
            try {
                const parsed = JSON.parse(privateMetadata);
                targetId = parsed.targetId || '';
                isFolder = parsed.isFolder ?? false;
                channelId = parsed.channelId || channelId || this.deps.getDefaultChannelId?.() || '';
                logger.log('SLACK-CMD', `Parsed metadata: targetId=${targetId}, isFolder=${isFolder}, channelId=${channelId}`);
            } catch {
                logger.error('SLACK-CMD', 'Failed to parse run options metadata');
                return;
            }

            if (selectedModes.length === 0) {
                if (channelId) {
                    try {
                        await this.slackService.sendMessage(channelId, '⚠️ No phases selected. Please select at least one phase to run.');
                    } catch (err: any) {
                        logger.error('SLACK-CMD', `Failed to send no-phases message: ${err.message}`);
                    }
                }
                return;
            }

            // Cast to AutopilotModes type
            const modes = selectedModes as ('bdd' | 'test' | 'run-fix')[];
            const modeLabels = modes.map(m => m === 'bdd' ? 'Plan' : m === 'test' ? 'Test' : 'Run+Fix').join(', ');

            // Determine target name
            const folderId = isFolder ? (targetId === 'all' ? null : targetId) : null;
            const targetName = isFolder
                ? (folderId ? this.deps.getNodeById(folderId)?.title || 'folder' : 'all nodes')
                : (this.deps.getNodeById(targetId)?.title || 'node');

            // Send first message to create thread - all notifications will go here
            let threadTs: string | undefined;
            if (channelId) {
                try {
                    logger.log('SLACK-CMD', `Creating automation thread in channel ${channelId}`);
                    threadTs = await this.slackService.sendMessage(
                        channelId,
                        `🚀 *Automation Started*\nTarget: *${targetName}*\nPhases: ${modeLabels}`
                    );
                    if (threadTs) {
                        this.activeAutomationThread = { channelId, threadTs };
                        logger.log('SLACK-CMD', `Created automation thread: ${threadTs}`);
                    }
                } catch (err: any) {
                    logger.error('SLACK-CMD', `Failed to create automation thread: ${err.message}`);
                }
            }

            // Helper to send to thread
            const notifyThread = async (message: string) => {
                if (channelId && threadTs) {
                    try {
                        await this.slackService.sendMessage(channelId, message, threadTs);
                    } catch (err: any) {
                        logger.error('SLACK-CMD', `Failed to send thread notification: ${err.message}`);
                    }
                }
            };

            if (isFolder) {
                // Running folder or all nodes
                try {
                    await this.deps.runFolderNodes(folderId, modes);
                    logger.log('SLACK-CMD', `Started folder automation: ${targetName} with modes: ${modes.join(', ')}`);
                    await notifyThread(`✅ Automation running for *${targetName}*`);
                } catch (error: any) {
                    logger.error('SLACK-CMD', `Failed to run folder: ${error.message}`, error);
                    await notifyThread(`❌ Failed to start: ${error.message}`);
                }
            } else {
                // Running single node
                const node = this.deps.getNodeById(targetId);
                if (!node) {
                    logger.error('SLACK-CMD', `Node not found: ${targetId}`);
                    await notifyThread(`❌ Node not found: ${targetId}`);
                    return;
                }

                try {
                    const result = await this.deps.runSingleNode(targetId, modes);
                    if (result.started) {
                        logger.log('SLACK-CMD', `Started node automation: ${node.title} with modes: ${modes.join(', ')}`);
                        await notifyThread(`✅ Automation running for *${node.title}*`);
                    } else {
                        logger.log('SLACK-CMD', `Node automation blocked: ${result.error}`);
                        await notifyThread(`⚠️ Could not start: ${result.error}`);
                    }
                } catch (error: any) {
                    logger.error('SLACK-CMD', `Failed to run node: ${error.message}`, error);
                    await notifyThread(`❌ Failed to start: ${error.message}`);
                }
            }
        }
    }

    private async handleThreadReply(text: string, context: SlackMessageContext): Promise<void> {
        if (!context.threadTs) return;

        const pendingEdit = this.pendingPlanEdits.get(context.threadTs);
        if (!pendingEdit) return;

        const { nodeId, nodeName } = pendingEdit;

        await this.deps.savePlanSpec(nodeId, text);

        await this.slackService.sendMessage(
            context.channelId,
            `✅ Saved Plan for *${nodeName}*`,
            context.threadTs
        );

        logger.log('SLACK-CMD', `Saved Plan for ${nodeName}`);
    }

    private async reply(context: SlackMessageContext, message: string): Promise<void> {
        // Check if this is a Home tab action (no channel context)
        const isHomeTabAction = !context.channelId;

        if (context.respond && !context.threadTs && !isHomeTabAction) {
            await context.respond(message);
        } else if (context.channelId) {
            await this.slackService.sendMessage(context.channelId, message, context.threadTs);
        } else {
            // Home tab action with no channel - cannot send message, just log
            logger.log('SLACK-CMD', `reply skipped (Home tab action): ${message.substring(0, 100)}`);
        }
    }

    private async replyWithBlocks(context: SlackMessageContext, text: string, blocks: any[]): Promise<void> {
        // Check if this is a Home tab action (no channel context)
        const isHomeTabAction = !context.channelId;

        try {
            if (context.respond && !context.threadTs && !isHomeTabAction) {
                await context.respond({ text, blocks, response_type: 'in_channel' });
            } else if (context.channelId) {
                await this.slackService.sendBlockMessage(context.channelId, text, blocks, context.threadTs);
            } else {
                // Home tab action with no channel - cannot send blocks
                // For Home tab, navigation actions should use modals instead
                logger.log('SLACK-CMD', `replyWithBlocks skipped (Home tab action): ${text}`);
                logger.log('SLACK-CMD', 'Tip: Home tab navigation should use modals. Consider using openModal with triggerId.');
            }
        } catch (error: any) {
            logger.error('SLACK-CMD', `replyWithBlocks failed: ${error?.message}`, error);
            logger.error('SLACK-CMD', `Blocks count: ${blocks.length}, first block: ${JSON.stringify(blocks[0])}`);
            throw error;
        }
    }

    public dispose(): void {
        this.stopStatusPolling();
        for (const [, watcher] of this.activeThreads) {
            watcher.stopWatching();
        }
        this.activeThreads.clear();
        this.knownUsers.clear();
    }
}
