/**
 * SlackBlockBuilders - Block Kit UI builders for Slack messages
 * Extracted from SlackCommandHandler to reduce file size
 */

import { Node } from '../../shared/types';
import { isFolderNode } from '../../shared/types/typeGuards';

export interface SlackBlock {
    type: string;
    text?: { type: string; text: string };
    elements?: any[];
    block_id?: string;
    element?: any;
    label?: any;
}

/**
 * Build node details view with action buttons
 */
export function buildNodeDetailsBlocks(node: Node): SlackBlock[] {
    const statusEmoji = (node as any).status === 'passed' ? '✅' :
                       (node as any).status === 'failed' ? '❌' : '⚪';

    const hasBdd = (node as any).bddSpecFile;
    const hasTests = (node as any).testCodeFile;

    const detailsText = `📦 *${node.title}* ${statusEmoji}\n\n` +
        `📝 *Description:* ${node.description || '_No description_'}\n` +
        `📋 *BDD:* ${hasBdd ? 'Yes' : 'No'}\n` +
        `🧪 *Tests:* ${hasTests ? 'Yes' : 'No'}`;

    return [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: detailsText }
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '▶️ Run Node' },
                    style: 'primary',
                    action_id: 'tdad_run_node',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '📋 View BDD' },
                    action_id: 'tdad_view_bdd',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '🧪 View Tests' },
                    action_id: 'tdad_view_tests',
                    value: node.id
                }
            ]
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '⬅️ Back to Nodes' },
                    action_id: 'tdad_back_to_nodes',
                    value: 'back'
                }
            ]
        }
    ];
}

/**
 * Build BDD view with edit button
 */
export function buildBddViewBlocks(node: Node, currentBdd: string | null): SlackBlock[] {
    let bddText: string;
    if (currentBdd) {
        bddText = `📋 *BDD Spec for ${node.title}:*\n\`\`\`gherkin\n${currentBdd}\n\`\`\``;
    } else {
        bddText = `📋 *BDD Spec for ${node.title}:*\n_No BDD spec yet._`;
    }

    return [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: bddText.substring(0, 3000) } // Slack limit
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '✏️ Edit BDD' },
                    style: 'primary',
                    action_id: 'tdad_edit_bdd',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '▶️ Run Node' },
                    action_id: 'tdad_run_node',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '⬅️ Back' },
                    action_id: 'tdad_select_node',
                    value: node.id
                }
            ]
        }
    ];
}

/**
 * Build BDD edit modal view
 */
export function buildBddEditModal(node: Node, currentBdd: string | null): any {
    return {
        type: 'modal',
        callback_id: 'tdad_edit_bdd_modal',
        private_metadata: node.id,
        title: {
            type: 'plain_text',
            text: 'Edit BDD Spec'
        },
        submit: {
            type: 'plain_text',
            text: 'Save'
        },
        close: {
            type: 'plain_text',
            text: 'Cancel'
        },
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*${node.title}*\n${node.description || '_No description_'}`
                }
            },
            {
                type: 'input',
                block_id: 'bdd_block',
                element: {
                    type: 'plain_text_input',
                    action_id: 'bdd_input',
                    multiline: true,
                    initial_value: currentBdd || 'Feature: ' + node.title + '\n  As a user\n  I want to\n  So that\n\n  Scenario: \n    Given\n    When\n    Then',
                    placeholder: {
                        type: 'plain_text',
                        text: 'Enter Gherkin BDD spec...'
                    }
                },
                label: {
                    type: 'plain_text',
                    text: 'BDD Spec (Gherkin)'
                }
            }
        ]
    };
}

/**
 * Build test status view with action buttons
 */
export function buildTestStatusBlocks(node: Node): SlackBlock[] {
    const statusEmoji = (node as any).status === 'passed' ? '✅' :
                       (node as any).status === 'failed' ? '❌' : '⚪';

    let testText = `🧪 *Tests for ${node.title}* ${statusEmoji}\n\n`;

    const hasTests = (node as any).testCodeFile;
    if (!hasTests) {
        testText += '_No test file generated yet._';
    } else {
        testText += `📁 *Test file:* \`${(node as any).testCodeFile}\`\n`;
        testText += `📊 *Status:* ${(node as any).status || 'not_tested'}`;

        const lastResults = (node as any).lastTestResults;
        if (lastResults && Array.isArray(lastResults)) {
            const passed = lastResults.filter((r: any) => r.passed).length;
            const total = lastResults.length;
            testText += `\n✅ *Passed:* ${passed}/${total}`;
        }
    }

    return [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: testText }
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '🧪 Run Tests' },
                    style: 'primary',
                    action_id: 'tdad_run_tests',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '▶️ Run Full Automation' },
                    action_id: 'tdad_run_node',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '⬅️ Back' },
                    action_id: 'tdad_select_node',
                    value: node.id
                }
            ]
        }
    ];
}

/**
 * Build folder summary with run button
 */
export function buildFolderSummaryBlocks(folder: Node, childNodes: Node[]): SlackBlock[] {
    const passedCount = childNodes.filter(n => (n as any).status === 'passed').length;
    const failedCount = childNodes.filter(n => (n as any).status === 'failed').length;
    const pendingCount = childNodes.length - passedCount - failedCount;

    const folderText = `📁 *${folder.title}*\n\n` +
        `📊 *Nodes:* ${childNodes.length}\n` +
        `✅ Passed: ${passedCount}\n` +
        `❌ Failed: ${failedCount}\n` +
        `⚪ Pending: ${pendingCount}`;

    return [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: folderText }
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '▶️ Run All Nodes in Folder' },
                    style: 'primary',
                    action_id: 'tdad_run_folder',
                    value: folder.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '⬅️ Back to Nodes' },
                    action_id: 'tdad_back_to_nodes',
                    value: 'back'
                }
            ]
        }
    ];
}

/**
 * Build nodes list with folder buttons
 */
export function buildNodesListBlocks(folders: Node[]): SlackBlock[] {
    const folderList = folders.map(f => `📁 ${f.title}`).join('\n');

    const blocks: SlackBlock[] = [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Nodes*\n\n${folderList}` }
        }
    ];

    if (folders.length > 0) {
        blocks.push({
            type: 'actions',
            elements: folders.slice(0, 5).map((f, i) => ({
                type: 'button',
                text: { type: 'plain_text', text: f.title.substring(0, 24), emoji: true },
                action_id: `tdad_browse_folder_${i}`,
                value: f.id
            }))
        });
    }

    return blocks;
}

/**
 * Helper to chunk array for button rows
 */
function chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

/**
 * Build folder contents view with nested folders and nodes as buttons
 */
export function buildFolderContentsBlocks(
    parentId: string | undefined,
    parent: Node | null,
    childFolders: Node[],
    childNodes: Node[],
    countDescendants: (folderId: string) => number
): SlackBlock[] {
    const title = parent ? `📁 ${parent.title}` : '📋 All Nodes';

    if (childFolders.length === 0 && childNodes.length === 0) {
        return [
            {
                type: 'section',
                text: { type: 'mrkdwn', text: `${title}\n\n_Empty - no items here._` }
            }
        ];
    }

    const blocks: SlackBlock[] = [
        {
            type: 'header',
            text: { type: 'plain_text', text: title }
        }
    ];

    // Counter for unique action_ids
    let actionCounter = 0;

    // Add back button if not at root
    if (parentId) {
        const grandparent = parent?.parentId || 'root';
        blocks.push({
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '⬅️ Back' },
                    action_id: 'tdad_back_btn',
                    value: grandparent
                }
            ]
        });
    }

    // Show child folders as buttons (max 5 per row)
    if (childFolders.length > 0) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '*📁 Folders:*' }
        });

        const folderChunks = chunk(childFolders, 5);
        for (const folderGroup of folderChunks) {
            blocks.push({
                type: 'actions',
                elements: folderGroup.map(folder => {
                    const nodeCount = countDescendants(folder.id);
                    return {
                        type: 'button',
                        text: { type: 'plain_text', text: `📁 ${folder.title} (${nodeCount})`.substring(0, 75) },
                        action_id: `tdad_browse_folder_${actionCounter++}`,
                        value: folder.id
                    };
                })
            });
        }
    }

    // Show child nodes as buttons (max 5 per row)
    if (childNodes.length > 0) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '*📦 Nodes:*' }
        });

        const nodeChunks = chunk(childNodes, 5);
        for (const nodeGroup of nodeChunks) {
            blocks.push({
                type: 'actions',
                elements: nodeGroup.map(node => {
                    const statusEmoji = (node as any).status === 'passed' ? '✅' :
                                       (node as any).status === 'failed' ? '❌' : '⚪';
                    return {
                        type: 'button',
                        text: { type: 'plain_text', text: `${statusEmoji} ${node.title}`.substring(0, 75) },
                        action_id: `tdad_select_node_${actionCounter++}`,
                        value: node.id
                    };
                })
            });
        }
    }

    // Add Run button at bottom
    blocks.push({ type: 'divider' } as SlackBlock);
    blocks.push({
        type: 'actions',
        elements: [
            {
                type: 'button',
                text: { type: 'plain_text', text: parentId ? '▶️ Run This Folder' : '🚀 Run All Nodes' },
                style: 'primary',
                action_id: 'tdad_run_folder',
                value: parentId || 'all'
            }
        ]
    });

    return blocks;
}

/**
 * Get status emoji for node
 */
export function getStatusEmoji(status: string | undefined): string {
    if (status === 'passed') return '✅';
    if (status === 'failed') return '❌';
    return '⚪';
}

/**
 * Build help text
 */
export function getHelpText(): string {
    return `*TDAD Slack Commands:*

📋 *Main Commands (Click-based UI):*
\`/tdad nodes\` - Show all nodes with interactive buttons
  • Select node from dropdown → View details with action buttons
  • Select folder → Run all nodes in folder
  • Click buttons: Run, View BDD, View Tests, Edit BDD

🚀 *Quick Commands:*
\`/tdad status\` - Quick automation status
\`/tdad progress\` - Detailed progress with completed/failed nodes
\`/tdad autopilot start/stop\` - Full multi-node automation

💬 *CLI Interaction:*
\`/tdad cli\` - Show recent CLI output
\`/tdad say <message>\` - Send message to CLI terminal
\`/tdad stop\` - Stop current operation (Ctrl+C)

📝 *Text Commands (optional):*
\`/tdad node create <name>\` - Create new node

❓ \`/tdad help\` - Show this help

_💡 Tip: Just type \`/tdad nodes\` and click!_`;
}
