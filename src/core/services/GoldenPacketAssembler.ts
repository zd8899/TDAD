import * as fs from 'fs';
import * as path from 'path';
import { Node, Edge, TestResult } from '../../shared/types';
import { toPascalCase, getWorkflowFolderName } from '../../shared/utils/stringUtils';
import { getFeatureFilePath, getActionFilePath, getTestFilePath } from '../../shared/utils/nodePathUtils';
import { logError, logger } from '../../shared/utils/Logger';
import { FileNameGenerator } from '../../shared/utils/fileNameGenerator';
import { DocumentationRetriever } from '../../shared/utils/DocumentationRetriever';
import { PromptService } from './PromptService';
import stripAnsi from 'strip-ansi';

/**
 * Stack frame from parsed error stack trace
 */
interface StackFrame {
    file: string;
    line: number;
    column?: number;
    func?: string;
}

/**
 * Trace data saved to file for complete debugging context
 */
interface SavedTraceData {
    testTitle: string;
    timestamp: string;
    status: string;
    duration: number | null;
    errorMessage: string | null;
    callStack: StackFrame[];
    apiRequests: Array<{
        url: string;
        method: string;
        status: number;
        requestBody?: any;
        responseBody?: any;
        contentType?: string;
        duration?: number;
        error?: string;
    }>;
    consoleLogs: Array<{
        type: string;
        text: string;
        location?: string;
    }>;
    pageErrors: Array<{
        message: string;
        stack?: string;
    }>;
    actionResult?: any;  // Return value from action function (e.g., { success: false, errorMessage: "..." })
    domSnapshot?: any;
    screenshotPath?: string;
}

export interface FixAttemptInfo {
    attemptNumber: number;
    approachDescription: string;  // What the AI tried (from AGENT_DONE.md)
    timestamp: string;
}

/**
 * GoldenPacketAssembler - Assembles the "Golden Packet" for AI hand-off
 *
 * MVP Phase 5: Enhanced Golden Packet Hand-off (THE CRITICAL MVP FEATURE)
 * - Combines Gherkin spec + test code + error + Dynamic Trace
 * - Layer 1 (Dynamic): Coverage report → execution trace → WHERE the error is
 * - Dependencies: Shows upstream features and action imports (MVP.md section 4-5)
 * - Prevents AI hallucination by providing project patterns
 *
 * This is the entire value proposition of TDAD.
 */
export class GoldenPacketAssembler {
    /**
     * Assemble the golden packet for a failed test
     *
     * @param node - The feature node
     * @param testResults - Test execution results
     * @param workspacePath - Workspace root path
     * @param allNodes - Optional array of all nodes (for dependency lookup)
     * @param previousAttempts - Optional array of previous fix attempts (for automated mode)
     * @param isAutomated - Whether this is automated mode (shows "When Done" section)
     * @returns Formatted golden packet string ready for clipboard
     */
    public static async assembleGoldenPacket(
        node: Node,
        testResults: TestResult[],
        workspacePath: string,
        allNodes?: Node[],
        edges?: Edge[],
        previousAttempts?: FixAttemptInfo[],
        isAutomated = false
    ): Promise<string> {
        try {
            logger.log('GOLDEN-PACKET', `Assembling golden packet for node: ${node.title}`);

            // Get file paths for scaffolded files
            const fileName = FileNameGenerator.getNodeFileName(node as any);
            const workflowFolderName = getWorkflowFolderName(node.workflowId);

            // Node path for debug folder structure: {workflow}/{node}
            const nodePath = `${workflowFolderName}/${fileName}`;

            // Format all test results with per-test traces (saves complete data to files)
            const formattedTestResults = await this.formatTestResults(testResults, workspacePath, nodePath);
            const featureFile = getFeatureFilePath(workflowFolderName, fileName);
            const actionFile = getActionFilePath(workflowFolderName, fileName);
            const testFile = getTestFilePath(workflowFolderName, fileName);

            // MVP: Format dependencies section (MVP.md section 4-5)
            // Edges are single source of truth for dependencies
            const dependenciesContext = this.formatDependencies(node, allNodes, edges, workflowFolderName, workspacePath);

            // Get project context (Tech Stack)
            const projectContext = await this.getProjectContext(workspacePath);

            // Get documentation context from node.contextFiles
            const documentationContext = await this.getDocumentationContext(node, workspacePath);

            // Format previous fix attempts (for automated mode)
            const previousAttemptsContext = this.formatPreviousAttempts(previousAttempts);

            // Use PromptService to load and process the template
            const extensionPath = path.join(__dirname, '..', '..', '..');
            const promptService = new PromptService(extensionPath, workspacePath);

            const goldenPacket = await promptService.generatePrompt('golden-packet', {
                featureName: node.title,
                featureDescription: node.description,
                testResults: formattedTestResults,
                projectContext,
                dependenciesContext,
                documentationContext,
                previousAttemptsContext,
                featureFile,
                actionFile,
                testFile,
                isAutomated
            });

            logger.log('GOLDEN-PACKET', 'Golden packet assembled successfully');
            return goldenPacket;
        } catch (error) {
            logError('GOLDEN-PACKET', 'Failed to assemble golden packet', error);
            throw error;
        }
    }

    /**
     * UNIFIED METHOD: Assemble golden packet AND save all files
     * Single Source of Truth for saving trace files and golden packet markdown.
     *
     * This method should be called by ALL code paths that need to save trace/golden packet:
     * - TestWorkflowHandlers.runTestsAndSaveTraces()
     * - TestWorkflowHandlers.handleCopyGoldenPacket()
     * - AgentOrchestrator.runTestsForNode()
     *
     * @returns The assembled golden packet string (for clipboard copy, etc.)
     */
    public static async assembleAndSave(
        node: Node,
        testResults: TestResult[],
        workspacePath: string,
        allNodes?: Node[],
        edges?: Edge[],
        previousAttempts?: FixAttemptInfo[],
        isAutomated = false
    ): Promise<string> {
        // Assemble the golden packet (this also saves trace JSON files)
        const goldenPacket = await this.assembleGoldenPacket(
            node,
            testResults,
            workspacePath,
            allNodes,
            edges,
            previousAttempts,
            isAutomated
        );

        // Save the golden packet markdown to .tdad/debug/golden-packet.md
        try {
            const debugDir = path.join(workspacePath, '.tdad', 'debug');
            if (!fs.existsSync(debugDir)) {
                fs.mkdirSync(debugDir, { recursive: true });
            }

            const goldenPacketPath = path.join(debugDir, 'golden-packet.md');
            fs.writeFileSync(goldenPacketPath, goldenPacket, 'utf-8');
            logger.log('GOLDEN-PACKET', `Saved golden packet to: .tdad/debug/golden-packet.md`);
        } catch (error) {
            logError('GOLDEN-PACKET', 'Failed to save golden packet markdown (non-fatal)', error);
        }

        return goldenPacket;
    }

    /**
     * Get project context from package.json
     */
    private static async getProjectContext(workspacePath: string): Promise<string> {
        try {
            const packageJsonPath = path.join(workspacePath, 'package.json');
            if (!fs.existsSync(packageJsonPath)) {
                return '';
            }

            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
            
            let output = '';
            const keyLibs = ['next', 'react', 'express', 'nestjs', 'tailwindcss', 'typescript', 'playwright', 'jest', 'vitest', 'axios', 'react-hook-form', 'zod'];
            const foundLibs = Object.keys(dependencies).filter(d => keyLibs.some(k => d.includes(k)));

            if (foundLibs.length > 0) {
                output += `- **Key Libraries:** ${foundLibs.join(', ')}\n`;
            }
            
            return output;
        } catch (e) {
            return '';
        }
    }

    /**
     * Format dependencies for the Golden Packet
     * MVP.md section 4: The Dependency System (State Chain)
     * Dependencies are derived from edges (single source of truth)
     */
    private static formatDependencies(node: Node, allNodes?: Node[], edges?: Edge[], workflowFolderName?: string, workspacePath?: string): string {
        // Derive dependencies from edges (single source of truth)
        const dependencies = edges
            ? edges.filter(e => e.target === node.id).map(e => e.source)
            : [];

        if (dependencies.length === 0) {
            return '';
        }

        // Detect if project uses ESM
        const isESM = this.isESMProject(workspacePath);

        let output = '';

        for (const depId of dependencies) {
            // Handle cross-workflow dependencies (format: "workflowId/nodeId")
            let targetWorkflowId: string | undefined;
            let targetNodeId: string;

            if (depId.includes('/')) {
                const [workflow, nodeIdPart] = depId.split('/');
                targetWorkflowId = workflow;
                targetNodeId = nodeIdPart;
            } else {
                targetNodeId = depId;
            }

            const depNode = allNodes?.find(n =>
                n.id === targetNodeId &&
                (!targetWorkflowId || n.workflowId === targetWorkflowId)
            );
            const depName = depNode?.title || targetNodeId;
            const depFileName = depNode ? FileNameGenerator.getNodeFileName(depNode as any) : FileNameGenerator.generate(depName);
            const depWorkflow = depNode?.workflowId ? getWorkflowFolderName(depNode.workflowId) : (targetWorkflowId || workflowFolderName || 'features');

            // Action file path for import
            const actionPath = getActionFilePath(depWorkflow, depFileName);
            const functionName = `perform${toPascalCase(depFileName)}Action`;

            // Generate import based on module system
            const importStatement = isESM
                ? `import { ${functionName} } from '${actionPath}';`
                : `const { ${functionName} } = require('${actionPath}');`;

            output += `### ${depName}\n`;
            output += `- **Action File:** \`${actionPath}\`\n`;
            output += `- **Import:** \`${importStatement}\`\n`;
            output += `\n`;
        }

        return output;
    }

    /**
     * Detect if the target project uses ES Modules
     */
    private static isESMProject(workspacePath?: string): boolean {
        if (!workspacePath) {
            return false;
        }
        try {
            const packageJsonPath = path.join(workspacePath, 'package.json');
            if (fs.existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                return packageJson.type === 'module';
            }
        } catch {
            // If we can't read package.json, default to CommonJS
        }
        return false;
    }

    /**
     * Format previous fix attempts for the golden packet
     * Shows what approaches were tried so AI can try something different
     * Now supports detailed multi-line format from AGENT_DONE.md
     */
    private static formatPreviousAttempts(attempts?: FixAttemptInfo[]): string {
        if (!attempts || attempts.length === 0) {
            return '';
        }

        let output = '';
        for (const attempt of attempts) {
            output += `### Attempt ${attempt.attemptNumber}\n`;

            // Check if the approach description contains the detailed format
            const description = attempt.approachDescription;
            if (description.includes('FILES MODIFIED:') || description.includes('CHANGES MADE:')) {
                // Detailed format - preserve the structure
                output += `${description}\n`;
            } else {
                // Legacy brief format
                output += `- **Approach tried:** ${description}\n`;
            }
            output += `- **Result:** Tests still failing\n\n`;
        }

        return output;
    }

    /**
     * Get documentation context from node.contextFiles
     */
    private static async getDocumentationContext(node: Node, workspacePath: string): Promise<string> {
        const contextFiles = (node as any).contextFiles as string[] | undefined;

        if (!contextFiles || contextFiles.length === 0) {
            return '';
        }

        try {
            const fileContents = await DocumentationRetriever.readDocumentationFiles(
                contextFiles,
                workspacePath
            );

            if (Object.keys(fileContents).length === 0) {
                return '';
            }

            return DocumentationRetriever.formatFilesForPrompt(fileContents);
        } catch (error) {
            logError('GOLDEN-PACKET', 'Failed to read documentation files', error);
            return '';
        }
    }

    /**
     * Format all test results with per-test traces for golden packet
     * Enhanced: Shows trace data (API calls, console, errors) under each test
     * Saves complete trace data to files for AI to reference
     * @param nodePath - Path in format "workflowName/nodeName" for debug folder structure
     */
    private static async formatTestResults(
        testResults: TestResult[],
        workspacePath: string,
        nodePath: string
    ): Promise<string> {
        if (testResults.length === 0) {
            return '(No tests were executed)';
        }

        const passed = testResults.filter(r => r.passed);
        const failed = testResults.filter(r => !r.passed);

        // Get coverage data with per-test traces
        const coverageData = testResults[0]?.coverageData;
        const testTraces = coverageData?.testTraces || {};

        let output = '';

        // Summary at top
        output += `**Summary:** ${passed.length} passed, ${failed.length} failed\n\n`;

        // Frontend Source Files (MVP requirement)
        if (coverageData?.sourceFiles && coverageData.sourceFiles.length > 0) {
            output += `**Frontend Source Files:**\n`;
            // Only show top 10 files to avoid bloating the prompt
            const uniqueFiles = Array.from(new Set(coverageData.sourceFiles));
            uniqueFiles.slice(0, 10).forEach(f => output += `- \`${f}\`\n`);
            if (uniqueFiles.length > 10) {
                output += `- ... and ${uniqueFiles.length - 10} more\n`;
            }
            output += `\n`;
        }

        // Expected Backend Files (Missing Endpoints: inferred from 404s)
        // Moved to per-test section for surgical precision


        // Show failed tests first (more important for debugging)
        if (failed.length > 0) {
            for (const result of failed) {
                output += `### ❌ FAILED: ${result.test.title}\n`;
                output += `${'─'.repeat(50)}\n`;

                // Error message
                const rawError = result.fullError || result.error || 'Unknown error';
                let error = stripAnsi(rawError);
                if (error.startsWith('Error: ')) {
                    error = error.substring(7);
                }
                // Show first line as summary
                output += `**Error:** ${error.split('\n')[0]}\n\n`;

                // Code snippet
                const snippet = await this.extractCodeSnippet(rawError, workspacePath);
                if (snippet) {
                    output += `${snippet}\n\n`;
                }

                // Per-test trace data - try exact match first, then fuzzy match
                let trace = testTraces[result.test.title];
                if (!trace) {
                    // Fuzzy match: normalize whitespace and try to find a matching key
                    const normalizedTitle = result.test.title.trim().toLowerCase().replace(/\s+/g, ' ');
                    for (const [key, value] of Object.entries(testTraces)) {
                        const normalizedKey = key.trim().toLowerCase().replace(/\s+/g, ' ');
                        if (normalizedKey === normalizedTitle ||
                            normalizedKey.includes(normalizedTitle) ||
                            normalizedTitle.includes(normalizedKey)) {
                            trace = value as any;
                            break;
                        }
                    }
                }
                if (trace) {
                    // Pass workspace path, test title, and node path for saving complete trace data
                    output += this.formatTestTrace(trace, false, workspacePath, result.test.title, nodePath, result.fullError);

                    // Missing Endpoints (Per-Test Surgical Context)
                    const missingEndpoints = new Set<string>();
                    trace.apiRequests?.forEach((req: any) => {
                        if (req.status === 404) {
                            missingEndpoints.add(`${req.method} ${req.url}`);
                        }
                    });

                    if (missingEndpoints.size > 0) {
                        output += `\n🛑 **Missing Backend Endpoints (404s):**\n`;
                        missingEndpoints.forEach(e => output += `- \`${e}\`\n`);

                        // Expected Backend Files (inferred from API endpoints) - MVP.md line 162
                        if (coverageData?.inferredBackendFiles && coverageData.inferredBackendFiles.length > 0) {
                            output += `\n📂 **Expected Backend Files (to implement):**\n`;
                            coverageData.inferredBackendFiles.forEach(f => output += `- \`${f}\`\n`);
                        }
                    }

                    // Timeout Guidance (MVP requirement)
                    if (trace.status === 'timedOut') {
                        output += `⏱️ **Timeout Guidance:**\n`;
                        output += `- The test timed out. Common causes:\n`;
                        output += `  - Element not found within timeout (check selectors)\n`;
                        output += `  - Promise not resolving (missing await?)\n`;
                        output += `  - Network request hanging\n`;
                    }
                } else {
                    // No trace data - this typically means Playwright failed to start (config error, syntax error, etc.)
                    // Show the FULL error output so the AI can diagnose the issue
                    output += `📡 **API Calls:** (No trace data captured - Playwright may have failed to start)\n\n`;

                    // Show full error output for startup failures
                    if (error.includes('\n')) {
                        output += `**Full Error Output:**\n\`\`\`\n${error}\n\`\`\`\n`;
                    }
                }
                output += '\n';
            }
        }

        // Show passed tests (collapsed, less detail)
        if (passed.length > 0) {
            output += `### ✅ PASSED TESTS (${passed.length})\n`;
            output += `${'─'.repeat(50)}\n`;

            for (const result of passed) {
                output += `\n**✅ ${result.test.title}**\n`;

                // Per-test trace data for passed tests - also save to file for debugging context
                const trace = testTraces[result.test.title];
                if (trace) {
                    output += this.formatTestTrace(trace, true, workspacePath, result.test.title, nodePath, result.fullError);
                }
            }
        }

        return output;
    }

    /**
     * Save complete trace data to a file and return the file path
     * @param trace - The trace data
     * @param testTitle - The test title for file naming
     * @param workspacePath - Workspace root path
     * @param nodeName - Node name for folder organization (format: "workflowName/nodeName")
     * @returns The relative path to the saved trace file
     */
    private static saveTraceDataToFile(
        trace: any,
        testTitle: string,
        workspacePath: string,
        nodeName: string,
        fullError?: string
    ): string {
        try {
            const safeTestTitle = FileNameGenerator.generate(testTitle).substring(0, 50);

            // Create folder structure matching screenshots: .tdad/debug/{workflow}/{node}/trace-files/
            // nodeName format is typically "workflowName/nodeName" or just "nodeName"
            const traceDir = path.join(workspacePath, '.tdad', 'debug', nodeName, 'trace-files');
            if (!fs.existsSync(traceDir)) {
                fs.mkdirSync(traceDir, { recursive: true });
            }

            // Single file per test - overwrites on each run
            const fileName = `trace-${safeTestTitle}.json`;
            const filePath = path.join(traceDir, fileName);
            const relativePath = `.tdad/debug/${nodeName}/trace-files/${fileName}`;

            // Build complete trace data object
            const traceData: SavedTraceData = {
                testTitle,
                timestamp: new Date().toISOString(),
                status: trace.status || 'unknown',
                duration: trace.duration ?? null,
                errorMessage: fullError ? this.extractErrorMessage(fullError) : null,
                callStack: fullError ? this.parseStackTrace(fullError) : [],
                apiRequests: trace.apiRequests?.map((req: any) => ({
                    url: req.url,
                    method: req.method,
                    status: req.status,
                    requestBody: req.requestBody,
                    responseBody: req.responseBody,
                    contentType: req.contentType,
                    duration: req.duration,
                    error: req.error
                })) || [],
                consoleLogs: trace.consoleLogs?.map((log: any) => ({
                    type: log.type,
                    text: log.text,
                    location: log.location
                })) || [],
                pageErrors: trace.pageErrors?.map((err: any) => ({
                    message: err.message,
                    stack: err.stack
                })) || [],
                actionResult: trace.actionResult || null,
                domSnapshot: trace.domSnapshot,
                screenshotPath: trace.screenshotPath || null
            };

            fs.writeFileSync(filePath, JSON.stringify(traceData, null, 2), 'utf-8');
            logger.log('GOLDEN-PACKET', `Saved complete trace data to: ${relativePath}`);

            return relativePath;
        } catch (error) {
            logError('GOLDEN-PACKET', 'Failed to save trace data to file', error);
            return '';
        }
    }

    /**
     * Format trace data for a single test
     * @param trace - The trace data for the test
     * @param testPassed - Whether the test passed (affects icon display for expected errors)
     * @param workspacePath - Workspace root path (optional, for saving complete data)
     * @param testTitle - Test title (optional, for saving complete data)
     * @param nodePath - Node path in format "workflowName/nodeName" (optional, for saving complete data)
     * @param fullError - Full error with stack trace (optional, for call stack parsing)
     */
    private static formatTestTrace(
        trace: any,
        testPassed = false,
        workspacePath?: string,
        testTitle?: string,
        nodePath?: string,
        fullError?: string
    ): string {
        let output = '';

        // Save complete trace data to file if workspace path provided
        let traceFilePath = '';
        if (workspacePath && testTitle && nodePath) {
            traceFilePath = this.saveTraceDataToFile(trace, testTitle, workspacePath, nodePath, fullError);
        }

        // Show trace file reference once at the top (for failed tests only)
        if (traceFilePath) {
            output += `📁 **Details Trace file and logs:** \`${traceFilePath}\`\n`;
        }

        // Show screenshot path if available
        if (trace.screenshotPath) {
            output += `📸 **Screenshot:** \`${trace.screenshotPath}\`\n`;
        }

        // API Calls - show all endpoints with status
        if (trace.apiRequests && trace.apiRequests.length > 0) {
            output += `📡 **API Calls:**\n`;
            for (const req of trace.apiRequests) {
                const isSuccess = req.status >= 200 && req.status < 400;
                const statusIcon = isSuccess ? '✅' : '❌';
                output += `- \`${req.method} ${req.url}\` → ${req.status} ${statusIcon}\n`;
            }
        } else {
            output += `📡 **API Calls:** (none)\n`;
        }

        // Console warnings/errors only - filter out browser network noise
        const importantLogs = trace.consoleLogs?.filter((log: any) => {
            if (log.type !== 'error' && log.type !== 'warn') {return false;}
            // Skip browser network errors - already shown in API Calls section (redundant noise)
            if (log.text.includes('Failed to load resource')) {return false;}
            if (log.text.includes('net::ERR_')) {return false;}
            return true;
        }) || [];

        if (importantLogs.length > 0) {
            output += `📋 **Console:**\n`;
            for (const log of importantLogs.slice(0, 5)) {
                const icon = log.type === 'error' ? '❌' : '⚠️';
                // Show full text if short, reference file if long
                const text = log.text.length <= 200 ? log.text : log.text.substring(0, 200) + '... (see trace file)';
                // Include location if available (per MVP.md requirement)
                const location = log.location ? ` (${log.location})` : '';
                output += `- ${icon} ${text}${location}\n`;
            }
        }

        // Page errors
        if (trace.pageErrors && trace.pageErrors.length > 0) {
            output += `💥 **JS Errors:**\n`;
            for (const err of trace.pageErrors) {
                output += `- ${err.message}\n`;
            }
        }

            return output;
    }

    /**
     * Extract file path and line number from error message
     * Supports formats like:
     * - "at C:\path\to\file.js:64:32"
     * - "at /path/to/file.js:64:32"
     * - "file.test.js:64"
     */
    private static parseErrorLocation(error: string): { filePath: string; lineNumber: number } | null {
        // Pattern 1: Windows/Unix absolute paths with "at" prefix
        // e.g., "at c:\Users\...\file.test.js:64:32" or "at /home/.../file.test.js:64:32"
        const atPathMatch = error.match(/at\s+([a-zA-Z]:\\[^:]+|\/[^:]+):(\d+)(?::\d+)?/);
        if (atPathMatch) {
            return {
                filePath: atPathMatch[1],
                lineNumber: parseInt(atPathMatch[2], 10)
            };
        }

        // Pattern 2: Standalone path with line number
        // e.g., "c:\path\file.js:64" or "/path/file.js:64"
        const standaloneMatch = error.match(/([a-zA-Z]:\\[^\s:]+|\/[^\s:]+):(\d+)/);
        if (standaloneMatch) {
            return {
                filePath: standaloneMatch[1],
                lineNumber: parseInt(standaloneMatch[2], 10)
            };
        }

        return null;
    }

    /**
     * Extract code snippet around the failing line
     * Returns formatted snippet with line numbers and >> marker
     */
    private static async extractCodeSnippet(error: string, workspacePath: string): Promise<string | null> {
        try {
            const location = this.parseErrorLocation(error);
            if (!location) {
                return null;
            }

            const { filePath, lineNumber } = location;

            // Resolve path - handle both absolute and relative paths
            let absolutePath = filePath;
            if (!path.isAbsolute(filePath)) {
                absolutePath = path.join(workspacePath, filePath);
            }

            // Check if file exists
            if (!fs.existsSync(absolutePath)) {
                logger.log('GOLDEN-PACKET', `File not found for snippet: ${absolutePath}`);
                return null;
            }

            // Read the file
            const fileContent = fs.readFileSync(absolutePath, 'utf8');
            const lines = fileContent.split('\n');

            // Calculate range (3 lines before and after, clamped to file bounds)
            const contextLines = 3;
            const startLine = Math.max(0, lineNumber - 1 - contextLines);
            const endLine = Math.min(lines.length - 1, lineNumber - 1 + contextLines);

            // Get relative path for display
            const relativePath = path.relative(workspacePath, absolutePath);

            // Build snippet with line numbers
            let snippet = `  📍 Code at ${relativePath}:${lineNumber}\n`;
            snippet += '  ```\n';

            for (let i = startLine; i <= endLine; i++) {
                const actualLineNum = i + 1; // Convert to 1-based
                const lineNumStr = actualLineNum.toString().padStart(4, ' ');
                const marker = actualLineNum === lineNumber ? '>>' : '  ';
                const line = lines[i] || '';
                snippet += `  ${marker} ${lineNumStr}│ ${line}\n`;
            }

            snippet += '  ```';

            return snippet;
        } catch (err) {
            logError('GOLDEN-PACKET', 'Failed to extract code snippet', err);
            return null;
        }
    }

    /**
     * Get a preview of the golden packet for UI display
     */
    public static async getPacketPreview(
        node: Node,
        testResults: TestResult[],
        workspacePath: string
    ): Promise<string> {
        const packet = await this.assembleGoldenPacket(node, testResults, workspacePath);

        // Truncate for preview (first 500 chars)
        if (packet.length > 500) {
            return packet.substring(0, 500) + '\n\n... (truncated for preview)';
        }

        return packet;
    }

    /**
     * Get packet statistics
     */
    public static getPacketStats(goldenPacket: string): {
        totalChars: number;
        totalLines: number;
        sections: number;
    } {
        return {
            totalChars: goldenPacket.length,
            totalLines: goldenPacket.split('\n').length,
            sections: (goldenPacket.match(/---/g) || []).length
        };
    }

    /**
     * Parse stack trace from error string into structured frames
     * @param fullError - The full error string including stack trace
     * @returns Array of stack frames with file, line, column, and function name
     */
    private static parseStackTrace(fullError: string): StackFrame[] {
        const frames: StackFrame[] = [];
        const lines = fullError.split('\n');

        for (const line of lines) {
            // Match: "at functionName (file:line:col)" or "at file:line:col"
            const match = line.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/);
            if (match) {
                frames.push({
                    func: match[1] || undefined,
                    file: match[2],
                    line: parseInt(match[3], 10),
                    column: parseInt(match[4], 10)
                });
            }
        }
        return frames;
    }

    /**
     * Extract meaningful error message including Expected/Received values
     * @param fullError - The full error string
     * @returns Formatted error message with key diagnostic info
     */
    private static extractErrorMessage(fullError: string): string {
        const lines = fullError.split('\n');
        const errorLines: string[] = [];

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip empty lines and code snippets
            if (!trimmed) {continue;}
            if (trimmed.match(/^\d+\s+\|/)) {continue;}  // Code line numbers
            if (trimmed.match(/^>\s*\d+\s+\|/)) {continue;}  // Arrow pointing to error
            if (trimmed.match(/^[\^~]+$/)) {continue;}  // Caret underline
            if (trimmed.startsWith('at ')) {break;}  // Stop at stack trace

            // Capture Error line
            if (trimmed.startsWith('Error:')) {
                errorLines.push(trimmed);
            }
            // Capture Expected/Received values (critical for debugging)
            else if (trimmed.startsWith('Expected:') || trimmed.startsWith('Received:')) {
                errorLines.push(trimmed);
            }
            // Capture Call log entries (Playwright action trace)
            else if (trimmed.startsWith('Call log:') || trimmed.startsWith('-')) {
                errorLines.push(trimmed);
            }
        }

        return errorLines.length > 0 ? errorLines.join('\n') : lines[0] || 'Unknown error';
    }
}
