import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { Node, TestResult } from '../../shared/types';
import { logTestRunner, logError } from '../../shared/utils/Logger';
import { getWorkflowFolderName } from '../../shared/utils/stringUtils';
import { getTestFilePath, getAbsolutePath } from '../../shared/utils/nodePathUtils';
import { TestFileParser } from '../../core/testing/TestFileParser';
import { getNodeFeatures } from '../../shared/types/typeGuards';
import { CoverageParser } from '../../core/testing/CoverageParser';
import { ITestRunner, TestRunOptions } from '../../core/testing/ITestRunner';
import { FileNameGenerator } from '../../shared/utils/fileNameGenerator';
import { ScaffoldingService } from '../../core/workflows/ScaffoldingService';
import { assignTestIdsToFile } from '../../shared/utils/idGenerator';
import stripAnsi from 'strip-ansi';

export interface TestExecutionResult {
    results: TestResult[];
    duration: number; // milliseconds
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
}

export class TestRunner implements ITestRunner {
    private outputChannel: vscode.OutputChannel;
    private terminal: vscode.Terminal | undefined;
    private currentProcess: ChildProcess | null = null;
    private defaultTimeout = 60000; // 60 seconds

    /** When true, only one test process runs at a time (queue via promise chain) */
    static sequentialMode = false;
    private static testQueue: Promise<void> = Promise.resolve();

    /** Monotonic cancellation token; incrementing cancels queued/in-flight runs with older tokens */
    private static cancellationVersion = 0;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('TDAD Tests');
        // Get timeout from configuration
        const config = vscode.workspace.getConfiguration('tdad');
        this.defaultTimeout = config.get<number>('test.timeout', 60000);
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
        const opts: TestRunOptions = {
            timeout: options?.timeout || this.defaultTimeout,
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
        this.outputChannel.appendLine(`Timeout: ${opts.timeout}ms | Framework: Playwright`);
        this.outputChannel.appendLine(`${'='.repeat(60)}\n`);

        // Look for automated test file (should exist if code was generated properly)
        const automatedTestFilePath = await this.findAutomatedTestFile(node);

        let results: TestResult[];

        if (automatedTestFilePath) {
            this.outputChannel.appendLine(`📁 Test file: ${automatedTestFilePath}\n`);

            try {
                const executionResult = await this.runTests(automatedTestFilePath, node, opts, runToken);
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

        // Compute the path deterministically (no need to store on node)
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
     * Run tests using Playwright
     */
    private async runTests(testFilePath: string, node: Node, options: TestRunOptions, runToken: number): Promise<TestExecutionResult> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder found');
        }

        const workspacePath = workspaceFolder.uri.fsPath;
        this.outputChannel.appendLine(`🔧 Using test framework: playwright\n`);

        return await this.runPlaywrightTests(testFilePath, node, workspacePath, options.timeout!, runToken);
    }

    /**
     * Run Playwright tests with enhanced error reporting
     */
    private async runPlaywrightTests(testFilePath: string, node: Node, workspacePath: string, timeout: number, runToken: number): Promise<TestExecutionResult> {
        const startTime = Date.now();

        if (this.isCancellationRequested(runToken)) {
            return this.createCanceledExecutionResult(Date.now() - startTime);
        }

        // Build diagnostic log for inclusion in error results
        // This captures all diagnostic output so AI can see full context on failures
        const diagnosticLines: string[] = [];
        const logDiagnostic = (line: string) => {
            diagnosticLines.push(line);
            this.outputChannel.appendLine(line);
        };

        try {
            // Ensure fixtures file is up-to-date before running tests
            // This regenerates tdad-fixtures.js with latest screenshot/trace path logic
            const scaffoldingService = new ScaffoldingService();
            scaffoldingService.ensureFixturesFile(workspacePath);
            // Ensure Playwright global lock hook exists.
            scaffoldingService.ensurePlaywrightGlobalLockFile(workspacePath);

            // Ensure TDAD Playwright config bundle exists before running tests.
            // Files:
            // - .tdad/playwright.config.js (wrapper entrypoint)
            // - .tdad/playwright.generated.js (TDAD-managed)
            // - .tdad/playwright.user.js (user-managed overrides)
            const tdadConfigFile = path.join(workspacePath, '.tdad', 'playwright.config.js');
            const tdadGeneratedConfigFile = path.join(workspacePath, '.tdad', 'playwright.generated.js');
            const tdadUserConfigFile = path.join(workspacePath, '.tdad', 'playwright.user.js');
            const config = vscode.workspace.getConfiguration('tdad');
            // Fallback to 5173 only if no URLs configured (for generated projects, .vscode/settings.json should have correct ports)
            const urls = config.get<Record<string, string>>('test.urls', { ui: 'http://localhost:5173' });
            const workers = config.get<number>('test.workers', 1);

            let shouldRegenerateConfig = false;
            let configReason = 'missing';
            if (!fs.existsSync(tdadConfigFile)) {
                shouldRegenerateConfig = true;
                configReason = 'missing-wrapper';
            } else if (!fs.existsSync(tdadGeneratedConfigFile)) {
                shouldRegenerateConfig = true;
                configReason = 'missing-generated';
            } else if (!fs.existsSync(tdadUserConfigFile)) {
                shouldRegenerateConfig = true;
                configReason = 'missing-user';
            } else {
                try {
                    const currentConfig = fs.readFileSync(tdadConfigFile, 'utf-8');
                    if (!currentConfig.includes('TDAD_WRAPPER_CONFIG_V2')) {
                        shouldRegenerateConfig = true;
                        configReason = 'legacy-wrapper-migration';
                    }
                } catch {
                    shouldRegenerateConfig = true;
                    configReason = 'wrapper-read-failed';
                }
            }

            if (shouldRegenerateConfig) {
                scaffoldingService.scaffoldPlaywrightConfig(workspacePath, urls, workers);
                const verb = configReason.startsWith('missing') ? 'Created' : `Regenerated (${configReason})`;
                logDiagnostic(`TDAD Playwright config bundle created/updated (.tdad/playwright.config.js + generated/user files)`);
            }

            // Auto-assign test IDs before running (assigns [UI-XXX] or [API-XXX] to tests without IDs)
            if (assignTestIdsToFile(testFilePath, workspacePath)) {
                logDiagnostic(`🏷️ Assigned test IDs to ${path.basename(testFilePath)}`);
            }

            // Clear previous coverage data before running tests
            // This prevents stale data from accumulating across runs
            const coverageDir = path.join(workspacePath, '.tdad', 'coverage');
            if (fs.existsSync(coverageDir)) {
                const files = fs.readdirSync(coverageDir);
                let cleared = 0;
                for (const file of files) {
                    // Clear both single coverage.json and worker files
                    if (file === 'coverage.json' || file.startsWith('coverage-worker-')) {
                        fs.unlinkSync(path.join(coverageDir, file));
                        cleared++;
                    }
                }
                if (cleared > 0) {
                    logDiagnostic(`🧹 Cleared ${cleared} previous coverage file(s)`);
                }
            }

            // Clear previous screenshots and trace files for THIS NODE ONLY
            // This prevents stale debug data while preserving other nodes' data
            const fileName = FileNameGenerator.getNodeFileName(node as any);
            // Handle both workflowId formats: "name-workflow" and "name.workflow.json"
            const workflowFolderName = getWorkflowFolderName(node.workflowId?.replace('.workflow.json', '') || 'default');
            const nodePath = `${workflowFolderName}/${fileName}`;
            logDiagnostic(`🔍 Debug path: workflowId="${node.workflowId}" -> nodePath="${nodePath}"`);

            // Clear screenshots for this node: .tdad/debug/{workflow}/{node}/screenshots/
            const screenshotDir = path.join(workspacePath, '.tdad', 'debug', nodePath, 'screenshots');
            if (fs.existsSync(screenshotDir)) {
                const files = fs.readdirSync(screenshotDir);
                for (const file of files) {
                    fs.unlinkSync(path.join(screenshotDir, file));
                }
                logDiagnostic(`🧹 Cleared ${files.length} previous screenshot(s) for ${node.title}`);
            }

            // Clear trace files for this node: .tdad/debug/{workflow}/{node}/trace-files/
            const traceDir = path.join(workspacePath, '.tdad', 'debug', nodePath, 'trace-files');
            if (fs.existsSync(traceDir)) {
                const files = fs.readdirSync(traceDir);
                for (const file of files) {
                    fs.unlinkSync(path.join(traceDir, file));
                }
                logDiagnostic(`🧹 Cleared ${files.length} previous trace file(s) for ${node.title}`);
            }

            // Get path relative to CWD (workspace root) for Playwright
            // Just pass the simple relative path - Playwright will handle it correctly
            const relativeTestPath = path.relative(workspacePath, testFilePath).replace(/\\/g, '/');

            // Use TDAD's wrapper config explicitly to avoid conflicts with user's own config.
            // Effective settings are generated config + user overrides merged by the wrapper.
            const tdadConfigPath = '.tdad/playwright.config.js';

            // MVP Phase 4: Code coverage for Playwright browser tests
            // Note: c8/nyc only work for Node.js code, not browser code
            // For browser coverage, use Playwright's Coverage API (page.coverage) in test files
            // See: https://playwright.dev/docs/api/class-coverage
            // Don't quote the path - causes issues with cmd.exe on Windows
            // Use multiple reporters: 'list' for real-time streaming, 'json' for structured data
            // The list output goes to stderr, JSON goes to stdout - both are captured
            const command = `npx playwright test ${relativeTestPath} --config=${tdadConfigPath} --reporter=list,json`;

            logDiagnostic(`🔍 Command: ${command}`);
            logDiagnostic(`🔍 Working directory: ${workspacePath}`);
            logDiagnostic(`🔍 Test file path: ${testFilePath}`);
            logDiagnostic(`🔍 Relative test path: ${relativeTestPath}`);
            logDiagnostic(`🔍 TDAD config: ${tdadConfigPath}`);

            const execResult = await this.executeCommandWithTimeout(command, workspacePath, timeout);

            if (this.isCancellationRequested(runToken)) {
                return this.createCanceledExecutionResult(Date.now() - startTime);
            }

            logDiagnostic(`\n📤 STDOUT length: ${execResult.stdout.length} bytes`);
            logDiagnostic(`📤 STDERR length: ${execResult.stderr.length} bytes`);
            logDiagnostic(`📤 Exit code: ${execResult.exitCode}`);
            logDiagnostic(`📤 Timed out: ${execResult.timedOut}`);

            if (execResult.exitCode !== 0) {
                logDiagnostic(`\n⚠️ Playwright exited with non-zero code. This is expected for failing tests.`);
            }


            let jsonResult;
            try {
                // With --reporter=list,json, stdout contains both list output and JSON
                // Extract just the JSON portion (starts with { and ends with })
                const jsonStart = execResult.stdout.indexOf('\n{');
                const jsonEnd = execResult.stdout.lastIndexOf('}');

                if (jsonStart === -1 || jsonEnd === -1) {
                    throw new Error('Could not find JSON in output');
                }

                const jsonString = execResult.stdout.substring(jsonStart + 1, jsonEnd + 1);
                jsonResult = JSON.parse(jsonString);
            } catch (parseError) {
                logDiagnostic(`\n❌ Failed to parse Playwright JSON output`);
                logDiagnostic(`Output length: ${execResult.stdout.length} characters`);
                logDiagnostic(`First 500 chars: ${execResult.stdout.substring(0, 500)}`);
                logDiagnostic(`Last 500 chars: ${execResult.stdout.substring(Math.max(0, execResult.stdout.length - 500))}`);

                // When Playwright fails to start (config error, etc.), return a synthetic test result
                // with FULL diagnostic output so the AI agent can see what went wrong
                const duration = Date.now() - startTime;

                // Include stderr in diagnostic log
                if (execResult.stderr) {
                    logDiagnostic(`\n❌ STDERR:\n${execResult.stderr}`);
                }

                // Build full diagnostic output for AI
                const fullDiagnosticOutput = diagnosticLines.join('\n');

                logDiagnostic(`\n📤 Returning synthetic error result with full diagnostic output`);

                // Create a synthetic Test object for the startup error
                const syntheticTest: TestResult = {
                    test: {
                        id: 'playwright-startup-error',
                        featureId: node.id,
                        title: 'Playwright Startup Error',
                        description: 'Playwright failed to start - check configuration',
                        input: {},
                        expectedResult: {}
                    },
                    passed: false,
                    error: `Playwright failed to start. This is usually a configuration or syntax error.\n\n--- FULL TEST OUTPUT ---\n${fullDiagnosticOutput}`,
                    fullError: fullDiagnosticOutput
                };

                return {
                    results: [syntheticTest],
                    duration,
                    stdout: execResult.stdout,
                    stderr: execResult.stderr,
                    exitCode: execResult.exitCode,
                    timedOut: execResult.timedOut
                };
            }

            const results: TestResult[] = [];

            // Check for Playwright-level errors (module not found, syntax errors, etc.)
            // These are in jsonResult.errors when tests can't even load
            const playwrightErrors = jsonResult.errors || [];
            if (playwrightErrors.length > 0 && (!jsonResult.suites || jsonResult.suites.length === 0)) {
                // Playwright encountered errors before any tests could run
                const duration = Date.now() - startTime;
                const errorMessages = playwrightErrors.map((e: any) => e.message || e.stack || String(e)).join('\n\n');

                logDiagnostic(`\n❌ Playwright encountered ${playwrightErrors.length} error(s) before tests could run`);
                logDiagnostic(`\n${errorMessages}`);

                // Build full diagnostic output for AI
                const fullDiagnosticOutput = diagnosticLines.join('\n');

                // Create a synthetic test result with the error details
                const syntheticTest: TestResult = {
                    test: {
                        id: 'playwright-load-error',
                        featureId: node.id,
                        title: 'Test File Load Error',
                        description: 'Tests could not be loaded - check imports and dependencies',
                        input: {},
                        expectedResult: {}
                    },
                    passed: false,
                    error: `Tests failed to load. Check imports and module paths.\n\n--- ERRORS ---\n${errorMessages}\n\n--- FULL DIAGNOSTIC OUTPUT ---\n${fullDiagnosticOutput}`,
                    fullError: `${errorMessages}\n\n${fullDiagnosticOutput}`
                };

                return {
                    results: [syntheticTest],
                    duration,
                    stdout: execResult.stdout,
                    stderr: execResult.stderr,
                    exitCode: execResult.exitCode,
                    timedOut: execResult.timedOut
                };
            }

            // Playwright JSON format can have multiple nesting levels:
            // - File level: suites[0]
            // - Outer describe: suites[0].suites[0]
            // - Inner describe (features): suites[0].suites[0].suites[x]
            // - Specs: suites[0].suites[0].suites[x].specs
            const topLevelSuites = jsonResult.suites || [];
            const specs: any[] = [];

            // Recursively extract all specs from nested suites
            const extractSpecs = (suite: any): void => {
                // Add specs directly on this suite
                if (suite.specs && suite.specs.length > 0) {
                    specs.push(...suite.specs);
                }
                // Recurse into nested suites
                if (suite.suites && suite.suites.length > 0) {
                    for (const nestedSuite of suite.suites) {
                        extractSpecs(nestedSuite);
                    }
                }
            };

            // Start extraction from top-level suites
            for (const fileSuite of topLevelSuites) {
                extractSpecs(fileSuite);
            }

            const tests = specs.flatMap((spec: any) => spec.tests || []);

            this.outputChannel.appendLine(`\n📊 Playwright returned ${tests.length} test results`);

            // Parse test file to get current test definitions (single source of truth)
            const parsedTests = TestFileParser.parseTestFile(testFilePath, node.id);
            const parsedFeatures = parsedTests?.features || [];
            const features = parsedFeatures.length > 0 ? parsedFeatures : getNodeFeatures(node);

            if (parsedFeatures.length > 0) {
                this.outputChannel.appendLine(`✅ Using test definitions from test file (${parsedFeatures.length} features)`);
            } else {
                this.outputChannel.appendLine(`⚠️  Using test definitions from node (fallback)`);
            }

            // Match test results with test definitions
            if (features.length === 0 || features.every(f => !f.tests || f.tests.length === 0)) {
                // No features/tests defined in node - create results directly from Playwright tests
                this.outputChannel.appendLine(`⚠️  No test definitions in node - using Playwright test names`);

                for (let i = 0; i < tests.length; i++) {
                    const playwrightTest = tests[i];
                    const spec = specs.find(s => s.tests?.includes(playwrightTest));
                    const passed = playwrightTest?.results?.[0]?.status === 'passed';
                    const testTitle = spec?.title || `Test ${i + 1}`;

                    // Extract error information
                    let error: string | undefined;
                    let fullError: string | undefined;

                    if (playwrightTest && !passed) {
                        const testResult = playwrightTest.results?.[0];
                        if (testResult?.error) {
                            // Extract the full error message with expected/actual values
                            const rawMessage = stripAnsi(testResult.error.message || 'Test failed');
                            const rawStack = stripAnsi(testResult.error.stack || '');

                            // Parse error message to show meaningful context
                            const lines = rawMessage.split('\n');
                            const errorLines = [];

                            for (let i = 0; i < lines.length; i++) {
                                const trimmed = lines[i].trim();

                                // Skip empty lines, code snippets (line numbers), and stack traces
                                if (!trimmed ||
                                    trimmed.match(/^\d+\s+\|/) ||
                                    trimmed.match(/^>\s*\d+\s+\|/) ||
                                    trimmed.startsWith('at ') ||
                                    trimmed.match(/^[\^]+$/)) {
                                    continue;
                                }

                                // Always capture Error: line and the line after it (custom message)
                                if (trimmed.startsWith('Error:')) {
                                    errorLines.push(trimmed);
                                    // Check if next line is a custom message (not Expected/Received)
                                    if (i + 1 < lines.length) {
                                        const nextLine = lines[i + 1].trim();
                                        if (nextLine && !nextLine.startsWith('Expected:') && !nextLine.startsWith('Received:')) {
                                            errorLines.push(nextLine);
                                            i++; // Skip the next iteration since we already processed it
                                        }
                                    }
                                }
                                // Capture Expected/Received values
                                else if (trimmed.startsWith('Expected:') || trimmed.startsWith('Received:')) {
                                    errorLines.push(trimmed);
                                }
                                // Capture expect() assertion line
                                else if (trimmed.includes('expect(') && trimmed.includes(')')) {
                                    errorLines.push(trimmed);
                                }
                            }

                            error = errorLines.length > 0 ? errorLines.join('\n') : rawMessage;
                            fullError = rawMessage + '\n' + rawStack;
                        }
                    }

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

                    // Log individual test result
                    const icon = passed ? '✅' : '❌';
                    const status = playwrightTest?.results?.[0]?.status || 'unknown';
                    this.outputChannel.appendLine(`   ${icon} Test ${i + 1}: ${testTitle} (${status})`);
                    if (error) {
                        const errorLines = error.split('\n');
                        errorLines.forEach((line, idx) => {
                            if (idx === 0) {
                                this.outputChannel.appendLine(`      └─ ${line}`);
                            } else {
                                this.outputChannel.appendLine(`         ${line}`);
                            }
                        });
                    }
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

                        // Extract error information
                        let error: string | undefined;
                        let fullError: string | undefined;
                        let actualResult: any = undefined;
                        const expectedResult: any = test.expectedResult;

                        if (playwrightTest && !passed) {
                            const testResult = playwrightTest.results?.[0];
                            if (testResult?.error) {
                                // Extract the full error message with expected/actual values
                                const rawMessage = stripAnsi(testResult.error.message || 'Test failed');
                                const rawStack = stripAnsi(testResult.error.stack || '');

                                // Parse error message to show meaningful context
                                const lines = rawMessage.split('\n');
                                const errorLines = [];

                                for (let i = 0; i < lines.length; i++) {
                                    const trimmed = lines[i].trim();

                                    // Skip empty lines, code snippets (line numbers), and stack traces
                                    if (!trimmed ||
                                        trimmed.match(/^\d+\s+\|/) ||
                                        trimmed.match(/^>\s*\d+\s+\|/) ||
                                        trimmed.startsWith('at ') ||
                                        trimmed.match(/^[\^]+$/)) {
                                        continue;
                                    }

                                    // Always capture Error: line and the line after it (custom message)
                                    if (trimmed.startsWith('Error:')) {
                                        errorLines.push(trimmed);
                                        // Check if next line is a custom message (not Expected/Received)
                                        if (i + 1 < lines.length) {
                                            const nextLine = lines[i + 1].trim();
                                            if (nextLine && !nextLine.startsWith('Expected:') && !nextLine.startsWith('Received:')) {
                                                errorLines.push(nextLine);
                                                i++; // Skip the next iteration since we already processed it
                                            }
                                        }
                                    }
                                    // Capture Expected/Received values
                                    else if (trimmed.startsWith('Expected:') || trimmed.startsWith('Received:')) {
                                        errorLines.push(trimmed);
                                    }
                                    // Capture expect() assertion line
                                    else if (trimmed.includes('expect(') && trimmed.includes(')')) {
                                        errorLines.push(trimmed);
                                    }
                                }

                                error = errorLines.length > 0 ? errorLines.join('\n') : rawMessage;
                                fullError = rawMessage + '\n' + rawStack;
                            }
                        }

                        // For passed tests, actualResult is same as expected
                        if (passed) {
                            actualResult = test.expectedResult;
                        }

                        results.push({
                            test: { ...test, expectedResult },
                            passed,
                            error,
                            fullError,
                            actualResult
                        });

                        // Log individual test result
                        const icon = passed ? '✅' : '❌';
                        this.outputChannel.appendLine(`   ${icon} ${test.title}`);
                        if (error) {
                            const errorLines = error.split('\n');
                            errorLines.forEach((line, idx) => {
                                if (idx === 0) {
                                    this.outputChannel.appendLine(`      └─ ${line}`);
                                } else {
                                    this.outputChannel.appendLine(`         ${line}`);
                                }
                            });
                        }

                        testIndex++;
                    }
                    this.outputChannel.appendLine('');
                }
            }

            if (this.isCancellationRequested(runToken)) {
                return this.createCanceledExecutionResult(Date.now() - startTime);
            }

            // Parse coverage report (Dynamic Context - Layer 1)
            // Sprint 5: Enhanced coverage with source files + API requests
            // Note: For browser tests, coverage must be collected via Playwright's Coverage API
            // Add page.coverage.startJSCoverage() / stopJSCoverage() in test files
            // c8/nyc only work for Node.js code, not browser application code
            this.parseCoverageAndAttachToResults(results, workspacePath, true);

            if (!CoverageParser.hasCoverage(path.join(workspacePath, '.tdad', 'coverage'))) {
                this.outputChannel.appendLine(`\n⚠️  No coverage data found.`);
                this.outputChannel.appendLine(`   Note: Coverage should be automatically collected if tests were generated with TDAD.`);
                this.outputChannel.appendLine(`   If you wrote tests manually, add coverage hooks to your test file.`);
            }

            // Check if all tests failed with page.goto or page.fill timeouts (indicates server not running)
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

            const duration = Date.now() - startTime;

            return {
                results,
                duration,
                stdout: execResult.stdout,
                stderr: execResult.stderr,
                exitCode: execResult.exitCode,
                timedOut: execResult.timedOut
            };
        } catch (error) {
            const duration = Date.now() - startTime;
            if (this.isCancellationRequested(runToken)) {
                return this.createCanceledExecutionResult(duration);
            }
            this.outputChannel.appendLine(`\n❌ Playwright execution failed: ${error}`);

            // Fallback: return failed results for all tests
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
     * Clean up Playwright test output for better readability
     * - Remove redundant folder name from file name (e.g., expose-scenario-crud-endpoints/expose-scenario-crud-endpoints.test.js -> expose-scenario-crud-endpoints.test.js)
     * - Remove column number from line reference (e.g., :933:3 -> :933)
     * - Remove Playwright project label in list lines (e.g., [ui], [api])
     */
    private cleanTestOutput(output: string): string {
        return output
            .replace(
                /([\\\/])([^\\\/]+)[\\\/]\2\.test\.js:(\d+):\d+/g,
                '$1$2.test.js:$3'
            )
            // List reporter format: "x   1 [ui]  file:line ..."
            // Remove only the project token after test index, keep title tags like [API-123].
            .replace(/^(\s*\S+\s+\d+\s+)\[[^\]]+\]\s+/gm, '$1');
    }

    /**
     * Execute command with timeout support using spawn for better process control
     */
    private executeCommandWithTimeout(command: string, workingDir: string, timeout: number, env?: Record<string, string>): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
        timedOut: boolean;
    }> {
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            let processExited = false;

            // Parse command for cross-platform execution
            const isWindows = process.platform === 'win32';
            const shell = isWindows ? 'cmd.exe' : '/bin/sh';
            const shellFlag = isWindows ? '/c' : '-c';

            this.outputChannel.appendLine(`\n🚀 Starting process...`);
            this.outputChannel.appendLine(`   Shell: ${shell} ${shellFlag}`);
            this.outputChannel.appendLine(`   CWD: ${workingDir}`);
            if (env) {
                this.outputChannel.appendLine(`   ENV: ${Object.keys(env).join(', ')}`);
            }

            // Spawn process with shell
            this.currentProcess = spawn(shell, [shellFlag, command], {
                cwd: workingDir,
                windowsHide: true,
                env: env ? { ...process.env, ...env } : process.env
            });

            this.outputChannel.appendLine(`✅ Process spawned (PID: ${this.currentProcess.pid})\n`);

            // Set up timeout
            const timeoutHandle = setTimeout(() => {
                if (!processExited && this.currentProcess) {
                    timedOut = true;
                    this.outputChannel.appendLine(`\n⚠️  Killing process due to timeout (${timeout}ms)`);

                    // Try graceful termination first
                    this.currentProcess.kill('SIGTERM');

                    // Force kill after 2 seconds if still running
                    setTimeout(() => {
                        if (this.currentProcess && !processExited) {
                            this.currentProcess.kill('SIGKILL');
                        }
                    }, 2000);
                }
            }, timeout);

            // Collect stdout and stream to output in real-time
            this.currentProcess.stdout?.on('data', (data) => {
                const text = data.toString();
                stdout += text;
                // Stream to output channel in real-time for debugging
                this.outputChannel.append(text);
            });

            // Collect stderr and stream to output in real-time
            // Note: Playwright 'list' reporter outputs to stderr, so we show it without prefix
            this.currentProcess.stderr?.on('data', (data) => {
                const text = data.toString();
                stderr += text;
                // Clean up test paths before displaying (remove .tdad/workflows prefix and redundant folder names)
                const cleaned = this.cleanTestOutput(text);
                this.outputChannel.append(cleaned);
            });

            // Track start time for progress logging
            const startTime = Date.now();

            // Log progress every 5 seconds
            const progressInterval = setInterval(() => {
                if (!processExited) {
                    const elapsed = Date.now() - startTime;
                    this.outputChannel.appendLine(`\n⏱️  Still running... (${Math.floor(elapsed / 1000)}s elapsed)`);
                }
            }, 5000);

            // Handle process exit
            this.currentProcess.on('close', (code) => {
                processExited = true;
                clearTimeout(timeoutHandle);
                clearInterval(progressInterval);
                this.currentProcess = null;

                const elapsed = Date.now() - startTime;
                this.outputChannel.appendLine(`\n✅ Process exited with code ${code} after ${Math.floor(elapsed / 1000)}s`);

                // For Playwright commands, ALWAYS resolve even with non-zero exit codes
                // Playwright exits with code 1 when tests fail, but still provides valid JSON output
                if (command.includes('playwright')) {
                    resolve({ stdout, stderr, exitCode: code, timedOut });
                } else if (timedOut) {
                    resolve({ stdout, stderr, exitCode: code, timedOut });
                } else if (code !== 0) {
                    reject(new Error(`Process exited with code ${code}\n${stderr}`));
                } else {
                    resolve({ stdout, stderr, exitCode: code, timedOut });
                }
            });

            // Handle process errors
            this.currentProcess.on('error', (error) => {
                processExited = true;
                clearTimeout(timeoutHandle);
                clearInterval(progressInterval);
                this.currentProcess = null;
                this.outputChannel.appendLine(`\n❌ Process error: ${error.message}`);
                reject(error);
            });
        });
    }

    private isCancellationRequested(runToken: number): boolean {
        return runToken !== TestRunner.cancellationVersion;
    }

    private createCanceledExecutionResult(duration: number): TestExecutionResult {
        return {
            results: [],
            duration,
            stdout: '',
            stderr: '',
            exitCode: null,
            timedOut: false
        };
    }

    /**
     * Parse coverage and attach to test results
     * Sprint 5: Extracted to prevent duplicate code (CLAUDE.md ALWAYS Rule 1)
     */
    private parseCoverageAndAttachToResults(
        results: TestResult[],
        workspacePath: string,
        showApiSummary = false
    ): void {
        const coveragePath = path.join(workspacePath, '.tdad', 'coverage');

        if (CoverageParser.hasCoverage(coveragePath)) {
            const coverageData = CoverageParser.parseCoverageSummaryEnhanced(coveragePath);

            // Count total API requests from all test traces
            const allApiRequests = Object.values(coverageData.testTraces)
                .flatMap(trace => trace.apiRequests || []);

            this.outputChannel.appendLine(`\n📊 Coverage: ${coverageData.sourceFiles.length} source files, ${allApiRequests.length} API requests`);

            // Show API requests summary (only for Playwright tests)
            if (showApiSummary && allApiRequests.length > 0) {
                const failedRequests = allApiRequests.filter(r => r.status >= 400);
                if (failedRequests.length > 0) {
                    this.outputChannel.appendLine(`   ⚠️  ${failedRequests.length} API request(s) failed`);
                } else {
                    this.outputChannel.appendLine(`   ✅ All API requests succeeded`);
                }
            }

            // Add enhanced coverage to each test result
            results.forEach(result => {
                result.coverageData = coverageData;
            });
        }
    }

    /**
     * Cancel currently running test process
     */
    public cancelCurrentTest(): void {
        TestRunner.cancellationVersion += 1;

        if (this.currentProcess) {
            this.outputChannel.appendLine('\n🛑 Canceling test execution...');
            this.currentProcess.kill('SIGTERM');
            this.currentProcess = null;
        } else {
            this.outputChannel.appendLine('\nCancel requested for queued/waiting test executions.');
        }
    }

    /**
     * Get test execution status
     */
    public isTestRunning(): boolean {
        return this.currentProcess !== null;
    }

    public dispose() {
        // Cancel any running process before disposing
        if (this.currentProcess) {
            this.currentProcess.kill('SIGTERM');
            this.currentProcess = null;
        }
        this.outputChannel.dispose();
        this.terminal?.dispose();
    }
}

