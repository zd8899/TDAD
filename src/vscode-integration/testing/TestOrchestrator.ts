/**
 * TestOrchestrator - Test Execution with Dependencies
 *
 * Orchestrates test execution for nodes with dependencies
 * Ensures prerequisite tests run first
 */

import { Node, TestResult } from '../../shared/types';
import { logger, logError } from '../../shared/utils/Logger';
import { getNodeInputs } from '../../shared/utils/nodeHelpers';
import { ITestRunner } from '../../core/testing/ITestRunner';

export interface TestExecutionPlan {
    nodeId: string;
    dependencies: string[]; // Node IDs that must run first
}

export class TestOrchestrator {
    private testRunner: ITestRunner;
    private executionHistory: Set<string> = new Set(); // Track which nodes ran in this session

    constructor(testRunner: ITestRunner) {
        this.testRunner = testRunner;
    }

    /**
     * Run tests for a node, automatically running dependencies first
     * @param node The node to test
     * @param allNodes All nodes in the workflow (needed to resolve dependencies)
     * @param generatedCode The generated test code for the node
     * @returns Test results for the requested node
     */
    public async runNodeWithDependencies(
        node: Node,
        allNodes: Node[],
        generatedCode: string
    ): Promise<TestResult[]> {
        logger.log('TEST_ORCHESTRATOR', `Running tests for node ${node.id}`);

        // Run the target node's tests directly (no dependency execution)
        logger.log('TEST_ORCHESTRATOR', `Running tests for target node ${node.id}`);

        const results = await this.testRunner.runNodeTests(node, generatedCode, {});

        // Track execution
        const allPassed = results.every(r => r.passed);
        if (allPassed) {
            this.executionHistory.add(node.id);
        }

        return results;
    }

    /**
     * Resolve which nodes must run before this node based on input dependencies
     * @param node The node to analyze
     * @param allNodes All nodes in the workflow
     * @returns Array of node IDs that must run first (in execution order)
     */
    public resolveInputDependencies(node: Node, allNodes: Node[]): string[] {
        const dependencies: string[] = [];
        const visited = new Set<string>();

        const resolveNode = (currentNodeId: string): void => {
            if (visited.has(currentNodeId)) {
                return; // Already processed or circular dependency
            }
            visited.add(currentNodeId);

            const currentNode = allNodes.find(n => n.id === currentNodeId);
            if (!currentNode) {
                return;
            }

            // Use explicit dependencies array (Global Dependency System)
            if (currentNode.dependencies && currentNode.dependencies.length > 0) {
                for (const depNodeId of currentNode.dependencies) {
                    // Recursively resolve dependencies
                    resolveNode(depNodeId);

                    // Add to list if not already there
                    if (!dependencies.includes(depNodeId)) {
                        dependencies.push(depNodeId);
                    }
                }
            }

            // Legacy Support (Input/Output System)
            // Get inputs for file and function nodes
            const inputs = getNodeInputs(currentNode);

            // Find inputs that depend on other nodes
            for (const input of inputs) {
                if (input.source.type === 'node' && input.source.nodeId) {
                    const depNodeId = input.source.nodeId;

                    // Recursively resolve dependencies
                    resolveNode(depNodeId);

                    // Add to list if not already there
                    if (!dependencies.includes(depNodeId)) {
                        dependencies.push(depNodeId);
                    }
                }
            }
        };

        resolveNode(node.id);

        logger.log('TEST_ORCHESTRATOR', `Resolved ${dependencies.length} dependencies for node ${node.id}: [${dependencies.join(', ')}]`);
        return dependencies;
    }

    /**
     * Run a chain of tests in dependency order
     * Useful for running all tests in a workflow
     */
    public async runTestChain(nodeIds: string[], allNodes: Node[]): Promise<Map<string, TestResult[]>> {
        const results = new Map<string, TestResult[]>();
        this.executionHistory.clear();

        for (const nodeId of nodeIds) {
            const node = allNodes.find(n => n.id === nodeId);
            if (!node) {
                logger.log('TEST_ORCHESTRATOR', `Warning: Node ${nodeId} not found in workflow`);
                continue;
            }

            try {
                const nodeResults = await this.runNodeWithDependencies(node, allNodes, '');
                results.set(nodeId, nodeResults);
            } catch (error) {
                logError('TEST_ORCHESTRATOR', `Failed to run tests for node ${nodeId}`, error);
                results.set(nodeId, []);
                break; // Stop chain on error
            }
        }

        return results;
    }

    /**
     * Clear execution history (useful for fresh test runs)
     */
    public clearHistory(): void {
        this.executionHistory.clear();
        logger.log('TEST_ORCHESTRATOR', 'Cleared execution history');
    }

    /**
     * Check if a node has been executed in this session
     */
    public hasExecuted(nodeId: string): boolean {
        return this.executionHistory.has(nodeId);
    }

    /**
     * Cancel the currently running test (kills the child process)
     */
    public cancelCurrentTest(): void {
        this.testRunner.cancelCurrentTest();
    }
}
