import React, { useState, useEffect } from 'react';
import { AutopilotModes } from '../../shared/types';
export type AutopilotMode = 'bdd' | 'test' | 'run-fix';

export type { AutopilotModes };

interface CLISettings {
  enabled: boolean;
  command: string;
  permissionFlags?: {
    claude: { dangerouslySkipPermissions: boolean };
    aider: { yesAlways: boolean; autoCommit: boolean };
    codex: { autoApprove: boolean };
  };
}

interface AutopilotConfirmDialogProps {
  isOpen: boolean;
  pendingCount: number;
  folderName: string;
  isAllFolders?: boolean;
  isSingleNode?: boolean;
  nodeName?: string;
  cliSettings?: CLISettings;
  onConfirm: (modes: AutopilotModes, maxRetries: number, cliSettings?: { preset: string; skipPermissions: boolean }) => void;
  onCancel: () => void;
  onOpenSettings?: () => void;
}

const MODE_OPTIONS: { value: AutopilotMode; label: string; icon: string; description: string }[] = [
  { value: 'bdd', label: 'Plan', icon: '📋', description: 'Generate plans' },
  { value: 'test', label: 'Test', icon: '🧪', description: 'Generate tests' },
  { value: 'run-fix', label: 'Run+Fix', icon: '🔄', description: 'Run and fix' }
];

const CLI_PRESETS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'aider', label: 'Aider' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'custom', label: 'Custom' }
];

export const AutopilotConfirmDialog: React.FC<AutopilotConfirmDialogProps> = ({
  isOpen,
  pendingCount,
  folderName,
  isAllFolders = false,
  isSingleNode = false,
  nodeName,
  cliSettings,
  onConfirm,
  onCancel,
  onOpenSettings
}) => {
  // Default: all modes selected
  const [selectedModes, setSelectedModes] = useState<Set<AutopilotMode>>(new Set(['bdd', 'test', 'run-fix']));
  const [maxRetries, setMaxRetries] = useState<number>(10);

  // CLI selection state
  const [selectedCli, setSelectedCli] = useState<string>('claude');
  const [skipPermissions, setSkipPermissions] = useState<boolean>(false);

  // Initialize from cliSettings
  useEffect(() => {
    if (cliSettings?.command) {
      if (cliSettings.command.includes('claude')) {setSelectedCli('claude');}
      else if (cliSettings.command.includes('aider')) {setSelectedCli('aider');}
      else if (cliSettings.command.includes('codex')) {setSelectedCli('codex');}
      else {setSelectedCli('custom');}

      if (cliSettings.permissionFlags?.claude?.dangerouslySkipPermissions) {
        setSkipPermissions(true);
      }
    }
  }, [cliSettings]);

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
    onConfirm(orderedModes, maxRetries, { preset: selectedCli, skipPermissions });
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
    if (selectedModes.has('bdd')) {parts.push('Plans');}
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

        <div className="autopilot-cli-selector">
          <label className="autopilot-cli-label">
            Agent Driver:
            <select
              value={selectedCli}
              onChange={(e) => setSelectedCli(e.target.value)}
              className="autopilot-cli-select"
            >
              {CLI_PRESETS.map(preset => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
          </label>
          {selectedCli === 'claude' && (
            <label className="autopilot-skip-permissions-label">
              <input
                type="checkbox"
                checked={skipPermissions}
                onChange={(e) => setSkipPermissions(e.target.checked)}
              />
              <span>Skip Permissions (--dangerously-skip-permissions)</span>
            </label>
          )}
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
