/**
 * Slack Integration Types
 * Sprint 15: Remote Control via Slack
 */

export interface SlackSettings {
    enabled: boolean;
    defaultChannel: string;
}

export interface SlackMessageContext {
    channelId: string;
    threadTs?: string;
    userId: string;
    responseUrl?: string;
    respond?: (message: string) => Promise<void>;
}

export interface SlackCommandPayload {
    command: string;
    args: string[];
    text: string;
    context: SlackMessageContext;
}

export type SlackCommandType =
    | 'node-create'
    | 'autopilot-start'
    | 'autopilot-stop'
    | 'test'
    | 'status'
    | 'nodes'
    | 'say'
    | 'stop'
    | 'help';

export interface SlackCommandResult {
    success: boolean;
    message: string;
    data?: any;
}

export interface CLIOutputChunk {
    content: string;
    timestamp: number;
    isError: boolean;
}
