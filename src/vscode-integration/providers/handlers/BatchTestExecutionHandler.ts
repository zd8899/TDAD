import * as vscode from 'vscode';
import { Node, TestResult, NodeStatus } from '../../../shared/types';
import { AutomationProgressUpdate } from '../../../shared/types/slack';
import { logCanvas, logError } from '../../../shared/utils/Logger';
import { FeatureMapStorage } from '../../../infrastructure/storage/FeatureMapStorage';
import { SimpleNodeManager } from '../SimpleNodeManager';
import { NodeStatusService } from '../NodeStatusService';
import { TestExecutionHandlers } from './TestExecutionHandlers';
import { CLIAgentLauncher } from '../../CLIAgentLauncher';
import { TestRunner } from '../../testing/TestRunner';
import { TaskFileManager } from '../../../core/services/TaskFileManager';
import { PromptGenerationService } from '../../../core/services/PromptGenerationService';
import { FixAttemptInfo } from '../../../core/services/GoldenPacketAssembler';
import { AutomationStateManager } from '../../../infrastructure/storage/AutomationStateManager';
import { AutomationState } from '../../../shared/types/automation';

export class BatchTestExecutionHandler {
    private batchAgentDoneResolve: (() => void) | null = null;
    private cancelled = false;
    private activeTestRunner: TestRunner | null = null;
    private activeStateManager: AutomationStateManager | null = null;

    constructor(
        private readonly webview: vscode.Webview,
        private readonly storage: FeatureMapStorage,
        private readonly nodeManager: SimpleNodeManager,
        private readonly context: vscode.ExtensionContext,
        private readonly testResultsCache: Map<string, TestResult[]>,
        private readonly testExecutionHandlers: TestExecutionHandlers,
        private readonly nodeStatusService: NodeStatusService
    ) {}

    /**
     * Handle batch AGENT_DONE signal from file watcher
     */
    handleBatchAgentDone(): boolean {
        if (this.batchAgentDoneResolve) {
            logCanvas('[BatchTest] Received batch AGENT_DONE signal');
            this.batchAgentDoneResolve();
            this.batchAgentDoneResolve = null;
            return true;
        }
        logCanvas('[BatchTest] Ignoring batch AGENT_DONE signal: no pending resolve');
        return false;
    }

    /**
     * Wait for batch AGENT_DONE.md to be signaled by file watcher
     */
    private waitForBatchAgentDone(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.batchAgentDoneResolve = resolve;
        });
    }

    /**
     * Run batch test + fix loop for all nodes that completed BDD + test gen.
     * Runs ALL tests in a single Playwright command, then uses a single CLI for fixes.
     */
    async runBatchTestFixLoop(
        nodes: Node[],
        allNodes: Node[],
        allEdges: any[],
        maxRetries: number,
        stateManager: AutomationStateManager,
        state: AutomationState,
        notifyProgress: (update: AutomationProgressUpdate) => void
    ): Promise<Map<string, boolean>> {
        const resultMap = new Map<string, boolean>();
        const workspacePath = this.storage.getWorkspaceRoot();
        const extensionPath = vscode.extensions.getExtension('tdad.tdad')?.extensionPath || this.context.extensionPath;
        const testRunner = new TestRunner();
        this.activeTestRunner = testRunner;
        this.activeStateManager = stateManager;

        this.cancelled = false;

        const fixAttempts: FixAttemptInfo[] = [];
        const taskFileManager = new TaskFileManager(workspacePath, 'batch');

        logCanvas(`[BatchTest] Starting batch test+fix loop for ${nodes.length} nodes (max retries: ${maxRetries})`);

        const progressMessage = `Batch testing ${nodes.length} features...`;
        this.webview.postMessage({
            command: 'allNodesAutomationStatus',
            status: 'running',
            message: progressMessage
        });
        notifyProgress({ status: 'running', message: progressMessage });

        let retryCount = 0;

        while (retryCount <= maxRetries) {
            // Check if automation was stopped or cancelled
            if (this.cancelled) {
                logCanvas('[BatchTest] Batch cancelled, aborting loop');
                break;
            }
            const currentState = stateManager.loadState();
            if (!currentState || currentState.status === 'stopped') {
                logCanvas('[BatchTest] Automation stopped, aborting batch loop');
                break;
            }

            // Step 1: Run all tests in one Playwright command
            logCanvas(`[BatchTest] Running batch tests (attempt ${retryCount + 1}/${maxRetries + 1})`);
            const batchMessage = retryCount === 0
                ? `Running all tests...`
                : `Re-running all tests (retry ${retryCount}/${maxRetries})...`;
            this.webview.postMessage({
                command: 'allNodesAutomationStatus',
                status: 'running',
                message: batchMessage
            });
            notifyProgress({ status: 'running', message: batchMessage });

            const batchResults = await testRunner.runBatchTests(nodes, workspacePath);

            if (this.cancelled) {
                logCanvas('[BatchTest] Cancelled after test run');
                break;
            }

            // Step 2: Publish per-node results via webview
            let allPassed = true;
            const failedNodes: Array<{ node: Node; testResults: TestResult[] }> = [];

            for (const node of nodes) {
                const nodeResults = batchResults.get(node.id) || [];
                this.testResultsCache.set(node.id, nodeResults);

                const nodePassed = nodeResults.length > 0 && nodeResults.every(r => r.passed);
                resultMap.set(node.id, nodePassed);

                this.webview.postMessage({
                    command: 'testResultsUpdated',
                    nodeId: node.id,
                    testResults: nodeResults,
                    passed: nodePassed
                });

                if (!nodePassed) {
                    allPassed = false;
                    failedNodes.push({ node, testResults: nodeResults });

                    // Update node status to failed
                    this.nodeStatusService.setStatusById(node.id, 'failed', {
                        saveNow: true,
                        reason: `batch-test failed (attempt ${retryCount + 1})`
                    });
                    stateManager.updateNodeStatus(state, node.id, 'failed');
                } else {
                    // Update node status to passed
                    this.nodeStatusService.setStatusById(node.id, 'passed', {
                        saveNow: true,
                        reason: `batch-test passed (attempt ${retryCount + 1})`
                    });
                    stateManager.updateNodeStatus(state, node.id, 'passed');
                }
            }

            // Step 3: If all passed, we're done
            if (allPassed) {
                logCanvas(`[BatchTest] All tests passed on attempt ${retryCount + 1}`);
                this.webview.postMessage({
                    command: 'allNodesAutomationStatus',
                    status: 'running',
                    message: `All ${nodes.length} features passed!`
                });
                notifyProgress({ status: 'running', message: `All ${nodes.length} features passed!` });
                break;
            }

            // Step 4: If we've exhausted retries, stop
            if (retryCount >= maxRetries) {
                logCanvas(`[BatchTest] Max retries (${maxRetries}) reached with ${failedNodes.length} failing features`);
                break;
            }

            // Step 5: Generate batch fix prompt and write task file
            logCanvas(`[BatchTest] ${failedNodes.length} features failing, generating batch fix prompt...`);
            const fixMessage = `Fixing ${failedNodes.length} failing feature(s) (retry ${retryCount + 1}/${maxRetries})...`;
            this.webview.postMessage({
                command: 'allNodesAutomationStatus',
                status: 'running',
                message: fixMessage
            });
            notifyProgress({ status: 'running', message: fixMessage });

            const promptService = new PromptGenerationService(workspacePath, extensionPath);
            const { prompt } = await promptService.generateBatchFixPrompt({
                failedNodes,
                allNodes,
                edges: allEdges,
                previousAttempts: fixAttempts.length > 0 ? fixAttempts : undefined,
                retryCount
            });

            // Step 6: Write single NEXT_TASK.md for batch (this clears old AGENT_DONE.md via clearAgentDone())
            taskFileManager.writeNextTask({
                status: 'FIX',
                node: failedNodes[0].node,
                workflowName: 'batch',
                retryCount,
                maxRetries,
                goal: `Fix ${failedNodes.length} failing features`,
                context: '',
                errorContext: prompt
            });

            // Step 7: Wait briefly for file watcher to process the deleted AGENT_DONE.md
            // This prevents the watcher from firing on a stale file after we set up the promise
            await new Promise(resolve => setTimeout(resolve, 250));

            // Step 8: Set up wait promise AFTER old AGENT_DONE.md is cleared and settled
            logCanvas('[BatchTest] Waiting for batch AGENT_DONE signal...');
            const waitPromise = this.waitForBatchAgentDone();

            // Step 9: Launch single CLI agent
            const launcher = CLIAgentLauncher.getInstance(workspacePath);
            const taskFile = taskFileManager.getNextTaskFilePath();
            const taskDesc = `Batch fix: ${failedNodes.length} failing feature(s) (retry ${retryCount + 1})`;
            launcher.triggerAgent(taskFile, taskDesc, 'batch');

            // Step 10: Wait for AGENT_DONE.md
            await waitPromise;

            if (this.cancelled) {
                logCanvas('[BatchTest] Cancelled after agent done wait');
                break;
            }

            // Read AGENT_DONE.md to capture what the agent tried (for previous attempts context)
            const agentResponse = taskFileManager.readAgentDone();
            if (agentResponse?.approach) {
                fixAttempts.push({
                    attemptNumber: retryCount + 1,
                    approachDescription: agentResponse.approach,
                    timestamp: new Date().toISOString()
                });
                logCanvas(`[BatchTest] Recorded fix attempt ${retryCount + 1}: ${agentResponse.approach.substring(0, 80)}...`);
            }

            logCanvas('[BatchTest] Batch AGENT_DONE received, re-running tests...');

            retryCount++;
        }

        // Clean up
        this.activeTestRunner = null;
        this.activeStateManager = null;
        CLIAgentLauncher.getInstance(workspacePath).killTerminal('batch');

        return resultMap;
    }

    /**
     * Cancel batch execution by resolving the wait promise
     */
    cancelBatch(): void {
        this.cancelled = true;

        // Kill active test processes (same as existing stop behavior)
        if (this.activeTestRunner) {
            this.activeTestRunner.cancelCurrentTest();
        }

        // Update automation state to stopped
        if (this.activeStateManager) {
            const currentState = this.activeStateManager.loadState();
            if (currentState && currentState.status === 'running') {
                this.activeStateManager.stopAutomation(currentState);
            }
        }

        // Unblock the AGENT_DONE wait
        if (this.batchAgentDoneResolve) {
            this.batchAgentDoneResolve();
            this.batchAgentDoneResolve = null;
        }
    }
}
