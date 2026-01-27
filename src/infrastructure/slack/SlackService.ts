/**
 * SlackService - Socket Mode connection for remote control
 * Sprint 15: Remote Control via Slack
 */

import { App, LogLevel } from '@slack/bolt';
import { logger } from '../../shared/utils/Logger';
import { SlackMessageContext, SlackCommandPayload } from '../../shared/types/slack';

type SlashCommandCallback = (payload: SlackCommandPayload) => Promise<void>;
type MessageCallback = (text: string, context: SlackMessageContext) => Promise<void>;

export class SlackService {
    private app: App | null = null;
    private static instance: SlackService | null = null;
    private connected: boolean = false;
    private slashCommandCallback: SlashCommandCallback | null = null;
    private messageCallback: MessageCallback | null = null;

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
            this.app.command('/tdad', async ({ command, ack, respond }) => {
                await ack();

                const args = command.text.trim().split(/\s+/);
                const context: SlackMessageContext = {
                    channelId: command.channel_id,
                    userId: command.user_id,
                    responseUrl: command.response_url
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
