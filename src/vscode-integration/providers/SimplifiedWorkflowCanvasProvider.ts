import * as vscode from 'vscode';
import * as path from 'path';
import { TestResult } from '../../shared/types';
import { logCanvas, logError } from '../../shared/utils/Logger';
import { FeatureMapStorage } from '../../infrastructure/storage/FeatureMapStorage';
import { SimpleNodeManager } from './SimpleNodeManager';
import { SimpleWorkflowLoader } from './SimpleWorkflowLoader';
import { TestRunner } from '../testing/TestRunner';
import { TestOrchestrator } from '../testing/TestOrchestrator';

// Import handler classes
import { TestWorkflowHandlers } from './handlers/TestWorkflowHandlers';
import { SettingsHandlers } from './handlers/SettingsHandlers';
import { NavigationHandlers } from './handlers/NavigationHandlers';
import { AutomationHandlers } from './handlers/AutomationHandlers';
import { PromptHandlers } from './handlers/PromptHandlers';

interface BreadcrumbItem {
    nodeId: string;
    title: string;
    nodeType: 'folder' | 'file' | 'function';
}

/**
 * Hierarchical WorkflowCanvasProvider with folder navigation support
 * Supports drill-down into folder nodes
 */
export class SimplifiedWorkflowCanvasProvider {
    public static currentPanel: SimplifiedWorkflowCanvasProvider | undefined;
    public static readonly viewType = 'tdadWorkflowCanvas';

    // Flag to suppress file watcher refresh when we're saving internally
    // This prevents the canvas from reloading after position updates
    public static suppressFileWatcherRefresh = false;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];

    private _storage!: FeatureMapStorage;
    private _nodeManager!: SimpleNodeManager;
    private _workflowLoader!: SimpleWorkflowLoader;
    private _testRunner: TestRunner;
    private _testOrchestrator: TestOrchestrator;

    // Handler classes
    private _testWorkflowHandlers!: TestWorkflowHandlers;
    private _settingsHandlers!: SettingsHandlers;
    private _navigationHandlers!: NavigationHandlers;
    private _automationHandlers!: AutomationHandlers;
    private _promptHandlers!: PromptHandlers;

    // Navigation state for hierarchical folders
    private _currentFolderId: string | null = null;
    private _breadcrumbPath: BreadcrumbItem[] = [];

    // Store test results for each node
    private _testResultsCache: Map<string, TestResult[]> = new Map();

    public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (SimplifiedWorkflowCanvasProvider.currentPanel) {
            SimplifiedWorkflowCanvasProvider.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            SimplifiedWorkflowCanvasProvider.viewType,
            'TDAD Workflow Canvas',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        SimplifiedWorkflowCanvasProvider.currentPanel = new SimplifiedWorkflowCanvasProvider(panel, extensionUri, context);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;
        this._testRunner = new TestRunner();
        this._testOrchestrator = new TestOrchestrator(this._testRunner);

        this._initialize();
    }

    private async _initialize() {
        try {
            this._storage = new FeatureMapStorage();
            this._nodeManager = new SimpleNodeManager(this._storage, this._panel.webview);
            this._workflowLoader = new SimpleWorkflowLoader(this._storage);

            // Initialize handler classes
            this._testWorkflowHandlers = new TestWorkflowHandlers(
                this._panel.webview,
                this._storage,
                this._nodeManager,
                this._context,
                this._testOrchestrator,
                this._testResultsCache
            );

            this._settingsHandlers = new SettingsHandlers(
                this._panel.webview,
                this._context
            );

            this._navigationHandlers = new NavigationHandlers(
                this._panel.webview,
                this._storage,
                this._nodeManager,
                this._workflowLoader,
                this._breadcrumbPath,
                this._currentFolderId,
                (folderId, breadcrumbs) => {
                    this._currentFolderId = folderId;
                    this._loadCanvas();
                }
            );

            // Initialize automation handlers
            this._automationHandlers = new AutomationHandlers(
                this._panel.webview,
                this._storage,
                this._nodeManager,
                this._testRunner,
                this._testResultsCache,
                this._extensionUri
            );
            this._automationHandlers.initializeOrchestrator();

            // Initialize prompt handlers
            this._promptHandlers = new PromptHandlers(
                this._panel.webview,
                this._storage,
                this._extensionUri,
                this._settingsHandlers
            );

            await this._loadCanvas();

            this._panel.webview.html = await this._getHtmlForWebview();

            this._setupMessageHandlers();

            this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

            logCanvas('MVP: Canvas initialized with simple JSON storage');
        } catch (error) {
            logError('CANVAS', 'Failed to initialize canvas', error);
            vscode.window.showErrorMessage('TDAD: Failed to initialize canvas');
        }
    }

    private async _loadCanvas() {
        this._nodeManager.setCurrentFolder(this._currentFolderId);

        const data = await this._workflowLoader.loadWorkflowData(this._currentFolderId);
        // BUG FIX: Skip save when loading from file to prevent file watcher loop
        // Without skipSave, loading triggers save which triggers file watcher which triggers reload
        this._nodeManager.setNodes(data.nodes, true);
        this._nodeManager.setEdges(data.edges, true);

        // Load stored ghost positions for this folder
        const storedGhostPositions = (data as any).ghostPositions || {};

        // Sprint 9: Ghost Node Injection
        // Identify dependencies that are NOT in the current folder and inject them as "Ghost Nodes"
        const localNodeIds = new Set(data.nodes.map(n => n.id));
        const ghostDependencies: Array<{ ghostId: string; dependentNodeId: string }> = [];

        // Check node.dependencies array for cross-folder deps
        data.nodes.forEach(node => {
            if (node.dependencies) {
                node.dependencies.forEach(depId => {
                    if (!localNodeIds.has(depId)) {
                        ghostDependencies.push({ ghostId: depId, dependentNodeId: node.id });
                    }
                });
            }
        });

        // Also check edges for cross-folder deps (source not in current folder)
        data.edges.forEach(edge => {
            if (!localNodeIds.has(edge.source)) {
                ghostDependencies.push({ ghostId: edge.source, dependentNodeId: edge.target });
            }
        });

        const nodesToSend = [...data.nodes];
        const edgesToSend = [...data.edges];
        const addedGhostIds = new Set<string>();

        // BUG FIX: Track existing edges to prevent duplicates when adding ghost edges
        const existingEdgeKeys = new Set(data.edges.map(e => `${e.source}-${e.target}`));

        if (ghostDependencies.length > 0) {
            // We need to find these nodes. Since we don't have a global index in memory all the time,
            // we load all nodes. Optimization: Cache this if it becomes slow.
            const allNodes = this._storage.loadAll();

            ghostDependencies.forEach(({ ghostId, dependentNodeId }) => {
                // Add ghost node if not already added
                if (!addedGhostIds.has(ghostId)) {
                    const parts = ghostId.split('/');
                    const nodeId = parts.length > 1 ? parts[parts.length - 1] : ghostId;
                    const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
                    const originalNode = allNodes.find(n => n.id === nodeId && (!folderPath || n.workflowId === folderPath));
                    if (originalNode) {
                        // Use stored ghost position if available, otherwise use original node position
                        const ghostPosition = storedGhostPositions[ghostId] || originalNode.position || { x: 0, y: 0 };
                        const ghostNode = {
                            ...originalNode,
                            id: ghostId,
                            isGhost: true,
                            position: ghostPosition
                        };
                        nodesToSend.push(ghostNode);
                        addedGhostIds.add(ghostId);
                    }
                }

                // Create edge from ghost node to dependent node
                // BUG FIX: Only add if not already present (prevents duplicate edges)
                const edgeKey = `${ghostId}-${dependentNodeId}`;
                if (addedGhostIds.has(ghostId) && !existingEdgeKeys.has(edgeKey)) {
                    edgesToSend.push({
                        id: `ghost-edge-${ghostId}-${dependentNodeId}`,
                        source: ghostId,
                        target: dependentNodeId
                    });
                    existingEdgeKeys.add(edgeKey); // Prevent duplicates within ghost edges too
                }
            });
        }

        // Load autopilot settings to send with nodes
        const config = vscode.workspace.getConfiguration('tdad');
        const betaCode = config.get<string>('betaAccessCode');
        logCanvas(`[AUTOPILOT DEBUG] Loading beta code from config: ${betaCode ? '***' : 'none'}`);

        const autopilotSettings = betaCode ? { betaCode } : undefined;
        logCanvas(`[AUTOPILOT DEBUG] Sending autopilot settings with loadNodes: ${autopilotSettings ? 'yes' : 'no'}`);

        this._panel.webview.postMessage({
            command: 'loadNodes',
            nodes: nodesToSend,
            edges: edgesToSend,
            currentFolderId: this._currentFolderId,
            breadcrumbPath: this._breadcrumbPath,
            autopilotSettings
        });
    }

    private _setupMessageHandlers() {
        this._panel.webview.onDidReceiveMessage(
            async message => {
                try {
                    switch (message.command) {
                        // Node CRUD
                        case 'addNode':
                            await vscode.commands.executeCommand('tdad.createNode');
                            break;

                        case 'createNodeFromForm':
                            this._nodeManager.addNode(message.node);
                            // Add dependency edges if provided
                            if (message.dependencyIds && Array.isArray(message.dependencyIds) && message.dependencyIds.length > 0) {
                                const edgesToAdd = message.dependencyIds.map((sourceId: string) => ({
                                    id: `${sourceId}-${message.node.id}`,
                                    source: sourceId,
                                    target: message.node.id,
                                    type: 'custom',
                                    animated: false
                                }));
                                this._nodeManager.addEdges(edgesToAdd);
                                logCanvas(`[createNodeFromForm] Added ${message.dependencyIds.length} dependency edges for node ${message.node.id}`);
                            }
                            break;

                        case 'createFolderFromForm':
                            // Create a folder node - user can navigate into it and add features
                            this._nodeManager.addFolder(message.node);
                            break;

                        case 'updateNode':
                            this._nodeManager.updateNode(message.node);
                            break;

                        case 'deleteNode':
                            logCanvas(`[MessageHandler] Received deleteNode for nodeId: ${message.nodeId}`);
                            this._nodeManager.deleteNode(message.nodeId);
                            break;

                        // Position updates
                        case 'updateNodePositions':
                            this._nodeManager.updateNodePositions(message.updates);
                            break;

                        // Edges
                        case 'updateEdges':
                            this._nodeManager.setEdges(message.edges);
                            break;

                        case 'addEdge':
                            if (message.edge) {
                                this._nodeManager.addEdge(message.edge);
                                // Check if cross-folder edge - reload to show ghost node
                                const currentNodes = this._nodeManager.getNodes();
                                const sourceInCurrentFolder = currentNodes.some(n => n.id === message.edge.source);
                                if (!sourceInCurrentFolder) {
                                    // Save and reload after a short delay to ensure all pending operations complete
                                    setTimeout(async () => {
                                        this._nodeManager.saveNow();
                                        await this._loadCanvas();
                                    }, 100);
                                }
                            }
                            break;

                        case 'deleteEdge':
                            if (message.edgeId) {
                                // Check if cross-folder before deleting
                                const edgeToDelete = this._nodeManager.getEdges().find(e => e.id === message.edgeId);
                                const nodesForDelete = this._nodeManager.getNodes();
                                const isCrossFolderEdge = edgeToDelete && !nodesForDelete.some(n => n.id === edgeToDelete.source);

                                this._nodeManager.removeEdge(message.edgeId);

                                if (isCrossFolderEdge) {
                                    setTimeout(async () => {
                                        this._nodeManager.saveNow();
                                        await this._loadCanvas();
                                    }, 100);
                                }
                            }
                            break;

                        // Initial data request
                        case 'requestInitialData':
                            // BUG FIX: Use _loadCanvas() to include ghost nodes/edges
                            // Previously this just returned nodeManager data without ghosts,
                            // causing inconsistency when canvas refreshed
                            await this._loadCanvas();
                            break;

                        // Test workflow handlers (delegated)
                        case 'loadBddSpec':
                            await this._testWorkflowHandlers.handleLoadBddSpec(message.nodeId, message.filePath);
                            break;

                        case 'loadTestDetails':
                            await this._testWorkflowHandlers.handleLoadTestDetails(message.nodeId, message.testFilePath);
                            break;

                        case 'loadTestFileContent':
                            await this._testWorkflowHandlers.handleLoadTestFileContent(message.nodeId, message.filePath);
                            break;

                        case 'requestAllNodes':
                            await this._testWorkflowHandlers.handleRequestAllNodes(message.workflowId);
                            break;

                        case 'checkAllNodesFileStatus':
                            await this._testWorkflowHandlers.handleCheckAllNodesFileStatus();
                            break;

                        case 'generateTestWithManualConfig':
                            logCanvas(`📩 MESSAGE RECEIVED: generateTestWithManualConfig for node ${message.nodeId}`);
                            await this._testWorkflowHandlers.handleGenerateTestWithManualConfig(
                                message.nodeId,
                                message.manualInputs,
                                message.generationContext
                            );
                            break;

                        case 'copyBddPrompt':
                            await this._testWorkflowHandlers.handleCopyBddPrompt(message.nodeId, message.featureDescription);
                            break;

                        case 'saveBddSpec':
                            await this._testWorkflowHandlers.handleSaveBddSpec(message.nodeId, message.bddSpec, message.filePath);
                            break;

                        case 'generateTestCodeFromGherkin':
                            logCanvas(`📩 MESSAGE RECEIVED: generateTestCodeFromGherkin for node ${message.nodeId}`);
                            await this._testWorkflowHandlers.handleGenerateTestCode(message.nodeId, message.gherkinSpec, message.testFramework);
                            break;

                        case 'selectContextFiles':
                            await this._testWorkflowHandlers.handleSelectContextFiles(message.nodeId);
                            break;

                        case 'selectContextFilesForForm':
                            await this._promptHandlers.handleSelectContextFilesForForm();
                            break;

                        case 'requestDependencyPickerNodes':
                            await this._promptHandlers.handleRequestDependencyPickerNodes();
                            break;

                        case 'copyGoldenPacket':
                            await this._testWorkflowHandlers.handleCopyGoldenPacket(message.nodeId);
                            break;

                        case 'runTests':
                            await this._testWorkflowHandlers.handleRunTests(message.node);
                            break;

                        // Settings handlers (delegated)
                        case 'openSettings':
                            await vscode.commands.executeCommand('tdad.showSettings');
                            break;

                        case 'openFeedback':
                            vscode.env.openExternal(vscode.Uri.parse('https://github.com/zd8899/TDAD/issues'));
                            break;

                        case 'openPromptTemplate':
                            logCanvas(`Received openPromptTemplate message: ${JSON.stringify(message)}`);
                            await this._promptHandlers.handleOpenPromptTemplate(message.templateName);
                            break;

                        case 'generateBlueprintPrompt':
                            logCanvas(`Received generateBlueprintPrompt message: mode=${message.mode}`);
                            await this._promptHandlers.handleGenerateBlueprintPrompt(message.mode, message.context);
                            break;

                        case 'generateProjectDocs':
                            logCanvas(`Received generateProjectDocs message: TechStack=${message.techStack}, ProjectType=${message.projectType}, Database=${message.database}`);
                            await this._promptHandlers.handleGenerateProjectDocs(message.idea, message.techStack, message.projectType, message.database);
                            break;

                        case 'generateProjectScaffold':
                            logCanvas(`Received generateProjectScaffold message: TestTypes=${message.testTypes}, Framework=${message.testFramework}`);
                            await this._promptHandlers.handleGenerateProjectScaffold(message.docPaths || [], message.testTypes, message.testFramework);
                            break;

                        case 'selectDocsFolder':
                            await this._promptHandlers.handleSelectDocsFolder();
                            break;

                        case 'selectDocFile':
                            await this._promptHandlers.handleSelectDocFile();
                            break;

                        case 'updateModels':
                            await this._settingsHandlers.handleUpdateModels(message.models, message.strategy, message.embedding);
                            break;

                        case 'saveApiKey':
                            await this._settingsHandlers.handleSaveApiKey(message.provider, message.apiKey);
                            break;

                        case 'testAIConnection':
                            await this._settingsHandlers.handleTestAIConnection(message.provider);
                            break;

                        case 'updateTestSettings':
                            await this._settingsHandlers.handleUpdateTestSettings(message.testSettings, message.urls);
                            break;

                        case 'updateProjectContext':
                            await this._settingsHandlers.handleUpdateProjectContext(message.projectContext);
                            break;

                        case 'updateCLISettings':
                            await this._settingsHandlers.handleUpdateCLISettings(message.cliSettings);
                            break;

                        case 'updateAutopilotSettings':
                            await this._settingsHandlers.handleUpdateAutopilotSettings(message.autopilotSettings);
                            break;

                        // Navigation handlers (delegated)
                        case 'navigateIntoFolder':
                            await this._navigationHandlers.handleNavigateIntoFolder(message.folderId);
                            break;

                        case 'navigateToParent':
                            await this._navigationHandlers.handleNavigateToParent();
                            break;

                        case 'navigateToBreadcrumb':
                            await this._navigationHandlers.handleNavigateToBreadcrumb(message.folderId);
                            break;

                        // Automation handlers (delegated)
                        case 'startAutomation':
                            await this._automationHandlers.handleStartAutomation(async () => this._loadCanvas());
                            break;

                        case 'stopAutomation':
                            this._automationHandlers.handleStopAutomation();
                            break;

                        case 'agentDone':
                            await this._automationHandlers.handleAgentDone();
                            break;

                        case 'copyAgentPrompt':
                            await this._automationHandlers.handleCopyAgentPrompt();
                            break;

                        case 'startAutomationWithContext':
                            await this._automationHandlers.handleStartAutomationWithContext(message.mode, message.projectContext, message.agentConfig);
                            break;

                        case 'getAutomationStatus':
                            this._automationHandlers.getAutomationStatus();
                            break;

                        // Single-node automation commands
                        case 'runSingleNodeAutomation': {
                            logCanvas(`runSingleNodeAutomation - received modes from webview: ${JSON.stringify(message.modes)}`);
                            const singleNodeModes = message.modes || ['bdd', 'test', 'run-fix'];
                            logCanvas(`runSingleNodeAutomation - using modes: [${singleNodeModes.join(', ')}]`);
                            await this._testWorkflowHandlers.handleRunSingleNodeAutomation(
                                message.nodeId,
                                singleNodeModes
                            );
                            break;
                        }

                        case 'stopSingleNodeAutomation':
                            this._testWorkflowHandlers.handleStopSingleNodeAutomation();
                            break;

                        // All-nodes automation commands
                        case 'getAutopilotInfo':
                            logCanvas('Received getAutopilotInfo message');
                            await this._testWorkflowHandlers.handleGetAutopilotInfo(message.allFolders === true);
                            break;

                        case 'runAllNodesAutomation':
                            logCanvas('Received runAllNodesAutomation message');
                            await this._testWorkflowHandlers.handleRunAllNodesAutomation(
                                message.confirmed === true,
                                message.allFolders === true,
                                message.modes || ['bdd', 'test', 'run-fix']
                            );
                            break;

                        case 'stopAllNodesAutomation':
                            this._testWorkflowHandlers.handleStopAllNodesAutomation();
                            break;

                        case 'openFile':
                            if (message.filePath) {
                                const workspaceRoot = this._storage.getWorkspaceRoot();
                                const fullPath = path.isAbsolute(message.filePath)
                                    ? message.filePath
                                    : path.join(workspaceRoot, message.filePath);
                                const uri = vscode.Uri.file(fullPath);
                                vscode.workspace.openTextDocument(uri).then(doc => {
                                    vscode.window.showTextDocument(doc);
                                });
                            }
                            break;

                        case 'refreshCanvas':
                            await this._loadCanvas();
                            break;

                        case 'canvasLog':
                            // Log messages from webview to TDAD log file
                            logCanvas(message.message);
                            break;

                        default:
                            logCanvas(`Unknown command: ${message.command}`);
                    }
                } catch (error) {
                    logError('CANVAS', `Error handling message: ${message.command}`, error);
                }
            },
            null,
            this._disposables
        );
    }

    private async _getHtmlForWebview(): Promise<string> {
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'canvas-react.js')
        );

        const pickLatestByPrefix = async (prefix: string): Promise<string | null> => {
            try {
                const assetsDir = vscode.Uri.joinPath(this._extensionUri, 'media', 'assets');
                const entries = await vscode.workspace.fs.readDirectory(assetsDir);
                const cssEntries = entries.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.css') && name.startsWith(prefix));
                if (cssEntries.length === 0) {
                    return null;
                }
                let latest: { name: string; mtime: number } | null = null;
                for (const [name] of cssEntries) {
                    const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(assetsDir, name));
                    if (!latest || stat.mtime > latest.mtime) {
                        latest = { name, mtime: stat.mtime };
                    }
                }
                return latest?.name || null;
            } catch (e) {
                logError('WEBVIEW', `Failed to pick latest CSS for prefix ${prefix}`, e);
                return null;
            }
        };

        const latestIndex = await pickLatestByPrefix('index-');
        const latestMain = await pickLatestByPrefix('main-');
        const chosenCss = [latestIndex, latestMain].filter(Boolean) as string[];
        if (chosenCss.length > 0) {
            logCanvas('WEBVIEW', `Using stylesheets: ${chosenCss.join(', ')}`);
        } else {
            logCanvas('WEBVIEW', 'No matching CSS (index-*, main-*) found in media/assets');
        }

        const styleLinks = chosenCss.map(fileName => {
            const uri = this._panel.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'media', 'assets', fileName)
            );
            return `<link href="${uri}" rel="stylesheet">`;
        }).join('\n    ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${styleLinks}
    <title>TDAD Workflow Canvas</title>
    <style>
        body {
            --vscode-editor-background: #ffffff;
            --vscode-editor-foreground: #000000;
            --vscode-descriptionForeground: #666666;
            --vscode-focusBorder: #0078d4;
            --vscode-button-background: #0078d4;
            --vscode-button-foreground: #ffffff;
            --vscode-button-secondaryBackground: #e0e0e0;
            --vscode-button-secondaryForeground: #000000;
            --vscode-badge-background: #e0e0e0;
            --vscode-badge-foreground: #000000;
            --vscode-list-hoverBackground: #f0f0f0;
            --vscode-widget-border: #cccccc;
            --vscode-panel-border: #cccccc;
            --vscode-input-background: #ffffff;
            --vscode-input-foreground: #000000;
            --vscode-input-border: #cccccc;
            --vscode-textCodeBlock-background: #f5f5f5;
            --vscode-editor-inactiveSelectionBackground: #e5e5e5;
            --vscode-list-activeSelectionBackground: #0078d4;
            margin: 0;
            padding: 0;
        }
    </style>
</head>
<body>
    <div id="root"></div>
    <div id="portal-root"></div>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }

    public sendMessage(message: any) {
        this._panel.webview.postMessage(message);
    }

    /**
     * Sprint 13: Handle AGENT_DONE.md signal from file watcher
     * Called directly from extension.ts when AGENT_DONE.md is created/changed
     *
     * Only ONE orchestrator should handle the signal - prioritize single-node if running
     */
    public async handleAgentDoneSignal(): Promise<void> {
        // Check if single-node orchestrator is running - it takes priority
        const singleNodeOrchestrator = this._testWorkflowHandlers.getSingleNodeOrchestrator();
        if (singleNodeOrchestrator?.isRunning()) {
            await this._testWorkflowHandlers.handleSingleNodeAgentDone();
            return;
        }

        // Otherwise, handle multi-node orchestrator
        if (this._automationHandlers.isRunning()) {
            await this._automationHandlers.handleAgentDone();
        }
    }

    /**
     * Sprint 15: Slack Integration - Get all nodes for Slack commands
     */
    public getNodes() {
        return this._nodeManager?.getNodes() || [];
    }

    /**
     * Sprint 15: Slack Integration - Add a node from Slack command
     */
    public addNodeFromSlack(nodeData: any) {
        if (this._nodeManager) {
            const node = {
                id: nodeData.id || `node-${Date.now()}`,
                workflowId: nodeData.workflowId || 'default',
                nodeType: nodeData.nodeType || 'file',
                title: nodeData.title || 'Untitled',
                description: nodeData.description || '',
                position: nodeData.position || { x: 100, y: 100 },
                preConditions: [],
                features: [],
                testData: {},
                filePath: '',
                language: 'typescript',
                status: 'pending'
            };
            this._nodeManager.addNode(node as any);
            this._loadCanvas(); // Refresh canvas
        }
    }

    /**
     * Sprint 15: Slack Integration - Update a node from Slack command
     */
    public updateNodeFromSlack(nodeData: any) {
        if (this._nodeManager && nodeData?.id) {
            this._nodeManager.updateNode(nodeData);
            this._loadCanvas(); // Refresh canvas
        }
    }

    /**
     * Sprint 15: Slack Integration - Get automation status for Slack commands
     */
    public getAutomationStatus(): {
        status: string;
        currentNodeId?: string;
        phase?: string;
        message?: string;
        processedNodes?: string[];
        failedNodes?: string[];
        currentRetry?: number;
        maxRetries?: number;
    } {
        // Check single-node orchestrator first
        const singleNodeOrchestrator = this._testWorkflowHandlers?.getSingleNodeOrchestrator?.();
        if (singleNodeOrchestrator?.isRunning()) {
            const state = singleNodeOrchestrator.getState();
            return {
                status: state?.status || 'running',
                currentNodeId: state?.nodeId || undefined,
                phase: state?.phase,
                message: state?.message,
                currentRetry: state?.currentRetry,
                maxRetries: state?.maxRetries
            };
        }

        // Check multi-node automation handler
        if (this._automationHandlers?.isRunning()) {
            const state = this._automationHandlers.getState();
            return {
                status: state?.status || 'running',
                currentNodeId: state?.currentNodeId || undefined,
                phase: state?.phase,
                message: state?.message,
                processedNodes: state?.processedNodes,
                failedNodes: state?.failedNodes,
                currentRetry: state?.currentRetry
            };
        }
        return { status: 'idle' };
    }

    public dispose() {
        SimplifiedWorkflowCanvasProvider.currentPanel = undefined;

        if (this._nodeManager) {
            this._nodeManager.saveNow();
        }

        if (this._testRunner) {
            this._testRunner.dispose();
        }

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        SimplifiedWorkflowCanvasProvider.currentPanel = new SimplifiedWorkflowCanvasProvider(panel, extensionUri, context);
    }
}
