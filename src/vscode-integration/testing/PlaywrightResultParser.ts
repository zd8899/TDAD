import { TestResult } from '../../shared/types';
import stripAnsi from 'strip-ansi';

export interface TestExecutionResult {
    results: TestResult[];
    duration: number; // milliseconds
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
}

export function createCanceledExecutionResult(duration: number): TestExecutionResult {
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
 * Parse Playwright JSON reporter output from mixed stdout (may contain globalSetup logs)
 */
export function extractPlaywrightJson(output: string): any {
    const trimmed = output.trim();
    if (!trimmed) { throw new Error('Empty Playwright output'); }

    try { return JSON.parse(trimmed); } catch { /* mixed output recovery */ }

    const jsonEnd = output.lastIndexOf('}');
    if (jsonEnd === -1) { throw new Error('Could not find JSON end token in output'); }

    const startCandidates: number[] = [];
    for (let i = 0; i < jsonEnd; i++) {
        if (output[i] === '{') { startCandidates.push(i); }
    }

    for (let i = startCandidates.length - 1; i >= 0; i--) {
        const candidate = output.substring(startCandidates[i], jsonEnd + 1).trim();
        if (!candidate.startsWith('{')) { continue; }
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed.suites) && parsed.stats) {
                return parsed;
            }
        } catch { /* try next */ }
    }

    throw new Error('Could not extract valid Playwright JSON payload from mixed output');
}

/**
 * Recursively extract all specs from nested Playwright suites
 */
export function extractSpecsFromSuites(suites: any[]): any[] {
    const specs: any[] = [];
    const walk = (suite: any): void => {
        if (suite.specs?.length > 0) { specs.push(...suite.specs); }
        if (suite.suites?.length > 0) {
            for (const nested of suite.suites) { walk(nested); }
        }
    };
    for (const suite of suites) { walk(suite); }
    return specs;
}

/**
 * Extract error information from a Playwright test result.
 * Centralizes the error parsing logic used in single-node, feature-matched, and batch flows.
 */
export function parsePlaywrightError(playwrightTest: any): { error?: string; fullError?: string } {
    if (!playwrightTest) { return {}; }

    const passed = playwrightTest.results?.[0]?.status === 'passed';
    if (passed) { return {}; }

    const testResult = playwrightTest.results?.[0];
    if (!testResult?.error) { return {}; }

    const rawMessage = stripAnsi(testResult.error.message || 'Test failed');
    const rawStack = stripAnsi(testResult.error.stack || '');

    const lines = rawMessage.split('\n');
    const errorLines: string[] = [];

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
            if (i + 1 < lines.length) {
                const nextLine = lines[i + 1].trim();
                if (nextLine && !nextLine.startsWith('Expected:') && !nextLine.startsWith('Received:')) {
                    errorLines.push(nextLine);
                    i++;
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

    return {
        error: errorLines.length > 0 ? errorLines.join('\n') : rawMessage,
        fullError: rawMessage + '\n' + rawStack
    };
}

/**
 * Build a synthetic error TestExecutionResult for Playwright startup/load failures
 */
export function buildSyntheticErrorResult(
    nodeId: string,
    errorId: string,
    title: string,
    description: string,
    errorMessage: string,
    fullErrorMessage: string,
    execResult: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean },
    duration: number
): TestExecutionResult {
    return {
        results: [{
            test: {
                id: errorId,
                featureId: nodeId,
                title,
                description,
                input: {},
                expectedResult: {}
            },
            passed: false,
            error: errorMessage,
            fullError: fullErrorMessage
        }],
        duration,
        stdout: execResult.stdout,
        stderr: execResult.stderr,
        exitCode: execResult.exitCode,
        timedOut: execResult.timedOut
    };
}

/**
 * Log a test result line to the output channel
 */
export function logTestResult(
    outputChannel: { appendLine: (line: string) => void },
    title: string,
    passed: boolean,
    error?: string
): void {
    const icon = passed ? '✅' : '❌';
    outputChannel.appendLine(`   ${icon} ${title}`);
    if (error) {
        const lines = error.split('\n');
        lines.forEach((line, idx) => {
            if (idx === 0) {
                outputChannel.appendLine(`      └─ ${line}`);
            } else {
                outputChannel.appendLine(`         ${line}`);
            }
        });
    }
}
