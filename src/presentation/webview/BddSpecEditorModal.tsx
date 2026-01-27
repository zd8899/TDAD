/**
 * BddSpecEditorModal - Modal dialog for editing BDD/Gherkin spec
 *
 * Large textarea for editing Gherkin spec with save functionality.
 */

import React, { useState, useEffect } from 'react';
import '../../styles/editor-modal.css';

interface BddSpecEditorModalProps {
    show: boolean;
    nodeTitle: string;
    bddSpecFilePath: string | null;
    initialSpec: string;
    onSave: (spec: string) => void;
    onClose: () => void;
    onOpenFile: (filePath: string) => void;
}

const BddSpecEditorModal: React.FC<BddSpecEditorModalProps> = ({
    show,
    nodeTitle,
    bddSpecFilePath,
    initialSpec,
    onSave,
    onClose,
    onOpenFile
}) => {
    const [spec, setSpec] = useState(initialSpec);

    useEffect(() => {
        setSpec(initialSpec);
    }, [initialSpec, show]);

    if (!show) {
        return null;
    }

    const handleSave = () => {
        onSave(spec);
        onClose();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            onClose();
        } else if (e.key === 's' && e.ctrlKey) {
            e.preventDefault();
            handleSave();
        }
    };

    return (
        <div className="editor-modal__overlay" onClick={onClose}>
            <div
                className="editor-modal editor-modal--large"
                onClick={e => e.stopPropagation()}
                onKeyDown={handleKeyDown}
            >
                <div className="editor-modal__header">
                    <h2 className="editor-modal__title">
                        📝 Plan: {nodeTitle}
                    </h2>
                    <button className="editor-modal__close" onClick={onClose}>
                        ×
                    </button>
                </div>

                {bddSpecFilePath && (
                    <div className="editor-modal__file-path">
                        <span>📄 File: </span>
                        <button
                            className="editor-modal__file-link"
                            onClick={() => onOpenFile(bddSpecFilePath)}
                        >
                            {bddSpecFilePath}
                        </button>
                    </div>
                )}

                <div className="editor-modal__content">
                    <div className="editor-modal__field">
                        <label className="editor-modal__label">Gherkin Specification</label>
                        <textarea
                            className="editor-modal__textarea editor-modal__textarea--code"
                            value={spec}
                            onChange={e => setSpec(e.target.value)}
                            placeholder={`Feature: ${nodeTitle}

  Scenario: ...
    Given ...
    When ...
    Then ...`}
                            autoFocus
                            rows={20}
                        />
                        <span className="editor-modal__hint">
                            Tip: Press Ctrl+S to save, Escape to cancel
                        </span>
                    </div>
                </div>

                <div className="editor-modal__footer">
                    <button
                        className="editor-modal__button editor-modal__button--secondary"
                        onClick={onClose}
                    >
                        Cancel
                    </button>
                    <button
                        className="editor-modal__button editor-modal__button--primary"
                        onClick={handleSave}
                    >
                        💾 Save Spec
                    </button>
                </div>
            </div>
        </div>
    );
};

export default BddSpecEditorModal;
