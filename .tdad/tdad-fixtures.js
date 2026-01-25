/**
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
 * - DOM Snapshot (accessibility tree for AI debugging)
 * - JS coverage collection
 *
 * IMPORTANT: Uses PER-WORKER files to avoid race conditions.
 * Each worker writes to coverage-worker-{index}.json
 * CoverageParser merges them after test run completes.
 *
 * Usage in test files:
 *   const { test, expect } = require('./tdad-fixtures');
 */
const { test: base, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// Workspace root - derive from fixtures file location (.tdad/tdad-fixtures.js)
const workspaceRoot = path.dirname(__dirname);

// Coverage file management - PER-WORKER files to avoid race conditions
const coverageDir = path.join(workspaceRoot, '.tdad', 'coverage');
const workerIndex = process.env.TEST_WORKER_INDEX || process.pid.toString();
const coveragePath = path.join(coverageDir, `coverage-worker-${workerIndex}.json`);

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
                location: msg.location() ? `${msg.location().url}:${msg.location().lineNumber}` : null,
                timestamp: Date.now()
            };
            writeTraceIncremental(testTitle, { consoleLog: logEntry });
        });

        async function captureSnapshot() {
            try {
                const snapshot = await page.accessibility.snapshot();
                if (snapshot) {
                    return {
                        type: 'accessibility',
                        url: page.url(),
                        tree: snapshot
                    };
                }
            } catch (e) { /* Accessibility API might not be available */ }

            try {
                const html = await page.content();
                if (html) {
                    const truncatedHtml = html.length > 5000
                        ? html.substring(0, 5000) + '\n... [truncated]'
                        : html;
                    return {
                        type: 'html',
                        url: page.url(),
                        content: truncatedHtml
                    };
                }
            } catch (e) { /* Page might be closed */ }
            return null;
        }

        async function captureScreenshot(testTitle, testFile) {
            try {
                let workflowPath = '';
                const workflowsMatch = testFile.match(/\.tdad[\\/]workflows[\\/](.+)[\\/][^\\/]+\.test\.js$/);
                if (workflowsMatch) {
                    workflowPath = workflowsMatch[1].replace(/\\/g, '/');
                }

                const safeTestTitle = testTitle
                    .toLowerCase()
                    .replace(/[\s/\\]+/g, '-')
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

                const fileName = `${safeTestTitle}.png`;
                const filePath = path.join(screenshotDir, fileName);
                const relativePath = workflowPath
                    ? `.tdad/debug/${workflowPath}/screenshots/${fileName}`
                    : `.tdad/debug/screenshots/${fileName}`;

                await page.screenshot({ path: filePath, fullPage: true });

                return relativePath;
            } catch (e) {
                return null;
            }
        }

        page.on('pageerror', async (error) => {
            const errorEntry = {
                message: error.message,
                stack: error.stack,
                timestamp: Date.now()
            };
            writeTraceIncremental(testTitle, { pageError: errorEntry });
        });

        const traceRef = {
            addApiRequest: (req) => writeTraceIncremental(testTitle, { apiRequest: req }),
            addConsoleLog: (log) => writeTraceIncremental(testTitle, { consoleLog: log }),
            addPageError: (err) => writeTraceIncremental(testTitle, { pageError: err }),
            setActionResult: (result) => writeTraceIncremental(testTitle, { actionResult: result })
        };

        await use(traceRef);

        let jsCoverage = [];
        if (coverageStarted) {
            try {
                jsCoverage = await page.coverage.stopJSCoverage();
            } catch (e) { /* Ignore */ }
        }

        const isApiTest = /\[API(-\d+)?\]/.test(testTitle);
        const screenshotPath = isApiTest ? null : await captureScreenshot(testTitle, testInfo.file);

        let domSnapshot = null;
        if (testInfo.status !== 'passed' && !isApiTest) {
            domSnapshot = await captureSnapshot();
        }

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
    }, { auto: true }]
});

module.exports = { test, expect };
