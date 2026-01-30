/**
 * SlackActionRouter - Routes interactive actions from Slack
 * Extracted from SlackCommandHandler to reduce file size
 */

import { Node } from '../../shared/types';
import { SlackMessageContext, SlackCommandDependencies, HomeTabView } from '../../shared/types/slack';
import { logger } from '../../shared/utils/Logger';
import { SlackService } from './SlackService';
import { CLIOutputWatcher } from './CLIOutputWatcher';
import {
    buildPlanEditModal,
    buildAddNodeModal,
    buildAddFolderModal,
    buildAutoGeneratePlanModal,
    buildAutoGenerateTestsModal,
    buildTerminalModal,
    buildRunOptionsModal,
    buildEditFeatureModal
} from './SlackBlockBuilders';

export interface ActiveAutomationThread {
    channelId: string;
    threadTs: string;
}

export interface ActionRouterContext {
    slackService: SlackService;
    deps: SlackCommandDependencies;
    activeThreads: Map<string, CLIOutputWatcher>;
    reply: (context: SlackMessageContext, message: string) => Promise<void>;
    replyWithBlocks: (context: SlackMessageContext, text: string, blocks: any[]) => Promise<void>;
    getActiveThread: () => ActiveAutomationThread | null;
    setActiveThread: (thread: ActiveAutomationThread | null) => void;
    clearActiveThread: () => void;
    setLastKnownChannel: (channelId: string) => void;
    getLastKnownChannel: () => string;
    updateHomeTab: (userId: string, newView?: HomeTabView) => Promise<void>;
    setUserView: (userId: string, view: HomeTabView) => Promise<void>;
    getUserView: (userId: string) => HomeTabView;
}
/**
 * Route interactive component actions (Home Tab only)
 */
export async function routeAction(
    actionId: string,
    value: string,
    context: SlackMessageContext,
    ctx: ActionRouterContext
): Promise<void> {
    logger.log('SLACK-CMD', `Action: ${actionId} = ${value}`);

    // =============================================================================
    // HOME TAB NAVIGATION ACTIONS
    // =============================================================================
    if (actionId === 'tdad_home_start_autopilot') {
        await handleHomeStartAutopilot(context, ctx);
    } else if (actionId === 'tdad_home_stop') {
        await handleHomeStop(context, ctx);
    } else if (actionId === 'tdad_home_browse') {
        await handleHomeBrowse(null, context, ctx);
    } else if (actionId.startsWith('tdad_home_folder:')) {
        const folderId = actionId.split(':')[1];
        await handleHomeBrowse(folderId, context, ctx);
    } else if (actionId.startsWith('tdad_home_node:')) {
        const nodeId = actionId.split(':')[1];
        await handleHomeSelectNode(nodeId, context, ctx);
    } else if (actionId === 'tdad_home_dashboard') {
        await handleHomeDashboard(context, ctx);
    } else if (actionId === 'tdad_home_back') {
        const parentId = value === 'root' ? null : value;
        await handleHomeBrowse(parentId, context, ctx);
    } else if (actionId === 'tdad_home_back_from_node') {
        const folderId = value === 'root' ? null : value;
        await handleHomeBrowse(folderId, context, ctx);
    } else if (actionId === 'tdad_home_add_node') {
        await handleAddNode(value, context, ctx);
    } else if (actionId === 'tdad_home_add_folder') {
        await handleAddFolder(value, context, ctx);
    } else if (actionId === 'tdad_home_run_folder') {
        await handleHomeRunFolder(value, context, ctx);
    } else if (actionId === 'tdad_home_auto_plan') {
        await handleAutoGeneratePlan(value, context, ctx);
    } else if (actionId === 'tdad_home_auto_test') {
        await handleAutoGenerateTests(value, context, ctx);
    } else if (actionId === 'tdad_home_run_fix') {
        await handleHomeRunFix(value, context, ctx);
    } else if (actionId === 'tdad_home_run_full') {
        await handleHomeRunFull(value, context, ctx);
    } else if (actionId === 'tdad_home_edit_plan') {
        await handleEditPlan(value, context, ctx);
    } else if (actionId === 'tdad_home_edit_feature') {
        await handleEditFeature(value, context, ctx);
    } else if (actionId === 'tdad_home_run_tests') {
        await handleHomeRunTests(value, context, ctx);
    }
    // =============================================================================
    // MODAL ACTIONS (opened from Home Tab)
    // =============================================================================
    else if (actionId === 'tdad_terminal_refresh') {
        await handleTerminalRefresh(context, ctx);
    } else if (actionId === 'tdad_terminal_stop') {
        await handleTerminalStop(context, ctx);
    } else if (actionId === 'tdad_cmd_cli') {
        await handleCmdCli(context, ctx);
    }
}

async function handleEditPlan(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (!node) return;

    logger.log('SLACK-CMD', `openPlanEditModal: Opening for node ${node.title} (${node.id})`);

    if (!context.triggerId) {
        logger.error('SLACK-CMD', 'Cannot open modal: no trigger_id');
        await ctx.reply(context, '❌ Cannot open edit dialog. Please try again.');
        return;
    }

    const currentPlan = await ctx.deps.getPlanSpec(node.id);
    logger.log('SLACK-CMD', `openPlanEditModal: Got Plan: ${currentPlan ? 'yes' : 'no'}`);

    try {
        const modalView = buildPlanEditModal(node, currentPlan, context.channelId);
        await ctx.slackService.openModal(context.triggerId, modalView);
        logger.log('SLACK-CMD', `Opened Plan edit modal for ${node.title}`);
    } catch (error: any) {
        logger.error('SLACK-CMD', `openPlanEditModal failed: ${error.message}`, error);
        await ctx.reply(context, `❌ Could not open edit dialog: ${error.message}`);
    }
}

async function handleEditFeature(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (!node) return;

    logger.log('SLACK-CMD', `openEditFeatureModal: Opening for node ${node.title} (${node.id})`);

    if (!context.triggerId) {
        logger.error('SLACK-CMD', 'Cannot open modal: no trigger_id');
        await ctx.reply(context, '❌ Cannot open edit dialog. Please try again.');
        return;
    }

    try {
        const modalView = buildEditFeatureModal(node, context.channelId);
        await ctx.slackService.openModal(context.triggerId, modalView);
        logger.log('SLACK-CMD', `Opened Edit Feature modal for ${node.title}`);
    } catch (error: any) {
        logger.error('SLACK-CMD', `openEditFeatureModal failed: ${error.message}`, error);
        await ctx.reply(context, `❌ Could not open edit dialog: ${error.message}`);
    }
}

async function handleAddNode(parentId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const effectiveParentId = parentId === 'root' ? undefined : parentId;
    logger.log('SLACK-CMD', `Opening Add Node modal, parentId: ${effectiveParentId || 'root'}`);

    if (!context.triggerId) {
        logger.error('SLACK-CMD', 'Cannot open modal: no trigger_id');
        await ctx.reply(context, '❌ Cannot open add node dialog. Please try again.');
        return;
    }

    try {
        const modalView = buildAddNodeModal(context.channelId, effectiveParentId);
        await ctx.slackService.openModal(context.triggerId, modalView);
        logger.log('SLACK-CMD', 'Opened Add Node modal');
    } catch (error: any) {
        logger.error('SLACK-CMD', `handleAddNode failed: ${error.message}`, error);
        await ctx.reply(context, `❌ Could not open add node dialog: ${error.message}`);
    }
}

async function handleAddFolder(parentId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const effectiveParentId = parentId === 'root' ? undefined : parentId;
    logger.log('SLACK-CMD', `Opening Add Folder modal, parentId: ${effectiveParentId || 'root'}`);

    if (!context.triggerId) {
        logger.error('SLACK-CMD', 'Cannot open modal: no trigger_id');
        await ctx.reply(context, '❌ Cannot open add folder dialog. Please try again.');
        return;
    }

    try {
        const modalView = buildAddFolderModal(context.channelId, effectiveParentId);
        await ctx.slackService.openModal(context.triggerId, modalView);
        logger.log('SLACK-CMD', 'Opened Add Folder modal');
    } catch (error: any) {
        logger.error('SLACK-CMD', `handleAddFolder failed: ${error.message}`, error);
        await ctx.reply(context, `❌ Could not open add folder dialog: ${error.message}`);
    }
}

async function handleAutoGeneratePlan(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (!node) return;

    logger.log('SLACK-CMD', `openAutoGeneratePlanModal: Opening for node ${node.title} (${node.id})`);

    if (!context.triggerId) {
        logger.error('SLACK-CMD', 'Cannot open modal: no trigger_id');
        await ctx.reply(context, '❌ Cannot open auto-generate dialog. Please try again.');
        return;
    }

    try {
        const modalView = buildAutoGeneratePlanModal(node, context.channelId);
        await ctx.slackService.openModal(context.triggerId, modalView);
        logger.log('SLACK-CMD', `Opened Auto-Generate Plan modal for ${node.title}`);
    } catch (error: any) {
        logger.error('SLACK-CMD', `openAutoGeneratePlanModal failed: ${error.message}`, error);
        await ctx.reply(context, `❌ Could not open auto-generate dialog: ${error.message}`);
    }
}

async function handleAutoGenerateTests(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (!node) return;

    logger.log('SLACK-CMD', `openAutoGenerateTestsModal: Opening for node ${node.title} (${node.id})`);

    if (!context.triggerId) {
        logger.error('SLACK-CMD', 'Cannot open modal: no trigger_id');
        await ctx.reply(context, '❌ Cannot open auto-generate dialog. Please try again.');
        return;
    }

    try {
        const modalView = buildAutoGenerateTestsModal(node, context.channelId);
        await ctx.slackService.openModal(context.triggerId, modalView);
        logger.log('SLACK-CMD', `Opened Auto-Generate Tests modal for ${node.title}`);
    } catch (error: any) {
        logger.error('SLACK-CMD', `openAutoGenerateTestsModal failed: ${error.message}`, error);
        await ctx.reply(context, `❌ Could not open auto-generate dialog: ${error.message}`);
    }
}
// =============================================================================
// MODAL ACTION HANDLERS (for Home Tab initiated modals)
// =============================================================================

async function handleCmdAutopilotStart(context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    if (!context.triggerId) {
        logger.error('SLACK-CMD', 'Cannot open modal: no trigger_id');
        return;
    }

    try {
        const modalView = buildRunOptionsModal('all', 'All Nodes', true, '');
        await ctx.slackService.openModal(context.triggerId, modalView);
        logger.log('SLACK-CMD', 'Opened Run Options modal for Start Autopilot');
    } catch (error: any) {
        logger.error('SLACK-CMD', `handleCmdAutopilotStart modal failed: ${error.message}`, error);
    }
}

async function handleCmdAutopilotStop(context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    ctx.deps.stopAutomation();

    // Clear Slack-specific watchers
    for (const [, watcher] of ctx.activeThreads) {
        watcher.stopWatching();
    }
    ctx.activeThreads.clear();
    ctx.clearActiveThread();

    // Update Home tab to reflect stopped state
    if (context.userId) {
        await ctx.updateHomeTab(context.userId);
    }
}

async function handleCmdCli(context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    if (!context.triggerId) {
        logger.error('SLACK-CMD', 'Cannot open terminal modal: no trigger_id');
        return;
    }

    const output = await ctx.deps.captureCliOutput() || 'No output captured. Is the terminal running?';
    const modalView = buildTerminalModal('', output);
    await ctx.slackService.openModal(context.triggerId, modalView);
}

async function handleTerminalRefresh(context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    if (!context.viewId) {
        await ctx.reply(context, 'Cannot refresh: not in a modal');
        return;
    }

    // Capture fresh output
    const output = await ctx.deps.captureCliOutput() || 'No output captured.';

    // Update modal with new output
    const modalView = buildTerminalModal(context.channelId, output);
    await ctx.slackService.updateModal(context.viewId, modalView);
}

async function handleTerminalStop(context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    // Stop the agent
    ctx.deps.stopAutomation();

    // Clear watchers
    for (const [, watcher] of ctx.activeThreads) {
        watcher.stopWatching();
    }
    ctx.activeThreads.clear();

    if (!context.viewId) {
        await ctx.reply(context, 'Agent stopped.');
        return;
    }

    // Update modal with stopped status
    const modalView = buildTerminalModal(context.channelId, 'Agent stopped.');
    await ctx.slackService.updateModal(context.viewId, modalView);
}

// =============================================================================
// HOME TAB ACTION HANDLERS
// =============================================================================

/**
 * Home Tab: Navigate to dashboard view
 */
async function handleHomeDashboard(context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    if (!context.userId) return;
    await ctx.setUserView(context.userId, { type: 'dashboard' });
    await ctx.updateHomeTab(context.userId);
}

/**
 * Home Tab: Browse folder (or root)
 */
async function handleHomeBrowse(folderId: string | null, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    if (!context.userId) return;
    await ctx.setUserView(context.userId, { type: 'folder', folderId });
    await ctx.updateHomeTab(context.userId);
}

/**
 * Home Tab: Select a node to view details
 */
async function handleHomeSelectNode(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    if (!context.userId) return;
    await ctx.setUserView(context.userId, { type: 'node', nodeId });
    await ctx.updateHomeTab(context.userId);
}

/**
 * Home Tab: Start autopilot (shows mode selection modal)
 */
async function handleHomeStartAutopilot(context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    // Reuse the existing autopilot start handler which opens the mode selection modal
    await handleCmdAutopilotStart(context, ctx);
}

/**
 * Home Tab: Stop automation
 */
async function handleHomeStop(context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    // Reuse the existing stop handler
    await handleCmdAutopilotStop(context, ctx);
}

/**
 * Home Tab: Run folder (shows mode selection modal)
 */
async function handleHomeRunFolder(value: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    if (!context.triggerId) {
        logger.error('SLACK-CMD', 'Cannot open modal: no trigger_id');
        return;
    }

    try {
        let targetName: string;
        if (value === 'all') {
            targetName = 'All Nodes';
        } else {
            const folder = ctx.deps.getNodeById(value);
            targetName = folder ? `📁 ${folder.title}` : 'Selected Folder';
        }

        const modalView = buildRunOptionsModal(value, targetName, true, '');
        await ctx.slackService.openModal(context.triggerId, modalView);
        logger.log('SLACK-CMD', `Opened Run Options modal from Home Tab for ${targetName}`);
    } catch (error: any) {
        logger.error('SLACK-CMD', `handleHomeRunFolder modal failed: ${error.message}`, error);
    }
}

/**
 * Home Tab: Run & Fix for a node
 */
async function handleHomeRunFix(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (!node) return;

    logger.log('SLACK-CMD', `Home Tab Run & Fix: Starting for node ${node.title} (${node.id})`);

    // Immediate feedback: Update Home tab with "starting" indication
    if (context.userId) {
        // Set a temporary running state message before the actual automation starts
        await ctx.updateHomeTab(context.userId);
    }

    try {
        const result = await ctx.deps.runSingleNode(node.id, ['run-fix']);
        if (result.started) {
            logger.log('SLACK-CMD', `Started Run & Fix for ${node.title}`);
            // Refresh again to show proper running status
            if (context.userId) {
                await ctx.updateHomeTab(context.userId);
            }
        } else {
            logger.log('SLACK-CMD', `Run & Fix blocked: ${result.error}`);
            // Show error via respond if available
            if (context.respond) {
                await context.respond(`⚠️ Could not start Run & Fix: ${result.error}`);
            }
        }
    } catch (error: any) {
        logger.error('SLACK-CMD', `Failed to start Run & Fix: ${error.message}`, error);
    }
}

/**
 * Home Tab: Full automation (Plan + Test + Run&Fix) for a node
 */
async function handleHomeRunFull(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (!node) return;

    logger.log('SLACK-CMD', `Home Tab Full Run: Starting for node ${node.title} (${node.id})`);

    // Immediate feedback: Update Home tab before starting
    if (context.userId) {
        await ctx.updateHomeTab(context.userId);
    }

    try {
        const result = await ctx.deps.runSingleNode(node.id, ['bdd', 'test', 'run-fix']);
        if (result.started) {
            logger.log('SLACK-CMD', `Started Full automation for ${node.title}`);
            // Refresh again to show proper running status
            if (context.userId) {
                await ctx.updateHomeTab(context.userId);
            }
        } else {
            logger.log('SLACK-CMD', `Full automation blocked: ${result.error}`);
            // Show error via respond if available
            if (context.respond) {
                await context.respond(`⚠️ Could not start automation: ${result.error}`);
            }
        }
    } catch (error: any) {
        logger.error('SLACK-CMD', `Failed to start Full automation: ${error.message}`, error);
    }
}

/**
 * Home Tab: Run tests for a node
 */
async function handleHomeRunTests(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (!node) return;

    logger.log('SLACK-CMD', `Home Tab Run Tests: Starting for node ${node.title} (${node.id})`);

    // Immediate feedback: Update Home tab before starting
    if (context.userId) {
        await ctx.updateHomeTab(context.userId);
    }

    try {
        await ctx.deps.runNodeTests(node.id);
        logger.log('SLACK-CMD', `Triggered tests for ${node.title}`);
        // Refresh again to show running status
        if (context.userId) {
            await ctx.updateHomeTab(context.userId);
        }
    } catch (error: any) {
        logger.error('SLACK-CMD', `Failed to run tests: ${error.message}`, error);
        if (context.respond) {
            await context.respond(`❌ Failed to run tests: ${error.message}`);
        }
    }
}
