/**
 * SlackBlockBuilders - Block Kit UI builders for Slack messages
 *
 * This file re-exports all block builders from their respective modules.
 * The builders are split into:
 * - SlackBlockTypes: Shared types and utilities
 * - SlackModalBuilders: Modal builders
 * - SlackViewBuilders: View/blocks builders for messages
 * - SlackHomeTabBuilders: Dynamic Home Tab view builders
 */

// Re-export types and utilities
export {
    SlackBlock,
    getStatusEmoji,
    getStatusDot,
    chunk,
    isRootLevel
} from './SlackBlockTypes';

// Re-export modal builders
export {
    buildPlanEditModal,
    buildAddNodeModal,
    buildAddFolderModal,
    buildAutoGeneratePlanModal,
    buildAutoGenerateTestsModal,
    buildTerminalModal,
    buildSendToCliModal,
    buildRunOptionsModal,
    buildNodesBrowserModal,
    buildNodeDetailsModal
} from './SlackModalBuilders';

// Re-export view builders
export {
    buildNodeDetailsBlocks,
    buildPlanViewBlocks,
    buildTestStatusBlocks,
    buildFolderSummaryBlocks,
    buildFolderContentsBlocks,
    buildStatusBlocks,
    buildProgressBlocks,
    buildCliOutputBlocks,
    buildTerminalPanelWithOutput,
    buildEditFileBlocks,
    buildHelpBlocks,
    buildHomeTabBlocks
} from './SlackViewBuilders';

// Re-export home tab builders
export {
    buildHomeTabDashboard,
    buildHomeTabFolderView,
    buildHomeTabNodeView
} from './SlackHomeTabBuilders';
