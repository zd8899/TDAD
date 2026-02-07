/**
 * Node Utility Helpers
 * Shared utilities for working with Node types across layers
 */

import { Node, NodeInput } from '../types';

/**
 * Get inputs for a node (only FileNode and FunctionNode have inputs)
 * @param node The node to get inputs from
 * @returns Array of inputs, or empty array if node doesn't support inputs
 */
export function getNodeInputs(node: Node): NodeInput[] {
    const nodeType = (node as any).nodeType;
    if (nodeType === 'feature') {
        return (node as any).inputs || [];
    }
    return [];
}
