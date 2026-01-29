import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Node, Edge } from '../../shared/types';
import { isFolderNode } from '../../shared/types/typeGuards';
import { logCanvas, logError, logger } from '../../shared/utils/Logger';

/**
 * Hierarchical JSON file storage for canvas state
 * - Root: .tdad/workflows/root.workflow.json (contains folder nodes)
 * - Folders: .tdad/workflows/{folderPath}/{folderName}.workflow.json (contains feature nodes)
 * - Features: .tdad/workflows/{folderPath}/{featureName}/*.feature, *.action.js, *.test.js
 */
export class FeatureMapStorage {
    private readonly workspaceRoot: string;
    private readonly featureMapDir: string;
    private _allNodes: Node[] = []; // Cache for folder path resolution

    constructor() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error('No workspace folder found');
        }

        this.workspaceRoot = workspaceFolders[0].uri.fsPath;
        this.featureMapDir = path.join(this.workspaceRoot, '.tdad', 'workflows');

        this.ensureDirectoryExists(this.featureMapDir);
    }

    private ensureDirectoryExists(dirPath: string): void {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            logCanvas(`Created directory: ${dirPath}`);
        }
    }

    /**
     * Get the file path for a specific folder's {name}.workflow.json
     * @param currentFolderId - ID of current folder, or null for root
     * @returns Full path to {name}.workflow.json
     */
    private getFeatureMapFilePath(currentFolderId: string | null): string {
        if (!currentFolderId) {
            return path.join(this.featureMapDir, 'root.workflow.json');
        }

        const folderPath = this.getFolderPath(currentFolderId);
        const folderName = path.basename(folderPath);
        return path.join(this.featureMapDir, folderPath, `${folderName}.workflow.json`);
    }

    /**
     * Get the folder path for a given folder node ID
     * @param folderId - Folder node ID
     * @returns Relative folder path (e.g., "auth", "profile/male")
     */
    public getFolderPath(folderId: string): string {
        const folderNode = this._allNodes.find(n => n.id === folderId);
        if (folderNode && isFolderNode(folderNode)) {
            return folderNode.folderPath || folderId;
        }
        return folderId;
    }

    /**
     * Load canvas state from hierarchical workflow.json
     * @param currentFolderId - ID of current folder, or null for root
     * @param silent - If true, suppress logging (used by loadAll to avoid cascade)
     */
    public load(currentFolderId: string | null = null, silent = false): { nodes: Node[]; edges: Edge[]; ghostPositions?: Record<string, { x: number; y: number }> } {
        try {
            const featureMapFile = this.getFeatureMapFilePath(currentFolderId);

            if (!fs.existsSync(featureMapFile)) {
                return { nodes: [], edges: [] };
            }

            const content = fs.readFileSync(featureMapFile, 'utf-8');
            const data = JSON.parse(content);

            // Update cache for folder path resolution
            if (data.nodes) {
                this._allNodes = [...this._allNodes.filter(n => !data.nodes.find((dn: Node) => dn.id === n.id)), ...data.nodes];
            }

            // Calculate children count for folder nodes by checking child workflow files
            const nodes = data.nodes || [];
            for (const node of nodes) {
                if (isFolderNode(node)) {
                    const childData = this.load(node.id, true);
                    node.children = childData.nodes.map(n => n.id);
                }
            }

            // Only log when not in silent mode (avoids cascade logging from loadAll)
            if (!silent) {
                const location = currentFolderId ? `folder ${this.getFolderPath(currentFolderId)}` : 'root';
                logger.debug('STORAGE', `Loaded ${nodes.length} nodes and ${data.edges?.length || 0} edges from ${location}`);
            }

            return {
                nodes,
                edges: data.edges || [],
                ghostPositions: data.ghostPositions || {}
            };
        } catch (error) {
            logError('STORAGE', 'Failed to load .workflow.json', error);
            return { nodes: [], edges: [] };
        }
    }

    /**
     * Save canvas state to hierarchical {name}.workflow.json
     * @param nodes - Nodes to save
     * @param edges - Edges to save
     * @param currentFolderId - ID of current folder, or null for root
     * @param ghostPositions - Optional ghost node positions to persist
     */
    public save(nodes: Node[], edges: Edge[], currentFolderId: string | null = null, ghostPositions?: Record<string, { x: number; y: number }>): void {
        try {
            const featureMapFile = this.getFeatureMapFilePath(currentFolderId);
            const dirPath = path.dirname(featureMapFile);

            this.ensureDirectoryExists(dirPath);

            // Load existing data to preserve ghostPositions if not provided
            let existingGhostPositions: Record<string, { x: number; y: number }> = {};
            if (fs.existsSync(featureMapFile)) {
                try {
                    const existingContent = fs.readFileSync(featureMapFile, 'utf-8');
                    const existingData = JSON.parse(existingContent);
                    existingGhostPositions = existingData.ghostPositions || {};
                } catch {
                    // Ignore parse errors
                }
            }

            // Strip transient fields from nodes before saving
            const cleanNodes = nodes.map(node => {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { lastTestResults, ...cleanNode } = node as any;
                return cleanNode;
            });

            const data: any = {
                version: '1.0',
                nodes: cleanNodes,
                edges
            };

            // Only include ghostPositions if there are any (merge with existing)
            const mergedGhostPositions = { ...existingGhostPositions, ...(ghostPositions || {}) };
            if (Object.keys(mergedGhostPositions).length > 0) {
                data.ghostPositions = mergedGhostPositions;
            }

            fs.writeFileSync(featureMapFile, JSON.stringify(data, null, 2), 'utf-8');

            // Update cache
            this._allNodes = [...this._allNodes.filter(n => !nodes.find(dn => dn.id === n.id)), ...nodes];

            const location = currentFolderId ? `folder ${this.getFolderPath(currentFolderId)}` : 'root';
            logger.debug('STORAGE', `Saved ${nodes.length} nodes and ${edges.length} edges to ${location}`);
        } catch (error) {
            logError('STORAGE', 'Failed to save .workflow.json', error);
            throw error;
        }
    }

    /**
     * Save only ghost positions without affecting nodes/edges
     * @param ghostPositions - Ghost node positions to save
     * @param currentFolderId - ID of current folder, or null for root
     */
    public saveGhostPositions(ghostPositions: Record<string, { x: number; y: number }>, currentFolderId: string | null = null): void {
        try {
            const featureMapFile = this.getFeatureMapFilePath(currentFolderId);

            if (!fs.existsSync(featureMapFile)) {
                return; // Can't save ghost positions if no workflow file exists
            }

            const content = fs.readFileSync(featureMapFile, 'utf-8');
            const data = JSON.parse(content);

            // Merge with existing ghost positions
            data.ghostPositions = { ...(data.ghostPositions || {}), ...ghostPositions };

            fs.writeFileSync(featureMapFile, JSON.stringify(data, null, 2), 'utf-8');
            logger.debug('STORAGE', `Saved ghost positions for ${Object.keys(ghostPositions).length} nodes`);
        } catch (error) {
            logError('STORAGE', 'Failed to save ghost positions', error);
        }
    }

    /**
     * Get the .tdad/workflows directory path
     */
    public getFeatureMapDir(): string {
        return this.featureMapDir;
    }

    /**
     * Get the workspace root path
     */
    public getWorkspaceRoot(): string {
        return this.workspaceRoot;
    }

    /**
     * Clear all data (for testing/reset)
     * @param currentFolderId - ID of current folder, or null for root
     */
    public clear(currentFolderId: string | null = null): void {
        try {
            const featureMapFile = this.getFeatureMapFilePath(currentFolderId);
            if (fs.existsSync(featureMapFile)) {
                fs.unlinkSync(featureMapFile);
                const location = currentFolderId ? `folder ${this.getFolderPath(currentFolderId)}` : 'root';
                logCanvas(`Cleared .workflow.json in ${location}`);
            }
        } catch (error) {
            logError('STORAGE', 'Failed to clear .workflow.json', error);
        }
    }

    /**
     * Load all nodes from all folders recursively
     * @returns All nodes across all folders
     */
    public loadAll(): Node[] {
        const allNodes: Node[] = [];
        let folderCount = 0;

        // Recursive helper to load folder and its children
        const loadFolderRecursive = (folderId: string | null) => {
            const data = this.load(folderId, true);

            // Ensure parentId is set for nodes loaded from a folder's workflow file
            // This is critical for hierarchical filtering (e.g., "run all nodes in this folder")
            for (const node of data.nodes) {
                if (folderId && !node.parentId) {
                    node.parentId = folderId;
                }
            }

            allNodes.push(...data.nodes);

            for (const node of data.nodes) {
                if (isFolderNode(node)) {
                    folderCount++;
                    loadFolderRecursive(node.id);
                }
            }
        };

        // Start from root
        loadFolderRecursive(null);

        logger.debug('STORAGE', `loadAll: ${allNodes.length} nodes from root + ${folderCount} folders (recursive)`);

        return allNodes;
    }

    /**
     * Add a new node to the correct workflow file based on its parentId
     * Works regardless of current folder context (for Slack/external triggers)
     * @param newNode - Node to add
     */
    public addNodeToWorkflow(newNode: Node): void {
        // Determine which workflow file this node belongs to based on its parentId
        const parentId = newNode.parentId || null;

        // Load nodes and edges from the correct workflow
        const data = this.load(parentId, true);

        // Add the new node
        data.nodes.push(newNode);

        // Save back to the correct workflow file
        this.save(data.nodes, data.edges, parentId);
        logCanvas(`addNodeToWorkflow: Added node ${newNode.id} (${newNode.title}) to workflow ${parentId || 'root'}`);
    }

    /**
     * Update a single node in its correct workflow file
     * Works regardless of current folder context (for Slack/external triggers)
     * @param updatedNode - Node with updated data
     * @returns true if node was found and updated, false otherwise
     */
    public updateNodeById(updatedNode: Node): boolean {
        // Determine which workflow file this node belongs to based on its parentId
        const parentId = updatedNode.parentId || null;

        // Load nodes and edges from the correct workflow
        const data = this.load(parentId, true);
        const nodeIndex = data.nodes.findIndex(n => n.id === updatedNode.id);

        if (nodeIndex === -1) {
            logError('STORAGE', `updateNodeById: Node ${updatedNode.id} not found in workflow ${parentId || 'root'}`);
            return false;
        }

        // Update the node
        data.nodes[nodeIndex] = updatedNode;

        // Save back to the correct workflow file
        this.save(data.nodes, data.edges, parentId);
        logCanvas(`updateNodeById: Updated node ${updatedNode.id} (${updatedNode.title}) in workflow ${parentId || 'root'}`);

        return true;
    }

    /**
     * Load all edges from all folders recursively
     * @returns All edges across all folders
     */
    public loadAllEdges(): Edge[] {
        const allEdges: Edge[] = [];
        let folderCount = 0;

        // Recursive helper to load folder edges and its children
        const loadFolderRecursive = (folderId: string | null) => {
            const data = this.load(folderId, true);
            allEdges.push(...data.edges);

            for (const node of data.nodes) {
                if (isFolderNode(node)) {
                    folderCount++;
                    loadFolderRecursive(node.id);
                }
            }
        };

        // Start from root
        loadFolderRecursive(null);

        logger.debug('STORAGE', `loadAllEdges: ${allEdges.length} edges from root + ${folderCount} folders (recursive)`);

        return allEdges;
    }
}
