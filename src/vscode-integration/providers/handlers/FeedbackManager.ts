/**
 * FeedbackManager - Handles user feedback collection via webview form
 *
 * Shows a beautiful feedback form in the canvas webview.
 * Respects user preferences and doesn't spam - shows only after N sessions
 * and no more than once per X days.
 */

import * as vscode from 'vscode';
import { logExtension, logError } from '../../../shared/utils/Logger';

interface FeedbackState {
    sessionCount: number;
    lastPromptTime: number;  // timestamp
    feedbackGiven: boolean;  // user has given feedback at least once
}

// Message sender function type
type MessageSender = (message: any) => void;

export class FeedbackManager {
    private static readonly STATE_KEY = 'tdad.feedback.state';
    private static readonly SESSIONS_BEFORE_PROMPT = 5;  // Show after 5 sessions
    private static readonly DAYS_BETWEEN_PROMPTS = 14;   // Don't ask more than every 14 days
    private static readonly MS_PER_DAY = 24 * 60 * 60 * 1000;
    private static readonly WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbwJhUlMHeuF6BqE2Z64H1NshYsdm_Ak3O3jxCbPGNOxIxsSMS3D6Kp6gqiMzM16klQ/exec';

    private messageSender: MessageSender | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {}

    /**
     * Set the message sender function (from SimplifiedWorkflowCanvasProvider)
     */
    setMessageSender(sender: MessageSender): void {
        this.messageSender = sender;
    }

    /**
     * Call this on extension activation to track sessions and potentially show feedback
     */
    async onActivate(): Promise<void> {
        const state = this.getState();

        // Increment session count
        state.sessionCount++;
        await this.saveState(state);

        logExtension(`FeedbackManager: Session ${state.sessionCount}`);

        // Check if we should show feedback prompt
        if (this.shouldShowPrompt(state)) {
            // Delay the prompt so it doesn't appear immediately on startup
            setTimeout(() => this.showFeedbackForm(), 30000); // 30 seconds after activation
        }
    }

    private getState(): FeedbackState {
        return this.context.globalState.get<FeedbackState>(FeedbackManager.STATE_KEY, {
            sessionCount: 0,
            lastPromptTime: 0,
            feedbackGiven: false
        });
    }

    private async saveState(state: FeedbackState): Promise<void> {
        await this.context.globalState.update(FeedbackManager.STATE_KEY, state);
    }

    private shouldShowPrompt(state: FeedbackState): boolean {
        // Check if enough sessions have passed
        if (state.sessionCount < FeedbackManager.SESSIONS_BEFORE_PROMPT) {
            return false;
        }

        // Check if enough time has passed since last prompt
        const daysSinceLastPrompt = (Date.now() - state.lastPromptTime) / FeedbackManager.MS_PER_DAY;
        if (daysSinceLastPrompt < FeedbackManager.DAYS_BETWEEN_PROMPTS) {
            return false;
        }

        return true;
    }

    /**
     * Show the feedback form in the webview
     */
    private showFeedbackForm(): void {
        logExtension('FeedbackManager: Showing feedback form in webview...');

        const state = this.getState();

        // Update last prompt time
        state.lastPromptTime = Date.now();
        this.saveState(state);

        // Send message to webview to show feedback form
        if (this.messageSender) {
            this.messageSender({ command: 'showFeedbackForm' });
        } else {
            logExtension('FeedbackManager: No message sender available, cannot show feedback form');
        }
    }

    /**
     * Handle feedback submission from webview
     */
    async handleFeedbackSubmission(data: { complaint?: string; featureRequest?: string; type?: string }): Promise<void> {
        logExtension('FeedbackManager: Processing feedback submission...');

        const state = this.getState();
        let feedbackSent = false;

        // Handle "All good" positive feedback
        if (data.type === 'positive') {
            await this.sendFeedback('positive', 'User is happy with TDAD!');
            feedbackSent = true;
        }

        // Handle complaint
        if (data.complaint && data.complaint.trim()) {
            await this.sendFeedback('complaint', data.complaint.trim());
            feedbackSent = true;
        }

        // Handle feature request
        if (data.featureRequest && data.featureRequest.trim()) {
            await this.sendFeedback('feature_request', data.featureRequest.trim());
            feedbackSent = true;
        }

        if (feedbackSent) {
            state.feedbackGiven = true;
            await this.saveState(state);
            logExtension('FeedbackManager: Feedback processed successfully');
        }
    }

    private async sendFeedback(type: 'positive' | 'complaint' | 'feature_request', message: string): Promise<void> {
        try {
            const payload = {
                timestamp: new Date().toISOString(),
                type,
                message,
                extensionVersion: vscode.extensions.getExtension('tdad.tdad')?.packageJSON?.version || 'unknown',
                vscodeVersion: vscode.version,
                platform: process.platform
            };

            const response = await fetch(FeedbackManager.WEBHOOK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                logExtension('FeedbackManager: Feedback sent successfully');
            } else {
                logError('EXTENSION', `FeedbackManager: Failed to send feedback - ${response.status}`, null);
            }
        } catch (error) {
            logError('EXTENSION', 'FeedbackManager: Error sending feedback', error);
        }
    }

    /**
     * Manually trigger feedback form (e.g., from a command)
     */
    async requestFeedback(): Promise<void> {
        logExtension('FeedbackManager: Manual feedback request triggered');
        this.showFeedbackForm();
    }

    /**
     * Reset feedback state (for testing)
     */
    async resetState(): Promise<void> {
        await this.context.globalState.update(FeedbackManager.STATE_KEY, undefined);
        logExtension('FeedbackManager: State reset');
    }
}
