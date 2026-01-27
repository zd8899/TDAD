import React, { useState } from 'react';
import { AutopilotModes } from '../../shared/types';
export type AutopilotMode = 'bdd' | 'test' | 'run-fix';

export type { AutopilotModes };

interface AutopilotConfirmDialogProps {
  isOpen: boolean;
  pendingCount: number;
  folderName: string;
  isAllFolders?: boolean;
  isSingleNode?: boolean;
  nodeName?: string;
  onConfirm: (modes: AutopilotModes, maxRetries: number) => void;
  onCancel: () => void;
  onOpenSettings?: () => void;
}

const MODE_OPTIONS: { value: AutopilotMode; label: string; icon: string; description: string }[] = [
  { value: 'bdd', label: 'BDD', icon: '📋', description: 'Generate BDD specs' },
  { value: 'test', label: 'Test', icon: '🧪', description: 'Generate tests' },
  { value: 'run-fix', label: 'Run+Fix', icon: '🔄', description: 'Run and fix' }
];

export const AutopilotConfirmDialog: React.FC<AutopilotConfirmDialogProps> = ({
  isOpen,
  pendingCount,
  folderName,
  isAllFolders = false,
  isSingleNode = false,
  nodeName,
  onConfirm,
  onCancel,
  onOpenSettings
}) => {
  // Default: all modes selected
  const [selectedModes, setSelectedModes] = useState<Set<AutopilotMode>>(new Set(['bdd', 'test', 'run-fix']));
  const [maxRetries, setMaxRetries] = useState<number>(10);

  if (!isOpen) {return null;}

  const toggleMode = (mode: AutopilotMode) => {
    const newModes = new Set(selectedModes);
    if (newModes.has(mode)) {
      newModes.delete(mode);
    } else {
      newModes.add(mode);
    }
    setSelectedModes(newModes);
  };

  const handleConfirm = () => {
    // Convert to array in order: bdd, test, run-fix
    const orderedModes: AutopilotModes = [];
    if (selectedModes.has('bdd')) {orderedModes.push('bdd');}
    if (selectedModes.has('test')) {orderedModes.push('test');}
    if (selectedModes.has('run-fix')) {orderedModes.push('run-fix');}
    onConfirm(orderedModes, maxRetries);
  };

  const getMessage = () => {
    if (isSingleNode && nodeName) {
      return <>Run automation for <strong>{nodeName}</strong>?</>;
    }
    if (isAllFolders) {
      return <>Run automation for <strong>{pendingCount}</strong> feature{pendingCount !== 1 ? 's' : ''} across <strong>all folders</strong>?</>;
    }
    return <>Run automation for <strong>{pendingCount}</strong> feature{pendingCount !== 1 ? 's' : ''} in <strong>{folderName}</strong>?</>;
  };

  const getTitle = () => {
    if (isSingleNode) {return 'Auto-Pilot';}
    if (isAllFolders) {return 'Auto-Pilot All Folders';}
    return 'Auto-Pilot All';
  };

  const getSelectedDescription = () => {
    const parts: string[] = [];
    if (selectedModes.has('bdd')) {parts.push('BDD specs');}
    if (selectedModes.has('test')) {parts.push('Test generation');}
    if (selectedModes.has('run-fix')) {parts.push('Run & Fix');}
    if (parts.length === 0) {return 'Select at least one mode';}
    return parts.join(' → ');
  };

  const canConfirm = selectedModes.size > 0;

  return (
    <div className="autopilot-confirm-overlay" onClick={onCancel}>
      <div className="autopilot-confirm-dialog autopilot-confirm-dialog--with-modes" onClick={e => e.stopPropagation()}>
        <div className="autopilot-confirm-icon">
          <span>✈</span>
        </div>
        <div className="autopilot-confirm-title">
          {getTitle()}
        </div>
        <div className="autopilot-confirm-message">
          {getMessage()}
        </div>

        <div className="autopilot-mode-selector">
          <div className="autopilot-mode-label">Select phases to run:</div>
          <div className="autopilot-mode-options">
            {MODE_OPTIONS.map(option => (
              <button
                key={option.value}
                className={`autopilot-mode-option ${selectedModes.has(option.value) ? 'autopilot-mode-option--selected' : ''}`}
                onClick={() => toggleMode(option.value)}
                title={option.description}
              >
                <span className="autopilot-mode-option__icon">{option.icon}</span>
                <span className="autopilot-mode-option__label">{option.label}</span>
              </button>
            ))}
          </div>
          <div className="autopilot-mode-description">
            {getSelectedDescription()}
          </div>
        </div>

        <div className="autopilot-retries-selector">
          <label className="autopilot-retries-label">
            Max Retries:
            <input
              type="number"
              min="0"
              value={maxRetries}
              onChange={(e) => setMaxRetries(Math.max(0, parseInt(e.target.value) || 0))}
              className="autopilot-retries-input"
            />
          </label>
        </div>

        <div className="autopilot-confirm-buttons">
          <button className="autopilot-confirm-btn autopilot-confirm-btn--cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="autopilot-confirm-btn autopilot-confirm-btn--confirm"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            Start Auto-Pilot
          </button>
        </div>

        {onOpenSettings && (
          <div style={{ marginTop: '16px', textAlign: 'center' }}>
            <button
              onClick={() => {
                onCancel();
                onOpenSettings();
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#7c3aed',
                textDecoration: 'underline',
                cursor: 'pointer',
                fontSize: '12px',
                padding: 0
              }}
            >
              Open Auto-Pilot Settings
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
