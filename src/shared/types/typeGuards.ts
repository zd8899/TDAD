/**
 * Type Guards for Node Union Types
 * Use these to safely access properties of specific node types
 */

import { Node, Feature, FolderNode, FeatureNode } from './index';

export function isFolderNode(node: Node): node is FolderNode {
    return node.nodeType === 'folder';
}

export function isFeatureNode(node: Node): node is FeatureNode {
    return node.nodeType === 'feature';
}

/**
 * Helper to get features from a node safely
 */
export function getNodeFeatures(node: Node): Feature[] {
    return isFeatureNode(node) ? (node.features || []) : [];
}
