/**
 * SlackModalBuilders - Modal builders for Slack Block Kit
 */

import { Node } from '../../shared/types';
import { SlackBlock, getStatusEmoji, chunk } from './SlackBlockTypes';
import {
    featureFormFields,
    testLayerOptions,
    testLayersToValue,
    formTitles,
    buttonLabels
} from '../../shared/config/featureFormConfig';

/**
 * Build Plan edit modal view
 */
export function buildPlanEditModal(node: Node, currentPlan: string | null, channelId?: string): any {
    const metadata = JSON.stringify({ nodeId: node.id, channelId: channelId || '' });
    return {
        type: 'modal',
        callback_id: 'tdad_edit_plan_modal',
        private_metadata: metadata,
        title: {
            type: 'plain_text',
            text: 'Edit Plan'
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
                block_id: 'plan_block',
                element: {
                    type: 'plain_text_input',
                    action_id: 'plan_input',
                    multiline: true,
                    initial_value: currentPlan || 'Feature: ' + node.title + '\n  As a user\n  I want to\n  So that\n\n  Scenario: \n    Given\n    When\n    Then',
                    placeholder: {
                        type: 'plain_text',
                        text: 'Enter Gherkin plan...'
                    }
                },
                label: {
                    type: 'plain_text',
                    text: 'Plan (Gherkin)'
                }
            }
        ]
    };
}

/**
 * Build Add Node modal view
 */
export function buildAddNodeModal(channelId?: string, parentId?: string): any {
    const metadata = JSON.stringify({ channelId: channelId || '', parentId: parentId || '' });
    return {
        type: 'modal',
        callback_id: 'tdad_add_node_modal',
        private_metadata: metadata,
        title: {
            type: 'plain_text',
            text: 'Add Node'
        },
        submit: {
            type: 'plain_text',
            text: 'Create'
        },
        close: {
            type: 'plain_text',
            text: 'Cancel'
        },
        blocks: [
            {
                type: 'input',
                block_id: 'node_name_block',
                element: {
                    type: 'plain_text_input',
                    action_id: 'node_name_input',
                    placeholder: {
                        type: 'plain_text',
                        text: 'Enter node name...'
                    }
                },
                label: {
                    type: 'plain_text',
                    text: 'Node Name'
                }
            },
            {
                type: 'input',
                block_id: 'node_description_block',
                optional: true,
                element: {
                    type: 'plain_text_input',
                    action_id: 'node_description_input',
                    multiline: true,
                    placeholder: {
                        type: 'plain_text',
                        text: 'Enter node description (optional)...'
                    }
                },
                label: {
                    type: 'plain_text',
                    text: 'Description'
                }
            }
        ]
    };
}

/**
 * Build Edit Feature modal view - matches canvas NodeForm.tsx
 * Uses shared config from featureFormConfig.ts
 */
export function buildEditFeatureModal(node: Node, channelId?: string): any {
    const metadata = JSON.stringify({ nodeId: node.id, channelId: channelId || '' });
    const currentTestLayerValue = testLayersToValue((node as any).testLayers);

    // Build test layer options for Slack static_select
    const testLayerSelectOptions = testLayerOptions.map(opt => ({
        text: { type: 'plain_text' as const, text: opt.slackLabel },
        value: opt.value
    }));

    // Find initial option
    const initialTestLayerOption = testLayerSelectOptions.find(opt => opt.value === currentTestLayerValue)
        || testLayerSelectOptions[0];

    const blocks: any[] = [
        // Feature Name
        {
            type: 'input',
            block_id: 'feature_name_block',
            element: {
                type: 'plain_text_input',
                action_id: 'feature_name_input',
                initial_value: node.title || '',
                placeholder: {
                    type: 'plain_text',
                    text: featureFormFields.title.placeholder
                }
            },
            label: {
                type: 'plain_text',
                text: featureFormFields.title.label + ' *'
            }
        },
        // Feature Description
        {
            type: 'input',
            block_id: 'feature_description_block',
            optional: true,
            element: {
                type: 'plain_text_input',
                action_id: 'feature_description_input',
                multiline: true,
                initial_value: node.description || '',
                placeholder: {
                    type: 'plain_text',
                    text: 'Describe what this feature should accomplish...'
                }
            },
            label: {
                type: 'plain_text',
                text: featureFormFields.description.label
            },
            hint: {
                type: 'plain_text',
                text: featureFormFields.description.hint || ''
            }
        },
        // Test Layers
        {
            type: 'input',
            block_id: 'test_layers_block',
            optional: true,
            element: {
                type: 'static_select',
                action_id: 'test_layers_input',
                initial_option: initialTestLayerOption,
                options: testLayerSelectOptions
            },
            label: {
                type: 'plain_text',
                text: featureFormFields.testLayers.label
            },
            hint: {
                type: 'plain_text',
                text: featureFormFields.testLayers.hint || ''
            }
        }
    ];

    // Show context files as read-only info (can't pick files from Slack)
    const contextFiles = (node as any).contextFiles || [];
    if (contextFiles.length > 0) {
        const fileList = contextFiles.map((f: string) => {
            const parts = f.split(/[/\\]/);
            return parts[parts.length - 1] || f;
        }).join(', ');

        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*${featureFormFields.contextFiles.label}:* ${fileList}\n_Edit context files from the VS Code canvas_`
            }
        });
    }

    return {
        type: 'modal',
        callback_id: 'tdad_edit_feature_modal',
        private_metadata: metadata,
        title: {
            type: 'plain_text',
            text: formTitles.editFeature
        },
        submit: {
            type: 'plain_text',
            text: buttonLabels.save
        },
        close: {
            type: 'plain_text',
            text: buttonLabels.cancel
        },
        blocks
    };
}

/**
 * Build Add Folder modal view
 */
export function buildAddFolderModal(channelId?: string, parentId?: string): any {
    const metadata = JSON.stringify({ channelId: channelId || '', parentId: parentId || '' });
    return {
        type: 'modal',
        callback_id: 'tdad_add_folder_modal',
        private_metadata: metadata,
        title: {
            type: 'plain_text',
            text: 'Add Folder'
        },
        submit: {
            type: 'plain_text',
            text: 'Create'
        },
        close: {
            type: 'plain_text',
            text: 'Cancel'
        },
        blocks: [
            {
                type: 'input',
                block_id: 'folder_name_block',
                element: {
                    type: 'plain_text_input',
                    action_id: 'folder_name_input',
                    placeholder: {
                        type: 'plain_text',
                        text: 'Enter folder name...'
                    }
                },
                label: {
                    type: 'plain_text',
                    text: 'Folder Name'
                }
            }
        ]
    };
}

/**
 * Build Auto-Generate Plan modal view
 */
export function buildAutoGeneratePlanModal(node: Node, channelId?: string): any {
    const metadata = JSON.stringify({ nodeId: node.id, channelId: channelId || '' });
    return {
        type: 'modal',
        callback_id: 'tdad_auto_generate_plan_modal',
        private_metadata: metadata,
        title: {
            type: 'plain_text',
            text: 'Auto-Generate Plan'
        },
        submit: {
            type: 'plain_text',
            text: 'Generate'
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
                    text: `*${node.title}*\n\n_Update the description below, then click Generate to auto-create a Plan using AI._`
                }
            },
            {
                type: 'input',
                block_id: 'description_block',
                element: {
                    type: 'plain_text_input',
                    action_id: 'description_input',
                    multiline: true,
                    initial_value: node.description || '',
                    placeholder: {
                        type: 'plain_text',
                        text: 'Describe what this node should do...'
                    }
                },
                label: {
                    type: 'plain_text',
                    text: 'Node Description'
                }
            }
        ]
    };
}

/**
 * Build Auto-Generate Tests modal view
 */
export function buildAutoGenerateTestsModal(node: Node, channelId?: string): any {
    const metadata = JSON.stringify({ nodeId: node.id, channelId: channelId || '' });
    return {
        type: 'modal',
        callback_id: 'tdad_auto_generate_tests_modal',
        private_metadata: metadata,
        title: {
            type: 'plain_text',
            text: 'Auto-Generate Tests'
        },
        submit: {
            type: 'plain_text',
            text: 'Generate'
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
                    text: `*${node.title}*\n\n_Update the description below, then click Generate to auto-create Tests using AI._`
                }
            },
            {
                type: 'input',
                block_id: 'description_block',
                element: {
                    type: 'plain_text_input',
                    action_id: 'description_input',
                    multiline: true,
                    initial_value: node.description || '',
                    placeholder: {
                        type: 'plain_text',
                        text: 'Describe what this node should do...'
                    }
                },
                label: {
                    type: 'plain_text',
                    text: 'Node Description'
                }
            }
        ]
    };
}

/**
 * Build Terminal modal
 */
export function buildTerminalModal(channelId: string, output: string): any {
    const metadata = JSON.stringify({ channelId: channelId || '' });
    const maxOutputLength = 2500;
    const displayOutput = output.length > maxOutputLength
        ? '...\n' + output.substring(output.length - maxOutputLength)
        : output;

    return {
        type: 'modal',
        callback_id: 'tdad_terminal_modal',
        private_metadata: metadata,
        title: {
            type: 'plain_text',
            text: 'Terminal'
        },
        submit: {
            type: 'plain_text',
            text: 'Send'
        },
        close: {
            type: 'plain_text',
            text: 'Close'
        },
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `\`\`\`\n${displayOutput || 'No output yet. Click Refresh to capture.'}\n\`\`\``
                }
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: { type: 'plain_text', text: 'Refresh' },
                        action_id: 'tdad_terminal_refresh',
                        value: 'refresh'
                    },
                    {
                        type: 'button',
                        text: { type: 'plain_text', text: 'Stop Agent' },
                        action_id: 'tdad_terminal_stop',
                        value: 'stop',
                        style: 'danger'
                    }
                ]
            },
            {
                type: 'divider'
            },
            {
                type: 'input',
                block_id: 'message_block',
                element: {
                    type: 'plain_text_input',
                    action_id: 'message_input',
                    multiline: true,
                    placeholder: {
                        type: 'plain_text',
                        text: 'Type message to send to the agent...'
                    }
                },
                label: {
                    type: 'plain_text',
                    text: 'Send Message'
                },
                optional: true
            }
        ]
    };
}

/**
 * Build Run Options modal
 */
export function buildRunOptionsModal(targetId: string, targetName: string, isFolder: boolean, channelId?: string): any {
    const metadata = JSON.stringify({ targetId, isFolder, channelId: channelId || '' });
    const title = isFolder ? (targetId === 'all' ? 'Run All Nodes' : 'Run Folder') : 'Run Node';

    return {
        type: 'modal',
        callback_id: 'tdad_run_options_modal',
        private_metadata: metadata,
        title: {
            type: 'plain_text',
            text: title
        },
        submit: {
            type: 'plain_text',
            text: 'Run'
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
                    text: `*${targetName}*\n\n_Select which phases to run:_`
                }
            },
            {
                type: 'input',
                block_id: 'modes_block',
                element: {
                    type: 'checkboxes',
                    action_id: 'modes_input',
                    initial_options: [
                        {
                            text: { type: 'plain_text', text: '📋 Plan' },
                            value: 'bdd',
                            description: { type: 'plain_text', text: 'Generate plans from descriptions' }
                        },
                        {
                            text: { type: 'plain_text', text: '🧪 Test' },
                            value: 'test',
                            description: { type: 'plain_text', text: 'Generate tests from plans' }
                        },
                        {
                            text: { type: 'plain_text', text: '🔄 Run+Fix' },
                            value: 'run-fix',
                            description: { type: 'plain_text', text: 'Run tests and auto-fix failures' }
                        }
                    ],
                    options: [
                        {
                            text: { type: 'plain_text', text: '📋 Plan' },
                            value: 'bdd',
                            description: { type: 'plain_text', text: 'Generate plans from descriptions' }
                        },
                        {
                            text: { type: 'plain_text', text: '🧪 Test' },
                            value: 'test',
                            description: { type: 'plain_text', text: 'Generate tests from plans' }
                        },
                        {
                            text: { type: 'plain_text', text: '🔄 Run+Fix' },
                            value: 'run-fix',
                            description: { type: 'plain_text', text: 'Run tests and auto-fix failures' }
                        }
                    ]
                },
                label: {
                    type: 'plain_text',
                    text: 'Phases'
                }
            }
        ]
    };
}

/**
 * Build Nodes Browser modal - for Home tab navigation
 */
export function buildNodesBrowserModal(
    parentId: string | undefined,
    parent: Node | null,
    childFolders: Node[],
    childNodes: Node[],
    countDescendants: (folderId: string) => number
): any {
    const title = parent ? parent.title : 'All Nodes';
    const displayTitle = title.length > 24 ? title.substring(0, 21) + '...' : title;

    const blocks: any[] = [];

    if (parentId) {
        const grandparent = parent?.parentId || 'root';
        blocks.push({
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '← Back' },
                    action_id: 'tdad_modal_back',
                    value: grandparent
                }
            ]
        });
    }

    if (childFolders.length === 0 && childNodes.length === 0) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '_Empty - no items here._' }
        });
    } else {
        if (childFolders.length > 0) {
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: '*Folders*' }
            });

            for (let i = 0; i < childFolders.length; i += 3) {
                const folderGroup = childFolders.slice(i, i + 3);
                blocks.push({
                    type: 'actions',
                    elements: folderGroup.map(folder => ({
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: `📁 ${folder.title} (${countDescendants(folder.id)})`
                        },
                        action_id: `tdad_modal_folder:${folder.id}`,
                        value: folder.id
                    }))
                });
            }
        }

        if (childNodes.length > 0) {
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: '*Nodes*' }
            });

            for (let i = 0; i < childNodes.length; i += 2) {
                const nodeGroup = childNodes.slice(i, i + 2);
                blocks.push({
                    type: 'actions',
                    elements: nodeGroup.map(node => ({
                        type: 'button',
                        text: {
                            type: 'plain_text',
                            text: `${getStatusEmoji(node.status)} ${node.title}`
                        },
                        action_id: `tdad_modal_node:${node.id}`,
                        value: node.id
                    }))
                });
            }
        }
    }

    blocks.push({ type: 'divider' });
    blocks.push({
        type: 'actions',
        elements: [
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Run All' },
                style: 'primary',
                action_id: 'tdad_modal_run_folder',
                value: parentId || 'all'
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Add Node' },
                action_id: 'tdad_modal_add_node',
                value: parentId || 'root'
            },
            {
                type: 'button',
                text: { type: 'plain_text', text: 'Add Folder' },
                action_id: 'tdad_modal_add_folder',
                value: parentId || 'root'
            }
        ]
    });

    const metadata = JSON.stringify({ parentId: parentId || '' });

    return {
        type: 'modal',
        callback_id: 'tdad_nodes_browser_modal',
        private_metadata: metadata,
        title: {
            type: 'plain_text',
            text: displayTitle
        },
        close: {
            type: 'plain_text',
            text: 'Close'
        },
        blocks
    };
}

/**
 * Build Node Details modal - for Home tab node viewing
 */
export function buildNodeDetailsModal(node: Node, hasPlan?: boolean): any {
    const statusEmoji = getStatusEmoji(node.status);
    const planExists = hasPlan ?? !!node.planFile;
    const hasTests = node.testCodeFile;
    const displayTitle = node.title.length > 24 ? node.title.substring(0, 21) + '...' : node.title;

    const blocks: any[] = [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*${node.title}* ${statusEmoji}\n\n` +
                    `${node.description || '_No description_'}\n\n` +
                    `Plan: ${planExists ? '✅' : '❌'}  |  Tests: ${hasTests ? '✅' : '❌'}`
            }
        },
        { type: 'divider' },
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
                    action_id: 'tdad_modal_auto_plan',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Test' },
                    action_id: 'tdad_modal_auto_test',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Run & Fix' },
                    action_id: 'tdad_modal_run_fix',
                    value: node.id
                }
            ]
        },
        { type: 'divider' },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Edit Plan' },
                    action_id: 'tdad_modal_edit_plan',
                    value: node.id
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'View Tests' },
                    action_id: 'tdad_modal_view_tests',
                    value: node.id
                }
            ]
        }
    ];

    const metadata = JSON.stringify({ nodeId: node.id, parentId: node.parentId || '' });

    return {
        type: 'modal',
        callback_id: 'tdad_node_details_modal',
        private_metadata: metadata,
        title: {
            type: 'plain_text',
            text: displayTitle
        },
        close: {
            type: 'plain_text',
            text: 'Close'
        },
        blocks
    };
}
