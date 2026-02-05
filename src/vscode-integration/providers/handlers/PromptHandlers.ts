/**
 * PromptHandlers - Handles prompt template and blueprint operations
 *
 * Extracted from SimplifiedWorkflowCanvasProvider to comply with CLAUDE.md file size limits
 * Manages: Prompt template opening, blueprint generation, docs folder selection, dependency picker
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { existsSync, copyFileSync, mkdirSync, writeFileSync } from 'fs';
import { logCanvas, logError } from '../../../shared/utils/Logger';
import { TestSettings } from '../../../shared/types';
import { FeatureMapStorage } from '../../../infrastructure/storage/FeatureMapStorage';
import { PromptService } from '../../../core/services/PromptService';
import { selectFilesRelative, selectFolderRelative } from '../../utils/fileDialogUtils';
import { SettingsHandlers } from './SettingsHandlers';

export class PromptHandlers {
    private _promptService: PromptService | null = null;
    private _templateUpdateCheckDone = false;

    constructor(
        private readonly webview: vscode.Webview,
        private readonly storage: FeatureMapStorage,
        private readonly extensionUri: vscode.Uri,
        private readonly settingsHandlers?: SettingsHandlers
    ) {}

    /**
     * Lazy-initialize and return PromptService
     */
    private async getPromptService(): Promise<PromptService> {
        if (!this._promptService) {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            this._promptService = new PromptService(this.extensionUri.fsPath, workspaceRoot);
        }
        return this._promptService;
    }

    /**
     * Check for updated prompt templates and notify user (once per session).
     * Sends notification through webview since Cursor cancels native VS Code notifications.
     */
    async checkForTemplateUpdates(): Promise<void> {
        if (this._templateUpdateCheckDone) {
            return;
        }
        this._templateUpdateCheckDone = true;

        try {
            const promptService = await this.getPromptService();
            const updatedTemplates = await promptService.ensureWorkspaceTemplates();

            if (updatedTemplates.length > 0) {
                // Wait for React to mount and register message listener
                await new Promise(resolve => setTimeout(resolve, 3000));
                logCanvas(`Sending templateUpdatesAvailable to webview: ${updatedTemplates.length} templates`);
                this.webview.postMessage({
                    command: 'templateUpdatesAvailable',
                    templates: updatedTemplates,
                    count: updatedTemplates.length
                });
            }
        } catch (error) {
            logError('CANVAS', 'Failed to check for template updates', error);
        }
    }

    /**
     * Handle user action on template update notification from webview
     */
    async handleTemplateUpdateAction(action: string): Promise<void> {
        try {
            const promptService = await this.getPromptService();
            const updatedTemplates = await promptService.ensureWorkspaceTemplates();
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const promptsDir = path.join(workspaceRoot, '.tdad', 'prompts');
            const extensionPromptsDir = path.join(this.extensionUri.fsPath, 'out', 'core', 'prompts');

            if (action === 'apply') {
                // Quick update: overwrite workspace templates from extension
                for (const template of updatedTemplates) {
                    const workspacePath = path.join(promptsDir, template);
                    const extensionPath = path.join(extensionPromptsDir, template);
                    if (existsSync(extensionPath)) {
                        copyFileSync(extensionPath, workspacePath);
                    }
                }
                await promptService.markTemplatesAsApplied();
                logCanvas(`Applied ${updatedTemplates.length} latest templates`);
                this.webview.postMessage({ command: 'templateUpdatesApplied' });
            } else if (action === 'update-review') {
                // Update & Review: backup all files first, then open all diffs
                const diffPairs: { backupFile: string; currentFile: string; template: string }[] = [];
                for (const template of updatedTemplates) {
                    const currentFile = path.join(promptsDir, template);
                    const extensionFile = path.join(extensionPromptsDir, template);
                    const backupFile = path.join(promptsDir, `${template}.backup`);
                    if (existsSync(currentFile) && existsSync(extensionFile)) {
                        copyFileSync(currentFile, backupFile);
                        copyFileSync(extensionFile, currentFile);
                        diffPairs.push({ backupFile, currentFile, template });
                    }
                }
                // Open all diffs concurrently so they all appear as tabs
                await Promise.all(diffPairs.map(({ backupFile, currentFile, template }) =>
                    vscode.commands.executeCommand('vscode.diff',
                        vscode.Uri.file(backupFile),
                        vscode.Uri.file(currentFile),
                        `${template}: Your Old ↔ New (editable)`
                    )
                ));
                await promptService.markTemplatesAsApplied();
                logCanvas(`Update & Review: ${updatedTemplates.length} templates with diff`);
                this.webview.postMessage({ command: 'templateUpdatesApplied' });
            }
        } catch (error) {
            logError('CANVAS', 'Failed to handle template update action', error);
        }
    }

    /**
     * Open a prompt template file for editing
     * Templates are stored in workspace/.tdad/prompts/ for user customization
     */
    async handleOpenPromptTemplate(templateName: string): Promise<void> {
        try {
            logCanvas(`=== handleOpenPromptTemplate START ===`);
            logCanvas(`Template name: ${templateName}`);

            const workspaceRoot = this.storage.getWorkspaceRoot();
            const workspacePromptsDir = path.join(workspaceRoot, '.tdad', 'prompts');

            logCanvas(`Workspace root: ${workspaceRoot}`);
            logCanvas(`Prompts directory: ${workspacePromptsDir}`);

            // Ensure .tdad/prompts/ directory exists and copy default templates
            if (!existsSync(workspacePromptsDir)) {
                logCanvas(`Creating prompts directory...`);
                mkdirSync(workspacePromptsDir, { recursive: true });
            } else {
                logCanvas(`Prompts directory already exists`);
            }

            const workspaceTemplatePath = path.join(workspacePromptsDir, `${templateName}.md`);
            logCanvas(`Workspace template path: ${workspaceTemplatePath}`);
            logCanvas(`Template exists in workspace: ${existsSync(workspaceTemplatePath)}`);

            // Copy from extension if doesn't exist in workspace
            if (!existsSync(workspaceTemplatePath)) {
                logCanvas(`Copying template from extension...`);

                let extensionTemplatePath = path.join(
                    this.extensionUri.fsPath,
                    'out',
                    'core',
                    'prompts',
                    `${templateName}.md`
                );
                logCanvas(`Trying out path: ${extensionTemplatePath} - exists: ${existsSync(extensionTemplatePath)}`);

                // Fallback to src if not found in out (development mode)
                if (!existsSync(extensionTemplatePath)) {
                    extensionTemplatePath = path.join(
                        this.extensionUri.fsPath,
                        'src',
                        'core',
                        'prompts',
                        `${templateName}.md`
                    );
                    logCanvas(`Trying src path: ${extensionTemplatePath} - exists: ${existsSync(extensionTemplatePath)}`);
                }

                if (existsSync(extensionTemplatePath)) {
                    copyFileSync(extensionTemplatePath, workspaceTemplatePath);
                    logCanvas(`✅ Copied default template to workspace: ${templateName}.md`);
                } else {
                    throw new Error(`Template not found in extension: ${templateName}.md`);
                }
            }

            // Open the workspace template
            logCanvas(`Opening document...`);
            const templateUri = vscode.Uri.file(workspaceTemplatePath);
            const document = await vscode.workspace.openTextDocument(templateUri);
            await vscode.window.showTextDocument(document);

            vscode.window.showInformationMessage(`📝 Editing: ${templateName}.md (workspace copy)`);
            logCanvas(`✅ Opened workspace prompt template successfully`);
            logCanvas(`=== handleOpenPromptTemplate END ===`);
        } catch (error) {
            logCanvas(`=== handleOpenPromptTemplate ERROR ===`);
            logError('CANVAS', `Failed to open prompt template: ${templateName}`, error);
            vscode.window.showErrorMessage(`Failed to open prompt template: ${error}`);
        }
    }

    /**
     * Generate blueprint prompt and copy to clipboard
     */
    async handleGenerateBlueprintPrompt(mode: 'idea' | 'architecture' | 'refactor', context: string): Promise<void> {
        try {
            logCanvas(`=== handleGenerateBlueprintPrompt START ===`);
            logCanvas(`Mode: ${mode}, Context: ${context.substring(0, 100)}...`);

            // Save docs root if in architecture mode
            if (mode === 'architecture' && this.settingsHandlers) {
                // We need to fetch current settings to avoid overwriting other fields with undefined
                // But handleUpdateProjectContext updates individual fields if provided?
                // Actually my implementation of handleUpdateProjectContext requires all fields if passing the whole object?
                // Let's check handleUpdateProjectContext implementation.
                // It takes ProjectContext interface which has all fields mandatory except Custom ones.
                // So I can't just pass { docsRoot: context }.
                
                // I'll skip saving here for now to avoid complexity of fetching full config, 
                // or I should make ProjectContext fields optional in the interface for update purposes?
                // But the interface is "Source of Truth".
                
                // Alternative: just update the config directly here for this one key.
                const config = vscode.workspace.getConfiguration('tdad');
                await config.update('project.docsRoot', context, vscode.ConfigurationTarget.Workspace);
            }

            const promptService = await this.getPromptService();

            // Generate the blueprint prompt
            const prompt = await promptService.generateBlueprintPrompt(mode, context);

            // Copy to clipboard
            await vscode.env.clipboard.writeText(prompt);

            vscode.window.showInformationMessage(
                `✅ Blueprint prompt copied to clipboard! Paste it into Cursor/Claude to generate the workflow.`
            );

            logCanvas(`✅ Blueprint prompt generated and copied successfully`);
            logCanvas(`=== handleGenerateBlueprintPrompt END ===`);
        } catch (error) {
            logCanvas(`=== handleGenerateBlueprintPrompt ERROR ===`);
            logError('CANVAS', `Failed to generate blueprint prompt`, error);
            vscode.window.showErrorMessage(`Failed to generate blueprint prompt: ${error}`);
        }
    }

    /**
     * Handle "Generate Project Docs" command
     * Creates template files in docs/ folder and returns paths in the prompt
     */
    async handleGenerateProjectDocs(ideaDescription: string, techStack = 'typescript-node', projectType = 'web-app', database = 'postgresql'): Promise<void> {
        try {
            logCanvas(`=== handleGenerateProjectDocs START ===`);
            logCanvas(`Tech Stack: ${techStack}, Project Type: ${projectType}, Database: ${database}`);

            // Save project context settings
            if (this.settingsHandlers) {
                await this.settingsHandlers.handleUpdateProjectContext({
                    techStack,
                    projectType,
                    database,
                    sourceRoot: 'src/',
                    docsRoot: 'docs/'
                });
            }

            const workspaceRoot = this.storage.getWorkspaceRoot();
            const docsDir = path.join(workspaceRoot, 'docs');

            // Create docs/ directory if it doesn't exist
            if (!existsSync(docsDir)) {
                mkdirSync(docsDir, { recursive: true });
                logCanvas(`Created docs/ directory`);
            }

            // Define the template files to create
            const docFiles = [
                { name: 'PRD.md', template: '# Product Requirements Document\n\n<!-- AI will fill this based on your idea -->\n' },
                { name: 'ARCHITECTURE.md', template: '# Technical Architecture\n\n<!-- AI will fill this based on your idea -->\n' },
                { name: 'README.md', template: '# Project README\n\n<!-- AI will fill this based on your idea -->\n' }
            ];

            const createdPaths: string[] = [];

            // Create template files
            for (const doc of docFiles) {
                const filePath = path.join(docsDir, doc.name);
                if (!existsSync(filePath)) {
                    writeFileSync(filePath, doc.template, 'utf-8');
                    logCanvas(`Created template: ${doc.name}`);
                }
                createdPaths.push(`docs/${doc.name}`);
            }

            // Generate prompt with file paths
            const promptService = await this.getPromptService();
            const prompt = await promptService.generateProjectDocsPrompt(ideaDescription, techStack, projectType, database, createdPaths);
            await vscode.env.clipboard.writeText(prompt);

            // Send created file paths to webview for Step 2
            this.webview.postMessage({
                command: 'docsCreated',
                files: createdPaths
            });

            vscode.window.showInformationMessage('📋 Docs prompt copied! Template files created in docs/');
            logCanvas(`=== handleGenerateProjectDocs END ===`);
        } catch (error) {
            logError('CANVAS', 'Failed to generate project docs prompt', error);
            vscode.window.showErrorMessage('Failed to generate docs prompt');
        }
    }

    /**
     * Handle "Generate Project Scaffold" command
     * Accepts array of doc file paths and test types
     */
    async handleGenerateProjectScaffold(docPaths: string[], testTypes: string[] = [], testFramework = 'vitest'): Promise<void> {
        try {
            logCanvas(`=== handleGenerateProjectScaffold START ===`);
            logCanvas(`Doc paths: ${docPaths.join(', ')}`);
            logCanvas(`Test types: ${testTypes.join(', ')}`);
            logCanvas(`Test Framework: ${testFramework}`);

            // Save test settings
            if (this.settingsHandlers) {
                const config = vscode.workspace.getConfiguration('tdad');
                const currentTestSettings: TestSettings = {
                    types: config.get<string[]>('testTypes', ['ui', 'api']),
                    coverage: config.get<boolean>('testCoverage', true),
                    workers: config.get<number>('test.workers', 1)
                };
                
                await this.settingsHandlers.handleUpdateTestSettings({
                    ...currentTestSettings,
                    types: testTypes
                });
            }

            const promptService = await this.getPromptService();
            const prompt = await promptService.generateProjectScaffoldPrompt(docPaths, testTypes, testFramework);
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage('📋 Scaffold prompt copied! Paste into AI to generate project files.');
            logCanvas(`=== handleGenerateProjectScaffold END ===`);
        } catch (error) {
            logError('CANVAS', 'Failed to generate scaffold prompt', error);
            vscode.window.showErrorMessage('Failed to generate scaffold prompt');
        }
    }

    /**
     * Handle "Select Doc File" command for adding additional doc files
     */
    async handleSelectDocFile(): Promise<void> {
        try {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const files = await selectFilesRelative(workspaceRoot, {
                title: 'Select Documentation File',
                many: false,
                filters: {
                    'Documentation': ['md', 'txt'],
                    'All Files': ['*']
                }
            });

            if (files && files.length > 0) {
                this.webview.postMessage({
                    command: 'docFileSelected',
                    file: files[0]
                });
            }
        } catch (error) {
            logError('CANVAS', 'Failed to select doc file', error);
        }
    }

    /**
     * Open folder selection dialog for documentation folder
     */
    async handleSelectDocsFolder(): Promise<void> {
        try {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const relativePath = await selectFolderRelative(workspaceRoot, {
                title: 'Select Documentation Folder'
            });

            if (relativePath) {
                this.webview.postMessage({
                    command: 'docsFolderSelected',
                    path: relativePath
                });
            }
        } catch (error) {
            logError('CANVAS', `Failed to select docs folder`, error);
        }
    }

    /**
     * Select context files for NodeForm (new nodes without nodeId)
     */
    async handleSelectContextFilesForForm(): Promise<void> {
        try {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            const files = await selectFilesRelative(workspaceRoot, {
                title: 'Select Context Files',
                many: true,
                filters: {
                    'All Files': ['*'],
                    'Documentation': ['md', 'txt', 'pdf', 'doc', 'docx'],
                    'Code': ['ts', 'js', 'tsx', 'jsx', 'json', 'yaml', 'yml']
                }
            });

            if (files) {
                this.webview.postMessage({
                    command: 'contextFilesSelectedForForm',
                    files
                });
            }
        } catch (error) {
            logError('CANVAS', `Failed to select context files for form`, error);
        }
    }

    /**
     * Get all available nodes for dependency picker (for new nodes)
     */
    async handleRequestDependencyPickerNodes(): Promise<void> {
        try {
            // Get all nodes from storage
            const allNodes = this.storage.loadAll();
            logCanvas(`[DependencyPicker] Loaded ${allNodes.length} nodes for picker`);

            // Send back to webview
            this.webview.postMessage({
                command: 'dependencyPickerNodesLoaded',
                nodes: allNodes
            });
            logCanvas(`[DependencyPicker] Sent dependencyPickerNodesLoaded message`);
        } catch (error) {
            logError('CANVAS', `Failed to load dependency picker nodes`, error);
        }
    }
}
