/**
 * FixturesGenerator - Generates TDAD fixtures file for Playwright tests
 *
 * Extracted from ScaffoldingService to comply with CLAUDE.md file size limits
 * Contains the large template for tdad-fixtures.js generation
 */

import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../../shared/utils/Logger';

export class FixturesGenerator {
    /**
     * Detect if the target project uses ES Modules
     */
    isESMProject(workspaceRoot: string): boolean {
        try {
            const packageJsonPath = path.join(workspaceRoot, 'package.json');
            if (fs.existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                return packageJson.type === 'module';
            }
        } catch {
            // Default to CommonJS
        }
        return false;
    }

    /**
     * Generate TDAD fixtures file with centralized trace capture
     * @param isESM - Whether to use ES Module syntax
     */
    scaffoldFixturesFile(isESM = false): string {
        const imports = isESM
            ? `import { test as base, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);`
            : `const { test: base, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');`;

        const usageComment = isESM
            ? `import { test, expect } from './tdad-fixtures.js';`
            : `const { test, expect } = require('./tdad-fixtures');`;

        return `/**
 * AUTO-GENERATED FILE - DO NOT EDIT
 * This file is automatically regenerated before each test run.
 * Any manual changes will be overwritten.
 *
 * Source: FixturesGenerator.scaffoldFixturesFile()
 */

/**
 * TDAD Test Fixtures - Centralized trace capture for Golden Packet
 *
 * This file extends Playwright's test with automatic:
 * - API request/response capture
 * - Console log capture
 * - Page error capture
 * - Accessibility tree snapshot (via ariaSnapshot for AI debugging)
 * - JS coverage collection
 *
 * IMPORTANT: Uses PER-WORKER files to avoid race conditions.
 * Each worker writes to coverage-worker-{index}.json
 * CoverageParser merges them after test run completes.
 *
 * Usage in test files:
 *   ${usageComment}
 */
${imports}

// Workspace root - derive from fixtures file location (.tdad/tdad-fixtures.js)
const workspaceRoot = path.dirname(__dirname);

// Coverage file management - PER-WORKER files to avoid race conditions
const coverageDir = path.join(workspaceRoot, '.tdad', 'coverage');
const workerIndex = process.env.TEST_WORKER_INDEX || process.pid.toString();
const coveragePath = path.join(coverageDir, \`coverage-worker-\${workerIndex}.json\`);

/**
 * Write trace data incrementally - each worker writes to its own file
 */
function writeTraceIncremental(testTitle, traceUpdate) {
    try {
        if (!fs.existsSync(coverageDir)) {
            fs.mkdirSync(coverageDir, { recursive: true });
        }

        let existingData = { jsCoverage: [], testTraces: {}, workerIndex: workerIndex };
        if (fs.existsSync(coveragePath)) {
            try {
                existingData = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));
            } catch (e) { /* Start fresh on parse error */ }
        }

        if (!existingData.testTraces[testTitle]) {
            existingData.testTraces[testTitle] = {
                status: 'running',
                apiRequests: [],
                consoleLogs: [],
                pageErrors: [],
                actionResult: null,
                domSnapshot: null,
                screenshotPath: null
            };
        }

        const trace = existingData.testTraces[testTitle];

        if (traceUpdate.apiRequest) {
            trace.apiRequests.push(traceUpdate.apiRequest);
        }
        if (traceUpdate.consoleLog) {
            trace.consoleLogs.push(traceUpdate.consoleLog);
        }
        if (traceUpdate.pageError) {
            trace.pageErrors.push(traceUpdate.pageError);
        }
        if (traceUpdate.status) {
            trace.status = traceUpdate.status;
        }
        if (traceUpdate.domSnapshot) {
            trace.domSnapshot = traceUpdate.domSnapshot;
        }
        if (traceUpdate.screenshotPath) {
            trace.screenshotPath = traceUpdate.screenshotPath;
        }
        if (traceUpdate.actionResult !== undefined) {
            trace.actionResult = traceUpdate.actionResult;
        }
        if (traceUpdate.jsCoverage) {
            existingData.jsCoverage.push(...traceUpdate.jsCoverage);
        }

        fs.writeFileSync(coveragePath, JSON.stringify(existingData, null, 2));
    } catch (error) {
        Logger.error('[TDAD] Failed to write trace:', error);
    }
}

// Extended test with TDAD trace capture
const test = base.extend({
    tdadTrace: [async ({ page }, use, testInfo) => {
        const testTitle = testInfo.title;

        writeTraceIncremental(testTitle, { status: 'running' });

        let coverageStarted = false;
        try {
            await page.coverage.startJSCoverage();
            coverageStarted = true;
        } catch (e) { /* Coverage not available in non-Chromium */ }

        const pendingRequests = new Map();

        page.on('request', (request) => {
            const url = request.url();
            if (!url.includes('/api/')) return;

            const entry = {
                method: request.method(),
                url: url,
                requestBody: null,
                responseBody: null,
                status: null,
                timestamp: Date.now()
            };

            const contentType = request.headers()['content-type'] || '';
            if (contentType.includes('multipart/form-data')) {
                entry.requestBody = '[FormData - file upload]';
            } else {
                try {
                    const postData = request.postData();
                    entry.requestBody = postData ? JSON.parse(postData) : null;
                } catch (e) {
                    entry.requestBody = request.postData();
                }
            }

            pendingRequests.set(url + request.method(), entry);
        });

        page.on('response', async (response) => {
            const request = response.request();
            const url = request.url();
            if (!url.includes('/api/')) return;

            const key = url + request.method();
            let entry = pendingRequests.get(key);

            if (!entry) {
                entry = {
                    method: request.method(),
                    url: url,
                    requestBody: null,
                    responseBody: null,
                    status: null,
                    timestamp: Date.now()
                };
                const contentType = request.headers()['content-type'] || '';
                if (contentType.includes('multipart/form-data')) {
                    entry.requestBody = '[FormData - file upload]';
                } else {
                    try {
                        const postData = request.postData();
                        entry.requestBody = postData ? JSON.parse(postData) : null;
                    } catch (e) {
                        entry.requestBody = request.postData();
                    }
                }
            }

            entry.status = response.status();

            try {
                const body = await response.text();
                entry.responseBody = body ? JSON.parse(body) : null;
            } catch (e) {
                entry.responseBody = null;
            }

            writeTraceIncremental(testTitle, { apiRequest: entry });
            pendingRequests.delete(key);
        });

        page.on('requestfailed', (request) => {
            const url = request.url();
            if (!url.includes('/api/')) return;

            const key = url + request.method();
            let entry = pendingRequests.get(key);

            if (!entry) {
                entry = {
                    method: request.method(),
                    url: url,
                    requestBody: null,
                    responseBody: null,
                    status: null,
                    timestamp: Date.now()
                };
                const contentType = request.headers()['content-type'] || '';
                if (contentType.includes('multipart/form-data')) {
                    entry.requestBody = '[FormData - file upload]';
                } else {
                    try {
                        const postData = request.postData();
                        entry.requestBody = postData ? JSON.parse(postData) : null;
                    } catch (e) {
                        entry.requestBody = request.postData();
                    }
                }
            }

            entry.status = 0;
            entry.responseBody = { error: request.failure()?.errorText || 'Network error' };
            writeTraceIncremental(testTitle, { apiRequest: entry });
            pendingRequests.delete(key);
        });

        page.on('console', (msg) => {
            const logEntry = {
                type: msg.type(),
                text: msg.text(),
                location: msg.location() ? \`\${msg.location().url}:\${msg.location().lineNumber}\` : null,
                timestamp: Date.now()
            };
            writeTraceIncremental(testTitle, { consoleLog: logEntry });
        });

        async function captureSnapshot() {
            try {
                const ariaYaml = await page.locator('body').ariaSnapshot();
                if (ariaYaml) {
                    return {
                        type: 'accessibility',
                        url: page.url(),
                        tree: ariaYaml
                    };
                }
            } catch (e) { /* Page might be closed */ }
            return null;
        }

        async function captureScreenshot(testTitle, testFile) {
            try {
                let workflowPath = '';
                const workflowsMatch = testFile.match(/\\.tdad[\\\\/]workflows[\\\\/](.+)[\\\\/][^\\\\/]+\\.test\\.js$/);
                if (workflowsMatch) {
                    workflowPath = workflowsMatch[1].replace(/\\\\/g, '/');
                }

                const safeTestTitle = testTitle
                    .toLowerCase()
                    .replace(/[\\s/\\\\]+/g, '-')
                    .replace(/[^a-z0-9-]/g, '')
                    .replace(/-+/g, '-')
                    .replace(/^-|-$/g, '')
                    .substring(0, 50);

                const screenshotDir = workflowPath
                    ? path.join(workspaceRoot, '.tdad', 'debug', workflowPath, 'screenshots')
                    : path.join(workspaceRoot, '.tdad', 'debug', 'screenshots');
                if (!fs.existsSync(screenshotDir)) {
                    fs.mkdirSync(screenshotDir, { recursive: true });
                }

                const fileName = \`\${safeTestTitle}.png\`;
                const filePath = path.join(screenshotDir, fileName);
                const relativePath = workflowPath
                    ? \`.tdad/debug/\${workflowPath}/screenshots/\${fileName}\`
                    : \`.tdad/debug/screenshots/\${fileName}\`;

                await page.screenshot({ path: filePath, fullPage: true });

                return relativePath;
            } catch (e) {
                return null;
            }
        }

        /**
         * Save trace JSON file directly during test teardown
         * Ensures trace files are generated regardless of how tests are run (CLI or UI)
         */
        function saveTraceFile(testTitle, testFile, trace, testStatus, testDuration, testError) {
            try {
                let workflowPath = '';
                const workflowsMatch = testFile.match(/\\.tdad[\\\\/]workflows[\\\\/](.+)[\\\\/][^\\\\/]+\\.test\\.js$/);
                if (workflowsMatch) {
                    workflowPath = workflowsMatch[1].replace(/\\\\/g, '/');
                }
                if (!workflowPath) return;

                const safeTestTitle = testTitle
                    .toLowerCase()
                    .replace(/[\\s/\\\\]+/g, '-')
                    .replace(/[^a-z0-9-]/g, '')
                    .replace(/-+/g, '-')
                    .replace(/^-|-$/g, '')
                    .substring(0, 50);

                const traceDir = path.join(workspaceRoot, '.tdad', 'debug', workflowPath, 'trace-files');
                if (!fs.existsSync(traceDir)) {
                    fs.mkdirSync(traceDir, { recursive: true });
                }

                const fileName = \`trace-\${safeTestTitle}.json\`;
                const filePath = path.join(traceDir, fileName);

                const traceData = {
                    testTitle: testTitle,
                    timestamp: new Date().toISOString(),
                    status: testStatus || trace.status || 'unknown',
                    duration: testDuration ?? trace.duration ?? null,
                    errorMessage: testError ? (testError.message || String(testError)) : null,
                    callStack: [],
                    apiRequests: trace.apiRequests || [],
                    consoleLogs: trace.consoleLogs || [],
                    pageErrors: trace.pageErrors || [],
                    actionResult: trace.actionResult || null,
                    domSnapshot: trace.domSnapshot || null,
                    screenshotPath: trace.screenshotPath || null
                };

                if (testError && testError.stack) {
                    const lines = testError.stack.split('\\n');
                    for (const line of lines) {
                        const match = line.match(/at\\s+(?:(.+?)\\s+\\()?(.+?):(\\d+):(\\d+)\\)?/);
                        if (match) {
                            traceData.callStack.push({
                                func: match[1] || undefined,
                                file: match[2],
                                line: parseInt(match[3], 10),
                                column: parseInt(match[4], 10)
                            });
                        }
                    }
                }

                fs.writeFileSync(filePath, JSON.stringify(traceData, null, 2), 'utf-8');
            } catch (e) { /* Silently fail - trace file is non-critical */ }
        }

        page.on('pageerror', async (error) => {
            const errorEntry = {
                message: error.message,
                stack: error.stack,
                timestamp: Date.now()
            };
            writeTraceIncremental(testTitle, { pageError: errorEntry });
        });

        // Create request wrapper that logs API calls automatically
        const createRequestWrapper = () => {
            const methods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'fetch'];
            const wrapper = {};

            methods.forEach(method => {
                wrapper[method] = async (url, options) => {
                    const startTime = Date.now();
                    const fullUrl = url.startsWith('http') ? url : url;

                    let requestBody = null;
                    if (options) {
                        if (options.multipart) {
                            requestBody = '[FormData - file upload]';
                        } else if (options.data) {
                            requestBody = options.data;
                        } else if (options.form) {
                            requestBody = options.form;
                        }
                    }

                    try {
                        const response = await page.request[method](url, options);
                        const duration = Date.now() - startTime;

                        let responseBody = null;
                        try {
                            const text = await response.text();
                            responseBody = text ? JSON.parse(text) : null;
                        } catch (e) {
                            // Response is not JSON, keep as null
                        }

                        const apiRequest = {
                            method: method.toUpperCase(),
                            url: response.url(),
                            status: response.status(),
                            requestBody,
                            responseBody,
                            duration,
                            timestamp: startTime
                        };

                        writeTraceIncremental(testTitle, { apiRequest });

                        return response;
                    } catch (error) {
                        const duration = Date.now() - startTime;
                        const apiRequest = {
                            method: method.toUpperCase(),
                            url: fullUrl,
                            status: 0,
                            requestBody,
                            responseBody: { error: error.message },
                            duration,
                            timestamp: startTime,
                            error: error.message
                        };

                        writeTraceIncremental(testTitle, { apiRequest });
                        throw error;
                    }
                };
            });

            return wrapper;
        };

        const traceRef = {
            addApiRequest: (req) => writeTraceIncremental(testTitle, { apiRequest: req }),
            addConsoleLog: (log) => writeTraceIncremental(testTitle, { consoleLog: log }),
            addPageError: (err) => writeTraceIncremental(testTitle, { pageError: err }),
            setActionResult: (result) => writeTraceIncremental(testTitle, { actionResult: result }),
            request: createRequestWrapper()
        };

        await use(traceRef);

        let jsCoverage = [];
        if (coverageStarted) {
            try {
                jsCoverage = await page.coverage.stopJSCoverage();
            } catch (e) { /* Ignore */ }
        }

        const isApiTest = /\\[API(-\\d+)?\\]/.test(testTitle);
        const screenshotPath = isApiTest ? null : await captureScreenshot(testTitle, testInfo.file);

        const domSnapshot = isApiTest ? null : await captureSnapshot();

        const strippedCoverage = jsCoverage.map(entry => ({
            url: entry.url,
            functions: entry.functions
        }));
        writeTraceIncremental(testTitle, {
            status: testInfo.status,
            duration: testInfo.duration,
            jsCoverage: strippedCoverage,
            domSnapshot: domSnapshot,
            screenshotPath: screenshotPath
        });

        // Save trace JSON file directly (works for both CLI and UI test runs)
        const finalTrace = {
            status: testInfo.status,
            duration: testInfo.duration,
            apiRequests: [],
            consoleLogs: [],
            pageErrors: [],
            actionResult: null,
            domSnapshot: domSnapshot,
            screenshotPath: screenshotPath
        };
        // Read back the accumulated trace data from coverage file
        try {
            if (fs.existsSync(coveragePath)) {
                const coverageData = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));
                const testTrace = coverageData.testTraces?.[testTitle];
                if (testTrace) {
                    finalTrace.apiRequests = testTrace.apiRequests || [];
                    finalTrace.consoleLogs = testTrace.consoleLogs || [];
                    finalTrace.pageErrors = testTrace.pageErrors || [];
                    finalTrace.actionResult = testTrace.actionResult;
                }
            }
        } catch (e) { /* Use empty trace if read fails */ }
        saveTraceFile(testTitle, testInfo.file, finalTrace, testInfo.status, testInfo.duration, testInfo.error);
    }, { auto: true }]
});

${isESM ? 'export { test, expect };' : 'module.exports = { test, expect };'}
`;
    }

    /**
     * Ensure TDAD fixtures file is up-to-date in the project
     */
    ensureFixturesFile(workspaceRoot: string, isESM?: boolean): string | null {
        const fixturesPath = path.join(workspaceRoot, '.tdad', 'tdad-fixtures.js');
        const fixturesDir = path.dirname(fixturesPath);

        const useESM = isESM !== undefined ? isESM : this.isESMProject(workspaceRoot);

        if (!fs.existsSync(fixturesDir)) {
            fs.mkdirSync(fixturesDir, { recursive: true });
        }

        fs.writeFileSync(fixturesPath, this.scaffoldFixturesFile(useESM), 'utf-8');
        return fixturesPath;
    }

    /**
     * Generate TDAD-specific Playwright config files:
     * - .tdad/playwright.generated.js (TDAD-managed, always overwritten)
     * - .tdad/playwright.user.js (user-owned, never overwritten after creation)
     * - .tdad/playwright.config.js (stable wrapper entrypoint used by test runs)
     */
    scaffoldPlaywrightConfig(workspaceRoot: string, urls: Record<string, string>, workers = 1): string {
        const tdadDir = path.join(workspaceRoot, '.tdad');
        if (!fs.existsSync(tdadDir)) {
            fs.mkdirSync(tdadDir, { recursive: true });
        }

        const wrapperPath = path.join(tdadDir, 'playwright.config.js');
        const generatedPath = path.join(tdadDir, 'playwright.generated.js');
        const userPath = path.join(tdadDir, 'playwright.user.js');
        const legacyBackupPath = path.join(tdadDir, 'playwright.legacy.config.backup.js');

        // Ensure global lock hook exists before writing config that references it.
        this.ensurePlaywrightGlobalLockFile(workspaceRoot);

        const isESM = this.isESMProject(workspaceRoot);
        const primaryUrl =
            urls.ui ||
            urls.frontend ||
            urls.fe ||
            urls.api ||
            urls.backend ||
            urls.be ||
            Object.values(urls)[0] ||
            // Fallback when no URLs configured - used as placeholder
            // For generated projects, URLs should be configured via .vscode/settings.json
            'http://localhost:5173';

        // One-time migration from legacy single-file config.
        this.migrateLegacyPlaywrightConfig(wrapperPath, userPath, legacyBackupPath, isESM);

        fs.writeFileSync(generatedPath, this.scaffoldPlaywrightGeneratedConfigFile(primaryUrl, workers, isESM), 'utf-8');

        if (!fs.existsSync(userPath)) {
            fs.writeFileSync(userPath, this.scaffoldPlaywrightUserConfigFile(isESM), 'utf-8');
        }

        fs.writeFileSync(wrapperPath, this.scaffoldPlaywrightWrapperConfigFile(isESM), 'utf-8');

        return wrapperPath;
    }

    /**
     * Build TDAD-managed generated Playwright config body.
     */
    scaffoldPlaywrightGeneratedConfigFile(primaryUrl: string, workers: number, isESM: boolean): string {
        const escapedUrl = primaryUrl.replace(/\\/g, '\\\\').replace(/'/g, '\\\'');

        const configBody = `{
  testDir: './workflows',
  // Cross-process lock for all Playwright runs using TDAD config.
  globalSetup: './playwright-global-lock.cjs',
  fullyParallel: ${workers > 1 ? 'true' : 'false'},
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: ${workers},
  reporter: 'html',
  use: {
    baseURL: '${escapedUrl}',
    trace: 'on-first-retry',
  },
}`;

        if (isESM) {
            return `// @ts-check
// AUTO-GENERATED FILE - DO NOT EDIT
// TDAD manages this file. Put custom overrides in .tdad/playwright.user.js.

const config = ${configBody};

export default config;
`;
        }

        return `// @ts-check
// AUTO-GENERATED FILE - DO NOT EDIT
// TDAD manages this file. Put custom overrides in .tdad/playwright.user.js.

const config = ${configBody};

module.exports = config;
`;
    }

    /**
     * Build user-owned Playwright override template.
     * This file is never overwritten by TDAD once created.
     */
    scaffoldPlaywrightUserConfigFile(isESM: boolean): string {
        if (isESM) {
            return `// USER-OWNED FILE - SAFE TO EDIT
// Add custom Playwright overrides here.
// TDAD never overwrites this file.

const userConfig = {
  // Example:
  // timeout: 120000,
  // expect: { timeout: 10000 },
};

export default userConfig;
`;
        }

        return `// USER-OWNED FILE - SAFE TO EDIT
// Add custom Playwright overrides here.
// TDAD never overwrites this file.

const userConfig = {
  // Example:
  // timeout: 120000,
  // expect: { timeout: 10000 },
};

module.exports = userConfig;
`;
    }

    /**
     * Build stable wrapper config used by TDAD test runner.
     * Keeps lock/testDir enforced while applying user overrides.
     */
    scaffoldPlaywrightWrapperConfigFile(isESM: boolean): string {
        if (isESM) {
            return `// @ts-check
// TDAD_WRAPPER_CONFIG_V2
// Stable wrapper that merges generated TDAD config with user overrides.
import { defineConfig } from '@playwright/test';
import generatedConfig from './playwright.generated.js';
import userConfig from './playwright.user.js';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) {
    return isPlainObject(override) ? { ...override } : override;
  }
  if (!isPlainObject(override)) {
    return { ...base };
  }

  const merged = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      merged[key] = deepMerge(baseValue, overrideValue);
    } else {
      merged[key] = overrideValue;
    }
  }
  return merged;
}

const mergedConfig = deepMerge(generatedConfig || {}, userConfig || {});

// Enforce TDAD-managed invariants.
mergedConfig.testDir = generatedConfig?.testDir || './workflows';
mergedConfig.globalSetup = generatedConfig?.globalSetup || './playwright-global-lock.cjs';

export default defineConfig(mergedConfig);
`;
        }

        return `// @ts-check
// TDAD_WRAPPER_CONFIG_V2
// Stable wrapper that merges generated TDAD config with user overrides.
const { defineConfig } = require('@playwright/test');
const generatedConfig = require('./playwright.generated.js');
const userConfig = require('./playwright.user.js');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) {
    return isPlainObject(override) ? { ...override } : override;
  }
  if (!isPlainObject(override)) {
    return { ...base };
  }

  const merged = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      merged[key] = deepMerge(baseValue, overrideValue);
    } else {
      merged[key] = overrideValue;
    }
  }
  return merged;
}

const mergedConfig = deepMerge(generatedConfig || {}, userConfig || {});

// Enforce TDAD-managed invariants.
mergedConfig.testDir = generatedConfig?.testDir || './workflows';
mergedConfig.globalSetup = generatedConfig?.globalSetup || './playwright-global-lock.cjs';

module.exports = defineConfig(mergedConfig);
`;
    }

    /**
     * Build migration user config that extracts safe overrides from legacy config.
     */
    scaffoldPlaywrightUserConfigFromLegacyFile(isESM: boolean): string {
        if (isESM) {
            return `// USER-OWNED FILE - SAFE TO EDIT
// Created by TDAD migration from legacy .tdad/playwright.config.js.
import generatedConfig from './playwright.generated.js';
import legacyConfig from './playwright.legacy.config.backup.js';

const blockedTopLevelKeys = new Set([
  'testDir',
  'globalSetup',
  'workers',
  'fullyParallel',
  'projects',
  'use',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diffConfig(legacyValue, generatedValue) {
  if (Array.isArray(legacyValue)) {
    return JSON.stringify(legacyValue) === JSON.stringify(generatedValue) ? undefined : legacyValue;
  }
  if (!isPlainObject(legacyValue)) {
    return legacyValue === generatedValue ? undefined : legacyValue;
  }

  const output = {};
  for (const key of Object.keys(legacyValue)) {
    if (blockedTopLevelKeys.has(key)) {
      continue;
    }

    const nestedDiff = diffConfig(legacyValue[key], generatedValue ? generatedValue[key] : undefined);
    if (nestedDiff !== undefined) {
      output[key] = nestedDiff;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

const migratedOverrides = diffConfig(legacyConfig || {}, generatedConfig || {}) || {};

export default migratedOverrides;
`;
        }

        return `// USER-OWNED FILE - SAFE TO EDIT
// Created by TDAD migration from legacy .tdad/playwright.config.js.
const generatedConfig = require('./playwright.generated.js');
const legacyConfig = require('./playwright.legacy.config.backup.js');

const blockedTopLevelKeys = new Set([
  'testDir',
  'globalSetup',
  'workers',
  'fullyParallel',
  'projects',
  'use',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diffConfig(legacyValue, generatedValue) {
  if (Array.isArray(legacyValue)) {
    return JSON.stringify(legacyValue) === JSON.stringify(generatedValue) ? undefined : legacyValue;
  }
  if (!isPlainObject(legacyValue)) {
    return legacyValue === generatedValue ? undefined : legacyValue;
  }

  const output = {};
  for (const key of Object.keys(legacyValue)) {
    if (blockedTopLevelKeys.has(key)) {
      continue;
    }

    const nestedDiff = diffConfig(legacyValue[key], generatedValue ? generatedValue[key] : undefined);
    if (nestedDiff !== undefined) {
      output[key] = nestedDiff;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

const migratedOverrides = diffConfig(legacyConfig || {}, generatedConfig || {}) || {};

module.exports = migratedOverrides;
`;
    }

    /**
     * Migrate legacy single-file TDAD config to new wrapper + user override model.
     * Legacy file is always backed up for manual recovery.
     */
    migrateLegacyPlaywrightConfig(wrapperPath: string, userPath: string, legacyBackupPath: string, isESM: boolean): void {
        if (!fs.existsSync(wrapperPath) || fs.existsSync(userPath)) {
            return;
        }

        try {
            const existingConfig = fs.readFileSync(wrapperPath, 'utf-8');

            // Already migrated wrapper; nothing to do.
            if (existingConfig.includes('TDAD_WRAPPER_CONFIG_V2')) {
                return;
            }

            if (!fs.existsSync(legacyBackupPath)) {
                fs.writeFileSync(legacyBackupPath, existingConfig, 'utf-8');
            }

            fs.writeFileSync(userPath, this.scaffoldPlaywrightUserConfigFromLegacyFile(isESM), 'utf-8');
        } catch {
            // If migration fails, fallback to fresh user template in caller.
        }
    }

    /**
     * Generate Playwright globalSetup lock hook.
     * Any run using .tdad/playwright.config.js will join the .tdad/.test-lock queue.
     */
    scaffoldPlaywrightGlobalLockFile(): string {
        return `const fs = require('fs');
const path = require('path');
const os = require('os');

const lockFile = path.join(__dirname, '.test-lock');
const timeoutMs = Number(process.env.TDAD_TEST_LOCK_TIMEOUT_MS || 1200000); // 20 min
const checkIntervalMs = 100;
const longHeldWarningThresholdMs = 300000; // 5 min warning only
const processId = process.pid;
let lockAcquired = false;
let handlersInstalled = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function detectTestTarget() {
  const args = process.argv.slice(2);
  const testPattern = /\\.(test|spec)\\.(js|ts|mjs|cjs|jsx|tsx)$/i;
  const explicitTarget = args.find(arg => testPattern.test(arg));
  return explicitTarget || null;
}

function resolveTestTargetFullPath(testTarget) {
  if (!testTarget) {
    return null;
  }
  if (path.isAbsolute(testTarget)) {
    return testTarget;
  }
  return path.resolve(process.cwd(), testTarget);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function readLockInfo() {
  try {
    if (!fs.existsSync(lockFile)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
  } catch {
    return null;
  }
}

function tryAcquire() {
  try {
    const now = new Date();
    const testTarget = detectTestTarget();
    const lockData = {
      pid: processId,
      timestamp: Date.now(),
      timestampIso: now.toISOString(),
      timestampLocal: now.toLocaleString(),
      hostname: os.hostname(),
      testTarget: testTarget,
      testTargetFullPath: resolveTestTargetFullPath(testTarget),
      cwd: process.cwd(),
      argv: process.argv.slice(2),
      command: process.argv.join(' ')
    };
    fs.writeFileSync(lockFile, JSON.stringify(lockData, null, 2), { flag: 'wx' });
    lockAcquired = true;
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return false;
    }
    console.error('[TDAD LOCK] Failed to acquire lock:', error.message || String(error));
    return false;
  }
}

function forceRelease() {
  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
    }
  } catch (error) {
    console.error('[TDAD LOCK] Failed to force-release stale lock:', error.message || String(error));
  }
}

function release() {
  if (!lockAcquired) {
    return;
  }
  try {
    if (fs.existsSync(lockFile)) {
      const lockInfo = readLockInfo();
      if (lockInfo && lockInfo.pid === processId) {
        fs.unlinkSync(lockFile);
      }
    }
  } catch (error) {
    console.error('[TDAD LOCK] Failed to release lock:', error.message || String(error));
  } finally {
    lockAcquired = false;
  }
}

async function acquireWithWait() {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (tryAcquire()) {
      return true;
    }

    const lockInfo = readLockInfo();
    if (!lockInfo) {
      forceRelease();
      continue;
    }

    if (!isProcessRunning(lockInfo.pid)) {
      forceRelease();
      continue;
    }

    const age = Date.now() - lockInfo.timestamp;
    if (age > longHeldWarningThresholdMs) {
      const ageSec = Math.floor(age / 1000);
      console.log('[TDAD LOCK] Waiting for active test lock (owner pid=' + lockInfo.pid + ', age=' + ageSec + 's)');
    }

    await sleep(checkIntervalMs);
  }

  return false;
}

function installHandlers() {
  if (handlersInstalled) {
    return;
  }
  handlersInstalled = true;

  process.on('SIGINT', () => {
    release();
    process.exit(130);
  });

  process.on('SIGTERM', () => {
    release();
    process.exit(143);
  });

  process.on('exit', () => {
    release();
  });
}

module.exports = async function globalSetup() {
  const lockDir = path.dirname(lockFile);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  installHandlers();

  const acquired = await acquireWithWait();
  if (!acquired) {
    throw new Error('[TDAD LOCK] Timeout waiting for lock at ' + lockFile);
  }

  // Optional delegate setup for project-specific bootstrapping.
  // If .tdad/globalSetup.js exists, run it under the acquired lock.
  const delegateSetupPath = path.join(__dirname, 'globalSetup.js');
  let delegateTeardown = null;
  try {
    if (fs.existsSync(delegateSetupPath)) {
      const delegateSetup = require(delegateSetupPath);
      if (typeof delegateSetup === 'function') {
        const teardown = await delegateSetup();
        if (typeof teardown === 'function') {
          delegateTeardown = teardown;
        }
      }
    }
  } catch (error) {
    release();
    throw error;
  }

  return async () => {
    try {
      if (typeof delegateTeardown === 'function') {
        await delegateTeardown();
      }
    } finally {
      release();
    }
  };
};
`;
    }

    /**
     * Ensure Playwright global lock hook exists at .tdad/playwright-global-lock.cjs
     */
    ensurePlaywrightGlobalLockFile(workspaceRoot: string): string {
        const lockHookPath = path.join(workspaceRoot, '.tdad', 'playwright-global-lock.cjs');
        const lockHookDir = path.dirname(lockHookPath);

        if (!fs.existsSync(lockHookDir)) {
            fs.mkdirSync(lockHookDir, { recursive: true });
        }

        fs.writeFileSync(lockHookPath, this.scaffoldPlaywrightGlobalLockFile(), 'utf-8');
        return lockHookPath;
    }

}
