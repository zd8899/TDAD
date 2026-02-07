import { Node as ReactFlowNode } from 'reactflow';
import { Node } from '../../../shared/types';
import { isFolderNode } from '../../../shared/types/typeGuards';

// Node handlers interface
interface NodeHandlers {
  onDelete: (nodeId: string) => void;
  onSelect?: (nodeId: string) => void;
  onEditDescription?: (node: Node) => void;
  onNavigateInto?: (folderId: string) => void;
  edges?: any[];
  workingNodeId?: string | null;
  automationPhase?: 'bdd' | 'tests' | 'run' | 'fix' | null;
}

/**
 * Convert a TDAD node to a ReactFlow node based on its type
 */
export const convertTDADNodeToReactFlow = (
  tdadNode: Node,
  nodeCounter: number,
  handlers?: NodeHandlers
): ReactFlowNode => {
  // Arrange nodes in a grid pattern (4 nodes per row)
  const nodesPerRow = 4;
  const horizontalSpacing = 220;
  const verticalSpacing = 200;
  const startX = 50;
  const startY = 50;

  const col = nodeCounter % nodesPerRow;
  const row = Math.floor(nodeCounter / nodesPerRow);

  const position = tdadNode.position || {
    x: startX + (col * horizontalSpacing),
    y: startY + (row * verticalSpacing)
  };

  // Determine node type and build appropriate data
  if (isFolderNode(tdadNode)) {
    // Folder node - no selection, only navigation
    return {
      id: tdadNode.id,
      type: 'folderNode',
      position,
      data: {
        node: tdadNode,
        onNavigateInto: handlers?.onNavigateInto || (() => { /* no-op */ }),
        onDelete: handlers?.onDelete || (() => { /* no-op */ }),
      }
    };
  }

  // Feature node - includes selection and editing
  // Read file status directly from node fields (single source of truth)
  const nodeData = {
    node: tdadNode,
    onDelete: handlers?.onDelete,
    onSelect: handlers?.onSelect,
    onEditDescription: handlers?.onEditDescription,
    edges: handlers?.edges || [],
    isWorking: handlers?.workingNodeId === tdadNode.id,
    automationPhase: handlers?.workingNodeId === tdadNode.id ? handlers?.automationPhase : null,
    hasBddSpec: (tdadNode as any).hasBddSpec,
    hasTestDetails: (tdadNode as any).hasTestDetails,
    bddHasRealContent: (tdadNode as any).bddHasRealContent,
    testHasRealContent: (tdadNode as any).testHasRealContent,
  };

  return {
    id: tdadNode.id,
    type: 'tdadNode',
    position,
    data: nodeData
  };
};
