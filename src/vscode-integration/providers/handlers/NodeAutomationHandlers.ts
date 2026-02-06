/**
 * NodeAutomationHandlers - Handles single-node and all-nodes automation
 *
 * Extracted from TestWorkflowHandlers to comply with CLAUDE.md file size limits
 * Manages: Single-node automation, all-nodes batch automation
 */

import * as vscode from 'vscode';
import { Node, TestResult } from '../../../shared/types';
import { AutomationProgressUpdate } from '../../../shared/types/slack';
import { logCanvas, logError } from '../../../shared/utils/Logger';
import { FeatureMapStorage } from '../../../infrastructure/storage/FeatureMapStorage';
import { SimpleNodeManager } from '../SimpleNodeManager';
import { SingleNodeOrchestrator, SingleNodeState } from '../../../core/services/SingleNodeOrchestrator';
import { TestExecutionHandlers } from './TestExecutionHandlers';
import { CLIAgentLauncher } from '../../CLIAgentLauncher';

export class NodeAutomationHandlers {
    private singleNodeOrchestrator: SingleNodeOrchestrator | null = null;
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

            if (this.singleNodeOrchestrator?.isRunning()) {
                logCanvas(`[WARN] Orchestrator already running - blocking new automation`);
                vscode.window.showWarningMessage('Single-node automation is already running. Stop it first.');
                return { started: false, error: 'Automation already running. Stop it first or wait for completion.', nodeName: node.title };
            }

            const workspaceRoot = this.storage.getWorkspaceRoot();
            const extensionPath = vscode.extensions.getExtension('tdad.tdad')?.extensionPath || this.context.extensionPath;
            logCanvas(`Creating orchestrator: workspace=${workspaceRoot}`);

            this.singleNodeOrchestrator = new SingleNodeOrchestrator(workspaceRoot, extensionPath);

            this.singleNodeOrchestrator.setTestRunner({
                runNodeTests: async (testNode: Node, _filter: string) => {
                    const allNodes = this.nodeManager.getNodes();
                    return await this.testExecutionHandlers.runTestsAndSaveTraces(testNode, allNodes);
                }
            });

            let previousPhase: string | null = null;

            this.singleNodeOrchestrator.setCallbacks({
                onStatusChange: (state: SingleNodeState) => {
                    logCanvas(`Single-node automation status: ${state.phase} - ${state.message}`);
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
                    logCanvas(`Single-node automation complete: ${completedNodeId} - ${passed ? 'PASSED' : 'FAILED'} (modes: ${modes.join(', ')})`);
                    this.checkSingleNodeFileStatus(completedNodeId);

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
                    logError('CANVAS', 'Single-node automation error', error);
                    vscode.window.showErrorMessage(`Automation error: ${error.message}`);
                },
                onTaskWritten: (taskFile: string, taskDescription: string) => {
                    logCanvas(`Task written: ${taskDescription}`);
                    vscode.window.showInformationMessage(`📝 ${taskDescription} - Check .tdad/NEXT_TASK.md`);

                    const launcher = CLIAgentLauncher.getInstance(workspaceRoot);
                    launcher.triggerAgent(taskFile, taskDescription);
                }
            });

            const allNodes = this.nodeManager.getAllNodes();
            const allEdges = this.storage.loadAllEdges();

            await this.singleNodeOrchestrator.startSingleNode(node, allNodes, allEdges, modes);

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
     * Stop single-node automation
     */
    handleStopSingleNodeAutomation(): void {
        // Kill CLI terminal first
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspacePath) {
            CLIAgentLauncher.getInstance(workspacePath).killTerminal();
        }

        if (this.singleNodeOrchestrator?.isRunning()) {
            this.singleNodeOrchestrator.stop();
            vscode.window.showInformationMessage('🛑 Single-node automation stopped');
        } else {
            vscode.window.showWarningMessage('No automation is running');
        }
    }

    /**
     * Handle agent done signal for single-node automation
     */
    async handleSingleNodeAgentDone(): Promise<void> {
        if (this.singleNodeOrchestrator?.isRunning()) {
            await this.singleNodeOrchestrator.onAgentDone();
        }
    }

    /**
     * Get single-node orchestrator for file watcher setup
     */
    getSingleNodeOrchestrator(): SingleNodeOrchestrator | null {
        return this.singleNodeOrchestrator;
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

            this.webview.postMessage({
                command: 'autopilotInfo',
                pendingCount: featureNodes.length,
                folderName
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
     * @param targetFolderId Optional folder ID to run nodes from (if null/undefined, uses current folder or all nodes)
     * @param modes The automation modes to run
     */
    async handleRunAllNodesAutomation(confirmed = false, targetFolderId: string | null | undefined = undefined, modes: ('bdd' | 'test' | 'run-fix')[] = ['bdd', 'test', 'run-fix']): Promise<void> {
        try {
            logCanvas(`Starting run-all-nodes automation (modes: ${modes.join(', ')}, targetFolderId: ${targetFolderId ?? 'none'})`);

            const cancelAutomation = (message: string) => {
                logCanvas(`Cancelling automation: ${message}`);
                this.webview.postMessage({
                    command: 'allNodesAutomationStatus',
                    status: 'cancelled',
                    message
                });
            };

            if (this.singleNodeOrchestrator?.isRunning()) {
                logCanvas('Automation already running, aborting');
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

            const startMessage = `Starting automation for ${sortedNodes.length} nodes...`;
            this.webview.postMessage({
                command: 'allNodesAutomationStatus',
                status: 'running',
                totalNodes: sortedNodes.length,
                currentIndex: 0,
                message: startMessage
            });
            this.notifyProgress({
                status: 'running',
                totalNodes: sortedNodes.length,
                currentIndex: 0,
                message: startMessage
            });

            vscode.window.showInformationMessage(`🚀 Starting automation for ${sortedNodes.length} nodes`);

            let completedCount = 0;
            let passedCount = 0;
            let skippedCount = 0;

            for (let i = 0; i < sortedNodes.length; i++) {
                const node = sortedNodes[i];

                // Skip nodes that have already passed (only when run-fix mode is included)
                if (modes.includes('run-fix') && (node as any).status === 'passed') {
                    logCanvas(`Skipping node ${node.title} - already passed`);
                    skippedCount++;
                    passedCount++;
                    completedCount++;

                    const progressMessage = `Skipped ${i + 1}/${sortedNodes.length}: ${node.title} (already passed)`;
                    this.webview.postMessage({
                        command: 'allNodesAutomationStatus',
                        status: 'running',
                        totalNodes: sortedNodes.length,
                        currentIndex: i,
                        currentNodeId: node.id,
                        currentNodeTitle: node.title,
                        message: progressMessage,
                        skipped: true
                    });
                    this.notifyProgress({
                        status: 'running',
                        totalNodes: sortedNodes.length,
                        currentIndex: i,
                        currentNodeId: node.id,
                        currentNodeTitle: node.title,
                        message: progressMessage,
                        skipped: true
                    });
                    continue;
                }

                const progressMessage = `Processing ${i + 1}/${sortedNodes.length}: ${node.title}`;

                this.webview.postMessage({
                    command: 'allNodesAutomationStatus',
                    status: 'running',
                    totalNodes: sortedNodes.length,
                    currentIndex: i,
                    currentNodeId: node.id,
                    currentNodeTitle: node.title,
                    message: progressMessage
                });
                this.notifyProgress({
                    status: 'running',
                    totalNodes: sortedNodes.length,
                    currentIndex: i,
                    currentNodeId: node.id,
                    currentNodeTitle: node.title,
                    message: progressMessage
                });

                const result = await this.runSingleNodeAutomationAndWait(node, modes);

                completedCount++;
                if (result.passed) {
                    passedCount++;
                }

                if (result.stopped && i < sortedNodes.length - 1) {
                    logCanvas('Automation stopped by user');
                    const stoppedMessage = skippedCount > 0
                        ? `Automation stopped (${skippedCount} skipped)`
                        : 'Automation stopped';
                    this.webview.postMessage({
                        command: 'allNodesAutomationStatus',
                        status: 'stopped',
                        totalNodes: sortedNodes.length,
                        completedCount,
                        passedCount,
                        skippedCount,
                        message: stoppedMessage
                    });
                    this.notifyProgress({
                        status: 'stopped',
                        totalNodes: sortedNodes.length,
                        completedCount,
                        passedCount,
                        skippedCount,
                        message: stoppedMessage
                    });
                    return;
                }
            }

            const completedMessage = skippedCount > 0
                ? `Completed: ${passedCount}/${completedCount} passed (${skippedCount} skipped)`
                : `Completed: ${passedCount}/${completedCount} passed`;
            logCanvas(`All-nodes automation complete: ${passedCount}/${completedCount} passed${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}`);

            this.webview.postMessage({
                command: 'allNodesAutomationStatus',
                status: 'completed',
                totalNodes: sortedNodes.length,
                completedCount,
                passedCount,
                skippedCount,
                message: completedMessage
            });
            this.notifyProgress({
                status: 'completed',
                totalNodes: sortedNodes.length,
                completedCount,
                passedCount,
                skippedCount,
                message: completedMessage
            });

            if (passedCount === completedCount) {
                const skipMsg = skippedCount > 0 ? ` (${skippedCount} skipped)` : '';
                vscode.window.showInformationMessage(`✅ All ${completedCount} nodes in this folder passed!${skipMsg}`);
            } else {
                const skipMsg = skippedCount > 0 ? ` (${skippedCount} skipped)` : '';
                vscode.window.showWarningMessage(`Folder automation complete: ${passedCount}/${completedCount} passed${skipMsg}`);
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
     */
    private async runSingleNodeAutomationAndWait(node: Node, modes: ('bdd' | 'test' | 'run-fix')[] = ['bdd', 'test', 'run-fix']): Promise<{ passed: boolean; stopped: boolean }> {
        return new Promise<{ passed: boolean; stopped: boolean }>((resolve) => {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const extensionPath = vscode.extensions.getExtension('tdad.tdad')?.extensionPath || process.cwd();

            let wasStopped = false;

            this.singleNodeOrchestrator = new SingleNodeOrchestrator(workspaceRoot, extensionPath);

            this.singleNodeOrchestrator.setTestRunner({
                runNodeTests: async (testNode: Node, _filter: string) => {
                    const allNodes = this.nodeManager.getNodes();
                    return await this.testExecutionHandlers.runTestsAndSaveTraces(testNode, allNodes);
                }
            });

            let previousPhase: string | null = null;

            this.singleNodeOrchestrator.setCallbacks({
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
                    if (!wasStopped) {
                        resolve({ passed: false, stopped: false });
                    }
                },
                onTaskWritten: (taskFile: string, taskDescription: string) => {
                    logCanvas(`[All-Nodes] Task written: ${taskDescription}`);
                    vscode.window.showInformationMessage(`📝 ${taskDescription}`);

                    const launcher = CLIAgentLauncher.getInstance(workspaceRoot);
                    launcher.triggerAgent(taskFile, taskDescription);
                }
            });

            const allNodes = this.nodeManager.getAllNodes();
            const allEdges = this.storage.loadAllEdges();

            this.singleNodeOrchestrator.startSingleNode(node, allNodes, allEdges, modes).catch((error) => {
                logError('CANVAS', `[All-Nodes] Failed to start automation for ${node.title}`, error);
                if (!wasStopped) {
                    resolve({ passed: false, stopped: false });
                }
            });
        });
    }

    /**
     * Stop all-nodes automation
     */
    handleStopAllNodesAutomation(): void {
        // Kill CLI terminal first
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspacePath) {
            CLIAgentLauncher.getInstance(workspacePath).killTerminal();
        }

        if (this.singleNodeOrchestrator?.isRunning()) {
            this.singleNodeOrchestrator.stop();
            vscode.window.showInformationMessage('🛑 All-nodes automation stopped');
        }
    }
}
