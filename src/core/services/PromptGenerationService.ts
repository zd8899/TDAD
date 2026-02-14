import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as vscode from 'vscode';
import { Node, Edge, TestResult, TestSettings } from '../../shared/types';
import { toPascalCase, getWorkflowFolderName } from '../../shared/utils/stringUtils';
import { FileNameGenerator } from '../../shared/utils/fileNameGenerator';
import { getFeatureFilePath, getActionFilePath, getTestFilePath, computeRelativeImportPath } from '../../shared/utils/nodePathUtils';
import { DocumentationRetriever } from '../../shared/utils/DocumentationRetriever';
import { PromptService } from './PromptService';
import { GoldenPacketAssembler, FixAttemptInfo } from './GoldenPacketAssembler';
import { logger, logError } from '../../shared/utils/Logger';

/**
 * Prompt types for file naming
 */
type PromptType = 'generate-bdd' | 'generate-tests' | 'golden-packet';

/**
 * PromptGenerationService - Single Source of Truth for Prompt Generation
 *
 * This service is the ONLY place where prompts are generated.
 * Both manual handlers (TestWorkflowHandlers) and automated flow (SingleNodeOrchestrator)
 * MUST use this service to ensure identical prompts.
 *
 * DO NOT duplicate prompt generation logic elsewhere.
 */
export class PromptGenerationService {
    private readonly workspacePath: string;
    private readonly extensionPath: string;
    private readonly promptService: PromptService;

    constructor(workspacePath: string, extensionPath: string) {
        this.workspacePath = workspacePath;
        this.extensionPath = extensionPath;
        this.promptService = new PromptService(extensionPath, workspacePath);
    }

    /**
     * Get test settings from VS Code configuration
     * If node has testLayers set, use that instead of global settings
     */
    private getTestSettings(node?: Node): TestSettings & { urls?: Record<string, string> } {
        const config = vscode.workspace.getConfiguration('tdad');
        const urls = config.get<Record<string, string>>('test.urls') || {};
        const globalTypes = config.get<string[]>('testTypes', ['ui', 'api']);

        // Node-level testLayers override global settings
        const types = (node?.testLayers && node.testLayers.length > 0)
            ? node.testLayers
            : globalTypes;

        return {
            types,
            coverage: config.get<boolean>('testCoverage', true),
            workers: config.get<number>('test.workers', 1),
            urls
        };
    }

    /**
     * Generate BDD (Gherkin) prompt - Single source of truth
     * Used by: handleCopyBddPrompt, SingleNodeOrchestrator.writeBddTask
     * Saves prompt to .tdad/prompts/<node-name>/bdd.md
     */
    async generateBddPrompt(params: {
        node: Node;
        featureDescription: string;
        allNodes: Node[];
        edges?: Edge[];
    }): Promise<{ prompt: string; featureFilePath: string; promptFilePath: string }> {
        const { node, featureDescription, allNodes, edges = [] } = params;

        const fileName = this.getFileName(node);
        const workflowFolderName = getWorkflowFolderName(node.workflowId);
        const featureFilePath = getFeatureFilePath(workflowFolderName, fileName);

        // Gather documentation context from node.contextFiles
        const documentationContext = await this.getDocumentationContext(node);

        // Build dependency context with file existence check (edges are single source of truth)
        const dependencyContext = await this.buildBddDependencyContext(node, allNodes, edges);

        // Get test settings (node-level testLayers override global settings)
        const testSettings = this.getTestSettings(node);

        // Generate the prompt using PromptService
        const prompt = await this.promptService.generateBddPrompt(
            node.title,
            featureDescription,
            dependencyContext,
            documentationContext,
            undefined, // testMessages
            featureFilePath,
            testSettings
        );

        // Save prompt to file (single source of truth)
        const promptFilePath = this.savePromptToFile(prompt, node.title, 'generate-bdd');

        return { prompt, featureFilePath, promptFilePath };
    }

    /**
     * Generate IMPLEMENT prompt - Single source of truth
     * Used by: handleGenerateTestCode, SingleNodeOrchestrator.writeImplementTask
     * Saves prompt to .tdad/prompts/<node-name>/implement.md
     */
    async generateImplementPrompt(params: {
        node: Node;
        gherkinSpec: string;
        allNodes: Node[];
        edges?: Edge[];
        dependencies?: Array<{
            nodeId: string;
            filePath: string;
            functionName: string;
        }>;
    }): Promise<{ prompt: string; promptFilePath: string }> {
        const { node, gherkinSpec, allNodes, edges = [], dependencies = [] } = params;

        const fileName = this.getFileName(node);
        const workflowFolderName = getWorkflowFolderName(node.workflowId);
        const actionFilePath = getActionFilePath(workflowFolderName, fileName);
        const testFilePath = getTestFilePath(workflowFolderName, fileName);

        // Get documentation context
        const documentationContext = await this.getDocumentationContext(node);

        // Build dependency info for prompt (edges are single source of truth)
        const dependencyInfo = await this.buildImplementDependencyInfo(node, allNodes, edges, dependencies, workflowFolderName);

        // Get test settings (node-level testLayers override global settings)
        const testSettings = this.getTestSettings(node);

        // Generate scaffold prompt
        const prompt = await this.promptService.generateScaffoldPrompt(
            node.title,
            node.description || '',
            gherkinSpec,
            actionFilePath,
            testFilePath,
            dependencyInfo,
            documentationContext,
            testSettings
        );

        // Save prompt to file (single source of truth)
        const promptFilePath = this.savePromptToFile(prompt, node.title, 'generate-tests');

        return { prompt, promptFilePath };
    }

    /**
     * Generate FIX prompt with Golden Packet - Single source of truth
     * Used by: SingleNodeOrchestrator.writeFixTask
     * Uses unified assembleAndSave() to save trace files and golden-packet.md
     */
    async generateFixPrompt(params: {
        node: Node;
        testResults: TestResult[];
        allNodes: Node[];
        edges?: Edge[];
        previousAttempts?: FixAttemptInfo[];
        retryCount?: number;
    }): Promise<{ prompt: string; promptFilePath: string }> {
        const { node, testResults, allNodes, edges = [], previousAttempts } = params;

        // Use unified assembleAndSave() - saves trace files AND golden-packet.md
        // isAutomated=true shows "When Done" section for AGENT_DONE.md signaling
        const goldenPacket = await GoldenPacketAssembler.assembleAndSave(
            node,
            testResults,
            this.workspacePath,
            allNodes,
            edges,
            previousAttempts,
            true  // isAutomated
        );

        return { prompt: goldenPacket, promptFilePath: '.tdad/debug/golden-packet.md' };
    }

    /**
     * Generate Multi-Feature FIX prompt - wraps per-node golden packets in a shared envelope
     * Used by: BatchTestExecutionHandler.runBatchTestFixLoop
     * Template: golden-packet-multi-feature.md (user-customizable via .tdad/prompts/)
     */
    async generateBatchFixPrompt(params: {
        failedNodes: Array<{ node: Node; testResults: TestResult[] }>;
        allNodes: Node[];
        edges?: Edge[];
        previousAttempts?: FixAttemptInfo[];
        retryCount: number;
    }): Promise<{ prompt: string; promptFilePath: string }> {
        const { failedNodes, allNodes, edges = [], previousAttempts, retryCount } = params;

        // Build the test command (same folders the test runner uses)
        const folderFilters = [...new Set(failedNodes.map(({ node }) =>
            `.tdad/workflows/${getWorkflowFolderName(node.workflowId)}`
        ))];
        const batchTestCommand = `npx playwright test ${folderFilters.join(' ')} --config=.tdad/playwright.config.js --reporter=list,json`;

        // Get shared context once (documentation + project context from first node)
        const firstNode = failedNodes[0].node;
        const documentationContext = await GoldenPacketAssembler.getDocumentationContext(firstNode, this.workspacePath);
        const projectContext = await GoldenPacketAssembler.getProjectContext(this.workspacePath);

        // Format previous attempts
        const previousAttemptsContext = GoldenPacketAssembler.formatPreviousAttempts(previousAttempts) || '';

        // Pre-assemble per-node golden packets
        const assembledNodes = [];
        for (const { node, testResults } of failedNodes) {
            const failedCount = testResults.filter(r => !r.passed).length;
            const fileName = FileNameGenerator.getNodeFileName(node as any);
            const workflowFolderName = getWorkflowFolderName(node.workflowId);
            const testFilePath = getTestFilePath(workflowFolderName, fileName);

            const goldenPacket = await GoldenPacketAssembler.assembleAndSave(
                node,
                testResults,
                this.workspacePath,
                allNodes,
                edges,
                undefined,  // previousAttempts in envelope, not per-node
                false,      // isAutomated=false (When Done is in the envelope)
                true        // batchMode=true (skip Rules, Docs, Checklist, When Done)
            );

            assembledNodes.push({
                title: node.title,
                testFilePath,
                failedCount,
                totalCount: testResults.length,
                goldenPacket
            });
        }

        // Generate prompt from template (user-customizable)
        const prompt = await this.promptService.generatePrompt('golden-packet-multi-feature', {
            projectContext,
            batchTestCommand,
            documentationContext,
            previousAttemptsContext,
            failedNodes: assembledNodes,
            totalNodes: failedNodes.length,
            retryCount
        });

        const promptFilePath = this.savePromptToFile(prompt, 'batch', 'golden-packet', retryCount);

        return { prompt, promptFilePath };
    }

    /**
     * Save context/golden packet to file (for manual copy context button)
     * Returns the file path
     */
    public saveContextToFile(context: string): string {
        return this.savePromptToFile(context, '', 'golden-packet');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PROMPT FILE MANAGEMENT - Single Source of Truth
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Clean logs before starting automation
     * Removes stale data
     */
    public cleanNodeLogs(_nodeName: string): void {
        try {
            // Clean debug directory (generated prompts and traces)
            const debugDir = path.join(this.workspacePath, '.tdad', 'debug');
            if (fsSync.existsSync(debugDir)) {
                fsSync.rmSync(debugDir, { recursive: true });
                logger.log('PROMPT-GEN-SERVICE', 'Cleaned debug directory');
            }
        } catch (error) {
            logError('PROMPT-GEN-SERVICE', 'Failed to clean debug', error);
        }
    }

    /**
     * Save a generated prompt to file and return the file path
     * Single file per prompt type - overwrites on each run
     */
    private savePromptToFile(
        prompt: string,
        _nodeName: string,
        promptType: PromptType,
        retryCount?: number
    ): string {
        try {
            // Create .tdad/debug/ directory
            const debugDir = path.join(this.workspacePath, '.tdad', 'debug');
            if (!fsSync.existsSync(debugDir)) {
                fsSync.mkdirSync(debugDir, { recursive: true });
            }

            // Single file per prompt type - overwrites on each run
            let fileName: string;
            if (promptType === 'golden-packet' && retryCount !== undefined) {
                fileName = `${promptType}-retry${retryCount}.md`;
            } else {
                fileName = `${promptType}.md`;
            }

            const filePath = path.join(debugDir, fileName);
            const relativePath = `.tdad/debug/${fileName}`;

            // Write the prompt to file
            logger.log('PROMPT-GEN-SERVICE', `Writing ${promptType} prompt to: ${filePath} (${prompt.length} chars)`);
            fsSync.writeFileSync(filePath, prompt, 'utf-8');
            logger.log('PROMPT-GEN-SERVICE', `Saved ${promptType} prompt to: ${relativePath}`);

            return relativePath;
        } catch (error) {
            logError('PROMPT-GEN-SERVICE', 'Failed to save prompt to file', error);
            return '';
        }
    }

    /**
     * Get the prompt file path for a type
     * Used when copying prompts - reads from the saved file (single source of truth)
     */
    public getLatestPromptPath(_nodeName: string, promptType: PromptType): string | null {
        try {
            const debugDir = path.join(this.workspacePath, '.tdad', 'debug');
            const filePath = path.join(debugDir, `${promptType}.md`);

            if (!fsSync.existsSync(filePath)) {
                return null;
            }

            return filePath;
        } catch (error) {
            logError('PROMPT-GEN-SERVICE', 'Failed to get prompt path', error);
            return null;
        }
    }

    /**
     * Read a prompt from file (single source of truth)
     */
    public readPromptFromFile(filePath: string): string | null {
        try {
            if (!fsSync.existsSync(filePath)) {
                return null;
            }
            return fsSync.readFileSync(filePath, 'utf-8');
        } catch (error) {
            logError('PROMPT-GEN-SERVICE', 'Failed to read prompt from file', error);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE HELPER METHODS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Get file name from node (consistent logic)
     */
    private getFileName(node: Node): string {
        return FileNameGenerator.getNodeFileName(node as any);
    }

    /**
     * Get documentation context from node.contextFiles + docsRoot (default)
     * docsRoot files are always included as context for all nodes
     */
    private async getDocumentationContext(node: Node): Promise<string> {
        // Get docsRoot from config (default: 'docs/')
        const config = vscode.workspace.getConfiguration('tdad');
        const docsRoot = config.get<string>('project.docsRoot', 'docs/');

        // Collect all context files: docsRoot files + node-specific context files
        const allContextFiles: string[] = [];

        // Add docsRoot files (if directory exists)
        if (docsRoot) {
            const docsRootFiles = await this.getFilesFromDocsRoot(docsRoot);
            allContextFiles.push(...docsRootFiles);
        }

        // Add node-specific context files
        if (node.contextFiles && node.contextFiles.length > 0) {
            // Avoid duplicates
            for (const file of node.contextFiles) {
                if (!allContextFiles.includes(file)) {
                    allContextFiles.push(file);
                }
            }
        }

        if (allContextFiles.length === 0) {
            return '';
        }

        logger.log('PROMPT-GEN-SERVICE', `Reading ${allContextFiles.length} context files (docsRoot: ${docsRoot})`);

        const fileContents = await DocumentationRetriever.readDocumentationFiles(
            allContextFiles,
            this.workspacePath
        );

        if (Object.keys(fileContents).length === 0) {
            return '';
        }

        logger.log('PROMPT-GEN-SERVICE', `Loaded ${Object.keys(fileContents).length} documentation files`);
        return DocumentationRetriever.formatDocumentationContextForPrompt(fileContents);
    }

    /**
     * Get all documentation files from docsRoot directory
     */
    private async getFilesFromDocsRoot(docsRoot: string): Promise<string[]> {
        const docsPath = path.join(this.workspacePath, docsRoot);
        const files: string[] = [];

        try {
            const entries = await fs.readdir(docsPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && this.isDocumentationFile(entry.name)) {
                    files.push(path.join(docsRoot, entry.name));
                }
            }
        } catch {
            // docsRoot directory doesn't exist - that's OK
            logger.log('PROMPT-GEN-SERVICE', `docsRoot directory not found: ${docsRoot}`);
        }

        return files;
    }

    /**
     * Check if file is a documentation file
     */
    private isDocumentationFile(fileName: string): boolean {
        const docExtensions = ['.md', '.txt', '.json', '.yaml', '.yml'];
        const ext = path.extname(fileName).toLowerCase();
        return docExtensions.includes(ext);
    }

    /**
     * Build dependency context for BDD prompt generation
     * Includes file existence check for bddSpecFile
     * Dependencies come from both edges (same-workflow) AND node.dependencies (cross-workflow)
     */
    private async buildBddDependencyContext(
        node: Node,
        allNodes: Node[],
        edges: Edge[]
    ): Promise<Array<{ name: string; description: string; bddSpecFile?: string }>> {
        const dependencyContext: Array<{ name: string; description: string; bddSpecFile?: string }> = [];

        // Merge dependencies from edges (same-workflow) AND node.dependencies (cross-workflow)
        const edgeDeps = edges
            .filter(e => e.target === node.id)
            .map(e => e.source);
        const nodeDeps = Array.isArray((node as any).dependencies) ? (node as any).dependencies as string[] : [];

        // Combine and deduplicate
        const dependencies = [...new Set([...edgeDeps, ...nodeDeps])];

        if (dependencies.length === 0) {
            return dependencyContext;
        }

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

            // Find node by matching id and optionally workflowId
            const depNode = allNodes.find(n =>
                n.id === targetNodeId &&
                (!targetWorkflowId || n.workflowId === targetWorkflowId)
            );

            if (depNode) {
                // Get bddSpecFile or compute expected path
                let bddSpecFile = (depNode as any).bddSpecFile;
                if (!bddSpecFile) {
                    const depFileName = this.getFileName(depNode);
                    const depWorkflowFolderName = getWorkflowFolderName(depNode.workflowId);
                    bddSpecFile = getFeatureFilePath(depWorkflowFolderName, depFileName);
                }

                // Only include bddSpecFile if the file actually exists on disk
                let bddSpecFileExists = false;
                try {
                    const normalizedBddPath = bddSpecFile.replace(/\//g, path.sep);
                    const fullBddPath = path.join(this.workspacePath, normalizedBddPath);
                    await fs.access(fullBddPath);
                    bddSpecFileExists = true;
                    logger.log('PROMPT-GEN-SERVICE', `BDD spec file found: ${fullBddPath}`);
                } catch {
                    bddSpecFileExists = false;
                    logger.log('PROMPT-GEN-SERVICE', `BDD spec file NOT found: ${bddSpecFile}`);
                }

                dependencyContext.push({
                    name: depNode.title || depId,
                    description: depNode.description || '',
                    bddSpecFile: bddSpecFileExists ? bddSpecFile : undefined
                });
            }
        }

        logger.log('PROMPT-GEN-SERVICE', `Built ${dependencyContext.length} dependency contexts for BDD`);
        return dependencyContext;
    }

    /**
     * Build dependency info for IMPLEMENT prompt generation
     * Dependencies come from both edges (same-workflow) AND node.dependencies (cross-workflow)
     */
    private async buildImplementDependencyInfo(
        node: Node,
        allNodes: Node[],
        edges: Edge[],
        wirings: Array<{ nodeId: string; filePath: string; functionName: string }>,
        currentWorkflowFolder: string
    ): Promise<Array<{ name: string; path: string; functionName: string; importPath: string }>> {
        const dependencyInfo: Array<{ name: string; path: string; functionName: string; importPath: string }> = [];

        // If wirings provided, use them
        if (wirings.length > 0) {
            for (const wiring of wirings) {
                const depNode = allNodes.find(n => n.id === wiring.nodeId);

                dependencyInfo.push({
                    name: depNode?.title || wiring.nodeId,
                    path: wiring.filePath,
                    functionName: wiring.functionName,
                    importPath: this.computeImportPath(wiring.filePath, currentWorkflowFolder)
                });
            }
            return dependencyInfo;
        }

        // Merge dependencies from edges (same-workflow) AND node.dependencies (cross-workflow)
        const edgeDeps = edges
            .filter(e => e.target === node.id)
            .map(e => e.source);
        const nodeDeps = Array.isArray((node as any).dependencies) ? (node as any).dependencies as string[] : [];

        // Combine and deduplicate
        const dependencies = [...new Set([...edgeDeps, ...nodeDeps])];

        if (dependencies.length === 0) {
            return dependencyInfo;
        }

        for (const depId of dependencies) {
            // Handle cross-workflow dependencies
            let targetWorkflowId: string | undefined;
            let targetNodeId: string;

            if (depId.includes('/')) {
                const [workflow, nodeIdPart] = depId.split('/');
                targetWorkflowId = workflow;
                targetNodeId = nodeIdPart;
            } else {
                targetNodeId = depId;
            }

            const depNode = allNodes.find(n =>
                n.id === targetNodeId &&
                (!targetWorkflowId || n.workflowId === targetWorkflowId)
            );

            if (depNode) {
                const depFileName = this.getFileName(depNode);
                const depWorkflowFolder = getWorkflowFolderName(depNode.workflowId);
                const depPath = getActionFilePath(depWorkflowFolder, depFileName);
                const functionName = `perform${toPascalCase(depFileName)}Action`;
                const importPath = computeRelativeImportPath(depWorkflowFolder, currentWorkflowFolder, depFileName);

                dependencyInfo.push({
                    name: depNode.title || depId,
                    path: depPath,
                    functionName,
                    importPath
                });
            }
        }

        logger.log('PROMPT-GEN-SERVICE', `Built ${dependencyInfo.length} dependency info for IMPLEMENT`);
        return dependencyInfo;
    }

    /**
     * Compute relative import path
     */
    private computeImportPath(filePath: string, currentWorkflowFolder: string): string {
        // Extract workflow folder from file path
        const match = filePath.match(/\.tdad\/workflows\/([^/]+)\//);
        const depWorkflowFolder = match ? match[1] : currentWorkflowFolder;
        const fileName = path.basename(filePath, '.action.js');

        if (depWorkflowFolder === currentWorkflowFolder) {
            return `../${fileName}/${fileName}.action.js`;
        } else {
            return `../../${depWorkflowFolder}/${fileName}/${fileName}.action.js`;
        }
    }

    /**
     * Read BDD spec from file
     */
    async readBddSpec(node: Node): Promise<string | null> {
        const fileName = this.getFileName(node);
        const workflowFolderName = getWorkflowFolderName(node.workflowId);
        const featureFilePath = path.join(this.workspacePath, getFeatureFilePath(workflowFolderName, fileName));

        try {
            const content = await fs.readFile(featureFilePath, 'utf-8');
            return content.trim() || null;
        } catch {
            return null;
        }
    }
}
