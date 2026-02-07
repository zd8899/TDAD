/**
 * useCanvasMessages - Message handler hook for canvas-app
 * Extracted from canvas-app.tsx to comply with CLAUDE.md file size limits
 *
 * Handles all VSCode webview message processing
 */

import { MarkerType } from 'reactflow';
import { Node } from '../../../shared/types';
import { convertTDADNodeToReactFlow } from '../utils/nodeConverters';
import { loadNodesFromExtension } from '../handlers/nodeHandlers';
import { sendVSCodeMessage } from './useVSCodeMessaging';
import { NotificationData } from '../CanvasNotification';

export interface CanvasMessageState {
    // Navigation state
    setCurrentFolderId: (id: string | null) => void;
    setBreadcrumbPath: (path: any[]) => void;

    // Node state
    setNodes: (fn: any) => void;
    setEdges: (fn: any) => void;
    setAllNodes: (fn: any) => void;
    setIsLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;

    // Modal state
    setEditingNode: (node: Node | null) => void;
    setShowNodeForm: (show: boolean) => void;
    setSettingsData: (data: any) => void;
    setShowSettings: (show: boolean) => void;
    setSettingsInitialTab: (tab: 'project' | 'testing' | 'autopilot' | 'prompts') => void;
    setShowBlueprintWizard: (show: boolean) => void;
    setAutomationWizardMode: (mode: boolean) => void;

    // Blueprint wizard state
    setBlueprintDocsFolder: (path: string) => void;
    setScaffoldDocs: (fn: any) => void;

    // Dependency picker state
    setDependencyPickerNodes: (nodes: Node[]) => void;

    // Automation state
    setAutomationStatus: (status: any) => void;
    setAutomationMessage: (msg: string) => void;
    setWorkingNodeId: (id: string | null) => void;
    setAutomationPhase: (phase: any) => void;

    // All nodes automation state
    setIsRunningAllNodes: (running: boolean) => void;
    setAllNodesProgress: (progress: string) => void;

    // Autopilot dialog state
    setAutopilotPendingCount: (count: number) => void;
    setAutopilotFolderName: (name: string) => void;
    setAutopilotDialogOpen: (open: boolean) => void;

    // Feedback form state
    setShowFeedbackForm: (show: boolean) => void;

    // Template update state
    setPendingTemplateUpdates: (templates: string[] | null) => void;
}

export interface CanvasMessageDeps {
    nodeCounter: number;
    filterVisibleNodes: (nodes: Node[]) => Node[];
    handlersRef: React.MutableRefObject<any>;
    pendingFileCallbackRef: React.MutableRefObject<((files: string[]) => void) | null>;
    showNotification: (message: string, subMessage?: string, type?: NotificationData['type']) => void;
}

/**
 * Creates a message handler callback for canvas messages
 */
export function createMessageHandler(
    state: CanvasMessageState,
    deps: CanvasMessageDeps
) {
    return (message: any) => {
        switch (message.command) {
            case 'loadNodes':
                handleLoadNodes(message, state, deps);
                break;
            case 'nodeAdded':
            case 'nodeUpdated':
                handleNodeAddedOrUpdated(message, state, deps);
                break;
            case 'nodeDeleted':
                handleNodeDeleted(message, state);
                break;
            case 'edgesUpdated':
                handleEdgesUpdated(message, state);
                break;
            case 'showSettings':
                state.setSettingsData(message.settings || { models: [], secrets: {}, strategy: undefined });
                state.setSettingsInitialTab('project'); // Default to project tab when opened from global control
                state.setShowSettings(true);
                break;
            case 'showFeedbackForm':
                state.setShowFeedbackForm(true);
                break;
            case 'docsFolderSelected':
                if (message.path) {state.setBlueprintDocsFolder(message.path);}
                break;
            case 'docsCreated':
                if (message.files && Array.isArray(message.files)) {
                    state.setScaffoldDocs(message.files);
                }
                break;
            case 'docFileSelected':
                if (message.file) {
                    state.setScaffoldDocs((prev: string[]) =>
                        prev.includes(message.file) ? prev : [...prev, message.file]
                    );
                }
                break;
            case 'contextFilesSelectedForForm':
                if (message.files && deps.pendingFileCallbackRef.current) {
                    deps.pendingFileCallbackRef.current(message.files);
                    deps.pendingFileCallbackRef.current = null;
                }
                break;
            case 'contextFilesAdded':
                // Used by floating button - node updated directly by backend
                break;
            case 'dependencyPickerNodesLoaded':
                if (message.nodes && Array.isArray(message.nodes)) {
                    state.setDependencyPickerNodes(message.nodes);
                }
                break;
            case 'automationStatusUpdate':
                handleAutomationStatusUpdate(message, state);
                break;
            case 'nodeAutomationComplete':
            case 'singleNodeAutomationComplete':
            case 'testResultsUpdated':
                handleNodeAutomationComplete(message, state);
                break;
            case 'showAutomationWizard':
                state.setAutomationWizardMode(true);
                state.setShowBlueprintWizard(true);
                break;
            case 'allNodesFileStatusLoaded':
                handleAllNodesFileStatusLoaded(message, state);
                break;
            case 'allNodesAutomationStatus':
                handleAllNodesAutomationStatus(message, state, deps);
                break;
            case 'autopilotInfo':
                handleAutopilotInfo(message, state, deps);
                break;
            case 'templateUpdatesAvailable':
                state.setPendingTemplateUpdates(message.templates || []);
                break;
            case 'templateUpdatesApplied':
                state.setPendingTemplateUpdates(null);
                deps.showNotification('Prompt templates updated to latest version', undefined, 'success');
                break;
        }
    };
}

// Individual message handlers

function handleLoadNodes(message: any, state: CanvasMessageState, deps: CanvasMessageDeps) {
    state.setCurrentFolderId(message.currentFolderId || null);
    state.setBreadcrumbPath(message.breadcrumbPath || []);

    if (message.edges && Array.isArray(message.edges)) {
        const enhancedEdges = message.edges.map((e: any) => ({
            ...e,
            type: 'custom',
            markerEnd: { type: MarkerType.ArrowClosed }
        }));
        state.setEdges(enhancedEdges);
    }

    loadNodesFromExtension(
        message.nodes,
        deps.nodeCounter,
        state.setNodes,
        state.setIsLoading,
        state.setError,
        deps.handlersRef.current,
        state.setAllNodes,
        deps.filterVisibleNodes
    );

    sendVSCodeMessage({ command: 'checkAllNodesFileStatus' });
}

function handleNodeAddedOrUpdated(message: any, state: CanvasMessageState, deps: CanvasMessageDeps) {
    const rfNode = convertTDADNodeToReactFlow(message.node, deps.nodeCounter, deps.handlersRef.current);

    state.setNodes((nds: any[]) => {
        const idx = nds.findIndex((n: any) => n.id === message.node.id);
        const existingNode = nds.find((n: any) => n.id === message.node.id);
        if (existingNode?.selected) {rfNode.selected = true;}
        if (existingNode?.position) {rfNode.position = existingNode.position;}
        return idx === -1 ? [...nds, rfNode] : nds.map((n: any) => n.id === message.node.id ? rfNode : n);
    });

    state.setAllNodes((prevAllNodes: Node[]) => {
        const idx = prevAllNodes.findIndex((n: Node) => n.id === message.node.id);
        const existingAllNode = prevAllNodes.find((n: Node) => n.id === message.node.id);
        const nodeToStore = existingAllNode?.position
            ? { ...message.node, position: existingAllNode.position }
            : message.node;
        return idx === -1 ? [...prevAllNodes, nodeToStore] : prevAllNodes.map((n: Node) => n.id === message.node.id ? nodeToStore : n);
    });
}

function handleNodeDeleted(message: any, state: CanvasMessageState) {
    state.setNodes((nds: any[]) => nds.filter((n: any) => n.id !== message.nodeId));
    state.setAllNodes((prevAllNodes: Node[]) => prevAllNodes.filter((n: Node) => n.id !== message.nodeId));
    state.setEdges((eds: any[]) => eds.filter((e: any) =>
        e.source !== message.nodeId && e.target !== message.nodeId
    ));
}

function handleEdgesUpdated(message: any, state: CanvasMessageState) {
    if (message.edges && Array.isArray(message.edges)) {
        state.setEdges((currentEdges: any[]) => {
            const ghostEdges = currentEdges.filter((e: any) => e.id.startsWith('ghost-edge-'));
            const enhancedEdges = message.edges.map((e: any) => ({
                ...e,
                type: 'custom',
                markerEnd: { type: MarkerType.ArrowClosed }
            }));
            return [...enhancedEdges, ...ghostEdges];
        });
    }
}

function handleAutomationStatusUpdate(message: any, state: CanvasMessageState) {
    if (message.state) {
        state.setAutomationStatus(message.state.status);
        state.setAutomationMessage(message.state.message || '');

        if (message.state.currentNodeId) {
            state.setWorkingNodeId(message.state.currentNodeId);
        } else if (['completed', 'error', 'idle'].includes(message.state.status)) {
            state.setWorkingNodeId(null);
            state.setAutomationPhase(null);
        }

        if (message.state.phase) {
            state.setAutomationPhase(message.state.phase);
        } else if (message.state.message) {
            const msg = message.state.message.toLowerCase();
            if (msg.includes('bdd') || msg.includes('feature')) {
                state.setAutomationPhase('bdd');
            } else if (msg.includes('test') && !msg.includes('running')) {
                state.setAutomationPhase('tests');
            } else if (msg.includes('running') || msg.includes('executing')) {
                state.setAutomationPhase('run');
            } else if (msg.includes('fix')) {
                state.setAutomationPhase('fix');
            }
        }
    }
}

function handleNodeAutomationComplete(message: any, state: CanvasMessageState) {
    if (message.command === 'nodeAutomationComplete' || message.command === 'singleNodeAutomationComplete') {
        state.setWorkingNodeId(null);
        state.setAutomationPhase(null);
    }

    const newStatus = message.passed ? 'passed' : 'failed';

    state.setNodes((nds: any[]) => nds.map((n: any) => {
        if (n.id === message.nodeId) {
            return {
                ...n,
                data: {
                    ...n.data,
                    node: {
                        ...n.data.node,
                        status: newStatus
                    }
                }
            };
        }
        return n;
    }));

    state.setAllNodes((prevAllNodes: Node[]) => prevAllNodes.map((n: Node) => {
        if (n.id === message.nodeId) {
            return { ...n, status: newStatus };
        }
        return n;
    }));
}

// REMOVED: File status is now stored directly in node fields (single source of truth)
// No need for separate frontend cache
function handleAllNodesFileStatusLoaded(message: any, state: CanvasMessageState) {
    // This handler is no longer needed - file status is in node.hasBddSpec, node.hasTestDetails, etc.
}

function handleAllNodesAutomationStatus(message: any, state: CanvasMessageState, deps: CanvasMessageDeps) {
    if (message.status === 'running') {
        state.setIsRunningAllNodes(true);
        state.setAllNodesProgress(message.message || '');
    } else if (['completed', 'stopped', 'error', 'cancelled'].includes(message.status)) {
        state.setIsRunningAllNodes(false);
        state.setAllNodesProgress('');
        if (message.status === 'completed') {
            deps.showNotification(
                message.passedCount === message.completedCount
                    ? `All ${message.completedCount} nodes passed!`
                    : `${message.passedCount}/${message.completedCount} passed`,
                undefined,
                message.passedCount === message.completedCount ? 'success' : 'warning'
            );
        }
    }
}

function handleAutopilotInfo(message: any, state: CanvasMessageState, deps: CanvasMessageDeps) {
    if (message.error) {
        deps.showNotification(message.error, undefined, 'warning');
        state.setIsRunningAllNodes(false);
    } else {
        state.setAutopilotPendingCount(message.pendingCount);
        state.setAutopilotFolderName(message.folderName || 'this folder');
        state.setAutopilotDialogOpen(true);
    }
}

