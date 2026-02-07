import React, { useState } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { Node } from '../../shared/types';
import '../../styles/tdad-node.css';

interface TDADNodeData {
  node: Node;
  onDelete: (nodeId: string) => void;
  onSelect?: (nodeId: string) => void;
  onEditDescription?: (node: Node) => void;
  edges?: Array<{ id: string; source: string; target: string }>;
  isWorking?: boolean;
  hasBddSpec?: boolean;
  hasTestDetails?: boolean;
  bddHasRealContent?: boolean;
  testHasRealContent?: boolean;
  automationPhase?: 'bdd' | 'tests' | 'run' | 'fix' | null;
}

const TDADNode: React.FC<NodeProps<TDADNodeData>> = ({ data, selected }) => {
  const {
    node, onSelect, onEditDescription, onDelete, edges = [], isWorking,
    hasBddSpec, hasTestDetails, bddHasRealContent, testHasRealContent, automationPhase
  } = data;
  const [isHovered, setIsHovered] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Calculate dependency count from edges (edges where this node is the target)
  const dependencyCount = edges.filter(e => e.target === node.id).length;

  // Single source of truth: read status directly from node fields (no fallback needed)
  const hasBddFeatures = hasBddSpec ?? false;
  const hasTests = hasTestDetails ?? false;

  // 3-bar progress states based on FILE STATE:
  // - Grey: No file exists
  // - Orange: File exists (default template, waiting for real content)
  // - Green: Phase complete (moved to next phase)
  // - Red: Failed (only for Run+Fix)
  type BarState = 'grey' | 'orange' | 'green' | 'red';

  const getBddBarState = (): BarState => {
    // Green: BDD has REAL content (file content differs from default scaffold)
    if (bddHasRealContent) {return 'green';}
    // Orange: BDD file exists but still default template
    if (hasBddFeatures) {return 'orange';}
    // Grey: No BDD file yet
    return 'grey';
  };

  const getTestGenBarState = (): BarState => {
    // Grey: No BDD yet - can't have tests
    if (!hasBddFeatures && !bddHasRealContent) {return 'grey';}
    // Green: Tests have REAL content (file content differs from default scaffold)
    if (testHasRealContent) {return 'green';}
    // Orange: Test file exists but still default template
    if (hasTests) {return 'orange';}
    // Grey: BDD exists but no test file yet
    return 'grey';
  };

  const getTestFixBarState = (): BarState => {
    // Green: Tests passed
    if (node.status === 'passed') {return 'green';}
    // Red: Tests failed
    if (node.status === 'failed') {return 'red';}
    // Orange: Currently testing
    if (node.status === 'testing') {return 'orange';}
    // Grey: Not run yet
    return 'grey';
  };

  const bddState = getBddBarState();
  const testGenState = getTestGenBarState();
  const testFixState = getTestFixBarState();

  const barColors: Record<BarState, string> = {
    grey: '#9ca3af',
    orange: '#f59e0b',
    green: '#4ade80',
    red: '#f87171'
  };

  // Determine if node should have working animation
  const isNodeWorking = isWorking || node.status === 'testing' || node.status === 'generating';
  const isBddWorking = bddState === 'orange';
  const isTestGenWorking = testGenState === 'orange';
  const isTestFixWorking = testFixState === 'orange';

  // Handle node selection
  const handleNodeClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent click from bubbling to canvas pane (which deselects nodes)
    if (onSelect) {
      onSelect(node.id);
    }
  };

  // Handle edit button click
  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onEditDescription) {
      onEditDescription(node);
    }
  };

  // Handle delete button click
  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(true);
  };

  const handleConfirmDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDelete) {
      onDelete(node.id);
    }
    setShowDeleteConfirm(false);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(false);
  };

  // Show floating buttons on hover or selection (not for ghost nodes)
  const showFloatingButtons = (isHovered || selected) && !node.isGhost;

  const getStatusText = (status?: string) => {
    switch (status) {
      case 'pending': return 'Pending';
      case 'spec-saved': return 'Spec Saved';
      case 'ready-to-test': return 'Ready to Test';
      case 'tests-ready': return 'Tests Ready';
      case 'generating': return 'Generating Code...';
      case 'testing': return 'Running Tests...';
      case 'passed': return 'Tests Passed';
      case 'failed': return 'Tests Failed';
      default: return 'Pending';
    }
  };

  const getNodeClassName = () => {
    const classes = ['tdad-node'];
    if (selected) {
      classes.push('tdad-node--selected');
    }

    // Sprint 9: Ghost Node Styling
    if (node.isGhost) {
      classes.push('tdad-node--ghost');
    }

    if (node.status) {
      classes.push(`tdad-node--${node.status}`);
    } else {
      classes.push('tdad-node--default');
    }

    return classes.join(' ');
  };

  const getStatusClassName = () => {
    const statusClass = node.status ? `tdad-node__status-badge--${node.status}` : 'tdad-node__status-badge--default';
    return `tdad-node__status-badge ${statusClass}`;
  };

  return (
    <div
      className={getNodeClassName()}
      onClick={handleNodeClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* ReactFlow handles for edge connections */}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      {/* Sprint 9: Ghost Node Indicator */}
      {node.isGhost && (
        <div style={{
          position: 'absolute',
          top: '-8px',
          right: '-8px',
          fontSize: '14px',
          zIndex: 10,
          backgroundColor: 'var(--vscode-editor-background)',
          borderRadius: '50%',
          border: '1px solid var(--vscode-focusBorder)',
          width: '20px',
          height: '20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }} title="External Dependency (Ghost Node)">
          👻
        </div>
      )}

      {/* Floating Action Buttons - Edit and Delete (no progress bar) */}
      {showFloatingButtons && (
        <div className="tdad-node__floating-buttons">
          <button
            className="tdad-node__floating-btn"
            onClick={handleEditClick}
            title="Edit Description"
          >
            ✎
          </button>
          <button
            className="tdad-node__floating-btn tdad-node__floating-btn--delete"
            onClick={handleDeleteClick}
            title="Delete Node"
          >
            ×
          </button>
        </div>
      )}

      <div className={getStatusClassName()}>
        {getStatusText(node.status)}
      </div>

      <div className="tdad-node__content">
        <div className="tdad-node__title">
          {node.title}
        </div>

        {/* Show description, docs, and dependencies when selected */}
        {selected && (
          <div className="tdad-node__details">
            {node.description ? (
              <div className="tdad-node__description" title={node.description}>
                {node.description.length > 80 ? `${node.description.substring(0, 80)}...` : node.description}
              </div>
            ) : (
              <div className="tdad-node__description tdad-node__description--empty">
                No description
              </div>
            )}
            <div className="tdad-node__meta-badges">
              {/* Test Layers Badge */}
              {node.testLayers && node.testLayers.length > 0 ? (
                <div className="tdad-node__layer-badge" title="Node-level test layer override">
                  🧪 {node.testLayers.includes('ui') && node.testLayers.includes('api')
                    ? 'UI + API'
                    : node.testLayers.includes('ui')
                      ? 'UI'
                      : 'API'}
                </div>
              ) : (
                <div className="tdad-node__layer-badge tdad-node__layer-badge--global" title="Using global test settings">
                  🧪 Global
                </div>
              )}
              {node.contextFiles && node.contextFiles.length > 0 && (
                <div className="tdad-node__docs-count">
                  📄 {node.contextFiles.length} context file{node.contextFiles.length !== 1 ? 's' : ''}
                </div>
              )}
              {dependencyCount > 0 && (
                <div className="tdad-node__deps-count">
                  🔗 {dependencyCount} dep{dependencyCount !== 1 ? 's' : ''}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 3-segment progress bar on the node - always visible */}
      {!node.isGhost && (
        <div className="tdad-node__progress-bar-3">
          <div
            className={`tdad-node__progress-segment ${isBddWorking ? 'tdad-node__progress-segment--animated' : ''}`}
            style={{ backgroundColor: barColors[bddState] }}
            title="Plan"
          />
          <div
            className={`tdad-node__progress-segment ${isTestGenWorking ? 'tdad-node__progress-segment--animated' : ''}`}
            style={{ backgroundColor: barColors[testGenState] }}
            title="Test Generation"
          />
          <div
            className={`tdad-node__progress-segment ${isTestFixWorking ? 'tdad-node__progress-segment--animated' : ''}`}
            style={{ backgroundColor: barColors[testFixState] }}
            title="Test & Fix"
          />
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {showDeleteConfirm && (
        <div className="tdad-node__delete-confirm-overlay" onClick={handleCancelDelete}>
          <div className="tdad-node__delete-confirm" onClick={e => e.stopPropagation()}>
            <div className="tdad-node__delete-confirm-title">
              Delete "{node.title}"?
            </div>
            <div className="tdad-node__delete-confirm-message">
              This will delete the node and all its associated files.
            </div>
            <div className="tdad-node__delete-confirm-buttons">
              <button
                className="tdad-node__delete-confirm-btn tdad-node__delete-confirm-btn--cancel"
                onClick={handleCancelDelete}
              >
                Cancel
              </button>
              <button
                className="tdad-node__delete-confirm-btn tdad-node__delete-confirm-btn--delete"
                onClick={handleConfirmDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default TDADNode;
