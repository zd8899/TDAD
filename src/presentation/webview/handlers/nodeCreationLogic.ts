/**
 * Node Creation Logic - Business logic for creating and editing nodes
 *
 * Extracted from canvas-app.tsx to improve maintainability.
 * Contains pure business logic for node creation with dependency handling.
 */

import { MarkerType } from 'reactflow';
import { Node } from '../../../shared/types';
import { getWorkflowFolderName } from '../../../shared/utils/stringUtils';

export interface NodeFormData {
    title: string;
    description: string;
    autoRun: boolean;
    mode?: 'feature' | 'folder';
    contextFiles: string[];
    dependencyIds: string[];
    testLayers?: ('ui' | 'api')[];
}

export interface NodeCreationDeps {
    editingNode: Node | null;
    edges: Array<{ id: string; source: string; target: string }>;
    dependencyPickerNodes: Node[];
    allNodes: Node[];
    currentFolderId: string | null;
    nodeCounter: number;
}

export interface NodeCreationActions {
    postMessage: (msg: any) => void;
    setEdges: (fn: (edges: any[]) => any[]) => void;
    setNodeCounter: (fn: (n: number) => number) => void;
    setEditingNode: (node: Node | null) => void;
    setShowNodeForm: (show: boolean) => void;
    handleNodeUpdate: (node: Node) => void;
}

interface DependencyClassification {
    crossFolderDeps: string[];
    sameFolderDeps: string[];
}

/**
 * Classify dependencies into cross-folder and same-folder
 */
function classifyDependencies(
    dependencyIds: string[],
    targetParentId: string | null,
    dependencyPickerNodes: Node[],
    allNodes: Node[]
): DependencyClassification {
    const crossFolderDeps: string[] = [];
    const sameFolderDeps: string[] = [];

    for (const sourceId of dependencyIds) {
        const sourceNode = dependencyPickerNodes.find(n => n.id === sourceId) ||
                          allNodes.find(n => n.id === sourceId);

        if (sourceNode) {
            const sourceParentId = (sourceNode as any).parentId || null;

            if (sourceParentId !== targetParentId) {
                // Cross-folder: use qualified ID (workflowId/nodeId)
                const qualifiedId = sourceNode.workflowId
                    ? `${getWorkflowFolderName(sourceNode.workflowId)}/${sourceId}`
                    : sourceId;
                crossFolderDeps.push(qualifiedId);
            } else {
                sameFolderDeps.push(sourceId);
            }
        } else {
            sameFolderDeps.push(sourceId);
        }
    }

    return { crossFolderDeps, sameFolderDeps };
}

/**
 * Create edge object for dependency visualization
 */
function createEdge(sourceId: string, targetId: string) {
    return {
        id: `${sourceId}-${targetId}`,
        source: sourceId,
        target: targetId,
        type: 'custom',
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed }
    };
}

/**
 * Handle editing an existing node
 */
function handleEditNode(
    formData: NodeFormData,
    deps: NodeCreationDeps,
    actions: NodeCreationActions
): void {
    const { editingNode, edges, dependencyPickerNodes, allNodes, currentFolderId } = deps;
    const { postMessage, setEdges, handleNodeUpdate, setEditingNode } = actions;

    if (!editingNode) {return;}

    // Find new dependencies (not already connected)
    const existingDependencyIds = edges
        .filter(e => e.target === editingNode.id)
        .map(e => e.source);
    const newDependencyIds = (formData.dependencyIds || []).filter(
        id => !existingDependencyIds.includes(id)
    );

    // Classify new dependencies
    const targetParentId = (editingNode as any).parentId || currentFolderId || null;
    const { crossFolderDeps, sameFolderDeps } = classifyDependencies(
        newDependencyIds,
        targetParentId,
        dependencyPickerNodes,
        allNodes
    );

    // Update node with cross-folder dependencies
    const existingNodeDeps = (editingNode as any).dependencies || [];
    const updatedDependencies = [...existingNodeDeps, ...crossFolderDeps];
    const updatedNode = {
        ...editingNode,
        title: formData.title,
        description: formData.description,
        contextFiles: formData.contextFiles,
        dependencies: updatedDependencies.length > 0 ? updatedDependencies : undefined,
        testLayers: formData.testLayers
    };
    handleNodeUpdate(updatedNode);

    // Create edges for same-folder dependencies
    for (const sourceId of sameFolderDeps) {
        const newEdge = createEdge(sourceId, editingNode.id);
        postMessage({ command: 'addEdge', edge: newEdge });
        setEdges(eds => [...eds, newEdge]);
    }

    // Create edges for cross-folder dependencies (immediate feedback)
    for (const qualifiedId of crossFolderDeps) {
        const newEdge = createEdge(qualifiedId, editingNode.id);
        postMessage({ command: 'addEdge', edge: newEdge });
        setEdges(eds => [...eds, newEdge]);
    }

    setEditingNode(null);
}

/**
 * Calculate position for new node in grid layout
 */
function calculateNodePosition(nodeCounter: number) {
    const nodesPerRow = 4;
    const horizontalSpacing = 220;
    const verticalSpacing = 200;
    const startX = 50;
    const startY = 50;
    const col = nodeCounter % nodesPerRow;
    const row = Math.floor(nodeCounter / nodesPerRow);

    return { x: startX + (col * horizontalSpacing), y: startY + (row * verticalSpacing) };
}

/**
 * Handle creating a new folder node
 */
function handleCreateFolder(
    formData: NodeFormData,
    deps: NodeCreationDeps,
    actions: NodeCreationActions
): void {
    const { nodeCounter } = deps;
    const { postMessage, setNodeCounter } = actions;

    const position = calculateNodePosition(nodeCounter);

    const newFolder: any = {
        id: `folder-${Date.now()}`,
        workflowId: '',
        title: formData.title,
        description: formData.description || '',
        nodeType: 'folder' as const,
        folderPath: '',
        children: [],
        position,
        status: 'pending' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    setNodeCounter(prev => prev + 1);
    postMessage({ command: 'createFolderFromForm', node: newFolder });
}

/**
 * Handle creating a new feature/file node
 */
function handleCreateFeature(
    formData: NodeFormData,
    deps: NodeCreationDeps,
    actions: NodeCreationActions
): void {
    const { dependencyPickerNodes, allNodes, currentFolderId, nodeCounter } = deps;
    const { postMessage, setNodeCounter } = actions;

    // Classify dependencies
    const { crossFolderDeps, sameFolderDeps } = classifyDependencies(
        formData.dependencyIds || [],
        currentFolderId,
        dependencyPickerNodes,
        allNodes
    );

    const position = calculateNodePosition(nodeCounter);

    const newNode: any = {
        id: `node-${Date.now()}`,
        workflowId: '',
        title: formData.title,
        description: formData.description,
        nodeType: 'feature' as const,
        filePath: '',
        fileName: formData.title.toLowerCase().replace(/[\s/\\]+/g, '-'),
        language: 'typescript',
        preConditions: [],
        features: [],
        testData: null,
        contextFiles: formData.contextFiles || [],
        dependencies: crossFolderDeps.length > 0 ? crossFolderDeps : undefined,
        testLayers: formData.testLayers,
        position,
        status: 'pending' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    setNodeCounter(prev => prev + 1);
    postMessage({
        command: 'createNodeFromForm',
        node: newNode,
        autoRun: formData.autoRun,
        dependencyIds: sameFolderDeps
    });
}

/**
 * Main handler for node creation/editing
 *
 * Routes to appropriate handler based on whether we're editing or creating,
 * and whether creating a folder or feature.
 */
export function handleNodeFormSubmit(
    formData: NodeFormData,
    deps: NodeCreationDeps,
    actions: NodeCreationActions
): void {
    if (deps.editingNode) {
        handleEditNode(formData, deps, actions);
    } else if (formData.mode === 'folder') {
        handleCreateFolder(formData, deps, actions);
    } else {
        handleCreateFeature(formData, deps, actions);
    }

    actions.setShowNodeForm(false);
}
