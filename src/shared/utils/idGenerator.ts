import * as fs from 'fs';
import * as path from 'path';

/**
 * Utility for generating unique IDs for nodes, features, and tests
 * Centralized to ensure consistency across the codebase
 */

/**
 * Generate a unique feature ID
 * Format: feature-<timestamp>-<random>
 */
export function generateFeatureId(): string {
    return `feature-${Date.now()}-${Math.random()}`;
}

/**
 * Generate a unique test ID (random)
 * Format: test-<timestamp>-<random>
 */
export function generateTestId(): string {
    return `test-${Date.now()}-${Math.random()}`;
}

// ============================================================================
// Sequential Test ID Generation (for [UI-XXX] and [API-XXX] patterns)
// ============================================================================

export type TestIdType = 'ui' | 'api';

/**
 * Scan all test files in .tdad/workflows/ and find max ID for each type
 * Finds [UI-XXX] and [API-XXX] patterns
 */
export function scanExistingTestIds(workspacePath: string): { ui: number; api: number } {
    const result = { ui: 0, api: 0 };
    const workflowsDir = path.join(workspacePath, '.tdad', 'workflows');

    if (!fs.existsSync(workflowsDir)) {
        return result;
    }

    // Patterns to match: [UI-001], [API-001], [UI-1000], etc. (any number of digits)
    const uiPattern = /\[UI-(\d+)\]/g;
    const apiPattern = /\[API-(\d+)\]/g;

    const scanDir = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scanDir(fullPath);
            } else if (entry.name.endsWith('.test.js') || entry.name.endsWith('.feature')) {
                const content = fs.readFileSync(fullPath, 'utf-8');

                // Find all UI IDs
                let match;
                while ((match = uiPattern.exec(content)) !== null) {
                    const num = parseInt(match[1], 10);
                    if (num > result.ui) {result.ui = num;}
                }
                uiPattern.lastIndex = 0; // Reset regex

                // Find all API IDs
                while ((match = apiPattern.exec(content)) !== null) {
                    const num = parseInt(match[1], 10);
                    if (num > result.api) {result.api = num;}
                }
                apiPattern.lastIndex = 0; // Reset regex
            }
        }
    };

    scanDir(workflowsDir);
    return result;
}

// ============================================================================
// Auto-assign Test IDs (runs before test execution)
// ============================================================================

/**
 * Detect if a test block is API or UI based on its content
 * API tests: use page.request, fetch, /api/ endpoints
 * UI tests: use page.goto, page.click, getByRole, etc.
 */
function detectTestType(testContent: string): TestIdType {
    // API indicators (check first - more specific)
    const apiPatterns = [
        /page\.request\./,
        /\.request\.(get|post|put|delete|patch)/i,
        /fetch\s*\(/,
        /['"`]\/api\//,
        /expect\(.*\.status\(\)\)/,
        /expect\(.*statusCode\)/,
        /response\.json\(\)/
    ];

    for (const pattern of apiPatterns) {
        if (pattern.test(testContent)) {
            return 'api';
        }
    }

    // Default to UI
    return 'ui';
}

/**
 * Assign sequential test IDs to a test file
 * Finds tests without [UI-XXX] or [API-XXX] prefixes and assigns them
 *
 * @param filePath - Path to the test file
 * @param workspacePath - Workspace root for scanning existing IDs
 * @param preferredType - Optional node-level test layer override ('ui' | 'api')
 * @returns true if file was modified, false otherwise
 */
export function assignTestIdsToFile(filePath: string, workspacePath: string, preferredType?: TestIdType): boolean {
    if (!fs.existsSync(filePath)) {
        return false;
    }

    let content = fs.readFileSync(filePath, 'utf-8');
    let modified = false;

    // Get current max IDs
    const counters = scanExistingTestIds(workspacePath);

    // Pattern to match test declarations:
    // - test('name', ...)
    // - test.skip("name", ...)
    // - test.only(`name`, ...)
    // Captures: full match, quote char, test name
    // Supports apostrophes/quotes inside titles when delimiter differs.
    const testPattern = /test(?:\.(?:skip|only))?\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

    // Pattern to check if test already has numbered ID (e.g., [UI-001], [API-002], [UI-1000], etc.)
    const hasNumberedIdPattern = /^\[(UI|API)-\d+\]/;

    // Pattern to check if test has prefix without number (e.g., [API], [UI])
    // AI generates these, we transform them to [API-XXX], [UI-XXX]
    const hasPrefixOnlyPattern = /^\[(UI|API)\]\s*/;

    let match;
    const replacements: Array<{ original: string; replacement: string }> = [];

    const extractTestBlockContent = (source: string, startIndex: number): string => {
        // Find the arrow function for this test() call and then its body block.
        // We intentionally look for the "{" that starts the function body (after =>),
        // not the "{" from destructured params like async ({ page, tdadTrace }).
        const arrowIndex = source.indexOf('=>', startIndex);
        if (arrowIndex === -1) {
            return '';
        }

        let bodyStart = -1;
        for (let i = arrowIndex + 2; i < source.length; i++) {
            const ch = source[i];
            if (ch === '{') {
                bodyStart = i;
                break;
            }
            if (!/\s/.test(ch)) {
                // Non-whitespace before body brace means unexpected shape.
                // Fall back to UI classification.
                return '';
            }
        }

        if (bodyStart === -1) {
            return '';
        }

        let braceCount = 1;
        let bodyEnd = -1;
        for (let i = bodyStart + 1; i < source.length; i++) {
            if (source[i] === '{') {
                braceCount++;
            } else if (source[i] === '}') {
                braceCount--;
                if (braceCount === 0) {
                    bodyEnd = i;
                    break;
                }
            }
        }

        return bodyEnd !== -1 ? source.substring(bodyStart, bodyEnd) : '';
    };

    while ((match = testPattern.exec(content)) !== null) {
        const fullMatch = match[0];
        const quote = match[1];
        const testName = match[2];

        // Skip if already has a numbered ID
        if (hasNumberedIdPattern.test(testName)) {
            continue;
        }

        // Check if test has prefix-only (AI generated [API] or [UI])
        const prefixMatch = testName.match(hasPrefixOnlyPattern);
        let testType: TestIdType;
        let nameWithoutPrefix: string;

        if (prefixMatch) {
            // AI provided the prefix, extract type and remove prefix from name
            testType = prefixMatch[1].toLowerCase() as TestIdType;
            nameWithoutPrefix = testName.replace(hasPrefixOnlyPattern, '');
        } else if (preferredType) {
            // Node-level test layer override (API/UI) takes precedence over content heuristics.
            testType = preferredType;
            nameWithoutPrefix = testName;
        } else {
            // No prefix - detect type from test content
            const testContent = extractTestBlockContent(content, match.index);
            testType = detectTestType(testContent);
            nameWithoutPrefix = testName;
        }

        // Generate next ID
        counters[testType]++;
        const prefix = testType === 'ui' ? 'UI' : 'API';
        const newId = `[${prefix}-${String(counters[testType]).padStart(3, '0')}]`;

        // Create replacement - numbered ID + original name (without duplicate prefix)
        const newTestName = `${newId} ${nameWithoutPrefix}`;
        const replacement = `test(${quote}${newTestName}${quote}`;

        replacements.push({ original: fullMatch, replacement });
    }

    // Apply replacements (in reverse order to maintain indices)
    for (const { original, replacement } of replacements.reverse()) {
        content = content.replace(original, replacement);
        modified = true;
    }

    if (modified) {
        fs.writeFileSync(filePath, content, 'utf-8');
    }

    return modified;
}
