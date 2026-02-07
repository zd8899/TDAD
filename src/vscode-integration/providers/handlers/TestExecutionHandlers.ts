/**
 * TestExecutionHandlers - Handles test execution and results
 *
 * Extracted from TestWorkflowHandlers to comply with CLAUDE.md file size limits
 * Manages: Test running, results caching, golden packet assembly, context files
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { execSync } from 'child_process';
import { Node, TestResult } from '../../../shared/types';
import { logCanvas, logError, logger } from '../../../shared/utils/Logger';
import { FileNameGenerator } from '../../../shared/utils/fileNameGenerator';
import { getWorkflowFolderName } from '../../../shared/utils/stringUtils';
import { getTestFilePath, getAbsolutePath } from '../../../shared/utils/nodePathUtils';
import { FeatureMapStorage } from '../../../infrastructure/storage/FeatureMapStorage';
import { SimpleNodeManager } from '../SimpleNodeManager';
import { TestFileParser } from '../../../core/testing/TestFileParser';
import { TestOrchestrator } from '../../testing/TestOrchestrator';
import { GoldenPacketAssembler } from '../../../core/services/GoldenPacketAssembler';
import { selectFilesRelative } from '../../utils/fileDialogUtils';

export class TestExecutionHandlers {
    constructor(
        private readonly webview: vscode.Webview,
        private readonly storage: FeatureMapStorage,
        private readonly nodeManager: SimpleNodeManager,
        private readonly context: vscode.ExtensionContext,
        private readonly testOrchestrator: TestOrchestrator,
        private readonly testResultsCache: Map<string, TestResult[]>
    ) {}

    /**
     * Assign unique IDs to tests that don't have them
     */
    assignTestIds(): void {
        try {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const extensionPath = this.context.extensionPath;
            const scriptPath = path.join(extensionPath, 'scripts', 'assign-test-ids.js');

            try {
                fsSync.accessSync(scriptPath);
            } catch {
                return;
            }

            execSync(`node "${scriptPath}"`, {
                cwd: workspaceRoot,
                stdio: 'pipe'
            });
            logger.debug('CANVAS', 'Test IDs assigned');
        } catch (error) {
            logger.debug('CANVAS', `Test ID assignment skipped: ${error}`);
        }
    }

    /**
     * Load test details from existing test file
     */
    async handleLoadTestDetails(nodeId: string, testFilePath: string): Promise<void> {
        try {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const fullPath = path.join(workspaceRoot, testFilePath);

            try {
                const testCode = await fs.readFile(fullPath, 'utf-8');
                let testDetails = TestFileParser.parsePlaywrightTestDetails(testCode);

                const cachedResults = this.testResultsCache.get(nodeId);
                let persistedResults: Array<{ testTitle: string; passed: boolean; error?: string; actualResult?: any }> | null = null;

                if (!cachedResults || cachedResults.length === 0) {
                    persistedResults = this.loadTestResultsFromFile(nodeId, testFilePath);
                }

                if ((cachedResults && cachedResults.length > 0) || (persistedResults && persistedResults.length > 0)) {
                    const resultMap = new Map<string, { passed: boolean; actualResult?: any }>();

                    if (cachedResults && cachedResults.length > 0) {
                        cachedResults.forEach(r => {
                            resultMap.set(r.test?.title || '', { passed: r.passed, actualResult: r.actualResult });
                        });
                        logger.debug('CANVAS', `Using ${cachedResults.length} in-memory cached results`);
                    } else if (persistedResults) {
                        persistedResults.forEach(r => {
                            resultMap.set(r.testTitle, { passed: r.passed, actualResult: r.actualResult });
                        });
                        logger.debug('CANVAS', `Using ${persistedResults.length} persisted results from file`);
                    }

                    testDetails = testDetails.map(detail => {
                        const result = resultMap.get(detail.title);
                        if (result) {
                            return {
                                ...detail,
                                status: result.passed ? 'passed' : 'failed',
                                actualResult: result.actualResult !== undefined
                                    ? (typeof result.actualResult === 'object'
                                        ? JSON.stringify(result.actualResult, null, 2)
                                        : String(result.actualResult))
                                    : undefined
                            };
                        }
                        return detail;
                    });
                }

                if (testDetails.length > 0) {
                    this.webview.postMessage({
                        command: 'testDetailsLoaded',
                        nodeId,
                        testDetails
                    });
                    logger.debug('CANVAS', `Test details loaded: ${testFilePath} (${testDetails.length} tests)`);
                }
            } catch (readError: any) {
                if (readError.code !== 'ENOENT') {
                    logError('CANVAS', 'Failed to read test file for details', readError);
                }
            }
        } catch (error) {
            logError('CANVAS', 'Failed to load test details', error);
        }
    }

    /**
     * Run Tests
     */
    async handleRunTests(nodeFromWebview: Node): Promise<void> {
        try {
            logCanvas('Running tests for node:', nodeFromWebview.id);

            const node = this.nodeManager.getNodeById(nodeFromWebview.id);
            if (!node) {
                vscode.window.showWarningMessage('Node not found. Please refresh the canvas.');
                return;
            }

            let testFilePath = (node as any).testCodeFile;

            if (!testFilePath) {
                const fileNode = node as any;
                if (fileNode.fileName && fileNode.workflowId) {
                    const workspaceRoot = this.storage.getWorkspaceRoot();
                    const workflowFolderName = getWorkflowFolderName(fileNode.workflowId.replace('.workflow.json', ''));
                    const expectedPath = getTestFilePath(workflowFolderName, fileNode.fileName);
                    const fullPath = getAbsolutePath(workspaceRoot, expectedPath);

                    if (fsSync.existsSync(fullPath)) {
                        testFilePath = expectedPath;
                        (node as any).testCodeFile = expectedPath;
                        this.nodeManager.updateNode(node);
                        this.nodeManager.saveNow();
                        logCanvas(`Auto-detected and saved testCodeFile: ${expectedPath}`);
                    }
                }
            }

            if (!testFilePath) {
                vscode.window.showWarningMessage('No test file found for this node. Generate test code first.');
                return;
            }

            vscode.window.showInformationMessage(`🧪 Running tests for: ${node.title}`);

            const allNodes = this.nodeManager.getNodes();
            const testResults = await this.runTestsAndSaveTraces(node, allNodes);

            const passedCount = testResults.filter(r => r.passed).length;
            const totalCount = testResults.length;

            if (totalCount === 0) {
                (node as any).status = 'pending';
                vscode.window.showWarningMessage(`⚠️ No tests found for "${node.title}". Check test file and Playwright configuration.`);
            } else if (testResults.every(r => r.passed)) {
                (node as any).status = 'passed';
                // Update file status fields when tests pass (real content confirmed)
                (node as any).testHasRealContent = true;
                vscode.window.showInformationMessage(`✅ All tests passed for "${node.title}" (${passedCount}/${totalCount})`);
            } else {
                (node as any).status = 'failed';
                // Update file status fields when tests fail (real content confirmed)
                (node as any).testHasRealContent = true;
                vscode.window.showWarningMessage(`❌ Some tests failed for "${node.title}" (${passedCount}/${totalCount} passed)`);
            }

            this.nodeManager.updateNode(node);
            this.nodeManager.saveNow();

            this.webview.postMessage({
                command: 'testResultsUpdated',
                nodeId: node.id,
                testResults,
                passed: totalCount > 0 && testResults.every(r => r.passed)
            });

            logCanvas('Test execution completed. Results:', { passed: passedCount, total: totalCount });
        } catch (error) {
            logError('CANVAS', 'Failed to run tests', error);
            vscode.window.showErrorMessage(`Failed to run tests: ${error}`);

            this.webview.postMessage({
                command: 'testError',
                nodeId: nodeFromWebview.id,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /**
     * Unified test execution method - Single Source of Truth
     */
    async runTestsAndSaveTraces(node: Node, allNodes: Node[]): Promise<TestResult[]> {
        this.assignTestIds();

        const testResults = await this.testOrchestrator.runNodeWithDependencies(node, allNodes, '');

        this.testResultsCache.set(node.id, testResults);

        if (testResults.length > 0) {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
                try {
                    const allWorkflowNodes = this.nodeManager.getAllNodes();
                    const allEdges = this.nodeManager.getEdges();
                    await GoldenPacketAssembler.assembleAndSave(
                        node,
                        testResults,
                        workspaceFolder.uri.fsPath,
                        allWorkflowNodes,
                        allEdges
                    );
                    logCanvas(`Trace files and golden packet saved for node: ${node.title}`);
                } catch (error) {
                    logError('CANVAS', 'Failed to save trace files (non-fatal)', error);
                }

                this.saveTestResultsToFile(node, testResults, workspaceFolder.uri.fsPath);
            }
        }

        return testResults;
    }

    /**
     * Save test results for persistence across sessions
     */
    saveTestResultsToFile(node: Node, testResults: TestResult[], workspacePath: string): void {
        try {
            const fileName = FileNameGenerator.getNodeFileName(node as any);
            const workflowFolderName = getWorkflowFolderName(node.workflowId);
            const resultsDir = path.join(
                workspacePath,
                '.tdad', 'test-results', workflowFolderName, fileName
            );

            if (!fsSync.existsSync(resultsDir)) {
                fsSync.mkdirSync(resultsDir, { recursive: true });
            }

            const resultsPath = path.join(resultsDir, 'results.json');

            const serializable = testResults.map(r => ({
                testTitle: r.test?.title || 'Unknown',
                passed: r.passed,
                error: r.error,
                actualResult: r.actualResult,
                timestamp: new Date().toISOString()
            }));

            fsSync.writeFileSync(resultsPath, JSON.stringify(serializable, null, 2), 'utf-8');
            logger.debug('CANVAS', `Saved test results to: ${resultsPath}`);
        } catch (error) {
            logError('CANVAS', 'Failed to save test results to file (non-fatal)', error);
        }
    }

    /**
     * Load test results from test-results folder
     */
    loadTestResultsFromFile(nodeId: string, testFilePath: string): Array<{ testTitle: string; passed: boolean; error?: string; actualResult?: any }> | null {
        try {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const match = testFilePath.match(/\.tdad\/workflows\/([^/]+)\/([^/]+)\//);
            if (!match) {
                return null;
            }

            const [, workflowFolder, nodeFolder] = match;
            const resultsPath = path.join(
                workspaceRoot,
                '.tdad', 'test-results', workflowFolder, nodeFolder, 'results.json'
            );

            if (!fsSync.existsSync(resultsPath)) {
                return null;
            }

            const content = fsSync.readFileSync(resultsPath, 'utf-8');
            const results = JSON.parse(content);

            if (Array.isArray(results) && results.length > 0) {
                logger.debug('CANVAS', `Loaded ${results.length} test results from file for node: ${nodeId}`);
                return results;
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Select context files for context-aware AI code generation
     */
    async handleSelectContextFiles(nodeId: string): Promise<void> {
        try {
            const workspaceRoot = this.storage.getWorkspaceRoot();

            const node = this.nodeManager.getNodeById(nodeId);
            if (!node) {
                throw new Error('Node not found');
            }

            const currentContextFiles = [...(node.contextFiles || [])];

            const relativePaths = await selectFilesRelative(workspaceRoot, {
                title: 'Select Context Files',
                many: true,
                filters: {
                    'All Files': ['*'],
                    'Documentation': ['md', 'txt', 'pdf', 'doc', 'docx'],
                    'Code': ['ts', 'js', 'tsx', 'jsx', 'json', 'yaml', 'yml']
                }
            });

            if (!relativePaths) {
                return;
            }

            const newFiles = relativePaths.filter(newPath =>
                !currentContextFiles.includes(newPath)
            );

            if (newFiles.length === 0) {
                vscode.window.showInformationMessage('All selected files are already added');
                return;
            }

            const updatedNode = {
                ...node,
                contextFiles: [...currentContextFiles, ...newFiles]
            };

            this.nodeManager.updateNode(updatedNode);

            this.webview.postMessage({
                command: 'contextFilesAdded',
                nodeId: nodeId,
                contextFiles: updatedNode.contextFiles,
                newFiles: newFiles
            });

            this.webview.postMessage({
                command: 'nodeUpdated',
                node: updatedNode
            });

            vscode.window.showInformationMessage(
                `✅ Added ${newFiles.length} context file${newFiles.length > 1 ? 's' : ''} to "${node.title}"`
            );

            logCanvas('Context files added to node:', { nodeId, newFiles, totalFiles: updatedNode.contextFiles });
        } catch (error) {
            logError('CANVAS', 'Failed to select context files', error);
            vscode.window.showErrorMessage(`Failed to select context files: ${error}`);
        }
    }

    /**
     * Cancel the currently running test (kills the child process)
     */
    cancelCurrentTest(): void {
        this.testOrchestrator.cancelCurrentTest();
    }

    /**
     * Assemble and copy golden packet
     */
    async handleCopyGoldenPacket(nodeId: string): Promise<void> {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showWarningMessage('No workspace folder open');
                return;
            }

            const node = this.nodeManager.getNodeById(nodeId);
            if (!node) {
                throw new Error('Node not found');
            }

            const testResults = this.testResultsCache.get(nodeId) || [];

            if (testResults.length === 0) {
                vscode.window.showWarningMessage('No test results found. Run tests first before copying context.');
                return;
            }

            const allNodes = this.nodeManager.getAllNodes();
            const allEdges = this.nodeManager.getEdges();
            const goldenPacket = await GoldenPacketAssembler.assembleAndSave(
                node,
                testResults,
                workspaceFolder.uri.fsPath,
                allNodes,
                allEdges
            );

            await vscode.env.clipboard.writeText(goldenPacket);

            vscode.window.showInformationMessage('✅ Golden Packet copied! Paste into your AI coding tool (Cursor, Claude Code, etc.)');

            logCanvas('Golden packet copied for node:', nodeId);
        } catch (error) {
            logError('CANVAS', 'Failed to copy golden packet', error);
            vscode.window.showErrorMessage('Failed to copy golden packet');
        }
    }
}
