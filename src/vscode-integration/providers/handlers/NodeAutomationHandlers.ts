import * as vscode from 'vscode';
import { Node, TestResult, DEFAULT_PERMISSION_FLAGS } from '../../../shared/types';
import { AutomationProgressUpdate } from '../../../shared/types/slack';
import { logCanvas, logError } from '../../../shared/utils/Logger';
import { FeatureMapStorage } from '../../../infrastructure/storage/FeatureMapStorage';
import { NodeStatus } from '../../../shared/types';
import { SimpleNodeManager } from '../SimpleNodeManager';
import { NodeStatusService } from '../NodeStatusService';
import { SingleNodeOrchestrator, SingleNodeState } from '../../../core/services/SingleNodeOrchestrator';
import { TestExecutionHandlers } from './TestExecutionHandlers';
import { CLIAgentLauncher } from '../../CLIAgentLauncher';
import { AutomationStateManager } from '../../../infrastructure/storage/AutomationStateManager';
import { TestRunner } from '../../testing/TestRunner';
import { BatchTestExecutionHandler } from './BatchTestExecutionHandler';
import { getDescendantNodeIds, expandFolderEdges, sortNodesByDependency } from '../../../shared/utils/nodeHelpers';

export class NodeAutomationHandlers {
    private orchestrators: Map<string, SingleNodeOrchestrator> = new Map();
    private automationProgressCallback: ((update: AutomationProgressUpdate) => void) | null = null;
    private readonly nodeStatusSnapshot: Map<string, NodeStatus | undefined> = new Map();
    private readonly batchHandler: BatchTestExecutionHandler;

    constructor(
        private readonly webview: vscode.Webview,
        private readonly storage: FeatureMapStorage,
        private readonly nodeManager: SimpleNodeManager,
        private readonly context: vscode.ExtensionContext,
        private readonly testResultsCache: Map<string, TestResult[]>,
        private readonly testExecutionHandlers: TestExecutionHandlers,
        private readonly checkSingleNodeFileStatus: (nodeId: string) => Promise<void>,
        private readonly nodeStatusService: NodeStatusService
    ) {
        this.batchHandler = new BatchTestExecutionHandler(
            webview, storage, nodeManager, context,
            testResultsCache, testExecutionHandlers, nodeStatusService
        );
    }

    /**
     * Set callback for automation progress updates (used by Slack integration)
     */
    setAutomationProgressCallback(callback: ((update: AutomationProgressUpdate) => void) | null): void {
        this.automationProgressCallback = callback;
    }

    /**
     * Notify progress callback if set
     */
    private notifyProgress(update: AutomationProgressUpdate): void {
        if (this.automationProgressCallback) {
            this.automationProgressCallback(update);
        }
    }

    /**
     * Resolve the persisted node.status based on selected automation modes.
     * - run-fix mode: passed/failed reflect real test execution
     * - bdd/test-only modes: restore pre-automation status
     */
    private resolveCompletionNodeStatus(
        modes: ('bdd' | 'test' | 'run-fix')[],
        passed: boolean,
        currentStatus?: string,
        initialStatus?: NodeStatus
    ): NodeStatus {
        const hasRunFix = modes.includes('run-fix');
        if (hasRunFix) {
            return passed ? 'passed' : 'failed';
        }

        // For BDD/test generation-only modes, restore original node status.
        if (initialStatus) {
            return initialStatus;
        }
        if (currentStatus && currentStatus !== 'generating' && currentStatus !== 'testing') {
            return currentStatus as NodeStatus;
        }
        return 'pending';
    }

    private rememberNodeStatus(nodeId: string): void {
        if (this.nodeStatusSnapshot.has(nodeId)) {
            return;
        }
        const node = this.nodeManager.getNodeById(nodeId);
        this.nodeStatusSnapshot.set(nodeId, (node as any)?.status as NodeStatus | undefined);
    }

    private forgetNodeStatus(nodeId: string): void {
        this.nodeStatusSnapshot.delete(nodeId);
    }

    private restoreNodeStatus(
        nodeId: string,
        reason: string,
        options: { preserveFailed?: boolean } = {}
    ): void {
        if (!this.nodeStatusSnapshot.has(nodeId)) {
            return;
        }

        const preserveFailed = options.preserveFailed === true;
        if (preserveFailed) {
            const currentNode = this.nodeManager.getNodeById(nodeId);
            const currentStatus = (currentNode as any)?.status as NodeStatus | undefined;
            if (currentStatus === 'failed') {
                logCanvas(`[NodeStatus] ${nodeId}: preserving failed status during restore (${reason})`);
                this.forgetNodeStatus(nodeId);
                return;
            }
        }

        const originalStatus = this.nodeStatusSnapshot.get(nodeId);
        if (originalStatus) {
            this.nodeStatusService.setStatusById(nodeId, originalStatus, {
                saveNow: true,
                force: true,
                reason
            });
        }
        this.forgetNodeStatus(nodeId);
    }

    /**
     * Persist failed status immediately for run-fix mode on first failed test run.
     * This keeps node red even if automation is stopped before retries complete.
     */
    private persistImmediateFailureIfNeeded(
        nodeId: string,
        modes: ('bdd' | 'test' | 'run-fix')[],
        results: TestResult[],
        reason: string
    ): void {
        if (!modes.includes('run-fix')) {
            return;
        }
        if (results.length === 0 || results.every(r => r.passed)) {
            return;
        }

        const node = this.nodeManager.getNodeById(nodeId);
        if (!node) {
            return;
        }

        this.nodeStatusService.setStatusByNode(node, 'failed', {
            saveNow: true,
            reason
        });
    }

    /**
     * Sync file paths from source node to target node
     */
    private syncNodeFilePaths(sourceNode: Node, targetNode: Node): boolean {
        let changed = false;
        if ((sourceNode as any).testCodeFile && !(targetNode as any).testCodeFile) {
            (targetNode as any).testCodeFile = (sourceNode as any).testCodeFile;
            changed = true;
        }
        if ((sourceNode as any).actionFile && !(targetNode as any).actionFile) {
            (targetNode as any).actionFile = (sourceNode as any).actionFile;
            changed = true;
        }
        if ((sourceNode as any).bddSpecFile && !(targetNode as any).bddSpecFile) {
            (targetNode as any).bddSpecFile = (sourceNode as any).bddSpecFile;
            changed = true;
        }
        return changed;
    }


    /**
     * Start single-node automation for the selected node
     * Returns result object for Slack notification support
     */
    async handleRunSingleNodeAutomation(nodeId: string, modes: ('bdd' | 'test' | 'run-fix')[] = ['bdd', 'test', 'run-fix']): Promise<{ started: boolean; error?: string; nodeName?: string }> {
        try {
            logCanvas(`Starting single-node automation for: ${nodeId} (modes: ${modes.join(', ')})`);

            const node = this.nodeManager.getNodeById(nodeId);
            if (!node) {
                logCanvas(`[WARN] Node not found: ${nodeId}`);
                vscode.window.showWarningMessage('Node not found');
                return { started: false, error: 'Node not found' };
            }
            logCanvas(`Found node: ${node.title} (${node.id})`);
            this.rememberNodeStatus(nodeId);

            // Only block if THIS specific node is already running (allows parallel)
            const existingOrchestrator = this.orchestrators.get(nodeId);
            if (existingOrchestrator?.isRunning()) {
                logCanvas(`[WARN] Orchestrator already running for node ${nodeId}`);
                vscode.window.showWarningMessage(`Automation already running for "${node.title}". Stop it first.`);
                return { started: false, error: 'Automation already running for this node.', nodeName: node.title };
            }

            const workspaceRoot = this.storage.getWorkspaceRoot();
            const extensionPath = vscode.extensions.getExtension('tdad.tdad')?.extensionPath || this.context.extensionPath;
            logCanvas(`Creating orchestrator for ${nodeId}: workspace=${workspaceRoot}`);

            const orchestrator = new SingleNodeOrchestrator(workspaceRoot, extensionPath, nodeId);
            this.orchestrators.set(nodeId, orchestrator);

            orchestrator.setTestRunner({
                runNodeTests: async (testNode: Node, _filter: string) => {
                    const allNodes = this.nodeManager.getNodes();
                    return await this.testExecutionHandlers.runTestsAndSaveTraces(testNode, allNodes);
                },
                cancelCurrentTest: () => {
                    this.testExecutionHandlers.cancelCurrentTest();
                }
            });

            let previousPhase: string | null = null;

            orchestrator.setCallbacks({
                onStatusChange: (state: SingleNodeState) => {
                    logCanvas(`Single-node automation status [${nodeId}]: ${state.phase} - ${state.message}`);
                    this.webview.postMessage({
                        command: 'singleNodeAutomationStatus',
                        nodeId: state.nodeId,
                        status: state.status,
                        phase: state.phase,
                        currentRetry: state.currentRetry,
                        maxRetries: state.maxRetries,
                        message: state.message
                    });

                    if (state.nodeId && state.phase !== previousPhase) {
                        previousPhase = state.phase;
                        this.rememberNodeStatus(state.nodeId);
                        logCanvas(`[NodeRuntime] ${state.nodeId} phase=${state.phase}, status=${state.status} (runtime only, not persisted)`);
                        if (['bdd', 'scaffold', 'generating', 'testing', 'fixing'].includes(state.phase)) {
                            this.checkSingleNodeFileStatus(state.nodeId);
                        }
                    }
                },
                onComplete: (completedNodeId: string, passed: boolean) => {
                    logCanvas(`Single-node automation complete [${nodeId}]: ${passed ? 'PASSED' : 'FAILED'} (modes: ${modes.join(', ')})`);
                    this.checkSingleNodeFileStatus(completedNodeId);
                    // Clean up completed orchestrator and terminal
                    this.orchestrators.delete(nodeId);
                    CLIAgentLauncher.getInstance(workspaceRoot).killTerminal(nodeId);

                    const hasRunFix = modes.includes('run-fix');
                    const isBddOnly = modes.length === 1 && modes[0] === 'bdd';
                    const isTestOnly = modes.length === 1 && modes[0] === 'test';
                    const completionKind = hasRunFix ? 'run-fix' : (isBddOnly ? 'bdd' : 'test');

                    let resolvedNodeStatus: NodeStatus = passed ? 'passed' : 'failed';
                    const completedNode = this.nodeManager.getNodeById(completedNodeId);
                    if (completedNode) {
                        const initialStatus = this.nodeStatusSnapshot.get(completedNodeId);
                        resolvedNodeStatus = this.resolveCompletionNodeStatus(
                            modes,
                            passed,
                            (completedNode as any).status,
                            initialStatus
                        );
                        this.nodeStatusService.setStatusByNode(completedNode, resolvedNodeStatus, {
                            saveNow: true,
                            reason: `single-node complete modes=[${modes.join(',')}] passed=${passed}`
                        });
                        this.syncNodeFilePaths(node, completedNode);
                        this.nodeManager.updateNode(completedNode);
                        this.nodeManager.saveNow();
                    }
                    this.forgetNodeStatus(completedNodeId);

                    this.webview.postMessage({
                        command: 'singleNodeAutomationComplete',
                        nodeId: completedNodeId,
                        passed,
                        nodeStatus: resolvedNodeStatus,
                        completionKind,
                        testsExecuted: hasRunFix
                    });

                    if (passed) {
                        if (isBddOnly) {
                            vscode.window.showInformationMessage(`✅ Automation complete: ${node.title} - Plan generated!`);
                        } else if (isTestOnly) {
                            vscode.window.showInformationMessage(`✅ Automation complete: ${node.title} - Tests generated!`);
                        } else if (hasRunFix) {
                            vscode.window.showInformationMessage(`✅ Automation complete: ${node.title} - All tests passed!`);
                        } else {
                            vscode.window.showInformationMessage(`✅ Automation complete: ${node.title}`);
                        }
                    } else {
                        if (hasRunFix) {
                            vscode.window.showWarningMessage(`❌ Automation complete: ${node.title} - Tests failed after max retries`);
                        } else {
                            vscode.window.showWarningMessage(`❌ Automation complete: ${node.title} - Failed`);
                        }
                    }
                },
                onTestResults: (testNodeId: string, results: TestResult[]) => {
                    this.testResultsCache.set(testNodeId, results);
                    this.persistImmediateFailureIfNeeded(
                        testNodeId,
                        modes,
                        results,
                        `single-node immediate fail modes=[${modes.join(',')}]`
                    );
                    this.webview.postMessage({
                        command: 'testResultsUpdated',
                        nodeId: testNodeId,
                        testResults: results,
                        passed: results.length > 0 && results.every(r => r.passed)
                    });
                },
                onError: (error: Error) => {
                    logError('CANVAS', `Single-node automation error [${nodeId}]`, error);
                    vscode.window.showErrorMessage(`Automation error: ${error.message}`);
                    this.orchestrators.delete(nodeId);
                    this.restoreNodeStatus(nodeId, 'single-node error restore', { preserveFailed: true });
                },
                onTaskWritten: (taskFile: string, taskDescription: string) => {
                    logCanvas(`Task written [${nodeId}]: ${taskDescription}`);
                    vscode.window.showInformationMessage(`📝 ${taskDescription}`);

                    const launcher = CLIAgentLauncher.getInstance(workspaceRoot);
                    launcher.triggerAgent(taskFile, taskDescription, nodeId);
                }
            });

            const allNodes = this.nodeManager.getAllNodes();
            const allEdges = this.storage.loadAllEdges();

            await orchestrator.startSingleNode(node, allNodes, allEdges, modes);

            const modeLabels = modes.map(m => m === 'bdd' ? 'Plan' : m === 'test' ? 'Test' : 'Run+Fix').join(' → ');
            vscode.window.showInformationMessage(`🚀 Started automation (${modeLabels}) for "${node.title}"`);

            return { started: true, nodeName: node.title };

        } catch (error) {
            logError('CANVAS', 'Failed to start single-node automation', error);
            this.restoreNodeStatus(nodeId, 'single-node start failure restore');
            vscode.window.showErrorMessage(`Failed to start automation: ${error}`);
            return { started: false, error: `Failed to start: ${error}` };
        }
    }

    /**
     * Stop single-node automation (all running orchestrators)
     */
    handleStopSingleNodeAutomation(): void {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const launcher = workspacePath ? CLIAgentLauncher.getInstance(workspacePath) : null;

        // Cancel any running test processes first
        this.testExecutionHandlers.cancelCurrentTest();

        let stoppedCount = 0;
        for (const [id, orchestrator] of this.orchestrators) {
            if (orchestrator.isRunning()) {
                orchestrator.stop();
                launcher?.killTerminal(id);
                this.restoreNodeStatus(id, 'single-node stop restore', { preserveFailed: true });
                stoppedCount++;
            }
        }

        if (stoppedCount > 0) {
            vscode.window.showInformationMessage(`🛑 Stopped ${stoppedCount} running automation(s)`);
        } else {
            vscode.window.showWarningMessage('No automation is running');
        }
    }

    /**
     * Handle agent done signal for legacy single-file watcher (backward compat)
     * Routes to first running orchestrator found
     */
    private getRunningOrchestratorIds(): string[] {
        const running: string[] = [];
        for (const [id, orchestrator] of this.orchestrators) {
            if (orchestrator.isRunning()) {
                running.push(id);
            }
        }
        return running;
    }

    async handleSingleNodeAgentDone(): Promise<boolean> {
        const runningIds = this.getRunningOrchestratorIds();
        if (runningIds.length === 0) {
            logCanvas('[AgentDone] Ignoring legacy AGENT_DONE signal: no running orchestrators');
            return false;
        }

        const targetId = runningIds[0];
        const orchestrator = this.orchestrators.get(targetId);
        if (!orchestrator?.isRunning()) {
            logCanvas(`[AgentDone] Ignoring legacy AGENT_DONE signal: orchestrator ${targetId} not running`);
            return false;
        }

        logCanvas(`[AgentDone] Routing legacy AGENT_DONE to node ${targetId} (running: ${runningIds.join(', ')})`);
        await orchestrator.onAgentDone();
        return true;
    }

    /**
     * Handle per-node agent done signal for parallel execution
     */
    async handlePerNodeAgentDone(nodeId: string): Promise<boolean> {
        const direct = this.orchestrators.get(nodeId);
        if (direct?.isRunning()) {
            logCanvas(`[AgentDone] Routing per-node AGENT_DONE to node ${nodeId}`);
            await direct.onAgentDone();
            return true;
        }

        let decodedNodeId = nodeId;
        try {
            decodedNodeId = decodeURIComponent(nodeId);
        } catch {
            decodedNodeId = nodeId;
        }
        if (decodedNodeId !== nodeId) {
            const decodedMatch = this.orchestrators.get(decodedNodeId);
            if (decodedMatch?.isRunning()) {
                logCanvas(`[AgentDone] Routing per-node AGENT_DONE to decoded node ${decodedNodeId} (raw=${nodeId})`);
                await decodedMatch.onAgentDone();
                return true;
            }
        }

        const caseInsensitiveEntry = Array.from(this.orchestrators.entries()).find(([id, orchestrator]) =>
            orchestrator.isRunning() && id.toLowerCase() === nodeId.toLowerCase()
        );
        if (caseInsensitiveEntry) {
            const [matchedId, matchedOrchestrator] = caseInsensitiveEntry;
            logCanvas(`[AgentDone] Routing per-node AGENT_DONE via case-insensitive match ${nodeId} -> ${matchedId}`);
            await matchedOrchestrator.onAgentDone();
            return true;
        }

        const runningIds = this.getRunningOrchestratorIds();
        logCanvas(`[AgentDone] Ignoring per-node AGENT_DONE for ${nodeId}: no running orchestrator match (running: ${runningIds.length > 0 ? runningIds.join(', ') : 'none'})`);
        return false;
    }

    /**
     * Get single-node orchestrator (backward compat - returns first running)
     */
    getSingleNodeOrchestrator(): SingleNodeOrchestrator | null {
        for (const [, orchestrator] of this.orchestrators) {
            if (orchestrator.isRunning()) {
                return orchestrator;
            }
        }
        return null;
    }

    /**
     * Get autopilot info for the confirmation dialog
     */
    async handleGetAutopilotInfo(_allFolders = false): Promise<void> {
        try {
            const allNodes = this.nodeManager.getAllNodes();
            const currentFolderId = this.nodeManager.getCurrentFolder();

            let featureNodes: Node[];
            let folderName: string;

            if (currentFolderId) {
                const descendantIds = getDescendantNodeIds(currentFolderId, allNodes);
                featureNodes = allNodes.filter(n =>
                    n.nodeType !== 'folder' && descendantIds.has(n.id)
                );
                const folderNode = allNodes.find(n => n.id === currentFolderId);
                folderName = folderNode?.title || 'this folder';
            } else {
                featureNodes = allNodes.filter(n => n.nodeType !== 'folder');
                folderName = 'all folders';
            }

            if (featureNodes.length === 0) {
                this.webview.postMessage({
                    command: 'autopilotInfo',
                    error: `No feature nodes found in ${folderName}`
                });
                return;
            }

            // Read CLI settings from config for the dialog
            const config = vscode.workspace.getConfiguration('tdad');
            const savedFlags = config.get<any>('agent.cli.permissionFlags');
            const cliSettings = {
                enabled: config.get<boolean>('agent.cli.enabled', true),
                command: config.get<string>('agent.cli.command', 'claude "{prompt}"'),
                preset: config.get<string>('agent.cli.preset', 'claude'),
                permissionFlags: savedFlags ? { ...DEFAULT_PERMISSION_FLAGS, ...savedFlags } : DEFAULT_PERMISSION_FLAGS
            };

            this.webview.postMessage({
                command: 'autopilotInfo',
                pendingCount: featureNodes.length,
                folderName,
                cliSettings
            });
        } catch (error) {
            logError('CANVAS', 'Failed to get autopilot info', error);
            this.webview.postMessage({
                command: 'autopilotInfo',
                error: `Error: ${error}`
            });
        }
    }

    /**
     * Run automation for all nodes
     * @param confirmed Whether the user has confirmed the action
     * @param targetFolderId Optional folder ID to run nodes from
     * @param modes The automation modes to run
     * @param concurrency Number of concurrent agents (1 = sequential)
     * @param waitForDependencies Whether to wait for dependencies before starting a node
     * @param sequentialTests Whether to run test processes one at a time
     */
    async handleRunAllNodesAutomation(
        confirmed = false,
        targetFolderId: string | null | undefined = undefined,
        modes: ('bdd' | 'test' | 'run-fix')[] = ['bdd', 'test', 'run-fix'],
        concurrency = 1,
        waitForDependencies = false,
        sequentialTests = true,
        skipPassedScenarios = true,
        batchTestMode = false
    ): Promise<void> {
        try {
            logCanvas(`Starting run-all-nodes automation (modes: ${modes.join(', ')}, concurrency: ${concurrency}, waitDeps: ${waitForDependencies}, skipPassed: ${skipPassedScenarios}, targetFolderId: ${targetFolderId ?? 'none'})`);

            const cancelAutomation = (message: string) => {
                logCanvas(`Cancelling automation: ${message}`);
                this.webview.postMessage({
                    command: 'allNodesAutomationStatus',
                    status: 'cancelled',
                    message
                });
            };

            // Check if any orchestrators are running (from batch automation)
            const runningCount = Array.from(this.orchestrators.values()).filter(o => o.isRunning()).length;
            if (runningCount > 0) {
                logCanvas(`${runningCount} orchestrator(s) already running, aborting batch`);
                vscode.window.showWarningMessage('Automation is already running. Stop it first.');
                cancelAutomation('Already running');
                return;
            }

            const allNodes = this.nodeManager.getAllNodes();
            // Use targetFolderId if provided (from Slack), otherwise fall back to current canvas folder
            const folderId = targetFolderId !== undefined ? targetFolderId : this.nodeManager.getCurrentFolder();

            let featureNodes: Node[];
            if (folderId) {
                const descendantIds = getDescendantNodeIds(folderId, allNodes);
                featureNodes = allNodes.filter(n =>
                    n.nodeType !== 'folder' && descendantIds.has(n.id)
                );
                logCanvas(`Running folder ${folderId}, found ${featureNodes.length} descendant feature nodes`);
            } else {
                featureNodes = allNodes.filter(n => n.nodeType !== 'folder');
                logCanvas(`At root, found ${featureNodes.length} feature nodes`);
            }

            if (featureNodes.length === 0) {
                logCanvas('No feature nodes found, aborting');
                cancelAutomation('No nodes found');
                return;
            }

            if (!confirmed) {
                logCanvas('Not confirmed, aborting');
                cancelAutomation('Not confirmed');
                return;
            }

            logCanvas('Confirmed, proceeding with automation');

            const allEdges = this.storage.loadAllEdges();
            const expandedEdges = expandFolderEdges(featureNodes, allNodes, allEdges);
            const sortedNodes = sortNodesByDependency(featureNodes, expandedEdges);

            logCanvas(`Found ${sortedNodes.length} nodes to process`);

            // Generate automation state file (user can edit this before/during execution)
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const stateManager = new AutomationStateManager(workspaceRoot);

            const state = stateManager.generateState(
                sortedNodes,
                sortedNodes[0]?.workflowId || 'unknown',
                folderId,
                modes,
                concurrency,
                sequentialTests,
                skipPassedScenarios ? ['passed'] : [],
                batchTestMode
            );

            // Auto-skip nodes based on skipStatuses from state file
            sortedNodes.forEach(node => {
                const nodeStatus = (node as any).status;

                if (state.skipStatuses.includes(nodeStatus)) {
                    const skipReason = `status="${nodeStatus}" (in skipStatuses)`;
                    stateManager.skipNode(state, node.id, skipReason);
                    logCanvas(`Auto-marked for skip: ${node.title} - ${skipReason}`);
                }
            });

            stateManager.saveState(state);

            logCanvas(`Automation state saved to: ${stateManager.getStateFilePath()}`);
            vscode.window.showInformationMessage(
                `📋 Automation queue created: ${stateManager.getStateFilePath()}`,
                'Open File'
            ).then(selection => {
                if (selection === 'Open File') {
                    vscode.workspace.openTextDocument(stateManager.getStateFilePath()).then(doc => {
                        vscode.window.showTextDocument(doc);
                    });
                }
            });

            const skippedCount = stateManager.getSkippedCount(state);
            const startMessage = skippedCount > 0
                ? `Starting automation for ${stateManager.getTotalNodes(state)} nodes (${skippedCount} already passed)...`
                : `Starting automation for ${stateManager.getTotalNodes(state)} nodes...`;
            this.webview.postMessage({
                command: 'allNodesAutomationStatus',
                status: 'running',
                totalNodes: stateManager.getTotalNodes(state),
                currentIndex: 0,
                message: startMessage
            });
            this.notifyProgress({
                status: 'running',
                totalNodes: stateManager.getTotalNodes(state),
                currentIndex: 0,
                message: startMessage
            });

            vscode.window.showInformationMessage(`🚀 ${startMessage}`);

            stateManager.startAutomation(state);

            // ─── BATCH TEST MODE BRANCH ───
            if (batchTestMode && modes.includes('run-fix')) {
                await this.runBatchModeAutomation(
                    sortedNodes, allNodes, allEdges, modes,
                    concurrency, waitForDependencies, sequentialTests,
                    stateManager, state, expandedEdges
                );
                return;
            }

            const automationStopped = await this.runSlidingWindowExecution(
                sortedNodes, allNodes, expandedEdges, modes,
                concurrency, waitForDependencies, sequentialTests, stateManager
            );

            if (!automationStopped) {
                const currentState = stateManager.loadState();
                if (currentState && !stateManager.getNextNode(currentState)) {
                    stateManager.completeAutomation(currentState);
                }
            }

            TestRunner.sequentialMode = false;
            this.emitFinalStatus(stateManager);

        } catch (error) {
            logError('CANVAS', 'Failed to run all-nodes automation', error);
            vscode.window.showErrorMessage(`Automation failed: ${error}`);
            this.emitErrorStatus(`Error: ${error}`);
        }
    }

    /**
     * Run single node automation and wait for completion
     * @param nodeId Optional node ID for per-node file isolation (parallel execution)
     */
    private async runSingleNodeAutomationAndWait(node: Node, modes: ('bdd' | 'test' | 'run-fix')[] = ['bdd', 'test', 'run-fix'], nodeId?: string): Promise<{ passed: boolean; stopped: boolean }> {
        return new Promise<{ passed: boolean; stopped: boolean }>((resolve) => {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const extensionPath = vscode.extensions.getExtension('tdad.tdad')?.extensionPath || process.cwd();
            const effectiveNodeId = nodeId || node.id;

            let wasStopped = false;
            this.rememberNodeStatus(effectiveNodeId);

            const orchestrator = new SingleNodeOrchestrator(workspaceRoot, extensionPath, effectiveNodeId);
            this.orchestrators.set(effectiveNodeId, orchestrator);

            orchestrator.setTestRunner({
                runNodeTests: async (testNode: Node, _filter: string) => {
                    const allNodes = this.nodeManager.getNodes();
                    return await this.testExecutionHandlers.runTestsAndSaveTraces(testNode, allNodes);
                },
                cancelCurrentTest: () => {
                    this.testExecutionHandlers.cancelCurrentTest();
                }
            });

            let previousPhase: string | null = null;

            orchestrator.setCallbacks({
                onStatusChange: (state: SingleNodeState) => {
                    logCanvas(`[All-Nodes] ${node.title}: ${state.phase} - ${state.message}`);

                    if (state.status === 'stopped') {
                        wasStopped = true;
                        if (state.nodeId) {
                            this.restoreNodeStatus(state.nodeId, 'all-nodes stopped restore', { preserveFailed: true });
                        } else {
                            this.restoreNodeStatus(effectiveNodeId, 'all-nodes stopped restore', { preserveFailed: true });
                        }
                        resolve({ passed: false, stopped: true });
                    }

                    this.webview.postMessage({
                        command: 'singleNodeAutomationStatus',
                        nodeId: state.nodeId,
                        status: state.status,
                        phase: state.phase,
                        currentRetry: state.currentRetry,
                        maxRetries: state.maxRetries,
                        message: state.message
                    });

                    if (state.nodeId && state.phase !== previousPhase) {
                        previousPhase = state.phase;
                        this.rememberNodeStatus(state.nodeId);
                        logCanvas(`[NodeRuntime] ${state.nodeId} phase=${state.phase}, status=${state.status} (runtime only, not persisted)`);
                        if (['bdd', 'scaffold', 'generating', 'testing', 'fixing'].includes(state.phase)) {
                            this.checkSingleNodeFileStatus(state.nodeId);
                        }
                        if (state.phase === 'testing' || state.phase === 'generating') {
                            const nodeToSync = this.nodeManager.getNodeById(state.nodeId);
                            if (nodeToSync && this.syncNodeFilePaths(node, nodeToSync)) {
                                this.nodeManager.updateNode(nodeToSync);
                                this.nodeManager.saveNow();
                                logCanvas(`[All-Nodes] Synced file paths for ${node.title}`);
                            }
                        }
                    }
                },
                onComplete: (completedNodeId: string, passed: boolean) => {
                    logCanvas(`[All-Nodes] ${node.title} complete: ${passed ? 'PASSED' : 'FAILED'} (modes: ${modes.join(', ')})`);
                    this.checkSingleNodeFileStatus(completedNodeId);
                    this.orchestrators.delete(effectiveNodeId);

                    // Close the terminal for this completed node
                    CLIAgentLauncher.getInstance(workspaceRoot).killTerminal(effectiveNodeId);

                    const hasRunFix = modes.includes('run-fix');
                    const isBddOnly = modes.length === 1 && modes[0] === 'bdd';
                    const completionKind = hasRunFix ? 'run-fix' : (isBddOnly ? 'bdd' : 'test');

                    let resolvedNodeStatus: NodeStatus = passed ? 'passed' : 'failed';
                    const completedNode = this.nodeManager.getNodeById(completedNodeId);
                    if (completedNode) {
                        const initialStatus = this.nodeStatusSnapshot.get(completedNodeId);
                        resolvedNodeStatus = this.resolveCompletionNodeStatus(
                            modes,
                            passed,
                            (completedNode as any).status,
                            initialStatus
                        );
                        this.nodeStatusService.setStatusByNode(completedNode, resolvedNodeStatus, {
                            saveNow: true,
                            reason: `all-nodes complete modes=[${modes.join(',')}] passed=${passed}`
                        });
                        this.syncNodeFilePaths(node, completedNode);
                        this.nodeManager.updateNode(completedNode);
                        this.nodeManager.saveNow();
                    }
                    this.forgetNodeStatus(completedNodeId);

                    this.webview.postMessage({
                        command: 'singleNodeAutomationComplete',
                        nodeId: completedNodeId,
                        passed,
                        nodeStatus: resolvedNodeStatus,
                        completionKind,
                        testsExecuted: hasRunFix
                    });

                    if (!wasStopped) {
                        resolve({ passed, stopped: false });
                    }
                },
                onTestResults: (testNodeId: string, results: TestResult[]) => {
                    this.testResultsCache.set(testNodeId, results);
                    this.persistImmediateFailureIfNeeded(
                        testNodeId,
                        modes,
                        results,
                        `all-nodes immediate fail modes=[${modes.join(',')}]`
                    );
                    this.webview.postMessage({
                        command: 'testResultsUpdated',
                        nodeId: testNodeId,
                        testResults: results,
                        passed: results.length > 0 && results.every(r => r.passed)
                    });
                },
                onError: (error: Error) => {
                    logError('CANVAS', `[All-Nodes] Error for ${node.title}`, error);
                    this.orchestrators.delete(effectiveNodeId);
                    this.restoreNodeStatus(effectiveNodeId, 'all-nodes error restore', { preserveFailed: true });
                    if (!wasStopped) {
                        resolve({ passed: false, stopped: false });
                    }
                },
                onTaskWritten: (taskFile: string, taskDescription: string) => {
                    logCanvas(`[All-Nodes] Task written [${effectiveNodeId}]: ${taskDescription}`);
                    vscode.window.showInformationMessage(`📝 ${taskDescription}`);

                    const launcher = CLIAgentLauncher.getInstance(workspaceRoot);
                    launcher.triggerAgent(taskFile, taskDescription, effectiveNodeId);
                }
            });

            const allNodes = this.nodeManager.getAllNodes();
            const allEdges = this.storage.loadAllEdges();

            orchestrator.startSingleNode(node, allNodes, allEdges, modes).catch((error) => {
                logError('CANVAS', `[All-Nodes] Failed to start automation for ${node.title}`, error);
                this.orchestrators.delete(effectiveNodeId);
                this.restoreNodeStatus(effectiveNodeId, 'all-nodes start failure restore');
                if (!wasStopped) {
                    resolve({ passed: false, stopped: false });
                }
            });
        });
    }

    /**
     * Handle batch AGENT_DONE signal - delegates to BatchTestExecutionHandler
     */
    handleBatchAgentDone(): boolean {
        return this.batchHandler.handleBatchAgentDone();
    }

    /**
     * Batch mode: Phase 1 = BDD+test gen (parallel), Phase 2 = batch test+fix loop
     */
    private async runBatchModeAutomation(
        sortedNodes: Node[],
        allNodes: Node[],
        allEdges: Array<{ source: string; target: string }>,
        modes: ('bdd' | 'test' | 'run-fix')[],
        concurrency: number,
        waitForDependencies: boolean,
        sequentialTests: boolean,
        stateManager: AutomationStateManager,
        state: any,
        expandedEdges: Array<{ source: string; target: string }>
    ): Promise<void> {
        try {
            // ── Phase 1: BDD + Test Generation (parallel, existing sliding window) ──
            const phase1Modes = modes.filter(m => m !== 'run-fix') as ('bdd' | 'test' | 'run-fix')[];

            if (phase1Modes.length > 0) {
                logCanvas(`[BatchMode] Phase 1: Running BDD+test gen for ${sortedNodes.length} nodes (modes: ${phase1Modes.join(', ')})`);
                this.webview.postMessage({
                    command: 'allNodesAutomationStatus',
                    status: 'running',
                    message: `Phase 1: Generating BDD plans and tests for ${sortedNodes.length} features...`
                });
                this.notifyProgress({
                    status: 'running',
                    message: `Phase 1: Generating BDD plans and tests for ${sortedNodes.length} features...`
                });

                const automationStopped = await this.runSlidingWindowExecution(
                    sortedNodes, allNodes, expandedEdges, phase1Modes,
                    concurrency, waitForDependencies, sequentialTests,
                    stateManager, 'Phase 1: '
                );

                if (automationStopped) {
                    TestRunner.sequentialMode = false;
                    this.emitFinalStatus(stateManager);
                    return;
                }

                logCanvas('[BatchMode] Phase 1 complete');
            }

            // ── Phase 2: Batch Test + Fix Loop ──
            logCanvas(`[BatchMode] Phase 2: Starting batch test+fix loop`);
            this.webview.postMessage({
                command: 'allNodesAutomationStatus',
                status: 'running',
                message: `Phase 2: Running batch tests for all features...`
            });
            this.notifyProgress({
                status: 'running',
                message: `Phase 2: Running batch tests for all features...`
            });

            // Get non-skipped nodes for batch testing
            const currentState = stateManager.loadState();
            const nodesToTest = sortedNodes.filter(n => {
                const stateNode = currentState?.nodes.find(sn => sn.id === n.id);
                return stateNode && stateNode.status !== 'skipped';
            });

            // Reset node statuses to pending for the test phase
            if (currentState) {
                for (const node of nodesToTest) {
                    stateManager.updateNodeStatus(currentState, node.id, 'running');
                }
            }

            const maxRetries = currentState?.retryConfig?.maxRetries ?? 10;
            const batchResults = await this.batchHandler.runBatchTestFixLoop(
                nodesToTest,
                allNodes,
                allEdges,
                maxRetries,
                stateManager,
                state,
                (update) => this.notifyProgress(update)
            );

            // Update final statuses
            for (const [nodeId, passed] of batchResults) {
                const node = this.nodeManager.getNodeById(nodeId);
                if (node) {
                    const status: NodeStatus = passed ? 'passed' : 'failed';
                    this.nodeStatusService.setStatusByNode(node, status, {
                        saveNow: true,
                        reason: `batch-mode final status: ${status}`
                    });

                    this.webview.postMessage({
                        command: 'singleNodeAutomationComplete',
                        nodeId,
                        passed,
                        nodeStatus: status,
                        completionKind: 'run-fix',
                        testsExecuted: true
                    });
                }
            }

            TestRunner.sequentialMode = false;

            // Complete automation
            const finalState = stateManager.loadState();
            if (finalState) {
                stateManager.completeAutomation(finalState);
            }

            this.emitFinalStatus(stateManager);

        } catch (error) {
            logError('CANVAS', 'Batch mode automation failed', error);
            TestRunner.sequentialMode = false;
            vscode.window.showErrorMessage(`Batch automation failed: ${error}`);
            this.emitErrorStatus(`Error: ${error}`);
        }
    }

    /**
     * Shared sliding window execution used by both normal and batch-mode Phase 1.
     * Returns true if automation was stopped, false otherwise.
     */
    private async runSlidingWindowExecution(
        sortedNodes: Node[],
        allNodes: Node[],
        expandedEdges: Array<{ source: string; target: string }>,
        modes: ('bdd' | 'test' | 'run-fix')[],
        concurrency: number,
        waitForDependencies: boolean,
        sequentialTests: boolean,
        stateManager: AutomationStateManager,
        progressPrefix = ''
    ): Promise<boolean> {
        const dependencyMap = new Map<string, Set<string>>();
        if (waitForDependencies) {
            for (const node of sortedNodes) {
                dependencyMap.set(node.id, new Set());
            }
            for (const edge of expandedEdges) {
                if (dependencyMap.has(edge.target)) {
                    dependencyMap.get(edge.target)!.add(edge.source);
                }
            }
        }

        const completedNodes = new Set<string>();
        const runningNodes = new Map<string, Promise<{ nodeId: string; passed: boolean; stopped: boolean }>>();
        let queueIndex = 0;
        let automationStopped = false;

        const launchNext = (): boolean => {
            const currentState = stateManager.loadState();
            if (!currentState || currentState.status === 'stopped') { return false; }

            const effectiveConcurrency = currentState.executionSettings?.concurrency || concurrency;
            TestRunner.sequentialMode = currentState.executionSettings?.sequentialTests ?? sequentialTests;
            while (runningNodes.size < effectiveConcurrency && queueIndex < sortedNodes.length) {
                const stateNode = currentState.nodes.find(n => n.id === sortedNodes[queueIndex].id);
                const sortedNode = sortedNodes[queueIndex];

                if (!stateNode || stateNode.status !== 'pending') {
                    queueIndex++;
                    completedNodes.add(sortedNode.id);
                    continue;
                }

                if (waitForDependencies) {
                    const deps = dependencyMap.get(sortedNode.id) || new Set();
                    const depsReady = [...deps].every(depId => completedNodes.has(depId));
                    if (!depsReady) {
                        queueIndex++;
                        continue;
                    }
                }

                const node = allNodes.find(n => n.id === sortedNode.id);
                if (!node) {
                    stateManager.updateNodeStatus(currentState, sortedNode.id, 'failed', 'Node not found');
                    completedNodes.add(sortedNode.id);
                    queueIndex++;
                    continue;
                }

                stateManager.updateNodeStatus(currentState, stateNode.id, 'running');

                const progressMessage = `${progressPrefix}${completedNodes.size + runningNodes.size + 1}/${sortedNodes.length}: ${node.title}`;
                this.webview.postMessage({
                    command: 'allNodesAutomationStatus',
                    status: 'running',
                    message: progressMessage
                });
                this.notifyProgress({ status: 'running', message: progressMessage });

                const promise = this.runSingleNodeAutomationAndWait(node, modes, node.id)
                    .then(result => ({ nodeId: node.id, ...result }));
                runningNodes.set(node.id, promise);
                queueIndex++;
            }
            return true;
        };

        if (!launchNext()) { automationStopped = true; }

        while (runningNodes.size > 0 && !automationStopped) {
            const result = await Promise.race([...runningNodes.values()]);
            runningNodes.delete(result.nodeId);

            if (result.stopped) {
                for (const [id] of runningNodes) {
                    const orch = this.orchestrators.get(id);
                    if (orch?.isRunning()) { orch.stop(); }
                    const wp = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (wp) { CLIAgentLauncher.getInstance(wp).killTerminal(id); }
                }
                const currentState = stateManager.loadState();
                if (currentState) { stateManager.stopAutomation(currentState); }
                automationStopped = true;
                break;
            }

            const currentState = stateManager.loadState();
            if (currentState) {
                stateManager.updateNodeStatus(currentState, result.nodeId, result.passed ? 'passed' : 'failed');
            }
            completedNodes.add(result.nodeId);

            if (waitForDependencies) { queueIndex = 0; }
            if (!launchNext()) { automationStopped = true; }
        }

        return automationStopped;
    }

    /**
     * Emit error status to webview and progress callback
     */
    private emitErrorStatus(message: string): void {
        this.webview.postMessage({
            command: 'allNodesAutomationStatus',
            status: 'error',
            message
        });
        this.notifyProgress({ status: 'error', message });
    }

    /**
     * Emit final automation status from state manager
     */
    private emitFinalStatus(stateManager: AutomationStateManager): void {
        const finalState = stateManager.loadState();
        if (!finalState) { return; }

        const completedMessage = stateManager.getSkippedCount(finalState) > 0
            ? `Completed: ${stateManager.getPassedCount(finalState)}/${stateManager.getCompletedCount(finalState)} passed (${stateManager.getSkippedCount(finalState)} skipped)`
            : `Completed: ${stateManager.getPassedCount(finalState)}/${stateManager.getCompletedCount(finalState)} passed`;

        logCanvas(`All-nodes automation complete: ${completedMessage}`);

        this.webview.postMessage({
            command: 'allNodesAutomationStatus',
            status: 'completed',
            totalNodes: stateManager.getTotalNodes(finalState),
            completedCount: stateManager.getCompletedCount(finalState),
            passedCount: stateManager.getPassedCount(finalState),
            skippedCount: stateManager.getSkippedCount(finalState),
            message: completedMessage
        });
        this.notifyProgress({
            status: 'completed',
            totalNodes: stateManager.getTotalNodes(finalState),
            completedCount: stateManager.getCompletedCount(finalState),
            passedCount: stateManager.getPassedCount(finalState),
            skippedCount: stateManager.getSkippedCount(finalState),
            message: completedMessage
        });

        if (stateManager.getPassedCount(finalState) === stateManager.getCompletedCount(finalState)) {
            const skipMsg = stateManager.getSkippedCount(finalState) > 0 ? ` (${stateManager.getSkippedCount(finalState)} skipped)` : '';
            vscode.window.showInformationMessage(`✅ All ${stateManager.getCompletedCount(finalState)} nodes passed!${skipMsg}`);
        } else {
            const skipMsg = stateManager.getSkippedCount(finalState) > 0 ? ` (${stateManager.getSkippedCount(finalState)} skipped)` : '';
            vscode.window.showWarningMessage(`Automation complete: ${stateManager.getPassedCount(finalState)}/${stateManager.getCompletedCount(finalState)} passed${skipMsg}`);
        }
    }

    /**
     * Stop all-nodes automation (stops all running orchestrators and terminals)
     */
    handleStopAllNodesAutomation(): void {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const launcher = workspacePath ? CLIAgentLauncher.getInstance(workspacePath) : null;

        // Cancel any running test processes first
        this.testExecutionHandlers.cancelCurrentTest();

        // Cancel batch mode if running
        this.batchHandler.cancelBatch();

        let stoppedCount = 0;
        for (const [id, orchestrator] of this.orchestrators) {
            if (orchestrator.isRunning()) {
                orchestrator.stop();
                launcher?.killTerminal(id);
                this.restoreNodeStatus(id, 'all-nodes stop restore', { preserveFailed: true });
                stoppedCount++;
            }
        }

        // Also kill any remaining terminals (including batch terminal)
        launcher?.killTerminal();

        if (stoppedCount > 0) {
            vscode.window.showInformationMessage(`🛑 Stopped ${stoppedCount} running automation(s)`);
        }
    }
}
