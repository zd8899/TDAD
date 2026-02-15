import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Node, TestResult } from '../../shared/types';
import { logTestRunner, logError } from '../../shared/utils/Logger';
import { getWorkflowFolderName } from '../../shared/utils/stringUtils';
import { getTestFilePath, getAbsolutePath } from '../../shared/utils/nodePathUtils';
import { TestFileParser } from '../../core/testing/TestFileParser';
import { getNodeFeatures } from '../../shared/types/typeGuards';
import { CoverageParser } from '../../core/testing/CoverageParser';
import { ITestRunner, TestRunOptions } from '../../core/testing/ITestRunner';
import { FileNameGenerator } from '../../shared/utils/fileNameGenerator';
import { TestProcessManager } from './TestProcessManager';
import {
    ensurePlaywrightPrerequisites,
    clearNodeDebugArtifacts,
    assignTestIds,
    buildPlaywrightCommand,
    buildBatchPlaywrightCommand
} from './PlaywrightEnvironment';
import {
    TestExecutionResult,
    createCanceledExecutionResult,
    extractPlaywrightJson,
    extractSpecsFromSuites,
    parsePlaywrightError,
    buildSyntheticErrorResult,
    logTestResult
} from './PlaywrightResultParser';

export { TestExecutionResult } from './PlaywrightResultParser';

export class TestRunner implements ITestRunner {
    private outputChannel: vscode.OutputChannel;
    private terminal: vscode.Terminal | undefined;
    private processManager: TestProcessManager;

    /** When true, only one test process runs at a time (queue via promise chain) */
    static sequentialMode = false;
    private static testQueue: Promise<void> = Promise.resolve();

    /** Monotonic cancellation token; incrementing cancels queued/in-flight runs with older tokens */
    private static cancellationVersion = 0;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('TDAD Tests');
        this.processManager = new TestProcessManager(this.outputChannel);
    }

    async runNodeTests(node: Node, generatedCode: string, options?: TestRunOptions): Promise<TestResult[]> {
        const runToken = TestRunner.cancellationVersion;
        if (TestRunner.sequentialMode) {
            return this.runNodeTestsQueued(node, generatedCode, options, runToken);
        }
        return this.runNodeTestsInternal(node, generatedCode, options, runToken);
    }

    private runNodeTestsQueued(node: Node, generatedCode: string, options: TestRunOptions | undefined, runToken: number): Promise<TestResult[]> {
        let resolve: (results: TestResult[]) => void;
        const resultPromise = new Promise<TestResult[]>(r => { resolve = r; });

        // Keep queue alive even if a prior queued run failed.
        TestRunner.testQueue = TestRunner.testQueue
            .catch(error => {
                logError('TEST-RUNNER', 'Recovered queued test chain after failure', error);
            })
            .then(async () => {
                if (this.isCancellationRequested(runToken)) {
                    this.outputChannel.appendLine('Cancelled queued test before start.');
                    resolve!([]);
                    return;
                }

                try {
                    const results = await this.runNodeTestsInternal(node, generatedCode, options, runToken);
                    resolve!(results);
                } catch (error) {
                    logError('TEST-RUNNER', 'Queued test execution failed', error);
                    resolve!([]);
                }
            });

        return resultPromise;
    }

    private async runNodeTestsInternal(node: Node, generatedCode: string, options: TestRunOptions | undefined, runToken: number): Promise<TestResult[]> {
        const startTime = Date.now();
        this.processManager.cancelRequested = false;
        const opts: TestRunOptions = {
            timeout: undefined,
            framework: 'playwright',
            silent: options?.silent || false
        };

        if (this.isCancellationRequested(runToken)) {
            return [];
        }

        if (!opts.silent) {
            this.outputChannel.clear();
            this.outputChannel.show();
        }

        if (this.isCancellationRequested(runToken)) {
            this.outputChannel.appendLine('Test run cancelled before execution started.');
            return [];
        }

        this.outputChannel.appendLine(`${'='.repeat(60)}`);
        this.outputChannel.appendLine(`Running tests for node: ${node.title}`);
        this.outputChannel.appendLine(`Timeout: disabled | Framework: Playwright`);
        this.outputChannel.appendLine(`${'='.repeat(60)}\n`);

        // Look for automated test file (should exist if code was generated properly)
        const automatedTestFilePath = await this.findAutomatedTestFile(node);

        let results: TestResult[];

        if (automatedTestFilePath) {
            this.outputChannel.appendLine(`📁 Test file: ${automatedTestFilePath}\n`);

            try {
                const executionResult = await this.runPlaywrightTestsForNode(automatedTestFilePath, node, runToken);
                results = executionResult.results;

                // Log detailed execution info
                this.outputChannel.appendLine(`\n${'─'.repeat(60)}`);
                this.outputChannel.appendLine(`⏱️  Duration: ${executionResult.duration}ms`);
                this.outputChannel.appendLine(`🔢 Exit code: ${executionResult.exitCode}`);

                if (executionResult.timedOut) {
                    this.outputChannel.appendLine(`⚠️  WARNING: Tests timed out after ${opts.timeout}ms`);
                    vscode.window.showWarningMessage(`Tests timed out for "${node.title}" after ${opts.timeout}ms`);
                }

                if (executionResult.stderr) {
                    this.outputChannel.appendLine(`\n❌ STDERR:\n${executionResult.stderr}`);
                }

            } catch (error) {
                if (this.isCancellationRequested(runToken)) {
                    this.outputChannel.appendLine('\nTest run cancelled during execution.');
                    results = [];
                } else {
                    this.outputChannel.appendLine(`\n❌ Test execution error: ${error instanceof Error ? error.message : String(error)}`);
                    logError('TEST-RUNNER', 'Test execution failed', error);

                    // Return failed results for all tests
                    results = [];
                    for (const feature of getNodeFeatures(node)) {
                        for (const test of (feature as any).tests || []) {
                            results.push({
                                test,
                                passed: false,
                                error: `Test execution failed: ${error instanceof Error ? error.message : String(error)}`
                            });
                        }
                    }
                }
            }
        } else {
            this.outputChannel.appendLine(`❌ No automated test file found. Generate code first to create automated tests.`);
            results = [];
            if (!this.isCancellationRequested(runToken)) {
                vscode.window.showWarningMessage('No automated tests found. Please generate code first to create automated test files.');
            }
        }

        // Display summary
        const passedCount = results.filter(r => r.passed).length;
        const totalCount = results.length;
        const passRate = totalCount > 0 ? (passedCount / totalCount * 100).toFixed(1) : '0';
        const duration = Date.now() - startTime;
        if (this.isCancellationRequested(runToken)) {
            return [];
        }

        this.outputChannel.appendLine(`\n${'='.repeat(60)}`);
        this.outputChannel.appendLine(`📊 SUMMARY:`);
        this.outputChannel.appendLine(`   ${passedCount}/${totalCount} tests passed (${passRate}%)`);
        this.outputChannel.appendLine(`   Total duration: ${duration}ms`);
        this.outputChannel.appendLine(`${'='.repeat(60)}`);

        logTestRunner('Test execution completed', {
            nodeId: node.id,
            nodeTitle: node.title,
            passed: passedCount,
            total: totalCount,
            duration
        });

        return results;
    }

    private async findAutomatedTestFile(node: Node): Promise<string | null> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return null;
        }

        const workflowFolderName = getWorkflowFolderName(node.workflowId);
        const fileName = FileNameGenerator.getNodeFileName(node);
        const testFilePath = getAbsolutePath(workspaceFolder.uri.fsPath, getTestFilePath(workflowFolderName, fileName));

        if (fs.existsSync(testFilePath)) {
            return testFilePath;
        }

        // Fallback: check stored path for backwards compatibility
        if ((node as any).testCodeFile) {
            const storedPath = path.join(workspaceFolder.uri.fsPath, (node as any).testCodeFile);
            if (fs.existsSync(storedPath)) {
                return storedPath;
            }
        }

        return null;
    }

    /**
     * Run Playwright tests for a single node
     */
    private async runPlaywrightTestsForNode(testFilePath: string, node: Node, runToken: number): Promise<TestExecutionResult> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder found');
        }

        const workspacePath = workspaceFolder.uri.fsPath;
        const startTime = Date.now();

        if (this.isCancellationRequested(runToken)) {
            return createCanceledExecutionResult(0);
        }

        this.outputChannel.appendLine(`🔧 Using test framework: playwright\n`);

        // Diagnostic logger captures output for AI context on failures
        const diagnosticLines: string[] = [];
        const logDiagnostic = (line: string) => {
            diagnosticLines.push(line);
            this.outputChannel.appendLine(line);
        };
        const diagnosticSink = { appendLine: logDiagnostic };

        try {
            // Pre-flight setup
            ensurePlaywrightPrerequisites(workspacePath, diagnosticSink);
            clearNodeDebugArtifacts(node, workspacePath, diagnosticSink);
            assignTestIds(testFilePath, workspacePath, diagnosticSink);

            // Build and execute command
            const command = buildPlaywrightCommand(testFilePath, workspacePath);
            const relativeTestPath = path.relative(workspacePath, testFilePath).replace(/\\/g, '/');
            logDiagnostic(`🔍 Command: ${command}`);
            logDiagnostic(`🔍 Working directory: ${workspacePath}`);
            logDiagnostic(`🔍 Test file path: ${testFilePath}`);
            logDiagnostic(`🔍 Relative test path: ${relativeTestPath}`);
            logDiagnostic(`🔍 TDAD config: .tdad/playwright.config.js`);

            const execResult = await this.processManager.executeCommandWithTimeout(command, workspacePath);

            if (this.isCancellationRequested(runToken) || this.processManager.cancelRequested) {
                return createCanceledExecutionResult(Date.now() - startTime);
            }

            logDiagnostic(`\n📤 STDOUT length: ${execResult.stdout.length} bytes`);
            logDiagnostic(`📤 STDERR length: ${execResult.stderr.length} bytes`);
            logDiagnostic(`📤 Exit code: ${execResult.exitCode}`);
            logDiagnostic(`📤 Timed out: ${execResult.timedOut}`);

            if (execResult.exitCode !== 0) {
                logDiagnostic(`\n⚠️ Playwright exited with non-zero code. This is expected for failing tests.`);
            }

            // Parse JSON output
            let jsonResult;
            try {
                jsonResult = extractPlaywrightJson(execResult.stdout);
            } catch (parseError) {
                if (this.isCancellationRequested(runToken) || this.processManager.cancelRequested) {
                    return createCanceledExecutionResult(Date.now() - startTime);
                }
                logDiagnostic(`\n❌ Failed to parse Playwright JSON output`);
                logDiagnostic(`Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
                logDiagnostic(`Output length: ${execResult.stdout.length} characters`);
                logDiagnostic(`First 500 chars: ${execResult.stdout.substring(0, 500)}`);
                logDiagnostic(`Last 500 chars: ${execResult.stdout.substring(Math.max(0, execResult.stdout.length - 500))}`);

                if (execResult.stderr) {
                    logDiagnostic(`\n❌ STDERR:\n${execResult.stderr}`);
                }

                const fullDiagnosticOutput = diagnosticLines.join('\n');
                logDiagnostic(`\n📤 Returning synthetic error result with full diagnostic output`);

                return buildSyntheticErrorResult(
                    node.id,
                    'playwright-startup-error',
                    'Playwright Startup Error',
                    'Playwright failed to start - check configuration',
                    `Playwright failed to start. This is usually a configuration or syntax error.\n\n--- FULL TEST OUTPUT ---\n${fullDiagnosticOutput}`,
                    fullDiagnosticOutput,
                    execResult,
                    Date.now() - startTime
                );
            }

            // Check for Playwright-level load errors
            const playwrightErrors = jsonResult.errors || [];
            if (playwrightErrors.length > 0 && (!jsonResult.suites || jsonResult.suites.length === 0)) {
                const errorMessages = playwrightErrors.map((e: any) => e.message || e.stack || String(e)).join('\n\n');
                logDiagnostic(`\n❌ Playwright encountered ${playwrightErrors.length} error(s) before tests could run`);
                logDiagnostic(`\n${errorMessages}`);
                const fullDiagnosticOutput = diagnosticLines.join('\n');

                return buildSyntheticErrorResult(
                    node.id,
                    'playwright-load-error',
                    'Test File Load Error',
                    'Tests could not be loaded - check imports and dependencies',
                    `Tests failed to load. Check imports and module paths.\n\n--- ERRORS ---\n${errorMessages}\n\n--- FULL DIAGNOSTIC OUTPUT ---\n${fullDiagnosticOutput}`,
                    `${errorMessages}\n\n${fullDiagnosticOutput}`,
                    execResult,
                    Date.now() - startTime
                );
            }

            // Build results from Playwright output
            const topLevelSuites = jsonResult.suites || [];
            const specs = extractSpecsFromSuites(topLevelSuites);
            const tests = specs.flatMap((spec: any) => spec.tests || []);

            this.outputChannel.appendLine(`\n📊 Playwright returned ${tests.length} test results`);

            const parsedTests = TestFileParser.parseTestFile(testFilePath, node.id);
            const parsedFeatures = parsedTests?.features || [];
            const features = parsedFeatures.length > 0 ? parsedFeatures : getNodeFeatures(node);

            if (parsedFeatures.length > 0) {
                this.outputChannel.appendLine(`✅ Using test definitions from test file (${parsedFeatures.length} features)`);
            } else {
                this.outputChannel.appendLine(`⚠️  Using test definitions from node (fallback)`);
            }

            const results = this.buildTestResults(specs, tests, features, node);

            if (this.isCancellationRequested(runToken)) {
                return createCanceledExecutionResult(Date.now() - startTime);
            }

            // Coverage (single-node only - batch skips this to avoid memory issues)
            this.parseCoverageAndAttachToResults(results, workspacePath, true);

            if (!CoverageParser.hasCoverage(path.join(workspacePath, '.tdad', 'coverage'))) {
                this.outputChannel.appendLine(`\n⚠️  No coverage data found.`);
                this.outputChannel.appendLine(`   Note: Coverage should be automatically collected if tests were generated with TDAD.`);
                this.outputChannel.appendLine(`   If you wrote tests manually, add coverage hooks to your test file.`);
            }

            // Server-not-running diagnostic
            const allFailedWithPageTimeout = results.length > 0 && results.every(r => {
                return !r.passed && r.fullError && (
                    r.fullError.includes('page.goto') ||
                    r.fullError.includes('page.fill') ||
                    r.fullError.includes('waiting for locator')
                );
            });

            if (allFailedWithPageTimeout) {
                this.outputChannel.appendLine(`\n⚠️  ⚠️  ⚠️  DIAGNOSTIC: All tests failed waiting for page elements`);
                this.outputChannel.appendLine(`🔍 This usually means:`);
                this.outputChannel.appendLine(`   1. Your dev server is not running`);
                this.outputChannel.appendLine(`   2. Check TDAD test URLs in Settings and any overrides in .tdad/playwright.user.js`);
                this.outputChannel.appendLine(`   3. Start your servers or update URLs via TDAD Settings\n`);
            }

            return {
                results,
                duration: Date.now() - startTime,
                stdout: execResult.stdout,
                stderr: execResult.stderr,
                exitCode: execResult.exitCode,
                timedOut: execResult.timedOut
            };
        } catch (error) {
            const duration = Date.now() - startTime;
            if (this.isCancellationRequested(runToken)) {
                return createCanceledExecutionResult(duration);
            }
            this.outputChannel.appendLine(`\n❌ Playwright execution failed: ${error}`);

            const results: TestResult[] = [];
            for (const feature of getNodeFeatures(node)) {
                for (const test of (feature as any).tests || []) {
                    results.push({
                        test,
                        passed: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }

            return {
                results,
                duration,
                stdout: error instanceof Error ? error.message : String(error),
                stderr: '',
                exitCode: 1,
                timedOut: false
            };
        }
    }

    /**
     * Match Playwright test results with node feature definitions and build TestResult[]
     */
    private buildTestResults(specs: any[], tests: any[], features: any[], node: Node): TestResult[] {
        const results: TestResult[] = [];

        if (features.length === 0 || features.every(f => !f.tests || f.tests.length === 0)) {
            // No features/tests defined in node - create results directly from Playwright tests
            this.outputChannel.appendLine(`⚠️  No test definitions in node - using Playwright test names`);

            for (let i = 0; i < tests.length; i++) {
                const playwrightTest = tests[i];
                const spec = specs.find(s => s.tests?.includes(playwrightTest));
                const passed = playwrightTest?.results?.[0]?.status === 'passed';
                const testTitle = spec?.title || `Test ${i + 1}`;
                const { error, fullError } = parsePlaywrightError(playwrightTest);

                results.push({
                    test: {
                        id: `test-${i}`,
                        featureId: `feature-${node.id}`,
                        title: testTitle,
                        description: testTitle,
                        input: {},
                        expectedResult: {}
                    },
                    passed,
                    error,
                    fullError,
                    actualResult: undefined
                });

                const status = playwrightTest?.results?.[0]?.status || 'unknown';
                logTestResult(this.outputChannel, `Test ${i + 1}: ${testTitle} (${status})`, passed, error);
            }
            this.outputChannel.appendLine('');
        } else {
            // Match Playwright tests with node's test definitions
            let testIndex = 0;
            for (const feature of features) {
                this.outputChannel.appendLine(`📋 Feature: ${feature.description}`);

                for (const test of feature.tests || []) {
                    const playwrightTest = tests[testIndex];
                    const passed = playwrightTest?.results?.[0]?.status === 'passed';

                    this.outputChannel.appendLine(`   Test ${testIndex}: ${test.title} -> Playwright status: ${playwrightTest?.results?.[0]?.status || 'undefined'}`);

                    const { error, fullError } = parsePlaywrightError(playwrightTest);
                    const expectedResult: any = test.expectedResult;
                    const actualResult = passed ? test.expectedResult : undefined;

                    results.push({
                        test: { ...test, expectedResult },
                        passed,
                        error,
                        fullError,
                        actualResult
                    });

                    logTestResult(this.outputChannel, test.title, passed, error);
                    testIndex++;
                }
                this.outputChannel.appendLine('');
            }
        }

        return results;
    }

    /**
     * Parse coverage and attach to test results
     */
    private parseCoverageAndAttachToResults(
        results: TestResult[],
        workspacePath: string,
        showApiSummary = false
    ): void {
        const coveragePath = path.join(workspacePath, '.tdad', 'coverage');

        if (CoverageParser.hasCoverage(coveragePath)) {
            const coverageData = CoverageParser.parseCoverageSummaryEnhanced(coveragePath);

            const allApiRequests = Object.values(coverageData.testTraces)
                .flatMap(trace => trace.apiRequests || []);

            this.outputChannel.appendLine(`\n📊 Coverage: ${coverageData.sourceFiles.length} source files, ${allApiRequests.length} API requests`);

            if (showApiSummary && allApiRequests.length > 0) {
                const failedRequests = allApiRequests.filter(r => r.status >= 400);
                if (failedRequests.length > 0) {
                    this.outputChannel.appendLine(`   ⚠️  ${failedRequests.length} API request(s) failed`);
                } else {
                    this.outputChannel.appendLine(`   ✅ All API requests succeeded`);
                }
            }

            results.forEach(result => {
                result.coverageData = coverageData;
            });
        }
    }

    /**
     * Run ALL test files in a single Playwright command.
     * Returns a Map of nodeId -> TestResult[] by matching suite.file to node test paths.
     * Note: Coverage data is NOT attached to batch results to avoid memory issues.
     * GoldenPacketAssembler re-reads coverage per-node when building fix prompts.
     */
    public async runBatchTests(
        nodes: Node[],
        workspacePath: string
    ): Promise<Map<string, TestResult[]>> {
        const runToken = TestRunner.cancellationVersion;
        const resultMap = new Map<string, TestResult[]>();

        this.outputChannel.clear();
        this.outputChannel.show();
        this.outputChannel.appendLine(`${'='.repeat(60)}`);
        this.outputChannel.appendLine(`Running BATCH tests for ${nodes.length} nodes`);
        this.outputChannel.appendLine(`${'='.repeat(60)}\n`);

        ensurePlaywrightPrerequisites(workspacePath, this.outputChannel);

        if (this.isCancellationRequested(runToken)) {
            return resultMap;
        }

        // Build node lookup: relative test file path -> node
        const nodeByTestPath = new Map<string, Node>();
        for (const node of nodes) {
            const testFile = await this.findAutomatedTestFile(node);
            if (testFile) {
                const rel = path.relative(workspacePath, testFile).replace(/\\/g, '/');
                nodeByTestPath.set(rel, node);
            }
        }

        const command = buildBatchPlaywrightCommand(nodes);
        this.outputChannel.appendLine(`🔍 Batch command: ${command}`);
        this.outputChannel.appendLine(`🔍 Working directory: ${workspacePath}\n`);

        const execResult = await this.processManager.executeCommandWithTimeout(command, workspacePath);

        if (this.isCancellationRequested(runToken) || this.processManager.cancelRequested) {
            return resultMap;
        }

        this.outputChannel.appendLine(`\n📤 Exit code: ${execResult.exitCode}`);

        // Parse JSON output
        let jsonResult: any;
        try {
            jsonResult = extractPlaywrightJson(execResult.stdout);
        } catch (parseError) {
            this.outputChannel.appendLine(`\n❌ Failed to parse batch Playwright JSON output: ${parseError}`);
            for (const node of nodes) {
                resultMap.set(node.id, [{
                    test: {
                        id: 'batch-startup-error',
                        featureId: node.id,
                        title: 'Batch Playwright Startup Error',
                        description: 'Playwright failed to start in batch mode',
                        input: {},
                        expectedResult: {}
                    },
                    passed: false,
                    error: `Batch Playwright failed to start.\nSTDOUT: ${execResult.stdout.substring(0, 500)}\nSTDERR: ${execResult.stderr.substring(0, 500)}`
                }]);
            }
            return resultMap;
        }

        // Map results back to nodes via top-level suite.file field
        const topLevelSuites = jsonResult.suites || [];
        for (const fileSuite of topLevelSuites) {
            const suiteFile = (fileSuite.file || '').replace(/\\/g, '/');
            let matchedNode: Node | undefined;
            for (const [relPath, node] of nodeByTestPath) {
                if (suiteFile.endsWith(relPath) || relPath.endsWith(suiteFile) || suiteFile === relPath) {
                    matchedNode = node;
                    break;
                }
            }
            if (!matchedNode) {
                this.outputChannel.appendLine(`⚠️ Could not match suite file to node: ${suiteFile}`);
                continue;
            }

            const specs = extractSpecsFromSuites([fileSuite]);
            const tests = specs.flatMap((spec: any) => spec.tests || []);
            const nodeResults: TestResult[] = [];

            for (let i = 0; i < tests.length; i++) {
                const playwrightTest = tests[i];
                const spec = specs.find(s => s.tests?.includes(playwrightTest));
                const passed = playwrightTest?.results?.[0]?.status === 'passed';
                const testTitle = spec?.title || `Test ${i + 1}`;
                const { error, fullError } = parsePlaywrightError(playwrightTest);

                nodeResults.push({
                    test: {
                        id: `batch-test-${i}`,
                        featureId: matchedNode.id,
                        title: testTitle,
                        description: testTitle,
                        input: {},
                        expectedResult: {}
                    },
                    passed,
                    error,
                    fullError
                });
            }

            resultMap.set(matchedNode.id, nodeResults);
            const passedCount = nodeResults.filter(r => r.passed).length;
            this.outputChannel.appendLine(`📊 ${matchedNode.title}: ${passedCount}/${nodeResults.length} passed`);
        }

        // Coverage data is NOT attached in batch mode to prevent memory issues.
        // With 57+ nodes, attaching the full coverage object (1000+ traces, 5000+ API requests)
        // to every test result causes memory blowup during serialization.
        // GoldenPacketAssembler re-reads coverage per-node when building fix prompts.

        // For nodes not found in results, add empty results
        for (const node of nodes) {
            if (!resultMap.has(node.id)) {
                resultMap.set(node.id, []);
            }
        }

        return resultMap;
    }

    private isCancellationRequested(runToken: number): boolean {
        return runToken !== TestRunner.cancellationVersion;
    }

    public cancelCurrentTest(): void {
        TestRunner.cancellationVersion += 1;
        this.processManager.cancelAll();
    }

    public isTestRunning(): boolean {
        return this.processManager.isRunning();
    }

    public dispose() {
        this.processManager.dispose();
        this.outputChannel.dispose();
        this.terminal?.dispose();
    }
}
