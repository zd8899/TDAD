import { Node, NodeStatus } from '../../shared/types';
import { logCanvas } from '../../shared/utils/Logger';
import { isPersistedNodeStatus } from '../../shared/utils/nodeStatusContract';
import { SimpleNodeManager } from './SimpleNodeManager';

interface StatusUpdateOptions {
    saveNow?: boolean;
    force?: boolean;
    reason?: string;
}

/**
 * NodeStatusService
 * Single writer for persisted canvas node.status values.
 */
export class NodeStatusService {
    constructor(private readonly nodeManager: SimpleNodeManager) {}

    setStatusOnNode(node: Node, status: NodeStatus): void {
        if (!isPersistedNodeStatus(status)) {
            logCanvas(`[NodeStatus] Ignored invalid status for ${node.id}: ${String(status)}`);
            return;
        }
        (node as any).status = status;
    }

    setStatusByNode(node: Node, status: NodeStatus, options: StatusUpdateOptions = {}): boolean {
        if (!isPersistedNodeStatus(status)) {
            logCanvas(`[NodeStatus] Ignored invalid status for ${node.id}: ${String(status)}`);
            return false;
        }

        const { saveNow = true, force = false, reason } = options;
        const currentStatus = (node as any).status as string | undefined;
        if (!force && currentStatus === status) {
            if (reason) {
                logCanvas(`[NodeStatus] ${node.id}: unchanged (${status}) (${reason})`);
            }
            return false;
        }

        (node as any).status = status;
        this.nodeManager.updateNode(node);
        if (saveNow) {
            this.nodeManager.saveNow();
        }

        if (reason) {
            logCanvas(`[NodeStatus] ${node.id}: ${currentStatus || 'undefined'} -> ${status} (${reason})`);
        } else {
            logCanvas(`[NodeStatus] ${node.id}: ${currentStatus || 'undefined'} -> ${status}`);
        }
        return true;
    }

    setStatusById(nodeId: string, status: NodeStatus, options: StatusUpdateOptions = {}): boolean {
        const node = this.nodeManager.getNodeById(nodeId);
        if (!node) {
            return false;
        }
        return this.setStatusByNode(node, status, options);
    }
}
