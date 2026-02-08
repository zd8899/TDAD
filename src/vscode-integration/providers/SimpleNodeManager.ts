import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Node, Edge, FolderNode } from '../../shared/types';
import { logCanvas, logError } from '../../shared/utils/Logger';
import { FeatureMapStorage } from '../../infrastructure/storage/FeatureMapStorage';
import { FileNameGenerator } from '../../shared/utils/fileNameGenerator';
import { SimplifiedWorkflowCanvasProvider } from './SimplifiedWorkflowCanvasProvider';

/**
 * Hierarchical node manager with folder navigation support
 * Manages nodes within a specific folder context
 */
export class SimpleNodeManager {
    private _nodes: Node[] = [];
    private _edges: Edge[] = [];
    private _autoSaveTimeout: NodeJS.Timeout | undefined;
    private _currentFolderId: string | null = null;

    constructor(
        private readonly storage: FeatureMapStorage,
        private readonly webview: vscode.Webview
    ) {}

    public getNodes(): Node[] {
        return this._nodes;
    }

    /**
     * Get a node by ID - first checks current context, then falls back to all nodes
     */
    public getNodeById(nodeId: string): Node | undefined {
        // First try current context
        const node = this._nodes.find(n => n.id === nodeId);
        if (node) {
            return node;
        }
        // Fall back to searching all nodes (for Slack/external triggers)
        const allNodes = this.storage.loadAll();
        return allNodes.find(n => n.id === nodeId);
    }

    /**
     * Get all nodes from all workflows/folders (for global dependencies)
     */
    public getAllNodes(): Node[] {
        return this.storage.loadAll();
    }

    /**
     * Set nodes in memory
     * @param nodes - Nodes to set
     * @param skipSave - If true, don't trigger save (used when loading from file to prevent loop)
     */
    public setNodes(nodes: Node[], skipSave = false): void {
        this._nodes = nodes;
        if (!skipSave) {
            this.saveDebounced();
        }
    }

    public getEdges(): Edge[] {
        return this._edges;
    }

    /**
     * Set edges in memory
     * @param edges - Edges to set
     * @param skipSave - If true, don't trigger save (used when loading from file to prevent loop)
     */
    public setEdges(edges: Edge[], skipSave = false): void {
        // BUG FIX: Filter out ghost edges before saving - they are for visualization only
        // Ghost edges have IDs starting with 'ghost-edge-' and should NOT be persisted
        this._edges = edges.filter(e => !e.id.startsWith('ghost-edge-'));
        if (!skipSave) {
            this.saveDebounced();
        }
    }

    /**
     * Add a single edge if not duplicate
     * @returns true if edge was added, false if duplicate
     */
    public addEdge(edge: Edge): boolean {
        if (this._edges.find(e => e.id === edge.id)) {
            return false;
        }
        this._edges.push(edge);
        this.saveDebounced();
        this.notifyEdgesUpdated();
        return true;
    }

    /**
     * Add multiple edges, skipping duplicates
     */
    public addEdges(edges: Edge[]): void {
        let added = false;
        for (const edge of edges) {
            if (!this._edges.find(e => e.id === edge.id)) {
                this._edges.push(edge);
                added = true;
            }
        }
        if (added) {
            this.saveDebounced();
            this.notifyEdgesUpdated();
        }
    }

    /**
     * Remove an edge by ID
     */
    public removeEdge(edgeId: string): void {
        const initialLength = this._edges.length;
        this._edges = this._edges.filter(e => e.id !== edgeId);
        if (this._edges.length !== initialLength) {
            this.saveDebounced();
            this.notifyEdgesUpdated();
        }
    }

    public addNode(node: Node): void {
        // Set parentId to current folder if not already set
        if (this._currentFolderId && !node.parentId) {
            node.parentId = this._currentFolderId;
        }

        // Set workflowId based on parent folder's folderPath (use node.parentId or _currentFolderId)
        const effectiveParentId = node.parentId || this._currentFolderId;
        if (effectiveParentId && !node.workflowId) {
            const parentFolder = this.findParentFolder(effectiveParentId);
            if (!parentFolder) {
                logError('NODE_ADD', `Parent folder not found: ${effectiveParentId}`);
                return;
            }
            const parentPath = (parentFolder as FolderNode).folderPath;
            if (!parentPath) {
                logError('NODE_ADD', `Parent folder has no folderPath: ${effectiveParentId}`);
                return;
            }
            node.workflowId = parentPath;
        }

        // Default to 'default' workflowId if still not set (root level)
        if (!node.workflowId) {
            node.workflowId = 'default';
        }

        // Check if node belongs to current folder context or a different folder
        const nodeParentId = node.parentId || null;
        const currentFolderId = this._currentFolderId || null;

        if (nodeParentId !== currentFolderId) {
            // Node belongs to a different folder - save directly to correct workflow file
            logCanvas(`addNode: Node ${node.id} belongs to folder ${nodeParentId || 'root'}, current folder is ${currentFolderId || 'root'} - using storage.addNodeToWorkflow`);
            this.storage.addNodeToWorkflow(node);
        } else {
            // Node belongs to current folder - add to memory and save
            this._nodes.push(node);
            this.saveDebounced();
        }

        this.notifyNodeAdded(node);
    }

    /**
     * Find parent folder by ID - searches current nodes then all nodes
     */
    private findParentFolder(folderId: string): Node | undefined {
        // First check current nodes
        const folder = this._nodes.find(n => n.id === folderId);
        if (folder) {
            return folder;
        }
        // Search all nodes (parent might be in root.workflow.json)
        const allNodes = this.storage.loadAll();
        return allNodes.find(n => n.id === folderId);
    }

    /**
     * Add a folder node that users can navigate into
     * The workflowId includes the full parent path (e.g., "auth/test-workflow" for "test" folder inside "auth")
     * @param folderData - Folder data including optional parentId
     * @param explicitParentId - Optional explicit parentId (for Slack integration), overrides _currentFolderId
     */
    public addFolder(folderData: Partial<FolderNode>, explicitParentId?: string): void {
        const folderName = (folderData.title || 'new-folder').toLowerCase().replace(/[\s/\\]+/g, '-');

        // Use explicit parentId if provided, otherwise fall back to current folder
        const effectiveParentId = explicitParentId || folderData.parentId || this._currentFolderId;

        // Build the full path from parent folder's folderPath
        let fullPath = folderName;
        if (effectiveParentId) {
            const parentFolder = this.findParentFolder(effectiveParentId);
            if (!parentFolder) {
                logError('FOLDER_ADD', `Parent folder not found: ${effectiveParentId}`);
                return;
            }
            const parentPath = (parentFolder as FolderNode).folderPath;
            if (!parentPath) {
                logError('FOLDER_ADD', `Parent folder has no folderPath: ${effectiveParentId}`);
                return;
            }
            fullPath = `${parentPath}/${folderName}`;
        }

        // Determine workflowId based on parent (where this folder will be saved)
        let folderWorkflowId = 'default';
        if (effectiveParentId) {
            const parentFolder = this.findParentFolder(effectiveParentId);
            if (parentFolder && (parentFolder as FolderNode).folderPath) {
                folderWorkflowId = (parentFolder as FolderNode).folderPath;
            }
        }

        const folder: FolderNode = {
            id: folderData.id || `folder-${Date.now()}`,
            workflowId: folderWorkflowId,
            nodeType: 'folder',
            title: folderData.title || 'New Folder',
            description: folderData.description || '',
            folderPath: fullPath, // Full path for file system
            children: [],
            position: folderData.position || { x: 50, y: 50 },
            status: 'pending',
            parentId: effectiveParentId || undefined,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // Check if folder belongs to current folder context or a different folder
        const currentFolderId = this._currentFolderId || null;

        if (effectiveParentId !== currentFolderId) {
            // Folder belongs to a different parent - save directly to correct workflow file
            logCanvas(`addFolder: Folder ${folder.id} belongs to ${effectiveParentId || 'root'}, current folder is ${currentFolderId || 'root'} - using storage.addNodeToWorkflow`);
            this.storage.addNodeToWorkflow(folder as unknown as Node);
        } else {
            // Folder belongs to current context - add to memory and save
            this._nodes.push(folder);
            this.saveDebounced();
        }

        this.notifyNodeAdded(folder);
        logCanvas(`Created folder: ${folder.title} (${folder.id}) with path: ${fullPath}`);
    }

    public updateNode(updatedNode: Node): void {
        const index = this._nodes.findIndex(n => n.id === updatedNode.id);
        if (index >= 0) {
            // Node is in current folder context - update in memory and save
            logCanvas(`updateNode: Node ${updatedNode.id} (status: ${(updatedNode as any).status}) is in current context, updating at index ${index}`);
            this._nodes[index] = updatedNode;
            this.saveDebounced();
            this.notifyNodeUpdated(updatedNode);
        } else {
            // Node is NOT in current context (e.g., Slack trigger for different workflow)
            // Update directly in the correct workflow file
            logCanvas(`updateNode: Node ${updatedNode.id} (status: ${(updatedNode as any).status}) NOT in current context, using storage.updateNodeById`);
            const success = this.storage.updateNodeById(updatedNode);
            if (success) {
                this.notifyNodeUpdated(updatedNode);
            } else {
                logError('NODE_MANAGER', `updateNode: Failed to update node ${updatedNode.id} via updateNodeById`);
            }
        }
    }

    public deleteNode(nodeId: string): void {
        logCanvas(`=== DELETE NODE START === nodeId: ${nodeId}`);
        logCanvas(`Current folder context: ${this._currentFolderId || 'root'}`);
        logCanvas(`Nodes in current context: ${this._nodes.length}`);
        logCanvas(`Node IDs in context: ${this._nodes.map(n => n.id).join(', ')}`);

        // Find the node before removing to get its details
        const nodeToDelete = this._nodes.find(n => n.id === nodeId);

        if (!nodeToDelete) {
            logCanvas(`WARNING: Node ${nodeId} NOT FOUND in current context nodes!`);
            logCanvas(`Looking for node in all nodes...`);
            const allNodes = this.storage.loadAll();
            const nodeFromAll = allNodes.find(n => n.id === nodeId);
            if (nodeFromAll) {
                logCanvas(`Found node in all nodes: ${nodeFromAll.title} (type: ${nodeFromAll.nodeType})`);
                logCanvas(`Node workflowId: ${nodeFromAll.workflowId}`);
                logCanvas(`Node parentId: ${(nodeFromAll as any).parentId || 'none'}`);
            } else {
                logCanvas(`Node ${nodeId} NOT FOUND anywhere!`);
            }
        } else {
            logCanvas(`Found node to delete: ${nodeToDelete.title} (type: ${nodeToDelete.nodeType})`);
            logCanvas(`Node workflowId: ${nodeToDelete.workflowId}`);
            if (nodeToDelete.nodeType === 'folder') {
                logCanvas(`Folder path: ${(nodeToDelete as any).folderPath}`);
            }
        }

        // Remove the node from memory
        this._nodes = this._nodes.filter(n => n.id !== nodeId);
        logCanvas(`Nodes after removal: ${this._nodes.length}`);

        // Remove all edges connected to this node (both as source and target)
        const edgesBeforeCount = this._edges.length;
        this._edges = this._edges.filter(e => e.source !== nodeId && e.target !== nodeId);
        const edgesRemovedCount = edgesBeforeCount - this._edges.length;

        if (edgesRemovedCount > 0) {
            logCanvas(`Removed ${edgesRemovedCount} edge(s) connected to deleted node ${nodeId}`);
        }

        // Delete node files (feature folder with .feature, .action.js, .test.js, .outputs.json)
        if (nodeToDelete) {
            logCanvas(`Calling deleteNodeFiles for node: ${nodeToDelete.title}`);
            this.deleteNodeFiles(nodeToDelete);
        } else {
            logCanvas(`SKIPPING file deletion - nodeToDelete is null`);
        }

        this.saveDebounced();
        this.notifyNodeDeleted(nodeId);

        // Notify webview about updated edges
        this.notifyEdgesUpdated();
        logCanvas(`=== DELETE NODE END ===`);
    }

    /**
     * Delete all files associated with a node
     * For feature nodes: Files are stored in .tdad/workflows/{workflowFolder}/{fileName}/
     * For folder nodes: Deletes the entire folder including workflow.json and all children
     */
    private deleteNodeFiles(node: Node): void {
        try {
            const workspaceRoot = this.storage.getWorkspaceRoot();

            // Check if this is a folder node - requires special handling
            if (node.nodeType === 'folder') {
                this.deleteFolderNode(node, workspaceRoot);
                return;
            }

            // Feature node deletion logic
            // Try to get folder path from bddSpecFile first (most reliable source)
            // bddSpecFile format: ".tdad\workflows\auth\user-registration\user-registration.feature"
            const nodeAny = node as any;
            let featureDir: string | null = null;

            if (nodeAny.bddSpecFile) {
                // Extract folder path from bddSpecFile
                const bddPath = nodeAny.bddSpecFile.replace(/\\/g, '/');
                const parts = bddPath.split('/');
                // Remove the filename to get directory
                parts.pop();
                featureDir = path.join(workspaceRoot, ...parts);
                logCanvas(`Extracted folder from bddSpecFile: ${featureDir}`);
            }

            // Fallback: construct path from workflowId and fileName
            if (!featureDir || !fs.existsSync(featureDir)) {
                const workflowFolderName = (node.workflowId || this._currentFolderId || 'root').replace(/-workflow$/, '');
                const fileName = FileNameGenerator.getNodeFileName(node as any);
                featureDir = path.join(workspaceRoot, '.tdad', 'workflows', workflowFolderName, fileName);
                logCanvas(`Constructed folder path: ${featureDir}`);
            }

            logCanvas(`Attempting to delete node folder: ${featureDir}`);

            if (fs.existsSync(featureDir)) {
                // Delete all files in the directory
                const files = fs.readdirSync(featureDir);
                for (const file of files) {
                    const filePath = path.join(featureDir, file);
                    try {
                        fs.unlinkSync(filePath);
                        logCanvas(`Deleted file: ${filePath}`);
                    } catch (err) {
                        logError('NODE_DELETE', `Failed to delete file: ${filePath}`, err);
                    }
                }

                // Remove the empty directory
                try {
                    fs.rmdirSync(featureDir);
                    logCanvas(`Deleted node folder: ${featureDir}`);
                } catch (err) {
                    logError('NODE_DELETE', `Failed to delete folder: ${featureDir}`, err);
                }
            } else {
                logCanvas(`Node folder does not exist (nothing to delete): ${featureDir}`);
            }
        } catch (error) {
            logError('NODE_DELETE', `Failed to delete node files for ${node.id}`, error);
        }
    }

    /**
     * Delete a folder node and all its contents
     * This includes the workflow.json and all child nodes (recursively)
     */
    private deleteFolderNode(node: Node, workspaceRoot: string): void {
        try {
            const folderNode = node as FolderNode;
            const folderPath = folderNode.folderPath;

            if (!folderPath) {
                logError('NODE_DELETE', `Folder node ${node.id} has no folderPath`);
                return;
            }

            // Full path to the folder directory: .tdad/workflows/{folderPath}
            const fullFolderPath = path.join(workspaceRoot, '.tdad', 'workflows', folderPath);
            logCanvas(`Attempting to delete folder node directory: ${fullFolderPath}`);

            if (fs.existsSync(fullFolderPath)) {
                // Recursively delete the entire folder and its contents
                this.deleteFolderRecursive(fullFolderPath);
                logCanvas(`Deleted folder node directory: ${fullFolderPath}`);
            } else {
                logCanvas(`Folder node directory does not exist (nothing to delete): ${fullFolderPath}`);
            }
        } catch (error) {
            logError('NODE_DELETE', `Failed to delete folder node ${node.id}`, error);
        }
    }

    /**
     * Recursively delete a directory and all its contents
     */
    private deleteFolderRecursive(dirPath: string): void {
        if (!fs.existsSync(dirPath)) {
            return;
        }

        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                // Recursively delete subdirectory
                this.deleteFolderRecursive(fullPath);
            } else {
                // Delete file
                try {
                    fs.unlinkSync(fullPath);
                    logCanvas(`Deleted file: ${fullPath}`);
                } catch (err) {
                    logError('NODE_DELETE', `Failed to delete file: ${fullPath}`, err);
                }
            }
        }

        // Remove the now-empty directory
        try {
            fs.rmdirSync(dirPath);
            logCanvas(`Deleted directory: ${dirPath}`);
        } catch (err) {
            logError('NODE_DELETE', `Failed to delete directory: ${dirPath}`, err);
        }
    }

    private notifyEdgesUpdated(): void {
        this.webview.postMessage({ command: 'edgesUpdated', edges: this._edges });
    }

    public updateNodePositions(updates: Array<{ nodeId: string; position: { x: number; y: number } }>): void {
        const ghostPositionUpdates: Record<string, { x: number; y: number }> = {};

        for (const update of updates) {
            const node = this._nodes.find(n => n.id === update.nodeId);
            if (node) {
                node.position = update.position;
            } else {
                // Node not found in regular nodes - might be a ghost node
                // Ghost nodes typically have "/" in their ID (e.g., "auth/user-registration")
                // Save their positions separately
                ghostPositionUpdates[update.nodeId] = update.position;
            }
        }

        // Save ghost positions if any
        if (Object.keys(ghostPositionUpdates).length > 0) {
            this.storage.saveGhostPositions(ghostPositionUpdates, this._currentFolderId);
        }

        this.saveDebounced();
    }

    /**
     * Debounced save to avoid excessive file writes
     */
    private saveDebounced(): void {
        if (this._autoSaveTimeout) {
            clearTimeout(this._autoSaveTimeout);
        }

        this._autoSaveTimeout = setTimeout(() => {
            this.saveNow();
        }, 500); // 500ms debounce
    }

    /**
     * Save immediately to hierarchical feature-map.json
     */
    public saveNow(): void {
        try {
            // Log what's being saved for debugging status issues
            const statusSummary = this._nodes.map(n => `${n.id}:${(n as any).status || 'no-status'}`).join(', ');
            logCanvas(`saveNow: Saving ${this._nodes.length} nodes to folder ${this._currentFolderId || 'root'} - statuses: [${statusSummary}]`);

            // Suppress file watcher refresh during internal saves
            SimplifiedWorkflowCanvasProvider.suppressFileWatcherRefresh = true;

            this.storage.save(this._nodes, this._edges, this._currentFolderId);

            // Re-enable file watcher after a delay (give file system time to settle)
            setTimeout(() => {
                SimplifiedWorkflowCanvasProvider.suppressFileWatcherRefresh = false;
            }, 1000);
        } catch (error) {
            logError('NODE_MANAGER', 'Failed to save workflow JSON', error);
        }
    }

    /**
     * Load from hierarchical feature-map.json
     */
    public load(): void {
        const data = this.storage.load(this._currentFolderId);
        this._nodes = data.nodes;
        this._edges = data.edges;
    }

    /**
     * Set current folder context
     */
    public setCurrentFolder(folderId: string | null): void {
        this._currentFolderId = folderId;
    }

    /**
     * Get current folder context
     */
    public getCurrentFolder(): string | null {
        return this._currentFolderId;
    }

    // Webview notifications
    private notifyNodeAdded(node: Node): void {
        this.webview.postMessage({ command: 'nodeAdded', node });
    }

    private notifyNodeUpdated(node: Node): void {
        this.webview.postMessage({ command: 'nodeUpdated', node });
    }

    private notifyNodeDeleted(nodeId: string): void {
        this.webview.postMessage({ command: 'nodeDeleted', nodeId });
    }

    // Sprint 7: Input/Output Node System - Edge Validation
    /**
     * Validate if an edge connection is valid
     * Checks type compatibility, circular dependencies, etc.
     */
    public validateEdgeConnection(
        sourceNodeId: string,
        sourceOutputName: string,
        targetNodeId: string,
        targetInputName: string
    ): { valid: boolean; error?: string } {
        // Can't connect to self
        if (sourceNodeId === targetNodeId) {
            return { valid: false, error: 'Cannot connect node to itself' };
        }

        // Find nodes
        const sourceNode = this._nodes.find(n => n.id === sourceNodeId);
        const targetNode = this._nodes.find(n => n.id === targetNodeId);

        if (!sourceNode || !targetNode) {
            return { valid: false, error: 'Source or target node not found' };
        }

        // Only FeatureNode supports inputs/outputs
        if (
            (sourceNode.nodeType !== 'feature') ||
            (targetNode.nodeType !== 'feature')
        ) {
            return { valid: false, error: 'Only file and function nodes support input/output connections' };
        }

        // Find output and input
        const sourceOutput = (sourceNode as any).outputs?.find((o: any) => o.name === sourceOutputName);
        const targetInput = (targetNode as any).inputs?.find((i: any) => i.name === targetInputName);

        if (!sourceOutput) {
            return { valid: false, error: `Output '${sourceOutputName}' not found on source node` };
        }

        if (!targetInput) {
            return { valid: false, error: `Input '${targetInputName}' not found on target node` };
        }

        // Check type compatibility
        if (sourceOutput.type !== targetInput.type && sourceOutput.type !== 'any' && targetInput.type !== 'any') {
            return {
                valid: false,
                error: `Type mismatch: ${sourceOutput.type} cannot be connected to ${targetInput.type}`
            };
        }

        // Check for circular dependencies
        if (this.wouldCreateCircularDependency(sourceNodeId, targetNodeId)) {
            return { valid: false, error: 'Connection would create circular dependency' };
        }

        return { valid: true };
    }

    /**
     * Check if connecting these nodes would create a circular dependency
     */
    private wouldCreateCircularDependency(sourceNodeId: string, targetNodeId: string): boolean {
        const visited = new Set<string>();
        const queue = [targetNodeId];

        while (queue.length > 0) {
            const currentId = queue.shift()!;
            if (visited.has(currentId)) {continue;}
            visited.add(currentId);

            // If we reached the source node, it's circular
            if (currentId === sourceNodeId) {
                return true;
            }

            // Find all nodes that current node depends on
            const outgoingEdges = this._edges.filter(e => e.source === currentId);
            for (const edge of outgoingEdges) {
                queue.push(edge.target);
            }
        }

        return false;
    }

    /**
     * Update input source when an edge is created
     */
    public updateInputSource(
        nodeId: string,
        inputId: string,
        sourceNodeId: string,
        outputName: string
    ): void {
        const node = this._nodes.find(n => n.id === nodeId);
        if (!node || node.nodeType !== 'feature') {
            return;
        }

        const inputs = (node as any).inputs;
        if (!inputs) {return;}

        const input = inputs.find((i: any) => i.id === inputId);
        if (!input) {return;}

        // Update source configuration
        input.source = {
            type: 'node',
            nodeId: sourceNodeId,
            outputName: outputName
        };

        this.updateNode(node);
    }

    /**
     * Clear input source when an edge is deleted
     */
    public clearInputSource(nodeId: string, inputId: string): void {
        const node = this._nodes.find(n => n.id === nodeId);
        if (!node || node.nodeType !== 'feature') {
            return;
        }

        const inputs = (node as any).inputs;
        if (!inputs) {return;}

        const input = inputs.find((i: any) => i.id === inputId);
        if (!input) {return;}

        // Reset to mock source
        input.source = {
            type: 'mock'
        };

        this.updateNode(node);
    }
}
