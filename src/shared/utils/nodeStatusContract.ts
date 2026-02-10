import { NodeStatus } from '../types';

export const PERSISTED_NODE_STATUSES: ReadonlyArray<NodeStatus> = [
    'pending',
    'planned',
    'ready-for-implementation',
    'passed',
    'failed'
];

export function isPersistedNodeStatus(status: unknown): status is NodeStatus {
    return typeof status === 'string' && (PERSISTED_NODE_STATUSES as readonly string[]).includes(status);
}

