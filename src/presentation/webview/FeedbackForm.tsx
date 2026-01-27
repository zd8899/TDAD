import React, { useState } from 'react';

interface FeedbackFormProps {
    show: boolean;
    onClose: () => void;
    postMessage: (message: any) => void;
}

export const FeedbackForm: React.FC<FeedbackFormProps> = ({ show, onClose, postMessage }) => {
    const [complaint, setComplaint] = useState('');
    const [featureRequest, setFeatureRequest] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    if (!show) return null;

    const overlayStyle: React.CSSProperties = {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
    };

    const cardStyle: React.CSSProperties = {
        background: 'rgba(255, 255, 255, 0.95)',
        backdropFilter: 'blur(16px)',
        border: '1px solid rgba(0, 0, 0, 0.12)',
        borderRadius: '16px',
        padding: '32px',
        width: '500px',
        maxWidth: '90%',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.12)',
        position: 'relative',
    };

    const titleStyle: React.CSSProperties = {
        fontSize: '24px',
        fontWeight: 700,
        margin: '0 0 8px 0',
        background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
    };

    const descStyle: React.CSSProperties = {
        fontSize: '14px',
        color: 'var(--vscode-descriptionForeground)',
        lineHeight: '1.5',
        margin: '0 0 24px 0',
    };

    const labelStyle: React.CSSProperties = {
        display: 'block',
        fontSize: '13px',
        fontWeight: 600,
        marginBottom: '8px',
        color: 'var(--vscode-foreground)',
    };

    const textareaStyle: React.CSSProperties = {
        width: '100%',
        padding: '12px',
        borderRadius: '8px',
        border: '1px solid var(--vscode-input-border)',
        backgroundColor: 'var(--vscode-input-background)',
        color: 'var(--vscode-input-foreground)',
        fontSize: '13px',
        resize: 'vertical',
        minHeight: '80px',
        fontFamily: 'inherit',
        boxSizing: 'border-box',
    };

    const fieldGroupStyle: React.CSSProperties = {
        marginBottom: '20px',
    };

    const buttonRowStyle: React.CSSProperties = {
        display: 'flex',
        gap: '12px',
        justifyContent: 'flex-end',
        marginTop: '24px',
    };

    const btnBaseStyle: React.CSSProperties = {
        padding: '10px 20px',
        borderRadius: '8px',
        fontSize: '14px',
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
    };

    const primaryBtnStyle: React.CSSProperties = {
        ...btnBaseStyle,
        background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
        color: 'white',
        boxShadow: '0 4px 12px rgba(37, 99, 235, 0.3)',
        border: '1px solid rgba(59, 130, 246, 0.5)',
    };

    const secondaryBtnStyle: React.CSSProperties = {
        ...btnBaseStyle,
        background: 'var(--vscode-button-secondaryBackground)',
        color: 'var(--vscode-button-secondaryForeground)',
        border: '1px solid var(--vscode-widget-border)',
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
        padding: '0',
    };

    const successStyle: React.CSSProperties = {
        textAlign: 'center',
        padding: '20px 0',
    };

    const handleSubmit = () => {
        const hasComplaint = complaint.trim().length > 0;
        const hasFeatureRequest = featureRequest.trim().length > 0;

        if (!hasComplaint && !hasFeatureRequest) {
            return;
        }

        setIsSubmitting(true);

        // Send feedback to extension
        postMessage({
            command: 'submitFeedback',
            complaint: complaint.trim(),
            featureRequest: featureRequest.trim(),
        });

        // Show success state
        setTimeout(() => {
            setIsSubmitting(false);
            setSubmitted(true);
            setTimeout(() => {
                onClose();
                setSubmitted(false);
                setComplaint('');
                setFeatureRequest('');
            }, 1500);
        }, 500);
    };

    const handleAllGood = () => {
        postMessage({
            command: 'submitFeedback',
            type: 'positive',
        });
        setSubmitted(true);
        setTimeout(() => {
            onClose();
            setSubmitted(false);
        }, 1500);
    };

    return (
        <div style={overlayStyle} onClick={onClose}>
            <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
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

                {submitted ? (
                    <div style={successStyle}>
                        <div style={{ fontSize: '48px', marginBottom: '16px' }}>🙏</div>
                        <h2 style={{ ...titleStyle, justifyContent: 'center' }}>Thank You!</h2>
                        <p style={descStyle}>Your feedback helps us make TDAD better.</p>
                    </div>
                ) : (
                    <>
                        <h2 style={titleStyle}>
                            <span>💬</span> Share Your Feedback
                        </h2>
                        <p style={descStyle}>
                            TDAD is free and works locally. Since we don't track usage, please kindly let us know how it's going!
                        </p>

                        <div style={fieldGroupStyle}>
                            <label style={labelStyle}>
                                😤 I hate this: <span style={{ fontWeight: 400, color: 'var(--vscode-descriptionForeground)' }}>(optional)</span>
                            </label>
                            <textarea
                                style={textareaStyle}
                                value={complaint}
                                onChange={(e) => setComplaint(e.target.value)}
                                placeholder="What frustrates you about TDAD? e.g., The canvas is slow when I have many nodes..."
                            />
                        </div>

                        <div style={fieldGroupStyle}>
                            <label style={labelStyle}>
                                💡 I would love to have: <span style={{ fontWeight: 400, color: 'var(--vscode-descriptionForeground)' }}>(optional)</span>
                            </label>
                            <textarea
                                style={textareaStyle}
                                value={featureRequest}
                                onChange={(e) => setFeatureRequest(e.target.value)}
                                placeholder="What feature would you love? e.g., Integration with Jest coverage reports..."
                            />
                        </div>

                        <div style={buttonRowStyle}>
                            <button
                                style={secondaryBtnStyle}
                                onClick={handleAllGood}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.transform = 'translateY(-1px)';
                                    e.currentTarget.style.opacity = '0.9';
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.transform = 'translateY(0)';
                                    e.currentTarget.style.opacity = '1';
                                }}
                            >
                                👍 All good!
                            </button>
                            <button
                                style={{
                                    ...primaryBtnStyle,
                                    opacity: (complaint.trim() || featureRequest.trim()) ? 1 : 0.5,
                                    cursor: (complaint.trim() || featureRequest.trim()) ? 'pointer' : 'not-allowed',
                                }}
                                onClick={handleSubmit}
                                disabled={isSubmitting || (!complaint.trim() && !featureRequest.trim())}
                                onMouseEnter={(e) => {
                                    if (complaint.trim() || featureRequest.trim()) {
                                        e.currentTarget.style.transform = 'translateY(-2px)';
                                        e.currentTarget.style.boxShadow = '0 6px 20px rgba(37, 99, 235, 0.4)';
                                    }
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.transform = 'translateY(0)';
                                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(37, 99, 235, 0.3)';
                                }}
                            >
                                {isSubmitting ? '⏳ Sending...' : '📤 Send Feedback'}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
