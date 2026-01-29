/**
 * SlackHomeTabBuilders - Dynamic Home Tab view builders for Slack
 */

import { Node } from '../../shared/types';
import { isFolderNode } from '../../shared/types/typeGuards';
import { AutomationStatus } from '../../shared/types/slack';
import { SlackBlock, getStatusEmoji, getStatusDot, isRootLevel } from './SlackBlockTypes';

/**
 * Build Home Tab Dashboard view - main view with status and quick access to nodes
 */
export function buildHomeTabDashboard(
    status: AutomationStatus,
    nodes: Node[]
): SlackBlock[] {
    const passedCount = nodes.filter(n => n.status === 'passed').length;
    const failedCount = nodes.filter(n => n.status === 'failed').length;
    const totalNodes = nodes.filter(n => !isFolderNode(n)).length;
    const pendingCount = totalNodes - passedCount - failedCount;

    const blocks: SlackBlock[] = [];

    // ===== HEADER =====
    blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: 'TDAD' }
    });

    // ===== STATUS BANNER (when running) =====
    if (status.status === 'running') {
        const currentNodeName = status.currentNodeId
            ? nodes.find(n => n.id === status.currentNodeId)?.title
            : undefined;

        let statusText = '*Running*';
        if (currentNodeName) statusText += ` · ${currentNodeName}`;
        if (status.phase) statusText += ` · ${status.phase}`;

        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: statusText },
            accessory: {
                type: 'button',
                text: { type: 'plain_text', text: 'Stop' },
                style: 'danger',
                action_id: 'tdad_home_stop',
                value: 'stop'
            }
        } as SlackBlock);

        if (status.message) {
            blocks.push({
                type: 'context',
                elements: [{ type: 'mrkdwn', text: status.message }]
            });
        }
    } else {
        blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `*${status.status.charAt(0).toUpperCase() + status.status.slice(1)}*` }]
        });
    }

    blocks.push({ type: 'divider' } as SlackBlock);

    // ===== 📂 NODES SECTION =====
    const rootItems = nodes.filter(n => isRootLevel(n.parentId));
    const folders = rootItems.filter(n => isFolderNode(n)).slice(0, 5);
    const fileNodes = rootItems.filter(n => !isFolderNode(n)).slice(0, 8);

    blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*📂 Nodes* · ${totalNodes} total · ${passedCount} passed · ${failedCount} failed` },
        accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Browse All' },
            action_id: 'tdad_home_browse',
            value: 'root'
        }
    } as SlackBlock);

    if (folders.length > 0) {
        blocks.push({
            type: 'actions',
            elements: folders.map(folder => ({
                type: 'button',
                text: { type: 'plain_text', text: folder.title.substring(0, 25) },
                action_id: `tdad_home_folder:${folder.id}`,
                value: folder.id
            }))
        });
    }

    if (fileNodes.length > 0) {
        for (let i = 0; i < fileNodes.length; i += 4) {
            const row = fileNodes.slice(i, i + 4);
            blocks.push({
                type: 'actions',
                elements: row.map(node => ({
                    type: 'button',
                    text: { type: 'plain_text', text: `${getStatusDot(node.status)} ${node.title}`.substring(0, 25) },
                    action_id: `tdad_home_node:${node.id}`,
                    value: node.id
                }))
            });
        }
    }

    blocks.push({ type: 'divider' } as SlackBlock);

    // ===== ⚡ ACTIONS =====
    blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*⚡ Actions*' }
    });

    blocks.push({
        type: 'actions',
        elements: [
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Start Autopilot' },
                style: 'primary',
                action_id: 'tdad_home_start_autopilot',
                value: 'start'
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Terminal' },
                action_id: 'tdad_cmd_cli',
                value: 'cli'
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Add Node' },
                action_id: 'tdad_home_add_node',
                value: 'root'
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Add Folder' },
                action_id: 'tdad_home_add_folder',
                value: 'root'
            }
        ]
    });

    return blocks;
}

/**
 * Build Home Tab Folder Browser view
 */
export function buildHomeTabFolderView(
    folderId: string | null,
    allNodes: Node[],
    status: AutomationStatus
): SlackBlock[] {
    const parent = folderId ? allNodes.find(n => n.id === folderId) : null;
    const title = parent ? parent.title : 'All Nodes';

    const children = allNodes.filter(n => {
        if (!folderId) {
            return isRootLevel(n.parentId);
        }
        return n.parentId === folderId;
    });

    const childFolders = children.filter(n => isFolderNode(n));
    const childNodes = children.filter(n => !isFolderNode(n));

    const countDescendants = (id: string): number => {
        let count = 0;
        const stack = [id];
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

    const blocks: SlackBlock[] = [
        {
            type: 'header',
            text: { type: 'plain_text', text: title }
        }
    ];

    // Navigation row
    const navElements: any[] = [];
    if (folderId) {
        const grandparent = parent?.parentId || null;
        navElements.push({
            type: 'button',
            text: { type: 'plain_text', text: 'Back' },
            action_id: 'tdad_home_back',
            value: grandparent || 'root'
        });
    }
    navElements.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Dashboard' },
        action_id: 'tdad_home_dashboard',
        value: 'dashboard'
    });

    blocks.push({ type: 'actions', elements: navElements });
    blocks.push({ type: 'divider' } as SlackBlock);

    if (childFolders.length === 0 && childNodes.length === 0) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '_No items in this folder_' }
        });
    }

    // 📁 Folders
    if (childFolders.length > 0) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '*📁 Folders*' }
        });

        for (let i = 0; i < childFolders.length; i += 4) {
            const group = childFolders.slice(i, i + 4);
            blocks.push({
                type: 'actions',
                elements: group.map(folder => ({
                    type: 'button',
                    text: { type: 'plain_text', text: `${folder.title} (${countDescendants(folder.id)})`.substring(0, 35) },
                    action_id: `tdad_home_folder:${folder.id}`,
                    value: folder.id
                }))
            });
        }
    }

    // 📄 Nodes
    if (childNodes.length > 0) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '*📄 Nodes*' }
        });

        for (let i = 0; i < childNodes.length; i += 4) {
            const group = childNodes.slice(i, i + 4);
            blocks.push({
                type: 'actions',
                elements: group.map(node => ({
                    type: 'button',
                    text: { type: 'plain_text', text: `${getStatusDot(node.status)} ${node.title}`.substring(0, 35) },
                    action_id: `tdad_home_node:${node.id}`,
                    value: node.id
                }))
            });
        }
    }

    // ⚡ Actions
    blocks.push({ type: 'divider' } as SlackBlock);
    blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*⚡ Actions*' }
    });
    blocks.push({
        type: 'actions',
        elements: [
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Run All' },
                style: 'primary',
                action_id: 'tdad_home_run_folder',
                value: folderId || 'all'
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Add Node' },
                action_id: 'tdad_home_add_node',
                value: folderId || 'root'
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Add Folder' },
                action_id: 'tdad_home_add_folder',
                value: folderId || 'root'
            }
        ]
    });

    return blocks;
}

/**
 * Build Home Tab Node Details view
 */
export function buildHomeTabNodeView(
    node: Node,
    hasPlan: boolean,
    status: AutomationStatus
): SlackBlock[] {
    const hasTests = !!node.testCodeFile;
    const isThisNodeRunning = status.status === 'running' && status.currentNodeId === node.id;

    const blocks: SlackBlock[] = [];

    // ===== HEADER =====
    const statusIndicator = node.status === 'passed' ? ' · passed' : node.status === 'failed' ? ' · failed' : '';
    blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: node.title }
    });

    // ===== RUNNING BANNER =====
    if (isThisNodeRunning) {
        let runningText = '*Running*';
        if (status.phase) runningText += ` · ${status.phase}`;

        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: runningText },
            accessory: {
                type: 'button',
                text: { type: 'plain_text', text: 'Stop' },
                style: 'danger',
                action_id: 'tdad_home_stop',
                value: 'stop'
            }
        } as SlackBlock);

        if (status.message) {
            blocks.push({
                type: 'context',
                elements: [{ type: 'mrkdwn', text: status.message }]
            });
        }
    }

    // ===== NAVIGATION =====
    blocks.push({
        type: 'actions',
        elements: [
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Back' },
                action_id: 'tdad_home_back_from_node',
                value: node.parentId || 'root'
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Dashboard' },
                action_id: 'tdad_home_dashboard',
                value: 'dashboard'
            }
        ]
    });

    blocks.push({ type: 'divider' } as SlackBlock);

    // ===== INFO =====
    blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: node.description || '_No description_' }
    });

    blocks.push({
        type: 'context',
        elements: [
            { type: 'mrkdwn', text: `Plan: ${hasPlan ? 'Yes' : 'No'} · Tests: ${hasTests ? 'Yes' : 'No'}${statusIndicator}` }
        ]
    });

    blocks.push({ type: 'divider' } as SlackBlock);

    // ===== 🤖 AUTOMATION =====
    blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*🤖 Automation*' }
    });

    blocks.push({
        type: 'actions',
        elements: [
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Run Full' },
                style: 'primary',
                action_id: 'tdad_home_run_full',
                value: node.id
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Plan' },
                action_id: 'tdad_home_auto_plan',
                value: node.id
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Test' },
                action_id: 'tdad_home_auto_test',
                value: node.id
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Run & Fix' },
                action_id: 'tdad_home_run_fix',
                value: node.id
            }
        ]
    });

    // ===== 🛠 Manual =====
    blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*🛠 Manual*' }
    });

    blocks.push({
        type: 'actions',
        elements: [
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Edit Plan' },
                action_id: 'tdad_home_edit_plan',
                value: node.id
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Run Tests' },
                action_id: 'tdad_home_run_tests',
                value: node.id
            }
        ]
    });

    // ===== TEST RESULTS =====
    if (node.lastTestResults && node.lastTestResults.length > 0) {
        const passed = node.lastTestResults.filter(r => r.passed).length;
        const total = node.lastTestResults.length;
        blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `Last run: ${passed}/${total} tests passed` }]
        });
    }

    return blocks;
}
