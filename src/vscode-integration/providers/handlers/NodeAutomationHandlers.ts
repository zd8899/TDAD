/**
 * NodeAutomationHandlers - Handles single-node and all-nodes automation
 *
 * Extracted from TestWorkflowHandlers to comply with CLAUDE.md file size limits
 * Manages: Single-node automation, all-nodes batch automation
 */

import * as vscode from 'vscode';
import { Node, TestResult, DEFAULT_PERMISSION_FLAGS } from '../../../shared/types';
import { AutomationProgressUpdate } from '../../../shared/types/slack';
import { logCanvas, logError } from '../../../shared/utils/Logger';
import { FeatureMapStorage } from '../../../infrastructure/storage/FeatureMapStorage';
import { SimpleNodeManager } from '../SimpleNodeManager';
import { SingleNodeOrchestrator, SingleNodeState } from '../../../core/services/SingleNodeOrchestrator';
import { TestExecutionHandlers } from './TestExecutionHandlers';
import { CLIAgentLauncher } from '../../CLIAgentLauncher';
import { AutomationStateManager } from '../../../infrastructure/storage/AutomationStateManager';
import { TestRunner } from '../../testing/TestRunner';

export class NodeAutomationHandlers {
    private orchestrators: Map<string, SingleNodeOrchestrator> = new Map();
    private automationProgressCallback: ((update: AutomationProgressUpdate) => void) | null = null;

    constructor(
        private readonly webview: vscode.Webview,
        private readonly storage: FeatureMapStorage,
        private readonly nodeManager: SimpleNodeManager,
        private readonly context: vscode.ExtensionContext,
        private readonly testResultsCache: Map<string, TestResult[]>,
        private readonly testExecutionHandlers: TestExecutionHandlers,
        private readonly checkSingleNodeFileStatus: (nodeId: string) => Promise<void>
    ) {}

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
     * Get all descendant node IDs of a folder (recursive)
     */
    private getDescendantNodeIds(folderId: string, allNodes: Node[]): Set<string> {
        const descendants = new Set<string>();

        logCanvas(`getDescendantNodeIds: Looking for descendants of folder ${folderId}`);
        logCanvas(`getDescendantNodeIds: Total nodes to search: ${allNodes.length}`);

        const collectDescendants = (parentId: string) => {
            for (const node of allNodes) {
                if ((node as any).parentId === parentId) {
                    descendants.add(node.id);
                    logCanvas(`getDescendantNodeIds: Found descendant: ${node.title} (${node.id}) with parentId=${(node as any).parentId}`);
                    if (node.nodeType === 'folder') {
                        collectDescendants(node.id);
                    }
                }
            }
        };

        collectDescendants(folderId);
        logCanvas(`getDescendantNodeIds: Found ${descendants.size} total descendants`);
        return descendants;
    }

    /**
     * Expand folder-level edges into feature-node edges so topological sort respects folder order.
     * - Within each folder: creates a chain based on the children array order (child[0] → child[1] → ...)
     * - Across folders: if folder A → folder B, the last child of A must complete before the first child of B
     */
    private expandFolderEdges(featureNodes: Node[], allNodes: Node[], edges: Array<{ source: string; target: string }>): Array<{ source: string; target: string }> {
        const featureNodeIds = new Set(featureNodes.map(n => n.id));
        const folderNodes = allNodes.filter(n => n.nodeType === 'folder');
        const folderMap = new Map(folderNodes.map(f => [f.id, f]));
        const expandedEdges: Array<{ source: string; target: string }> = [];

        // Get ordered feature children of a folder (respecting children array order)
        const getOrderedFeatureChildren = (folderId: string): string[] => {
            const folder = folderMap.get(folderId);
            if (!folder || !(folder as any).children) { return []; }
            return ((folder as any).children as string[]).filter(id => featureNodeIds.has(id));
        };

        // Within-folder chains: children execute in declared order
        for (const folder of folderNodes) {
            const orderedChildren = getOrderedFeatureChildren(folder.id);
            for (let i = 0; i < orderedChildren.length - 1; i++) {
                expandedEdges.push({ source: orderedChildren[i], target: orderedChildren[i + 1] });
            }
        }

        // Cross-folder edges: last child of source folder → first child of target folder
        for (const edge of edges) {
            const sourceFolder = folderMap.get(edge.source);
            const targetFolder = folderMap.get(edge.target);

            if (sourceFolder && targetFolder) {
                const sourceChildren = getOrderedFeatureChildren(edge.source);
                const targetChildren = getOrderedFeatureChildren(edge.target);
                if (sourceChildren.length > 0 && targetChildren.length > 0) {
                    expandedEdges.push({
                        source: sourceChildren[sourceChildren.length - 1],
                        target: targetChildren[0]
                    });
                }
            } else if (featureNodeIds.has(edge.source) && featureNodeIds.has(edge.target)) {
                // Direct feature-to-feature edge, keep as-is
                expandedEdges.push(edge);
            }
        }

        logCanvas(`expandFolderEdges: ${edges.length} original edges → ${expandedEdges.length} expanded edges`);
        return expandedEdges;
    }

    /**
     * Sort nodes by dependency order (topological sort)
     */
    private sortNodesByDependency(nodes: Node[], edges: Array<{ source: string; target: string }>): Node[] {
        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        const inDegree = new Map<string, number>();
        const adjacencyList = new Map<string, string[]>();

        for (const node of nodes) {
            inDegree.set(node.id, 0);
            adjacencyList.set(node.id, []);
        }

        for (const edge of edges) {
            if (nodeMap.has(edge.source) && nodeMap.has(edge.target)) {
                adjacencyList.get(edge.source)!.push(edge.target);
                inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
            }
        }

        const queue: string[] = [];
        const result: Node[] = [];

        for (const [nodeId, degree] of inDegree) {
            if (degree === 0) {
                queue.push(nodeId);
            }
        }

        while (queue.length > 0) {
            const nodeId = queue.shift()!;
            const node = nodeMap.get(nodeId);
            if (node) {
                result.push(node);
            }

            for (const dependent of adjacencyList.get(nodeId) || []) {
                const newDegree = (inDegree.get(dependent) || 0) - 1;
                inDegree.set(dependent, newDegree);
                if (newDegree === 0) {
                    queue.push(dependent);
                }
            }
        }

        for (const node of nodes) {
            if (!result.includes(node)) {
                result.push(node);
            }
        }

        return result;
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

                    const completedNode = this.nodeManager.getNodeById(completedNodeId);
                    if (completedNode) {
                        (completedNode as any).status = passed ? 'passed' : 'failed';
                        this.syncNodeFilePaths(node, completedNode);
                        this.nodeManager.updateNode(completedNode);
                        this.nodeManager.saveNow();
                    }

                    this.webview.postMessage({
                        command: 'singleNodeAutomationComplete',
                        nodeId: completedNodeId,
                        passed
                    });

                    const isBddOnly = modes.length === 1 && modes[0] === 'bdd';
                    const isTestOnly = modes.length === 1 && modes[0] === 'test';
                    const hasRunFix = modes.includes('run-fix');

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
    async handleSingleNodeAgentDone(): Promise<void> {
        for (const [, orchestrator] of this.orchestrators) {
            if (orchestrator.isRunning()) {
                await orchestrator.onAgentDone();
                return;
            }
        }
    }

    /**
     * Handle per-node agent done signal for parallel execution
     */
    async handlePerNodeAgentDone(nodeId: string): Promise<void> {
        const orchestrator = this.orchestrators.get(nodeId);
        if (orchestrator?.isRunning()) {
            await orchestrator.onAgentDone();
        }
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
                const descendantIds = this.getDescendantNodeIds(currentFolderId, allNodes);
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
    async handleRunAllNodesAutomation(confirmed = false, targetFolderId: string | null | undefined = undefined, modes: ('bdd' | 'test' | 'run-fix')[] = ['bdd', 'test', 'run-fix'], concurrency = 1, waitForDependencies = false, sequentialTests = true): Promise<void> {
        try {
            logCanvas(`Starting run-all-nodes automation (modes: ${modes.join(', ')}, concurrency: ${concurrency}, waitDeps: ${waitForDependencies}, targetFolderId: ${targetFolderId ?? 'none'})`);

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
                const descendantIds = this.getDescendantNodeIds(folderId, allNodes);
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
            const expandedEdges = this.expandFolderEdges(featureNodes, allNodes, allEdges);
            const sortedNodes = this.sortNodesByDependency(featureNodes, expandedEdges);

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
                sequentialTests
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

            const startMessage = `Starting automation for ${stateManager.getTotalNodes(state)} nodes (${stateManager.getSkippedCount(state)} already passed)...`;
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

            // Build dependency map for waitForDependencies mode
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

            // Parallel sliding window execution
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

                    // Skip already processed nodes
                    if (!stateNode || stateNode.status !== 'pending') {
                        queueIndex++;
                        completedNodes.add(sortedNode.id);
                        continue;
                    }

                    // If waitForDependencies, check deps are completed
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

                    // Launch this node
                    stateManager.updateNodeStatus(currentState, stateNode.id, 'running');

                    const modesToRun: ('bdd' | 'test' | 'run-fix')[] = [];
                    if (stateNode.modes.bdd) { modesToRun.push('bdd'); }
                    if (stateNode.modes.test) { modesToRun.push('test'); }
                    if (stateNode.modes.runFix) { modesToRun.push('run-fix'); }

                    const progressMessage = `Processing ${completedNodes.size + runningNodes.size + 1}/${stateManager.getTotalNodes(currentState)}: ${node.title}`;
                    logCanvas(progressMessage);
                    this.webview.postMessage({
                        command: 'allNodesAutomationStatus',
                        status: 'running',
                        totalNodes: stateManager.getTotalNodes(currentState),
                        currentIndex: completedNodes.size,
                        currentNodeId: node.id,
                        currentNodeTitle: node.title,
                        message: concurrency > 1 ? `[${runningNodes.size + 1} agents] ${progressMessage}` : progressMessage
                    });
                    this.notifyProgress({
                        status: 'running',
                        totalNodes: stateManager.getTotalNodes(currentState),
                        currentIndex: completedNodes.size,
                        currentNodeId: node.id,
                        currentNodeTitle: node.title,
                        message: progressMessage
                    });

                    const promise = this.runSingleNodeAutomationAndWait(node, modesToRun, node.id)
                        .then(result => ({ nodeId: node.id, ...result }));
                    runningNodes.set(node.id, promise);
                    queueIndex++;
                }

                return true;
            };

            // Initial launch
            if (!launchNext()) { automationStopped = true; }

            // Wait for completions and launch more
            while (runningNodes.size > 0 && !automationStopped) {
                const result = await Promise.race([...runningNodes.values()]);
                runningNodes.delete(result.nodeId);

                if (result.stopped) {
                    // Stop all running orchestrators
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

                // Try to launch more - when waiting for dependencies, rescan from start
                // since completed nodes may have unblocked previously-skipped nodes
                if (waitForDependencies) { queueIndex = 0; }
                if (!launchNext()) { automationStopped = true; }
            }

            // Check if all nodes are processed (not stopped)
            if (!automationStopped) {
                const currentState = stateManager.loadState();
                if (currentState && !stateManager.getNextNode(currentState)) {
                    stateManager.completeAutomation(currentState);
                }
            }

            // Reset sequential test mode when automation ends
            TestRunner.sequentialMode = false;

            // Final state
            const finalState = stateManager.loadState();
            if (finalState) {
                const completedMessage = stateManager.getSkippedCount(finalState) > 0
                    ? `Completed: ${stateManager.getPassedCount(finalState)}/${stateManager.getCompletedCount(finalState)} passed (${stateManager.getSkippedCount(finalState)} skipped)`
                    : `Completed: ${stateManager.getPassedCount(finalState)}/${stateManager.getCompletedCount(finalState)} passed`;

                logCanvas(`All-nodes automation complete: ${stateManager.getPassedCount(finalState)}/${stateManager.getCompletedCount(finalState)} passed${stateManager.getSkippedCount(finalState) > 0 ? ` (${stateManager.getSkippedCount(finalState)} skipped)` : ''}`);

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
                    vscode.window.showInformationMessage(`✅ All ${stateManager.getCompletedCount(finalState)} nodes in this folder passed!${skipMsg}`);
                } else {
                    const skipMsg = stateManager.getSkippedCount(finalState) > 0 ? ` (${stateManager.getSkippedCount(finalState)} skipped)` : '';
                    vscode.window.showWarningMessage(`Folder automation complete: ${stateManager.getPassedCount(finalState)}/${stateManager.getCompletedCount(finalState)} passed${skipMsg}`);
                }
            }

        } catch (error) {
            logError('CANVAS', 'Failed to run all-nodes automation', error);
            vscode.window.showErrorMessage(`Automation failed: ${error}`);
            const errorMessage = `Error: ${error}`;
            this.webview.postMessage({
                command: 'allNodesAutomationStatus',
                status: 'error',
                message: errorMessage
            });
            this.notifyProgress({
                status: 'error',
                message: errorMessage
            });
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

            const orchestrator = new SingleNodeOrchestrator(workspaceRoot, extensionPath, effectiveNodeId);
            this.orchestrators.set(effectiveNodeId, orchestrator);

            orchestrator.setTestRunner({
                runNodeTests: async (testNode: Node, _filter: string) => {
                    const allNodes = this.nodeManager.getNodes();
                    return await this.testExecutionHandlers.runTestsAndSaveTraces(testNode, allNodes);
                }
            });

            let previousPhase: string | null = null;

            orchestrator.setCallbacks({
                onStatusChange: (state: SingleNodeState) => {
                    logCanvas(`[All-Nodes] ${node.title}: ${state.phase} - ${state.message}`);

                    if (state.status === 'stopped') {
                        wasStopped = true;
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

                    const completedNode = this.nodeManager.getNodeById(completedNodeId);
                    if (completedNode) {
                        (completedNode as any).status = passed ? 'passed' : 'failed';
                        this.syncNodeFilePaths(node, completedNode);
                        this.nodeManager.updateNode(completedNode);
                        this.nodeManager.saveNow();
                    }

                    this.webview.postMessage({
                        command: 'singleNodeAutomationComplete',
                        nodeId: completedNodeId,
                        passed
                    });

                    if (!wasStopped) {
                        resolve({ passed, stopped: false });
                    }
                },
                onTestResults: (testNodeId: string, results: TestResult[]) => {
                    this.testResultsCache.set(testNodeId, results);
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
                if (!wasStopped) {
                    resolve({ passed: false, stopped: false });
                }
            });
        });
    }

    /**
     * Stop all-nodes automation (stops all running orchestrators and terminals)
     */
    handleStopAllNodesAutomation(): void {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const launcher = workspacePath ? CLIAgentLauncher.getInstance(workspacePath) : null;

        // Cancel any running test processes first
        this.testExecutionHandlers.cancelCurrentTest();

        let stoppedCount = 0;
        for (const [id, orchestrator] of this.orchestrators) {
            if (orchestrator.isRunning()) {
                orchestrator.stop();
                launcher?.killTerminal(id);
                stoppedCount++;
            }
        }

        // Also kill any remaining terminals
        launcher?.killTerminal();

        if (stoppedCount > 0) {
            vscode.window.showInformationMessage(`🛑 Stopped ${stoppedCount} running automation(s)`);
        }
    }
}
