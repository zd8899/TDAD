import * as vscode from 'vscode';
import { Node, TestSettings, CLISettings, ProjectContext } from '../../shared/types';
import { ITestRunner } from '../testing/ITestRunner';
// MVP-ONLY: Removed non-MVP imports (NodeCreator, NodeManager, CodeGenerator, TestCaseGenerator, FeatureGenerator)
import { logAI } from '../../shared/utils/Logger';

/**
 * Message sender function type for sending messages to the webview
 */
export type MessageSender = (message: any) => void;

/**
 * MVP-ONLY WorkflowController
 * Handles: API key management, AI connection testing, model updates
 * Removed: code generation, test case generation, node creation, runTests (handled by canvas/handlers)
 */
export class WorkflowController {
    private testRunner: ITestRunner;
    private context: vscode.ExtensionContext;
    private messageSender?: MessageSender;

    constructor(context: vscode.ExtensionContext, testRunner: ITestRunner, messageSender?: MessageSender) {
        this.context = context;
        this.testRunner = testRunner;
        this.messageSender = messageSender;
        // MVP: No test history manager - tests are run directly
        // MVP: No AI provider manager - using prompt platform approach
    }

    dispose() {
        this.testRunner.dispose();
    }

    // MVP: Settings management (no AI provider needed)
    public async saveApiKey(provider: 'openai' | 'anthropic' | 'google' | 'cohere', apiKey: string): Promise<void> {
        // MVP: Store API keys in secret storage for user's external AI assistant usage
        await this.context.secrets.store(`tdad.${provider}.apiKey`, apiKey);
    }

    public async testAIConnection(_provider: 'openai' | 'anthropic' | 'google' | 'cohere'): Promise<{ ok: boolean; message?: string }> {
        // MVP: No direct AI connection - user uses external AI assistants
        return { ok: true, message: 'MVP: API keys stored for external use. Test connection in your AI assistant (Claude Code, Cursor, etc.)' };
    }

    public async getSettings(): Promise<{
        models: any[];
        secrets: { [k: string]: boolean };
        strategy?: any;
        embedding?: any;
        projectContext?: ProjectContext;
        testSettings?: TestSettings;
        cliSettings?: CLISettings;
        urls?: Record<string, string>;
    }> {
        const config = vscode.workspace.getConfiguration('tdad');
        const models = config.get<any[]>('models', []);
        const strategy = config.get<any>('strategy');
        const embedding = config.get<any>('embedding');

        // Project Context
        const projectContext: ProjectContext = {
            techStack: config.get<string>('project.techStack', 'typescript-node'),
            techStackCustom: config.get<string>('project.techStackCustom'),
            projectType: config.get<string>('project.projectType', 'web-app'),
            projectTypeCustom: config.get<string>('project.projectTypeCustom'),
            database: config.get<string>('project.database', 'postgresql'),
            databaseCustom: config.get<string>('project.databaseCustom'),
            sourceRoot: config.get<string>('project.sourceRoot', 'src/'),
            docsRoot: config.get<string>('project.docsRoot', 'docs/')
        };

        // Test settings (Playwright only: UI and API tests)
        const testSettings: TestSettings = {
            types: config.get<string[]>('testTypes', ['ui', 'api']),
            coverage: config.get<boolean>('testCoverage', true),
            workers: config.get<number>('test.workers', 1)
        };

        // Test URLs (multi-URL support)
        const urls = config.get<Record<string, string>>('test.urls') || {};

        // CLI/Autopilot settings with permission flags
        const defaultPermissionFlags = {
            claude: { dangerouslySkipPermissions: false },
            aider: { yesAlways: false, autoCommit: false },
            codex: { autoApprove: false },
            cursor: { autoApprove: false },
            gemini: { autoConfirm: false },
            opencode: { autoApprove: false }
        };
        const savedFlags = config.get<any>('agent.cli.permissionFlags');
        const cliSettings: CLISettings = {
            enabled: config.get<boolean>('agent.cli.enabled', true),
            command: config.get<string>('agent.cli.command', 'claude "{prompt}"'),
            preset: config.get<string>('agent.cli.preset', 'claude'),
            permissionFlags: savedFlags ? { ...defaultPermissionFlags, ...savedFlags } : defaultPermissionFlags
        };

        // We cannot read back secrets, only indicate presence
        return {
            models,
            secrets: {
                openai: !!(await this.context.secrets.get('tdad.openai.apiKey')),
                anthropic: !!(await this.context.secrets.get('tdad.anthropic.apiKey')),
                google: !!(await this.context.secrets.get('tdad.google.apiKey')),
                cohere: !!(await this.context.secrets.get('tdad.cohere.apiKey'))
            },
            strategy,
            embedding,
            projectContext,
            testSettings,
            cliSettings,
            urls
        };
    }

    public async updateModels(models: any[], strategy?: any): Promise<void> {
        // MVP: Store model preferences for prompt generation
        const config = vscode.workspace.getConfiguration('tdad');
        await config.update('models', models, vscode.ConfigurationTarget.Workspace);
        if (strategy !== undefined) {
            await config.update('strategy', strategy, vscode.ConfigurationTarget.Workspace);
        }
    }
}