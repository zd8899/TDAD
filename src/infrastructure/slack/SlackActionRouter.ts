/**
 * SlackActionRouter - Routes interactive actions from Slack
 * Extracted from SlackCommandHandler to reduce file size
 */

import { Node } from '../../shared/types';
import { SlackMessageContext, SlackCommandDependencies } from '../../shared/types/slack';
import { isFolderNode } from '../../shared/types/typeGuards';
import { logger } from '../../shared/utils/Logger';
import { SlackService } from './SlackService';
import {
    buildNodeDetailsBlocks,
    buildBddViewBlocks,
    buildBddEditModal,
    buildTestStatusBlocks,
    buildFolderContentsBlocks
} from './SlackBlockBuilders';

export interface ActionRouterContext {
    slackService: SlackService;
    deps: SlackCommandDependencies;
    reply: (context: SlackMessageContext, message: string) => Promise<void>;
    replyWithBlocks: (context: SlackMessageContext, text: string, blocks: any[]) => Promise<void>;
}

/**
 * Route interactive component actions
 */
export async function routeAction(
    actionId: string,
    value: string,
    context: SlackMessageContext,
    ctx: ActionRouterContext
): Promise<void> {
    logger.log('SLACK-CMD', `Action: ${actionId} = ${value}`);

    if (actionId.startsWith('tdad_select_node')) {
        await handleSelectNode(value, context, ctx);
    } else if (actionId === 'tdad_back_btn') {
        await handleBackButton(value, context, ctx);
    } else if (actionId === 'tdad_run_node') {
        await handleRunNode(value, context, ctx);
    } else if (actionId === 'tdad_view_bdd') {
        await handleViewBdd(value, context, ctx);
    } else if (actionId === 'tdad_edit_bdd') {
        await handleEditBdd(value, context, ctx);
    } else if (actionId === 'tdad_view_tests') {
        await handleViewTests(value, context, ctx);
    } else if (actionId === 'tdad_run_tests') {
        await handleRunTests(value, context, ctx);
    } else if (actionId === 'tdad_select_folder') {
        await handleSelectFolder(value, context, ctx);
    } else if (actionId.startsWith('tdad_browse_folder')) {
        await handleBrowseFolder(value, context, ctx);
    } else if (actionId.startsWith('tdad_run_folder')) {
        await handleRunFolder(value, context, ctx);
    } else if (actionId === 'tdad_back_to_nodes') {
        await showFolderContents(context, undefined, ctx);
    }
}

async function handleSelectNode(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (node) {
        const blocks = buildNodeDetailsBlocks(node);
        await ctx.replyWithBlocks(context, `Node: ${node.title}`, blocks);
    } else {
        await ctx.reply(context, `❌ Node not found: ${nodeId}`);
    }
}

async function handleBackButton(value: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    if (value === 'root') {
        await showFolderContents(context, undefined, ctx);
    } else {
        await showFolderContents(context, value, ctx);
    }
}

async function handleRunNode(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (node) {
        await ctx.reply(context, `🚀 Starting automation for: *${node.title}*...`);
        await ctx.deps.runSingleNode(node.id, ['bdd', 'test', 'run-fix']);
    }
}

async function handleViewBdd(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (node) {
        const currentBdd = await ctx.deps.getBddSpec(node.id);
        const blocks = buildBddViewBlocks(node, currentBdd);
        await ctx.replyWithBlocks(context, `BDD: ${node.title}`, blocks);
    }
}

async function handleEditBdd(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (!node) return;

    logger.log('SLACK-CMD', `openBddEditModal: Opening for node ${node.title} (${node.id})`);

    if (!context.triggerId) {
        logger.error('SLACK-CMD', 'Cannot open modal: no trigger_id');
        await ctx.reply(context, '❌ Cannot open edit dialog. Please try again.');
        return;
    }

    const currentBdd = await ctx.deps.getBddSpec(node.id);
    logger.log('SLACK-CMD', `openBddEditModal: Got BDD spec: ${currentBdd ? 'yes' : 'no'}`);

    try {
        const modalView = buildBddEditModal(node, currentBdd);
        await ctx.slackService.openModal(context.triggerId, modalView);
        logger.log('SLACK-CMD', `Opened BDD edit modal for ${node.title}`);
    } catch (error: any) {
        logger.error('SLACK-CMD', `openBddEditModal failed: ${error.message}`, error);
        await ctx.reply(context, `❌ Could not open edit dialog: ${error.message}`);
    }
}

async function handleViewTests(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (node) {
        const blocks = buildTestStatusBlocks(node);
        await ctx.replyWithBlocks(context, `Tests: ${node.title}`, blocks);
    }
}

async function handleRunTests(nodeId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const node = ctx.deps.getNodeById(nodeId);
    if (node) {
        await ctx.reply(context, `🧪 Running tests for: *${node.title}*...`);
        await ctx.deps.runNodeTests(node.id);
    }
}

async function handleSelectFolder(folderId: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    const folder = ctx.deps.getNodeById(folderId);
    if (folder) {
        await showFolderContents(context, folder.id, ctx);
    }
}

async function handleBrowseFolder(value: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    if (value === 'root') {
        await showFolderContents(context, undefined, ctx);
    } else {
        await showFolderContents(context, value, ctx);
    }
}

async function handleRunFolder(value: string, context: SlackMessageContext, ctx: ActionRouterContext): Promise<void> {
    await ctx.reply(context, `🚀 Starting automation for folder...`);
    await ctx.deps.runFolderNodes(value === 'all' ? null : value);
}

/**
 * Show contents of a folder (or root)
 */
export async function showFolderContents(
    context: SlackMessageContext,
    parentId: string | undefined,
    ctx: ActionRouterContext
): Promise<void> {
    const allNodes = ctx.deps.getNodes();

    const isRootLevel = (nodeParentId: string | undefined | null): boolean => {
        return !nodeParentId || nodeParentId === 'root' || nodeParentId === '';
    };

    const children = allNodes.filter(n => {
        if (!parentId) {
            return isRootLevel(n.parentId);
        }
        return n.parentId === parentId;
    });

    const childFolders = children.filter(n => isFolderNode(n));
    const childNodes = children.filter(n => !isFolderNode(n));

    logger.log('SLACK-CMD', `showFolderContents: parentId=${parentId}, folders=${childFolders.length}, nodes=${childNodes.length}`);

    const parent = parentId ? ctx.deps.getNodeById(parentId) : null;
    const title = parent ? `📁 ${parent.title}` : '📋 All Nodes';

    if (childFolders.length === 0 && childNodes.length === 0) {
        await ctx.reply(context, `${title}\n\n_Empty - no items here._`);
        return;
    }

    // Helper to count descendants
    const countDescendants = (folderId: string): number => {
        let count = 0;
        const stack = [folderId];
        while (stack.length > 0) {
            const current = stack.pop()!;
            const folderChildren = allNodes.filter(n => n.parentId === current);
            for (const child of folderChildren) {
                if (isFolderNode(child)) {
                    stack.push(child.id);
                } else {
                    count++;
                }
            }
        }
        return count;
    };

    const blocks = buildFolderContentsBlocks(
        parentId,
        parent ?? null,
        childFolders,
        childNodes,
        countDescendants
    );

    logger.log('SLACK-CMD', `Sending ${blocks.length} blocks to Slack`);
    await ctx.replyWithBlocks(context, title, blocks);
}
