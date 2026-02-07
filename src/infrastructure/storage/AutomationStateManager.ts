/**
 * AutomationStateManager - Manages .tdad/automation-state.json
 * Single source of truth for automation execution
 */

import * as fs from 'fs';
import * as path from 'path';
import { AutomationState, AutomationNode, AutomationNodeStatus } from '../../shared/types/automation';
import { Node } from '../../shared/types';
import { logCanvas } from '../../shared/utils/Logger';

export class AutomationStateManager {
    private stateFilePath: string;

    constructor(private workspacePath: string) {
        this.stateFilePath = path.join(workspacePath, '.tdad', 'automation-state.json');
    }

    /**
     * Generate initial automation state from nodes
     */
    generateState(
        nodes: Node[],
        workflowId: string,
        folderId: string | null,
        modes: ('bdd' | 'test' | 'run-fix')[]
    ): AutomationState {
        const now = new Date().toISOString();

        const automationNodes: AutomationNode[] = nodes.map((node) => ({
            id: node.id,
            title: node.title,
            folderPath: node.workflowId,
            status: 'pending' as AutomationNodeStatus,
            modes: {
                bdd: modes.includes('bdd'),
                test: modes.includes('test'),
                runFix: modes.includes('run-fix')
            }
        }));

        const state: AutomationState = {
            _HOW_TO_USE: 'Edit this file to control automation. Changes take effect immediately!',
            workflowId,
            folderId,
            status: 'pending',

            _SKIP_NODES: 'Add status values here to skip those nodes. Example: ["passed", "failed"]',
            _SKIP_OPTIONS: 'pending | running | passed | failed | skipped',
            skipStatuses: ['passed'],

            _RETRY_SETTINGS: 'Control how many times to retry failed nodes',
            retryConfig: {
                maxRetries: 10,      // How many times to retry each failed node
                retryDelayMs: 2000   // Wait time (milliseconds) between retries
            },

            _EXECUTION: 'Future: Set concurrency > 1 to run multiple nodes in parallel',
            executionSettings: {
                concurrency: 1  // 1 = sequential (one at a time)
            },

            _NODES_HELP: 'Reorder this array to change execution order. Edit each node status/modes as needed.',
            _NODE_STATUSES: 'pending (not started) | running (in progress) | passed (success) | failed (error) | skipped (skipped)',
            _NODE_MODES: 'bdd: Generate .feature file | test: Generate .test.js file | runFix: Run tests and auto-fix failures',
            nodes: automationNodes,

            _PROGRESS_INFO: 'Auto-updated by TDAD - shows current position in queue',
            currentIndex: -1,
            createdAt: now,
            updatedAt: now
        } as any;

        return state;
    }

    /**
     * Save automation state to file
     */
    saveState(state: AutomationState): void {
        const tdadDir = path.dirname(this.stateFilePath);
        if (!fs.existsSync(tdadDir)) {
            fs.mkdirSync(tdadDir, { recursive: true });
        }

        state.updatedAt = new Date().toISOString();

        // Format JSON with modes on single line
        let jsonStr = JSON.stringify(state, null, 2);

        // Replace multi-line modes objects with single-line format
        // Example: "modes": {\n      "bdd": true,\n      "test": true\n    }
        // Becomes: "modes": { "bdd": true, "test": true, "runFix": true }
        jsonStr = jsonStr.replace(
            /"modes":\s*\{\s*"bdd":\s*(true|false),\s*"test":\s*(true|false),\s*"runFix":\s*(true|false)\s*\}/gs,
            '"modes": { "bdd": $1, "test": $2, "runFix": $3 }'
        );

        fs.writeFileSync(this.stateFilePath, jsonStr, 'utf-8');
        logCanvas(`Automation state saved to ${this.stateFilePath}`);
    }

    /**
     * Load automation state from file
     */
    loadState(): AutomationState | null {
        if (!fs.existsSync(this.stateFilePath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(this.stateFilePath, 'utf-8');
            const state = JSON.parse(content) as AutomationState;
            logCanvas(`Automation state loaded from ${this.stateFilePath}`);
            return state;
        } catch (error) {
            logCanvas(`Failed to load automation state: ${error}`);
            return null;
        }
    }

    /**
     * Check if automation state file exists
     */
    exists(): boolean {
        return fs.existsSync(this.stateFilePath);
    }

    /**
     * Delete automation state file
     */
    deleteState(): void {
        if (fs.existsSync(this.stateFilePath)) {
            fs.unlinkSync(this.stateFilePath);
            logCanvas(`Automation state deleted: ${this.stateFilePath}`);
        }
    }

    /**
     * Update node status
     */
    updateNodeStatus(
        state: AutomationState,
        nodeId: string,
        status: AutomationNodeStatus,
        error?: string
    ): void {
        const node = state.nodes.find(n => n.id === nodeId);
        if (!node) {
            return;
        }

        // Update node status
        node.status = status;
        if (error) {
            node.error = error;
        }

        this.saveState(state);
    }

    /**
     * Get next pending node to execute
     */
    getNextNode(state: AutomationState): AutomationNode | null {
        // Find the first pending node after currentIndex
        for (let i = state.currentIndex + 1; i < state.nodes.length; i++) {
            const node = state.nodes[i];
            if (node.status === 'pending') {
                state.currentIndex = i;
                return node;
            }
        }
        return null;
    }

    /**
     * Mark automation as started
     */
    startAutomation(state: AutomationState): void {
        state.status = 'running';
        state.startedAt = new Date().toISOString();
        this.saveState(state);
    }

    /**
     * Mark automation as completed
     */
    completeAutomation(state: AutomationState): void {
        state.status = 'completed';
        state.completedAt = new Date().toISOString();
        this.saveState(state);
    }

    /**
     * Mark automation as stopped
     */
    stopAutomation(state: AutomationState): void {
        state.status = 'stopped';
        state.completedAt = new Date().toISOString();
        this.saveState(state);
    }

    /**
     * Add node to queue (user can add during execution)
     */
    addNode(state: AutomationState, node: Node, modes: ('bdd' | 'test' | 'run-fix')[]): void {
        const automationNode: AutomationNode = {
            id: node.id,
            title: node.title,
            folderPath: node.workflowId,
            status: 'pending',
            modes: {
                bdd: modes.includes('bdd'),
                test: modes.includes('test'),
                runFix: modes.includes('run-fix')
            }
        };

        state.nodes.push(automationNode);
        this.saveState(state);
        logCanvas(`Added node to automation queue: ${node.title}`);
    }

    /**
     * Remove node from queue (user can remove during execution)
     * Only pending nodes can be removed
     */
    removeNode(state: AutomationState, nodeId: string): boolean {
        const index = state.nodes.findIndex(n => n.id === nodeId);
        if (index === -1) {
            return false;
        }

        const node = state.nodes[index];
        if (node.status !== 'pending') {
            logCanvas(`Cannot remove node ${node.title}: status is ${node.status}`);
            return false;
        }

        state.nodes.splice(index, 1);

        // Adjust currentIndex if needed
        if (index <= state.currentIndex) {
            state.currentIndex--;
        }

        this.saveState(state);
        logCanvas(`Removed node from automation queue: ${node.title}`);
        return true;
    }

    /**
     * Get automation state file path
     */
    getStateFilePath(): string {
        return this.stateFilePath;
    }

    /**
     * Get current executing node
     */
    getCurrentNode(state: AutomationState): AutomationNode | null {
        if (state.currentIndex < 0 || state.currentIndex >= state.nodes.length) {
            return null;
        }
        return state.nodes[state.currentIndex];
    }

    /**
     * Get pending nodes count
     */
    getPendingCount(state: AutomationState): number {
        return state.nodes.filter(n => n.status === 'pending').length;
    }

    /**
     * Get total nodes count
     */
    getTotalNodes(state: AutomationState): number {
        return state.nodes.length;
    }

    /**
     * Get completed nodes count (passed + failed + skipped)
     */
    getCompletedCount(state: AutomationState): number {
        return state.nodes.filter(n =>
            n.status === 'passed' || n.status === 'failed' || n.status === 'skipped'
        ).length;
    }

    /**
     * Get passed nodes count
     */
    getPassedCount(state: AutomationState): number {
        return state.nodes.filter(n => n.status === 'passed').length;
    }

    /**
     * Get skipped nodes count
     */
    getSkippedCount(state: AutomationState): number {
        return state.nodes.filter(n => n.status === 'skipped').length;
    }

    /**
     * Skip node (mark as skipped without executing)
     */
    skipNode(state: AutomationState, nodeId: string, reason?: string): void {
        const node = state.nodes.find(n => n.id === nodeId);
        if (!node || node.status !== 'pending') {
            return;
        }

        this.updateNodeStatus(state, nodeId, 'skipped', reason);
        logCanvas(`Skipped node: ${node.title}${reason ? ` (${reason})` : ''}`);
    }
}
