/**
 * TestWorkflowHandlers - Coordinator for test workflow operations
 *
 * Delegates to specialized handlers to comply with CLAUDE.md file size limits:
 * - BddSpecHandlers: BDD spec loading, generation, saving
 * - TestGenerationHandlers: Test code generation from Gherkin specs
 * - TestExecutionHandlers: Test running, results, golden packet
 * - NodeAutomationHandlers: Single-node and all-nodes automation
 */

import * as vscode from 'vscode';
import { Node, TestResult } from '../../../shared/types';
import { AutomationProgressUpdate } from '../../../shared/types/slack';
import { logError, logger } from '../../../shared/utils/Logger';
import { FileNameGenerator } from '../../../shared/utils/fileNameGenerator';
import { FeatureMapStorage } from '../../../infrastructure/storage/FeatureMapStorage';
import { SimpleNodeManager } from '../SimpleNodeManager';
import { TestOrchestrator } from '../../testing/TestOrchestrator';
import { ScaffoldingService } from '../../../core/workflows/ScaffoldingService';
import { SingleNodeOrchestrator } from '../../../core/services/SingleNodeOrchestrator';
import { BddSpecHandlers } from './BddSpecHandlers';
import { TestGenerationHandlers } from './TestGenerationHandlers';
import { TestExecutionHandlers } from './TestExecutionHandlers';
import { NodeAutomationHandlers } from './NodeAutomationHandlers';

export class TestWorkflowHandlers {
    private readonly bddSpecHandlers: BddSpecHandlers;
    private readonly testGenerationHandlers: TestGenerationHandlers;
    private readonly testExecutionHandlers: TestExecutionHandlers;
    private readonly nodeAutomationHandlers: NodeAutomationHandlers;

    constructor(
        private readonly webview: vscode.Webview,
        private readonly storage: FeatureMapStorage,
        private readonly nodeManager: SimpleNodeManager,
        context: vscode.ExtensionContext,
        testOrchestrator: TestOrchestrator,
        testResultsCache: Map<string, TestResult[]>
    ) {
        // Initialize sub-handlers
        this.bddSpecHandlers = new BddSpecHandlers(webview, storage, nodeManager, context);
        this.testGenerationHandlers = new TestGenerationHandlers(webview, storage, nodeManager);
        this.testExecutionHandlers = new TestExecutionHandlers(
            webview, storage, nodeManager, context, testOrchestrator, testResultsCache
        );
        this.nodeAutomationHandlers = new NodeAutomationHandlers(
            webview, storage, nodeManager, context, testResultsCache,
            this.testExecutionHandlers,
            this.handleCheckSingleNodeFileStatus.bind(this)
        );
    }

    /**
     * Get the base path and fileName for a node's workflow files
     */
    private getNodeFilePaths(node: Node): { basePath: string; fileName: string } {
        const workflowFolderName = node.workflowId?.replace('.workflow.json', '').replace(/-workflow$/, '') || 'default';
        const fileName = FileNameGenerator.generate(node.title);
        const basePath = `.tdad/workflows/${workflowFolderName}/${fileName}`;
        return { basePath, fileName };
    }

    /**
     * Send all workflow nodes to webview for input/output suggestions
     */
    async handleRequestAllNodes(_workflowId: string): Promise<void> {
        try {
            const allNodes = this.nodeManager.getAllNodes();
            this.webview.postMessage({
                command: 'allNodesLoaded',
                nodes: allNodes
            });
            logger.debug('CANVAS', `Sent ${allNodes.length} nodes to webview`);
        } catch (error) {
            logError('CANVAS', 'Failed to load all nodes', error);
        }
    }

    /**
     * Check file status for all nodes at once (bulk operation for initial load)
     */
    async handleCheckAllNodesFileStatus(): Promise<void> {
        try {
            const allNodes = this.nodeManager.getAllNodes();
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const scaffoldingService = new ScaffoldingService();

            const fileStatusMap: Record<string, { hasBddSpec: boolean; hasTestDetails: boolean; bddHasRealContent: boolean; testHasRealContent: boolean }> = {};

            for (const node of allNodes) {
                if (node.nodeType === 'folder') {continue;}

                const { basePath, fileName } = this.getNodeFilePaths(node);
                const status = scaffoldingService.checkNodeFileStatus(workspaceRoot, basePath, fileName);
                fileStatusMap[node.id] = status;
            }

            this.webview.postMessage({
                command: 'allNodesFileStatusLoaded',
                fileStatusMap
            });
            logger.debug('CANVAS', `Checked file status for ${Object.keys(fileStatusMap).length} nodes`);
        } catch (error) {
            logError('CANVAS', 'Failed to check all nodes file status', error);
        }
    }

    /**
     * Check file status for a single node and send update to webview
     */
    async handleCheckSingleNodeFileStatus(nodeId: string): Promise<void> {
        try {
            const node = this.nodeManager.getNodes().find(n => n.id === nodeId);
            if (!node || node.nodeType === 'folder') {return;}

            const workspaceRoot = this.storage.getWorkspaceRoot();
            const scaffoldingService = new ScaffoldingService();

            const { basePath, fileName } = this.getNodeFilePaths(node);
            const status = scaffoldingService.checkNodeFileStatus(workspaceRoot, basePath, fileName);

            this.webview.postMessage({
                command: 'allNodesFileStatusLoaded',
                fileStatusMap: { [nodeId]: status }
            });
            logger.debug('CANVAS', `Checked file status for node: ${node.title}`);
        } catch (error) {
            logError('CANVAS', 'Failed to check single node file status', error);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // BDD Spec Handlers - Delegated to BddSpecHandlers
    // ═══════════════════════════════════════════════════════════════════════════

    async handleLoadBddSpec(nodeId: string, filePath: string): Promise<void> {
        return this.bddSpecHandlers.handleLoadBddSpec(nodeId, filePath);
    }

    async handleLoadTestFileContent(nodeId: string, filePath: string): Promise<void> {
        return this.bddSpecHandlers.handleLoadTestFileContent(nodeId, filePath);
    }

    async handleGenerateBddSpec(nodeId: string, featureDescription: string): Promise<void> {
        return this.bddSpecHandlers.handleGenerateBddSpec(nodeId, featureDescription);
    }

    async handleCopyBddPrompt(nodeId: string, featureDescription: string): Promise<void> {
        return this.bddSpecHandlers.handleCopyBddPrompt(nodeId, featureDescription);
    }

    async handleSaveBddSpec(nodeId: string, bddSpec: string, filePath: string): Promise<void> {
        return this.bddSpecHandlers.handleSaveBddSpec(nodeId, bddSpec, filePath);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test Generation Handlers - Delegated to TestGenerationHandlers
    // ═══════════════════════════════════════════════════════════════════════════

    async handleGenerateTestCode(nodeId: string, gherkinSpec: string, testFramework: string): Promise<void> {
        return this.testGenerationHandlers.handleGenerateTestCode(nodeId, gherkinSpec, testFramework);
    }

    async handleGenerateTestWithManualConfig(
        nodeId: string,
        manualInputs: Array<{ name: string; sourceNodeId: string; sourceOutputField: string }>,
        generationContext: { gherkinSpec: string; testFramework: string; nodeDescription?: string }
    ): Promise<void> {
        return this.testGenerationHandlers.handleGenerateTestWithManualConfig(nodeId, manualInputs, generationContext);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Test Execution Handlers - Delegated to TestExecutionHandlers
    // ═══════════════════════════════════════════════════════════════════════════

    async handleLoadTestDetails(nodeId: string, testFilePath: string): Promise<void> {
        return this.testExecutionHandlers.handleLoadTestDetails(nodeId, testFilePath);
    }

    async handleRunTests(nodeFromWebview: Node): Promise<void> {
        return this.testExecutionHandlers.handleRunTests(nodeFromWebview);
    }

    async runTestsAndSaveTraces(node: Node, allNodes: Node[]): Promise<TestResult[]> {
        return this.testExecutionHandlers.runTestsAndSaveTraces(node, allNodes);
    }

    async handleSelectContextFiles(nodeId: string): Promise<void> {
        return this.testExecutionHandlers.handleSelectContextFiles(nodeId);
    }

    async handleCopyGoldenPacket(nodeId: string): Promise<void> {
        return this.testExecutionHandlers.handleCopyGoldenPacket(nodeId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Node Automation Handlers - Delegated to NodeAutomationHandlers
    // ═══════════════════════════════════════════════════════════════════════════

    async handleRunSingleNodeAutomation(nodeId: string, modes: ('bdd' | 'test' | 'run-fix')[] = ['bdd', 'test', 'run-fix']): Promise<{ started: boolean; error?: string; nodeName?: string }> {
        return this.nodeAutomationHandlers.handleRunSingleNodeAutomation(nodeId, modes);
    }

    handleStopSingleNodeAutomation(): void {
        return this.nodeAutomationHandlers.handleStopSingleNodeAutomation();
    }

    async handleSingleNodeAgentDone(): Promise<void> {
        return this.nodeAutomationHandlers.handleSingleNodeAgentDone();
    }

    async handlePerNodeAgentDone(nodeId: string): Promise<void> {
        return this.nodeAutomationHandlers.handlePerNodeAgentDone(nodeId);
    }

    getSingleNodeOrchestrator(): SingleNodeOrchestrator | null {
        return this.nodeAutomationHandlers.getSingleNodeOrchestrator();
    }

    async handleGetAutopilotInfo(_allFolders = false): Promise<void> {
        return this.nodeAutomationHandlers.handleGetAutopilotInfo(_allFolders);
    }

    async handleRunAllNodesAutomation(confirmed = false, targetFolderId: string | null | undefined = undefined, modes: ('bdd' | 'test' | 'run-fix')[] = ['bdd', 'test', 'run-fix'], concurrency = 1, waitForDependencies = false, sequentialTests = true): Promise<void> {
        return this.nodeAutomationHandlers.handleRunAllNodesAutomation(confirmed, targetFolderId, modes, concurrency, waitForDependencies, sequentialTests);
    }

    handleStopAllNodesAutomation(): void {
        return this.nodeAutomationHandlers.handleStopAllNodesAutomation();
    }

    setAutomationProgressCallback(callback: ((update: AutomationProgressUpdate) => void) | null): void {
        this.nodeAutomationHandlers.setAutomationProgressCallback(callback);
    }
}
