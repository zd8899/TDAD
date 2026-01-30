/**
 * SlackViewBuilders - View/block builders for Slack messages
 */

import { Node } from '../../shared/types';
import { SlackBlock, getStatusEmoji, chunk } from './SlackBlockTypes';

/**
 * Build node details view with action buttons
 */
export function buildNodeDetailsBlocks(node: Node, hasPlan?: boolean): SlackBlock[] {
    const statusEmoji = getStatusEmoji(node.status);
    const planExists = hasPlan ?? !!node.planFile;
    const hasTests = node.testCodeFile;

    const detailsText = `*${node.title}* ${statusEmoji}\n\n` +
        `${node.description || '_No description_'}\n\n` +
        `Plan: ${planExists ? 'Yes' : 'No'}  |  Tests: ${hasTests ? 'Yes' : 'No'}`;

    return [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: detailsText }
        },
        {
            type: 'section',
            text: { type: 'mrkdwn', text: '*🤖 Auto-Pilot*' }
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Plan' },
                    action_id: 'tdad_auto_generate_plan',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Test' },
                    action_id: 'tdad_auto_generate_tests',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Run & Fix' },
                    action_id: 'tdad_run_and_fix',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Full' },
                    action_id: 'tdad_run_node',
                    value: node.id
                }
            ]
        },
        {
            type: 'section',
            text: { type: 'mrkdwn', text: '*Plan*' }
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Edit Plan' },
                    action_id: 'tdad_edit_plan',
                    value: node.id
                }
            ]
        },
        {
            type: 'section',
            text: { type: 'mrkdwn', text: '*Test*' }
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Edit Action' },
                    action_id: 'tdad_edit_action',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Edit Test' },
                    action_id: 'tdad_edit_test',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Run Tests' },
                    action_id: 'tdad_run_tests',
                    value: node.id
                }
            ]
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Back' },
                    action_id: 'tdad_back_to_nodes',
                    value: 'back'
                }
            ]
        }
    ];
}

/**
 * Build Plan view with edit button
 */
export function buildPlanViewBlocks(node: Node, currentPlan: string | null): SlackBlock[] {
    let planText: string;
    if (currentPlan) {
        planText = `*Plan for ${node.title}:*\n\`\`\`gherkin\n${currentPlan}\n\`\`\``;
    } else {
        planText = `*Plan for ${node.title}:*\n_No plan yet._`;
    }

    return [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: planText.substring(0, 3000) }
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Edit Plan' },
                    action_id: 'tdad_edit_plan',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Back' },
                    action_id: 'tdad_select_node',
                    value: node.id
                }
            ]
        }
    ];
}

/**
 * Build test status view with action buttons
 */
export function buildTestStatusBlocks(node: Node): SlackBlock[] {
    const statusEmoji = getStatusEmoji(node.status);
    let testText = `*Tests for ${node.title}* ${statusEmoji}\n\n`;

    const hasTests = node.testCodeFile;
    if (!hasTests) {
        testText += '_No test file generated yet._';
    } else {
        testText += `Test file: \`${node.testCodeFile}\`\n`;
        testText += `Status: ${node.status || 'not_tested'}`;

        const lastResults = node.lastTestResults;
        if (lastResults && Array.isArray(lastResults)) {
            const passed = lastResults.filter((r: any) => r.passed).length;
            const total = lastResults.length;
            testText += `\nPassed: ${passed}/${total}`;
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
                    text: { type: 'plain_text', text: 'Run Tests' },
                    action_id: 'tdad_run_tests',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Back' },
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

    const folderText = `*📁 ${folder.title}*\n\n` +
        `Nodes: ${childNodes.length}\n` +
        `Passed: ${passedCount}  |  Failed: ${failedCount}  |  Pending: ${pendingCount}`;

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
                    text: { type: 'plain_text', text: 'Run All' },
                    action_id: 'tdad_run_folder',
                    value: folder.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Back' },
                    action_id: 'tdad_back_to_nodes',
                    value: 'back'
                }
            ]
        }
    ];
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

    if (parentId) {
        const grandparent = parent?.parentId || 'root';
        blocks.push({
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Back' },
                    action_id: 'tdad_back_btn',
                    value: grandparent
                }
            ]
        });
    }

    if (childFolders.length > 0) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '*Folders*' }
        });

        const folderChunks = chunk(childFolders, 5);
        for (const folderGroup of folderChunks) {
            blocks.push({
                type: 'actions',
                elements: folderGroup.map(folder => {
                    const nodeCount = countDescendants(folder.id);
                    return {
                        type: 'button',
                        text: { type: 'plain_text', text: `${folder.title} (${nodeCount})`.substring(0, 75) },
                        action_id: `tdad_browse_folder:${folder.id}`,
                        value: folder.id
                    };
                })
            });
        }
    }

    if (childNodes.length > 0) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '*Nodes*' }
        });

        const nodeChunks = chunk(childNodes, 5);
        for (const nodeGroup of nodeChunks) {
            blocks.push({
                type: 'actions',
                elements: nodeGroup.map(node => {
                    const statusEmoji = getStatusEmoji(node.status);
                    return {
                        type: 'button',
                        text: { type: 'plain_text', text: `${statusEmoji} ${node.title}`.substring(0, 75) },
                        action_id: `tdad_select_node:${node.id}`,
                        value: node.id
                    };
                })
            });
        }
    }

    blocks.push({ type: 'divider' } as SlackBlock);
    const bottomElements: any[] = [
        {
            type: 'button',
            text: { type: 'plain_text', text: parentId ? 'Run Folder' : 'Run All' },
            action_id: 'tdad_run_folder',
            value: parentId || 'all'
        },
        {
            type: 'button',
            text: { type: 'plain_text', text: 'Add Node' },
            action_id: 'tdad_add_node',
            value: parentId || 'root'
        },
        {
            type: 'button',
            text: { type: 'plain_text', text: 'Add Folder' },
            action_id: 'tdad_add_folder',
            value: parentId || 'root'
        }
    ];

    if (!parentId) {
        bottomElements.push({
            type: 'button',
            text: { type: 'plain_text', text: 'Home' },
            action_id: 'tdad_cmd_help',
            value: 'help'
        });
    }

    blocks.push({
        type: 'actions',
        elements: bottomElements
    });

    return blocks;
}

/**
 * Build status view with navigation buttons
 */
export function buildStatusBlocks(
    statusEmoji: string,
    status: string,
    currentNodeTitle?: string,
    phase?: string,
    message?: string
): SlackBlock[] {
    let statusText = `${statusEmoji} *Status:* ${status}`;
    if (currentNodeTitle) {
        statusText += `\nCurrent: ${currentNodeTitle}`;
    }
    if (phase) {
        statusText += `\nPhase: ${phase}`;
    }
    if (message) {
        statusText += `\n${message}`;
    }

    return [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: statusText }
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Refresh' },
                    action_id: 'tdad_cmd_status',
                    value: 'status'
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Home' },
                    action_id: 'tdad_cmd_help',
                    value: 'help'
                }
            ]
        }
    ];
}

/**
 * Build progress view with navigation buttons
 */
export function buildProgressBlocks(
    statusEmoji: string,
    status: string,
    currentNodeTitle?: string,
    phase?: string,
    retry?: { current: number; max: number },
    processedNodes?: string[],
    failedNodes?: string[],
    message?: string
): SlackBlock[] {
    let progressText = `${statusEmoji} *Automation Progress*\n`;
    progressText += `\nStatus: ${status}`;

    if (currentNodeTitle) {
        progressText += `\nCurrent: ${currentNodeTitle}`;
    }
    if (phase) {
        progressText += `\nPhase: ${phase}`;
    }
    if (retry) {
        progressText += `\nRetry: ${retry.current}/${retry.max}`;
    }
    if (processedNodes && processedNodes.length > 0) {
        const displayedNodes = processedNodes.slice(-5);
        progressText += `\n\n*Completed (${processedNodes.length}):*`;
        displayedNodes.forEach(name => {
            progressText += `\n  • ${name}`;
        });
        if (processedNodes.length > 5) {
            progressText += `\n  _...and ${processedNodes.length - 5} more_`;
        }
    }
    if (failedNodes && failedNodes.length > 0) {
        progressText += `\n\n*Failed (${failedNodes.length}):*`;
        failedNodes.forEach(name => {
            progressText += `\n  • ${name}`;
        });
    }
    if (message) {
        progressText += `\n\n${message}`;
    }

    return [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: progressText }
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Refresh' },
                    action_id: 'tdad_cmd_progress',
                    value: 'progress'
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Home' },
                    action_id: 'tdad_cmd_help',
                    value: 'help'
                }
            ]
        }
    ];
}

/**
 * Build edit file response with back to node button
 */
export function buildEditFileBlocks(nodeId: string, nodeTitle: string, fileType: 'action' | 'test', filePath: string | null): SlackBlock[] {
    let fileText: string;
    if (filePath) {
        fileText = `*${fileType === 'action' ? 'Action' : 'Test'} file for ${nodeTitle}:*\n\`${filePath}\`\n\n_Open this file in VS Code to edit the ${fileType === 'action' ? 'implementation' : 'tests'}._`;
    } else {
        fileText = `*${nodeTitle}*\n\n_No ${fileType} file generated yet. Run Auto-Pilot ${fileType === 'action' ? '' : 'Test '}to generate ${fileType === 'action' ? 'implementation' : 'tests'}._`;
    }

    return [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: fileText }
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Back' },
                    action_id: 'tdad_select_node',
                    value: nodeId
                }
            ]
        }
    ];
}

/**
 * Build Home Tab blocks - persistent dashboard (legacy)
 */
export function buildHomeTabBlocks(
    status: { status: string; phase?: string; currentNodeId?: string; message?: string },
    nodes: Node[],
    passedCount: number,
    failedCount: number
): SlackBlock[] {
    const statusEmoji = getStatusEmoji(status.status);
    const totalNodes = nodes.length;
    const pendingCount = totalNodes - passedCount - failedCount;

    const blocks: SlackBlock[] = [
        {
            type: 'header',
            text: { type: 'plain_text', text: '🚀 TDAD Canvas Dashboard' }
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*Status:* ${statusEmoji} ${status.status.toUpperCase()}\n` +
                      `*Phase:* ${status.phase || 'Idle'}\n` +
                      (status.message ? `*Message:* ${status.message}` : '')
            }
        },
        { type: 'divider' } as SlackBlock,
    ];

    blocks.push({
        type: 'section',
        fields: [
            { type: 'mrkdwn', text: `*Total Nodes:*\n${totalNodes}` },
            { type: 'mrkdwn', text: `*Passed:*\n✅ ${passedCount}` },
            { type: 'mrkdwn', text: `*Failed:*\n❌ ${failedCount}` },
            { type: 'mrkdwn', text: `*Pending:*\n⏳ ${pendingCount}` }
        ]
    });

    blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*Quick Actions*' }
    });

    blocks.push({
        type: 'actions',
        elements: [
            {
                type: 'button',
                text: { type: 'plain_text', text: '▶ Start Autopilot' },
                style: 'primary',
                action_id: 'tdad_cmd_autopilot_start',
                value: 'autopilot_start'
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: '⏹ Stop' },
                style: 'danger',
                action_id: 'tdad_cmd_autopilot_stop',
                value: 'autopilot_stop'
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: '🖥 Terminal' },
                action_id: 'tdad_cmd_cli',
                value: 'cli'
            }
        ]
    });

    blocks.push({
        type: 'context',
        elements: [
            { type: 'mrkdwn', text: '💡 _Use `/tdad` in a channel for full node browsing experience_' }
        ]
    });

    blocks.push({
        type: 'section',
        text: {
            type: 'mrkdwn',
            text: '*Development Environment*'
        },
        accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Open VS Code ↗' },
            url: 'vscode://tdad.tdad/open',
            action_id: 'tdad_open_vscode'
        }
    } as SlackBlock);

    blocks.push({ type: 'divider' } as SlackBlock);

    if (status.currentNodeId) {
        const activeNode = nodes.find(n => n.id === status.currentNodeId);
        if (activeNode) {
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: `*Currently Running:* \n📂 *${activeNode.title}*` }
            });
            blocks.push({
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: { type: 'plain_text', text: 'View Details' },
                        action_id: 'tdad_select_node',
                        value: activeNode.id
                    }
                ]
            });
        }
    } else {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '_No active task running._' }
        });
    }

    blocks.push({
        type: 'context',
        elements: [
            { type: 'mrkdwn', text: 'Updates automatically based on agent activity.' }
        ]
    });

    return blocks;
}
