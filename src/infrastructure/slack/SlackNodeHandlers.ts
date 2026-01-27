/**
 * SlackNodeHandlers - Node-related command handlers for Slack
 * Extracted from SlackCommandHandler to reduce file size
 */

import { Node } from '../../shared/types';
import { SlackMessageContext, SlackCommandDependencies } from '../../shared/types/slack';
import { isFolderNode } from '../../shared/types/typeGuards';
import { logger } from '../../shared/utils/Logger';

export interface NodeHandlerContext {
    deps: SlackCommandDependencies;
    reply: (context: SlackMessageContext, message: string) => Promise<void>;
    replyWithBlocks: (context: SlackMessageContext, text: string, blocks: any[]) => Promise<void>;
}

/**
 * Find a node by name (case-insensitive partial match)
 */
export function findNodeByName(nodes: Node[], name: string): Node | undefined {
    return nodes.find(n =>
        n.title.toLowerCase().includes(name.toLowerCase()) &&
        !isFolderNode(n)
    );
}

/**
 * Find a folder by name
 */
export function findFolderByName(nodes: Node[], name: string): Node | undefined {
    return nodes.find(n =>
        n.title.toLowerCase().includes(name.toLowerCase()) &&
        isFolderNode(n)
    );
}

/**
 * Handle /tdad node command
 */
export async function handleNodeCommand(
    args: string[],
    context: SlackMessageContext,
    ctx: NodeHandlerContext
): Promise<void> {
    if (args.length === 0) {
        await ctx.reply(context, '❌ Usage: `/tdad node <name>` or `/tdad node <name> desc|bdd|tests`');
        return;
    }

    const firstArg = args[0]?.toLowerCase();

    if (firstArg === 'create') {
        const nodeName = args.slice(1).join(' ');
        if (!nodeName) {
            await ctx.reply(context, '❌ Usage: `/tdad node create <name>`');
            return;
        }

        const newNode: Partial<Node> = {
            id: `node-${Date.now()}`,
            workflowId: 'default',
            nodeType: 'file',
            title: nodeName,
            description: `Created via Slack by <@${context.userId}>`,
            position: { x: 100, y: 100 }
        };

        ctx.deps.addNode(newNode);
        await ctx.reply(context, `✅ Created node: *${nodeName}*`);
        logger.log('SLACK-CMD', `Created node: ${nodeName}`);
        return;
    }

    const secondArg = args[1]?.toLowerCase();

    if (secondArg === 'desc') {
        const nodeName = args[0];
        const newDesc = args.slice(2).join(' ');
        await handleDescriptionCommand(nodeName, newDesc, context, ctx);
    } else if (secondArg === 'bdd') {
        const nodeName = args[0];
        await handleBddCommand(nodeName, context, ctx);
    } else if (secondArg === 'tests') {
        const nodeName = args[0];
        await handleTestStatusCommand(nodeName, context, ctx);
    } else {
        const nodeName = args.join(' ');
        await handleNodeDetailsCommand(nodeName, context, ctx);
    }
}

/**
 * Show node details
 */
async function handleNodeDetailsCommand(
    nodeName: string,
    context: SlackMessageContext,
    ctx: NodeHandlerContext
): Promise<void> {
    const node = findNodeByName(ctx.deps.getNodes(), nodeName);
    if (!node) {
        await ctx.reply(context, `❌ Node not found: *${nodeName}*`);
        return;
    }

    const statusEmoji = (node as any).status === 'passed' ? '✅' :
                       (node as any).status === 'failed' ? '❌' : '⚪';

    let message = `📦 *${node.title}* ${statusEmoji}\n`;
    message += `\n📝 *Description:* ${node.description || '_No description_'}\n`;
    message += `\n🆔 *ID:* \`${node.id}\``;

    const hasBdd = (node as any).bddSpecFile;
    message += `\n📋 *BDD:* ${hasBdd ? 'Yes' : 'No'}`;

    const hasTests = (node as any).testCodeFile;
    message += `\n🧪 *Tests:* ${hasTests ? 'Yes' : 'No'}`;

    message += `\n\n_Use \`/tdad node ${node.title} desc|bdd|tests\` to view/edit_`;

    await ctx.reply(context, message);
}

/**
 * Update or show node description
 */
async function handleDescriptionCommand(
    nodeName: string,
    newDesc: string,
    context: SlackMessageContext,
    ctx: NodeHandlerContext
): Promise<void> {
    const node = findNodeByName(ctx.deps.getNodes(), nodeName);
    if (!node) {
        await ctx.reply(context, `❌ Node not found: *${nodeName}*`);
        return;
    }

    if (!newDesc) {
        await ctx.reply(context, `📝 *${node.title}* description:\n\n${node.description || '_No description_'}`);
        return;
    }

    node.description = newDesc;
    ctx.deps.updateNode(node);
    await ctx.reply(context, `✅ Updated description for *${node.title}*`);
    logger.log('SLACK-CMD', `Updated description for ${node.title}`);
}

/**
 * Show BDD spec inline
 */
async function handleBddCommand(
    nodeName: string,
    context: SlackMessageContext,
    ctx: NodeHandlerContext
): Promise<void> {
    const node = findNodeByName(ctx.deps.getNodes(), nodeName);
    if (!node) {
        await ctx.reply(context, `❌ Node not found: *${nodeName}*`);
        return;
    }

    const currentBdd = await ctx.deps.getBddSpec(node.id);

    if (currentBdd) {
        const truncated = currentBdd.length > 2500 ? currentBdd.substring(0, 2500) + '\n...(truncated)' : currentBdd;
        await ctx.reply(context, `📋 *BDD Spec for ${node.title}*\n\`\`\`gherkin\n${truncated}\n\`\`\`\n\n_Use the UI to edit: \`/tdad nodes\` → select node → Edit BDD_`);
    } else {
        await ctx.reply(context, `📋 *BDD Spec for ${node.title}*\n_No BDD spec yet._\n\n_Use the UI to create: \`/tdad nodes\` → select node → Edit BDD_`);
    }
}

/**
 * Show test status for a node
 */
async function handleTestStatusCommand(
    nodeName: string,
    context: SlackMessageContext,
    ctx: NodeHandlerContext
): Promise<void> {
    const node = findNodeByName(ctx.deps.getNodes(), nodeName);
    if (!node) {
        await ctx.reply(context, `❌ Node not found: *${nodeName}*`);
        return;
    }

    const statusEmoji = (node as any).status === 'passed' ? '✅' :
                       (node as any).status === 'failed' ? '❌' : '⚪';

    let message = `🧪 *Tests for ${node.title}* ${statusEmoji}\n`;

    const hasTests = (node as any).testCodeFile;
    if (!hasTests) {
        message += '\n_No test file generated yet._';
        message += '\n\nUse `/tdad run ' + node.title + '` to generate tests.';
    } else {
        message += `\n📁 Test file: \`${(node as any).testCodeFile}\``;
        message += `\n📊 Status: ${(node as any).status || 'not_tested'}`;

        const lastResults = (node as any).lastTestResults;
        if (lastResults && Array.isArray(lastResults)) {
            const passed = lastResults.filter((r: any) => r.passed).length;
            const total = lastResults.length;
            message += `\n✅ Passed: ${passed}/${total}`;
        }
    }

    await ctx.reply(context, message);
}

/**
 * Handle /tdad test command
 */
export async function handleTestCommand(
    args: string[],
    context: SlackMessageContext,
    ctx: NodeHandlerContext
): Promise<void> {
    const nodeName = args.join(' ');
    if (!nodeName) {
        await ctx.reply(context, '❌ Usage: `/tdad test <node-name>`');
        return;
    }

    const node = findNodeByName(ctx.deps.getNodes(), nodeName);

    if (!node) {
        await ctx.reply(context, `❌ Node not found: *${nodeName}*`);
        return;
    }

    await ctx.reply(context, `🧪 Running tests for: *${node.title}*...`);
    await ctx.deps.runNodeTests(node.id);
}
