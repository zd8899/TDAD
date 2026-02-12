/**
 * Node Utility Helpers
 * Shared utilities for working with Node types across layers
 */

import { Node, NodeInput } from '../types';
import { logCanvas } from './Logger';

export function getNodeInputs(node: Node): NodeInput[] {
    if (node.nodeType === 'feature') {
        return node.inputs || [];
    }
    return [];
}

/**
 * Get all descendant node IDs of a folder (recursive)
 */
export function getDescendantNodeIds(folderId: string, allNodes: Node[]): Set<string> {
    const descendants = new Set<string>();

    logCanvas(`getDescendantNodeIds: Looking for descendants of folder ${folderId}`);
    logCanvas(`getDescendantNodeIds: Total nodes to search: ${allNodes.length}`);

    const collectDescendants = (parentId: string) => {
        for (const node of allNodes) {
            if ((node as any).parentId === parentId) {
                descendants.add(node.id);
                logCanvas(`getDescendantNodeIds: Found descendant: ${node.title} (${node.id}) with parentId=${(node as any).parentId}`);
                if (node.nodeType === 'folder') {
                    collectDescendants(node.id);
                }
            }
        }
    };

    collectDescendants(folderId);
    logCanvas(`getDescendantNodeIds: Found ${descendants.size} total descendants`);
    return descendants;
}

/**
 * Expand folder-level edges into feature-node edges so topological sort respects folder order.
 * - Within each folder: creates a chain based on the children array order (child[0] -> child[1] -> ...)
 * - Across folders: if folder A -> folder B, the last child of A must complete before the first child of B
 */
export function expandFolderEdges(
    featureNodes: Node[],
    allNodes: Node[],
    edges: Array<{ source: string; target: string }>
): Array<{ source: string; target: string }> {
    const featureNodeIds = new Set(featureNodes.map(n => n.id));
    const folderNodes = allNodes.filter(n => n.nodeType === 'folder');
    const folderMap = new Map(folderNodes.map(f => [f.id, f]));
    const expandedEdges: Array<{ source: string; target: string }> = [];

    const getOrderedFeatureChildren = (folderId: string): string[] => {
        const folder = folderMap.get(folderId);
        if (!folder || !(folder as any).children) { return []; }
        return ((folder as any).children as string[]).filter(id => featureNodeIds.has(id));
    };

    for (const folder of folderNodes) {
        const orderedChildren = getOrderedFeatureChildren(folder.id);
        for (let i = 0; i < orderedChildren.length - 1; i++) {
            expandedEdges.push({ source: orderedChildren[i], target: orderedChildren[i + 1] });
        }
    }

    for (const edge of edges) {
        const sourceFolder = folderMap.get(edge.source);
        const targetFolder = folderMap.get(edge.target);

        if (sourceFolder && targetFolder) {
            const sourceChildren = getOrderedFeatureChildren(edge.source);
            const targetChildren = getOrderedFeatureChildren(edge.target);
            if (sourceChildren.length > 0 && targetChildren.length > 0) {
                expandedEdges.push({
                    source: sourceChildren[sourceChildren.length - 1],
                    target: targetChildren[0]
                });
            }
        } else if (featureNodeIds.has(edge.source) && featureNodeIds.has(edge.target)) {
            expandedEdges.push(edge);
        }
    }

    logCanvas(`expandFolderEdges: ${edges.length} original edges -> ${expandedEdges.length} expanded edges`);
    return expandedEdges;
}

/**
 * Sort nodes by dependency order (topological sort)
 */
export function sortNodesByDependency(
    nodes: Node[],
    edges: Array<{ source: string; target: string }>
): Node[] {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const inDegree = new Map<string, number>();
    const adjacencyList = new Map<string, string[]>();

    for (const node of nodes) {
        inDegree.set(node.id, 0);
        adjacencyList.set(node.id, []);
    }

    for (const edge of edges) {
        if (nodeMap.has(edge.source) && nodeMap.has(edge.target)) {
            adjacencyList.get(edge.source)!.push(edge.target);
            inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
        }
    }

    const queue: string[] = [];
    const result: Node[] = [];

    for (const [nodeId, degree] of inDegree) {
        if (degree === 0) {
            queue.push(nodeId);
        }
    }

    while (queue.length > 0) {
        const nodeId = queue.shift()!;
        const node = nodeMap.get(nodeId);
        if (node) {
            result.push(node);
        }

        for (const dependent of adjacencyList.get(nodeId) || []) {
            const newDegree = (inDegree.get(dependent) || 0) - 1;
            inDegree.set(dependent, newDegree);
            if (newDegree === 0) {
                queue.push(dependent);
            }
        }
    }

    for (const node of nodes) {
        if (!result.includes(node)) {
            result.push(node);
        }
    }

    return result;
}
