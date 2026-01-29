/**
 * Slack Integration Types
 * Sprint 15: Remote Control via Slack
 */

export interface SlackSettings {
    enabled: boolean;
    defaultChannel: string;
}

/**
 * Home Tab view state - tracks what each user is currently viewing
 */
export type HomeTabView =
    | { type: 'dashboard' }
    | { type: 'folder'; folderId: string | null } // null = root
    | { type: 'node'; nodeId: string };

export interface SlackRespondOptions {
    text: string;
    blocks?: any[];
    response_type?: 'in_channel' | 'ephemeral';
}

export interface SlackMessageContext {
    channelId: string;
    threadTs?: string;
    userId: string;
    responseUrl?: string;
    triggerId?: string; // For opening modals
    viewId?: string; // For updating existing modals
    respond?: (message: string | SlackRespondOptions) => Promise<void>;
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

export interface AutomationStatus {
    status: string;
    currentNodeId?: string;
    phase?: string;
    message?: string;
    processedNodes?: string[];
    failedNodes?: string[];
    currentRetry?: number;
    maxRetries?: number;
}

export interface SlackCommandDependencies {
    // Existing
    getNodes: () => import('./index').Node[];
    addNode: (node: Partial<import('./index').Node>) => void;
    startAutomation: () => Promise<void>;
    stopAutomation: () => void;
    getAutomationStatus: () => AutomationStatus;
    runNodeTests: (nodeId: string) => Promise<void>;
    workspacePath: string;

    // Node management
    updateNode: (node: import('./index').Node) => void;
    getNodeById: (nodeId: string) => import('./index').Node | undefined;

    // Plan/Test management
    getPlanSpec: (nodeId: string) => Promise<string | null>;
    savePlanSpec: (nodeId: string, spec: string) => Promise<void>;

    // Automation
    runSingleNode: (nodeId: string, modes: string[]) => Promise<{ started: boolean; error?: string; nodeName?: string }>;
    runFolderNodes: (folderId: string | null, modes?: ('bdd' | 'test' | 'run-fix')[]) => Promise<void>;

    // CLI
    getCliOutput: (lines: number) => string;
    captureCliOutput: () => Promise<string | null>;
    killCliTerminal: () => boolean;
    clearAutomationState: () => void;

    // Channel management (for Home Tab fallback)
    getDefaultChannelId?: () => string | undefined;
    setDefaultChannelId?: (channelId: string) => void;
}
