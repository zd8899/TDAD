import React, { useState, useEffect } from 'react';

interface TestSettings {
    types: string[];
    coverage: boolean;
    workers: number;
}

interface ProjectContext {
    techStack: string;
    techStackCustom?: string;
    projectType: string;
    projectTypeCustom?: string;
    database: string;
    databaseCustom?: string;
    sourceRoot: string;
    docsRoot: string;
}

interface CLIPermissionFlags {
    claude: {
        dangerouslySkipPermissions: boolean;
    };
    aider: {
        yesAlways: boolean;
        autoCommit: boolean;
    };
    codex: {
        autoApprove: boolean;
    };
    cursor: {
        autoApprove: boolean;
    };
    gemini: {
        autoConfirm: boolean;
    };
    opencode: {
        autoApprove: boolean;
    };
}

interface CLISettings {
    enabled: boolean;
    command: string;
    preset?: string;
    permissionFlags?: CLIPermissionFlags;
}

interface SettingsModalProps {
    show: boolean;
    settingsData: {
        projectContext?: ProjectContext;
        testSettings?: TestSettings;
        cliSettings?: CLISettings;
        urls?: Record<string, string>;
        autopilotSettings?: { betaCode?: string };
    };
    onClose: () => void;
    onUpdateSettings: (data: any) => void;
    postMessage: (message: any) => void;
    initialTab?: SettingsTab;
}

type SettingsTab = 'project' | 'testing' | 'autopilot' | 'prompts' | 'slack';

const CLI_PRESETS = [
    { id: 'claude', label: 'Claude Code', baseCommand: 'claude', command: 'claude "{prompt}"' },
    { id: 'aider', label: 'Aider', baseCommand: 'aider', command: 'aider --message "{prompt}"' },
    { id: 'codex', label: 'Codex CLI (OpenAI)', baseCommand: 'codex', command: 'codex "{prompt}"' },
    { id: 'cursor', label: 'Cursor', baseCommand: 'cursor', command: 'cursor --ask "{prompt}"' },
    { id: 'gemini', label: 'Gemini CLI (Google)', baseCommand: 'gemini', command: 'gemini "{prompt}"' },
    { id: 'opencode', label: 'OpenCode', baseCommand: 'opencode', command: 'opencode "{prompt}"' },
    { id: 'custom', label: 'Custom', baseCommand: '', command: '' }
];

const DEFAULT_PERMISSION_FLAGS: CLIPermissionFlags = {
    claude: { dangerouslySkipPermissions: false },
    aider: { yesAlways: false, autoCommit: false },
    codex: { autoApprove: false },
    cursor: { autoApprove: false },
    gemini: { autoConfirm: false },
    opencode: { autoApprove: false }
};

const PROJECT_TYPES = [
    { value: 'web-app', label: 'Web Application' },
    { value: 'api-service', label: 'API Service' },
    { value: 'cli-tool', label: 'CLI Tool' },
    { value: 'library', label: 'Library / Package' },
    { value: 'mobile-app', label: 'Mobile App' },
    { value: 'desktop-app', label: 'Desktop App' },
    { value: 'game', label: 'Game' },
    { value: 'data-pipeline', label: 'Data Pipeline' },
    { value: 'custom', label: 'Other (Specify)...' }
];

const TECH_STACKS = [
    { value: 'typescript-node', label: 'TypeScript (Node.js)' },
    { value: 'python', label: 'Python' },
    { value: 'go', label: 'Go' },
    { value: 'rust', label: 'Rust' },
    { value: 'java', label: 'Java' },
    { value: 'csharp', label: 'C# (.NET)' },
    { value: 'php', label: 'PHP' },
    { value: 'ruby', label: 'Ruby' },
    { value: 'swift', label: 'Swift' },
    { value: 'javascript', label: 'JavaScript' },
    { value: 'custom', label: 'Other (Specify)...' }
];

const DATABASES = [
    { value: 'postgresql', label: 'PostgreSQL' },
    { value: 'mysql', label: 'MySQL' },
    { value: 'sqlite', label: 'SQLite' },
    { value: 'mongodb', label: 'MongoDB' },
    { value: 'redis', label: 'Redis' },
    { value: 'none', label: 'None / In-Memory' },
    { value: 'custom', label: 'Other (Specify)...' }
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
    show,
    settingsData,
    onClose,
    postMessage,
    initialTab
}) => {
    const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab || 'project');

    // Project Context State
    const [projectContext, setProjectContext] = useState<ProjectContext>({
        techStack: 'typescript-node',
        projectType: 'web-app',
        database: 'postgresql',
        sourceRoot: 'src/',
        docsRoot: 'docs/'
    });

    // Test settings state
    const [testTypes, setTestTypes] = useState<string[]>(['ui', 'api']);
    const [testCoverage, setTestCoverage] = useState(true);
    const [testWorkers, setTestWorkers] = useState(1);
    
    // CLI settings state
    const [cliEnabled, setCLIEnabled] = useState(true);
    const [cliCommand, setCLICommand] = useState('claude "{prompt}"');
    const [selectedPreset, setSelectedPreset] = useState('claude');
    const [permissionFlags, setPermissionFlags] = useState<CLIPermissionFlags>(DEFAULT_PERMISSION_FLAGS);

    // URL settings state
    const [urls, setUrls] = useState<Record<string, string>>({});
    const [newUrlName, setNewUrlName] = useState('');
    const [newUrlValue, setNewUrlValue] = useState('');
    
    // Saving state for UI feedback
    const [isSaving, setIsSaving] = useState(false);

    // Slack setup state
    const [slackAppName, setSlackAppName] = useState('Personal');
    const [manifestCopied, setManifestCopied] = useState(false);
    const [slackOpened, setSlackOpened] = useState(false);
    const [saving, setSaving] = useState(false);

    // Update active tab when initialTab prop changes
    useEffect(() => {
        if (initialTab) {
            setActiveTab(initialTab);
        }
    }, [initialTab]);

    // Load settings from props
    useEffect(() => {
        if (settingsData?.projectContext) {
            setProjectContext({
                ...projectContext,
                ...settingsData.projectContext
            });
        }
        if (settingsData?.testSettings) {
            const ts = settingsData.testSettings;
            setTestTypes(ts.types || ['ui', 'api']);
            setTestCoverage(ts.coverage !== false);
            setTestWorkers(ts.workers ?? 1);
        }
        if (settingsData?.cliSettings) {
            const cs = settingsData.cliSettings;
            setCLIEnabled(cs.enabled !== false);
            setCLICommand(cs.command || CLI_PRESETS[0].command);
            // Use saved preset if available, otherwise try to detect
            if (cs.preset) {
                setSelectedPreset(cs.preset);
            } else {
                const matchingPreset = CLI_PRESETS.find(p => p.command === cs.command);
                setSelectedPreset(matchingPreset?.id || 'custom');
            }
            // Load permission flags
            if (cs.permissionFlags) {
                setPermissionFlags({
                    ...DEFAULT_PERMISSION_FLAGS,
                    ...cs.permissionFlags
                });
            }
        }
        if (settingsData?.urls) {
            setUrls(settingsData.urls);
        }
    }, [settingsData]);

    if (!show) { return null; }

    const handleSave = (action: () => void) => {
        setIsSaving(true);
        action();
        // Reset after 800ms to give visual feedback
        setTimeout(() => setIsSaving(false), 800);
    };

    const handleSaveProjectContext = () => {
        handleSave(() => {
            postMessage({
                command: 'updateProjectContext',
                projectContext
            });
        });
    };

    const handleSaveTestSettings = () => {
        handleSave(() => {
            postMessage({
                command: 'updateTestSettings',
                testSettings: {
                    types: testTypes,
                    coverage: testCoverage,
                    workers: testWorkers
                },
                urls // Include URLs in the save
            });
        });
    };

    const handleSaveCLISettings = () => {
        handleSave(() => {
            postMessage({
                command: 'updateCLISettings',
                cliSettings: {
                    enabled: cliEnabled,
                    command: cliCommand,
                    preset: selectedPreset,
                    permissionFlags
                }
            });
        });
    };

    const handleOpenPromptTemplate = (templateName: string) => {
        postMessage({
            command: 'openPromptTemplate',
            templateName
        });
    };

    // Helper Functions
    const toggleTestType = (typeId: string) => {
        setTestTypes(prev =>
            prev.includes(typeId)
                ? prev.filter(t => t !== typeId)
                : [...prev, typeId]
        );
    };

    const handleAddUrl = () => {
        if (!newUrlName.trim() || !newUrlValue.trim()) { return; }
        // Normalize to unified naming: frontend→ui, backend→api
        let name = newUrlName.trim().toLowerCase();
        if (name === 'frontend' || name === 'fe') {name = 'ui';}
        if (name === 'backend' || name === 'be') {name = 'api';}
        setUrls(prev => ({ ...prev, [name]: newUrlValue.trim() }));
        setNewUrlName('');
        setNewUrlValue('');
    };

    const handleRemoveUrl = (name: string) => {
        setUrls(prev => {
            const updated = { ...prev };
            delete updated[name];
            return updated;
        });
    };

    const handleUpdateUrl = (name: string, value: string) => {
        setUrls(prev => ({ ...prev, [name]: value }));
    };

    const handlePresetChange = (presetId: string) => {
        setSelectedPreset(presetId);
        const preset = CLI_PRESETS.find(p => p.id === presetId);
        if (preset && preset.command) {
            setCLICommand(preset.command);
        }
    };

    const updatePermissionFlag = (cli: keyof CLIPermissionFlags, flag: string, value: boolean) => {
        const newFlags = { ...permissionFlags };
        (newFlags[cli] as any)[flag] = value;
        setPermissionFlags(newFlags);

        // Update command with new flags if preset is active
        if (selectedPreset !== 'custom') {
            const preset = CLI_PRESETS.find(p => p.id === selectedPreset);
            let flags = '';
            if (selectedPreset === 'claude' && newFlags.claude.dangerouslySkipPermissions) {flags = '--dangerously-skip-permissions ';}
            if (selectedPreset === 'aider') {
                if (newFlags.aider.yesAlways) {flags += '--yes ';}
                if (newFlags.aider.autoCommit) {flags += '--auto-commits ';}
            }
            if (selectedPreset === 'codex' && newFlags.codex.autoApprove) {flags = '--auto-approve ';}
            if (selectedPreset === 'cursor' && newFlags.cursor.autoApprove) {flags = '--auto-approve ';}
            if (selectedPreset === 'gemini' && newFlags.gemini.autoConfirm) {flags = '--yes ';}
            if (selectedPreset === 'opencode' && newFlags.opencode.autoApprove) {flags = '--auto-approve ';}

            if (preset && preset.baseCommand) {
                const newCommand = preset.command.replace(preset.baseCommand, preset.baseCommand + ' ' + flags).replace(/\s+/g, ' ').trim();
                setCLICommand(newCommand);
            }
        }
    };

    // Styles
    const sectionStyle: React.CSSProperties = {
        marginBottom: '12px',
        padding: '12px',
        backgroundColor: 'rgba(255, 255, 255, 0.5)',
        borderRadius: '6px',
        border: '1px solid rgba(0, 0, 0, 0.08)',
        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.02)'
    };

    const labelStyle: React.CSSProperties = {
        display: 'block',
        marginBottom: '6px',
        fontSize: '12px',
        fontWeight: 600,
        color: 'var(--vscode-foreground)'
    };

    const selectStyle: React.CSSProperties = {
        width: '100%',
        padding: '6px 10px',
        borderRadius: '4px',
        border: '1px solid var(--vscode-input-border)',
        backgroundColor: 'var(--vscode-input-background)',
        color: 'var(--vscode-input-foreground)',
        fontSize: '12px',
        transition: 'border-color 0.2s'
    };

    const checkboxContainerStyle: React.CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 10px',
        backgroundColor: 'rgba(0, 0, 0, 0.03)',
        borderRadius: '4px',
        cursor: 'pointer',
        marginBottom: '4px',
        border: '1px solid transparent',
        transition: 'all 0.2s'
    };


    // Render Content
    const renderTabContent = () => {
        switch (activeTab) {
            case 'project':
                return (
                    <div>
                        <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(37, 99, 235, 0.08)', borderRadius: '8px', border: '1px solid rgba(37, 99, 235, 0.2)' }}>
                            <h4 style={{ margin: '0 0 4px 0', color: '#2563eb', fontSize: '14px', fontWeight: 600 }}>Project Profile</h4>
                            <p style={{ margin: '0', fontSize: '12px', color: 'var(--vscode-descriptionForeground)', lineHeight: 1.4 }}>
                                This context is used by the AI to generate code that matches your stack and architecture.
                            </p>
                        </div>

                        <div style={sectionStyle}>
                            <label style={{ ...labelStyle, marginBottom: '10px' }}>Core Configuration</label>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                                <div>
                                    <label style={{ ...labelStyle, fontSize: '11px', marginBottom: '4px' }}>Tech Stack</label>
                                    <select
                                        value={projectContext.techStack}
                                        onChange={(e) => setProjectContext({ ...projectContext, techStack: e.target.value })}
                                        style={selectStyle}
                                    >
                                        {TECH_STACKS.map(ts => <option key={ts.value} value={ts.value}>{ts.label}</option>)}
                                    </select>
                                    {projectContext.techStack === 'custom' && (
                                        <input
                                            type="text"
                                            value={projectContext.techStackCustom || ''}
                                            onChange={(e) => setProjectContext({ ...projectContext, techStackCustom: e.target.value })}
                                            style={{ ...selectStyle, marginTop: '6px' }}
                                            placeholder="Specify Tech Stack..."
                                        />
                                    )}
                                </div>

                                <div>
                                    <label style={{ ...labelStyle, fontSize: '11px', marginBottom: '4px' }}>Project Type</label>
                                    <select
                                        value={projectContext.projectType}
                                        onChange={(e) => setProjectContext({ ...projectContext, projectType: e.target.value })}
                                        style={selectStyle}
                                    >
                                        {PROJECT_TYPES.map(pt => <option key={pt.value} value={pt.value}>{pt.label}</option>)}
                                    </select>
                                    {projectContext.projectType === 'custom' && (
                                        <input
                                            type="text"
                                            value={projectContext.projectTypeCustom || ''}
                                            onChange={(e) => setProjectContext({ ...projectContext, projectTypeCustom: e.target.value })}
                                            style={{ ...selectStyle, marginTop: '6px' }}
                                            placeholder="Specify Project Type..."
                                        />
                                    )}
                                </div>

                                <div>
                                    <label style={{ ...labelStyle, fontSize: '11px', marginBottom: '4px' }}>Database</label>
                                    <select
                                        value={projectContext.database}
                                        onChange={(e) => setProjectContext({ ...projectContext, database: e.target.value })}
                                        style={selectStyle}
                                    >
                                        {DATABASES.map(db => <option key={db.value} value={db.value}>{db.label}</option>)}
                                    </select>
                                    {projectContext.database === 'custom' && (
                                        <input
                                            type="text"
                                            value={projectContext.databaseCustom || ''}
                                            onChange={(e) => setProjectContext({ ...projectContext, databaseCustom: e.target.value })}
                                            style={{ ...selectStyle, marginTop: '6px' }}
                                            placeholder="Specify Database..."
                                        />
                                    )}
                                </div>
                            </div>
                        </div>

                        <div style={sectionStyle}>
                            <label style={labelStyle}>Key Directories</label>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                                <div>
                                    <label style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)', marginBottom: '4px', display: 'block' }}>Source Root</label>
                                    <input
                                        type="text"
                                        value={projectContext.sourceRoot}
                                        onChange={(e) => setProjectContext({ ...projectContext, sourceRoot: e.target.value })}
                                        style={selectStyle}
                                        placeholder="src/"
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)', marginBottom: '4px', display: 'block' }}>Docs Root</label>
                                    <input
                                        type="text"
                                        value={projectContext.docsRoot}
                                        onChange={(e) => setProjectContext({ ...projectContext, docsRoot: e.target.value })}
                                        style={selectStyle}
                                        placeholder="docs/"
                                    />
                                </div>
                            </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                            <button
                                onClick={handleSaveProjectContext}
                                className="canvas-app__button canvas-app__button--primary"
                                style={{ padding: '8px 16px', minWidth: '140px', fontSize: '13px' }}
                                disabled={isSaving}
                            >
                                {isSaving ? 'Saving...' : 'Save Project Profile'}
                            </button>
                        </div>
                    </div>
                );

            case 'testing':
                return (
                    <div>
                        <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(34, 197, 94, 0.08)', borderRadius: '8px', border: '1px solid rgba(34, 197, 94, 0.2)' }}>
                            <h4 style={{ margin: '0 0 4px 0', color: '#16a34a', fontSize: '14px', fontWeight: 600 }}>Testing Strategy</h4>
                            <p style={{ margin: '0', fontSize: '12px', color: 'var(--vscode-descriptionForeground)', lineHeight: 1.4 }}>
                                Configure how Playwright tests are generated. Select which layers to test.
                            </p>
                        </div>

                        <div style={sectionStyle}>
                            <label style={labelStyle}>Enabled Test Layers</label>
                            <label style={checkboxContainerStyle}>
                                <input
                                    type="checkbox"
                                    checked={testTypes.includes('ui')}
                                    onChange={() => toggleTestType('ui')}
                                    style={{ accentColor: 'var(--vscode-focusBorder)' }}
                                />
                                <div>
                                    <span style={{ fontWeight: 500 }}>UI / E2E Tests</span>
                                    <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>Browser-based testing with Playwright</div>
                                </div>
                            </label>
                            <label style={checkboxContainerStyle}>
                                <input
                                    type="checkbox"
                                    checked={testTypes.includes('api')}
                                    onChange={() => toggleTestType('api')}
                                    style={{ accentColor: 'var(--vscode-focusBorder)' }}
                                />
                                <div>
                                    <span style={{ fontWeight: 500 }}>API / Integration Tests</span>
                                    <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>HTTP-based testing with Playwright</div>
                                </div>
                            </label>
                        </div>

                        <div style={sectionStyle}>
                            <label style={labelStyle}>Environment URLs</label>
                            {Object.entries(urls).map(([name, url]) => (
                                <div key={name} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
                                    <span style={{ minWidth: '80px', fontSize: '12px', fontWeight: 500, padding: '4px 8px', background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', borderRadius: '4px' }}>{name}</span>
                                    <input type="text" value={url} onChange={(e) => handleUpdateUrl(name, e.target.value)} style={{ ...selectStyle, flex: 1 }} />
                                    <button onClick={() => handleRemoveUrl(name)} style={{ border: 'none', background: 'transparent', color: 'var(--vscode-errorForeground)', cursor: 'pointer' }}>✕</button>
                                </div>
                            ))}
                            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                                <input type="text" value={newUrlName} onChange={(e) => setNewUrlName(e.target.value)} placeholder="Name (e.g. ui, api)" style={{ ...selectStyle, width: '120px' }} />
                                <input type="text" value={newUrlValue} onChange={(e) => setNewUrlValue(e.target.value)} placeholder="http://localhost:3000" style={{ ...selectStyle, flex: 1 }} onKeyDown={e => e.key === 'Enter' && handleAddUrl()} />
                                <button onClick={handleAddUrl} disabled={!newUrlName.trim() || !newUrlValue.trim()} style={{ padding: '6px 12px', background: 'var(--vscode-button-background)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>+ Add</button>
                            </div>
                        </div>

                        <div style={sectionStyle}>
                            <label style={labelStyle}>Parallel Execution</label>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <label style={{ fontSize: '13px', color: 'var(--vscode-foreground)' }}>Workers:</label>
                                <input
                                    type="number"
                                    min={1}
                                    max={16}
                                    value={testWorkers}
                                    onChange={(e) => setTestWorkers(Math.max(1, Math.min(16, parseInt(e.target.value) || 1)))}
                                    style={{ ...selectStyle, width: '80px', textAlign: 'center' }}
                                />
                                <span style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)' }}>
                                    {testWorkers === 1 ? '(Sequential - prevents race conditions)' : `(${testWorkers} parallel workers)`}
                                </span>
                            </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                            <button
                                onClick={handleSaveTestSettings}
                                className="canvas-app__button canvas-app__button--primary"
                                style={{ padding: '8px 16px', minWidth: '140px', fontSize: '13px' }}
                                disabled={isSaving}
                            >
                                {isSaving ? 'Saving...' : 'Save Strategy'}
                            </button>
                        </div>
                    </div>
                );

            case 'autopilot':
                return (
                    <div>
                        <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(245, 158, 11, 0.08)', borderRadius: '8px', border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                            <h4 style={{ margin: '0 0 4px 0', color: '#d97706', fontSize: '14px', fontWeight: 600 }}>Autopilot (Automation Mode)</h4>
                            <p style={{ margin: '0', fontSize: '12px', color: 'var(--vscode-descriptionForeground)', lineHeight: 1.4 }}>
                                Configure the "Hands-Free" agent driver. This enables the Agent Mode button.
                            </p>
                        </div>

                        <div style={sectionStyle}>
                            <label style={labelStyle}>Agent Driver</label>
                            {CLI_PRESETS.map(preset => (
                                <label key={preset.id} style={{ ...checkboxContainerStyle, border: selectedPreset === preset.id ? '1px solid var(--vscode-focusBorder)' : '1px solid transparent' }}>
                                    <input
                                        type="radio"
                                        name="cliPreset"
                                        value={preset.id}
                                        checked={selectedPreset === preset.id}
                                        onChange={() => handlePresetChange(preset.id)}
                                        style={{ accentColor: 'var(--vscode-focusBorder)' }}
                                    />
                                    <div>
                                        <span style={{ fontWeight: 500 }}>{preset.label}</span>
                                        {preset.id !== 'custom' && <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)' }}>{preset.command.substring(0, 50)}...</div>}
                                    </div>
                                </label>
                            ))}
                        </div>

                        {selectedPreset !== 'custom' && (
                            <div style={sectionStyle}>
                                <label style={labelStyle}>Safety Flags</label>
                                {selectedPreset === 'claude' && (
                                    <label style={checkboxContainerStyle}>
                                        <input
                                            type="checkbox"
                                            checked={permissionFlags.claude.dangerouslySkipPermissions}
                                            onChange={(e) => updatePermissionFlag('claude', 'dangerouslySkipPermissions', e.target.checked)}
                                        />
                                        <span>Skip Permissions (--dangerously-skip-permissions)</span>
                                    </label>
                                )}
                                {selectedPreset === 'aider' && (
                                    <>
                                        <label style={checkboxContainerStyle}>
                                            <input type="checkbox" checked={permissionFlags.aider.yesAlways} onChange={(e) => updatePermissionFlag('aider', 'yesAlways', e.target.checked)} />
                                            <span>Auto Confirm (--yes)</span>
                                        </label>
                                        <label style={checkboxContainerStyle}>
                                            <input type="checkbox" checked={permissionFlags.aider.autoCommit} onChange={(e) => updatePermissionFlag('aider', 'autoCommit', e.target.checked)} />
                                            <span>Auto Commit (--auto-commits)</span>
                                        </label>
                                    </>
                                )}
                                {selectedPreset === 'codex' && (
                                    <label style={checkboxContainerStyle}>
                                        <input type="checkbox" checked={permissionFlags.codex.autoApprove} onChange={(e) => updatePermissionFlag('codex', 'autoApprove', e.target.checked)} />
                                        <span>Auto Approve (--auto-approve)</span>
                                    </label>
                                )}
                                {selectedPreset === 'cursor' && (
                                    <label style={checkboxContainerStyle}>
                                        <input type="checkbox" checked={permissionFlags.cursor.autoApprove} onChange={(e) => updatePermissionFlag('cursor', 'autoApprove', e.target.checked)} />
                                        <span>Auto Approve (--auto-approve)</span>
                                    </label>
                                )}
                                {selectedPreset === 'gemini' && (
                                    <label style={checkboxContainerStyle}>
                                        <input type="checkbox" checked={permissionFlags.gemini.autoConfirm} onChange={(e) => updatePermissionFlag('gemini', 'autoConfirm', e.target.checked)} />
                                        <span>Auto Confirm (--yes)</span>
                                    </label>
                                )}
                                {selectedPreset === 'opencode' && (
                                    <label style={checkboxContainerStyle}>
                                        <input type="checkbox" checked={permissionFlags.opencode.autoApprove} onChange={(e) => updatePermissionFlag('opencode', 'autoApprove', e.target.checked)} />
                                        <span>Auto Approve (--auto-approve)</span>
                                    </label>
                                )}
                            </div>
                        )}

                        <div style={sectionStyle}>
                            <label style={labelStyle}>CLI Command</label>
                            <textarea
                                value={cliCommand}
                                onChange={(e) => { setCLICommand(e.target.value); setSelectedPreset('custom'); }}
                                style={{ ...selectStyle, fontFamily: 'monospace', height: '60px' }}
                            />
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                            <button
                                onClick={handleSaveCLISettings}
                                className="canvas-app__button canvas-app__button--primary"
                                style={{ padding: '8px 16px', minWidth: '160px', fontSize: '13px' }}
                                disabled={isSaving}
                            >
                                {isSaving ? 'Saving...' : 'Save Autopilot Settings'}
                            </button>
                        </div>
                    </div>
                );

            case 'prompts':
                return (
                    <div>
                        <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(255, 255, 255, 0.5)', borderRadius: '8px', border: '1px solid rgba(0, 0, 0, 0.08)' }}>
                            <h4 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 600 }}>Prompt Templates</h4>
                            <p style={{ margin: '0', fontSize: '12px', color: 'var(--vscode-descriptionForeground)', lineHeight: 1.4 }}>
                                Edit the Handlebars (.md) templates used for generation.
                            </p>
                        </div>

                        {[
                            'generate-bdd',
                            'generate-tests',
                            'generate-blueprint',
                            'generate-project-docs',
                            'generate-project-scaffold',
                            'golden-packet',
                            'agent-system-prompt'
                        ].map(template => (
                            <div key={template} style={{ ...sectionStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                    <strong style={{ fontSize: '13px', fontWeight: 600 }}>{template}.md</strong>
                                    <div style={{ fontSize: '11px', color: '#3b82f6', marginTop: '2px', fontFamily: 'monospace' }}>.tdad/prompts/{template}.md</div>
                                </div>
                                <button
                                    onClick={() => handleOpenPromptTemplate(template)}
                                    className="canvas-app__button canvas-app__button--secondary"
                                    style={{
                                        padding: '6px 12px',
                                        fontSize: '12px',
                                        borderRadius: '4px',
                                        border: '1px solid rgba(0,0,0,0.1)',
                                        background: 'white',
                                        color: 'var(--vscode-foreground)',
                                        cursor: 'pointer'
                                    }}
                                >
                                    Edit Template
                                </button>
                            </div>
                        ))}
                    </div>
                );

            case 'slack':
                const SLACK_MANIFEST = JSON.stringify({
                    "display_information": {
                        "name": `TDAD - ${slackAppName}`,
                        "description": "My personal TDAD workflow automation",
                        "background_color": "#2c2d30"
                    },
                    "features": {
                        "app_home": { "home_tab_enabled": true, "messages_tab_enabled": false },
                        "bot_user": { "display_name": "TDAD", "always_online": true },
                        "slash_commands": [{ "command": "/tdad", "description": "TDAD controls and help", "usage_hint": "[command]", "should_escape": false }]
                    },
                    "oauth_config": { "scopes": { "bot": ["app_mentions:read", "channels:history", "channels:join", "channels:read", "chat:write", "commands", "files:write", "users:read"] } },
                    "settings": {
                        "event_subscriptions": { "bot_events": ["app_home_opened", "app_mention", "message.channels"] },
                        "interactivity": { "is_enabled": true },
                        "org_deploy_enabled": false,
                        "socket_mode_enabled": true,
                        "token_rotation_enabled": false
                    }
                }, null, 2);

                const stepStyle = {
                    padding: '20px',
                    marginBottom: '16px',
                    border: '1px solid rgba(0,0,0,0.1)',
                    borderRadius: '8px',
                    background: 'rgba(0,0,0,0.02)'
                };

                const StepHeader = ({ number, title }: { number: number, title: string }) => (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                        <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#611f69', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: '15px', flexShrink: 0 }}>{number}</div>
                        <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>{title}</h4>
                    </div>
                );

                return (
                    <div>
                        <div style={{ marginBottom: '20px', padding: '12px', background: 'rgba(97, 31, 105, 0.1)', borderRadius: '8px', border: '1px solid rgba(97, 31, 105, 0.2)' }}>
                            <h4 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 600 }}>Slack Remote Control</h4>
                            <p style={{ margin: 0, fontSize: '12px', color: 'var(--vscode-descriptionForeground)', lineHeight: 1.4 }}>
                                Build software from your phone. Start AI coding sessions, monitor progress, and ship features from anywhere.
                            </p>
                            <p style={{ margin: '8px 0 0 0', fontSize: '11px', color: '#d97706', fontWeight: 500 }}>
                                Note: VS Code must be open for Slack commands to work.
                            </p>
                        </div>

                        {/* Step 1: Copy Manifest */}
                        <div style={stepStyle}>
                            <StepHeader number={1} title="Copy App Manifest" />
                            <div style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginBottom: '14px', paddingLeft: '44px', lineHeight: '1.6' }}>
                                This manifest auto-configures all Slack app settings (permissions, commands, etc.) so you don't have to set them manually.
                            </div>
                            <div style={{ paddingLeft: '44px' }}>
                                <button
                                    onClick={() => {
                                        postMessage({ command: 'copyToClipboard', text: SLACK_MANIFEST });
                                        setManifestCopied(true);
                                        setTimeout(() => setManifestCopied(false), 2000);
                                    }}
                                    style={{
                                        padding: '10px 20px',
                                        background: manifestCopied ? '#28a745' : '#611f69',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontSize: '13px',
                                        fontWeight: 600,
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    {manifestCopied ? '✓ Copied!' : '📋 Copy Manifest'}
                                </button>
                            </div>
                        </div>

                        {/* Step 2: Open Slack */}
                        <div style={stepStyle}>
                            <StepHeader number={2} title="Create Slack App" />
                            <div style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginBottom: '14px', paddingLeft: '44px', lineHeight: '1.6' }}>
                                • Click "From an app manifest"<br/>
                                • Select your Slack workspace<br/>
                                • Click "Next"<br/>
                                • Paste the manifest (Ctrl+V)<br/>
                                • Click "Next" → "Create"
                            </div>
                            <div style={{ paddingLeft: '44px' }}>
                                <button
                                    onClick={() => {
                                        postMessage({ command: 'openUrl', url: 'https://api.slack.com/apps/new' });
                                        setSlackOpened(true);
                                        setTimeout(() => setSlackOpened(false), 2000);
                                    }}
                                    style={{
                                        padding: '10px 20px',
                                        background: slackOpened ? '#28a745' : '#007a5a',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontSize: '13px',
                                        fontWeight: 600,
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    {slackOpened ? '✓ Opening...' : '🔗 Open Slack'}
                                </button>
                            </div>
                        </div>

                        {/* Step 3: App-Level Token */}
                        <div style={stepStyle}>
                            <StepHeader number={3} title="Get App-Level Token" />
                            <div style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginBottom: '14px', paddingLeft: '44px', lineHeight: '1.6' }}>
                                After creating the app, you'll land on "Basic Information":<br/>
                                • Scroll to "App-Level Tokens" section<br/>
                                • Click "Generate Token and Scopes"<br/>
                                • Name: "TDAD Socket"<br/>
                                • Add scope: <strong>connections:write</strong><br/>
                                • Click "Generate" and copy token
                            </div>
                            <div style={{ paddingLeft: '44px' }}>
                                <input
                                    type="password"
                                    placeholder="xapp-..."
                                    style={{
                                        width: '100%',
                                        maxWidth: '500px',
                                        padding: '10px 12px',
                                        fontSize: '13px',
                                        fontFamily: 'Consolas, Monaco, monospace',
                                        border: '1px solid var(--vscode-input-border)',
                                        borderRadius: '6px',
                                        background: 'var(--vscode-input-background)',
                                        color: 'var(--vscode-input-foreground)'
                                    }}
                                    onChange={(e) => {
                                        (window as any).slackAppToken = e.target.value;
                                    }}
                                />
                            </div>
                        </div>

                        {/* Step 4: Bot Token */}
                        <div style={stepStyle}>
                            <StepHeader number={4} title="Get Bot Token" />
                            <div style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginBottom: '14px', paddingLeft: '44px', lineHeight: '1.6' }}>
                                • Click "Install App" in left sidebar<br/>
                                • Click green "Install to [YourWorkspace]" button<br/>
                                • Click "Allow"<br/>
                                • Bot token appears automatically<br/>
                                • Click "Copy" button
                            </div>
                            <div style={{ paddingLeft: '44px' }}>
                                <input
                                    type="password"
                                    placeholder="xoxb-..."
                                    style={{
                                        width: '100%',
                                        maxWidth: '500px',
                                        padding: '10px 12px',
                                        fontSize: '13px',
                                        fontFamily: 'Consolas, Monaco, monospace',
                                        border: '1px solid var(--vscode-input-border)',
                                        borderRadius: '6px',
                                        background: 'var(--vscode-input-background)',
                                        color: 'var(--vscode-input-foreground)'
                                    }}
                                    onChange={(e) => {
                                        (window as any).slackBotToken = e.target.value;
                                    }}
                                />
                            </div>
                        </div>

                        {/* Step 5: Save */}
                        <div style={stepStyle}>
                            <StepHeader number={5} title="Save & Activate" />
                            <div style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginBottom: '14px', paddingLeft: '44px', lineHeight: '1.6' }}>
                                Tokens are stored securely in VS Code's encrypted storage. VS Code will reload to activate the connection.
                            </div>
                            <div style={{ paddingLeft: '44px' }}>
                                <button
                                    onClick={() => {
                                        const botToken = (window as any).slackBotToken;
                                        const appToken = (window as any).slackAppToken;

                                        if (!botToken || !appToken) {
                                            postMessage({ command: 'showMessage', text: '⚠️ Please enter both tokens' });
                                            return;
                                        }

                                        if (!botToken.startsWith('xoxb-')) {
                                            postMessage({ command: 'showMessage', text: '⚠️ Bot token must start with xoxb-' });
                                            return;
                                        }

                                        if (!appToken.startsWith('xapp-')) {
                                            postMessage({ command: 'showMessage', text: '⚠️ App token must start with xapp-' });
                                            return;
                                        }

                                        setSaving(true);
                                        postMessage({
                                            command: 'saveSlackTokens',
                                            botToken,
                                            appToken
                                        });
                                        setTimeout(() => setSaving(false), 2000);
                                    }}
                                    disabled={saving}
                                    style={{
                                        width: '100%',
                                        maxWidth: '500px',
                                        padding: '12px',
                                        background: saving ? '#28a745' : '#611f69',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: saving ? 'wait' : 'pointer',
                                        fontSize: '14px',
                                        fontWeight: 600,
                                        transition: 'all 0.2s',
                                        opacity: saving ? 0.9 : 1
                                    }}
                                >
                                    {saving ? '⏳ Saving...' : '💾 Save & Activate'}
                                </button>
                            </div>
                        </div>
                    </div>
                );
        }
    };

    return (
        <div className="tdad-modal-overlay">
            <div className="wizard-container" style={{ maxWidth: '800px', width: '90vw', height: '600px', maxHeight: '85vh', flexDirection: 'column', overflow: 'hidden' }}>
                <div className="wizard-content-header" style={{ padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                    <h3 className="wizard-content-title" style={{ fontSize: '18px', margin: 0 }}>TDAD Settings</h3>
                    <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '18px', color: 'var(--vscode-descriptionForeground)' }}>✕</button>
                </div>

                <div style={{ display: 'flex', padding: '0 24px', borderBottom: '1px solid rgba(0,0,0,0.06)', flexShrink: 0 }}>
                    {(['project', 'testing', 'autopilot', 'prompts', 'slack'] as SettingsTab[]).map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setActiveTab(tab as SettingsTab)}
                            style={{
                                padding: '10px 12px',
                                border: 'none',
                                borderBottom: activeTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
                                background: 'transparent',
                                color: activeTab === tab ? '#3b82f6' : 'var(--vscode-descriptionForeground)',
                                fontWeight: activeTab === tab ? 600 : 500,
                                cursor: 'pointer',
                                fontSize: '13px',
                                transition: 'all 0.2s'
                            }}
                        >
                            {tab.charAt(0).toUpperCase() + tab.slice(1)}
                            {tab === 'slack' && <span style={{ marginLeft: '4px', fontSize: '7px', fontWeight: 'bold', background: '#ff4444', color: 'white', padding: '1px 3px', borderRadius: '6px', boxShadow: '0 1px 2px rgba(0,0,0,0.3)', verticalAlign: 'top' }}>NEW</span>}
                        </button>
                    ))}
                </div>

                <div className="wizard-content-body" style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', minHeight: 0 }}>
                    {renderTabContent()}
                </div>
            </div>
        </div>
    );
};
