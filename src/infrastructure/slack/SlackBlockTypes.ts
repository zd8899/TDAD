/**
 * SlackBlockTypes - Shared types and utilities for Slack Block Kit
 */

import { Node } from '../../shared/types';

export interface SlackBlock {
    type: string;
    text?: { type: string; text: string };
    elements?: any[];
    block_id?: string;
    element?: any;
    label?: any;
    accessory?: any;
    fields?: { type: string; text: string }[];
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
 * Get status dot indicator for compact display
 */
export function getStatusDot(status: string | undefined): string {
    if (status === 'passed') return '🟢';
    if (status === 'failed') return '🔴';
    return '⚪';
}

/**
 * Helper to chunk array for button rows
 */
export function chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

/**
 * Check if node is at root level
 */
export function isRootLevel(parentId: string | undefined | null): boolean {
    return !parentId || parentId === 'root' || parentId === '';
}
