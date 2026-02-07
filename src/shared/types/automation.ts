/**
 * Automation State Types
 * Defines the structure for .tdad/automation-state.json
 * This file is the single source of truth for automation execution
 */

export type AutomationNodeStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface AutomationNode {
    /** Node ID from the workflow */
    id: string;
    /** Node title for display */
    title: string;
    /** Folder path (e.g., "uxer-private/local-services") - helps identify which folder this node belongs to */
    folderPath: string;
    /** Current execution status */
    status: AutomationNodeStatus;
    /** Automation modes - editable boolean flags */
    modes: {
        /** Generate BDD plan/spec */
        bdd: boolean;
        /** Generate test code */
        test: boolean;
        /** Run tests and fix failures */
        runFix: boolean;
    };
    /** Error message if failed */
    error?: string;
    /** Number of retries attempted */
    retries?: number;
}

/** Retry configuration */
export interface RetryConfig {
    /** Maximum number of retries per node */
    maxRetries: number;
    /** Delay between retries in milliseconds */
    retryDelayMs: number;
}

/** Execution settings */
export interface ExecutionSettings {
    /** Max concurrent nodes (1 = sequential, >1 = parallel - future feature) */
    concurrency: number;
}

export interface AutomationState {
    /** Workflow ID this automation is for */
    workflowId: string;
    /** Folder ID this automation is scoped to (null = all folders) */
    folderId: string | null;
    /** Overall automation status */
    status: 'pending' | 'running' | 'completed' | 'stopped' | 'error';
    /** Status values to skip (e.g. ["passed"]) */
    skipStatuses: AutomationNodeStatus[];
    /** Retry configuration */
    retryConfig: RetryConfig;
    /** Execution settings */
    executionSettings: ExecutionSettings;
    /** List of nodes to execute (ordered by array index) */
    nodes: AutomationNode[];
    /** Index of currently executing node (-1 = not started) */
    currentIndex: number;
    /** When automation was created */
    createdAt: string;
    /** When automation was last updated */
    updatedAt: string;
    /** When automation started */
    startedAt?: string;
    /** When automation completed */
    completedAt?: string;
}
