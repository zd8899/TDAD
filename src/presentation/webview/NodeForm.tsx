import React, { useState } from 'react';
import '../../styles/node-form.css';

type FormMode = 'feature' | 'folder';

interface DependencyNode {
  id: string;
  title: string;
}

interface NodeFormProps {
  node?: { id: string; title: string; description?: string; contextFiles?: string[]; testLayers?: ('ui' | 'api')[] } | null;
  mode?: FormMode;
  onSubmit: (data: { title: string; description: string; autoRun: boolean; mode: FormMode; contextFiles: string[]; dependencyIds: string[]; testLayers?: ('ui' | 'api')[] }) => void;
  onCancel: () => void;
  contextFiles?: string[];
  onAddContextFiles?: (callback: (files: string[]) => void) => void;
  onRemoveContextFile?: (filePath: string) => void;
  // Dependencies
  dependencies?: DependencyNode[];
  onAddDependency?: (callback: (selectedNodes: DependencyNode[]) => void) => void;
  onRemoveDependency?: (nodeId: string) => void;
}

/**
 * Enhanced NodeForm for UX-Optimized MVP
 * Supports two modes:
 * - 'feature': Full BDD/TDD workflow with description and docs (default)
 * - 'folder': Simple folder creation with just a name
 */
const NodeForm: React.FC<NodeFormProps> = ({
  node,
  mode = 'feature',
  onSubmit,
  onCancel,
  contextFiles: initialContextFiles = [],
  onAddContextFiles,
  onRemoveContextFile,
  dependencies: initialDependencies = [],
  onAddDependency,
  onRemoveDependency
}) => {
  const [title, setTitle] = useState(node?.title || '');
  const [description, setDescription] = useState(node?.description || '');
  // Test layers: undefined = use global settings, [] = none, ['ui'] = UI only, ['api'] = API only, ['ui', 'api'] = both
  const [testLayers, setTestLayers] = useState<('ui' | 'api')[] | undefined>(node?.testLayers);

  // Local state for context files and dependencies (for new nodes)
  const [localContextFiles, setLocalContextFiles] = useState<string[]>(initialContextFiles);
  const [localDependencies, setLocalDependencies] = useState<DependencyNode[]>(initialDependencies);

  // Helper to convert testLayers to select value
  const getTestLayerValue = (): string => {
    if (!testLayers || testLayers.length === 0) {return 'global';}
    if (testLayers.includes('ui') && testLayers.includes('api')) {return 'both';}
    if (testLayers.includes('ui')) {return 'ui';}
    if (testLayers.includes('api')) {return 'api';}
    return 'global';
  };

  const handleTestLayerChange = (value: string) => {
    switch (value) {
      case 'ui': setTestLayers(['ui']); break;
      case 'api': setTestLayers(['api']); break;
      case 'both': setTestLayers(['ui', 'api']); break;
      default: setTestLayers(undefined); // global
    }
  };

  const isFolderMode = mode === 'folder';
  const isEditing = !!node;

  // Always use local state for display - provides immediate UI feedback
  const displayContextFiles = localContextFiles;
  const displayDependencies = localDependencies;

  // Helper to get filename from path
  const getFileName = (filePath: string): string => {
    const parts = filePath.split(/[/\\]/);
    return parts[parts.length - 1] || filePath;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      alert(isFolderMode ? 'Please enter a folder name.' : 'Please enter a feature name.');
      return;
    }

    onSubmit({
      title: title.trim(),
      description: description.trim(),
      autoRun: !isFolderMode, // Folders don't auto-run TDD workflow
      mode,
      contextFiles: localContextFiles,
      dependencyIds: localDependencies.map(d => d.id),
      testLayers: isFolderMode ? undefined : testLayers
    });
  };

  // Unified handlers for context files/dependencies - always update local state for display
  // Parent handles backend sync for editing mode
  const handleAddContextFiles = () => {
    if (onAddContextFiles) {
      onAddContextFiles((files: string[]) => {
        // Always update local state for immediate UI feedback
        setLocalContextFiles(prev => [...prev, ...files.filter(f => !prev.includes(f))]);
      });
    }
  };

  const handleRemoveContextFile = (filePath: string) => {
    // Update local state for immediate UI feedback
    setLocalContextFiles(prev => prev.filter(f => f !== filePath));
    // Parent handles backend sync for editing mode
    if (isEditing && onRemoveContextFile) {
      onRemoveContextFile(filePath);
    }
  };

  const handleAddDependency = () => {
    if (onAddDependency) {
      onAddDependency((selectedNodes: DependencyNode[]) => {
        // Always update local state for immediate UI feedback
        setLocalDependencies(prev => {
          const newDeps = selectedNodes.filter(n => !prev.some(p => p.id === n.id));
          return [...prev, ...newDeps];
        });
      });
    }
  };

  const handleRemoveDependency = (nodeId: string) => {
    // Update local state for immediate UI feedback
    setLocalDependencies(prev => prev.filter(d => d.id !== nodeId));
    // Parent handles backend sync for editing mode
    if (isEditing && onRemoveDependency) {
      onRemoveDependency(nodeId);
    }
  };

  // Dynamic labels based on mode
  const headerTitle = isEditing
    ? (isFolderMode ? 'Edit Folder' : 'Edit Feature')
    : (isFolderMode ? '📁 Create New Folder' : '➕ Create New Feature');

  const nameLabel = isFolderMode ? 'Folder Name *:' : 'Feature Name *:';
  const namePlaceholder = isFolderMode
    ? 'e.g., auth, user-management, api, utils'
    : 'e.g., User Login, Shopping Cart, File Upload';

  const submitLabel = isEditing
    ? (isFolderMode ? 'Update Folder' : 'Update Feature')
    : (isFolderMode ? '📁 Create Folder' : 'Create New Feature');

  return (
    <div className="node-form">
      <div className="node-form__content">
        <div className="node-form__header">
          <h3 className="node-form__title">{headerTitle}</h3>
          <button
            onClick={onCancel}
            className="node-form__close-button"
            title="Close"
            type="button"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="node-form__section">
            <label className="node-form__label" htmlFor="feature-title">
              {nameLabel}
            </label>
            <input
              id="feature-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="node-form__input"
              placeholder={namePlaceholder}
              autoFocus
              required
            />
          </div>

          {/* Description section - only for feature mode (folders don't need description) */}
          {!isFolderMode && (
            <div className="node-form__section">
              <label className="node-form__label" htmlFor="feature-description">
                Feature Description:
              </label>
              <textarea
                id="feature-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="node-form__textarea"
                placeholder="Write a clear description of what this feature should accomplish. This will be used to generate the plan and test code.

Example: As a user, I need to be able to log in with username and password. The system should validate credentials against the database and create a session."
                rows={6}
              />
            </div>
          )}

          {/* Context Files Section - only for feature mode */}
          {!isFolderMode && (
            <div className="node-form__section">
              <div className="node-form__docs-header">
                <label className="node-form__label">
                  📄 Context Files:
                </label>
                {onAddContextFiles && (
                  <button
                    type="button"
                    className="node-form__docs-add-btn"
                    onClick={handleAddContextFiles}
                  >
                    + Add Files
                  </button>
                )}
              </div>

              {displayContextFiles.length > 0 ? (
                <div className="node-form__docs-list">
                  {displayContextFiles.map((filePath, index) => (
                    <div key={index} className="node-form__docs-item">
                      <span className="node-form__docs-icon">📄</span>
                      <span className="node-form__docs-name" title={filePath}>
                        {getFileName(filePath)}
                      </span>
                      <button
                        type="button"
                        className="node-form__docs-remove"
                        onClick={() => handleRemoveContextFile(filePath)}
                        title="Remove this file"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="node-form__docs-empty">
                  No context files added yet.
                </p>
              )}
            </div>
          )}

          {/* Dependencies Section - only for feature mode */}
          {!isFolderMode && (
            <div className="node-form__section">
              <div className="node-form__docs-header">
                <label className="node-form__label">
                  🔗 Dependencies:
                </label>
                {onAddDependency && (
                  <button
                    type="button"
                    className="node-form__docs-add-btn"
                    onClick={handleAddDependency}
                  >
                    + Add Dependency
                  </button>
                )}
              </div>

              {displayDependencies.length > 0 ? (
                <div className="node-form__docs-list">
                  {displayDependencies.map((dep) => (
                    <div key={dep.id} className="node-form__docs-item">
                      <span className="node-form__docs-icon">🔗</span>
                      <span className="node-form__docs-name">
                        {dep.title}
                      </span>
                      <button
                        type="button"
                        className="node-form__docs-remove"
                        onClick={() => handleRemoveDependency(dep.id)}
                        title="Remove this dependency"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="node-form__docs-empty">
                  No dependencies added yet.
                </p>
              )}
            </div>
          )}

          {/* Test Layers Section - only for feature mode */}
          {!isFolderMode && (
            <div className="node-form__section">
              <label className="node-form__label" htmlFor="test-layers">
                🧪 Test Layers:
              </label>
              <select
                id="test-layers"
                value={getTestLayerValue()}
                onChange={(e) => handleTestLayerChange(e.target.value)}
                className="node-form__input"
              >
                <option value="global">Use Global Settings</option>
                <option value="ui">UI Only</option>
                <option value="api">API Only</option>
                <option value="both">UI + API</option>
              </select>
              <p className="node-form__hint">
                Override global test settings for this specific feature.
              </p>
            </div>
          )}

          <div className="node-form__footer">
            <button
              type="button"
              onClick={onCancel}
              className="node-form__button node-form__button--secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="node-form__button node-form__button--primary"
            >
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default NodeForm;