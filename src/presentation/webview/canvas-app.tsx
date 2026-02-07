import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  ReactFlow,
  addEdge,
  useNodesState,
  useEdgesState,
  Connection,
  ConnectionMode,
  ReactFlowProvider,
  Panel,
  Controls,
  MiniMap,
  Background,
  NodeChange,
  useReactFlow,
  MarkerType,
  OnSelectionChangeFunc,
  Viewport,
} from 'reactflow';
import { Node } from '../../shared/types';
import TDADNode from './TDADNode';
import NodeForm from './NodeForm';
import CustomEdge from './CustomEdge';
import { UnifiedBottomBar } from './UnifiedBottomBar';
import TestDetailsDialog from './TestDetailsDialog';
import BddSpecEditorModal from './BddSpecEditorModal';
import { DependencyPickerModal } from './DependencyPickerModal';
import Breadcrumbs from './Breadcrumbs';
import FolderNodeRenderer from './FolderNodeRenderer';
import { useVSCodeMessaging } from './hooks/useVSCodeMessaging';
import { useNodeActions } from './hooks/useNodeActions';
import { useUndoRedo } from './hooks/useUndoRedo';
import { useAutoLayout } from './hooks/useAutoLayout';
import { createMessageHandler, CanvasMessageState, CanvasMessageDeps } from './hooks/useCanvasMessages';
import { SettingsModal } from './SettingsModal';
import { ProjectWizardModal } from './ProjectWizardModal';
import { WelcomeOverlay } from './WelcomeOverlay';
import { FeedbackForm } from './FeedbackForm';
import { NotificationData } from './CanvasNotification';
import '../../styles/canvas-app.css';
import '../../styles/canvas-controls.css';
import '../../styles/autopilot-confirm-dialog.css';
import '../../styles/template-update-banner.css';
import '../../styles/project-wizard.css';
import { AutopilotConfirmDialog, AutopilotModes } from './AutopilotConfirmDialog';

import { convertTDADNodeToReactFlow } from './utils/nodeConverters';
import { hasCircularDependency, isDuplicateConnection } from './utils/edgeUtils';
import { createNodeHandlers } from './handlers/nodeHandlers';
import { handleNodeFormSubmit, NodeFormData } from './handlers/nodeCreationLogic';

interface BreadcrumbItem {
    nodeId: string;
    title: string;
    nodeType: 'folder' | 'feature';
}

// Hierarchical node types: folders and features
const nodeTypes = {
  tdadNode: TDADNode,
  folderNode: FolderNodeRenderer
};
const edgeTypes = { custom: CustomEdge };

const CanvasApp: React.FC = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Undo/Redo history management
  const { takeSnapshot, undo, redo, canUndo, canRedo } = useUndoRedo(nodes, edges, setNodes, setEdges);

  const [showNodeForm, setShowNodeForm] = useState(false);
  const [nodeFormMode, setNodeFormMode] = useState<'feature' | 'folder'>('feature');
  const [editingNode, setEditingNode] = useState<Node | null>(null);
  const [nodeCounter, setNodeCounter] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reactFlowInstance = useReactFlow();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'project' | 'testing' | 'autopilot' | 'prompts'>('project');
  const [showWelcomeOverlay, setShowWelcomeOverlay] = useState(true);
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);

  // New modal states for context-aware UI
  const [showBddEditor, setShowBddEditor] = useState(false);
  const [showTestDetailsDialog, setShowTestDetailsDialog] = useState(false);
  const [showDependencyPicker, setShowDependencyPicker] = useState(false);
  const [settingsData, setSettingsData] = useState<any>({ models: [], secrets: {}, strategy: undefined });
  const [showBlueprintWizard, setShowBlueprintWizard] = useState(false);
  const [wizardInitialTab, setWizardInitialTab] = useState<'new-project' | 'existing-project'>('new-project');
  const [blueprintDocsFolder, setBlueprintDocsFolder] = useState('');
  const [scaffoldDocs, setScaffoldDocs] = useState<string[]>([]);

  // Navigation state for hierarchical folders
  const [allNodes, setAllNodes] = useState<Node[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumbPath, setBreadcrumbPath] = useState<BreadcrumbItem[]>([]);

  // Viewport state per folder - remembers zoom/pan position when navigating back
  const [viewportByFolder, setViewportByFolder] = useState<Record<string, Viewport>>({});

  // Callback refs for NodeForm file/dependency selection (for new nodes)
  const pendingFileCallbackRef = useRef<((files: string[]) => void) | null>(null);
  const pendingDepCallbackRef = useRef<((nodes: Array<{ id: string; title: string }>) => void) | null>(null);
  // All available nodes for dependency picker (fetched on demand)
  const [dependencyPickerNodes, setDependencyPickerNodes] = useState<Node[]>([]);

  // Sprint 13: Agent Orchestrator state
  const [automationStatus, setAutomationStatus] = useState<'idle' | 'running' | 'paused' | 'completed' | 'error'>('idle');
  const [automationMessage, setAutomationMessage] = useState<string>('');
  const [automationWizardMode, setAutomationWizardMode] = useState(false); // When true, Blueprint Wizard is for automation
  const [workingNodeId, setWorkingNodeId] = useState<string | null>(null); // ID of node currently being automated
  const [automationPhase, setAutomationPhase] = useState<'bdd' | 'tests' | 'run' | 'fix' | null>(null); // Current automation phase

  // Run All Nodes automation state
  const [isRunningAllNodes, setIsRunningAllNodes] = useState(false);
  const [allNodesProgress, setAllNodesProgress] = useState<string>('');

  // Autopilot confirmation dialog state
  const [autopilotDialogOpen, setAutopilotDialogOpen] = useState(false);
  const [autopilotPendingCount, setAutopilotPendingCount] = useState(0);
  const [autopilotFolderName, setAutopilotFolderName] = useState('');
  const [autopilotIsAllFolders, setAutopilotIsAllFolders] = useState(false);
  const [autopilotIsSingleNode, setAutopilotIsSingleNode] = useState(false);
  const [autopilotNodeName, setAutopilotNodeName] = useState('');

  // Canvas notification state
  const [notification, setNotification] = useState<NotificationData | null>(null);

  // Template update state
  const [pendingTemplateUpdates, setPendingTemplateUpdates] = useState<string[] | null>(null);

  // Helper to show notifications
  const showNotification = useCallback((message: string, subMessage?: string, type: NotificationData['type'] = 'info') => {
    setNotification({
      id: Date.now().toString(),
      message,
      subMessage,
      type
    });
  }, []);

  // Create a ref to store handlers so we can use them in callbacks
  const handlersRef = useRef<any>(null);

  // Ref for debouncing position updates
  const positionUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Show all nodes (folders already filtered at backend)
  const filterVisibleNodes = useCallback((allNodes: Node[]) => {
    return allNodes;
  }, []);

  // Create message handler state object for the extracted hook
  const messageState: CanvasMessageState = {
    setCurrentFolderId,
    setBreadcrumbPath,
    setNodes,
    setEdges,
    setAllNodes,
    setIsLoading,
    setError,
    setEditingNode,
    setShowNodeForm,
    setSettingsData,
    setShowSettings,
    setSettingsInitialTab,
    setShowBlueprintWizard,
    setAutomationWizardMode,
    setBlueprintDocsFolder,
    setScaffoldDocs,
    setDependencyPickerNodes,
    setAutomationStatus,
    setAutomationMessage,
    setWorkingNodeId,
    setAutomationPhase,
    setIsRunningAllNodes,
    setAllNodesProgress,
    setAutopilotPendingCount,
    setAutopilotFolderName,
    setAutopilotDialogOpen,
    setShowFeedbackForm,
    setPendingTemplateUpdates
  };

  const messageDeps: CanvasMessageDeps = {
    nodeCounter,
    filterVisibleNodes,
    handlersRef,
    pendingFileCallbackRef,
    showNotification
  };

  const handleMessage = useCallback(
    createMessageHandler(messageState, messageDeps),
    [nodeCounter, filterVisibleNodes, showNotification]
  );

  const { postMessage } = useVSCodeMessaging(handleMessage);

  // Auto-layout hook for arranging nodes (must be after postMessage is available)
  const { handleAutoLayout, isAutoLayoutingRef } = useAutoLayout({
    nodes,
    edges,
    setNodes,
    setAllNodes,
    postMessage,
    takeSnapshot
  });

  // Get the selected node for hooks
  const selectedNode = nodes.find(n => n.id === selectedNodeId)?.data?.node;

  // Use node actions hook for bottom bar and modals
  const [nodeActionsState, nodeActionsHandlers] = useNodeActions(
    selectedNode,
    postMessage,
    edges,
    showNotification
  );

  // Navigation handlers for folder nodes
  const handleNavigateIntoFolder = useCallback((folderId: string) => {
    // Save current viewport before navigating away
    const currentViewport = reactFlowInstance.getViewport();
    setViewportByFolder(prev => ({
      ...prev,
      [currentFolderId ?? 'root']: currentViewport
    }));
    postMessage({ command: 'navigateIntoFolder', folderId });
  }, [postMessage, currentFolderId, reactFlowInstance]);

  const handleNavigateToBreadcrumb = useCallback((folderId: string | null) => {
    // Save current viewport before navigating away
    const currentViewport = reactFlowInstance.getViewport();
    setViewportByFolder(prev => ({
      ...prev,
      [currentFolderId ?? 'root']: currentViewport
    }));
    postMessage({ command: 'navigateToBreadcrumb', folderId });
  }, [postMessage, currentFolderId, reactFlowInstance]);

  const nodeHandlers = createNodeHandlers(
    postMessage,
    setSelectedNodeId
  );

  // Store handlers in ref - includes navigation handlers and floating button handlers
  handlersRef.current = {
    onDelete: nodeHandlers.handleNodeDelete,
    onSelect: nodeHandlers.handleNodeSelect,
    onEditDescription: (node: Node) => {
      setSelectedNodeId(node.id);
      setEditingNode(node);
      setShowNodeForm(true);
    },
    onNavigateInto: handleNavigateIntoFolder,
    edges: edges,
    workingNodeId: workingNodeId,
    automationPhase: automationPhase
  };

  // NOTE: filterVisibleNodes is now defined earlier (before handleMessage) to avoid initialization order issues

  // MVP: Re-render nodes when allNodes changes - APPLY FILTER to exclude folders
  // IMPORTANT: Preserve selection state AND positions from current ReactFlow nodes
  useEffect(() => {
    if (allNodes.length > 0) {
      // Filter out folder nodes before rendering
      const visibleNodes = filterVisibleNodes(allNodes);
      setNodes(currentNodes => {
        // Get current selection state and positions to preserve them
        const selectedNodeIds = new Set(currentNodes.filter(n => n.selected).map(n => n.id));
        const currentPositions = new Map(currentNodes.map(n => [n.id, n.position]));

        const reactFlowNodes = visibleNodes.map((node, index) => {
          const rfNode = convertTDADNodeToReactFlow(node, nodeCounter + index, handlersRef.current);
          // Preserve selection state from current nodes
          if (selectedNodeIds.has(rfNode.id)) {
            rfNode.selected = true;
          }
          // Preserve position from current nodes if available (prevents position reset during drag)
          const currentPosition = currentPositions.get(rfNode.id);
          if (currentPosition) {
            rfNode.position = currentPosition;
          }
          return rfNode;
        });
        return reactFlowNodes;
      });
    }
  }, [allNodes, nodeCounter, filterVisibleNodes]);

  // Real-time status updates - re-render nodes when automation status changes
  // This ensures progress bars and status indicators update during automation
  useEffect(() => {
    if (allNodes.length > 0 && (workingNodeId || automationPhase)) {
      const visibleNodes = filterVisibleNodes(allNodes);
      setNodes(currentNodes => {
        const selectedNodeIds = new Set(currentNodes.filter(n => n.selected).map(n => n.id));
        const currentPositions = new Map(currentNodes.map(n => [n.id, n.position]));

        return visibleNodes.map((node, index) => {
          const rfNode = convertTDADNodeToReactFlow(node, nodeCounter + index, handlersRef.current);
          if (selectedNodeIds.has(rfNode.id)) {
            rfNode.selected = true;
          }
          const currentPosition = currentPositions.get(rfNode.id);
          if (currentPosition) {
            rfNode.position = currentPosition;
          }
          return rfNode;
        });
      });
    }
  }, [workingNodeId, automationPhase, allNodes, nodeCounter, filterVisibleNodes]);

  // Auto-layout on first load if all nodes are at (0,0) + fit view to center
  // Also triggers when navigating into folders (currentFolderId changes)
  // Restores saved viewport when returning to a previously visited folder
  useEffect(() => {
    postMessage({ command: 'canvasLog', message: `[FitView] isLoading=${isLoading}, nodes.length=${nodes.length}, folderId=${currentFolderId}` });
    if (!isLoading && nodes.length > 0) {
      const folderKey = currentFolderId ?? 'root';
      const savedViewport = viewportByFolder[folderKey];

      if (savedViewport) {
        // Returning to folder - restore saved viewport with smooth animation
        postMessage({ command: 'canvasLog', message: `[FitView] Restoring saved viewport for ${folderKey}` });
        setTimeout(() => {
          reactFlowInstance.setViewport(savedViewport, { duration: 200 });
        }, 100);
      } else {
        // First visit to folder - use fitView or auto-layout
        const allAtZero = nodes.every(n => n.position.x === 0 && n.position.y === 0);
        postMessage({ command: 'canvasLog', message: `[FitView] All nodes at (0,0)? ${allAtZero}` });

        if (allAtZero && nodes.length > 1) {
          // Apply auto-layout on first load
          postMessage({ command: 'canvasLog', message: '[FitView] Applying auto-layout' });
          setTimeout(() => {
            handleAutoLayout();
          }, 200);
        } else {
          // Center the view to show all nodes
          setTimeout(() => {
            postMessage({ command: 'canvasLog', message: `[FitView] Calling fitView with ${nodes.length} nodes` });
            reactFlowInstance.fitView({ padding: 0.1, duration: 200, minZoom: 0.1 });
          }, 100);
        }
      }
    }
  }, [isLoading, currentFolderId]); // Trigger on load complete and folder navigation

  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Ctrl+Z (undo) or Ctrl+Y / Ctrl+Shift+Z (redo)
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.key === 'z' && !event.shiftKey) {
          event.preventDefault();
          undo();
        } else if (event.key === 'y' || (event.key === 'z' && event.shiftKey)) {
          event.preventDefault();
          redo();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  useEffect(() => {
    if (edges.length > 0) {
      const timeout = setTimeout(() => {
        // BUG FIX: Filter out ghost edges before sending to backend
        // Ghost edges are for visualization only and should not be persisted
        const persistableEdges = edges.filter(e => !e.id.startsWith('ghost-edge-'));
        if (persistableEdges.length > 0) {
          postMessage({
            command: 'updateEdges',
            edges: persistableEdges.map(e => ({
              id: e.id, source: e.source, target: e.target,
              type: e.type, label: e.data?.label, animated: e.animated
            }))
          });
        }
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [edges, postMessage]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) {return;}
    if (connection.source === connection.target) {return;}
    if (isDuplicateConnection(connection.source, connection.target, edges)) {return;}

    // Take snapshot before adding edge for undo support
    takeSnapshot();

    // Sprint 7: Detect if this is an I/O connection (has sourceHandle/targetHandle)
    const isIOConnection = connection.sourceHandle && connection.targetHandle;

    if (!isIOConnection && hasCircularDependency(connection.source, connection.target, edges)) {
      alert('Cannot create connection: This would create a circular dependency');
      return;
    }

    setEdges((eds) => addEdge({
      ...connection,
      id: connection.sourceHandle && connection.targetHandle
        ? `io-${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`
        : `${connection.source}-${connection.target}`,
      type: 'custom',
      animated: false,
      markerEnd: { type: MarkerType.ArrowClosed }
    }, eds));

    // Sprint 7: If connecting I/O handles, auto-configure the input
    if (isIOConnection && connection.sourceHandle && connection.targetHandle) {
      // Find the target node and update its input configuration
      const targetNode = allNodes.find(n => n.id === connection.target);
      if (targetNode && (targetNode.nodeType === 'feature' || targetNode.nodeType === 'function')) {
        const nodeWithIO = targetNode as any;
        const targetInput = nodeWithIO.inputs?.find((inp: any) => inp.id === connection.targetHandle);

        if (targetInput) {
          // Get the source output name
          const sourceNode = allNodes.find(n => n.id === connection.source);
          const sourceOutput = sourceNode && (sourceNode as any).outputs?.find((out: any) => out.id === connection.sourceHandle);

          // Update input source to reference the connected node
          const updatedInputs = (nodeWithIO.inputs || []).map((inp: any) =>
            inp.id === connection.targetHandle
              ? { ...inp, source: { type: 'node' as const, nodeId: connection.source, outputName: sourceOutput?.name || connection.sourceHandle } }
              : inp
          );

          postMessage({
            command: 'updateNode',
            node: { ...targetNode, inputs: updatedInputs }
          });
        }
      }
    }
    // Edges are the single source of truth for dependencies - no need to update node.dependencies
  }, [edges, setEdges, allNodes, postMessage, takeSnapshot]);

  // Wrap onNodesChange to capture position updates
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    // Check if drag is starting (for undo snapshot)
    const dragStarting = changes.some((change: any) =>
      change.type === 'position' && change.dragging === true
    );
    if (dragStarting) {
      takeSnapshot();
    }

    // Apply changes to nodes immediately
    onNodesChange(changes);

    // Skip position updates if we're doing auto-layout (it handles persistence itself)
    if (isAutoLayoutingRef.current) {
      return;
    }

    // Check if any changes are position changes
    const positionChanges = changes.filter((change: any) =>
      change.type === 'position' && change.dragging === false
    );

    if (positionChanges.length > 0) {
      // Debounce position updates to avoid excessive saves
      if (positionUpdateTimeoutRef.current) {
        clearTimeout(positionUpdateTimeoutRef.current);
      }

      positionUpdateTimeoutRef.current = setTimeout(() => {
        // Get current nodes from ReactFlow (they have updated positions now)
        const currentNodes = reactFlowInstance.getNodes();

        // Collect all updated positions from the current nodes
        // BUG FIX: Only include updates where position actually changed
        const updates = positionChanges.map((change: any) => {
          const node = currentNodes.find(n => n.id === change.id);
          const tdadNode = allNodes.find(n => n.id === change.id);
          if (node && node.position && tdadNode) {
            // Check if position actually changed (not just a selection event)
            // Use 5px threshold to avoid false positives from floating-point rounding
            const oldPos = tdadNode.position || { x: 0, y: 0 };
            const newPos = node.position;
            const positionChanged = Math.abs(oldPos.x - newPos.x) > 5 || Math.abs(oldPos.y - newPos.y) > 5;
            if (positionChanged) {
              return {
                nodeId: change.id,
                position: node.position
              };
            }
          }
          return null;
        }).filter(Boolean);

        if (updates.length > 0) {
          // Update allNodes state immediately so navigation doesn't reset positions
          setAllNodes(prevAllNodes =>
            prevAllNodes.map(tdadNode => {
              const update = updates.find((u: any) => u.nodeId === tdadNode.id);
              if (update) {
                return { ...tdadNode, position: update.position };
              }
              return tdadNode;
            })
          );

          // Send position updates to backend for persistence
          postMessage({
            command: 'updateNodePositions',
            updates
          });
        }
      }, 500); // 500ms debounce
    }
  }, [onNodesChange, reactFlowInstance, postMessage, allNodes, takeSnapshot]);

  const handleAddNode = () => {
    setNodeFormMode('feature');
    setShowNodeForm(true);
  };

  const handleAddFolder = () => {
    setNodeFormMode('folder');
    setShowNodeForm(true);
  };

  const handleCreateNode = (formData: NodeFormData) => {
    handleNodeFormSubmit(
      formData,
      {
        editingNode,
        edges,
        dependencyPickerNodes,
        allNodes,
        currentFolderId,
        nodeCounter
      },
      {
        postMessage,
        setEdges,
        setNodeCounter,
        setEditingNode,
        setShowNodeForm,
        handleNodeUpdate: nodeHandlers.handleNodeUpdate
      }
    );
  };

  const handleOpenWizard = (tab: 'new-project' | 'existing-project') => {
    setWizardInitialTab(tab);
    setShowBlueprintWizard(true);
    setShowWelcomeOverlay(false);
  };

  // Sprint 13: Automation handlers
  const handleStartAutomation = useCallback(() => {
    // Immediate optimistic UI update
    setAutomationStatus('running');
    setAutomationMessage('Starting automation...');
    postMessage({ command: 'startAutomation' });
  }, [postMessage]);

  const handleStopAutomation = useCallback(() => {
    // Immediate optimistic UI update
    setAutomationStatus('paused');
    setAutomationMessage('Pausing automation...');
    postMessage({ command: 'stopAutomation' });
  }, [postMessage]);

  const handleCopyAgentPrompt = useCallback(() => {
    // Show immediate feedback
    setAutomationMessage('Copying agent prompt...');
    if (automationStatus === 'idle') {
      setAutomationStatus('idle');
    }
    postMessage({ command: 'copyAgentPrompt' });
    // Show temporary success message
    setTimeout(() => {
      setAutomationMessage('Agent prompt copied to clipboard!');
      setTimeout(() => {
        if (automationStatus === 'idle') {
          setAutomationMessage('');
        }
      }, 2000);
    }, 100);
  }, [postMessage, automationStatus]);

  // Run All Nodes automation handlers
  const handleRunAllNodes = useCallback(() => {
    // Request autopilot info first - this will trigger the confirmation dialog
    // allFolders: false means only run nodes in current folder
    setAutopilotIsAllFolders(false);
    setAutopilotIsSingleNode(false);
    postMessage({ command: 'getAutopilotInfo', allFolders: false });
  }, [postMessage]);

  // Single node automation handler - called from BottomActionBar
  const handleShowSingleNodeDialog = useCallback(() => {
    if (!selectedNode) {return;}
    setAutopilotIsSingleNode(true);
    setAutopilotIsAllFolders(false);
    setAutopilotNodeName(selectedNode.title);
    setAutopilotPendingCount(1);
    setAutopilotDialogOpen(true);
  }, [selectedNode]);

  // Toggle handler for single node automation (stop if running, show dialog if not)
  const handleToggleSingleNodeAutomation = useCallback(() => {
    if (nodeActionsState.isRunningAutomation) {
      // If running, stop it
      postMessage({ command: 'stopSingleNodeAutomation' });
    } else {
      // If not running, show the dialog
      handleShowSingleNodeDialog();
    }
  }, [nodeActionsState.isRunningAutomation, postMessage, handleShowSingleNodeDialog]);

  // Separate handler for starting single node automation
  const handleStartSingleNodeAutomation = useCallback(() => {
    if (!nodeActionsState.isRunningAutomation) {
      handleShowSingleNodeDialog();
    }
  }, [nodeActionsState.isRunningAutomation, handleShowSingleNodeDialog]);

  // Separate handler for stopping single node automation
  const handleStopSingleNodeAutomation = useCallback(() => {
    postMessage({ command: 'stopSingleNodeAutomation' });
  }, [postMessage]);

  // Autopilot dialog handlers
  const handleAutopilotConfirm = useCallback((modes: AutopilotModes, maxRetries: number, cliSettings?: { preset: string; skipPermissions: boolean }) => {
    setAutopilotDialogOpen(false);

    if (autopilotIsSingleNode && selectedNode) {
      postMessage({
        command: 'runSingleNodeAutomation',
        nodeId: selectedNode.id,
        modes,
        maxRetries,
        cliSettings
      });
    } else {
      setIsRunningAllNodes(true);
      setAllNodesProgress('Starting...');
      postMessage({
        command: 'runAllNodesAutomation',
        confirmed: true,
        allFolders: autopilotIsAllFolders,
        modes,
        maxRetries,
        cliSettings
      });
    }
  }, [postMessage, autopilotIsSingleNode, autopilotIsAllFolders, selectedNode]);

  const handleAutopilotCancel = useCallback(() => {
    setAutopilotDialogOpen(false);
    setAutopilotIsAllFolders(false);
    setAutopilotIsSingleNode(false);
  }, []);

  const handleStopAllNodes = useCallback(() => {
    setIsRunningAllNodes(false);
    setAllNodesProgress('');
    postMessage({ command: 'stopAllNodesAutomation' });
  }, [postMessage]);

  const handleRefreshCanvas = useCallback(() => {
    postMessage({ command: 'refreshCanvas' });
  }, [postMessage]);

  const handleDeleteEdge = useCallback((edgeId: string) => {
    const edge = edges.find(e => e.id === edgeId);
    if (edge) {
      // Take snapshot before deleting edge for undo support
      takeSnapshot();
      setEdges((eds) => eds.filter(e => e.id !== edgeId));

      // Don't send to backend for ghost edges (visualization-only)
      if (edgeId.startsWith('ghost-edge-')) {
        return;
      }

      // Edges are single source of truth - just delete from backend
      postMessage({ command: 'deleteEdge', edgeId });
    }
  }, [edges, setEdges, postMessage, takeSnapshot]);

  // Handle ReactFlow selection changes to sync with our app state
  const handleSelectionChange: OnSelectionChangeFunc = useCallback(({ nodes: selectedNodes }) => {
    if (selectedNodes.length === 1) {
      setSelectedNodeId(selectedNodes[0].id);
    } else if (selectedNodes.length === 0) {
      setSelectedNodeId(null);
    }
  }, []);

  // Transform edges to include onDelete handler for CustomEdge
  const edgesWithDeleteHandler = useMemo(() => {
    return edges.map(edge => ({
      ...edge,
      data: {
        ...edge.data,
        onDelete: handleDeleteEdge
      }
    }));
  }, [edges, handleDeleteEdge]);

  if (isLoading) {
    return (
      <div className="canvas-app__loading">
        <div className="canvas-app__loading-text">Loading TDAD Canvas...</div>
        <div className="canvas-app__loading-spinner" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="canvas-app__error">
        <div className="canvas-app__error-text">❌ {error}</div>
        <button onClick={() => window.location.reload()} className="canvas-app__error-button">
          Reload Canvas
        </button>
      </div>
    );
  }

  return (
    <div className="canvas-container" style={{ display: 'flex', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <div className="canvas-app" style={{ flex: 1, height: '100%', position: 'relative' }}>
        <ReactFlow
          nodes={nodes}
          edges={edgesWithDeleteHandler}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgesDelete={(edgesToDelete) => edgesToDelete.forEach(e => handleDeleteEdge(e.id))}
          onSelectionChange={handleSelectionChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={{
            type: 'custom',
            markerEnd: { type: MarkerType.ArrowClosed }
          }}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={null}
          minZoom={0.1}
        >
          {/* Controls with Auto Layout integrated */}
          <Controls showInteractive={false}>
            <button
              onClick={handleAutoLayout}
              className="react-flow__controls-button"
              title="Auto-arrange nodes in a grid layout"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </button>
          </Controls>

          {!isLoading && nodes.length === 0 && !showBlueprintWizard && showWelcomeOverlay && (
            <WelcomeOverlay
                onStartNew={() => handleOpenWizard('new-project')}
                onImport={() => handleOpenWizard('existing-project')}
                onClose={() => setShowWelcomeOverlay(false)}
            />
          )}

          <MiniMap
            nodeColor={(node) => {
              const status = node.data?.node?.status;
              if (status === 'passed') {return '#22c55e';}
              if (status === 'failed') {return '#ef4444';}
              if (status === 'running') {return '#3b82f6';}
              return '#6366f1';
            }}
            maskColor="rgba(59, 130, 246, 0.1)"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.95)',
              border: '1px solid rgba(0, 0, 0, 0.12)',
              borderRadius: '8px',
              width: 120,
              height: 80
            }}
            zoomable
            pannable
          />
          <Background variant={"dots" as any} gap={12} size={1} />

          {/* Breadcrumbs for hierarchical navigation */}
          <Panel position="top-left" style={{ marginLeft: '10px', marginTop: '10px' }}>
            <Breadcrumbs
              path={breadcrumbPath}
              onNavigate={handleNavigateToBreadcrumb}
            />
          </Panel>

          {pendingTemplateUpdates && pendingTemplateUpdates.length > 0 && (
            <Panel position="top-center" style={{ marginTop: '10px' }}>
              <div className="template-update-banner">
                <span className="template-update-banner__text">
                  {pendingTemplateUpdates.length} prompt template update(s) available
                </span>
                <button
                  className="template-update-banner__btn-primary"
                  onClick={() => postMessage({ command: 'templateUpdateAction', action: 'apply' })}
                >
                  Update All
                </button>
                <button
                  className="template-update-banner__btn-secondary"
                  onClick={() => postMessage({ command: 'templateUpdateAction', action: 'update-review' })}
                >
                  Update &amp; Review
                </button>
                <button
                  className="template-update-banner__btn-dismiss"
                  onClick={() => setPendingTemplateUpdates(null)}
                >
                  ×
                </button>
              </div>
            </Panel>
          )}

          <Panel position="bottom-center" style={{ marginBottom: '40px' }}>
            <UnifiedBottomBar
              // Selection State
              selectedNode={selectedNode}

              // Global Actions (CanvasControls)
              onAddNode={handleAddNode}
              onAddFolder={handleAddFolder}
              onOpenSettings={() => postMessage({ command: 'openSettings' })}
              onRefreshCanvas={handleRefreshCanvas}
              onOpenWaitlist={() => setAutopilotDialogOpen(true)}
              onOpenBlueprintWizard={() => setShowBlueprintWizard(true)}
              canUndo={canUndo}
              canRedo={canRedo}
              onUndo={undo}
              onRedo={redo}
              automationStatus={automationStatus}
              automationMessage={automationMessage}
              onStartAutomation={handleStartAutomation}
              onStopGlobalAutomation={handleStopAutomation}
              onCopyAgentPrompt={handleCopyAgentPrompt}
              isRunningAllNodes={isRunningAllNodes}
              allNodesProgress={allNodesProgress}
              onRunAllNodes={handleRunAllNodes}
              onStopAllNodes={handleStopAllNodes}
              onOpenFeedback={() => postMessage({ command: 'openFeedback' })}

              // Context Actions (BottomActionBar)
              bddSpecFilePath={nodeActionsState.bddSpecFilePath}
              testCodeFilePath={nodeActionsState.testCodeFilePath}
              isGeneratingBdd={nodeActionsState.isGeneratingBdd}
              isGeneratingTest={nodeActionsState.isGeneratingTest}
              isRunningTest={nodeActionsState.isRunningTest}
              isCopyingGoldenPacket={nodeActionsState.isCopyingGoldenPacket}
              isRunningAutomation={nodeActionsState.isRunningAutomation}
              hasTestDetails={nodeActionsState.testDetails.length > 0}
              hasBddSpec={!!nodeActionsState.bddSpec}
              bddHasRealContent={nodeActionsState.bddHasRealContent}
              testHasRealContent={nodeActionsState.testHasRealContent}
              onCopyBddPrompt={nodeActionsHandlers.handleCopyBddPrompt}
              onCopyTestGeneration={nodeActionsHandlers.handleGenerateTestCode}
              onRunTest={nodeActionsHandlers.handleRunTest}
              onCopyGoldenPacket={nodeActionsHandlers.handleCopyGoldenPacket}
              onRunAutomation={handleStartSingleNodeAutomation}
              onStopAutomation={handleStopSingleNodeAutomation}
              onOpenFile={nodeActionsHandlers.handleOpenFile}
              onOpenTestDetails={() => setShowTestDetailsDialog(true)}
              onOpenBddEditor={() => setShowBddEditor(true)}
              notification={notification}
              onDismissNotification={() => setNotification(null)}
            />
          </Panel>
        </ReactFlow>
      </div>

      {/* All modals and panels are rendered here, outside of the transformed canvas area */}
      {showNodeForm && (
        <NodeForm
          node={editingNode}
          mode={editingNode ? 'feature' : nodeFormMode}
          onSubmit={handleCreateNode}
          onCancel={() => { setEditingNode(null); setShowNodeForm(false); setNodeFormMode('feature'); pendingFileCallbackRef.current = null; pendingDepCallbackRef.current = null; }}
          contextFiles={editingNode ? (editingNode.contextFiles || []) : []}
          onAddContextFiles={(callback) => {
            // Unified: always use selectContextFilesForForm for the form
            // Form manages local state, submission handles the actual save
            pendingFileCallbackRef.current = callback;
            postMessage({ command: 'selectContextFilesForForm' });
          }}
          onRemoveContextFile={(filePath) => {
            if (editingNode) {
              nodeActionsHandlers.handleRemoveContextFile(filePath);
            }
            // For new nodes, NodeForm handles it via local state
          }}
          dependencies={editingNode ? edges
            .filter(e => e.target === editingNode.id)
            .map(e => {
              const sourceNode = allNodes.find(n => n.id === e.source);
              return sourceNode ? { id: sourceNode.id, title: sourceNode.title } : null;
            })
            .filter((d): d is { id: string; title: string } => d !== null)
          : []}
          onAddDependency={(callback) => {
            // Unified: always store callback and show picker
            postMessage({ command: 'canvasLog', message: '[DependencyPicker] onAddDependency called, storing callback and requesting nodes' });
            pendingDepCallbackRef.current = callback;
            postMessage({ command: 'requestDependencyPickerNodes' });
            setShowDependencyPicker(true);
          }}
          onRemoveDependency={(nodeId) => {
            if (editingNode) {
              const edgeToRemove = edges.find(e => e.source === nodeId && e.target === editingNode.id);
              if (edgeToRemove) {
                postMessage({ command: 'deleteEdge', edgeId: edgeToRemove.id });
                setEdges(eds => eds.filter(e => e.id !== edgeToRemove.id));
              }
            }
            // For new nodes, NodeForm handles it via local state
          }}
        />
      )}

      <SettingsModal
        show={showSettings}
        settingsData={settingsData}
        onClose={() => {
          setShowSettings(false);
          setSettingsInitialTab('project'); // Reset to default tab on close
        }}
        onUpdateSettings={setSettingsData}
        postMessage={postMessage}
        initialTab={settingsInitialTab}
      />

      <FeedbackForm
        show={showFeedbackForm}
        onClose={() => setShowFeedbackForm(false)}
        postMessage={postMessage}
      />

      <ProjectWizardModal
        show={showBlueprintWizard}
        initialTab={wizardInitialTab}
        onGenerateDocs={(idea, techStack, projectType, database) => postMessage({ command: 'generateProjectDocs', idea, techStack, projectType, database })}
        onGenerateScaffold={(docPaths, testTypes) => postMessage({ command: 'generateProjectScaffold', docPaths, testTypes })}
        onGenerateBlueprint={(mode, context) => postMessage({ command: 'generateBlueprintPrompt', mode, context })}
        onCancel={() => {
          setShowBlueprintWizard(false);
          setAutomationWizardMode(false);
          setScaffoldDocs([]);
          setShowWelcomeOverlay(false); // Keep welcome overlay hidden after wizard closes
        }}
        onSelectDocsFolder={() => postMessage({ command: 'selectDocsFolder' })}
        docsFolderValue={blueprintDocsFolder}
        automationMode={automationWizardMode}
        onStartAutomation={(mode, projectContext) => {
          setShowBlueprintWizard(false);
          setAutomationWizardMode(false);
          postMessage({ command: 'startAutomationWithContext', mode, projectContext });
        }}
        onSelectDocFile={() => postMessage({ command: 'selectDocFile' })}
        scaffoldDocs={scaffoldDocs}
      />

      {/* BDD Spec Editor Modal */}
      {showBddEditor && selectedNode && (
        <BddSpecEditorModal
          show={showBddEditor}
          nodeTitle={selectedNode.title}
          bddSpecFilePath={nodeActionsState.bddSpecFilePath}
          initialSpec={nodeActionsState.bddSpec}
          onSave={(spec) => {
            nodeActionsHandlers.handleSaveBddSpec(spec);
          }}
          onClose={() => setShowBddEditor(false)}
          onOpenFile={nodeActionsHandlers.handleOpenFile}
        />
      )}

      {/* Test Details Dialog */}
      {showTestDetailsDialog && selectedNode && (
        <TestDetailsDialog
          show={showTestDetailsDialog}
          nodeTitle={selectedNode.title}
          testFilePath={nodeActionsState.testCodeFilePath}
          testDetails={nodeActionsState.testDetails}
          onClose={() => setShowTestDetailsDialog(false)}
          onOpenFile={nodeActionsHandlers.handleOpenFile}
        />
      )}

      {/* Dependency Picker Modal */}
      {showDependencyPicker && (() => {
        // Use the same node source for both picker display and confirm handler
        // Priority: 1) dependencyPickerNodes (from backend request), 2) nodeActionsState.allWorkflowNodes, 3) allNodes fallback
        const pickerNodes = dependencyPickerNodes.length > 0
          ? dependencyPickerNodes.filter(n => n.nodeType !== 'folder')
          : (nodeActionsState.allWorkflowNodes.length > 0
            ? nodeActionsState.allWorkflowNodes
            : allNodes.filter(n => n.nodeType !== 'folder'));
        postMessage({ command: 'canvasLog', message: `[DependencyPicker] Rendering modal with ${pickerNodes.length} nodes, hasCallback: ${!!pendingDepCallbackRef.current}` });
        return (
          <DependencyPickerModal
            show={showDependencyPicker}
            currentNodeId={editingNode?.id || selectedNode?.id || 'new-node'}
            allNodes={pickerNodes}
            existingDependencies={editingNode ? edges.filter(e => e.target === editingNode.id).map(e => e.source) : (selectedNode ? edges.filter(e => e.target === selectedNode.id).map(e => e.source) : [])}
            onConfirm={(selectedNodeIds) => {
              postMessage({ command: 'canvasLog', message: `[DependencyPicker] onConfirm with ${selectedNodeIds.length} selected, hasCallback: ${!!pendingDepCallbackRef.current}` });
              // Unified: always use callback if available (from NodeForm)
              if (pendingDepCallbackRef.current) {
                const selectedNodes = pickerNodes
                  .filter(n => selectedNodeIds.includes(n.id))
                  .map(n => ({ id: n.id, title: n.title }));
                postMessage({ command: 'canvasLog', message: `[DependencyPicker] Calling callback with ${selectedNodes.length} nodes: ${selectedNodes.map(n => n.title).join(', ')}` });
                pendingDepCallbackRef.current(selectedNodes);
                pendingDepCallbackRef.current = null;
              } else if (selectedNode) {
                // Fallback for floating button (no NodeForm involved)
                nodeActionsHandlers.handleAddDependency(selectedNodeIds);
              }
              setShowDependencyPicker(false);
              setDependencyPickerNodes([]);
            }}
            onCancel={() => { setShowDependencyPicker(false); pendingDepCallbackRef.current = null; setDependencyPickerNodes([]); }}
          />
        );
      })()}

      {/* Autopilot Confirmation Dialog */}
      {(() => {
        return (
          <AutopilotConfirmDialog
            isOpen={autopilotDialogOpen}
            pendingCount={autopilotPendingCount}
            folderName={autopilotFolderName}
            isAllFolders={autopilotIsAllFolders}
            isSingleNode={autopilotIsSingleNode}
            nodeName={autopilotNodeName}
            cliSettings={settingsData?.cliSettings}
            onConfirm={handleAutopilotConfirm}
            onCancel={handleAutopilotCancel}
            onOpenSettings={() => {
              setSettingsInitialTab('autopilot');
              setShowSettings(true);
            }}
          />
        );
      })()}

    </div>
  );
};

const CanvasAppWrapper: React.FC = () => (
    <ReactFlowProvider>
      <CanvasApp />
    </ReactFlowProvider>
  );

export default CanvasAppWrapper;

