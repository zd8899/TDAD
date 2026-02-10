/**
 * FileStatusSyncService - Synchronizes node file status fields with actual file system
 * Single source of truth for hasBddSpec, hasTestDetails, bddHasRealContent, testHasRealContent
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Node, FeatureNode } from '../../shared/types';
import { logCanvas } from '../../shared/utils/Logger';
import { resolveNodeFileStatus } from '../../shared/utils/nodeFileStatusResolver';

export class FileStatusSyncService {
    private fileWatchers: vscode.FileSystemWatcher[] = [];
    private updateCallback?: (nodeId: string, updates: Partial<FeatureNode>) => void;

    constructor(private workspacePath: string) {}

    /**
     * Initialize file system watchers for BDD and test files
     */
    initialize(updateCallback: (nodeId: string, updates: Partial<FeatureNode>) => void): void {
        this.updateCallback = updateCallback;

        // Watch for BDD spec files (*.feature and legacy *.feature.md)
        const bddWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspacePath, '**/*.feature')
        );
        const bddLegacyWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspacePath, '**/*.feature.md')
        );

        bddWatcher.onDidCreate(uri => this.handleBddFileChange(uri, 'created'));
        bddWatcher.onDidChange(uri => this.handleBddFileChange(uri, 'changed'));
        bddWatcher.onDidDelete(uri => this.handleBddFileChange(uri, 'deleted'));
        bddLegacyWatcher.onDidCreate(uri => this.handleBddFileChange(uri, 'created'));
        bddLegacyWatcher.onDidChange(uri => this.handleBddFileChange(uri, 'changed'));
        bddLegacyWatcher.onDidDelete(uri => this.handleBddFileChange(uri, 'deleted'));

        // Watch for test files used by TDAD (*.test.js) and legacy TS tests
        const testWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspacePath, '**/*.{spec,test}.{js,ts}')
        );

        testWatcher.onDidCreate(uri => this.handleTestFileChange(uri, 'created'));
        testWatcher.onDidChange(uri => this.handleTestFileChange(uri, 'changed'));
        testWatcher.onDidDelete(uri => this.handleTestFileChange(uri, 'deleted'));

        this.fileWatchers.push(bddWatcher, bddLegacyWatcher, testWatcher);
        logCanvas('[FileStatusSync] File watchers initialized');
    }

    /**
     * Sync status fields for a single node
     */
    async syncNodeStatus(node: FeatureNode): Promise<Partial<FeatureNode>> {
        const status = resolveNodeFileStatus(this.workspacePath, node as Node);
        return {
            hasBddSpec: status.hasBddSpec,
            hasTestDetails: status.hasTestDetails,
            bddHasRealContent: status.bddHasRealContent,
            testHasRealContent: status.testHasRealContent
        };
    }

    /**
     * Sync status fields for all nodes in a workflow
     */
    async syncAllNodes(nodes: FeatureNode[]): Promise<Map<string, Partial<FeatureNode>>> {
        const updates = new Map<string, Partial<FeatureNode>>();

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

        const fileName = path.basename(uri.fsPath).replace(/\.feature(\.md)?$/, '');
        logCanvas(`[FileStatusSync] BDD file ${changeType}: ${fileName}`);

        // Find node by fileName (this requires access to nodes - will be provided by the callback)
        // For now, we'll trigger a re-sync via the callback
        const updates: Partial<FeatureNode> = {
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

        const fileName = path.basename(uri.fsPath).replace(/\.(spec|test)\.(ts|js)$/, '');
        logCanvas(`[FileStatusSync] Test file ${changeType}: ${fileName}`);

        const updates: Partial<FeatureNode> = {
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
