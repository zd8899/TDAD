/**
 * BddSpecHandlers - Handles BDD specification operations
 *
 * Extracted from TestWorkflowHandlers to comply with CLAUDE.md file size limits
 * Manages: BDD spec loading, generation, saving, and prompt copying
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Node } from '../../../shared/types';
import { logCanvas, logError, logger } from '../../../shared/utils/Logger';
import { FileNameGenerator } from '../../../shared/utils/fileNameGenerator';
import { getWorkflowFolderName } from '../../../shared/utils/stringUtils';
import { getNodeBasePath, getFeatureFilePath } from '../../../shared/utils/nodePathUtils';
import { FeatureMapStorage } from '../../../infrastructure/storage/FeatureMapStorage';
import { SimpleNodeManager } from '../SimpleNodeManager';
import { ScaffoldingService } from '../../../core/workflows/ScaffoldingService';
import { PromptGenerationService } from '../../../core/services/PromptGenerationService';

export class BddSpecHandlers {
    constructor(
        private readonly webview: vscode.Webview,
        private readonly storage: FeatureMapStorage,
        private readonly nodeManager: SimpleNodeManager,
        private readonly context: vscode.ExtensionContext
    ) {}

    /**
     * Load BDD Spec from file
     */
    async handleLoadBddSpec(nodeId: string, filePath: string): Promise<void> {
        try {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const fullPath = path.join(workspaceRoot, filePath);

            try {
                const content = await fs.readFile(fullPath, 'utf-8');
                this.webview.postMessage({
                    command: 'bddSpecLoaded',
                    nodeId,
                    gherkinSpec: content
                });
                logger.debug('CANVAS', `BDD spec loaded: ${filePath}`);
            } catch (readError: any) {
                if (readError.code !== 'ENOENT') {
                    logError('CANVAS', 'Failed to read BDD spec file', readError);
                }
                this.webview.postMessage({
                    command: 'bddSpecLoaded',
                    nodeId,
                    gherkinSpec: ''
                });
            }
        } catch (error) {
            logError('CANVAS', 'Failed to load BDD spec', error);
            this.webview.postMessage({
                command: 'bddSpecLoaded',
                nodeId,
                gherkinSpec: ''
            });
        }
    }

    /**
     * Load raw test file content for default detection
     */
    async handleLoadTestFileContent(nodeId: string, filePath: string): Promise<void> {
        try {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const fullPath = path.join(workspaceRoot, filePath);

            try {
                const content = await fs.readFile(fullPath, 'utf-8');
                this.webview.postMessage({
                    command: 'testFileContentLoaded',
                    nodeId,
                    content
                });
                logger.debug('CANVAS', `Test file content loaded: ${filePath}`);
            } catch (readError: any) {
                if (readError.code !== 'ENOENT') {
                    logError('CANVAS', 'Failed to read test file content', readError);
                }
                this.webview.postMessage({
                    command: 'testFileContentLoaded',
                    nodeId,
                    content: ''
                });
            }
        } catch (error) {
            logError('CANVAS', 'Failed to load test file content', error);
            this.webview.postMessage({
                command: 'testFileContentLoaded',
                nodeId,
                content: ''
            });
        }
    }

    /**
     * Generate BDD Spec - DEPRECATED in Sprint 10
     * Now just copies prompt to clipboard
     */
    async handleGenerateBddSpec(nodeId: string, featureDescription: string): Promise<void> {
        await this.handleCopyBddPrompt(nodeId, featureDescription);
    }

    /**
     * Sprint 10: Copy BDD Prompt to clipboard (no API call)
     * Sprint 14: Create .feature file scaffold to prevent overwriting
     */
    async handleCopyBddPrompt(nodeId: string, featureDescription: string): Promise<void> {
        try {
            logCanvas('Copying BDD prompt for node:', nodeId);

            const node = this.nodeManager.getNodeById(nodeId);
            if (!node) {
                throw new Error('Node not found');
            }

            const workspaceRoot = this.storage.getWorkspaceRoot();
            const extensionPath = vscode.extensions.getExtension('tdad.tdad')?.extensionPath || process.cwd();

            const fileName = FileNameGenerator.getNodeFileName(node as any);
            const workflowFolderName = getWorkflowFolderName(node.workflowId);
            const basePath = getNodeBasePath(workflowFolderName, fileName);
            const featureFilePath = getFeatureFilePath(workflowFolderName, fileName);

            const scaffoldingService = new ScaffoldingService();
            const createdPath = scaffoldingService.scaffoldFeatureFileIfNeeded(
                workspaceRoot,
                basePath,
                fileName,
                node.title || fileName,
                featureDescription
            );

            const featureFileCreated = createdPath !== null;
            if (featureFileCreated) {
                logCanvas(`✅ Feature file scaffold created: ${featureFilePath}`);

                (node as any).bddSpecFile = featureFilePath;
                this.nodeManager.updateNode(node);

                const fullFeaturePath = path.join(workspaceRoot, featureFilePath);
                let featureContent = '';
                try {
                    featureContent = await fs.readFile(fullFeaturePath, 'utf-8');
                } catch { /* ignore */ }

                this.webview.postMessage({
                    command: 'bddSpecSaved',
                    nodeId,
                    filePath: featureFilePath,
                    gherkinSpec: featureContent
                });
            } else {
                logCanvas(`Feature file already exists, will not overwrite: ${featureFilePath}`);
            }

            const promptGenService = new PromptGenerationService(workspaceRoot, extensionPath);
            const allNodes = [...this.nodeManager.getNodes(), ...this.nodeManager.getAllNodes()];
            const edges = this.nodeManager.getEdges();

            const { prompt: bddPrompt, promptFilePath } = await promptGenService.generateBddPrompt({
                node,
                featureDescription,
                allNodes,
                edges
            });

            const fullPromptPath = path.join(workspaceRoot, promptFilePath);
            const promptToClipboard = promptGenService.readPromptFromFile(fullPromptPath) || bddPrompt;

            await vscode.env.clipboard.writeText(promptToClipboard);
            logCanvas(`✅ BDD prompt copied to clipboard from: ${promptFilePath}`);

            this.webview.postMessage({
                command: 'bddPromptCopied',
                nodeId,
                bddSpecFilePath: featureFilePath
            });

            if (featureFileCreated) {
                vscode.window.showInformationMessage(`✅ Feature file created & Plan Prompt copied! Paste into your AI coding tool (Cursor, Claude Code, etc.)`);
            } else {
                vscode.window.showInformationMessage('✅ Plan Prompt copied! Paste into your AI coding tool (Cursor, Claude Code, etc.)');
            }

            logCanvas('BDD prompt copied to clipboard successfully');
        } catch (error) {
            logError('CANVAS', 'Failed to copy BDD prompt', error);
            vscode.window.showErrorMessage(`Failed to copy Plan prompt: ${error}`);

            this.webview.postMessage({
                command: 'bddPromptCopied',
                nodeId
            });
        }
    }

    /**
     * Save BDD Spec to .tdad-scenarios/[name].feature
     */
    async handleSaveBddSpec(nodeId: string, bddSpec: string, filePath: string): Promise<void> {
        try {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const fullPath = path.join(workspaceRoot, filePath);
            const dirPath = path.dirname(fullPath);

            await fs.mkdir(dirPath, { recursive: true });
            await fs.writeFile(fullPath, bddSpec, 'utf-8');

            const node = this.nodeManager.getNodeById(nodeId);
            if (node) {
                (node as any).bddSpecFile = filePath;
                (node as any).status = 'spec-saved';
                this.nodeManager.updateNode(node);
            }

            logCanvas('BDD spec saved to:', fullPath);

            this.webview.postMessage({
                command: 'bddSpecSaved',
                nodeId,
                filePath: fullPath
            });

            vscode.window.showInformationMessage(`✅ Plan saved to ${filePath}`);
        } catch (error) {
            logError('CANVAS', 'Failed to save BDD spec', error);
            vscode.window.showErrorMessage(`Failed to save plan: ${error}`);
            this.webview.postMessage({
                command: 'error',
                message: 'Failed to save BDD spec'
            });
        }
    }
}
