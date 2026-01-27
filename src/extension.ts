import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SimplifiedWorkflowCanvasProvider } from './vscode-integration/providers/SimplifiedWorkflowCanvasProvider';
import { WorkflowEditorProvider } from './vscode-integration/providers/WorkflowEditorProvider';
import { WorkflowController } from './core/workflows/WorkflowController'; // MVP: Still needed for saveApiKey, testAIConnection, updateModels
import { TestRunner } from './vscode-integration/testing/TestRunner';
import { logExtension, logError, logger } from './shared/utils/Logger';
import { TDADBootstrap } from './vscode-integration/bootstrap/TDADBootstrap';
import { SlackService, SlackCommandHandler, SlackCommandDependencies } from './infrastructure/slack';
import { CLIAgentLauncher } from './vscode-integration/CLIAgentLauncher';

export function activate(context: vscode.ExtensionContext) {
    let workflowController: WorkflowController;

    try {
        logExtension('🚀 TDAD extension is now ACTIVATED! Version with comprehensive logging');
        logExtension('📁 Log file location: ' + logger.getLogFilePath());
        logExtension('📊 Workspace folders: ' + (vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath).join(', ') || 'None'));

        // Initialize TDAD structure if needed
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const bootstrap = new TDADBootstrap(workspaceFolder, context.extensionPath);
            bootstrap.isInitialized().then(async (initialized) => {
                if (initialized) {
                    logExtension('TDAD structure already initialized');
                    // Auto-open canvas for TDAD workspaces
                    logExtension('Auto-opening TDAD Canvas...');
                    SimplifiedWorkflowCanvasProvider.createOrShow(context.extensionUri, context);
                }
            }).catch(err => {
                logError('EXTENSION', 'Failed to check TDAD initialization', err);
            });
        }

        // Initialize WorkflowController (still needed for MVP: API key management, model updates)
        logExtension('Creating WorkflowController...');
        const testRunner = new TestRunner();
        const messageSender = (message: any) => {
            SimplifiedWorkflowCanvasProvider.currentPanel?.sendMessage(message);
        };
        workflowController = new WorkflowController(context, testRunner, messageSender);

        // MVP: No database initialization needed - using simple JSON storage
        logExtension('MVP: Using simple JSON storage (.tdad/workflows/workflow.json)');

        logExtension('TDAD Extension activated successfully');
    } catch (error) {
        logError('EXTENSION', 'TDAD Extension activation failed', error);
        vscode.window.showErrorMessage('TDAD Extension failed to activate: ' + error);
        throw error;
    }

    logExtension('Registering commands...');

    const openCanvasCommand = vscode.commands.registerCommand('tdad.openCanvas', () => {
        logExtension('openCanvas command executed');
        logExtension('Log file location: ' + logger.getLogFilePath());
        SimplifiedWorkflowCanvasProvider.createOrShow(context.extensionUri, context);
    });

    const createNodeCommand = vscode.commands.registerCommand('tdad.createNode', () => {
        logExtension('createNode command executed');
        // MVP: Node creation is handled by the webview NodeForm
        // Just show a message - the webview handles the actual creation
        vscode.window.showInformationMessage('Use the "➕ Add New Feature" button in the canvas to create nodes.');
    });


    const checkConfigCommand = vscode.commands.registerCommand('tdad.checkConfig', () => {
        logExtension('checkConfig command executed');
        const config = vscode.workspace.getConfiguration('tdad');
        const models = config.get('models', []);
        logExtension('Current models configuration', models);
        
        if (models.length === 0) {
            logExtension('ERROR: No AI models configured');
            vscode.window.showErrorMessage('No AI models configured! Please configure models in VS Code settings. Check log file: ' + logger.getLogFilePath());
            vscode.commands.executeCommand('workbench.action.openSettings', 'tdad.models');
        } else {
            logExtension(`Found ${models.length} AI model(s) configured`);
            vscode.window.showInformationMessage(`Found ${models.length} AI model(s) configured. Check log: ${logger.getLogFilePath()}`);
        }
    });


    const runAutomatedTestsCommand = vscode.commands.registerCommand('tdad.runAutomatedTests', async () => {
        logExtension('runAutomatedTests command executed');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }

        const terminal = vscode.window.createTerminal('TDAD Tests');
        terminal.show();
        terminal.sendText('npm test');
        
        vscode.window.showInformationMessage('Running all automated Jest tests...');
    });

    // Settings commands (Phase 5)
    const saveApiKeyCommand = vscode.commands.registerCommand('tdad.saveApiKey', async (provider?: 'openai' | 'anthropic' | 'google' | 'cohere', apiKeyArg?: string) => {
        try {
            const p = provider || await vscode.window.showQuickPick(['openai', 'anthropic', 'google', 'cohere'], { placeHolder: 'Select provider' }) as any;
            if (!p) {return;}
            const apiKey = apiKeyArg || await vscode.window.showInputBox({ prompt: `Enter API key for ${p}`, password: true });
            if (!apiKey) {return;}
            await workflowController.saveApiKey(p, apiKey);
            vscode.window.showInformationMessage(`${p} API key saved.`);
        } catch (e) {
            logError('EXTENSION', 'Failed to save API key', e);
            vscode.window.showErrorMessage('Failed to save API key');
        }
    });

    // COMMAND: Configure Test URLs (multi-URL support)
    const configureUrlsCommand = vscode.commands.registerCommand('tdad.configureUrls', async () => {
        const config = vscode.workspace.getConfiguration('tdad');
        const urls = config.get<Record<string, string>>('test.urls') || {};

        const actions = [
            { label: '$(add) Add New URL', action: 'add' },
            { label: '$(edit) Edit Existing URL', action: 'edit' },
            { label: '$(trash) Remove URL', action: 'remove' },
            ...Object.entries(urls).map(([name, url]) => ({
                label: `$(globe) ${name}: ${url}`,
                action: 'show',
                name,
                url
            }))
        ];

        const selected = await vscode.window.showQuickPick(actions, {
            placeHolder: 'Configure Test URLs (ui, api, auth, etc.)'
        });

        if (!selected) { return; }

        if (selected.action === 'add') {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter URL name (e.g., ui, api, auth)',
                placeHolder: 'api'
            });
            if (!name) { return; }

            const url = await vscode.window.showInputBox({
                prompt: `Enter URL for "${name}"`,
                placeHolder: 'http://localhost:8080'
            });
            if (!url) { return; }

            const newUrls = { ...urls, [name.toLowerCase()]: url };
            await config.update('test.urls', newUrls, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(`Added ${name}: ${url}`);
            updateUrlsStatusBar(newUrls);
        } else if (selected.action === 'edit') {
            const urlNames = Object.keys(urls);
            if (urlNames.length === 0) {
                vscode.window.showWarningMessage('No URLs configured yet');
                return;
            }

            const nameToEdit = await vscode.window.showQuickPick(urlNames, {
                placeHolder: 'Select URL to edit'
            });
            if (!nameToEdit) { return; }

            const newUrl = await vscode.window.showInputBox({
                prompt: `Enter new URL for "${nameToEdit}"`,
                value: urls[nameToEdit],
                placeHolder: 'http://localhost:5173'
            });
            if (!newUrl) { return; }

            const newUrls = { ...urls, [nameToEdit]: newUrl };
            await config.update('test.urls', newUrls, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(`Updated ${nameToEdit}: ${newUrl}`);
            updateUrlsStatusBar(newUrls);
        } else if (selected.action === 'remove') {
            const urlNames = Object.keys(urls);
            if (urlNames.length === 0) {
                vscode.window.showWarningMessage('No URLs configured');
                return;
            }

            const nameToRemove = await vscode.window.showQuickPick(urlNames, {
                placeHolder: 'Select URL to remove'
            });
            if (!nameToRemove) { return; }

            const newUrls = { ...urls };
            delete newUrls[nameToRemove];
            await config.update('test.urls', newUrls, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(`Removed ${nameToRemove}`);
            updateUrlsStatusBar(newUrls);
        }
    });

    // STATUS BAR: TDAD Canvas button (primary access point)
    const canvasStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 200);
    canvasStatusBarItem.command = 'tdad.openCanvas';
    canvasStatusBarItem.text = '$(window) TDAD Canvas';
    canvasStatusBarItem.tooltip = 'Open TDAD Workflow Canvas';
    canvasStatusBarItem.show();
    context.subscriptions.push(canvasStatusBarItem);

    // STATUS BAR: Show URLs count
    const urlsStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    urlsStatusBarItem.command = 'tdad.configureUrls';
    context.subscriptions.push(urlsStatusBarItem);

    // Function to update status bar
    const updateUrlsStatusBar = (urls: Record<string, string>) => {
        const count = Object.keys(urls).length;
        const primaryUrl = urls.ui || urls.api || Object.values(urls)[0] || 'not set';
        urlsStatusBarItem.text = `$(globe) TDAD: ${count} URL${count !== 1 ? 's' : ''} (${primaryUrl})`;
        urlsStatusBarItem.tooltip = Object.entries(urls).map(([k, v]) => `${k}: ${v}`).join('\n') || 'Click to configure URLs';
        urlsStatusBarItem.show();
    };

    // Initialize status bar
    const initialUrls = vscode.workspace.getConfiguration('tdad').get<Record<string, string>>('test.urls') || {};
    updateUrlsStatusBar(initialUrls);

    // Watch for config changes
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('tdad.test.urls')) {
            const newUrls = vscode.workspace.getConfiguration('tdad').get<Record<string, string>>('test.urls') || {};
            updateUrlsStatusBar(newUrls);
        }
    });

    const testAIConnectionCommand = vscode.commands.registerCommand('tdad.testAIConnection', async (provider?: 'openai' | 'anthropic' | 'google' | 'cohere') => {
        const p = provider || await vscode.window.showQuickPick(['openai', 'anthropic', 'google', 'cohere'], { placeHolder: 'Select provider to test' }) as any;
        if (!p) {return;}
        const result = await workflowController.testAIConnection(p);
        if (result.ok) {
            vscode.window.showInformationMessage(`Connection to ${p} OK`);
        } else {
            vscode.window.showErrorMessage(`Connection to ${p} failed: ${result.message || 'Unknown error'}`);
        }
    });

    const showSettingsCommand = vscode.commands.registerCommand('tdad.showSettings', async () => {
        // Reuse existing canvas panel to show settings overlay in webview
        if (!SimplifiedWorkflowCanvasProvider.currentPanel) {
            vscode.commands.executeCommand('tdad.openCanvas');
            // Small delay, then send message
            setTimeout(async () => {
                const settings = await workflowController.getSettings();
                SimplifiedWorkflowCanvasProvider.currentPanel?.sendMessage({ command: 'showSettings', settings });
            }, 500);
        } else {
            const settings = await workflowController.getSettings();
            SimplifiedWorkflowCanvasProvider.currentPanel.sendMessage({ command: 'showSettings', settings });
        }
    });

    const saveWorkflowCommand = vscode.commands.registerCommand('tdad.saveWorkflow', async () => {
        logExtension('saveWorkflow command executed');
        
        if (!SimplifiedWorkflowCanvasProvider.currentPanel) {
            vscode.window.showErrorMessage('No workflow canvas is open');
            return;
        }

        // MVP: Auto-saves to workflow.json
        vscode.window.showInformationMessage('Canvas auto-saves to .tdad/workflows/workflow.json');
        logExtension('MVP: Canvas auto-saves - manual save not needed');
    });

    const listWorkflowsCommand = vscode.commands.registerCommand('tdad.listWorkflows', async () => {
        // MVP: Single workspace workflow
        vscode.window.showInformationMessage('MVP uses single workspace workflow in .tdad/workflows/workflow.json');
        logExtension('MVP: Single workspace workflow');
    });

    // MVP: Update models (webview triggers)
    const updateModelsCommand = vscode.commands.registerCommand('tdad.updateModels', async (models: any[], strategy?: any) => {
        await workflowController.updateModels(models, strategy);
        vscode.window.showInformationMessage('TDAD models updated.');
    });


    const setOpenAIOrgIdCommand = vscode.commands.registerCommand('tdad.setOpenAIOrgId', async () => {
        const orgId = await vscode.window.showInputBox({ prompt: 'Enter OpenAI Organization ID (optional)', value: vscode.workspace.getConfiguration('tdad').get('openai.orgId', '') as string });
        if (orgId === undefined) {return;}
        await vscode.workspace.getConfiguration('tdad').update('openai.orgId', orgId, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('OpenAI Org ID saved.');
    });


    // Scan workspace and import existing files as nodes
    const scanWorkspaceCommand = vscode.commands.registerCommand('tdad.scanWorkspace', async () => {
        logExtension('scanWorkspace command executed');
        try {
            // MVP: Workspace scanning not implemented - add features manually
            vscode.window.showInformationMessage('MVP: Use "Add New Feature" button to create features manually');
            logExtension('MVP: Workspace scanning disabled - not part of MVP');
        } catch (error) {
            logError('EXTENSION', 'Scan workspace not available', error);
        }
    });

    const workflowEditorProvider = new WorkflowEditorProvider(context);
    const workflowEditorDisposable = vscode.window.registerCustomEditorProvider(
        'tdad.workflowEditor',
        workflowEditorProvider
    );

    if (vscode.window.registerWebviewPanelSerializer) {
        vscode.window.registerWebviewPanelSerializer(SimplifiedWorkflowCanvasProvider.viewType, {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
                logExtension('Deserializing webview panel state', state);
                webviewPanel.webview.options = {
                    enableScripts: true,
                    localResourceRoots: [context.extensionUri]
                };
                SimplifiedWorkflowCanvasProvider.revive(webviewPanel, context.extensionUri, context);
            }
        });
    }

    // MVP: No workspace change handler needed - simple JSON storage
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        logExtension('MVP: Workspace folders changed - workflow.json will be read from new workspace');
    });

    // Sprint 12: File System Watcher for Blueprint workflow files
    const workflowWatcher = vscode.workspace.createFileSystemWatcher('**/.tdad/workflows/*.workflow.json');

    workflowWatcher.onDidCreate(async (uri) => {
        logExtension(`Blueprint workflow created: ${uri.fsPath}`);

        // Trigger scaffolding sync
        const { ScaffoldingService } = await import('./core/workflows/ScaffoldingService');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            try {
                const scaffoldingService = new ScaffoldingService();
                const createdFiles = await scaffoldingService.bulkSync(uri.fsPath, workspaceFolder.uri.fsPath);

                if (createdFiles.length > 0) {
                    logExtension(`Scaffolded ${createdFiles.length} files from blueprint`);
                    vscode.window.showInformationMessage(
                        `✅ Blueprint scaffolded ${createdFiles.length} files successfully!`
                    );
                }
            } catch (error) {
                logError('EXTENSION', 'Failed to scaffold blueprint', error);
                vscode.window.showErrorMessage(`Failed to scaffold blueprint: ${error}`);
            }
        }

        // Refresh the canvas to show new nodes
        if (SimplifiedWorkflowCanvasProvider.currentPanel) {
            SimplifiedWorkflowCanvasProvider.currentPanel.sendMessage({
                command: 'refreshCanvas'
            });
        }
    });

    workflowWatcher.onDidChange(async (uri) => {
        // Skip refresh if we're saving internally (prevents reload loop from position updates)
        if (SimplifiedWorkflowCanvasProvider.suppressFileWatcherRefresh) {
            logExtension(`Blueprint workflow changed (suppressed - internal save): ${uri.fsPath}`);
            return;
        }

        logExtension(`Blueprint workflow changed: ${uri.fsPath}`);

        // Trigger scaffolding sync for updated workflow
        const { ScaffoldingService } = await import('./core/workflows/ScaffoldingService');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            try {
                const scaffoldingService = new ScaffoldingService();
                const createdFiles = await scaffoldingService.bulkSync(uri.fsPath, workspaceFolder.uri.fsPath);

                if (createdFiles.length > 0) {
                    logExtension(`Scaffolded ${createdFiles.length} new files from blueprint update`);
                    vscode.window.showInformationMessage(
                        `✅ Blueprint updated - scaffolded ${createdFiles.length} new files!`
                    );
                }
            } catch (error) {
                logError('EXTENSION', 'Failed to sync blueprint update', error);
            }
        }

        // Refresh the canvas to show updated nodes
        if (SimplifiedWorkflowCanvasProvider.currentPanel) {
            SimplifiedWorkflowCanvasProvider.currentPanel.sendMessage({
                command: 'refreshCanvas'
            });
        }
    });

    context.subscriptions.push(workflowWatcher);

    // Sprint 13: Agent Orchestrator - File System Watcher for AGENT_DONE.md
    const agentDoneWatcher = vscode.workspace.createFileSystemWatcher('**/.tdad/AGENT_DONE.md');

    agentDoneWatcher.onDidCreate(async (uri) => {
        logExtension(`Agent done signal detected (created): ${uri.fsPath}`);
        await handleAgentDone();
    });

    agentDoneWatcher.onDidChange(async (uri) => {
        logExtension(`Agent done signal detected (changed): ${uri.fsPath}`);
        await handleAgentDone();
    });

    async function handleAgentDone() {
        // Notify the canvas provider about agent completion
        if (SimplifiedWorkflowCanvasProvider.currentPanel) {
            // Call the handler directly instead of routing through webview
            await SimplifiedWorkflowCanvasProvider.currentPanel.handleAgentDoneSignal();
        }
    }

    context.subscriptions.push(agentDoneWatcher);

    // Sprint 13: Register Agent Orchestrator commands
    const startAutomationCommand = vscode.commands.registerCommand('tdad.startAutomation', async () => {
        logExtension('startAutomation command executed');

        if (!SimplifiedWorkflowCanvasProvider.currentPanel) {
            vscode.window.showWarningMessage('Please open the TDAD Canvas first');
            return;
        }

        SimplifiedWorkflowCanvasProvider.currentPanel.sendMessage({
            command: 'startAutomation'
        });
    });

    const stopAutomationCommand = vscode.commands.registerCommand('tdad.stopAutomation', async () => {
        logExtension('stopAutomation command executed');

        if (SimplifiedWorkflowCanvasProvider.currentPanel) {
            SimplifiedWorkflowCanvasProvider.currentPanel.sendMessage({
                command: 'stopAutomation'
            });
        }
    });

    context.subscriptions.push(startAutomationCommand, stopAutomationCommand);

    // Reset database command (MVP: clear workflow.json)
    const resetDatabaseCommand = vscode.commands.registerCommand('tdad.resetDatabase', async () => {
        logExtension('resetDatabase command executed');
        try {
            const confirm = await vscode.window.showWarningMessage(
                'This will DELETE the .tdad/workflows/workflow.json file. This cannot be undone. Continue?',
                { modal: true },
                'Yes, Clear Canvas',
                'Cancel'
            );

            if (confirm === 'Yes, Clear Canvas') {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage('No workspace folder found');
                    return;
                }

                const featureMapFile = path.join(workspaceFolder.uri.fsPath, '.tdad', 'workflows', 'workflow.json');

                if (fs.existsSync(featureMapFile)) {
                    fs.unlinkSync(featureMapFile);
                }

                vscode.window.showInformationMessage('Canvas cleared! Please reload the window.');

                // Offer to reload window
                const reload = await vscode.window.showInformationMessage(
                    'Canvas has been cleared. Reload window now?',
                    'Reload',
                    'Later'
                );
                if (reload === 'Reload') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            }
        } catch (error: any) {
            logError('EXTENSION', 'Failed to clear canvas', error);
            vscode.window.showErrorMessage(`Failed to clear canvas: ${error.message}`);
        }
    });


    // Migrate Feature Map to Hierarchical Structure (Sprint 6)
    const migrateFeatureMapCommand = vscode.commands.registerCommand('tdad.migrateFeatureMap', async () => {
        logExtension('migrateFeatureMap command executed');
        try {
            const { FeatureMapMigration } = await import('./infrastructure/storage/FeatureMapMigration');
            const migration = new FeatureMapMigration();

            // Check if migration is needed
            if (!migration.isMigrationNeeded()) {
                vscode.window.showInformationMessage('Feature map is already using hierarchical structure - no migration needed');
                return;
            }

            // Confirm migration
            const confirm = await vscode.window.showWarningMessage(
                'This will convert your workflow.json to hierarchical folder structure. A backup will be created. Continue?',
                { modal: true },
                'Yes, Migrate'
            );

            if (confirm !== 'Yes, Migrate') {
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Migrating Feature Map...',
                    cancellable: false
                },
                async (progress) => {
                    progress.report({ message: 'Creating backup and reorganizing nodes...' });
                    await migration.migrate();
                    logExtension('Feature map migration completed successfully');
                }
            );

            vscode.window.showInformationMessage('✅ Feature map migrated to hierarchical structure! Reload the canvas to see the new folder organization.');
        } catch (error: any) {
            logError('EXTENSION', 'Failed to migrate feature map', error);
            vscode.window.showErrorMessage(`Migration failed: ${error.message}`);
        }
    });

    const generateProjectDocsCommand = vscode.commands.registerCommand('tdad.generateProjectDocs', async () => {
        const idea = await vscode.window.showInputBox({
            prompt: 'Enter your project idea/description',
            placeHolder: 'e.g. A kanban board for managing personal tasks'
        });
        
        if (idea) {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) { return; }

            const { PromptHandlers } = await import('./vscode-integration/providers/handlers/PromptHandlers');
            const { FeatureMapStorage } = await import('./infrastructure/storage/FeatureMapStorage');
            
            // Temporary manual instantiation since handlers are usually part of webview provider
            const storage = new FeatureMapStorage();
            // Mock webview for CLI usage
            const mockWebview = { postMessage: () => Promise.resolve(true) } as unknown as vscode.Webview;
            
            const handlers = new PromptHandlers(mockWebview, storage, context.extensionUri);
            await handlers.handleGenerateProjectDocs(idea);
        }
    });

    const generateProjectScaffoldCommand = vscode.commands.registerCommand('tdad.generateProjectScaffold', async () => {
        // Option to select documentation files
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: true,
            filters: { 'Markdown': ['md'] },
            title: 'Select Documentation Files (ARCHITECTURE.md, PRD.md, etc.)'
        });

        if (uris && uris.length > 0) {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) { return; }

            // Convert to relative paths
            const docPaths = uris.map(uri => {
                const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
                return relativePath.replace(/\\/g, '/');
            });

            const { PromptHandlers } = await import('./vscode-integration/providers/handlers/PromptHandlers');
            const { FeatureMapStorage } = await import('./infrastructure/storage/FeatureMapStorage');

            const storage = new FeatureMapStorage();
            const mockWebview = { postMessage: () => Promise.resolve(true) } as unknown as vscode.Webview;

            const handlers = new PromptHandlers(mockWebview, storage, context.extensionUri);
            await handlers.handleGenerateProjectScaffold(docPaths);
        }
    });

    // Sprint 15: Slack Remote Control Integration
    let slackService: SlackService | null = null;
    let slackCommandHandler: SlackCommandHandler | null = null;

    const connectSlackCommand = vscode.commands.registerCommand('tdad.connectSlack', async () => {
        logExtension('connectSlack command executed');

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }

        // Get tokens from user
        const botToken = await vscode.window.showInputBox({
            prompt: 'Enter Slack Bot Token (xoxb-...)',
            password: true,
            placeHolder: 'xoxb-your-bot-token'
        });
        if (!botToken) { return; }

        const appToken = await vscode.window.showInputBox({
            prompt: 'Enter Slack App Token (xapp-...)',
            password: true,
            placeHolder: 'xapp-your-app-token'
        });
        if (!appToken) { return; }

        try {
            // Store tokens securely
            await context.secrets.store('tdad.slack.botToken', botToken);
            await context.secrets.store('tdad.slack.appToken', appToken);

            // Initialize Slack service
            slackService = SlackService.getInstance();
            await slackService.connect(botToken, appToken);

            // Enable Slack output capture in CLI launcher
            const cliLauncher = CLIAgentLauncher.getInstance(workspaceFolder.uri.fsPath);
            cliLauncher.setSlackOutputEnabled(true);

            // Set up command handler with dependencies
            const deps: SlackCommandDependencies = {
                getNodes: () => SimplifiedWorkflowCanvasProvider.currentPanel?.getNodes() || [],
                addNode: (node) => SimplifiedWorkflowCanvasProvider.currentPanel?.addNodeFromSlack(node),
                startAutomation: async () => {
                    SimplifiedWorkflowCanvasProvider.currentPanel?.sendMessage({ command: 'startAutomation' });
                },
                stopAutomation: () => {
                    SimplifiedWorkflowCanvasProvider.currentPanel?.sendMessage({ command: 'stopAutomation' });
                },
                getAutomationStatus: () => {
                    return SimplifiedWorkflowCanvasProvider.currentPanel?.getAutomationStatus() || { status: 'unknown' };
                },
                runNodeTests: async (nodeId: string) => {
                    SimplifiedWorkflowCanvasProvider.currentPanel?.sendMessage({ command: 'runTests', nodeId });
                },
                workspacePath: workspaceFolder.uri.fsPath
            };

            slackCommandHandler = new SlackCommandHandler(slackService, deps);

            // Register slash command handler
            slackService.onSlashCommand(async (payload) => {
                await slackCommandHandler?.handleCommand(payload);
            });

            // Enable Slack in config
            await vscode.workspace.getConfiguration('tdad').update('slack.enabled', true, vscode.ConfigurationTarget.Workspace);

            vscode.window.showInformationMessage('✅ Connected to Slack! Use /tdad help in Slack to see available commands.');
            logExtension('Slack connected successfully');

        } catch (error: any) {
            logError('EXTENSION', 'Failed to connect to Slack', error);
            vscode.window.showErrorMessage(`Failed to connect to Slack: ${error.message}`);
        }
    });

    const disconnectSlackCommand = vscode.commands.registerCommand('tdad.disconnectSlack', async () => {
        logExtension('disconnectSlack command executed');

        if (slackService) {
            await slackService.disconnect();
            slackService = null;
            slackCommandHandler = null;

            // Disable Slack output capture
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
                const cliLauncher = CLIAgentLauncher.getInstance(workspaceFolder.uri.fsPath);
                cliLauncher.setSlackOutputEnabled(false);
            }

            // Update config
            await vscode.workspace.getConfiguration('tdad').update('slack.enabled', false, vscode.ConfigurationTarget.Workspace);

            vscode.window.showInformationMessage('Disconnected from Slack');
            logExtension('Slack disconnected');
        } else {
            vscode.window.showInformationMessage('Not connected to Slack');
        }
    });

    // Auto-connect to Slack if enabled and tokens are stored
    const slackEnabled = vscode.workspace.getConfiguration('tdad').get('slack.enabled');
    const slackWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (slackEnabled && slackWorkspaceFolder) {
        context.secrets.get('tdad.slack.botToken').then(async (botToken) => {
            const appToken = await context.secrets.get('tdad.slack.appToken');
            if (botToken && appToken) {
                try {
                    slackService = SlackService.getInstance();
                    await slackService.connect(botToken, appToken);

                    const cliLauncher = CLIAgentLauncher.getInstance(slackWorkspaceFolder.uri.fsPath);
                    cliLauncher.setSlackOutputEnabled(true);

                    const deps: SlackCommandDependencies = {
                        getNodes: () => SimplifiedWorkflowCanvasProvider.currentPanel?.getNodes() || [],
                        addNode: (node) => SimplifiedWorkflowCanvasProvider.currentPanel?.addNodeFromSlack(node),
                        startAutomation: async () => {
                            SimplifiedWorkflowCanvasProvider.currentPanel?.sendMessage({ command: 'startAutomation' });
                        },
                        stopAutomation: () => {
                            SimplifiedWorkflowCanvasProvider.currentPanel?.sendMessage({ command: 'stopAutomation' });
                        },
                        getAutomationStatus: () => {
                            return SimplifiedWorkflowCanvasProvider.currentPanel?.getAutomationStatus() || { status: 'unknown' };
                        },
                        runNodeTests: async (nodeId: string) => {
                            SimplifiedWorkflowCanvasProvider.currentPanel?.sendMessage({ command: 'runTests', nodeId });
                        },
                        workspacePath: slackWorkspaceFolder.uri.fsPath
                    };

                    slackCommandHandler = new SlackCommandHandler(slackService, deps);
                    slackService.onSlashCommand(async (payload) => {
                        await slackCommandHandler?.handleCommand(payload);
                    });

                    logExtension('Slack auto-connected on startup');
                } catch (error) {
                    logError('EXTENSION', 'Failed to auto-connect Slack', error);
                }
            }
        });
    }

    context.subscriptions.push(
        connectSlackCommand,
        disconnectSlackCommand,
        openCanvasCommand,
        createNodeCommand,
        checkConfigCommand,
        runAutomatedTestsCommand,
        saveWorkflowCommand,
        listWorkflowsCommand,
        saveApiKeyCommand,
        testAIConnectionCommand,
        showSettingsCommand,
        updateModelsCommand,
        setOpenAIOrgIdCommand,
        scanWorkspaceCommand,
        resetDatabaseCommand,
        migrateFeatureMapCommand,
        workflowEditorDisposable,
        configureUrlsCommand,
        urlsStatusBarItem,
        generateProjectDocsCommand,
        generateProjectScaffoldCommand
    );
}

export function deactivate() {
    // Extension cleanup if needed
}