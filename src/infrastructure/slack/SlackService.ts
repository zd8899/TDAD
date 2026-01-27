/**
 * SlackService - Socket Mode connection for remote control
 * Sprint 15: Remote Control via Slack
 */

import { App, LogLevel } from '@slack/bolt';
import axios from 'axios';
import { logger } from '../../shared/utils/Logger';
import { SlackMessageContext, SlackCommandPayload } from '../../shared/types/slack';

type SlashCommandCallback = (payload: SlackCommandPayload) => Promise<void>;
type MessageCallback = (text: string, context: SlackMessageContext) => Promise<void>;
type ActionCallback = (actionId: string, value: string, context: SlackMessageContext) => Promise<void>;
type ViewSubmissionCallback = (callbackId: string, values: Record<string, any>, privateMetadata: string, context: SlackMessageContext) => Promise<void>;

export class SlackService {
    private app: App | null = null;
    private static instance: SlackService | null = null;
    private connected: boolean = false;
    private slashCommandCallback: SlashCommandCallback | null = null;
    private messageCallback: MessageCallback | null = null;
    private actionCallback: ActionCallback | null = null;
    private viewSubmissionCallback: ViewSubmissionCallback | null = null;

    private constructor() {}

    public static getInstance(): SlackService {
        if (!SlackService.instance) {
            SlackService.instance = new SlackService();
        }
        return SlackService.instance;
    }

    public async connect(botToken: string, appToken: string): Promise<void> {
        if (this.connected) {
            logger.log('SLACK', 'Already connected');
            return;
        }

        try {
            this.app = new App({
                token: botToken,
                appToken: appToken,
                socketMode: true,
                logLevel: LogLevel.WARN
            });

            // Register slash command handler
            this.app.command('/tdad', async ({ command, ack, respond, client }) => {
                await ack();

                const args = command.text.trim().split(/\s+/);
                const context: SlackMessageContext = {
                    channelId: command.channel_id,
                    userId: command.user_id,
                    responseUrl: command.response_url,
                    respond: async (message) => {
                        if (typeof message === 'string') {
                            await respond({ text: message, response_type: 'ephemeral' });
                        } else if (message.blocks) {
                            logger.log('SLACK', `Responding with ${message.blocks.length} blocks`);
                            logger.log('SLACK', `Blocks JSON: ${JSON.stringify(message.blocks)}`);
                            try {
                                await respond({
                                    text: message.text,
                                    blocks: message.blocks,
                                    response_type: 'in_channel'
                                });
                            } catch (err: any) {
                                logger.error('SLACK', `respond() with blocks failed: ${err.message}`);
                                if (err.response?.data) {
                                    logger.error('SLACK', `Slack error response: ${JSON.stringify(err.response.data)}`);
                                }
                                throw err;
                            }
                        } else {
                            await respond({
                                text: message.text,
                                response_type: message.response_type || 'ephemeral'
                            });
                        }
                    }
                };

                logger.log('SLACK', `Received command: /tdad ${command.text}`);

                if (this.slashCommandCallback) {
                    try {
                        await this.slashCommandCallback({
                            command: args[0] || 'help',
                            args: args.slice(1),
                            text: command.text,
                            context
                        });
                    } catch (error) {
                        logger.error('SLACK', 'Error handling command', error);
                        await respond(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    }
                }
            });

            // Register message handler for thread replies (for /tdad say)
            this.app.message(async ({ message, say }) => {
                // Only handle messages that mention the bot or are in a thread we're tracking
                if (this.messageCallback && 'text' in message && message.text) {
                    const context: SlackMessageContext = {
                        channelId: message.channel,
                        threadTs: 'thread_ts' in message ? message.thread_ts : undefined,
                        userId: 'user' in message ? message.user || '' : ''
                    };

                    await this.messageCallback(message.text, context);
                }
            });

            // Register action handler for interactive components (buttons, selects)
            this.app.action(/^tdad_.*/, async ({ action, ack, body, respond }) => {
                await ack();
                logger.log('SLACK', `Action received: ${JSON.stringify(action)}`);

                if (this.actionCallback && 'action_id' in action) {
                    const context: SlackMessageContext = {
                        channelId: body.channel?.id || '',
                        userId: body.user?.id || '',
                        triggerId: (body as any).trigger_id, // For opening modals
                        respond: async (message) => {
                            logger.log('SLACK', `Action respond called with: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
                            try {
                                if (typeof message === 'string') {
                                    await respond({ text: message, response_type: 'ephemeral' });
                                } else if (message.blocks) {
                                    await respond({
                                        text: message.text,
                                        blocks: message.blocks,
                                        response_type: 'in_channel',
                                        replace_original: true
                                    });
                                } else {
                                    await respond({ text: message.text, response_type: 'ephemeral' });
                                }
                            } catch (err: any) {
                                logger.error('SLACK', `Action respond failed: ${err.message}`);
                                if (err.response?.data) {
                                    logger.error('SLACK', `Error data: ${JSON.stringify(err.response.data)}`);
                                }
                                throw err;
                            }
                        }
                    };

                    const value = 'selected_option' in action
                        ? (action.selected_option as any)?.value || ''
                        : 'value' in action ? (action as any).value : '';

                    logger.log('SLACK', `Calling actionCallback: ${action.action_id} = ${value}`);
                    await this.actionCallback(action.action_id, value, context);
                } else {
                    logger.log('SLACK', `No actionCallback or no action_id`);
                }
            });

            // Register view submission handler for modals
            this.app.view(/^tdad_.*/, async ({ ack, body, view }) => {
                await ack();
                logger.log('SLACK', `View submission: ${view.callback_id}`);

                if (this.viewSubmissionCallback) {
                    const values: Record<string, any> = {};
                    // Extract values from view state
                    for (const [blockId, block] of Object.entries(view.state.values)) {
                        for (const [actionId, action] of Object.entries(block)) {
                            values[actionId] = (action as any).value || (action as any).selected_option?.value;
                        }
                    }

                    const context: SlackMessageContext = {
                        channelId: '', // Not available in view submission
                        userId: body.user?.id || ''
                    };

                    await this.viewSubmissionCallback(view.callback_id, values, view.private_metadata || '', context);
                }
            });

            await this.app.start();
            this.connected = true;
            logger.log('SLACK', 'Connected via Socket Mode');

        } catch (error) {
            logger.error('SLACK', 'Failed to connect', error);
            throw error;
        }
    }

    public async disconnect(): Promise<void> {
        if (this.app && this.connected) {
            await this.app.stop();
            this.connected = false;
            this.app = null;
            logger.log('SLACK', 'Disconnected');
        }
    }

    public isConnected(): boolean {
        return this.connected;
    }

    public onSlashCommand(callback: SlashCommandCallback): void {
        this.slashCommandCallback = callback;
    }

    public onMessage(callback: MessageCallback): void {
        this.messageCallback = callback;
    }

    public onAction(callback: ActionCallback): void {
        this.actionCallback = callback;
    }

    public onViewSubmission(callback: ViewSubmissionCallback): void {
        this.viewSubmissionCallback = callback;
    }

    /**
     * Open a modal dialog
     */
    public async openModal(triggerId: string, view: any): Promise<void> {
        if (!this.app || !this.connected) {
            logger.log('SLACK', 'Cannot open modal: not connected');
            throw new Error('Slack not connected');
        }

        try {
            await this.app.client.views.open({
                trigger_id: triggerId,
                view
            });
            logger.log('SLACK', `Modal opened: ${view.callback_id}`);
        } catch (error: any) {
            logger.error('SLACK', `Failed to open modal: ${error.message}`, error);
            throw error;
        }
    }

    public async sendMessage(
        channel: string,
        text: string,
        threadTs?: string
    ): Promise<string | undefined> {
        if (!this.app || !this.connected) {
            logger.log('SLACK', 'Cannot send message: not connected');
            return undefined;
        }

        try {
            const result = await this.app.client.chat.postMessage({
                channel,
                text,
                thread_ts: threadTs
            });

            return result.ts;
        } catch (error) {
            logger.error('SLACK', 'Failed to send message', error);
            throw error;
        }
    }

    public async sendCodeBlock(
        channel: string,
        code: string,
        language: string = '',
        threadTs?: string
    ): Promise<void> {
        const formattedCode = `\`\`\`${language}\n${code}\n\`\`\``;
        await this.sendMessage(channel, formattedCode, threadTs);
    }

    /**
     * Send a message with Block Kit blocks (for interactive components)
     */
    public async sendBlockMessage(
        channel: string,
        text: string,
        blocks: any[],
        threadTs?: string
    ): Promise<string | undefined> {
        if (!this.app || !this.connected) {
            logger.log('SLACK', 'Cannot send block message: not connected');
            return undefined;
        }

        try {
            const result = await this.app.client.chat.postMessage({
                channel,
                text, // Fallback text
                blocks,
                thread_ts: threadTs
            });

            return result.ts;
        } catch (error) {
            logger.error('SLACK', 'Failed to send block message', error);
            throw error;
        }
    }

    public async sendCLIOutput(
        channel: string,
        output: string,
        threadTs?: string
    ): Promise<void> {
        // Truncate if too long (Slack has 40k char limit)
        const maxLength = 3800;
        let truncatedOutput = output;
        if (output.length > maxLength) {
            truncatedOutput = output.substring(output.length - maxLength) + '\n... (truncated)';
        }

        const formatted = `\`\`\`\n${truncatedOutput}\n\`\`\``;
        await this.sendMessage(channel, formatted, threadTs);
    }

    public dispose(): void {
        this.disconnect();
        SlackService.instance = null;
    }
}
