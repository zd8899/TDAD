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
            await this.slackService.sendMessage(
                context.channelId,
                `❌ Error: ${errorMsg}`,
                context.threadTs
            );
        }
    }

    private async handleNodeCommand(args: string[], context: SlackMessageContext): Promise<void> {
        const subCommand = args[0]?.toLowerCase();

        if (subCommand === 'create') {
            const nodeName = args.slice(1).join(' ');
            if (!nodeName) {
                await this.slackService.sendMessage(
                    context.channelId,
                    '❌ Usage: `/tdad node create <name>`',
                    context.threadTs
                );
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
            await this.slackService.sendMessage(
                context.channelId,
                `✅ Created node: *${nodeName}*`,
                context.threadTs
            );

            logger.log('SLACK-CMD', `Created node: ${nodeName}`);
        } else {
            await this.slackService.sendMessage(
                context.channelId,
                '❌ Usage: `/tdad node create <name>`',
                context.threadTs
            );
        }
    }

    private async handleAutopilotCommand(args: string[], context: SlackMessageContext): Promise<void> {
        const subCommand = args[0]?.toLowerCase();

        if (subCommand === 'start') {
            // Send initial message and get thread timestamp
            const threadTs = await this.slackService.sendMessage(
                context.channelId,
                '🚀 Starting autopilot...'
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

            await this.deps.startAutomation();

            await this.slackService.sendMessage(
                context.channelId,
                '✅ Autopilot started! CLI output will appear in this thread.',
                threadTs
            );

        } else if (subCommand === 'stop') {
            this.deps.stopAutomation();

            // Stop any active watchers
            for (const [ts, watcher] of this.activeThreads) {
                watcher.stopWatching();
            }
            this.activeThreads.clear();

            await this.slackService.sendMessage(
                context.channelId,
                '⏹️ Autopilot stopped.',
                context.threadTs
            );

        } else {
            await this.slackService.sendMessage(
                context.channelId,
                '❌ Usage: `/tdad autopilot start` or `/tdad autopilot stop`',
                context.threadTs
            );
        }
    }

    private async handleTestCommand(args: string[], context: SlackMessageContext): Promise<void> {
        const nodeName = args.join(' ');
        if (!nodeName) {
            await this.slackService.sendMessage(
                context.channelId,
                '❌ Usage: `/tdad test <node-name>`',
                context.threadTs
            );
            return;
        }

        const nodes = this.deps.getNodes();
        const node = nodes.find(n =>
            n.title.toLowerCase().includes(nodeName.toLowerCase()) &&
            !isFolderNode(n)
        );

        if (!node) {
            await this.slackService.sendMessage(
                context.channelId,
                `❌ Node not found: *${nodeName}*`,
                context.threadTs
            );
            return;
        }

        await this.slackService.sendMessage(
            context.channelId,
            `🧪 Running tests for: *${node.title}*...`,
            context.threadTs
        );

        await this.deps.runNodeTests(node.id);

        await this.slackService.sendMessage(
            context.channelId,
            `✅ Tests completed for: *${node.title}*`,
            context.threadTs
        );
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

        await this.slackService.sendMessage(context.channelId, message, context.threadTs);
    }

    private async handleNodesCommand(context: SlackMessageContext): Promise<void> {
        const nodes = this.deps.getNodes();
        const featureNodes = nodes.filter(n => !isFolderNode(n));

        if (featureNodes.length === 0) {
            await this.slackService.sendMessage(
                context.channelId,
                '📋 No nodes found.',
                context.threadTs
            );
            return;
        }

        const nodeList = featureNodes.map((n, i) => {
            const statusEmoji = (n as any).status === 'passed' ? '✅' :
                               (n as any).status === 'failed' ? '❌' : '⚪';
            return `${i + 1}. ${statusEmoji} ${n.title}`;
        }).join('\n');

        await this.slackService.sendMessage(
            context.channelId,
            `📋 *Nodes (${featureNodes.length}):*\n${nodeList}`,
            context.threadTs
        );
    }

    private async handleSayCommand(args: string[], context: SlackMessageContext): Promise<void> {
        const message = args.join(' ');
        if (!message) {
            await this.slackService.sendMessage(
                context.channelId,
                '❌ Usage: `/tdad say <message to send to CLI>`',
                context.threadTs
            );
            return;
        }

        const launcher = CLIAgentLauncher.getInstance(this.deps.workspacePath);
        if (!launcher) {
            await this.slackService.sendMessage(
                context.channelId,
                '❌ CLI agent not initialized.',
                context.threadTs
            );
            return;
        }

        // Send text to the terminal
        const terminal = vscode.window.terminals.find(t => t.name === 'TDAD Agent');
        if (terminal) {
            terminal.sendText(message);
            await this.slackService.sendMessage(
                context.channelId,
                `📤 Sent to CLI: \`${message}\``,
                context.threadTs
            );
            logger.log('SLACK-CMD', `Sent to terminal: ${message}`);
        } else {
            await this.slackService.sendMessage(
                context.channelId,
                '❌ No active TDAD Agent terminal found.',
                context.threadTs
            );
        }
    }

    private async handleStopCommand(context: SlackMessageContext): Promise<void> {
        // Send Ctrl+C to terminal
        const terminal = vscode.window.terminals.find(t => t.name === 'TDAD Agent');
        if (terminal) {
            terminal.sendText('\x03'); // Ctrl+C
            await this.slackService.sendMessage(
                context.channelId,
                '⏹️ Sent cancel signal (Ctrl+C) to CLI.',
                context.threadTs
            );
        } else {
            await this.slackService.sendMessage(
                context.channelId,
                '❌ No active TDAD Agent terminal found.',
                context.threadTs
            );
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

        await this.slackService.sendMessage(context.channelId, helpText, context.threadTs);
    }

    public dispose(): void {
        for (const [ts, watcher] of this.activeThreads) {
            watcher.stopWatching();
        }
        this.activeThreads.clear();
    }
}
