import React from 'react';

interface WelcomeOverlayProps {
    onStartNew: () => void;
    onImport: () => void;
    onClose: () => void;
}

export const WelcomeOverlay: React.FC<WelcomeOverlayProps> = ({ onStartNew, onImport, onClose }) => {
    const containerStyle: React.CSSProperties = {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
        pointerEvents: 'none', // Allow clicking through to canvas if needed
        width: '100%'
    };

    const cardStyle: React.CSSProperties = {
        background: 'rgba(255, 255, 255, 0.95)',
        backdropFilter: 'blur(16px)',
        border: '1px solid rgba(0, 0, 0, 0.12)',
        borderRadius: '16px',
        padding: '40px',
        width: '500px',
        maxWidth: '90%',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.12)',
        textAlign: 'center',
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '24px'
    };

    const titleStyle: React.CSSProperties = {
        fontSize: '28px',
        fontWeight: 700,
        margin: '0',
        background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
    };

    const descStyle: React.CSSProperties = {
        fontSize: '15px',
        color: 'var(--vscode-descriptionForeground)',
        lineHeight: '1.6',
        margin: '0',
        maxWidth: '400px'
    };

    const buttonRowStyle: React.CSSProperties = {
        display: 'flex',
        gap: '16px',
        justifyContent: 'center',
        marginTop: '8px',
        width: '100%'
    };

    const btnBaseStyle: React.CSSProperties = {
        padding: '12px 24px',
        borderRadius: '8px',
        fontSize: '14px',
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        flex: 1,
        maxWidth: '200px'
    };

    const primaryBtnStyle: React.CSSProperties = {
        ...btnBaseStyle,
        background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
        color: 'white',
        boxShadow: '0 4px 12px rgba(37, 99, 235, 0.3)',
        border: '1px solid rgba(59, 130, 246, 0.5)'
    };

    const secondaryBtnStyle: React.CSSProperties = {
        ...btnBaseStyle,
        background: 'var(--vscode-button-secondaryBackground)',
        color: 'var(--vscode-button-secondaryForeground)',
        border: '1px solid var(--vscode-widget-border)'
    };

    const closeBtnStyle: React.CSSProperties = {
        position: 'absolute',
        top: '12px',
        right: '12px',
        width: '28px',
        height: '28px',
        borderRadius: '6px',
        border: 'none',
        background: 'transparent',
        color: 'var(--vscode-descriptionForeground)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '18px',
        transition: 'all 0.2s',
        padding: '0'
    };

    return (
        <div style={containerStyle}>
            <div style={cardStyle}>
                <button
                    style={closeBtnStyle}
                    onClick={onClose}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(0, 0, 0, 0.05)';
                        e.currentTarget.style.color = 'var(--vscode-foreground)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = 'var(--vscode-descriptionForeground)';
                    }}
                    title="Close"
                >
                    ✕
                </button>
                <div style={{ fontSize: '56px', marginBottom: '-8px' }}>🚀</div>
                
                <div>
                    <h1 style={titleStyle}>Welcome to TDAD</h1>
                    <div style={{ fontSize: '13px', color: 'var(--vscode-textLink-activeForeground)', fontWeight: 500, marginTop: '4px' }}>
                        The AI-Native TDD Orchestrator
                    </div>
                </div>

                <p style={descStyle}>
                    Your canvas is empty. Start by defining your project idea or mapping your existing codebase.
                </p>
                
                <div style={buttonRowStyle}>
                    <button 
                        style={primaryBtnStyle} 
                        onClick={onStartNew}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.transform = 'translateY(-2px)';
                            e.currentTarget.style.boxShadow = '0 6px 20px rgba(37, 99, 235, 0.4)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.transform = 'translateY(0)';
                            e.currentTarget.style.boxShadow = '0 4px 12px rgba(37, 99, 235, 0.3)';
                        }}
                    >
                        <span>✨</span> Start New
                    </button>
                    
                    <button 
                        style={secondaryBtnStyle} 
                        onClick={onImport}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.transform = 'translateY(-2px)';
                            e.currentTarget.style.opacity = '0.9';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.transform = 'translateY(0)';
                            e.currentTarget.style.opacity = '1';
                        }}
                    >
                        <span>📂</span> Map Codebase
                    </button>
                </div>

                <div style={{ marginTop: '24px' }}>
                    <a
                        href="https://github.com/zd8899/TDAD"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                            fontSize: '12px',
                            color: 'var(--vscode-textLink-foreground)',
                            textDecoration: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            opacity: 0.8,
                            transition: 'opacity 0.2s'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                        onMouseLeave={(e) => e.currentTarget.style.opacity = '0.8'}
                    >
                        <span>⭐</span> Star on GitHub to support us!
                    </a>
                </div>
            </div>
        </div>
    );
};

