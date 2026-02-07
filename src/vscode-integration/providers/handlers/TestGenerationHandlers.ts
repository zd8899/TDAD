/**
 * TestGenerationHandlers - Handles test code generation
 *
 * Extracted from TestWorkflowHandlers to comply with CLAUDE.md file size limits
 * Manages: Test code generation from Gherkin specs, scaffolding
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Node } from '../../../shared/types';
import { logCanvas, logError, logger } from '../../../shared/utils/Logger';
import { FileNameGenerator } from '../../../shared/utils/fileNameGenerator';
import { getWorkflowFolderName } from '../../../shared/utils/stringUtils';
import { getNodeBasePath, getFeatureFilePath, getTestFilePath, getActionFilePath, getAbsolutePath } from '../../../shared/utils/nodePathUtils';
import { FeatureMapStorage } from '../../../infrastructure/storage/FeatureMapStorage';
import { SimpleNodeManager } from '../SimpleNodeManager';
import { TestFileParser } from '../../../core/testing/TestFileParser';
import { ScaffoldingService, DependencyWiring } from '../../../core/workflows/ScaffoldingService';
import { PromptGenerationService } from '../../../core/services/PromptGenerationService';

export class TestGenerationHandlers {
    constructor(
        private readonly webview: vscode.Webview,
        private readonly storage: FeatureMapStorage,
        private readonly nodeManager: SimpleNodeManager
    ) {}

    /**
     * Generate test code from Gherkin and save to .tdad-tests/
     */
    async handleGenerateTestCode(nodeId: string, gherkinSpec: string, testFramework: string): Promise<void> {
        try {
            logCanvas('═══════════════════════════════════════════════════════════');
            logCanvas('🧪 GENERATE TEST CODE - START');
            logCanvas('═══════════════════════════════════════════════════════════');
            logCanvas(`Node ID: ${nodeId}`);
            logCanvas(`Test Framework: ${testFramework}`);

            const node = this.nodeManager.getNodeById(nodeId);
            if (!node) {
                throw new Error('Node not found');
            }

            // Read fresh feature file content from disk
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const fileName = FileNameGenerator.getNodeFileName(node as any);
            const workflowFolderName = getWorkflowFolderName(node.workflowId);
            const featureFilePath = getAbsolutePath(workspaceRoot, getFeatureFilePath(workflowFolderName, fileName));

            let actualGherkinSpec = gherkinSpec;
            try {
                const fileContent = await fs.readFile(featureFilePath, 'utf-8');
                if (fileContent && fileContent.trim()) {
                    actualGherkinSpec = fileContent;
                    logCanvas(`✅ Loaded fresh feature file content from disk: ${featureFilePath}`);
                }
            } catch (readError) {
                logCanvas(`Using webview gherkin spec (file not found on disk): ${featureFilePath}`);
            }

            gherkinSpec = actualGherkinSpec;

            logCanvas('Processing Node Dependencies');

            const dependencies = Array.isArray(node.dependencies) ? node.dependencies : [];
            const manualInputs = dependencies.map(depId => ({
                name: `dependency_${depId}`,
                sourceNodeId: depId,
                sourceOutputField: 'all'
            }));

            await this.handleGenerateTestWithManualConfig(
                nodeId,
                manualInputs,
                {
                    gherkinSpec,
                    testFramework,
                    nodeDescription: node.description
                }
            );

            return;
        } catch (error) {
            logCanvas('❌ GENERATE TEST CODE - FAILED');
            logError('AI', 'Failed to generate test code', error);
            vscode.window.showErrorMessage(`Failed to generate test code: ${error}`);
            this.webview.postMessage({
                command: 'error',
                nodeId,
                message: 'Failed to generate test code'
            });
        }
    }

    /**
     * Generate Test Code - Sprint 10: Replaced with Scaffolding
     */
    async handleGenerateTestWithManualConfig(
        nodeId: string,
        manualInputs: Array<{ name: string; sourceNodeId: string; sourceOutputField: string }>,
        generationContext: {
            gherkinSpec: string;
            testFramework: string;
            nodeDescription?: string;
        }
    ): Promise<void> {
        try {
            logCanvas('═══════════════════════════════════════════════════════════');
            logCanvas('🔄 RESUMING TEST GENERATION (Sprint 10: Scaffolding)');
            logCanvas('═══════════════════════════════════════════════════════════');

            const node = this.nodeManager.getNodeById(nodeId);
            if (!node) {
                throw new Error(`Node not found: ${nodeId}`);
            }

            const wiringsForChain = await Promise.all(manualInputs.map(async (input) => {
                const sourceNode = this.nodeManager.getNodeById(input.sourceNodeId);

                if (!sourceNode) {
                     const allNodes = this.storage.loadAll();
                     const foundNode = allNodes.find(n => n.id === input.sourceNodeId);

                     if (foundNode) {
                         const testFilePath = (foundNode as any).testCodeFile;
                         if (!testFilePath) {return null;}

                         const workspaceRoot = this.storage.getWorkspaceRoot();
                         const fullPath = path.join(workspaceRoot, testFilePath);
                         let functionName = 'performAction';

                         try {
                             const fileContent = await fs.readFile(fullPath, 'utf-8');
                             const exportsMatch = fileContent.match(/module\.exports\s*=\s*\{([^}]+)\}/);
                             if (exportsMatch) {
                                 const exportsList = exportsMatch[1].split(',').map(s => s.trim());
                                 if (exportsList.length > 0) {
                                     functionName = exportsList[0];
                                 }
                             }
                         } catch (e) { /* Ignore */ }

                         return {
                             inputName: input.name,
                             functionName,
                             filePath: testFilePath,
                             nodeId: input.sourceNodeId
                         };
                     }
                    return null;
                }

                const testFilePath = (sourceNode as any).testCodeFile;
                if (!testFilePath) {
                    return null;
                }

                const workspaceRoot = this.storage.getWorkspaceRoot();
                const fullPath = path.join(workspaceRoot, testFilePath);
                let functionName = 'performAction';

                try {
                    const fileContent = await fs.readFile(fullPath, 'utf-8');
                    const exportsMatch = fileContent.match(/module\.exports\s*=\s*\{([^}]+)\}/);
                    if (exportsMatch) {
                        const exportsList = exportsMatch[1].split(',').map(s => s.trim());
                        if (exportsList.length > 0) {
                            functionName = exportsList[0];
                        }
                    }
                } catch (e) {
                    // Ignore read error
                }

                return {
                    inputName: input.name,
                    functionName,
                    filePath: testFilePath,
                    nodeId: input.sourceNodeId
                };
            }));

            const validWirings = wiringsForChain.filter(w => w !== null) as DependencyWiring[];

            logCanvas('─────────────────────────────────────────────────────────────');
            logCanvas('📋 Sprint 10: Scaffolding Files (No AI Generation)');
            logCanvas('─────────────────────────────────────────────────────────────');

            const fileName = FileNameGenerator.getNodeFileName(node as any);
            const workflowFolderName = getWorkflowFolderName(node.workflowId);
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const basePath = getNodeBasePath(workflowFolderName, fileName);
            const testFilePath = getTestFilePath(workflowFolderName, fileName);
            const actionFilePath = getActionFilePath(workflowFolderName, fileName);

            const scaffoldingService = new ScaffoldingService();
            const created = scaffoldingService.scaffoldImplementationFilesIfNeeded(
                workspaceRoot,
                basePath,
                fileName,
                validWirings,
                generationContext.gherkinSpec
            );

            const actionFileCreated = created.actionFile !== undefined;
            const testFileCreated = created.testFile !== undefined;
            if (actionFileCreated) {
                logCanvas(`✅ Action file created: ${actionFilePath}`);
            } else {
                logCanvas(`Action file already exists, will not overwrite: ${actionFilePath}`);
            }
            if (testFileCreated) {
                logCanvas(`✅ Test file created: ${testFilePath}`);
            } else {
                logCanvas(`Test file already exists, will not overwrite: ${testFilePath}`);
            }
            if (created.fixturesFile) {
                logCanvas(`✅ Fixtures file created: ${created.fixturesFile}`);
            }

            (node as any).testCodeFile = testFilePath;
            (node as any).actionFile = actionFilePath;
            (node as any).status = 'ready-to-test';
            // Update file status fields (single source of truth)
            (node as any).hasTestDetails = testFileCreated;
            (node as any).testHasRealContent = false; // Scaffold template, not real content yet
            this.nodeManager.setNodes(
                this.nodeManager.getNodes().map(n => n.id === nodeId ? node : n)
            );

            const fullTestPath = path.join(workspaceRoot, testFilePath);
            let testCode = '';
            try {
                testCode = await fs.readFile(fullTestPath, 'utf-8');
            } catch { /* ignore */ }
            const testDetails = TestFileParser.parsePlaywrightTestDetails(testCode);

            logCanvas('📋 Generating scaffold prompt for clipboard...');

            const extensionPath = vscode.extensions.getExtension('tdad.tdad')?.extensionPath || process.cwd();
            const promptGenService = new PromptGenerationService(workspaceRoot, extensionPath);
            const allNodes = [...this.nodeManager.getNodes(), ...this.nodeManager.getAllNodes()];
            const edges = this.nodeManager.getEdges();

            const dependencies = validWirings.map(wiring => ({
                nodeId: wiring.nodeId,
                filePath: wiring.filePath,
                functionName: wiring.functionName
            }));

            const { prompt: scaffoldPrompt, promptFilePath } = await promptGenService.generateImplementPrompt({
                node,
                gherkinSpec: generationContext.gherkinSpec,
                allNodes,
                edges,
                dependencies
            });

            const fullPromptPath = path.join(workspaceRoot, promptFilePath);
            const promptToClipboard = promptGenService.readPromptFromFile(fullPromptPath) || scaffoldPrompt;

            await vscode.env.clipboard.writeText(promptToClipboard);
            logCanvas(`✅ Prompt copied to clipboard from: ${promptFilePath}`);

            this.webview.postMessage({
                command: 'testCodeGenerated',
                nodeId,
                testFilePath,
                testCode,
                testDetails
            });

            if (!actionFileCreated && !testFileCreated) {
                vscode.window.showInformationMessage('✅ Files already exist (preserved). Prompt copied to clipboard!');
            } else if (actionFileCreated && testFileCreated) {
                vscode.window.showInformationMessage('✅ Files scaffolded & prompt copied to clipboard! Paste into Claude/Cursor to implement.');
            } else {
                const createdFile = actionFileCreated ? 'action' : 'test';
                vscode.window.showInformationMessage(`✅ ${createdFile} file created, other preserved. Prompt copied to clipboard!`);
            }
            logCanvas('✅ GENERATE TEST CODE - COMPLETED SUCCESSFULLY');

        } catch (error: any) {
            logError('CANVAS', '❌ GENERATE TEST CODE - FAILED', error);
            vscode.window.showErrorMessage(`Failed to generate test code: ${error}`);
            this.webview.postMessage({
                command: 'error',
                nodeId,
                message: 'Failed to generate test code'
            });
        }
    }
}
