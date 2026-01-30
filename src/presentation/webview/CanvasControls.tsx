import React from 'react';
import '../../styles/canvas-controls.css';

interface CanvasControlsProps {
  hasSelectedNode: boolean;
  onAddNode: () => void;
  onAddFolder: () => void;
  onOpenSettings?: () => void;
  onRefreshCanvas?: () => void;
  onOpenBlueprintWizard?: () => void;
  // Undo/Redo
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  // Sprint 13: Automation controls
  automationStatus?: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  automationMessage?: string;
  onStartAutomation?: () => void;
  onStopAutomation?: () => void;
  onCopyAgentPrompt?: () => void;
  // Run All Nodes automation
  isRunningAllNodes?: boolean;
  allNodesProgress?: string;
  onRunAllNodes?: () => void;
  onStopAllNodes?: () => void;
  onOpenFeedback?: () => void;
}

const CanvasControls: React.FC<CanvasControlsProps> = ({
  onAddNode,
  onAddFolder,
  onOpenSettings,
  onRefreshCanvas,
  onOpenBlueprintWizard,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  isRunningAllNodes = false,
  allNodesProgress,
  onRunAllNodes,
  onStopAllNodes,
  onOpenFeedback
}) => {
  const handleAutopilotClick = () => {
    if (!isRunningAllNodes) {
      onRunAllNodes?.();
    }
  };

  const handleStopClick = () => {
    onStopAllNodes?.();
  };

  return (
    <div className="canvas-controls__row">
      {/* Run All Nodes - Separate pill on the left with Start and Stop buttons */}
      <div className="canvas-controls__auto-container">
        <button
          onClick={handleAutopilotClick}
          className={`canvas-controls__segment canvas-controls__segment--auto ${isRunningAllNodes ? 'canvas-controls__segment--disabled-running' : ''}`}
          disabled={isRunningAllNodes}
          title="Engage Auto-Pilot for all pending nodes"
        >
          <span className="canvas-controls__icon">✈</span>
          <span>Auto-Pilot All</span>
        </button>
        <button
          onClick={handleStopClick}
          className={`canvas-controls__segment canvas-controls__segment--stop ${isRunningAllNodes ? 'canvas-controls__segment--stop-active' : ''}`}
          disabled={!isRunningAllNodes}
          title={isRunningAllNodes ? `Stop Auto-Pilot (${allNodesProgress || 'running...'})` : 'Stop Auto-Pilot'}
        >
          <span className="canvas-controls__icon">■</span>
          <span>Stop</span>
        </button>
      </div>

      {/* Main Controls - Right pill */}
      <div className="canvas-controls">
        <button
          onClick={onAddNode}
          className="canvas-controls__btn canvas-controls__btn--primary canvas-controls__btn--icon-only"
          title="Add Feature"
        >
          <span className="canvas-controls__icon">+</span>
        </button>

        <button
          onClick={onAddFolder}
          className="canvas-controls__btn canvas-controls__btn--secondary canvas-controls__btn--icon-only"
          title="Add Folder"
        >
          <span className="canvas-controls__icon">▢</span>
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenBlueprintWizard?.();
          }}
          className="canvas-controls__btn canvas-controls__btn--primary canvas-controls__btn--icon-only"
          title="Project Wizard"
        >
          <span className="canvas-controls__icon">★</span>
        </button>

        <div className="canvas-controls__separator" />

        <button
          onClick={onUndo}
          disabled={!canUndo}
          className={`canvas-controls__btn canvas-controls__btn--icon-only ${!canUndo ? 'canvas-controls__btn--disabled' : ''}`}
          title="Undo (Ctrl+Z)"
        >
          <span className="canvas-controls__icon">↶</span>
        </button>

        <button
          onClick={onRedo}
          disabled={!canRedo}
          className={`canvas-controls__btn canvas-controls__btn--icon-only ${!canRedo ? 'canvas-controls__btn--disabled' : ''}`}
          title="Redo (Ctrl+Y)"
        >
          <span className="canvas-controls__icon">↷</span>
        </button>

        <div className="canvas-controls__separator" />

        <button
          onClick={onOpenSettings}
          className="canvas-controls__btn canvas-controls__btn--icon-only"
          title="Settings (NEW: Slack Integration)"
          style={{ position: 'relative' }}
        >
          <span className="canvas-controls__icon">⚙</span>
          <span style={{
            position: 'absolute',
            top: '-2px',
            right: '-2px',
            background: '#ff4444',
            color: 'white',
            fontSize: '7px',
            fontWeight: 'bold',
            padding: '1px 3px',
            borderRadius: '6px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.3)'
          }}>NEW</span>
        </button>

        <button
          onClick={onRefreshCanvas}
          className="canvas-controls__btn canvas-controls__btn--icon-only"
          title="Refresh Canvas"
        >
          <span className="canvas-controls__icon">↻</span>
        </button>

        <div className="canvas-controls__separator" />

        <button
          onClick={onOpenFeedback}
          className="canvas-controls__btn canvas-controls__btn--icon-only"
          title="Send Feedback / Report Bug"
        >
          <span className="canvas-controls__icon">💬</span>
        </button>
      </div>
    </div>
  );
};

export default CanvasControls;
