/**
 * SlackService - Socket Mode connection for remote control
 * Sprint 15: Remote Control via Slack
 */

import { App, LogLevel } from '@slack/bolt';
import { logger } from '../../shared/utils/Logger';
import { SlackMessageContext } from '../../shared/types/slack';

type MessageCallback = (text: string, context: SlackMessageContext) => Promise<void>;
type ActionCallback = (actionId: string, value: string, context: SlackMessageContext) => Promise<void>;
type ViewSubmissionCallback = (callbackId: string, values: Record<string, any>, privateMetadata: string, context: SlackMessageContext) => Promise<any | void>;
type AppHomeOpenedCallback = (context: SlackMessageContext) => Promise<void>;
    
    export class SlackService {
        private app: App | null = null;
        private static instance: SlackService | null = null;
        private connected: boolean = false;
        private messageCallback: MessageCallback | null = null;
        private actionCallback: ActionCallback | null = null;
        private viewSubmissionCallback: ViewSubmissionCallback | null = null;
        private appHomeOpenedCallback: AppHomeOpenedCallback | null = null;

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

            // Register message handler for thread replies
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
                        viewId: (body as any).view?.id, // For updating existing modals
                        respond: async (message) => {
                            logger.log('SLACK', `Action respond called with: ${typeof message === 'string' ? message : JSON.stringify(message)}`);

                            // Check if respond function is available (not available for Home tab actions)
                            if (typeof respond !== 'function') {
                                logger.log('SLACK', 'Action respond skipped: no respond function (Home tab action)');
                                return;
                            }

                            try {
                                // Detect if this is from Home tab (no channel context)
                                const isFromHomeTab = !body.channel?.id;
                                const responseType = isFromHomeTab ? 'ephemeral' : 'in_channel';

                                if (typeof message === 'string') {
                                    // Text-only responses don't replace (notifications)
                                    await respond({ text: message, response_type: responseType, replace_original: false });
                                } else if (message.blocks) {
                                    // Block responses replace the original (UI navigation)
                                    await respond({
                                        text: message.text,
                                        blocks: message.blocks,
                                        response_type: responseType,
                                        replace_original: !isFromHomeTab  // Don't replace Home tab view
                                    });
                                } else {
                                    await respond({ text: message.text, response_type: responseType, replace_original: false });
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
                logger.log('SLACK', `View submission: ${view.callback_id}`);

                if (this.viewSubmissionCallback) {
                    const values: Record<string, any> = {};
                    // Extract values from view state
                    for (const [blockId, block] of Object.entries(view.state.values)) {
                        for (const [actionId, action] of Object.entries(block)) {
                            const actionData = action as any;
                            // Handle different input types:
                            // - text inputs: .value
                            // - single select: .selected_option.value
                            // - checkboxes/multi-select: .selected_options[].value
                            if (actionData.selected_options) {
                                // Checkboxes or multi-select - extract values from array
                                values[actionId] = actionData.selected_options.map((opt: any) => opt.value);
                            } else if (actionData.selected_option) {
                                // Single select
                                values[actionId] = actionData.selected_option.value;
                            } else {
                                // Text input
                                values[actionId] = actionData.value;
                            }
                        }
                    }

                    const context: SlackMessageContext = {
                        channelId: '', // Not available in view submission - use private_metadata
                        userId: body.user?.id || ''
                    };

                    // Terminal modal needs to return an updated view to stay open
                    // For all other modals, ack immediately and process in background
                    if (view.callback_id === 'tdad_terminal_modal') {
                        const updatedView = await this.viewSubmissionCallback(view.callback_id, values, view.private_metadata || '', context);
                        if (updatedView) {
                            await ack({ response_action: 'update', view: updatedView });
                        } else {
                            await ack();
                        }
                    } else {
                        // Ack immediately to avoid Slack timeout (must respond within 3 seconds)
                        await ack();
                        // Process callback asynchronously - errors are logged, not thrown
                        this.viewSubmissionCallback(view.callback_id, values, view.private_metadata || '', context)
                            .catch(err => logger.error('SLACK', `View submission callback error: ${err.message}`, err));
                    }
                } else {
                    await ack();
                }
            });

            // Register App Home Opened event
            this.app.event('app_home_opened', async ({ event, client, logger: slackLogger }) => {
                logger.log('SLACK', `App Home Opened by ${event.user}`);
                if (this.appHomeOpenedCallback) {
                    const context: SlackMessageContext = {
                        channelId: '', // Home tab is user-specific, not channel-specific
                        userId: event.user
                    };
                    await this.appHomeOpenedCallback(context);
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

    public onMessage(callback: MessageCallback): void {
        this.messageCallback = callback;
    }

    public onAction(callback: ActionCallback): void {
        this.actionCallback = callback;
    }

    public onViewSubmission(callback: ViewSubmissionCallback): void {
        this.viewSubmissionCallback = callback;
    }

    public onAppHomeOpened(callback: AppHomeOpenedCallback): void {
        this.appHomeOpenedCallback = callback;
    }

    /**
     * Publish a view to the App Home tab
     */
    public async publishHomeView(userId: string, blocks: any[]): Promise<void> {
        if (!this.app || !this.connected) {
            logger.log('SLACK', 'Cannot publish home view: not connected');
            return;
        }

        try {
            await this.app.client.views.publish({
                user_id: userId,
                view: {
                    type: 'home',
                    blocks: blocks
                }
            });
            logger.log('SLACK', `Published Home View for ${userId}`);
        } catch (error: any) {
            logger.error('SLACK', `Failed to publish home view: ${error.message}`, error);
        }
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

    /**
     * Update an existing modal (used for refresh within modal)
     */
    public async updateModal(viewId: string, view: any): Promise<void> {
        if (!this.app || !this.connected) {
            logger.log('SLACK', 'Cannot update modal: not connected');
            throw new Error('Slack not connected');
        }

        try {
            await this.app.client.views.update({
                view_id: viewId,
                view
            });
            logger.log('SLACK', `Modal updated: ${view.callback_id}`);
        } catch (error: any) {
            logger.error('SLACK', `Failed to update modal: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * Check if bot is a member of the given channel
     */
    public async isBotInChannel(channelId: string): Promise<boolean> {
        if (!this.app || !this.connected) {
            return false;
        }

        try {
            const result = await this.app.client.conversations.info({ channel: channelId });
            return (result.channel as any)?.is_member === true;
        } catch (error: any) {
            logger.log('SLACK', `Could not check channel membership: ${error.message}`);
            return false;
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
        } catch (error: any) {
            const errorStr = (error.message || error.code || '').toLowerCase();
            if (errorStr.includes('not_in_channel') || errorStr.includes('channel_not_found')) {
                logger.log('SLACK', `Bot not in channel ${channel}. User needs to run: /invite @TDAD`);
                // Return a special marker so callers can handle this
                throw new Error('BOT_NOT_IN_CHANNEL');
            }
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

    /**
     * Join a channel (works for public channels)
     * For private channels, user must manually invite the bot
     */
    public async joinChannel(channelId: string): Promise<{ success: boolean; message: string }> {
        if (!this.app || !this.connected) {
            return { success: false, message: 'Not connected to Slack' };
        }

        try {
            await this.app.client.conversations.join({ channel: channelId });
            logger.log('SLACK', `Joined channel ${channelId}`);
            return { success: true, message: 'Successfully joined the channel! Notifications will now work.' };
        } catch (error: any) {
            const errorMsg = error.message || error.code || JSON.stringify(error) || 'Unknown error';
            logger.error('SLACK', `Failed to join channel ${channelId}: ${errorMsg}`);

            // Check error message or code for known error types
            const errorStr = errorMsg.toLowerCase();
            if (errorStr.includes('missing_scope') || error.code === 'missing_scope') {
                return {
                    success: false,
                    message: 'Please invite the bot manually by typing `/invite @TDAD` in the channel.\n\n_(To enable auto-join, add `channels:join` scope in Slack App settings)_'
                };
            }
            if (errorStr.includes('channel_not_found') || errorStr.includes('is_private')) {
                return {
                    success: false,
                    message: 'This is a private channel. Please invite the bot manually by typing `/invite @TDAD`'
                };
            }
            if (errorStr.includes('already_in_channel')) {
                return { success: true, message: 'Bot is already in this channel!' };
            }
            // Default fallback - always give helpful instructions
            return { success: false, message: 'Please invite the bot manually by typing `/invite @TDAD` in the channel.' };
        }
    }

    public dispose(): void {
        this.disconnect();
        SlackService.instance = null;
    }
}
