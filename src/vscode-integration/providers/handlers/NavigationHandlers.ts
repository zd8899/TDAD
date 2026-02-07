/**
 * NavigationHandlers - Handles folder navigation operations
 *
 * Extracted from SimplifiedWorkflowCanvasProvider to comply with CLAUDE.md file size limits
 * Manages: Folder navigation, breadcrumb navigation, parent navigation
 */

import * as vscode from 'vscode';
import { FolderNode } from '../../../shared/types';
import { isFolderNode } from '../../../shared/types/typeGuards';
import { logCanvas, logError } from '../../../shared/utils/Logger';
import { FeatureMapStorage } from '../../../infrastructure/storage/FeatureMapStorage';
import { SimpleNodeManager } from '../SimpleNodeManager';
import { SimpleWorkflowLoader } from '../SimpleWorkflowLoader';

interface BreadcrumbItem {
    nodeId: string;
    title: string;
    nodeType: 'folder' | 'feature';
}

export class NavigationHandlers {
    constructor(
        private readonly webview: vscode.Webview,
        private readonly storage: FeatureMapStorage,
        private readonly nodeManager: SimpleNodeManager,
        private readonly workflowLoader: SimpleWorkflowLoader,
        private readonly breadcrumbPath: BreadcrumbItem[],
        private currentFolderId: string | null,
        private readonly onFolderChange: (folderId: string | null, breadcrumbs: BreadcrumbItem[]) => void
    ) {}

    /**
     * Navigate into a folder node
     */
    async handleNavigateIntoFolder(folderId: string): Promise<void> {
        try {
            const folderNode = this.nodeManager.getNodes().find(n => n.id === folderId);
            if (!folderNode || !isFolderNode(folderNode)) {
                vscode.window.showErrorMessage('Selected node is not a folder');
                return;
            }

            this.breadcrumbPath.push({
                nodeId: folderNode.id,
                title: folderNode.title,
                nodeType: 'folder'
            });

            this.currentFolderId = folderId;
            this.onFolderChange(this.currentFolderId, this.breadcrumbPath);

            logCanvas(`Navigated into folder: ${folderNode.title}`);
        } catch (error) {
            logError('CANVAS', 'Failed to navigate into folder', error);
            vscode.window.showErrorMessage('Failed to navigate into folder');
        }
    }

    /**
     * Navigate to parent folder
     */
    async handleNavigateToParent(): Promise<void> {
        try {
            if (this.breadcrumbPath.length === 0) {
                return;
            }

            this.breadcrumbPath.pop();

            if (this.breadcrumbPath.length === 0) {
                this.currentFolderId = null;
            } else {
                const parent = this.breadcrumbPath[this.breadcrumbPath.length - 1];
                this.currentFolderId = parent.nodeId;
            }

            this.onFolderChange(this.currentFolderId, this.breadcrumbPath);

            const location = this.currentFolderId ? `folder ${this.storage.getFolderPath(this.currentFolderId)}` : 'root';
            logCanvas(`Navigated to parent: ${location}`);
        } catch (error) {
            logError('CANVAS', 'Failed to navigate to parent', error);
            vscode.window.showErrorMessage('Failed to navigate to parent');
        }
    }

    /**
     * Navigate to a specific breadcrumb (folder in path)
     */
    async handleNavigateToBreadcrumb(folderId: string | null): Promise<void> {
        try {
            if (folderId === null) {
                this.breadcrumbPath.length = 0;
                this.currentFolderId = null;
            } else {
                const index = this.breadcrumbPath.findIndex(b => b.nodeId === folderId);
                if (index === -1) {
                    vscode.window.showErrorMessage('Folder not found in breadcrumb path');
                    return;
                }

                this.breadcrumbPath.splice(index + 1);
                this.currentFolderId = folderId;
            }

            this.onFolderChange(this.currentFolderId, this.breadcrumbPath);

            const location = this.currentFolderId ? `folder ${this.storage.getFolderPath(this.currentFolderId)}` : 'root';
            logCanvas(`Navigated to breadcrumb: ${location}`);
        } catch (error) {
            logError('CANVAS', 'Failed to navigate to breadcrumb', error);
            vscode.window.showErrorMessage('Failed to navigate to breadcrumb');
        }
    }
}
