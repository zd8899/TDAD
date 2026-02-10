import * as fs from 'fs';
import * as path from 'path';
import { Node } from '../types';
import { FileNameGenerator } from './fileNameGenerator';
import { getFeatureFilePath, getTestFilePath } from './nodePathUtils';
import { getWorkflowFolderName } from './stringUtils';

export interface ResolvedNodeFileStatus {
    hasBddSpec: boolean;
    hasTestDetails: boolean;
    bddHasRealContent: boolean;
    testHasRealContent: boolean;
    bddPath?: string;
    testPath?: string;
}

function normalizeWorkflowFolderName(workflowId: string | undefined): string {
    if (!workflowId) {
        return 'default';
    }
    const withoutJsonSuffix = workflowId.replace('.workflow.json', '');
    return getWorkflowFolderName(withoutJsonSuffix);
}

function toAbsolutePath(workspaceRoot: string, filePath: string | undefined): string | undefined {
    if (!filePath) {
        return undefined;
    }
    if (path.isAbsolute(filePath)) {
        return filePath;
    }
    return path.join(workspaceRoot, filePath);
}

function firstExistingPath(candidates: Array<string | undefined>): string | undefined {
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

function hasRealBddContent(content: string): boolean {
    return content.length > 0 && !content.includes('# TODO: Add more scenarios based on requirements');
}

function hasRealTestContent(content: string): boolean {
    return content.length > 0 && !content.includes("throw new Error('Test not implemented yet')");
}

export function resolveNodeFileStatus(workspaceRoot: string, node: Node): ResolvedNodeFileStatus {
    const nodeAny = node as any;
    const workflowFolderName = normalizeWorkflowFolderName(node.workflowId);
    const fileName = nodeAny.fileName || node.id || FileNameGenerator.generate(node.title);

    const canonicalFeaturePath = path.join(workspaceRoot, getFeatureFilePath(workflowFolderName, fileName));
    const canonicalFeatureLegacyPath = canonicalFeaturePath.replace(/\.feature$/, '.feature.md');
    const canonicalTestJsPath = path.join(workspaceRoot, getTestFilePath(workflowFolderName, fileName));
    const canonicalTestTsPath = canonicalTestJsPath.replace(/\.test\.js$/, '.test.ts');
    const canonicalSpecJsPath = canonicalTestJsPath.replace(/\.test\.js$/, '.spec.js');
    const canonicalSpecTsPath = canonicalTestJsPath.replace(/\.test\.js$/, '.spec.ts');

    const bddPath = firstExistingPath([
        toAbsolutePath(workspaceRoot, nodeAny.bddSpecFile),
        canonicalFeaturePath,
        canonicalFeatureLegacyPath
    ]);

    const testPath = firstExistingPath([
        toAbsolutePath(workspaceRoot, nodeAny.testCodeFile),
        canonicalTestJsPath,
        canonicalTestTsPath,
        canonicalSpecJsPath,
        canonicalSpecTsPath
    ]);

    const hasBddSpec = !!bddPath;
    const hasTestDetails = !!testPath;

    let bddHasRealContent = false;
    let testHasRealContent = false;

    if (bddPath) {
        const bddContent = fs.readFileSync(bddPath, 'utf8');
        bddHasRealContent = hasRealBddContent(bddContent);
    }

    if (testPath) {
        const testContent = fs.readFileSync(testPath, 'utf8');
        testHasRealContent = hasRealTestContent(testContent);
    }

    return {
        hasBddSpec,
        hasTestDetails,
        bddHasRealContent,
        testHasRealContent,
        bddPath,
        testPath
    };
}
