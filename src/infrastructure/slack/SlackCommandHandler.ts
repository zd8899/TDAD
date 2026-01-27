/**
 * SlackCommandHandler - Routes Slack slash commands to TDAD functionality
 * Sprint 15: Remote Control via Slack
 * Refactored: Split into multiple modules for maintainability
 */

import * as vscode from 'vscode';
import { SlackService } from './SlackService';
import { SlackCommandPayload, SlackMessageContext, SlackCommandDependencies } from '../../shared/types/slack';
import { isFolderNode } from '../../shared/types/typeGuards';
import { logger } from '../../shared/utils/Logger';
import { CLIAgentLauncher } from '../../vscode-integration/CLIAgentLauncher';
import { CLIOutputWatcher } from './CLIOutputWatcher';
import { handleNodeCommand, handleTestCommand, findNodeByName, findFolderByName, NodeHandlerContext } from './SlackNodeHandlers';
import { routeAction, ActionRouterContext } from './SlackActionRouter';
import { buildNodesListBlocks, getHelpText } from './SlackBlockBuilders';

// Re-export types for backward compatibility
export type { AutomationStatus, SlackCommandDependencies } from '../../shared/types/slack';

export class SlackCommandHandler {
    private activeThreads: Map<string, CLIOutputWatcher> = new Map();
    private pendingBddEdits: Map<string, { nodeId: string; nodeName: string }> = new Map();

    constructor(
        private readonly slackService: SlackService,
        private readonly deps: SlackCommandDependencies
    ) {
        this.slackService.onMessage(async (text, context) => {
            await this.handleThreadReply(text, context);
        });

        this.slackService.onAction(async (actionId, value, context) => {
            await routeAction(actionId, value, context, this.getActionContext());
        });

        this.slackService.onViewSubmission(async (callbackId, values, privateMetadata, context) => {
            await this.handleViewSubmission(callbackId, values, privateMetadata, context);
        });
    }

    private getNodeHandlerContext(): NodeHandlerContext {
        return {
            deps: this.deps,
            reply: this.reply.bind(this),
            replyWithBlocks: this.replyWithBlocks.bind(this)
        };
    }

    private getActionContext(): ActionRouterContext {
        return {
            slackService: this.slackService,
            deps: this.deps,
            reply: this.reply.bind(this),
            replyWithBlocks: this.replyWithBlocks.bind(this)
        };
    }

    private async handleViewSubmission(
        callbackId: string,
        values: Record<string, any>,
        privateMetadata: string,
        _context: SlackMessageContext
    ): Promise<void> {
        logger.log('SLACK-CMD', `View submission: ${callbackId}, metadata: ${privateMetadata}`);

        if (callbackId === 'tdad_edit_bdd_modal') {
            const nodeId = privateMetadata;
            const newBddSpec = values['bdd_input'];

            if (nodeId && newBddSpec) {
                try {
                    await this.deps.saveBddSpec(nodeId, newBddSpec);
                    logger.log('SLACK-CMD', `Saved BDD spec for node ${nodeId}`);
                } catch (error: any) {
                    logger.error('SLACK-CMD', `Failed to save BDD spec: ${error.message}`, error);
                }
            }
        }
    }

    public async handleCommand(payload: SlackCommandPayload): Promise<void> {
        const { command, args, context } = payload;

        logger.log('SLACK-CMD', `Handling: ${command} ${args.join(' ')}`);

        try {
            switch (command.toLowerCase()) {
                case 'node':
                    await handleNodeCommand(args, context, this.getNodeHandlerContext());
                    break;
                case 'nodes':
                    await this.handleNodesCommand(context);
                    break;
                case 'run':
                    await this.handleRunCommand(args, context);
                    break;
                case 'autopilot':
                    await this.handleAutopilotCommand(args, context);
                    break;
                case 'test':
                    await handleTestCommand(args, context, this.getNodeHandlerContext());
                    break;
                case 'status':
                    await this.handleStatusCommand(context);
                    break;
                case 'progress':
                    await this.handleProgressCommand(context);
                    break;
                case 'cli':
                    await this.handleCliCommand(context);
                    break;
                case 'say':
                    await this.handleSayCommand(args, context);
                    break;
                case 'stop':
                    await this.handleStopCommand(context);
                    break;
                case 'help':
                default:
                    await this.handleHelpCommand(context);
                    break;
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            logger.error('SLACK-CMD', `Error handling ${command}`, error);
            await this.reply(context, `❌ Error: ${errorMsg}`);
        }
    }

    private async handleRunCommand(args: string[], context: SlackMessageContext): Promise<void> {
        if (args.length === 0) {
            await this.reply(context, '❌ Usage: `/tdad run <node-name>` or `/tdad run folder [name]`');
            return;
        }

        const firstArg = args[0]?.toLowerCase();

        if (firstArg === 'folder') {
            const folderName = args.slice(1).join(' ');

            if (folderName) {
                const folder = findFolderByName(this.deps.getNodes(), folderName);
                if (!folder) {
                    await this.reply(context, `❌ Folder not found: *${folderName}*`);
                    return;
                }
                await this.reply(context, `🚀 Starting automation for folder: *${folder.title}*...`);
                await this.deps.runFolderNodes(folder.id);
            } else {
                await this.reply(context, '🚀 Starting automation for all nodes...');
                await this.deps.runFolderNodes(null);
            }
        } else {
            const nodeName = args.join(' ');
            const node = findNodeByName(this.deps.getNodes(), nodeName);

            if (!node) {
                await this.reply(context, `❌ Node not found: *${nodeName}*`);
                return;
            }

            await this.reply(context, `🚀 Starting automation for: *${node.title}*...`);

            try {
                const threadTs = await this.slackService.sendMessage(
                    context.channelId,
                    `📺 *Output for ${node.title}* - CLI output will appear here`
                );

                if (threadTs) {
                    const watcher = new CLIOutputWatcher(
                        this.slackService,
                        context.channelId,
                        threadTs,
                        this.deps.workspacePath
                    );
                    watcher.startWatching();
                    this.activeThreads.set(threadTs, watcher);
                }
            } catch (err) {
                logger.log('SLACK-CMD', 'Could not create output thread');
            }

            await this.deps.runSingleNode(node.id, ['bdd', 'test', 'run-fix']);
        }
    }

    private async handleProgressCommand(context: SlackMessageContext): Promise<void> {
        const status = this.deps.getAutomationStatus();

        let statusEmoji = '⚪';
        if (status.status === 'running') statusEmoji = '🟢';
        else if (status.status === 'paused') statusEmoji = '🟡';
        else if (status.status === 'stopped' || status.status === 'idle') statusEmoji = '🔴';
        else if (status.status === 'completed') statusEmoji = '✅';

        let message = `${statusEmoji} *Automation Progress*\n`;
        message += `\n*Status:* ${status.status}`;

        if (status.currentNodeId) {
            const nodes = this.deps.getNodes();
            const currentNode = nodes.find(n => n.id === status.currentNodeId);
            if (currentNode) {
                message += `\n📍 *Current Node:* ${currentNode.title}`;
            }
        }

        if (status.phase) {
            const phaseEmoji = status.phase === 'bdd' ? '📋' :
                              status.phase === 'generating' ? '⚙️' :
                              status.phase === 'testing' ? '🧪' :
                              status.phase === 'fixing' ? '🔧' : '🔄';
            message += `\n${phaseEmoji} *Phase:* ${status.phase}`;
        }

        if (status.currentRetry && status.maxRetries) {
            message += `\n🔄 *Retry:* ${status.currentRetry}/${status.maxRetries}`;
        }

        if (status.processedNodes && status.processedNodes.length > 0) {
            const nodes = this.deps.getNodes();
            const processedNames = status.processedNodes
                .map(id => nodes.find(n => n.id === id)?.title || id)
                .slice(-5);
            message += `\n\n✅ *Completed (${status.processedNodes.length}):*`;
            processedNames.forEach(name => {
                message += `\n  • ${name}`;
            });
            if (status.processedNodes.length > 5) {
                message += `\n  _...and ${status.processedNodes.length - 5} more_`;
            }
        }

        if (status.failedNodes && status.failedNodes.length > 0) {
            const nodes = this.deps.getNodes();
            const failedNames = status.failedNodes
                .map(id => nodes.find(n => n.id === id)?.title || id);
            message += `\n\n❌ *Failed (${status.failedNodes.length}):*`;
            failedNames.forEach(name => {
                message += `\n  • ${name}`;
            });
        }

        if (status.message) {
            message += `\n\n💬 ${status.message}`;
        }

        await this.reply(context, message);
    }

    private async handleCliCommand(context: SlackMessageContext): Promise<void> {
        const output = this.deps.getCliOutput(50);

        if (!output || output.trim() === '') {
            await this.reply(context, '📺 No CLI output available.\n\n_Start automation with `/tdad run <node>` to see output._');
            return;
        }

        const maxLength = 3500;
        const truncated = output.length > maxLength
            ? '...(truncated)\n' + output.substring(output.length - maxLength)
            : output;

        await this.reply(context, `📺 *Recent CLI Output* (last 50 lines)\n\`\`\`\n${truncated}\n\`\`\``);
    }

    private async handleAutopilotCommand(args: string[], context: SlackMessageContext): Promise<void> {
        const subCommand = args[0]?.toLowerCase();

        if (subCommand === 'start') {
            await this.reply(context, '🚀 Starting autopilot...');

            try {
                const threadTs = await this.slackService.sendMessage(
                    context.channelId,
                    '📺 *Autopilot Output Thread* - CLI output will appear here'
                );

                if (threadTs) {
                    const watcher = new CLIOutputWatcher(
                        this.slackService,
                        context.channelId,
                        threadTs,
                        this.deps.workspacePath
                    );
                    watcher.startWatching();
                    this.activeThreads.set(threadTs, watcher);
                }
            } catch (err) {
                logger.log('SLACK-CMD', 'Could not create output thread - bot may not be in channel');
            }

            await this.deps.startAutomation();

        } else if (subCommand === 'stop') {
            this.deps.stopAutomation();

            for (const [, watcher] of this.activeThreads) {
                watcher.stopWatching();
            }
            this.activeThreads.clear();

            await this.reply(context, '⏹️ Autopilot stopped.');

        } else {
            await this.reply(context, '❌ Usage: `/tdad autopilot start` or `/tdad autopilot stop`');
        }
    }

    private async handleStatusCommand(context: SlackMessageContext): Promise<void> {
        const status = this.deps.getAutomationStatus();

        let statusEmoji = '⚪';
        if (status.status === 'running') statusEmoji = '🟢';
        else if (status.status === 'paused') statusEmoji = '🟡';
        else if (status.status === 'stopped') statusEmoji = '🔴';

        let message = `${statusEmoji} *Status:* ${status.status}`;

        if (status.currentNodeId) {
            const nodes = this.deps.getNodes();
            const currentNode = nodes.find(n => n.id === status.currentNodeId);
            if (currentNode) {
                message += `\n📍 *Current:* ${currentNode.title}`;
            }
        }

        if (status.phase) {
            message += `\n🔄 *Phase:* ${status.phase}`;
        }

        if (status.message) {
            message += `\n💬 ${status.message}`;
        }

        await this.reply(context, message);
    }

    private async handleNodesCommand(context: SlackMessageContext): Promise<void> {
        const allNodes = this.deps.getNodes();
        const folders = allNodes.filter(n => isFolderNode(n) && (!n.parentId || n.parentId === 'root' || n.parentId === ''));

        logger.log('SLACK-CMD', `Root level: ${folders.length} folders`);

        const blocks = buildNodesListBlocks(folders);
        await this.replyWithBlocks(context, 'Nodes', blocks);
    }

    private async handleThreadReply(text: string, context: SlackMessageContext): Promise<void> {
        if (!context.threadTs) return;

        const pendingEdit = this.pendingBddEdits.get(context.threadTs);
        if (!pendingEdit) return;

        const { nodeId, nodeName } = pendingEdit;

        await this.deps.saveBddSpec(nodeId, text);

        await this.slackService.sendMessage(
            context.channelId,
            `✅ Saved BDD spec for *${nodeName}*`,
            context.threadTs
        );

        logger.log('SLACK-CMD', `Saved BDD spec for ${nodeName}`);
    }

    private async handleSayCommand(args: string[], context: SlackMessageContext): Promise<void> {
        const message = args.join(' ');
        if (!message) {
            await this.reply(context, '❌ Usage: `/tdad say <message to send to CLI>`');
            return;
        }

        const launcher = CLIAgentLauncher.getInstance(this.deps.workspacePath);
        if (!launcher) {
            await this.reply(context, '❌ CLI agent not initialized.');
            return;
        }

        const terminal = vscode.window.terminals.find(t => t.name === 'TDAD Agent');
        if (terminal) {
            terminal.sendText(message);
            await this.reply(context, `📤 Sent to CLI: \`${message}\``);
            logger.log('SLACK-CMD', `Sent to terminal: ${message}`);
        } else {
            await this.reply(context, '❌ No active TDAD Agent terminal found.');
        }
    }

    private async handleStopCommand(context: SlackMessageContext): Promise<void> {
        const terminal = vscode.window.terminals.find(t => t.name === 'TDAD Agent');
        if (terminal) {
            terminal.sendText('\x03');
            await this.reply(context, '⏹️ Sent cancel signal (Ctrl+C) to CLI.');
        } else {
            await this.reply(context, '❌ No active TDAD Agent terminal found.');
        }

        this.deps.stopAutomation();

        for (const [, watcher] of this.activeThreads) {
            watcher.stopWatching();
        }
        this.activeThreads.clear();
    }

    private async handleHelpCommand(context: SlackMessageContext): Promise<void> {
        await this.reply(context, getHelpText());
    }

    private async reply(context: SlackMessageContext, message: string): Promise<void> {
        if (context.respond && !context.threadTs) {
            await context.respond(message);
        } else {
            await this.slackService.sendMessage(context.channelId, message, context.threadTs);
        }
    }

    private async replyWithBlocks(context: SlackMessageContext, text: string, blocks: any[]): Promise<void> {
        try {
            if (context.respond && !context.threadTs) {
                await context.respond({ text, blocks, response_type: 'in_channel' });
            } else {
                await this.slackService.sendBlockMessage(context.channelId, text, blocks, context.threadTs);
            }
        } catch (error: any) {
            logger.error('SLACK-CMD', `replyWithBlocks failed: ${error?.message}`, error);
            logger.error('SLACK-CMD', `Blocks count: ${blocks.length}, first block: ${JSON.stringify(blocks[0])}`);
            throw error;
        }
    }

    public dispose(): void {
        for (const [, watcher] of this.activeThreads) {
            watcher.stopWatching();
        }
        this.activeThreads.clear();
    }
}
