/**
 * AgentNodeProcessor - Handles node processing logic for AgentOrchestrator
 *
 * Extracted from AgentOrchestrator to comply with CLAUDE.md file size limits
 * Manages: Node finding, test execution, pass/fail handling, retry logic
 */

import { Node, TestResult } from '../../shared/types';
import { toPascalCase, getWorkflowFolderName } from '../../shared/utils/stringUtils';
import { FileNameGenerator } from '../../shared/utils/fileNameGenerator';
import { getTestFilePath, getFeatureFilePath } from '../../shared/utils/nodePathUtils';
import { logger, logError } from '../../shared/utils/Logger';
import { isFolderNode } from '../../shared/types/typeGuards';
import { GoldenPacketAssembler } from './GoldenPacketAssembler';
import { OrchestratorState, OrchestratorCallbacks, FixAttempt } from './AgentOrchestrator';
import { ScaffoldingService, DependencyWiring } from '../workflows/ScaffoldingService';

export interface NodeProcessorDeps {
    workspacePath: string;
    testRunner: any;
    scaffoldingService: ScaffoldingService;
    callbacks: OrchestratorCallbacks;
    maxRetries: number;
}

export interface ProcessingResult {
    success: boolean;
    nextPhase?: string;
    error?: Error;
}

export class AgentNodeProcessor {
    constructor(private deps: NodeProcessorDeps) {}

    /**
     * Find next node that needs processing (respects dependencies)
     */
    findNextPendingNode(
        allNodes: Node[],
        allEdges: any[],
        processedNodes: string[]
    ): Node | null {
        const featureNodes = allNodes.filter(n => !isFolderNode(n));

        for (const node of featureNodes) {
            if (processedNodes.includes(node.id)) {
                continue;
            }

            if ((node as any).status === 'passed') {
                continue;
            }

            const dependencies = this.getNodeDependencies(node, allEdges);
            const allDepsSatisfied = dependencies.length === 0 || dependencies.every(depId => {
                const depNode = allNodes.find(n => n.id === depId);
                return depNode && (
                    (depNode as any).status === 'passed' ||
                    processedNodes.includes(depId)
                );
            });

            if (allDepsSatisfied) {
                logger.log('AGENT-ORCHESTRATOR', `  - ${node.title}: ready for processing (deps satisfied)`);
                return node;
            }
        }
        return null;
    }

    /**
     * Get dependency node IDs for a node
     */
    getNodeDependencies(node: Node, allEdges: any[]): string[] {
        return allEdges
            .filter(e => e.target === node.id)
            .map(e => e.source);
    }

    /**
     * Run tests for a node and return results
     */
    async runTestsForNode(
        currentNode: Node,
        allNodes: Node[],
        allEdges: any[]
    ): Promise<{ results: TestResult[]; allPassed: boolean }> {
        if (!this.deps.testRunner) {
            logger.log('AGENT-ORCHESTRATOR', 'No test runner available');
            return { results: [], allPassed: false };
        }

        try {
            const results = await this.deps.testRunner.runNodeTests(currentNode, '');
            const allPassed = results.length > 0 && results.every((r: TestResult) => r.passed);

            (currentNode as any).lastTestResults = results;

            if (results.length > 0) {
                try {
                    await GoldenPacketAssembler.assembleAndSave(
                        currentNode,
                        results,
                        this.deps.workspacePath,
                        allNodes,
                        allEdges
                    );
                    logger.log('AGENT-ORCHESTRATOR', `Trace files and golden packet saved for node: ${currentNode.title}`);
                } catch (traceError) {
                    logError('AGENT-ORCHESTRATOR', 'Failed to save trace files (non-fatal)', traceError);
                }
            }

            this.deps.callbacks.onTestResults?.(currentNode.id, results);

            return { results, allPassed };
        } catch (error) {
            logError('AGENT-ORCHESTRATOR', 'Test execution failed', error);
            return { results: [], allPassed: false };
        }
    }

    /**
     * Handle tests passing - mark node as complete
     */
    handleTestsPassed(
        node: Node,
        state: OrchestratorState
    ): void {
        logger.log('AGENT-ORCHESTRATOR', `Tests passed for: ${node.title}`);

        state.processedNodes.push(node.id);
        state.fixAttempts = [];

        this.deps.callbacks.onNodeComplete?.(node.id, true);
    }

    /**
     * Check if max retries exceeded
     */
    isMaxRetriesExceeded(currentRetry: number): boolean {
        return currentRetry >= this.deps.maxRetries;
    }

    /**
     * Handle max retries exceeded
     */
    handleMaxRetriesExceeded(
        node: Node,
        state: OrchestratorState
    ): void {
        logger.log('AGENT-ORCHESTRATOR', `Max retries exceeded for: ${node.title}`);

        state.failedNodes.push(node.id);
        state.processedNodes.push(node.id);
        state.fixAttempts = [];

        this.deps.callbacks.onNodeComplete?.(node.id, false);
    }

    /**
     * Record a fix attempt
     */
    recordFixAttempt(
        state: OrchestratorState,
        lastAgentResponse: { approach?: string } | null
    ): void {
        if (state.currentRetry > 0 && lastAgentResponse?.approach) {
            state.fixAttempts.push({
                attemptNumber: state.currentRetry,
                approachDescription: lastAgentResponse.approach,
                timestamp: new Date().toISOString()
            });
            logger.log('AGENT-ORCHESTRATOR', `Saved fix attempt ${state.currentRetry}: ${lastAgentResponse.approach.substring(0, 50)}...`);
        }
    }

    /**
     * Handle agent stuck scenario
     */
    handleAgentStuck(
        currentNode: Node | undefined,
        state: OrchestratorState,
        reason: string
    ): void {
        const nodeName = currentNode?.title || 'Unknown';
        logger.log('AGENT-ORCHESTRATOR', `Agent stuck on: ${nodeName} - ${reason}`);

        if (currentNode) {
            state.failedNodes.push(currentNode.id);
            state.processedNodes.push(currentNode.id);
            this.deps.callbacks.onNodeComplete?.(currentNode.id, false);
        }
    }

    /**
     * Build dependency wirings for a node
     */
    buildDependencyWirings(node: Node, allNodes: Node[], allEdges: any[]): DependencyWiring[] {
        const dependencies = this.getNodeDependencies(node, allEdges);

        return dependencies.map(depId => {
            let targetWorkflowId: string | undefined;
            let targetNodeId: string;

            if (depId.includes('/')) {
                const [workflow, nodeIdPart] = depId.split('/');
                targetWorkflowId = workflow;
                targetNodeId = nodeIdPart;
            } else {
                targetNodeId = depId;
            }

            const depNode = allNodes.find(n =>
                n.id === targetNodeId &&
                (!targetWorkflowId || n.workflowId === targetWorkflowId)
            );
            if (!depNode) {return null;}

            const depFileName = FileNameGenerator.getNodeFileName(depNode as any);
            const depWorkflowFolder = getWorkflowFolderName(depNode.workflowId);
            const depTestFilePath = getTestFilePath(depWorkflowFolder, depFileName);

            return {
                inputName: depNode.title,
                functionName: `perform${toPascalCase(depFileName)}Action`,
                filePath: depTestFilePath,
                nodeId: depId
            };
        }).filter((w): w is DependencyWiring => w !== null);
    }

    /**
     * Build dependency context for BDD generation
     */
    buildDependencyContextForBdd(node: Node, allNodes: Node[], allEdges: any[]): Array<{
        name: string;
        description: string;
        bddSpecFile?: string;
    }> {
        const dependencies = this.getNodeDependencies(node, allEdges);
        const result: Array<{ name: string; description: string; bddSpecFile?: string }> = [];

        for (const depId of dependencies) {
            let targetWorkflowId: string | undefined;
            let targetNodeId: string;

            if (depId.includes('/')) {
                const [workflow, nodeIdPart] = depId.split('/');
                targetWorkflowId = workflow;
                targetNodeId = nodeIdPart;
            } else {
                targetNodeId = depId;
            }

            const depNode = allNodes.find(n =>
                n.id === targetNodeId &&
                (!targetWorkflowId || n.workflowId === targetWorkflowId)
            );
            if (!depNode) {continue;}

            let bddSpecFile = (depNode as any).bddSpecFile;
            if (!bddSpecFile) {
                const fileName = FileNameGenerator.getNodeFileName(depNode as any);
                const workflowFolderName = getWorkflowFolderName(depNode.workflowId);
                bddSpecFile = getFeatureFilePath(workflowFolderName, fileName);
            }

            result.push({
                name: depNode.title,
                description: depNode.description || depNode.title,
                bddSpecFile
            });
        }

        return result;
    }

    /**
     * Scaffold files if needed
     */
    async scaffoldFilesIfNeeded(
        node: Node,
        fileName: string,
        basePath: string,
        dependencyWirings: DependencyWiring[],
        bddSpec?: string
    ): Promise<void> {
        const created = this.deps.scaffoldingService.scaffoldImplementationFilesIfNeeded(
            this.deps.workspacePath,
            basePath,
            fileName,
            dependencyWirings,
            bddSpec
        );

        if (created.actionFile) {
            logger.log('AGENT-ORCHESTRATOR', `Scaffolded action file: ${basePath}/${fileName}.action.js`);
        }
        if (created.testFile) {
            logger.log('AGENT-ORCHESTRATOR', `Scaffolded test file: ${basePath}/${fileName}.test.js`);
        }

        (node as any).testCodeFile = `${basePath}/${fileName}.test.js`;
        (node as any).actionFile = `${basePath}/${fileName}.action.js`;
    }
}
