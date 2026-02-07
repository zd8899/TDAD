/**
 * Node Utility Helpers
 * Shared utilities for working with Node types across layers
 */

import { Node, NodeInput } from '../types';

export function getNodeInputs(node: Node): NodeInput[] {
    if (node.nodeType === 'feature') {
        return node.inputs || [];
    }
    return [];
}
