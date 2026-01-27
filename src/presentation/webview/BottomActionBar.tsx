/**
 * BottomActionBar - Context-aware workflow action bar shown at bottom of canvas
 *
 * Displays a linear workflow pipeline: BDD -> Tests -> Run -> Fix
 * Design: Glassmorphic action groups with split buttons for Edit/View access.
 */

import React from 'react';
import { Node } from '../../shared/types';
import CanvasNotification, { NotificationData } from './CanvasNotification';
import { isAutopilotComingSoon } from '../../shared/utils/FeatureGating';
import '../../styles/bottom-action-bar.css';
import '../../styles/canvas-notification.css';

interface BottomActionBarProps {
    selectedNode: Node | null;
    // State
    bddSpecFilePath: string | null;
    testCodeFilePath: string | null;
    isGeneratingBdd: boolean;
    isGeneratingTest: boolean;
    isRunningTest: boolean;
    isCopyingGoldenPacket: boolean;
    isRunningAutomation: boolean;
    hasTestDetails: boolean;
    hasBddSpec: boolean;
    bddHasRealContent: boolean;
    testHasRealContent: boolean;
    // Handlers
    onCopyBddPrompt: () => void;
    onCopyTestGeneration: () => void;
    onRunTest: () => void;
    onCopyGoldenPacket: () => void;
    onRunAutomation: () => void;
    onOpenFile: (filePath: string) => void;
    onOpenTestDetails: () => void;
    onOpenBddEditor: () => void;
    onOpenWaitlist?: () => void;
    // Notification
    notification?: NotificationData | null;
    onDismissNotification?: () => void;
}

const BottomActionBar: React.FC<BottomActionBarProps> = ({
    selectedNode,
    isGeneratingBdd,
    isGeneratingTest,
    isRunningTest,
    isCopyingGoldenPacket,
    isRunningAutomation,
    hasTestDetails,
    hasBddSpec,
    bddHasRealContent,
    testHasRealContent,
    onCopyBddPrompt,
    onCopyTestGeneration,
    onRunTest,
    onCopyGoldenPacket,
    onRunAutomation,
    onOpenTestDetails,
    onOpenBddEditor,
    onOpenWaitlist,
    notification,
    onDismissNotification
}) => {
    if (!selectedNode) {
        return null;
    }

    // STRICT Workflow Status Logic
    // 1. BDD: Always available (Start point)
    // 2. Tests: Available only if BDD Spec exists
    // 3. Run: Available only if Tests exist
    // 4. Fix: Available only if Tests exist (usually after Run, but available for iterative fixing)

    const isBddDone = hasBddSpec;
    const isTestsDone = hasTestDetails;
    // Run is an action, not a state to be "done" in the artifact sense, but result is passed/failed.
    const isRunDone = selectedNode.status === 'passed' || selectedNode.status === 'failed';

    // 3-segment progress bar states
    type BarState = 'grey' | 'orange' | 'green' | 'red';
    const barColors: Record<BarState, string> = {
        grey: '#9ca3af',
        orange: '#f59e0b',
        green: '#4ade80',
        red: '#f87171'
    };

    // Progress bar based on FILE STATE (independent of automation):
    // - Grey: Nothing exists for this phase
    // - Orange: Previous phase done, this phase waiting
    // - Green: This phase complete
    // - Red: Failed (only for Run+Fix)

    const getBddBarState = (): BarState => {
        // Green: BDD has REAL content (file content differs from default scaffold)
        if (bddHasRealContent) {return 'green';}
        // Orange: BDD file exists but still default template
        if (isBddDone) {return 'orange';}
        // Grey: No BDD file yet
        return 'grey';
    };

    const getTestGenBarState = (): BarState => {
        // Grey: No BDD yet - can't have tests
        if (!isBddDone && !bddHasRealContent) {return 'grey';}
        // Green: Tests have REAL content (file content differs from default scaffold)
        if (testHasRealContent) {return 'green';}
        // Orange: Test file exists but still default template
        if (isTestsDone) {return 'orange';}
        // Grey: BDD exists but no test file yet
        return 'grey';
    };

    const getTestFixBarState = (): BarState => {
        // Green: Tests passed
        if (selectedNode.status === 'passed') {return 'green';}
        // Red: Tests failed
        if (selectedNode.status === 'failed') {return 'red';}
        // Orange: Currently testing
        if (isRunningTest || selectedNode.status === 'testing') {return 'orange';}
        // Grey: Not run yet
        return 'grey';
    };

    const bddBarState = getBddBarState();
    const testGenBarState = getTestGenBarState();
    const testFixBarState = getTestFixBarState();
    const isBddWorking = bddBarState === 'orange';
    const isTestGenWorking = testGenBarState === 'orange';
    const isTestFixWorking = testFixBarState === 'orange';

    // Step 1: BDD Logic
    const bddGroupClass = `bottom-action-bar__group`;
    const bddMainClass = `bottom-action-bar__segment ${isGeneratingBdd ? 'bottom-action-bar__segment--active' : (isBddDone ? 'bottom-action-bar__segment--completed' : '')}`;

    // Step 2: Tests Logic - STRICTLY disabled if no BDD
    const testsDisabled = !isBddDone;
    const testsGroupClass = `bottom-action-bar__group ${testsDisabled ? 'bottom-action-bar__group--disabled' : ''}`;
    const testsMainClass = `bottom-action-bar__segment ${isGeneratingTest ? 'bottom-action-bar__segment--active' : (isTestsDone ? 'bottom-action-bar__segment--completed' : '')}`;

    // Step 3: Run Logic - STRICTLY disabled if no Tests
    const runDisabled = !isTestsDone;
    const runGroupClass = `bottom-action-bar__group ${runDisabled ? 'bottom-action-bar__group--disabled' : ''}`;
    const runMainClass = `bottom-action-bar__segment bottom-action-bar__segment--compact ${isRunningTest ? 'bottom-action-bar__segment--active' : (isRunDone ? 'bottom-action-bar__segment--completed' : '')}`;

    // Step 4: Fix Logic - STRICTLY disabled if no Tests (can't fix what you haven't tested)
    const fixDisabled = !isTestsDone;
    const fixGroupClass = `bottom-action-bar__group ${fixDisabled ? 'bottom-action-bar__group--disabled' : ''}`;
    const fixMainClass = `bottom-action-bar__segment bottom-action-bar__segment--compact ${isCopyingGoldenPacket ? 'bottom-action-bar__segment--active' : ''}`;


    return (
        <div className="bottom-action-bar">
            {/* Notification Toast - appears at top */}
            {notification && onDismissNotification && (
                <CanvasNotification
                    notification={notification}
                    onDismiss={onDismissNotification}
                />
            )}

            {/* Horizontal container for action buttons */}
            <div className="bottom-action-bar__row">
                {/* Auto Run - Separate pill (toggle: click to start/stop) */}
                <div className="bottom-action-bar__auto-container">
                    <button
                        className={`bottom-action-bar__segment bottom-action-bar__segment--auto ${isRunningAutomation ? 'bottom-action-bar__segment--active' : ''} ${isAutopilotComingSoon() ? 'bottom-action-bar__segment--coming-soon' : ''}`}
                        onClick={() => {
                            if (isAutopilotComingSoon()) {
                                onOpenWaitlist?.();
                            } else {
                                onRunAutomation();
                            }
                        }}
                        title={isAutopilotComingSoon() ? 'Coming Soon - Click to join waitlist!' : (isRunningAutomation ? 'Stop Auto-Pilot' : 'Engage Auto-Pilot: Hands-free Plan → Test → Fix loop')}
                    >
                        <span className="bottom-action-bar__icon">
                            {isAutopilotComingSoon() ? '✈' : (isRunningAutomation ? '■' : '✈')}
                        </span>
                        <span>{isAutopilotComingSoon() ? 'Coming Soon' : (isRunningAutomation ? 'Stop' : 'Auto-Pilot')}</span>
                    </button>
                </div>

                {/* Main content wrapper - contains buttons and progress bar */}
                <div className="bottom-action-bar__main-wrapper">
                    {/* Main Action Bar - 3 equal sections aligned with progress bar */}
                    <div className="bottom-action-bar__content">

                {/* Section 1: BDD (33%) */}
                <div className="bottom-action-bar__section">
                    <div className={bddGroupClass}>
                        <button
                            className={bddMainClass}
                            onClick={onCopyBddPrompt}
                            disabled={isGeneratingBdd}
                            title="Copy Plan Generation Prompt"
                        >
                            <span>1. Plan</span>
                        </button>
                        {hasBddSpec && (
                            <button
                                className="bottom-action-bar__mini-btn"
                                onClick={onOpenBddEditor}
                                title="Edit Plan"
                            >
                                ✎
                            </button>
                        )}
                    </div>
                </div>

                {/* Section 2: Tests (33%) */}
                <div className="bottom-action-bar__section">
                    <div className={testsGroupClass}>
                        <button
                            className={testsMainClass}
                            onClick={onCopyTestGeneration}
                            disabled={isGeneratingTest || testsDisabled}
                            title="Copy Test Generation Prompt"
                        >
                            <span>2. Tests</span>
                        </button>
                        {hasTestDetails && (
                            <button
                                className="bottom-action-bar__mini-btn"
                                onClick={onOpenTestDetails}
                                title="Edit Test Details"
                            >
                                ✎
                            </button>
                        )}
                    </div>
                </div>

                {/* Section 3: Run + Fix (Joined Segment) */}
                <div className="bottom-action-bar__section">
                    <div className={`bottom-action-bar__joined-wrapper ${runDisabled ? 'bottom-action-bar__group--disabled' : ''}`}>
                        <button
                            className={`bottom-action-bar__segment bottom-action-bar__segment--joined-left ${isRunningTest ? 'bottom-action-bar__segment--active' : (isRunDone ? 'bottom-action-bar__segment--completed' : '')}`}
                            onClick={onRunTest}
                            disabled={isRunningTest || runDisabled}
                            title="Run Tests"
                        >
                            <span>3. Run</span>
                        </button>
                        <div className="bottom-action-bar__joined-separator">
                            ↻
                        </div>
                        <button
                            className={`bottom-action-bar__segment bottom-action-bar__segment--joined-right ${isCopyingGoldenPacket ? 'bottom-action-bar__segment--active' : ''}`}
                            onClick={onCopyGoldenPacket}
                            disabled={isCopyingGoldenPacket || fixDisabled}
                            title="Copy Golden Packet (Context for AI Fix)"
                        >
                            <span>4. Fix</span>
                        </button>
                    </div>
                </div>

                    </div>

                    {/* 3-Segment Progress Bar - below buttons, inside main-wrapper */}
                    <div className="bottom-action-bar__progress-container">
                        <div
                            className={`bottom-action-bar__progress-segment ${isBddWorking ? 'bottom-action-bar__progress-segment--animated' : ''}`}
                            style={{ backgroundColor: barColors[bddBarState] }}
                            title="Plan"
                        />
                        <div
                            className={`bottom-action-bar__progress-segment ${isTestGenWorking ? 'bottom-action-bar__progress-segment--animated' : ''}`}
                            style={{ backgroundColor: barColors[testGenBarState] }}
                            title="Test Generation"
                        />
                        <div
                            className={`bottom-action-bar__progress-segment ${isTestFixWorking ? 'bottom-action-bar__progress-segment--animated' : ''}`}
                            style={{ backgroundColor: barColors[testFixBarState] }}
                            title="Test & Fix"
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default BottomActionBar;
