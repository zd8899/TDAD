/**
 * AgentOrchestrator - Sprint 13: File-Based Agent Protocol
 * Sprint 14 Fix: Node-by-Node Processing (not phase-based)
 *
 * Orchestrates hands-free TDD automation by:
 * 1. (Optional) Generating project blueprint if no nodes exist
 * 2. For EACH node (respecting dependencies):
 *    a. Generate BDD spec
 *    b. Scaffold files
 *    c. Implement code
 *    d. Run tests
 *    e. Fix loop (up to 5 retries) with Golden Packet
 * 3. Move to next node only after current node passes or fails max retries
 */

import { Node, TestResult } from '../../shared/types';
import { FileNameGenerator } from '../../shared/utils/fileNameGenerator';
import { getWorkflowFolderName } from '../../shared/utils/stringUtils';
import { getNodeBasePath } from '../../shared/utils/nodePathUtils';
import { TaskFileManager, AgentResponse } from './TaskFileManager';
import { PromptService } from './PromptService';
import { PromptGenerationService } from './PromptGenerationService';
import { ScaffoldingService } from '../workflows/ScaffoldingService';
import { logger, logError } from '../../shared/utils/Logger';
import { isFolderNode } from '../../shared/types/typeGuards';
import { AgentNodeProcessor } from './AgentNodeProcessor';
import { AgentTaskWriter } from './AgentTaskWriter';

export type OrchestratorStatus = 'idle' | 'running' | 'paused' | 'completed' | 'error';
export type OrchestratorPhase = 'idle' | 'blueprint' | 'bdd' | 'scaffold' | 'generating' | 'testing' | 'fixing';

export interface FixAttempt {
    attemptNumber: number;
    approachDescription: string;
    timestamp: string;
}

export interface OrchestratorState {
    status: OrchestratorStatus;
    phase: OrchestratorPhase;
    currentNodeId: string | null;
    currentRetry: number;
    processedNodes: string[];
    failedNodes: string[];
    fixAttempts: FixAttempt[];
    message: string;
}

export interface OrchestratorCallbacks {
    onStatusChange?: (state: OrchestratorState) => void;
    onNodeComplete?: (nodeId: string, passed: boolean) => void;
    onTestResults?: (nodeId: string, results: TestResult[]) => void;
    onError?: (error: Error) => void;
    onBlueprintComplete?: () => void;
    onTaskWritten?: (taskFile: string, taskDescription: string) => void;
}

export class AgentOrchestrator {
    private readonly workspacePath: string;
    private readonly extensionPath: string;
    private readonly taskFileManager: TaskFileManager;
    private readonly scaffoldingService: ScaffoldingService;
    private nodeProcessor: AgentNodeProcessor;
    private taskWriter: AgentTaskWriter;

    private state: OrchestratorState;
    private callbacks: OrchestratorCallbacks = {};
    private maxRetries = 10;
    private projectContext = '';
    private lastAgentResponse: { approach?: string } | null = null;
    private testRunner: any = null;
    private featureMapStorage: any = null;

    constructor(workspacePath: string, extensionPath: string) {
        this.workspacePath = workspacePath;
        this.extensionPath = extensionPath;
        this.taskFileManager = new TaskFileManager(workspacePath);
        this.scaffoldingService = new ScaffoldingService();

        const promptService = new PromptService(extensionPath, workspacePath);
        const promptGenService = new PromptGenerationService(workspacePath, extensionPath);

        this.state = {
            status: 'idle',
            phase: 'idle',
            currentNodeId: null,
            currentRetry: 0,
            processedNodes: [],
            failedNodes: [],
            fixAttempts: [],
            message: 'Ready to start automation'
        };

        this.nodeProcessor = new AgentNodeProcessor({
            workspacePath,
            testRunner: null,
            scaffoldingService: this.scaffoldingService,
            callbacks: this.callbacks,
            maxRetries: this.maxRetries
        });

        this.taskWriter = new AgentTaskWriter({
            workspacePath,
            extensionPath,
            taskFileManager: this.taskFileManager,
            promptService,
            promptGenService,
            scaffoldingService: this.scaffoldingService,
            callbacks: this.callbacks,
            maxRetries: this.maxRetries
        });
    }

    public setDependencies(testRunner: any, featureMapStorage: any): void {
        this.testRunner = testRunner;
        this.featureMapStorage = featureMapStorage;
        this.nodeProcessor = new AgentNodeProcessor({
            workspacePath: this.workspacePath,
            testRunner: this.testRunner,
            scaffoldingService: this.scaffoldingService,
            callbacks: this.callbacks,
            maxRetries: this.maxRetries
        });
    }

    public setCallbacks(callbacks: OrchestratorCallbacks): void {
        this.callbacks = callbacks;
        this.nodeProcessor = new AgentNodeProcessor({
            workspacePath: this.workspacePath,
            testRunner: this.testRunner,
            scaffoldingService: this.scaffoldingService,
            callbacks: this.callbacks,
            maxRetries: this.maxRetries
        });
    }

    public setMaxRetries(maxRetries: number): void {
        this.maxRetries = maxRetries;
    }

    public getState(): OrchestratorState {
        return { ...this.state };
    }

    public isRunning(): boolean {
        return this.state.status === 'running';
    }

    public async startWithBlueprint(mode: 'idea' | 'architecture' | 'refactor', projectContext: string): Promise<void> {
        if (this.state.status === 'running') {
            logger.log('AGENT-ORCHESTRATOR', 'Automation already running');
            return;
        }

        logger.log('AGENT-ORCHESTRATOR', `Starting automation with blueprint generation (mode: ${mode})`);
        this.projectContext = projectContext;

        this.updateState({
            status: 'running',
            phase: 'blueprint',
            currentNodeId: null,
            currentRetry: 0,
            processedNodes: [],
            failedNodes: [],
            message: '📋 Generating project blueprint...'
        });

        try {
            await this.taskWriter.writeBlueprintTask(mode, projectContext);
            logger.log('AGENT-ORCHESTRATOR', 'Blueprint task written, waiting for agent...');
        } catch (error) {
            this.handleError(error as Error);
        }
    }

    public async start(allNodes: Node[], allEdges: any[]): Promise<void> {
        logger.log('AGENT-ORCHESTRATOR', `start() called - status: ${this.state.status}, phase: ${this.state.phase}, nodes: ${allNodes.length}`);

        if (this.state.status === 'running' && this.state.phase !== 'blueprint') {
            logger.log('AGENT-ORCHESTRATOR', 'Automation already running - skipping');
            return;
        }

        logger.log('AGENT-ORCHESTRATOR', `Starting node-by-node automation with ${allNodes.length} nodes`);

        this.updateState({
            status: 'running',
            phase: 'bdd',
            currentNodeId: null,
            currentRetry: 0,
            processedNodes: [],
            failedNodes: [],
            message: '🚀 Starting node-by-node automation...'
        });

        try {
            await this.processNextNode(allNodes, allEdges);
        } catch (error) {
            this.handleError(error as Error);
        }
    }

    public stop(): void {
        logger.log('AGENT-ORCHESTRATOR', 'Stopping automation');
        this.updateState({
            status: 'paused',
            message: 'Automation paused by user'
        });
    }

    public async resume(allNodes: Node[], allEdges: any[]): Promise<void> {
        if (this.state.status !== 'paused') {
            logger.log('AGENT-ORCHESTRATOR', 'Cannot resume - not paused');
            return;
        }

        logger.log('AGENT-ORCHESTRATOR', 'Resuming automation');
        this.updateState({
            status: 'running',
            message: 'Automation resumed'
        });

        try {
            await this.processNextNode(allNodes, allEdges);
        } catch (error) {
            this.handleError(error as Error);
        }
    }

    public async onAgentDone(allNodes: Node[], allEdges: any[]): Promise<void> {
        const response = this.taskFileManager.readAgentDone();
        if (!response) {
            logger.log('AGENT-ORCHESTRATOR', 'No valid agent response found');
            return;
        }

        this.lastAgentResponse = response;
        logger.log('AGENT-ORCHESTRATOR', `Agent response: ${response.status}${response.approach ? ` (approach: ${response.approach.substring(0, 50)}...)` : ''}`);

        const lastTask = this.taskFileManager.readLastTask();
        const wasBlueprint = lastTask?.includes('GENERATE_BLUEPRINT') || lastTask?.includes('Generate project blueprint');
        const wasBddGeneration = lastTask?.includes('GENERATE_BDD') || lastTask?.includes('Generate BDD');
        const wasGenerateTests = lastTask?.includes('GENERATE_TESTS') || lastTask?.includes('Generate Tests');
        const wasFix = lastTask?.includes('FIX') || lastTask?.includes('Fix the failing');

        const persistedState = this.taskFileManager.loadAutomationState();
        if (persistedState) {
            this.state.processedNodes = persistedState.processedNodes || [];
            this.state.failedNodes = persistedState.failedNodes || [];
            this.state.currentNodeId = persistedState.currentNodeId;
            this.state.currentRetry = persistedState.currentRetry || 0;
            if (persistedState.phase) {
                this.state.phase = persistedState.phase as OrchestratorPhase;
            }
        }

        if (!this.state.currentNodeId && !wasBlueprint) {
            const nodeTitle = this.taskFileManager.parseCurrentNodeId();
            if (nodeTitle) {
                const node = allNodes.find(n => n.title === nodeTitle);
                if (node) {
                    this.state.currentNodeId = node.id;
                }
            }
        }

        let currentPhase: OrchestratorPhase = this.state.phase;
        if (wasBlueprint) {currentPhase = 'blueprint';}
        else if (wasBddGeneration) {currentPhase = 'bdd';}
        else if (wasGenerateTests) {currentPhase = 'generating';}
        else if (wasFix) {currentPhase = 'fixing';}

        this.updateState({
            status: 'running',
            phase: currentPhase,
            message: 'Processing agent response...'
        });

        if (wasBlueprint) {
            await this.handleBlueprintDone(response);
            return;
        }

        if (response.status === 'STUCK') {
            this.nodeProcessor.handleAgentStuck(
                allNodes.find(n => n.id === this.state.currentNodeId),
                this.state,
                response.reason || 'Unknown'
            );
            this.persistState();
            await this.processNextNode(allNodes, allEdges);
            return;
        }

        const currentNode = allNodes.find(n => n.id === this.state.currentNodeId);
        if (!currentNode) {
            await this.processNextNode(allNodes, allEdges);
            return;
        }

        switch (currentPhase) {
            case 'bdd':
                await this.handleBddComplete(currentNode, allNodes, allEdges);
                break;
            case 'generating':
            case 'fixing':
                await this.handleTestGenerationCompleteAndRunTests(currentNode, allNodes, allEdges);
                break;
            default:
                await this.handleTestGenerationCompleteAndRunTests(currentNode, allNodes, allEdges);
        }
    }

    private async handleBlueprintDone(response: AgentResponse): Promise<void> {
        if (response.status === 'STUCK') {
            this.updateState({
                status: 'error',
                phase: 'idle',
                message: `Blueprint failed: ${response.reason || 'Unknown error'}`
            });
            return;
        }

        logger.log('AGENT-ORCHESTRATOR', 'Blueprint generation complete!');
        this.updateState({
            status: 'idle',
            phase: 'idle',
            message: '✅ Blueprint generated! Loading nodes for Plan generation...'
        });
        this.callbacks.onBlueprintComplete?.();
    }

    private async processNextNode(allNodes: Node[], allEdges: any[]): Promise<void> {
        if (this.state.status !== 'running') {return;}

        const nextNode = this.nodeProcessor.findNextPendingNode(allNodes, allEdges, this.state.processedNodes);

        if (!nextNode) {
            this.completeAutomation(allNodes);
            return;
        }

        logger.log('AGENT-ORCHESTRATOR', `Processing node: ${nextNode.title}`);
        this.state.fixAttempts = [];

        this.updateState({
            currentNodeId: nextNode.id,
            currentRetry: 0,
            phase: 'bdd',
            message: `📝 [${nextNode.title}] Step 1/4: Generating Plan...`
        });

        await this.taskWriter.writeTaskForNode(
            nextNode,
            'GENERATE_BDD',
            allNodes,
            allEdges,
            this.state.currentRetry,
            this.state.fixAttempts,
            this.nodeProcessor.buildDependencyWirings.bind(this.nodeProcessor),
            this.nodeProcessor.buildDependencyContextForBdd.bind(this.nodeProcessor),
            this.nodeProcessor.scaffoldFilesIfNeeded.bind(this.nodeProcessor)
        );
        this.persistState();
    }

    private async handleBddComplete(currentNode: Node, allNodes: Node[], allEdges: any[]): Promise<void> {
        logger.log('AGENT-ORCHESTRATOR', `BDD complete for: ${currentNode.title}`);

        const fileName = FileNameGenerator.getNodeFileName(currentNode as any);
        const workflowFolderName = getWorkflowFolderName(currentNode.workflowId);
        const basePath = getNodeBasePath(workflowFolderName, fileName);
        const bddSpec = this.taskWriter.readBddSpec(currentNode) || undefined;
        const dependencyWirings = this.nodeProcessor.buildDependencyWirings(currentNode, allNodes, allEdges);

        await this.nodeProcessor.scaffoldFilesIfNeeded(currentNode, fileName, basePath, dependencyWirings, bddSpec);

        this.updateState({
            phase: 'generating',
            message: `🔧 [${currentNode.title}] Step 2/4: Generating tests...`
        });

        await this.taskWriter.writeTaskForNode(
            currentNode,
            'GENERATE_TESTS',
            allNodes,
            allEdges,
            this.state.currentRetry,
            this.state.fixAttempts,
            this.nodeProcessor.buildDependencyWirings.bind(this.nodeProcessor),
            this.nodeProcessor.buildDependencyContextForBdd.bind(this.nodeProcessor),
            this.nodeProcessor.scaffoldFilesIfNeeded.bind(this.nodeProcessor)
        );
        this.persistState();
    }

    private async handleTestGenerationCompleteAndRunTests(currentNode: Node, allNodes: Node[], allEdges: any[]): Promise<void> {
        this.updateState({
            phase: 'testing',
            message: `🧪 [${currentNode.title}] Step 3/4: Running tests...`
        });

        const { results, allPassed } = await this.nodeProcessor.runTestsForNode(currentNode, allNodes, allEdges);

        if (allPassed) {
            this.nodeProcessor.handleTestsPassed(currentNode, this.state);
            this.persistState();
            this.updateState({ message: `✅ ${currentNode.title} - Tests passed!` });
            await this.processNextNode(allNodes, allEdges);
        } else {
            await this.handleTestsFailed(currentNode, results, allNodes, allEdges);
        }
    }

    private async handleTestsFailed(node: Node, results: TestResult[], allNodes: Node[], allEdges: any[]): Promise<void> {
        logger.log('AGENT-ORCHESTRATOR', `Tests failed for: ${node.title} (retry ${this.state.currentRetry + 1}/${this.maxRetries})`);

        this.nodeProcessor.recordFixAttempt(this.state, this.lastAgentResponse);

        if (this.nodeProcessor.isMaxRetriesExceeded(this.state.currentRetry)) {
            this.nodeProcessor.handleMaxRetriesExceeded(node, this.state);
            this.persistState();
            this.updateState({
                phase: 'idle',
                message: `❌ ${node.title} - Failed after ${this.maxRetries} retries`
            });
            await this.processNextNode(allNodes, allEdges);
        } else {
            this.state.currentRetry++;
            this.updateState({
                phase: 'fixing',
                currentRetry: this.state.currentRetry,
                message: `🔄 [${node.title}] Step 4/4: Fix attempt ${this.state.currentRetry}/${this.maxRetries}...`
            });

            (node as any).lastTestResults = results;
            await this.taskWriter.writeTaskForNode(
                node,
                'FIX',
                allNodes,
                allEdges,
                this.state.currentRetry,
                this.state.fixAttempts,
                this.nodeProcessor.buildDependencyWirings.bind(this.nodeProcessor),
                this.nodeProcessor.buildDependencyContextForBdd.bind(this.nodeProcessor),
                this.nodeProcessor.scaffoldFilesIfNeeded.bind(this.nodeProcessor)
            );
            this.persistState();
        }
    }

    private persistState(): void {
        this.taskFileManager.saveAutomationState({
            processedNodes: this.state.processedNodes,
            failedNodes: this.state.failedNodes,
            currentNodeId: this.state.currentNodeId,
            isRunning: this.state.status === 'running',
            phase: this.state.phase,
            currentRetry: this.state.currentRetry
        });
    }

    private completeAutomation(allNodes: Node[]): void {
        const total = allNodes.filter(n => !isFolderNode(n)).length;
        const passed = this.state.processedNodes.length - this.state.failedNodes.length;
        const failed = this.state.failedNodes.length;
        const summary = `Automation complete: ${passed}/${total} nodes passed, ${failed} failed`;

        logger.log('AGENT-ORCHESTRATOR', summary);
        this.taskWriter.writeComplete(summary);
        this.taskFileManager.clearAutomationState();

        this.updateState({
            status: 'completed',
            currentNodeId: null,
            message: summary
        });
    }

    private handleError(error: Error): void {
        logError('AGENT-ORCHESTRATOR', 'Automation error', error);
        this.updateState({
            status: 'error',
            message: `Error: ${error.message}`
        });
        this.callbacks.onError?.(error);
    }

    private updateState(updates: Partial<OrchestratorState>): void {
        this.state = { ...this.state, ...updates };
        this.callbacks.onStatusChange?.(this.getState());
    }

    public getAgentDoneWatchPattern(): string {
        return this.taskFileManager.getAgentDoneFilePath();
    }
}
