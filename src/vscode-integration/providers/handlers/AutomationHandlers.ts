/**
 * AutomationHandlers - Handles automation and orchestrator operations
 *
 * Extracted from SimplifiedWorkflowCanvasProvider to comply with CLAUDE.md file size limits
 * Manages: Agent Orchestrator initialization, start/stop automation, agent done signals
 */

import * as vscode from 'vscode';
import { Node, TestResult } from '../../../shared/types';
import { isFolderNode } from '../../../shared/types/typeGuards';
import { logCanvas, logError } from '../../../shared/utils/Logger';
import { FeatureMapStorage } from '../../../infrastructure/storage/FeatureMapStorage';
import { SimpleNodeManager } from '../SimpleNodeManager';
import { TestRunner } from '../../testing/TestRunner';
import { AgentOrchestrator, OrchestratorState } from '../../../core/services/AgentOrchestrator';
import { CLIAgentLauncher } from '../../CLIAgentLauncher';
import { PromptService } from '../../../core/services/PromptService';

const AUTOMATION_STARTED_MSG = '🤖 Automation started! AI agent will be triggered automatically.';

export class AutomationHandlers {
    private _agentOrchestrator: AgentOrchestrator | null = null;
    private _promptService: PromptService | null = null;

    constructor(
        private readonly webview: vscode.Webview,
        private readonly storage: FeatureMapStorage,
        private readonly nodeManager: SimpleNodeManager,
        private readonly testRunner: TestRunner,
        private readonly testResultsCache: Map<string, TestResult[]>,
        private readonly extensionUri: vscode.Uri
    ) {}

    /**
     * Initialize the Agent Orchestrator
     */
    initializeOrchestrator(): void {
        try {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            this._agentOrchestrator = new AgentOrchestrator(workspaceRoot, this.extensionUri.fsPath);

            // Inject dependencies
            this._agentOrchestrator.setDependencies(this.testRunner, this.storage);

            // Set up callbacks
            this._agentOrchestrator.setCallbacks({
                onStatusChange: (state: OrchestratorState) => {
                    this.webview.postMessage({
                        command: 'automationStatusUpdate',
                        state
                    });
                },
                onNodeComplete: (nodeId: string, passed: boolean) => {
                    // Update node status in the canvas
                    const nodes = this.nodeManager.getNodes();
                    const node = nodes.find(n => n.id === nodeId);
                    if (node) {
                        (node as any).status = passed ? 'passed' : 'failed';
                        this.nodeManager.updateNode(node);
                        // BUG FIX: Save immediately to prevent race condition with canvas refresh
                        this.nodeManager.saveNow();
                    }

                    this.webview.postMessage({
                        command: 'nodeAutomationComplete',
                        nodeId,
                        passed
                    });
                },
                onTestResults: (nodeId: string, results: TestResult[]) => {
                    this.testResultsCache.set(nodeId, results);
                    this.webview.postMessage({
                        command: 'testResultsUpdated',
                        nodeId,
                        results
                    });
                },
                onError: (error: Error) => {
                    vscode.window.showErrorMessage(`Automation error: ${error.message}`);
                },
                onBlueprintComplete: async () => {
                    // Reload nodes from workflow.json after blueprint generation
                    logCanvas('Blueprint complete, reloading canvas...');

                    // Load ALL nodes from ALL folders (including feature nodes in subfolders)
                    const allNodes = this.storage.loadAll();
                    const featureNodes = allNodes.filter(n => !isFolderNode(n));
                    logCanvas(`Loaded ${allNodes.length} total nodes, ${featureNodes.length} feature nodes for automation`);

                    if (featureNodes.length > 0) {
                        vscode.window.showInformationMessage(`📋 Blueprint generated ${featureNodes.length} features! Continuing with implementation...`);
                        await this._agentOrchestrator?.start(allNodes, []);
                    } else if (allNodes.length > 0) {
                        vscode.window.showInformationMessage(`📋 Blueprint generated ${allNodes.length} folder nodes. Navigate into folders to see features.`);
                    } else {
                        vscode.window.showWarningMessage('Blueprint generated but no nodes found. Check workflow.json.');
                    }
                },
                onTaskWritten: (taskFile: string, taskDescription: string) => {
                    const launcher = CLIAgentLauncher.getInstance(workspaceRoot);
                    launcher.triggerAgent(taskFile, taskDescription);
                }
            });

            logCanvas('Sprint 13: Agent Orchestrator initialized');
        } catch (error) {
            logError('CANVAS', 'Failed to initialize Agent Orchestrator', error);
        }
    }

    /**
     * Guard method to ensure orchestrator is initialized
     */
    private ensureOrchestrator(): boolean {
        if (!this._agentOrchestrator) {
            vscode.window.showErrorMessage('Agent Orchestrator not initialized');
            return false;
        }
        return true;
    }

    /**
     * Lazy-initialize and return PromptService
     */
    private getPromptService(): PromptService {
        if (!this._promptService) {
            const workspaceRoot = this.storage.getWorkspaceRoot();
            this._promptService = new PromptService(this.extensionUri.fsPath, workspaceRoot);
        }
        return this._promptService;
    }

    /**
     * Start automation
     * If no nodes exist, tell webview to show automation wizard for context collection
     */
    async handleStartAutomation(loadCanvasCallback: () => Promise<void>): Promise<void> {
        if (!this.ensureOrchestrator()) {return;}

        const nodes = this.nodeManager.getNodes();
        const edges = this.nodeManager.getEdges();

        if (nodes.length === 0) {
            logCanvas('No nodes found, showing automation wizard...');
            this.webview.postMessage({
                command: 'showAutomationWizard'
            });
            return;
        }

        const workspaceRoot = this.storage.getWorkspaceRoot();
        const launcher = CLIAgentLauncher.getInstance(workspaceRoot);
        const confirmed = await launcher.showConfigurationDialog();

        if (!confirmed) {
            logCanvas('Automation cancelled by user');
            return;
        }

        logCanvas('Starting automation with existing nodes...');
        vscode.window.showInformationMessage(AUTOMATION_STARTED_MSG);

        await this._agentOrchestrator!.start(nodes, edges);
    }

    /**
     * Start automation with project context (from wizard)
     */
    async handleStartAutomationWithContext(
        mode: 'idea' | 'architecture' | 'refactor',
        projectContext: string,
        agentConfig?: { type: string; command: string }
    ): Promise<void> {
        if (!this.ensureOrchestrator()) {return;}

        if (agentConfig?.command) {
            const vsConfig = vscode.workspace.getConfiguration('tdad');
            await vsConfig.update('agent.cli.command', agentConfig.command, vscode.ConfigurationTarget.Workspace);
            logCanvas(`Agent configured: ${agentConfig.type} - ${agentConfig.command}`);
        }

        logCanvas(`Starting automation with blueprint generation (mode: ${mode})...`);
        vscode.window.showInformationMessage(AUTOMATION_STARTED_MSG);

        await this._agentOrchestrator!.startWithBlueprint(mode, projectContext);
    }

    /**
     * Stop automation
     */
    handleStopAutomation(): void {
        if (this._agentOrchestrator) {
            this._agentOrchestrator.stop();
            vscode.window.showInformationMessage('⏸️ Automation paused');
        }
    }

    /**
     * Handle agent done signal
     */
    async handleAgentDone(): Promise<void> {
        if (!this._agentOrchestrator) {
            return;
        }

        const allNodes = this.storage.loadAll();
        const allEdges = this.storage.loadAllEdges();
        logCanvas(`_handleAgentDone: loaded ${allNodes.length} nodes and ${allEdges.length} edges for orchestrator`);

        await this._agentOrchestrator.onAgentDone(allNodes, allEdges);
    }

    /**
     * Copy agent system prompt to clipboard
     */
    async handleCopyAgentPrompt(): Promise<void> {
        try {
            const promptService = this.getPromptService();
            const prompt = await promptService.generatePrompt('agent-system-prompt', {});

            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage('📋 Agent system prompt copied to clipboard!');
        } catch (error) {
            logError('CANVAS', 'Failed to copy agent prompt', error);
            vscode.window.showErrorMessage('Failed to copy agent prompt');
        }
    }

    /**
     * Get automation status
     */
    getAutomationStatus(): void {
        if (this._agentOrchestrator) {
            this.webview.postMessage({
                command: 'automationStatusUpdate',
                state: this._agentOrchestrator.getState()
            });
        }
    }

    /**
     * Check if orchestrator is running
     */
    isRunning(): boolean {
        return this._agentOrchestrator?.isRunning() ?? false;
    }

    /**
     * Sprint 15: Get orchestrator state for Slack integration
     */
    getState(): OrchestratorState | null {
        return this._agentOrchestrator?.getState() ?? null;
    }

    /**
     * Get the orchestrator instance (for external coordination)
     */
    getOrchestrator(): AgentOrchestrator | null {
        return this._agentOrchestrator;
    }
}
