/**
 * SlackCommandHandler - Routes Slack slash commands to TDAD functionality
 * Sprint 15: Remote Control via Slack
 */

import * as vscode from 'vscode';
import { SlackService } from './SlackService';
import { SlackCommandPayload, SlackMessageContext } from '../../shared/types/slack';
import { Node } from '../../shared/types';
import { isFolderNode } from '../../shared/types/typeGuards';
import { logger } from '../../shared/utils/Logger';
import { CLIAgentLauncher } from '../../vscode-integration/CLIAgentLauncher';
import { CLIOutputWatcher } from './CLIOutputWatcher';

export interface SlackCommandDependencies {
    getNodes: () => Node[];
    addNode: (node: Partial<Node>) => void;
    startAutomation: () => Promise<void>;
    stopAutomation: () => void;
    getAutomationStatus: () => { status: string; currentNodeId?: string; phase?: string; message?: string };
    runNodeTests: (nodeId: string) => Promise<void>;
    workspacePath: string;
}

export class SlackCommandHandler {
    private activeThreads: Map<string, CLIOutputWatcher> = new Map();

    constructor(
        private readonly slackService: SlackService,
        private readonly deps: SlackCommandDependencies
    ) {}

    public async handleCommand(payload: SlackCommandPayload): Promise<void> {
        const { command, args, context } = payload;

        logger.log('SLACK-CMD', `Handling: ${command} ${args.join(' ')}`);

        try {
            switch (command.toLowerCase()) {
                case 'node':
                    await this.handleNodeCommand(args, context);
                    break;
                case 'autopilot':
                    await this.handleAutopilotCommand(args, context);
                    break;
                case 'test':
                    await this.handleTestCommand(args, context);
                    break;
                case 'status':
                    await this.handleStatusCommand(context);
                    break;
                case 'nodes':
                    await this.handleNodesCommand(context);
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

    private async handleNodeCommand(args: string[], context: SlackMessageContext): Promise<void> {
        const subCommand = args[0]?.toLowerCase();

        if (subCommand === 'create') {
            const nodeName = args.slice(1).join(' ');
            if (!nodeName) {
                await this.reply(context, '❌ Usage: `/tdad node create <name>`');
                return;
            }

            const newNode: Partial<Node> = {
                id: `node-${Date.now()}`,
                workflowId: 'default',
                nodeType: 'file',
                title: nodeName,
                description: `Created via Slack by <@${context.userId}>`,
                position: { x: 100, y: 100 }
            };

            this.deps.addNode(newNode);
            await this.reply(context, `✅ Created node: *${nodeName}*`);
            logger.log('SLACK-CMD', `Created node: ${nodeName}`);
        } else {
            await this.reply(context, '❌ Usage: `/tdad node create <name>`');
        }
    }

    private async handleAutopilotCommand(args: string[], context: SlackMessageContext): Promise<void> {
        const subCommand = args[0]?.toLowerCase();

        if (subCommand === 'start') {
            // For autopilot start, we need to post to channel to create a thread
            // First respond to slash command
            await this.reply(context, '🚀 Starting autopilot...');

            // Then post to channel if bot has access (for thread-based output)
            try {
                const threadTs = await this.slackService.sendMessage(
                    context.channelId,
                    '📺 *Autopilot Output Thread* - CLI output will appear here'
                );

                if (threadTs) {
                    // Start CLI output watcher for this thread
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

            // Stop any active watchers
            for (const [ts, watcher] of this.activeThreads) {
                watcher.stopWatching();
            }
            this.activeThreads.clear();

            await this.reply(context, '⏹️ Autopilot stopped.');

        } else {
            await this.reply(context, '❌ Usage: `/tdad autopilot start` or `/tdad autopilot stop`');
        }
    }

    private async handleTestCommand(args: string[], context: SlackMessageContext): Promise<void> {
        const nodeName = args.join(' ');
        if (!nodeName) {
            await this.reply(context, '❌ Usage: `/tdad test <node-name>`');
            return;
        }

        const nodes = this.deps.getNodes();
        const node = nodes.find(n =>
            n.title.toLowerCase().includes(nodeName.toLowerCase()) &&
            !isFolderNode(n)
        );

        if (!node) {
            await this.reply(context, `❌ Node not found: *${nodeName}*`);
            return;
        }

        await this.reply(context, `🧪 Running tests for: *${node.title}*...`);
        await this.deps.runNodeTests(node.id);
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
        const nodes = this.deps.getNodes();
        const featureNodes = nodes.filter(n => !isFolderNode(n));

        if (featureNodes.length === 0) {
            await this.reply(context, '📋 No nodes found.');
            return;
        }

        const nodeList = featureNodes.map((n, i) => {
            const statusEmoji = (n as any).status === 'passed' ? '✅' :
                               (n as any).status === 'failed' ? '❌' : '⚪';
            return `${i + 1}. ${statusEmoji} ${n.title}`;
        }).join('\n');

        await this.reply(context, `📋 *Nodes (${featureNodes.length}):*\n${nodeList}`);
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

        // Send text to the terminal
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
        // Send Ctrl+C to terminal
        const terminal = vscode.window.terminals.find(t => t.name === 'TDAD Agent');
        if (terminal) {
            terminal.sendText('\x03'); // Ctrl+C
            await this.reply(context, '⏹️ Sent cancel signal (Ctrl+C) to CLI.');
        } else {
            await this.reply(context, '❌ No active TDAD Agent terminal found.');
        }

        // Also stop automation
        this.deps.stopAutomation();

        // Stop watchers
        for (const [ts, watcher] of this.activeThreads) {
            watcher.stopWatching();
        }
        this.activeThreads.clear();
    }

    private async handleHelpCommand(context: SlackMessageContext): Promise<void> {
        const helpText = `*TDAD Slack Commands:*

📦 *Node Management:*
\`/tdad node create <name>\` - Create a new node
\`/tdad nodes\` - List all nodes

🤖 *Automation:*
\`/tdad autopilot start\` - Start autopilot
\`/tdad autopilot stop\` - Stop autopilot
\`/tdad status\` - Get current status

🧪 *Testing:*
\`/tdad test <node-name>\` - Run tests for a node

💬 *CLI Interaction:*
\`/tdad say <message>\` - Send message to running CLI
\`/tdad stop\` - Send Ctrl+C to CLI

❓ \`/tdad help\` - Show this help`;

        await this.reply(context, helpText);
    }

    /**
     * Reply to a slash command - uses respond() for slash commands, sendMessage for threads
     */
    private async reply(context: SlackMessageContext, message: string): Promise<void> {
        // For slash commands, use respond() which doesn't require channel membership
        if (context.respond && !context.threadTs) {
            await context.respond(message);
        } else {
            // For thread replies or when respond isn't available, use sendMessage
            await this.slackService.sendMessage(context.channelId, message, context.threadTs);
        }
    }

    public dispose(): void {
        for (const [ts, watcher] of this.activeThreads) {
            watcher.stopWatching();
        }
        this.activeThreads.clear();
    }
}
