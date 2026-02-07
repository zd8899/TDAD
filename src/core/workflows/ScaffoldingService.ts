import * as path from 'path';
import * as fs from 'fs';
import { FixturesGenerator } from './FixturesGenerator';
import { toPascalCase, toTitleCase } from '../../shared/utils/stringUtils';

/**
 * ScaffoldingService - Sprint 10: The Pivot
 *
 * Generates empty file skeletons with correct imports and structure
 * instead of full AI-generated code. This allows Cursor/Claude to fill
 * in the implementation with proper context from the Golden Packet.
 *
 * Sprint 12: Added bulk sync functionality for Blueprint workflows
 */

export interface DependencyWiring {
    inputName: string;
    functionName: string;
    filePath: string;
    nodeId: string;
}

export class ScaffoldingService {
    private readonly fixturesGenerator: FixturesGenerator;

    constructor() {
        this.fixturesGenerator = new FixturesGenerator();
    }

    /**
     * Detect if the target project uses ES Modules
     */
    isESMProject(workspaceRoot: string): boolean {
        return this.fixturesGenerator.isESMProject(workspaceRoot);
    }

    /**
     * Check if a .feature file contains only default scaffold content
     */
    isDefaultFeatureFile(content: string): boolean {
        return content.includes('# TODO: Add more scenarios based on requirements');
    }

    /**
     * Check if a .test.js file contains only default scaffold content
     */
    isDefaultTestFile(content: string): boolean {
        return content.includes("throw new Error('Test not implemented yet')");
    }

    /**
     * Check if an .action.js file contains only default scaffold content
     */
    isDefaultActionFile(content: string): boolean {
        return content.includes('not implemented yet');
    }

    /**
     * Check file status for a node
     */
    checkNodeFileStatus(
        workspaceRoot: string,
        basePath: string,
        fileName: string
    ): {
        hasBddSpec: boolean;
        hasTestDetails: boolean;
        bddHasRealContent: boolean;
        testHasRealContent: boolean;
    } {
        const baseDir = path.join(workspaceRoot, basePath);
        const featureFilePath = path.join(baseDir, `${fileName}.feature`);
        const testFilePath = path.join(baseDir, `${fileName}.test.js`);

        const hasBddSpec = fs.existsSync(featureFilePath);
        const hasTestDetails = fs.existsSync(testFilePath);

        let bddHasRealContent = false;
        let testHasRealContent = false;

        if (hasBddSpec) {
            const content = fs.readFileSync(featureFilePath, 'utf-8');
            bddHasRealContent = !this.isDefaultFeatureFile(content);
        }

        if (hasTestDetails) {
            const content = fs.readFileSync(testFilePath, 'utf-8');
            testHasRealContent = !this.isDefaultTestFile(content);
        }

        return { hasBddSpec, hasTestDetails, bddHasRealContent, testHasRealContent };
    }

    /**
     * Generate empty action file skeleton
     */
    scaffoldActionFile(
        nodeName: string,
        dependencies: DependencyWiring[] = [],
        isESM = false
    ): string {
        const functionName = `perform${toPascalCase(nodeName)}Action`;

        const imports = dependencies
            .map(dep => {
                const depNodeId = path.basename(dep.filePath, '.test.js');
                const depFolderName = path.basename(path.dirname(dep.filePath));
                const relativePath = `../${depFolderName}/${depNodeId}.action.js`;
                return isESM
                    ? `import { ${dep.functionName} } from '${relativePath}';`
                    : `const { ${dep.functionName} } = require('${relativePath}');`;
            })
            .join('\n');

        const importsSection = imports ? `${imports}\n\n` : '';
        const exportStatement = isESM
            ? `export { ${functionName} };`
            : `module.exports = { ${functionName} };`;

        return `${importsSection}/**
 * ${toTitleCase(nodeName)} Action
 *
 * TODO: Implement the business logic for this feature.
 *
 * @param {Object} page - Playwright page object
 * @param {Object} context - Test context and dependencies
 * @returns {Promise<Object>} - Returns any data needed by dependent features
 */
async function ${functionName}(page, context = {}) {
    // TODO: Implement action logic here
    throw new Error('${functionName} not implemented yet');
}

${exportStatement}
`;
    }

    /**
     * Generate empty test file skeleton
     */
    scaffoldTestFile(
        nodeName: string,
        actionRelativePath: string,
        dependencies: DependencyWiring[] = [],
        gherkinSummary?: string,
        isESM = false
    ): string {
        const functionName = `perform${toPascalCase(nodeName)}Action`;
        const actionFileName = path.basename(actionRelativePath, '.test.js') + '.action.js';

        const dependencyImports = dependencies
            .map(dep => {
                const depActionFile = path.basename(dep.filePath, '.test.js') + '.action.js';
                const relativePath = '../' + path.basename(path.dirname(dep.filePath)) + '/' + depActionFile;
                return isESM
                    ? `import { ${dep.functionName} } from '${relativePath}';`
                    : `const { ${dep.functionName} } = require('${relativePath}');`;
            })
            .join('\n');

        const importsSection = dependencyImports ? `${dependencyImports}\n` : '';

        const gherkinComment = gherkinSummary
            ? `/**
 * Test based on Gherkin specification:
 * ${gherkinSummary.split('\n').join('\n * ')}
 */\n\n`
            : '';

        const fixturesImport = isESM
            ? `import { test, expect } from '../../../tdad-fixtures.js';`
            : `const { test, expect } = require('../../../tdad-fixtures');`;
        const actionImport = isESM
            ? `import { ${functionName} } from './${actionFileName}';`
            : `const { ${functionName} } = require('./${actionFileName}');`;

        return `// TDAD fixtures provide automatic trace capture for Golden Packet
${fixturesImport}
${actionImport}
${importsSection}
${gherkinComment}test.describe('${toTitleCase(nodeName)}', () => {
    test('should complete ${nodeName} workflow', async ({ page, tdadTrace }) => {
        // TODO: Implement test steps here
        throw new Error('Test not implemented yet');
    });
});
`;
    }

    /**
     * Sprint 12: Bulk Sync - Scaffold all nodes from a workflow JSON file
     */
    async bulkSync(workflowFilePath: string, workspaceRoot: string): Promise<string[]> {
        const createdFiles: string[] = [];
        const isESM = this.isESMProject(workspaceRoot);

        const fixturesFile = this.ensureFixturesFile(workspaceRoot, isESM);
        if (fixturesFile) {
            createdFiles.push(fixturesFile);
        }

        if (!fs.existsSync(workflowFilePath)) {
            throw new Error(`Workflow file not found: ${workflowFilePath}`);
        }

        const workflowContent = fs.readFileSync(workflowFilePath, 'utf-8');
        const workflow = JSON.parse(workflowContent);

        if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
            throw new Error('Invalid workflow file: missing nodes array');
        }

        const nodeMap = new Map<string, any>();
        workflow.nodes.forEach((node: any) => {
            nodeMap.set(node.id, node);
        });

        for (const node of workflow.nodes) {
            if (node.nodeType !== 'feature') {
                continue;
            }

            const nodeId = node.id;
            const group = node.group || 'features';
            const nodeName = node.label || nodeId;
            const description = node.description || '';

            const featureDir = path.join(workspaceRoot, '.tdad', 'workflows', group, nodeId);
            const featureFile = path.join(featureDir, `${nodeId}.feature`);
            const actionFile = path.join(featureDir, `${nodeId}.action.js`);
            const testFile = path.join(featureDir, `${nodeId}.test.js`);

            if (!fs.existsSync(featureDir)) {
                fs.mkdirSync(featureDir, { recursive: true });
            }

            const dependencies: DependencyWiring[] = [];
            if (node.dependencies && Array.isArray(node.dependencies)) {
                for (const depId of node.dependencies) {
                    const depNode = nodeMap.get(depId);
                    if (depNode) {
                        const depGroup = depNode.group || 'features';
                        const depPath = path.join(workspaceRoot, '.tdad', 'workflows', depGroup, depId, `${depId}.test.js`);
                        dependencies.push({
                            inputName: depNode.label || depId,
                            functionName: `perform${toPascalCase(depId)}Action`,
                            filePath: depPath,
                            nodeId: depId
                        });
                    }
                }
            }

            if (!fs.existsSync(featureFile)) {
                const featureContent = this.scaffoldFeatureFile(nodeName, description);
                fs.writeFileSync(featureFile, featureContent, 'utf-8');
                createdFiles.push(featureFile);
            }

            if (!fs.existsSync(actionFile)) {
                const actionContent = this.scaffoldActionFile(nodeId, dependencies, isESM);
                fs.writeFileSync(actionFile, actionContent, 'utf-8');
                createdFiles.push(actionFile);
            }

            if (!fs.existsSync(testFile)) {
                const testContent = this.scaffoldTestFile(nodeId, testFile, dependencies, undefined, isESM);
                fs.writeFileSync(testFile, testContent, 'utf-8');
                createdFiles.push(testFile);
            }
        }

        return createdFiles;
    }

    /**
     * Generate Gherkin feature file skeleton
     */
    scaffoldFeatureFile(featureName: string, description: string): string {
        return `Feature: ${featureName}

  ${description}

  Scenario: ${featureName} - Happy Path
    Given the preconditions are met
    When the user performs the action
    Then the expected outcome should occur

  # TODO: Add more scenarios based on requirements
`;
    }

    /**
     * Delegate to FixturesGenerator
     */
    scaffoldFixturesFile(isESM = false): string {
        return this.fixturesGenerator.scaffoldFixturesFile(isESM);
    }

    /**
     * Delegate to FixturesGenerator
     */
    ensureFixturesFile(workspaceRoot: string, isESM?: boolean): string | null {
        return this.fixturesGenerator.ensureFixturesFile(workspaceRoot, isESM);
    }

    /**
     * Delegate to FixturesGenerator
     */
    scaffoldPlaywrightConfig(workspaceRoot: string, urls: Record<string, string>, workers = 1): string {
        return this.fixturesGenerator.scaffoldPlaywrightConfig(workspaceRoot, urls, workers);
    }

    /**
     * Sprint 17: Consolidated scaffolding method for node files
     */
    scaffoldNodeFilesIfNeeded(
        workspaceRoot: string,
        basePath: string,
        fileName: string,
        nodeTitle: string,
        nodeDescription: string,
        dependencyWirings: DependencyWiring[] = [],
        bddSpec?: string
    ): { featureFile?: string; actionFile?: string; testFile?: string; fixturesFile?: string } {
        const created: { featureFile?: string; actionFile?: string; testFile?: string; fixturesFile?: string } = {};
        const baseDir = path.join(workspaceRoot, basePath);
        const featureFilePath = path.join(baseDir, `${fileName}.feature`);
        const actionFilePath = path.join(baseDir, `${fileName}.action.js`);
        const testFilePath = path.join(baseDir, `${fileName}.test.js`);

        const isESM = this.isESMProject(workspaceRoot);

        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }

        const fixturesCreated = this.ensureFixturesFile(workspaceRoot, isESM);
        if (fixturesCreated) {
            created.fixturesFile = fixturesCreated;
        }

        if (!fs.existsSync(featureFilePath)) {
            const featureContent = this.scaffoldFeatureFile(nodeTitle, nodeDescription);
            fs.writeFileSync(featureFilePath, featureContent, 'utf-8');
            created.featureFile = featureFilePath;
        }

        if (!fs.existsSync(actionFilePath)) {
            const actionCode = this.scaffoldActionFile(fileName, dependencyWirings, isESM);
            fs.writeFileSync(actionFilePath, actionCode, 'utf-8');
            created.actionFile = actionFilePath;
        }

        if (!fs.existsSync(testFilePath)) {
            const gherkinSummary = bddSpec ? bddSpec.split('\n').slice(0, 5).join('\n') + '...' : undefined;
            const testCode = this.scaffoldTestFile(
                fileName,
                `${basePath}/${fileName}.test.js`,
                dependencyWirings,
                gherkinSummary,
                isESM
            );
            fs.writeFileSync(testFilePath, testCode, 'utf-8');
            created.testFile = testFilePath;
        }

        return created;
    }

    /**
     * Sprint 17: Scaffold only feature file if it doesn't exist
     */
    scaffoldFeatureFileIfNeeded(
        workspaceRoot: string,
        basePath: string,
        fileName: string,
        nodeTitle: string,
        nodeDescription: string
    ): string | null {
        const baseDir = path.join(workspaceRoot, basePath);
        const featureFilePath = path.join(baseDir, `${fileName}.feature`);

        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }

        if (!fs.existsSync(featureFilePath)) {
            const featureContent = this.scaffoldFeatureFile(nodeTitle, nodeDescription);
            fs.writeFileSync(featureFilePath, featureContent, 'utf-8');
            return featureFilePath;
        }
        return null;
    }

    /**
     * Sprint 17: Scaffold only action and test files if they don't exist
     */
    scaffoldImplementationFilesIfNeeded(
        workspaceRoot: string,
        basePath: string,
        fileName: string,
        dependencyWirings: DependencyWiring[] = [],
        bddSpec?: string
    ): { actionFile?: string; testFile?: string; fixturesFile?: string } {
        const created: { actionFile?: string; testFile?: string; fixturesFile?: string } = {};
        const baseDir = path.join(workspaceRoot, basePath);
        const actionFilePath = path.join(baseDir, `${fileName}.action.js`);
        const testFilePath = path.join(baseDir, `${fileName}.test.js`);

        const isESM = this.isESMProject(workspaceRoot);

        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }

        const fixturesCreated = this.ensureFixturesFile(workspaceRoot, isESM);
        if (fixturesCreated) {
            created.fixturesFile = fixturesCreated;
        }

        if (!fs.existsSync(actionFilePath)) {
            const actionCode = this.scaffoldActionFile(fileName, dependencyWirings, isESM);
            fs.writeFileSync(actionFilePath, actionCode, 'utf-8');
            created.actionFile = actionFilePath;
        }

        if (!fs.existsSync(testFilePath)) {
            const gherkinSummary = bddSpec ? bddSpec.split('\n').slice(0, 5).join('\n') + '...' : undefined;
            const testCode = this.scaffoldTestFile(
                fileName,
                `${basePath}/${fileName}.test.js`,
                dependencyWirings,
                gherkinSummary,
                isESM
            );
            fs.writeFileSync(testFilePath, testCode, 'utf-8');
            created.testFile = testFilePath;
        }

        return created;
    }
}
