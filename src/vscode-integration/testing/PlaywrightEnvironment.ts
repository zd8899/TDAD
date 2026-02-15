import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Node } from '../../shared/types';
import { getWorkflowFolderName } from '../../shared/utils/stringUtils';
import { ScaffoldingService } from '../../core/workflows/ScaffoldingService';
import { FileNameGenerator } from '../../shared/utils/fileNameGenerator';
import { assignTestIdsToFile } from '../../shared/utils/idGenerator';

const TDAD_CONFIG_PATH = '.tdad/playwright.config.js';

interface OutputSink {
    appendLine: (line: string) => void;
}

/**
 * Ensure all Playwright prerequisites are in place before running tests.
 * Handles: fixtures, global lock, config bundle, coverage cleanup.
 */
export function ensurePlaywrightPrerequisites(
    workspacePath: string,
    outputChannel: OutputSink
): void {
    const scaffoldingService = new ScaffoldingService();
    scaffoldingService.ensureFixturesFile(workspacePath);
    scaffoldingService.ensurePlaywrightGlobalLockFile(workspacePath);
    ensurePlaywrightConfig(workspacePath, scaffoldingService, outputChannel);
    clearCoverageData(workspacePath, outputChannel);
}

/**
 * Ensure TDAD Playwright config bundle exists and is up-to-date.
 * Config files: playwright.config.js (wrapper), playwright.generated.js, playwright.user.js
 */
function ensurePlaywrightConfig(
    workspacePath: string,
    scaffoldingService: ScaffoldingService,
    outputChannel: OutputSink
): void {
    const tdadConfigFile = path.join(workspacePath, '.tdad', 'playwright.config.js');
    const tdadGeneratedConfigFile = path.join(workspacePath, '.tdad', 'playwright.generated.js');
    const tdadUserConfigFile = path.join(workspacePath, '.tdad', 'playwright.user.js');
    const config = vscode.workspace.getConfiguration('tdad');
    const urls = config.get<Record<string, string>>('test.urls', { ui: 'http://localhost:5173' });
    const workers = config.get<number>('test.workers', 1);

    let shouldRegenerate = false;
    let reason = 'missing';
    if (!fs.existsSync(tdadConfigFile)) {
        shouldRegenerate = true;
        reason = 'missing-wrapper';
    } else if (!fs.existsSync(tdadGeneratedConfigFile)) {
        shouldRegenerate = true;
        reason = 'missing-generated';
    } else if (!fs.existsSync(tdadUserConfigFile)) {
        shouldRegenerate = true;
        reason = 'missing-user';
    } else {
        try {
            const currentConfig = fs.readFileSync(tdadConfigFile, 'utf-8');
            if (!currentConfig.includes('TDAD_WRAPPER_CONFIG_V2')) {
                shouldRegenerate = true;
                reason = 'legacy-wrapper-migration';
            }
        } catch {
            shouldRegenerate = true;
            reason = 'wrapper-read-failed';
        }
    }

    if (shouldRegenerate) {
        scaffoldingService.scaffoldPlaywrightConfig(workspacePath, urls, workers);
        outputChannel.appendLine(`TDAD Playwright config bundle created/updated (${reason})`);
    }
}

/**
 * Clear previous coverage data to prevent stale data across runs
 */
export function clearCoverageData(
    workspacePath: string,
    outputChannel: OutputSink
): void {
    const coverageDir = path.join(workspacePath, '.tdad', 'coverage');
    if (!fs.existsSync(coverageDir)) { return; }

    const files = fs.readdirSync(coverageDir);
    let cleared = 0;
    for (const file of files) {
        if (file === 'coverage.json' || file.startsWith('coverage-worker-')) {
            fs.unlinkSync(path.join(coverageDir, file));
            cleared++;
        }
    }
    if (cleared > 0) {
        outputChannel.appendLine(`🧹 Cleared ${cleared} previous coverage file(s)`);
    }
}

/**
 * Clear previous screenshots and trace files for a specific node
 */
export function clearNodeDebugArtifacts(
    node: Node,
    workspacePath: string,
    outputChannel: OutputSink
): void {
    const fileName = FileNameGenerator.getNodeFileName(node as any);
    const workflowFolderName = getWorkflowFolderName(node.workflowId?.replace('.workflow.json', '') || 'default');
    const nodePath = `${workflowFolderName}/${fileName}`;
    outputChannel.appendLine(`🔍 Debug path: workflowId="${node.workflowId}" -> nodePath="${nodePath}"`);

    // Clear screenshots: .tdad/debug/{workflow}/{node}/screenshots/
    const screenshotDir = path.join(workspacePath, '.tdad', 'debug', nodePath, 'screenshots');
    if (fs.existsSync(screenshotDir)) {
        const files = fs.readdirSync(screenshotDir);
        for (const file of files) {
            fs.unlinkSync(path.join(screenshotDir, file));
        }
        outputChannel.appendLine(`🧹 Cleared ${files.length} previous screenshot(s) for ${node.title}`);
    }

    // Clear trace files: .tdad/debug/{workflow}/{node}/trace-files/
    const traceDir = path.join(workspacePath, '.tdad', 'debug', nodePath, 'trace-files');
    if (fs.existsSync(traceDir)) {
        const files = fs.readdirSync(traceDir);
        for (const file of files) {
            fs.unlinkSync(path.join(traceDir, file));
        }
        outputChannel.appendLine(`🧹 Cleared ${files.length} previous trace file(s) for ${node.title}`);
    }
}

/**
 * Auto-assign test IDs to a test file if needed
 */
export function assignTestIds(
    testFilePath: string,
    workspacePath: string,
    outputChannel: OutputSink
): void {
    if (assignTestIdsToFile(testFilePath, workspacePath)) {
        outputChannel.appendLine(`🏷️ Assigned test IDs to ${path.basename(testFilePath)}`);
    }
}

/**
 * Build the Playwright command for a single test file
 */
export function buildPlaywrightCommand(testFilePath: string, workspacePath: string): string {
    const relativeTestPath = path.relative(workspacePath, testFilePath).replace(/\\/g, '/');
    return `npx playwright test ${relativeTestPath} --config=${TDAD_CONFIG_PATH} --reporter=list,json`;
}

/**
 * Build the Playwright batch command for multiple workflow folders
 */
export function buildBatchPlaywrightCommand(nodes: Node[]): string {
    const folderFilters = [...new Set(nodes.map(n => `.tdad/workflows/${getWorkflowFolderName(n.workflowId)}`))];
    return folderFilters.length > 0
        ? `npx playwright test ${folderFilters.join(' ')} --config=${TDAD_CONFIG_PATH} --reporter=list,json`
        : `npx playwright test --config=${TDAD_CONFIG_PATH} --reporter=list,json`;
}
