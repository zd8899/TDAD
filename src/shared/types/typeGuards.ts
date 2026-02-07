/**
 * Type Guards for Node Union Types
 * Use these to safely access properties of specific node types
 */

import { Node, FolderNode, FileNode, FunctionNode } from './index';

export function isFolderNode(node: Node): node is FolderNode {
    return node.nodeType === 'folder';
}

function hasFeatures(node: Node): node is FileNode | FunctionNode {
    return node.nodeType === 'feature' || node.nodeType === 'function';
}

/**
 * Helper to get features from a node safely
 */
export function getNodeFeatures(node: Node) {
    return hasFeatures(node) ? node.features : [];
}
