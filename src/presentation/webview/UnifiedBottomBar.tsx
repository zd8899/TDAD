import React from 'react';
import CanvasControls from './CanvasControls';
import BottomActionBar from './BottomActionBar';
import CanvasNotification, { NotificationData } from './CanvasNotification';
import { Node } from '../../shared/types';
import '../../styles/bottom-action-bar.css';

interface UnifiedBottomBarProps {
    // State
    selectedNode: Node | null;

    // CanvasControls Props (Global Actions)
    onAddNode: () => void;
    onAddFolder: () => void;
    onOpenSettings?: () => void;
    onRefreshCanvas?: () => void;
    onOpenWaitlist?: () => void;
    onOpenBlueprintWizard?: () => void;
    canUndo?: boolean;
    canRedo?: boolean;
    onUndo?: () => void;
    onRedo?: () => void;
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

    // BottomActionBar Props (Context Actions)
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
    onCopyBddPrompt: () => void;
    onCopyTestGeneration: () => void;
    onRunTest: () => void;
    onCopyGoldenPacket: () => void;
    onRunAutomation: () => void;
    onOpenFile: (filePath: string) => void;
    onOpenTestDetails: () => void;
    onOpenBddEditor: () => void;
    notification?: NotificationData | null;
    onDismissNotification?: () => void;
}

export const UnifiedBottomBar: React.FC<UnifiedBottomBarProps> = (props) => {
    const { selectedNode, notification, onDismissNotification } = props;
    
    // Check if we should show context actions (only for Feature nodes, not folders)
    const isFeatureNode = selectedNode && selectedNode.nodeType !== 'folder';

    if (isFeatureNode) {
        return (
            <BottomActionBar
                selectedNode={props.selectedNode}
                bddSpecFilePath={props.bddSpecFilePath}
                testCodeFilePath={props.testCodeFilePath}
                isGeneratingBdd={props.isGeneratingBdd}
                isGeneratingTest={props.isGeneratingTest}
                isRunningTest={props.isRunningTest}
                isCopyingGoldenPacket={props.isCopyingGoldenPacket}
                isRunningAutomation={props.isRunningAutomation}
                hasTestDetails={props.hasTestDetails}
                hasBddSpec={props.hasBddSpec}
                bddHasRealContent={props.bddHasRealContent}
                testHasRealContent={props.testHasRealContent}
                onCopyBddPrompt={props.onCopyBddPrompt}
                onCopyTestGeneration={props.onCopyTestGeneration}
                onRunTest={props.onRunTest}
                onCopyGoldenPacket={props.onCopyGoldenPacket}
                onRunAutomation={props.onRunAutomation}
                onOpenFile={props.onOpenFile}
                onOpenTestDetails={props.onOpenTestDetails}
                onOpenBddEditor={props.onOpenBddEditor}
                notification={notification}
                onDismissNotification={onDismissNotification}
            />
        );
    }

    return (
        <div className="bottom-action-bar">
            {/* Notification Toast - appears at top of the stack */}
            {notification && onDismissNotification && (
                <CanvasNotification
                    notification={notification}
                    onDismiss={onDismissNotification}
                />
            )}
            <CanvasControls
                hasSelectedNode={!!selectedNode}
                onAddNode={props.onAddNode}
                onAddFolder={props.onAddFolder}
                onOpenSettings={props.onOpenSettings}
                onRefreshCanvas={props.onRefreshCanvas}
                onOpenWaitlist={props.onOpenWaitlist}
                onOpenBlueprintWizard={props.onOpenBlueprintWizard}
                canUndo={props.canUndo}
                canRedo={props.canRedo}
                onUndo={props.onUndo}
                onRedo={props.onRedo}
                automationStatus={props.automationStatus}
                automationMessage={props.automationMessage}
                onStartAutomation={props.onStartAutomation}
                onStopAutomation={props.onStopAutomation}
                onCopyAgentPrompt={props.onCopyAgentPrompt}
                isRunningAllNodes={props.isRunningAllNodes}
                allNodesProgress={props.allNodesProgress}
                onRunAllNodes={props.onRunAllNodes}
                onStopAllNodes={props.onStopAllNodes}
                onOpenFeedback={props.onOpenFeedback}
            />
        </div>
    );
};
