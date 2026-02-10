import * as path from 'path';
import { Node, TestResult, AutopilotModes } from '../../shared/types';
import { toPascalCase, getWorkflowFolderName } from '../../shared/utils/stringUtils';
import { FileNameGenerator } from '../../shared/utils/fileNameGenerator';
import { getNodeBasePath, getTestFilePath } from '../../shared/utils/nodePathUtils';
import { TaskFileManager, TaskContext, AgentResponse } from './TaskFileManager';
import { ScaffoldingService, DependencyWiring } from '../workflows/ScaffoldingService';
import { logger, logError } from '../../shared/utils/Logger';
import { PromptGenerationService } from './PromptGenerationService';
import { FixAttemptInfo } from './GoldenPacketAssembler';

/**
 * SingleNodeOrchestrator - Single-Node Automation
 *
 * Automates the full TDD cycle for a SINGLE selected node:
 * 1. Generate BDD spec (always regenerate)
 * 2. Scaffold files (.action.js, .test.js)
 * 3. Generate tests
 * 4. Run test → fix loop (max 5 retries)
 */

export type SingleNodeStatus = 'idle' | 'running' | 'completed' | 'failed' | 'stopped';
export type SingleNodePhase = 'idle' | 'bdd' | 'scaffold' | 'generating' | 'testing' | 'fixing';
export type AutopilotMode = 'bdd' | 'test' | 'run-fix';
export type { AutopilotModes };

export interface SingleNodeState {
    status: SingleNodeStatus;
    phase: SingleNodePhase;
    nodeId: string | null;
    nodeTitle: string | null;
    currentRetry: number;
    maxRetries: number;
    message: string;
}

export interface SingleNodeCallbacks {
    onStatusChange?: (state: SingleNodeState) => void;
    onComplete?: (nodeId: string, passed: boolean) => void;
    onTestResults?: (nodeId: string, results: TestResult[]) => void;
    onError?: (error: Error) => void;
    onTaskWritten?: (taskFile: string, taskDescription: string) => void;
}

export class SingleNodeOrchestrator {
    private readonly workspacePath: string;
    private readonly isolatedNodeId: string | undefined;
    private readonly taskFileManager: TaskFileManager;
    private readonly promptGenService: PromptGenerationService;
    private readonly scaffoldingService: ScaffoldingService;

    private state: SingleNodeState;
    private callbacks: SingleNodeCallbacks = {};
    private maxRetries = 10;

    // The single node being automated
    private targetNode: Node | null = null;
    private allNodes: Node[] = [];
    private allEdges: any[] = [];

    // Fix attempt tracking
    private fixAttempts: FixAttemptInfo[] = [];
    private lastAgentResponse: AgentResponse | null = null;

    // Automation modes (which phases to run)
    private automationModes: AutopilotModes = ['bdd', 'test', 'run-fix'];

    // External dependencies (injected)
    private testRunner: any = null;

    constructor(workspacePath: string, extensionPath: string, nodeId?: string) {
        this.workspacePath = workspacePath;
        this.isolatedNodeId = nodeId;
        this.taskFileManager = new TaskFileManager(workspacePath, nodeId);
        this.promptGenService = new PromptGenerationService(workspacePath, extensionPath);
        this.scaffoldingService = new ScaffoldingService();

        this.state = {
            status: 'idle',
            phase: 'idle',
            nodeId: null,
            nodeTitle: null,
            currentRetry: 0,
            maxRetries: this.maxRetries,
            message: 'Ready'
        };
    }

    /**
     * Set test runner dependency
     */
    public setTestRunner(testRunner: any): void {
        this.testRunner = testRunner;
    }

    /**
     * Set callbacks for status updates
     */
    public setCallbacks(callbacks: SingleNodeCallbacks): void {
        this.callbacks = callbacks;
    }

    /**
     * Get current state
     */
    public getState(): SingleNodeState {
        return { ...this.state };
    }

    /**
     * Check if automation is running
     */
    public isRunning(): boolean {
        return this.state.status === 'running';
    }

    /**
     * Start single-node automation
     * @param modes - Array of phases to run: 'bdd', 'test', 'run-fix'
     */
    public async startSingleNode(node: Node, allNodes: Node[], allEdges: any[], modes: AutopilotModes = ['bdd', 'test', 'run-fix']): Promise<void> {
        if (this.state.status === 'running') {
            logger.log('SINGLE-NODE-ORCHESTRATOR', 'Automation already running');
            return;
        }

        logger.log('SINGLE-NODE-ORCHESTRATOR', `Starting automation for node: ${node.title}`);
        logger.log('SINGLE-NODE-ORCHESTRATOR', `Received modes: [${modes.join(', ')}] (length: ${modes.length})`);

        this.targetNode = node;
        this.allNodes = allNodes;
        this.allEdges = allEdges;
        this.automationModes = modes;

        logger.log('SINGLE-NODE-ORCHESTRATOR', `Set automationModes to: [${this.automationModes.join(', ')}]`);

        // Reset fix attempt tracking for new automation
        this.fixAttempts = [];
        this.lastAgentResponse = null;

        // Note: Node-specific cleanup (screenshots, trace files) is handled by TestRunner
        // before each test run. No global debug directory cleanup needed here.

        // Calculate phase count based on selected modes
        let phaseCount = 0;
        if (modes.includes('bdd')) {phaseCount += 1;}
        if (modes.includes('test')) {phaseCount += 2;} // scaffold + generating
        if (modes.includes('run-fix')) {phaseCount += 1;}

        // Determine starting phase
        const startPhase = modes.includes('bdd') ? 'bdd' : modes.includes('test') ? 'scaffold' : 'testing';

        this.updateState({
            status: 'running',
            phase: startPhase,
            nodeId: node.id,
            nodeTitle: node.title,
            currentRetry: 0,
            message: `Phase 1/${phaseCount}: Starting automation for ${node.title}...`
        });

        try {
            if (modes.includes('bdd')) {
                await this.writeBddTask();
            } else if (modes.includes('test')) {
                // Skip BDD, go directly to scaffold
                await this.scaffoldFiles();
                this.updateState({ phase: 'generating', message: `Generating tests for ${node.title}...` });
                await this.writeTestGenerationTask();
            } else if (modes.includes('run-fix')) {
                // Skip BDD and test generation, go directly to running tests
                this.updateState({ phase: 'testing', message: `Running tests for ${node.title}...` });
                await this.runTestsAndDecide();
            }
        } catch (error) {
            this.handleError(error as Error);
        }
    }

    /**
     * Stop automation
     */
    public stop(): void {
        logger.log('SINGLE-NODE-ORCHESTRATOR', 'Stopping automation');

        if (this.testRunner && typeof this.testRunner.cancelCurrentTest === 'function') {
            try {
                this.testRunner.cancelCurrentTest();
            } catch (error) {
                logError('SINGLE-NODE-ORCHESTRATOR', 'Failed to cancel current test on stop', error);
            }
        }

        this.updateState({
            status: 'stopped',
            message: 'Automation stopped by user'
        });
    }

    /**
     * Handle agent completion signal (called by file watcher)
     */
    public async onAgentDone(): Promise<void> {
        if (this.state.status !== 'running') {
            logger.log('SINGLE-NODE-ORCHESTRATOR', 'Not running - ignoring agent response');
            return;
        }

        const response = this.taskFileManager.readAgentDone();
        if (!response) {
            logger.log('SINGLE-NODE-ORCHESTRATOR', 'No valid agent response found');
            return;
        }

        // Store response for fix attempt tracking
        this.lastAgentResponse = response;

        logger.log('SINGLE-NODE-ORCHESTRATOR', `Agent response: ${response.status}${response.approach ? ` (approach: ${response.approach.substring(0, 50)}...)` : ''}${response.reason ? ` - ${response.reason}` : ''}`);

        if (response.status === 'STUCK') {
            await this.handleAgentStuck(response.reason || 'Unknown reason');
            return;
        }

        // Handle based on current phase
        try {
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Processing phase: ${this.state.phase}`);
            switch (this.state.phase) {
                case 'bdd':
                    await this.handleBddComplete();
                    break;
                case 'generating':
                    await this.handleTestGenerationComplete();
                    break;
                case 'fixing':
                    await this.handleFixComplete();
                    break;
                default:
                    logger.log('SINGLE-NODE-ORCHESTRATOR', `Unexpected phase: ${this.state.phase}`);
            }
        } catch (error) {
            logError('SINGLE-NODE-ORCHESTRATOR', `Error handling phase ${this.state.phase}`, error);
            this.handleError(error as Error);
        }
    }

    /**
     * Write BDD generation task
     * Matches the full context from manual handleCopyBddPrompt
     * Sprint 14 Fix: Create feature file scaffold BEFORE writing task (like manual flow)
     */
    private async writeBddTask(): Promise<void> {
        if (!this.targetNode) {return;}

        const node = this.targetNode;
        const fileName = this.getFileName(node);
        const workflowFolderName = getWorkflowFolderName(node.workflowId);
        // Use path.sep for Windows compatibility (matches manual handler)
        const basePath = `.tdad${path.sep}workflows${path.sep}${workflowFolderName}${path.sep}${fileName}`;
        const featureFilePath = `${basePath}${path.sep}${fileName}.feature`;

        // Sprint 17: Use consolidated scaffolding method from ScaffoldingService (no duplicate code)
        const createdPath = this.scaffoldingService.scaffoldFeatureFileIfNeeded(
            this.workspacePath,
            basePath,
            fileName,
            node.title || fileName,
            node.description || ''
        );
        if (createdPath) {
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Created feature file scaffold: ${featureFilePath}`);
            (node as any).bddSpecFile = featureFilePath;
        } else {
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Feature file already exists: ${featureFilePath}`);
        }

        const goal = `Generate BDD (Gherkin) specification for the "${node.title}" feature.`;

        // ═══════════════════════════════════════════════════════════════════════
        // Use PromptGenerationService - Single Source of Truth
        // ═══════════════════════════════════════════════════════════════════════
        const { prompt: context } = await this.promptGenService.generateBddPrompt({
            node,
            featureDescription: node.description || node.title,
            allNodes: this.allNodes,
            edges: this.allEdges
        });

        const taskContext: TaskContext = {
            status: 'GENERATE_BDD',
            node,
            workflowName: workflowFolderName,
            retryCount: 0,
            maxRetries: this.maxRetries,
            goal,
            context
        };

        this.taskFileManager.writeNextTask(taskContext);

        this.updateState({
            message: `Waiting for agent to generate plan for ${node.title}...`
        });

        this.callbacks.onTaskWritten?.(this.getTaskFilePath(), `GENERATE_BDD: ${node.title}`);
    }

    /**
     * Handle BDD generation complete - move to scaffold phase
     */
    private async handleBddComplete(): Promise<void> {
        if (!this.targetNode) {return;}

        logger.log('SINGLE-NODE-ORCHESTRATOR', `BDD complete for: ${this.targetNode.title}`);
        logger.log('SINGLE-NODE-ORCHESTRATOR', `Current automationModes: [${this.automationModes.join(', ')}]`);

        // Check if we should continue to test generation
        const shouldGenerateTests = this.automationModes.includes('test');
        const shouldRunTests = this.automationModes.includes('run-fix');

        logger.log('SINGLE-NODE-ORCHESTRATOR', `shouldGenerateTests: ${shouldGenerateTests}, shouldRunTests: ${shouldRunTests}`);

        if (!shouldGenerateTests && !shouldRunTests) {
            // Only BDD was selected, complete now
            logger.log('SINGLE-NODE-ORCHESTRATOR', `BDD-only mode - completing automation`);
            this.completeAutomation(true, 'Plan generated successfully');
            return;
        }

        try {
            this.updateState({
                phase: 'scaffold',
                message: `Scaffolding files for ${this.targetNode.title}...`
            });

            // Scaffold is sync - no agent needed
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Starting scaffold phase...`);
            await this.scaffoldFiles();
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Scaffold phase complete`);

            if (shouldGenerateTests) {
                // Move to test generation phase
                this.updateState({
                    phase: 'generating',
                    message: `Generating tests for ${this.targetNode.title}...`
                });

                logger.log('SINGLE-NODE-ORCHESTRATOR', `Starting test generation phase...`);
                await this.writeTestGenerationTask();
                logger.log('SINGLE-NODE-ORCHESTRATOR', `Test generation task written, debug file should exist`);
            } else if (shouldRunTests) {
                // Skip test generation, go directly to running tests
                this.updateState({
                    phase: 'testing',
                    message: `Running tests for ${this.targetNode.title}...`
                });
                await this.runTestsAndDecide();
            }
        } catch (error) {
            logError('SINGLE-NODE-ORCHESTRATOR', 'Error in handleBddComplete', error);
            this.handleError(error as Error);
        }
    }

    /**
     * Scaffold action and test files
     * Sprint 17: Use consolidated scaffolding method from ScaffoldingService (no duplicate code)
     */
    private async scaffoldFiles(): Promise<void> {
        if (!this.targetNode) {return;}

        const node = this.targetNode;
        const fileName = this.getFileName(node);
        const workflowFolderName = getWorkflowFolderName(node.workflowId);
        // Use path.sep for Windows compatibility
        const basePath = `.tdad${path.sep}workflows${path.sep}${workflowFolderName}${path.sep}${fileName}`;

        // Build dependency wirings
        const dependencyWirings = this.buildDependencyWirings(node);

        // Read BDD spec
        const bddSpec = await this.promptGenService.readBddSpec(node);

        // Sprint 17: Use consolidated scaffolding method from ScaffoldingService
        const created = this.scaffoldingService.scaffoldImplementationFilesIfNeeded(
            this.workspacePath,
            basePath,
            fileName,
            dependencyWirings,
            bddSpec || undefined
        );

        if (created.actionFile) {
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Scaffolded: ${basePath}/${fileName}.action.js`);
        } else {
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Action file already exists, preserving: ${basePath}/${fileName}.action.js`);
        }

        if (created.testFile) {
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Scaffolded: ${basePath}/${fileName}.test.js`);
        } else {
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Test file already exists, preserving: ${basePath}/${fileName}.test.js`);
        }

        // Update node with file paths
        (node as any).testCodeFile = `${basePath}/${fileName}.test.js`;
        (node as any).actionFile = `${basePath}/${fileName}.action.js`;
    }

    /**
     * Write test generation task
     */
    private async writeTestGenerationTask(): Promise<void> {
        if (!this.targetNode) {return;}

        const node = this.targetNode;
        const workflowFolderName = getWorkflowFolderName(node.workflowId);

        logger.log('SINGLE-NODE-ORCHESTRATOR', `writeTestGenerationTask started for: ${node.title}`);

        // Read BDD spec from file
        const bddSpec = await this.promptGenService.readBddSpec(node) || 'No BDD spec available';
        logger.log('SINGLE-NODE-ORCHESTRATOR', `BDD spec loaded, length: ${bddSpec.length} chars`);

        // ═══════════════════════════════════════════════════════════════════════
        // Use PromptGenerationService - Single Source of Truth
        // ═══════════════════════════════════════════════════════════════════════
        logger.log('SINGLE-NODE-ORCHESTRATOR', `Generating test generation prompt...`);
        const { prompt: context, promptFilePath } = await this.promptGenService.generateImplementPrompt({
            node,
            gherkinSpec: bddSpec,
            allNodes: this.allNodes,
            edges: this.allEdges
        });

        logger.log('SINGLE-NODE-ORCHESTRATOR', `Test generation prompt saved to: ${promptFilePath} (${context.length} chars)`);

        const taskContext: TaskContext = {
            status: 'GENERATE_TESTS',
            node,
            workflowName: workflowFolderName,
            retryCount: 0,
            maxRetries: this.maxRetries,
            goal: `Generate test code for the "${node.title}" feature according to the BDD specification.`,
            context,
            bddSpec
        };

        this.taskFileManager.writeNextTask(taskContext);

        this.updateState({
            message: `Waiting for agent to generate tests for ${node.title}...`
        });

        this.callbacks.onTaskWritten?.(this.getTaskFilePath(), `GENERATE_TESTS: ${node.title}`);
    }

    /**
     * Handle test generation complete - run tests
     */
    private async handleTestGenerationComplete(): Promise<void> {
        if (!this.targetNode) {return;}

        logger.log('SINGLE-NODE-ORCHESTRATOR', `Test generation complete for: ${this.targetNode.title}`);

        // Check if we should run tests
        const shouldRunTests = this.automationModes.includes('run-fix');

        if (!shouldRunTests) {
            // Test generation only, complete now
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Test-only mode - completing automation (tests generated, not run)`);
            this.completeAutomation(true, 'Tests generated successfully');
            return;
        }

        try {
            this.updateState({
                phase: 'testing',
                message: `Running tests for ${this.targetNode.title}...`
            });

            await this.runTestsAndDecide();
        } catch (error) {
            logError('SINGLE-NODE-ORCHESTRATOR', 'Error in handleTestGenerationComplete', error);
            this.handleError(error as Error);
        }
    }

    /**
     * Run tests and decide next action
     */
    private async runTestsAndDecide(): Promise<void> {
        if (!this.targetNode || !this.testRunner) {
            logger.log('SINGLE-NODE-ORCHESTRATOR', 'No target node or test runner');
            this.completeAutomation(false, 'No test runner available');
            return;
        }

        try {
            const results = await this.testRunner.runNodeTests(this.targetNode, '');
            const allPassed = results.length > 0 && results.every((r: TestResult) => r.passed);

            // Store results on node for Golden Packet
            (this.targetNode as any).lastTestResults = results;

            // Always publish latest test results, even if stop was requested mid-run.
            this.callbacks.onTestResults?.(this.targetNode.id, results);

            // Check if automation was stopped while tests were running
            if (this.state.status !== 'running') {
                logger.log('SINGLE-NODE-ORCHESTRATOR', 'Automation stopped during test execution, aborting');
                return;
            }

            if (allPassed) {
                logger.log('SINGLE-NODE-ORCHESTRATOR', `Tests PASSED for: ${this.targetNode.title}`);
                this.completeAutomation(true, 'All tests passed!');
            } else {
                logger.log('SINGLE-NODE-ORCHESTRATOR', `Tests FAILED for: ${this.targetNode.title} (retry ${this.state.currentRetry + 1}/${this.maxRetries})`);
                await this.handleTestsFailed(results);
            }
        } catch (error) {
            logError('SINGLE-NODE-ORCHESTRATOR', 'Test execution failed', error);
            await this.handleTestsFailed([]);
        }
    }

    /**
     * Handle tests failing - retry with fix task
     * Captures the previous fix approach (if any) before writing new task
     */
    private async handleTestsFailed(results: TestResult[]): Promise<void> {
        if (!this.targetNode) {return;}

        // If we have a previous fix attempt with approach info, record it
        // Note: We check currentRetry > 0 because retry 1 means we already did one fix attempt
        // We also check lastAgentResponse?.approach which contains the detailed fix description
        if (this.state.currentRetry > 0 && this.lastAgentResponse?.approach) {
            this.fixAttempts.push({
                attemptNumber: this.state.currentRetry,
                approachDescription: this.lastAgentResponse.approach,
                timestamp: new Date().toISOString()
            });
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Recorded fix attempt ${this.state.currentRetry}: ${this.lastAgentResponse.approach.substring(0, 50)}...`);
        }

        if (this.state.currentRetry >= this.maxRetries) {
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Max retries exceeded for: ${this.targetNode.title}`);
            this.completeAutomation(false, `Failed after ${this.maxRetries} fix attempts`);
            return;
        }

        // Increment retry count
        const newRetry = this.state.currentRetry + 1;

        this.updateState({
            phase: 'fixing',
            currentRetry: newRetry,
            message: `Fix attempt ${newRetry}/${this.maxRetries} for ${this.targetNode.title}...`
        });

        await this.writeFixTask(results);
    }

    /**
     * Write fix task with Golden Packet
     * Includes previous fix attempts so AI can try different approaches
     */
    private async writeFixTask(results: TestResult[]): Promise<void> {
        if (!this.targetNode) {return;}

        const node = this.targetNode;
        const workflowFolderName = getWorkflowFolderName(node.workflowId);

        logger.log('SINGLE-NODE-ORCHESTRATOR', `writeFixTask started for: ${node.title} (attempt ${this.state.currentRetry})`);

        // Read BDD spec from file
        const bddSpec = await this.promptGenService.readBddSpec(node) || undefined;

        // FIX tasks don't need implementation patterns - golden packet has all debugging context
        // ═══════════════════════════════════════════════════════════════════════
        // Use PromptGenerationService - Single Source of Truth for Golden Packet
        // ═══════════════════════════════════════════════════════════════════════
        let errorContext: string | undefined;
        const testResults = (node as any).lastTestResults || results;
        logger.log('SINGLE-NODE-ORCHESTRATOR', `Generating fix prompt with ${testResults.length} test results...`);
        if (testResults.length > 0) {
            const { prompt, promptFilePath } = await this.promptGenService.generateFixPrompt({
                node,
                testResults,
                allNodes: this.allNodes,
                edges: this.allEdges,
                previousAttempts: this.fixAttempts.length > 0 ? this.fixAttempts : undefined,
                retryCount: this.state.currentRetry
            });
            errorContext = prompt;
            logger.log('SINGLE-NODE-ORCHESTRATOR', `Fix prompt saved to: ${promptFilePath} (${prompt.length} chars)`);
        } else {
            logger.log('SINGLE-NODE-ORCHESTRATOR', `No test results available for fix prompt`);
        }

        const taskContext: TaskContext = {
            status: 'FIX',
            node,
            workflowName: workflowFolderName,
            retryCount: this.state.currentRetry,
            maxRetries: this.maxRetries,
            goal: `Fix the failing tests for "${node.title}". Use the error context below to identify and fix the issue.`,
            context: '',  // FIX tasks don't need implementation patterns
            bddSpec,
            errorContext
        };

        this.taskFileManager.writeNextTask(taskContext);

        this.updateState({
            message: `Waiting for agent to fix ${node.title} (attempt ${this.state.currentRetry}/${this.maxRetries})...`
        });

        this.callbacks.onTaskWritten?.(this.getTaskFilePath(), `FIX: ${node.title} (${this.state.currentRetry}/${this.maxRetries})`);
    }

    /**
     * Handle fix complete - run tests again
     */
    private async handleFixComplete(): Promise<void> {
        if (!this.targetNode) {return;}

        logger.log('SINGLE-NODE-ORCHESTRATOR', `Fix complete for: ${this.targetNode.title}, running tests...`);

        try {
            this.updateState({
                phase: 'testing',
                message: `Testing after fix ${this.state.currentRetry}/${this.maxRetries}...`
            });

            await this.runTestsAndDecide();
        } catch (error) {
            logError('SINGLE-NODE-ORCHESTRATOR', 'Error in handleFixComplete', error);
            this.handleError(error as Error);
        }
    }

    /**
     * Handle agent getting stuck
     */
    private async handleAgentStuck(reason: string): Promise<void> {
        logger.log('SINGLE-NODE-ORCHESTRATOR', `Agent stuck: ${reason}`);
        this.completeAutomation(false, `Agent stuck: ${reason}`);
    }

    /**
     * Complete automation
     */
    private completeAutomation(passed: boolean, message: string): void {
        const nodeId = this.state.nodeId;
        const nodeTitle = this.state.nodeTitle || 'Unknown';

        logger.log('SINGLE-NODE-ORCHESTRATOR', `Automation complete: ${nodeTitle} - ${passed ? 'PASSED' : 'FAILED'} - ${message}`);

        this.updateState({
            status: passed ? 'completed' : 'failed',
            phase: 'idle',
            message: `${passed ? '✅' : '❌'} ${nodeTitle}: ${message}`
        });

        // Write appropriate status to NEXT_TASK.md
        if (passed) {
            this.taskFileManager.writeComplete(`Node "${nodeTitle}" passed all tests.`);
        } else {
            // Write FAILED status so agent knows not to continue
            this.taskFileManager.writeFailed(
                nodeTitle,
                message,
                this.state.currentRetry,
                this.maxRetries
            );
        }

        if (nodeId) {
            this.callbacks.onComplete?.(nodeId, passed);
        }
    }

    /**
     * Handle errors
     */
    private handleError(error: Error): void {
        logError('SINGLE-NODE-ORCHESTRATOR', 'Automation error', error);

        this.updateState({
            status: 'failed',
            phase: 'idle',
            message: `Error: ${error.message}`
        });

        this.callbacks.onError?.(error);
    }

    /**
     * Update state and notify callbacks
     */
    private updateState(updates: Partial<SingleNodeState>): void {
        this.state = { ...this.state, ...updates };
        this.callbacks.onStatusChange?.(this.getState());
    }

    // --- Helper Methods ---

    /** Get the relative task file path (per-node or legacy) */
    private getTaskFilePath(): string {
        if (this.isolatedNodeId) {
            return `.tdad${path.sep}tasks${path.sep}${this.isolatedNodeId}${path.sep}NEXT_TASK.md`;
        }
        return `.tdad${path.sep}NEXT_TASK.md`;
    }

    private getFileName(node: Node): string {
        return FileNameGenerator.getNodeFileName(node as any);
    }

    private getNodeDependencies(node: Node): string[] {
        return this.allEdges
            .filter(e => e.target === node.id)
            .map(e => e.source);
    }

    private buildDependencyWirings(node: Node): DependencyWiring[] {
        const dependencies = this.getNodeDependencies(node);

        return dependencies.map(depId => {
            const depNode = this.allNodes.find(n => n.id === depId);
            if (!depNode) {return null;}

            const depFileName = this.getFileName(depNode);
            const depWorkflowFolder = getWorkflowFolderName(depNode.workflowId);
            // Use path.sep for Windows compatibility
            const depTestFilePath = `.tdad${path.sep}workflows${path.sep}${depWorkflowFolder}${path.sep}${depFileName}${path.sep}${depFileName}.test.js`;

            return {
                inputName: depNode.title,
                functionName: `perform${toPascalCase(depFileName)}Action`,
                filePath: depTestFilePath,
                nodeId: depId
            };
        }).filter((w): w is DependencyWiring => w !== null);
    }

    /**
     * Get the file watcher pattern for AGENT_DONE.md
     */
    public getAgentDoneWatchPattern(): string {
        return this.taskFileManager.getAgentDoneFilePath();
    }
}
