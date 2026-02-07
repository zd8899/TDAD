import * as fs from 'fs';
import * as path from 'path';
import { Node } from '../../shared/types';
import { logger, logError } from '../../shared/utils/Logger';

/**
 * TaskFileManager - Sprint 13: Agent Orchestrator
 *
 * Manages the file-based communication protocol between TDAD and AI agents.
 * - Writes .tdad/NEXT_TASK.md (TDAD -> Agent)
 * - Reads .tdad/AGENT_DONE.md (Agent -> TDAD)
 */

export type TaskStatus = 'GENERATE_TESTS' | 'FIX' | 'COMPLETE' | 'GENERATE_BDD' | 'GENERATE_BLUEPRINT';

export interface TaskContext {
    status: TaskStatus;
    node: Node;
    workflowName: string;
    retryCount: number;
    maxRetries: number;
    goal: string;
    context: string;
    bddSpec?: string;
    errorContext?: string;
}

export interface AgentResponse {
    status: 'DONE' | 'STUCK';
    reason?: string;
    approach?: string;  // For FIX tasks: description of what approach was tried
}

export class TaskFileManager {
    private readonly workspacePath: string;
    private readonly tdadDir: string;
    private readonly taskDir: string;
    private readonly nextTaskFile: string;
    private readonly agentDoneFile: string;
    private readonly nodeId: string | undefined;

    constructor(workspacePath: string, nodeId?: string) {
        this.workspacePath = workspacePath;
        this.nodeId = nodeId;
        this.tdadDir = path.join(workspacePath, '.tdad');
        if (nodeId) {
            this.taskDir = path.join(this.tdadDir, 'tasks', nodeId);
            this.nextTaskFile = path.join(this.taskDir, 'NEXT_TASK.md');
            this.agentDoneFile = path.join(this.taskDir, 'AGENT_DONE.md');
        } else {
            this.taskDir = this.tdadDir;
            this.nextTaskFile = path.join(this.tdadDir, 'NEXT_TASK.md');
            this.agentDoneFile = path.join(this.tdadDir, 'AGENT_DONE.md');
        }
    }

    /**
     * Ensure .tdad directory exists
     */
    private ensureDirectoryExists(): void {
        if (!fs.existsSync(this.taskDir)) {
            fs.mkdirSync(this.taskDir, { recursive: true });
            logger.log('TASK-FILE-MANAGER', `Created directory: ${this.taskDir}`);
        }
    }

    /**
     * Write the NEXT_TASK.md file for the agent to read
     */
    public writeNextTask(taskContext: TaskContext): void {
        this.ensureDirectoryExists();

        const taskContent = this.formatTaskFile(taskContext);

        fs.writeFileSync(this.nextTaskFile, taskContent, 'utf-8');
        logger.log('TASK-FILE-MANAGER', `Wrote NEXT_TASK.md for node: ${taskContext.node.title}`);

        // Clear AGENT_DONE.md to prepare for next response
        this.clearAgentDone();
    }

    /**
     * Format the task file content
     * - FIX tasks: Golden packet content + retry at end
     * - Other tasks: No header metadata (context is self-contained in prompts)
     */
    private formatTaskFile(ctx: TaskContext): string {
        const lines: string[] = [];

        // BDD Spec (only for GENERATE_BDD - GENERATE_TESTS and FIX use generate-tests.md template which includes it)
        if (ctx.bddSpec && ctx.status !== 'GENERATE_TESTS' && ctx.status !== 'FIX') {
            lines.push('## BDD Specification');
            lines.push('```gherkin');
            lines.push(ctx.bddSpec);
            lines.push('```');
            lines.push('');
            lines.push('---');
            lines.push('');
        }

        // Error context (for FIX status) - no header, just the content
        if (ctx.status === 'FIX' && ctx.errorContext) {
            lines.push(ctx.errorContext);
            lines.push('');
        }

        // Context section (skip if empty - FIX tasks don't need implementation patterns)
        // Prompts already start with # SYSTEM RULES, no extra header needed
        if (ctx.context && ctx.context.trim()) {
            lines.push(ctx.context);
            lines.push('');
        }

        // FIX tasks: Retry info at the end
        if (ctx.status === 'FIX') {
            lines.push('---');
            lines.push('');
            lines.push(`**Retry:** ${ctx.retryCount}/${ctx.maxRetries}`);
        }

        return lines.join('\n');
    }

    /**
     * Read and parse the AGENT_DONE.md file
     * @returns Agent response or null if file doesn't exist or is empty
     *
     * Expected formats:
     * - `DONE` - Task completed (no approach description)
     * - `DONE: <approach description>` - FIX task completed with approach description
     * - `STUCK: <reason>` - Agent is stuck
     */
    public readAgentDone(): AgentResponse | null {
        try {
            if (!fs.existsSync(this.agentDoneFile)) {
                return null;
            }

            const content = fs.readFileSync(this.agentDoneFile, 'utf-8').trim();

            if (!content) {
                return null;
            }

            // Parse the response - check for DONE with approach first
            if (content.toUpperCase().startsWith('DONE:')) {
                const approach = content.substring(5).trim();
                logger.log('TASK-FILE-MANAGER', `Agent DONE with approach: ${approach.substring(0, 50)}...`);
                return { status: 'DONE', approach };
            }

            if (content.toUpperCase() === 'DONE') {
                return { status: 'DONE' };
            }

            if (content.toUpperCase().startsWith('STUCK:')) {
                const reason = content.substring(6).trim();
                return { status: 'STUCK', reason };
            }

            // Unknown format - treat as DONE with the content as approach description
            logger.log('TASK-FILE-MANAGER', `Unknown AGENT_DONE format, treating as approach: ${content.substring(0, 50)}`);
            return { status: 'DONE', approach: content };

        } catch (error) {
            logError('TASK-FILE-MANAGER', 'Failed to read AGENT_DONE.md', error);
            return null;
        }
    }

    /**
     * Clear the AGENT_DONE.md file
     */
    public clearAgentDone(): void {
        try {
            if (fs.existsSync(this.agentDoneFile)) {
                fs.unlinkSync(this.agentDoneFile);
                logger.log('TASK-FILE-MANAGER', 'Cleared AGENT_DONE.md');
            }
        } catch (error) {
            logError('TASK-FILE-MANAGER', 'Failed to clear AGENT_DONE.md', error);
        }
    }

    /**
     * Write a blueprint task using a pre-generated prompt (same as Blueprint Wizard)
     */
    public writeBlueprintTaskWithPrompt(prompt: string): void {
        this.ensureDirectoryExists();

        const content = `# CURRENT TASK

**Status:** GENERATE_BLUEPRINT

---

${prompt}

---

## When Done

1. Save the workflow files as described above
2. Write "DONE" to \`.tdad/AGENT_DONE.md\`

If you get stuck:
1. Write "STUCK: [reason]" to \`.tdad/AGENT_DONE.md\`
`;

        fs.writeFileSync(this.nextTaskFile, content, 'utf-8');
        logger.log('TASK-FILE-MANAGER', 'Wrote GENERATE_BLUEPRINT task with full prompt to NEXT_TASK.md');

        // Clear AGENT_DONE.md to prepare for response
        this.clearAgentDone();
    }

    /**
     * Write a COMPLETE status to indicate automation is finished
     */
    public writeComplete(message: string): void {
        this.ensureDirectoryExists();

        const content = `# AUTOMATION COMPLETE

**Status:** COMPLETE

---

## Summary
${message}

---

All nodes have been processed. The automation loop has finished.
`;

        fs.writeFileSync(this.nextTaskFile, content, 'utf-8');
        logger.log('TASK-FILE-MANAGER', 'Wrote COMPLETE status to NEXT_TASK.md');
    }

    /**
     * Write a FAILED status to indicate node failed after max retries
     */
    public writeFailed(nodeTitle: string, message: string, retryCount: number, maxRetries: number): void {
        this.ensureDirectoryExists();

        const content = `# AUTOMATION FAILED

**Status:** FAILED
**Node:** ${nodeTitle}
**Retries:** ${retryCount}/${maxRetries}

---

## Summary
${message}

---

## What to do next

The automated fix loop has exhausted all retry attempts. Manual intervention is required:

1. **Review the fix attempts** in \`.tdad/debug/\` to see what was tried
2. **Check the trace files** in \`.tdad/debug/\` for complete request/response data
3. **Add debug logs** to understand the issue better
4. **Fix manually** and run tests via the TDAD canvas

When ready to retry automation, use the "Start Single Node" button on the canvas.
`;

        fs.writeFileSync(this.nextTaskFile, content, 'utf-8');
        logger.log('TASK-FILE-MANAGER', `Wrote FAILED status to NEXT_TASK.md for node: ${nodeTitle}`);
    }

    /**
     * Get the path to AGENT_DONE.md for file watching
     */
    public getAgentDoneFilePath(): string {
        return this.agentDoneFile;
    }

    /**
     * Get the path to NEXT_TASK.md
     */
    public getNextTaskFilePath(): string {
        return this.nextTaskFile;
    }

    /**
     * Check if AGENT_DONE.md exists and has content
     */
    public hasAgentResponse(): boolean {
        if (!fs.existsSync(this.agentDoneFile)) {
            return false;
        }

        const content = fs.readFileSync(this.agentDoneFile, 'utf-8').trim();
        return content.length > 0;
    }

    /**
     * Read the last task from NEXT_TASK.md
     * Used to understand context when handling agent responses (fresh session approach)
     */
    public readLastTask(): string | null {
        try {
            if (!fs.existsSync(this.nextTaskFile)) {
                return null;
            }

            return fs.readFileSync(this.nextTaskFile, 'utf-8');
        } catch (error) {
            logError('TASK-FILE-MANAGER', 'Failed to read NEXT_TASK.md', error);
            return null;
        }
    }

    /**
     * Parse the current node ID from NEXT_TASK.md
     * Returns the node ID being worked on, or null if not found
     */
    public parseCurrentNodeId(): string | null {
        const content = this.readLastTask();
        if (!content) {return null;}

        // Parse "**Node:** Title" line - we need to find the node by title in the caller
        const nodeMatch = content.match(/\*\*Node:\*\*\s*(.+)/);
        if (nodeMatch) {
            return nodeMatch[1].trim();
        }
        return null;
    }

    // --- Automation State Persistence ---

    private get stateFile(): string {
        return path.join(this.taskDir, 'automation-state.json');
    }

    /**
     * Save automation state to disk for persistence across sessions
     * Sprint 14 Fix: Added currentRetry for fix loop tracking
     */
    public saveAutomationState(state: {
        processedNodes: string[];
        failedNodes: string[];
        currentNodeId: string | null;
        isRunning: boolean;
        phase?: string;
        currentRetry?: number;
    }): void {
        this.ensureDirectoryExists();
        try {
            fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), 'utf-8');
            logger.log('TASK-FILE-MANAGER', `Saved automation state: phase=${state.phase}, retry=${state.currentRetry || 0}, ${state.processedNodes.length} processed, ${state.failedNodes.length} failed`);
        } catch (error) {
            logError('TASK-FILE-MANAGER', 'Failed to save automation state', error);
        }
    }

    /**
     * Load automation state from disk
     * Sprint 14 Fix: Added currentRetry for fix loop tracking
     */
    public loadAutomationState(): {
        processedNodes: string[];
        failedNodes: string[];
        currentNodeId: string | null;
        isRunning: boolean;
        phase?: string;
        currentRetry?: number;
    } | null {
        try {
            if (!fs.existsSync(this.stateFile)) {
                return null;
            }
            const content = fs.readFileSync(this.stateFile, 'utf-8');
            const state = JSON.parse(content);
            logger.log('TASK-FILE-MANAGER', `Loaded automation state: phase=${state.phase}, ${state.processedNodes?.length || 0} processed`);
            return state;
        } catch (error) {
            logError('TASK-FILE-MANAGER', 'Failed to load automation state', error);
            return null;
        }
    }

    /**
     * Clear automation state (when automation completes or is reset)
     */
    public clearAutomationState(): void {
        try {
            if (fs.existsSync(this.stateFile)) {
                fs.unlinkSync(this.stateFile);
                logger.log('TASK-FILE-MANAGER', 'Cleared automation state');
            }
        } catch (error) {
            logError('TASK-FILE-MANAGER', 'Failed to clear automation state', error);
        }
    }
}
