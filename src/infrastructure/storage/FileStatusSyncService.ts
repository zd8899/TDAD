/**
 * FileStatusSyncService - Synchronizes node file status fields with actual file system
 * Single source of truth for hasBddSpec, hasTestDetails, bddHasRealContent, testHasRealContent
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Node, FileNode, FunctionNode } from '../../shared/types';
import { getFeatureFilePath, getTestFilePath } from '../../shared/utils/nodePathUtils';
import { getWorkflowFolderName } from '../../shared/utils/stringUtils';
import { logCanvas } from '../../shared/utils/Logger';

export class FileStatusSyncService {
    private fileWatchers: vscode.FileSystemWatcher[] = [];
    private updateCallback?: (nodeId: string, updates: Partial<FileNode | FunctionNode>) => void;

    constructor(private workspacePath: string) {}

    /**
     * Initialize file system watchers for BDD and test files
     */
    initialize(updateCallback: (nodeId: string, updates: Partial<FileNode | FunctionNode>) => void): void {
        this.updateCallback = updateCallback;

        // Watch for BDD spec files (*.feature.md)
        const bddWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspacePath, '**/*.feature.md')
        );

        bddWatcher.onDidCreate(uri => this.handleBddFileChange(uri, 'created'));
        bddWatcher.onDidChange(uri => this.handleBddFileChange(uri, 'changed'));
        bddWatcher.onDidDelete(uri => this.handleBddFileChange(uri, 'deleted'));

        // Watch for test files (*.spec.ts, *.test.ts)
        const testWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspacePath, '**/*.{spec,test}.ts')
        );

        testWatcher.onDidCreate(uri => this.handleTestFileChange(uri, 'created'));
        testWatcher.onDidChange(uri => this.handleTestFileChange(uri, 'changed'));
        testWatcher.onDidDelete(uri => this.handleTestFileChange(uri, 'deleted'));

        this.fileWatchers.push(bddWatcher, testWatcher);
        logCanvas('[FileStatusSync] File watchers initialized');
    }

    /**
     * Sync status fields for a single node
     */
    async syncNodeStatus(node: FileNode | FunctionNode): Promise<Partial<FileNode | FunctionNode>> {
        // Only FileNode has fileName
        if (node.nodeType !== 'file' || !('fileName' in node) || !node.fileName) {
            return {};
        }

        const workflowFolderName = getWorkflowFolderName(node.workflowId);
        const bddPath = getFeatureFilePath(workflowFolderName, node.fileName);
        const testPath = getTestFilePath(workflowFolderName, node.fileName);

        const updates: Partial<FileNode | FunctionNode> = {};

        // Check BDD file
        const bddFullPath = path.join(this.workspacePath, bddPath);
        const bddExists = fs.existsSync(bddFullPath);
        updates.hasBddSpec = bddExists;

        if (bddExists) {
            const bddContent = fs.readFileSync(bddFullPath, 'utf8');
            updates.bddHasRealContent = this.hasRealBddContent(bddContent);
        } else {
            updates.bddHasRealContent = false;
        }

        // Check test file
        const testFullPath = path.join(this.workspacePath, testPath);
        const testExists = fs.existsSync(testFullPath);
        updates.hasTestDetails = testExists;

        if (testExists) {
            const testContent = fs.readFileSync(testFullPath, 'utf8');
            updates.testHasRealContent = this.hasRealTestContent(testContent);
        } else {
            updates.testHasRealContent = false;
        }

        return updates;
    }

    /**
     * Sync status fields for all nodes in a workflow
     */
    async syncAllNodes(nodes: (FileNode | FunctionNode)[]): Promise<Map<string, Partial<FileNode | FunctionNode>>> {
        const updates = new Map<string, Partial<FileNode | FunctionNode>>();

        for (const node of nodes) {
            const nodeUpdates = await this.syncNodeStatus(node);
            if (Object.keys(nodeUpdates).length > 0) {
                updates.set(node.id, nodeUpdates);
            }
        }

        logCanvas(`[FileStatusSync] Synced ${updates.size} nodes`);
        return updates;
    }

    /**
     * Check if BDD content is real (not default scaffold)
     */
    private hasRealBddContent(content: string): boolean {
        return content.length > 0 && !content.includes('# TODO: Add more scenarios based on requirements');
    }

    /**
     * Check if test content is real (not default scaffold)
     */
    private hasRealTestContent(content: string): boolean {
        return content.length > 0 && !content.includes("throw new Error('Test not implemented yet')");
    }

    /**
     * Handle BDD file changes
     */
    private async handleBddFileChange(uri: vscode.Uri, changeType: 'created' | 'changed' | 'deleted'): Promise<void> {
        if (!this.updateCallback) {return;}

        const fileName = path.basename(uri.fsPath, '.feature.md');
        logCanvas(`[FileStatusSync] BDD file ${changeType}: ${fileName}`);

        // Find node by fileName (this requires access to nodes - will be provided by the callback)
        // For now, we'll trigger a re-sync via the callback
        const updates: Partial<FileNode | FunctionNode> = {
            hasBddSpec: changeType !== 'deleted'
        };

        if (changeType !== 'deleted') {
            const content = fs.readFileSync(uri.fsPath, 'utf8');
            updates.bddHasRealContent = this.hasRealBddContent(content);
        } else {
            updates.bddHasRealContent = false;
        }

        // Notify via callback (node ID will be resolved by the caller)
        this.updateCallback(fileName, updates);
    }

    /**
     * Handle test file changes
     */
    private async handleTestFileChange(uri: vscode.Uri, changeType: 'created' | 'changed' | 'deleted'): Promise<void> {
        if (!this.updateCallback) {return;}

        const fileName = path.basename(uri.fsPath).replace(/\.(spec|test)\.ts$/, '');
        logCanvas(`[FileStatusSync] Test file ${changeType}: ${fileName}`);

        const updates: Partial<FileNode | FunctionNode> = {
            hasTestDetails: changeType !== 'deleted'
        };

        if (changeType !== 'deleted') {
            const content = fs.readFileSync(uri.fsPath, 'utf8');
            updates.testHasRealContent = this.hasRealTestContent(content);
        } else {
            updates.testHasRealContent = false;
        }

        this.updateCallback(fileName, updates);
    }

    /**
     * Dispose file watchers
     */
    dispose(): void {
        this.fileWatchers.forEach(watcher => watcher.dispose());
        this.fileWatchers = [];
        logCanvas('[FileStatusSync] File watchers disposed');
    }
}
