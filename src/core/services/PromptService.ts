import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logCanvas } from '../../shared/utils/Logger';
import { toPascalCase } from '../../shared/utils/stringUtils';

/**
 * PromptService - Sprint 10: The Prompt Platform
 *
 * Loads markdown templates from src/core/prompts/ and injects context variables.
 * This replaces direct AI code generation - instead we provide rich prompts
 * to Cursor/Claude via clipboard.
 */

export interface PromptContext {
    [key: string]: any;
}

export class PromptService {
    private readonly extensionPromptsDir: string;
    private readonly workspacePromptsDir: string;
    private readonly workspaceRoot: string | undefined;

    constructor(extensionPath: string, workspacePath?: string) {
        // In production (packaged extension), prompts are in out/core/prompts
        // In development, prompts are in src/core/prompts
        const devPath = path.join(extensionPath, 'src', 'core', 'prompts');
        const prodPath = path.join(extensionPath, 'out', 'core', 'prompts');
        this.extensionPromptsDir = fs.existsSync(prodPath) ? prodPath : devPath;
        this.workspacePromptsDir = workspacePath
            ? path.join(workspacePath, '.tdad', 'prompts')
            : this.extensionPromptsDir;
        this.workspaceRoot = workspacePath;
    }

    /**
     * Detect if the target project uses ES Modules
     * Checks package.json for "type": "module"
     */
    private isESMProject(): boolean {
        if (!this.workspaceRoot) {
            return false;
        }
        try {
            const packageJsonPath = path.join(this.workspaceRoot, 'package.json');
            if (fs.existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                return packageJson.type === 'module';
            }
        } catch {
            // If we can't read package.json, default to CommonJS
        }
        return false;
    }

    /**
     * Calculate MD5 hash of file content
     */
    private getFileHash(filePath: string): string | null {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return crypto.createHash('md5').update(content).digest('hex');
        } catch {
            return null;
        }
    }

    /**
     * Load the hash tracking file that records which extension version was last applied per template
     */
    private loadAppliedHashes(): Record<string, string> {
        const hashFile = path.join(this.workspacePromptsDir, '.applied-hashes.json');
        try {
            if (fs.existsSync(hashFile)) {
                return JSON.parse(fs.readFileSync(hashFile, 'utf-8'));
            }
        } catch { /* ignore corrupt file */ }
        return {};
    }

    /**
     * Save the hash tracking file
     */
    private saveAppliedHashes(hashes: Record<string, string>): void {
        const hashFile = path.join(this.workspacePromptsDir, '.applied-hashes.json');
        fs.writeFileSync(hashFile, JSON.stringify(hashes, null, 2), 'utf-8');
    }

    /**
     * Ensure workspace prompts directory exists and copy default templates if needed.
     * Returns list of templates that have new versions available (for notification).
     * Uses hash tracking so users aren't re-notified after customizing an applied update.
     */
    async ensureWorkspaceTemplates(): Promise<string[]> {
        const updatedTemplates: string[] = [];

        if (this.workspacePromptsDir === this.extensionPromptsDir) {
            return updatedTemplates;
        }

        if (!fs.existsSync(this.workspacePromptsDir)) {
            fs.mkdirSync(this.workspacePromptsDir, { recursive: true });
        }

        const templates = ['generate-bdd.md', 'generate-tests.md', 'generate-blueprint.md', 'golden-packet.md', 'generate-project-docs.md', 'generate-project-scaffold.md'];
        const appliedHashes = this.loadAppliedHashes();
        let hashesChanged = false;

        for (const template of templates) {
            const workspaceTemplatePath = path.join(this.workspacePromptsDir, template);
            const extensionTemplatePath = path.join(this.extensionPromptsDir, template);
            const backupTemplatePath = path.join(this.workspacePromptsDir, `${template}.backup`);
            const latestTemplatePath = path.join(this.workspacePromptsDir, `${template}.latest`);

            // Clean up stale files from previous sessions
            if (fs.existsSync(backupTemplatePath)) { fs.unlinkSync(backupTemplatePath); }
            if (fs.existsSync(latestTemplatePath)) { fs.unlinkSync(latestTemplatePath); }

            if (!fs.existsSync(extensionTemplatePath)) {
                continue;
            }

            const extensionHash = this.getFileHash(extensionTemplatePath);

            if (!fs.existsSync(workspaceTemplatePath)) {
                // First time: copy from extension, record hash
                fs.copyFileSync(extensionTemplatePath, workspaceTemplatePath);
                if (extensionHash) {
                    appliedHashes[template] = extensionHash;
                    hashesChanged = true;
                }
            } else {
                // Workspace exists — only notify if extension has a NEWER version than last applied
                const lastAppliedHash = appliedHashes[template];

                if (extensionHash && extensionHash !== lastAppliedHash) {
                    // Extension version changed since last apply — user needs to know
                    updatedTemplates.push(template);
                }
            }
        }

        if (hashesChanged) {
            this.saveAppliedHashes(appliedHashes);
        }

        return updatedTemplates;
    }

    /**
     * Record that the current extension hashes have been applied (called after user updates)
     */
    async markTemplatesAsApplied(): Promise<void> {
        const templates = ['generate-bdd.md', 'generate-tests.md', 'generate-blueprint.md', 'golden-packet.md', 'generate-project-docs.md', 'generate-project-scaffold.md'];
        const appliedHashes = this.loadAppliedHashes();

        for (const template of templates) {
            const extensionTemplatePath = path.join(this.extensionPromptsDir, template);
            const extensionHash = this.getFileHash(extensionTemplatePath);
            if (extensionHash) {
                appliedHashes[template] = extensionHash;
            }
        }

        this.saveAppliedHashes(appliedHashes);
    }

    /**
     * Generate a prompt from a template by injecting context variables
     * @param templateName - Name of the template file (without .md extension)
     * @param context - Variables to inject into the template
     * @returns The processed prompt ready for clipboard
     */
    async generatePrompt(templateName: string, context: PromptContext): Promise<string> {
        // Ensure templates are copied to workspace
        await this.ensureWorkspaceTemplates();

        // Try workspace first, fallback to extension
        const workspaceTemplatePath = path.join(this.workspacePromptsDir, `${templateName}.md`);
        const extensionTemplatePath = path.join(this.extensionPromptsDir, `${templateName}.md`);

        let templatePath: string;
        if (fs.existsSync(workspaceTemplatePath)) {
            templatePath = workspaceTemplatePath;
            logCanvas(`Using WORKSPACE template: ${templatePath}`);
        } else if (fs.existsSync(extensionTemplatePath)) {
            templatePath = extensionTemplatePath;
            logCanvas(`Using EXTENSION template: ${templatePath}`);
        } else {
            throw new Error(`Template not found: ${templateName}.md`);
        }

        let template = fs.readFileSync(templatePath, 'utf-8');

        // Log first 500 chars of template to verify correct version
        logCanvas(`Template content (first 500 chars): ${template.substring(0, 500)}`);

        // Process the template with context
        template = this.injectVariables(template, context);
        template = this.processConditionals(template, context);
        template = this.processLoops(template, context);

        return template;
    }

    /**
     * Inject simple variables: {{variableName}} and nested properties {{obj.prop}}
     */
    private injectVariables(template: string, context: PromptContext): string {
        // First handle nested properties like {{testSettings.types}}
        template = template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_match, objName, propName) => {
            if (objName in context && typeof context[objName] === 'object' && context[objName] !== null) {
                const obj = context[objName];
                if (propName in obj) {
                    return String(obj[propName]);
                }
            }
            // Leave unmatched variables as-is
            return _match;
        });

        // Then handle simple variables like {{variableName}}
        return template.replace(/\{\{(\w+)\}\}/g, (_match, varName) => {
            if (varName in context) {
                return String(context[varName]);
            }
            // Leave unmatched variables as-is (for conditionals and loops)
            return _match;
        });
    }

    /**
     * Process conditionals: {{#if variable}} ... {{/if}}
     * Handles both simple vars {{#if var}} and nested {{#if obj.prop}}
     * Ignores {{#if this.xxx}} patterns - those are handled in processLoops
     * Uses balanced tag matching to correctly handle nested conditionals
     */
    private processConditionals(template: string, context: PromptContext): string {
        let result = template;
        let changed = true;

        while (changed) {
            changed = false;

            // Find {{#if varname}} or {{#if obj.prop}} where it doesn't start with "this."
            const openTagRegex = /\{\{#if\s+(?!this\.)(\w+(?:\.\w+)?)\}\}/g;
            let match: RegExpExecArray | null;

            // Reset regex state
            openTagRegex.lastIndex = 0;

            // Find the first conditional to process
            while ((match = openTagRegex.exec(result)) !== null) {
                const varPath = match[1];
                const startIndex = match.index;
                const afterOpenTag = startIndex + match[0].length;

                // Find matching {{/if}} by counting depth
                let depth = 1;
                let searchIndex = afterOpenTag;
                const ifOpenRegex = /\{\{#if\s+/g;
                const ifCloseRegex = /\{\{\/if\}\}/g;

                let closingIndex = -1;

                while (searchIndex < result.length && depth > 0) {
                    // Find next {{#if or {{/if}}
                    ifOpenRegex.lastIndex = searchIndex;
                    ifCloseRegex.lastIndex = searchIndex;

                    const nextOpen = ifOpenRegex.exec(result);
                    const nextClose = ifCloseRegex.exec(result);

                    if (!nextClose) {
                        // No closing tag found - malformed template
                        break;
                    }

                    // Determine which comes first
                    const openPos = nextOpen ? nextOpen.index : Infinity;
                    const closePos = nextClose.index;

                    if (closePos < openPos) {
                        // {{/if}} comes first
                        depth--;
                        if (depth === 0) {
                            closingIndex = closePos;
                            break;
                        }
                        searchIndex = closePos + nextClose[0].length;
                    } else if (nextOpen) {
                        // {{#if comes first
                        depth++;
                        searchIndex = openPos + nextOpen[0].length;
                    }
                }

                if (closingIndex !== -1) {
                    // Extract content between open and close tags
                    const fullContent = result.substring(afterOpenTag, closingIndex);

                    // Find {{else}} at depth 0 within the content
                    const elseIndex = this.findElseAtDepthZero(fullContent);
                    const ifContent = elseIndex !== -1 ? fullContent.substring(0, elseIndex) : fullContent;
                    const elseContent = elseIndex !== -1 ? fullContent.substring(elseIndex + 8) : ''; // 8 = length of "{{else}}"

                    // Check if condition is truthy - handle both simple vars and nested paths
                    let value: any;
                    if (varPath.includes('.')) {
                        const [objName, propName] = varPath.split('.');
                        value = context[objName] && typeof context[objName] === 'object'
                            ? context[objName][propName]
                            : undefined;
                    } else {
                        value = context[varPath];
                    }
                    const isTruthy = value &&
                        (typeof value !== 'string' || value.trim() !== '') &&
                        (!Array.isArray(value) || value.length > 0);

                    let replacement = '';
                    const contentToProcess = isTruthy ? ifContent : elseContent;
                    if (contentToProcess) {
                        let processed = this.injectVariables(contentToProcess, context);
                        processed = this.processLoops(processed, context);
                        replacement = processed;
                    }

                    // Replace the full conditional block (7 = length of "{{/if}}")
                    result = result.substring(0, startIndex) + replacement + result.substring(closingIndex + 7);
                    changed = true;
                    break; // Restart to handle any remaining conditionals
                }
            }
        }

        return result;
    }

    /**
     * Find {{else}} at depth 0 within content (not inside nested {{#if}})
     */
    private findElseAtDepthZero(content: string): number {
        let depth = 0;
        const ifOpenRegex = /\{\{#if\s+/g;
        const ifCloseRegex = /\{\{\/if\}\}/g;
        const elseRegex = /\{\{else\}\}/g;

        let searchIndex = 0;

        while (searchIndex < content.length) {
            ifOpenRegex.lastIndex = searchIndex;
            ifCloseRegex.lastIndex = searchIndex;
            elseRegex.lastIndex = searchIndex;

            const nextOpen = ifOpenRegex.exec(content);
            const nextClose = ifCloseRegex.exec(content);
            const nextElse = elseRegex.exec(content);

            // Find which comes first
            const openPos = nextOpen ? nextOpen.index : Infinity;
            const closePos = nextClose ? nextClose.index : Infinity;
            const elsePos = nextElse ? nextElse.index : Infinity;

            const minPos = Math.min(openPos, closePos, elsePos);

            if (minPos === Infinity) {
                break;
            }

            if (minPos === elsePos && depth === 0) {
                return elsePos;
            } else if (minPos === openPos) {
                depth++;
                searchIndex = openPos + (nextOpen ? nextOpen[0].length : 1);
            } else if (minPos === closePos) {
                depth--;
                searchIndex = closePos + 7; // length of "{{/if}}"
            } else {
                // else at non-zero depth, skip it
                searchIndex = elsePos + 8; // length of "{{else}}"
            }
        }

        return -1;
    }

    /**
     * Process loops: {{#each arrayName}} ... {{this.property}} ... {{/each}}
     * Handles nested loops and conditionals inside loop body
     * Uses balanced tag matching to correctly handle nested structures
     */
    private processLoops(template: string, context: PromptContext): string {
        let result = template;
        let changed = true;

        while (changed) {
            changed = false;

            // Find {{#each arrayName}}
            const openTagRegex = /\{\{#each\s+(\w+)\}\}/g;
            let match: RegExpExecArray | null;

            openTagRegex.lastIndex = 0;

            while ((match = openTagRegex.exec(result)) !== null) {
                const arrayName = match[1];
                const startIndex = match.index;
                const afterOpenTag = startIndex + match[0].length;

                // Find matching {{/each}} by counting depth
                let depth = 1;
                let searchIndex = afterOpenTag;
                const eachOpenRegex = /\{\{#each\s+/g;
                const eachCloseRegex = /\{\{\/each\}\}/g;

                let closingIndex = -1;

                while (searchIndex < result.length && depth > 0) {
                    eachOpenRegex.lastIndex = searchIndex;
                    eachCloseRegex.lastIndex = searchIndex;

                    const nextOpen = eachOpenRegex.exec(result);
                    const nextClose = eachCloseRegex.exec(result);

                    if (!nextClose) {
                        break;
                    }

                    const openPos = nextOpen ? nextOpen.index : Infinity;
                    const closePos = nextClose.index;

                    if (closePos < openPos) {
                        depth--;
                        if (depth === 0) {
                            closingIndex = closePos;
                            break;
                        }
                        searchIndex = closePos + nextClose[0].length;
                    } else if (nextOpen) {
                        depth++;
                        searchIndex = openPos + nextOpen[0].length;
                    }
                }

                if (closingIndex !== -1) {
                    const itemTemplate = result.substring(afterOpenTag, closingIndex);
                    const array = context[arrayName];

                    let replacement = '';
                    if (Array.isArray(array) && array.length > 0) {
                        replacement = array.map((item, index) => {
                            return this.processLoopItem(item, index, itemTemplate, context);
                        }).join('');
                    }

                    // Replace the full loop block (9 = length of "{{/each}}")
                    result = result.substring(0, startIndex) + replacement + result.substring(closingIndex + 9);
                    changed = true;
                    break;
                }
            }
        }

        return result;
    }

    /**
     * Process a single loop item with balanced tag matching for {{#if this.xxx}} blocks
     */
    private processLoopItem(item: any, index: number, itemTemplate: string, context: PromptContext): string {
        const itemContext: PromptContext = {
            ...context,
            '@index': index + 1
        };

        if (typeof item === 'object' && item !== null) {
            for (const [key, val] of Object.entries(item)) {
                itemContext[`this.${key}`] = val;
            }
            logCanvas(`processLoops item ${index}:`, JSON.stringify({
                name: item.name,
                bddSpecFile: item.bddSpecFile,
                'this.bddSpecFile in context': itemContext['this.bddSpecFile']
            }));
        }

        // Replace {{this.property}} with item values
        let processed = itemTemplate.replace(/\{\{this\.(\w+)\}\}/g, (m: string, prop: string) => {
            return item[prop] !== undefined ? String(item[prop]) : m;
        });

        // Replace {{@index}} with the current index
        processed = processed.replace(/\{\{@index\}\}/g, String(index + 1));

        // Process {{#if this.xxx}} conditionals using balanced tag matching
        processed = this.processThisConditionals(processed, itemContext);

        // Process other nested conditionals
        processed = this.processConditionals(processed, itemContext);

        // Process any remaining variables from the item context
        processed = this.injectVariables(processed, itemContext);

        return processed;
    }

    /**
     * Process {{#if this.xxx}} conditionals using balanced tag matching
     */
    private processThisConditionals(template: string, itemContext: PromptContext): string {
        let result = template;
        let changed = true;

        while (changed) {
            changed = false;

            const openTagRegex = /\{\{#if\s+(this\.\w+)\}\}/g;
            let match: RegExpExecArray | null;

            openTagRegex.lastIndex = 0;

            while ((match = openTagRegex.exec(result)) !== null) {
                const varName = match[1];
                const startIndex = match.index;
                const afterOpenTag = startIndex + match[0].length;

                // Find matching {{/if}} by counting depth
                let depth = 1;
                let searchIndex = afterOpenTag;
                const ifOpenRegex = /\{\{#if\s+/g;
                const ifCloseRegex = /\{\{\/if\}\}/g;

                let closingIndex = -1;

                while (searchIndex < result.length && depth > 0) {
                    ifOpenRegex.lastIndex = searchIndex;
                    ifCloseRegex.lastIndex = searchIndex;

                    const nextOpen = ifOpenRegex.exec(result);
                    const nextClose = ifCloseRegex.exec(result);

                    if (!nextClose) {
                        break;
                    }

                    const openPos = nextOpen ? nextOpen.index : Infinity;
                    const closePos = nextClose.index;

                    if (closePos < openPos) {
                        depth--;
                        if (depth === 0) {
                            closingIndex = closePos;
                            break;
                        }
                        searchIndex = closePos + nextClose[0].length;
                    } else if (nextOpen) {
                        depth++;
                        searchIndex = openPos + nextOpen[0].length;
                    }
                }

                if (closingIndex !== -1) {
                    const fullContent = result.substring(afterOpenTag, closingIndex);

                    // Find {{else}} at depth 0 within the content
                    const elseIndex = this.findElseAtDepthZero(fullContent);
                    const ifContent = elseIndex !== -1 ? fullContent.substring(0, elseIndex) : fullContent;
                    const elseContent = elseIndex !== -1 ? fullContent.substring(elseIndex + 8) : ''; // 8 = length of "{{else}}"

                    const value = itemContext[varName];
                    const isTruthy = value && (typeof value !== 'string' || value.trim() !== '');

                    const replacement = isTruthy ? ifContent : elseContent;

                    result = result.substring(0, startIndex) + replacement + result.substring(closingIndex + 7);
                    changed = true;
                    break;
                }
            }
        }

        return result;
    }

    /**
     * Generate the "Scaffold Feature" prompt
     * Used when user clicks "Copy Scaffolding Prompt"
     */
    async generateScaffoldPrompt(
        featureName: string,
        featureDescription: string,
        gherkinSpec: string,
        actionFilePath: string,
        testFilePath: string,
        dependencies: Array<{
            name: string;
            path: string;
            functionName: string;
            importPath: string;
        }> = [],
        documentationContext?: string,
        testSettings?: {
            types: string[];
            coverage: boolean;
        }
    ): Promise<string> {
        const workflowName = path.basename(path.dirname(path.dirname(actionFilePath)));
        const nodeName = path.basename(actionFilePath, '.action.js');
        const actionFileName = path.basename(actionFilePath, '.js').replace('.action', '');
        const actionFunctionName = `perform${toPascalCase(nodeName)}Action`;

        // Format test settings for template (uses Playwright for E2E/integration tests)
        // Check types array for 'ui' and 'api' (unified terminology)
        const scaffoldTypes = testSettings?.types || [];

        // Compute layer display from types array
        const scaffoldLayerDisplay = [
            scaffoldTypes.includes('ui') ? 'UI' : '',
            scaffoldTypes.includes('api') ? 'API' : ''
        ].filter(Boolean).join(' + ') || 'None';

        // Format URLs as Playwright project documentation
        const urls = (testSettings as any)?.urls as Record<string, string> | undefined;
        const urlsFormatted = urls ? Object.entries(urls).map(([name, url]) =>
            `- **${name}**: ${url}`
        ).join('\n') : '';

        const formattedTestSettings = testSettings ? {
            layer: scaffoldLayerDisplay,
            frontendIncluded: scaffoldTypes.includes('ui'),
            backendIncluded: scaffoldTypes.includes('api'),
            urls: urlsFormatted,
            hasUrls: !!urlsFormatted
        } : undefined;

        return await this.generatePrompt('generate-tests', {
            featureName,
            featureDescription,
            gherkinSpec,
            actionFilePath,
            testFilePath,
            actionFileName,
            actionFunctionName,
            workflowName,
            nodeName,
            dependencies,
            documentationContext: documentationContext || '',
            testSettings: formattedTestSettings,
            isESM: this.isESMProject()
        });
    }

    /**
     * Generate the "BDD Spec" prompt
     * Used as alternative to API generation
     *
     * @param featureTitle - Title of the feature (node title)
     * @param featureDescription - Description of the feature to generate BDD for
     * @param dependencyContext - Array of upstream dependencies (their names, descriptions, and BDD spec file paths)
     * @param documentationContext - Optional documentation for API contracts
     * @param testMessages - Optional specific test messages to use
     * @param targetFilePath - Optional path to the target .feature file (Sprint 14)
     * @param testSettings - Optional test settings from user preferences
     */
    async generateBddPrompt(
        featureTitle: string,
        featureDescription: string,
        dependencyContext: Array<{
            name: string;
            description: string;
            bddSpecFile?: string;
        }> = [],
        documentationContext?: string,
        testMessages?: string,
        targetFilePath?: string,
        testSettings?: {
            types: string[];
            coverage: boolean;
        }
    ): Promise<string> {
        // Log dependency context for debugging
        logCanvas('PromptService.generateBddPrompt - dependencyContext:', JSON.stringify(dependencyContext, null, 2));

        // Format test settings for template
        // Check types array for 'ui' and 'api' (unified terminology)
        const types = testSettings?.types || [];

        // Compute layer display from types array
        const layerDisplay = [
            types.includes('ui') ? 'UI' : '',
            types.includes('api') ? 'API' : ''
        ].filter(Boolean).join(' + ') || 'None';

        // Format URLs as Playwright project documentation
        const urls = (testSettings as any)?.urls as Record<string, string> | undefined;
        const urlsFormatted = urls ? Object.entries(urls).map(([name, url]) =>
            `- **${name}**: ${url}`
        ).join('\n') : '';

        const formattedTestSettings = testSettings ? {
            layer: layerDisplay,
            frontendIncluded: types.includes('ui'),
            backendIncluded: types.includes('api'),
            urls: urlsFormatted,
            hasUrls: !!urlsFormatted
        } : undefined;

        return await this.generatePrompt('generate-bdd', {
            featureTitle,
            featureDescription,
            dependencyContext,
            documentationContext: documentationContext || '',
            testMessages: testMessages || '',
            targetFilePath: targetFilePath || '',
            testSettings: formattedTestSettings
        });
    }

    /**
     * Generate the "Project Documentation" prompt
     * Stage 1 of Bootstrapping
     * @param ideaDescription - User's project idea
     * @param techStack - Selected tech stack (e.g. typescript-node)
     * @param projectType - Selected project type (e.g. web-app)
     * @param database - Selected database (e.g. postgresql)
     * @param targetFiles - Array of file paths where AI should write the docs
     */
    async generateProjectDocsPrompt(
        ideaDescription: string,
        techStack: string,
        projectType: string,
        database: string,
        targetFiles?: string[]
    ): Promise<string> {
        const targetFilesFormatted = targetFiles
            ? targetFiles.map(f => `- ${f}`).join('\n')
            : '- docs/PRD.md\n- docs/ARCHITECTURE.md\n- docs/README.md';

        return await this.generatePrompt('generate-project-docs', {
            ideaDescription,
            techStack,
            projectType,
            database,
            targetFiles: targetFilesFormatted
        });
    }

    /**
     * Generate the "Project Scaffolding" prompt
     * Stage 2 of Bootstrapping
     * @param docPaths - Array of documentation file paths to read
     * @param testTypes - Array of selected test types (e.g. unit, e2e)
     * @param testFramework - Selected test runner (e.g. vitest, jest, pytest)
     */
    async generateProjectScaffoldPrompt(docPaths: string[], testTypes: string[] = [], testFramework = 'vitest'): Promise<string> {
        const docPathsFormatted = docPaths.map(p => `- ${p}`).join('\n');
        const testTypesFormatted = testTypes.map(t => `- ${t}`).join('\n');

        return await this.generatePrompt('generate-project-scaffold', {
            docPaths: docPathsFormatted,
            testTypes: testTypesFormatted,
            testFramework
        });
    }

    /**
     * Generate the "Blueprint" prompt (Sprint 12)
     * Used when user wants to generate a project architecture blueprint
     */
    async generateBlueprintPrompt(
        mode: 'idea' | 'architecture' | 'refactor',
        context: string
    ): Promise<string> {
        const timestamp = new Date().toISOString();
        const promptContext: PromptContext = {
            mode,
            timestamp
        };

        switch (mode) {
            case 'idea':
                promptContext.ideaDescription = context;
                break;
            case 'architecture':
                // TODO: Read documentation files from the folder path
                promptContext.documentationContext = `Documentation folder: ${context}`;
                break;
            case 'refactor':
                // TODO: Scan the codebase and generate file list
                promptContext.refactorContext = `Scan path: ${context}`;
                break;
        }

        return await this.generatePrompt('generate-blueprint', promptContext);
    }
}
