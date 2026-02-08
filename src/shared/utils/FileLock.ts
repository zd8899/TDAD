import * as fs from 'fs';
import * as path from 'path';
import { logger } from './Logger';

/**
 * File-based lock for cross-process synchronization
 * Ensures only one test process runs at a time, even across multiple terminals/processes
 *
 * Features:
 * - Cross-process safe using atomic file operations
 * - Stale lock detection (checks if process still exists)
 * - Automatic lock cleanup on exit
 * - Configurable timeout and retry behavior
 */
export class FileLock {
    private lockFile: string;
    private lockAcquired = false;
    private processId: number;
    private checkInterval = 100; // ms - how often to check for lock availability
    private staleThreshold = 300000; // ms - 5 minutes, after which a lock is considered stale

    constructor(lockFilePath: string) {
        this.lockFile = lockFilePath;
        this.processId = process.pid;

        // Ensure lock directory exists
        const lockDir = path.dirname(lockFilePath);
        if (!fs.existsSync(lockDir)) {
            fs.mkdirSync(lockDir, { recursive: true });
        }
    }

    /**
     * Acquire lock with timeout
     * @param timeout Maximum time to wait for lock (ms)
     * @returns true if lock acquired, false if timeout
     */
    async acquire(timeout = 600000): Promise<boolean> {
        const startTime = Date.now();

        logger.log('FILE-LOCK', `Process ${this.processId} attempting to acquire lock: ${this.lockFile}`);

        while (Date.now() - startTime < timeout) {
            // Try to acquire lock
            if (this.tryAcquire()) {
                this.lockAcquired = true;
                logger.log('FILE-LOCK', `Process ${this.processId} acquired lock`);
                return true;
            }

            // Lock exists - check if it's stale
            if (this.isLockStale()) {
                logger.log('FILE-LOCK', `Stale lock detected, removing it`);
                this.forceRelease();
                continue; // Try acquiring again
            }

            // Lock is held by another process - wait and retry
            const lockInfo = this.readLockInfo();
            const elapsed = Date.now() - startTime;
            const remaining = timeout - elapsed;

            logger.log('FILE-LOCK', `Lock held by process ${lockInfo?.pid || 'unknown'}, waiting... (${Math.floor(elapsed / 1000)}s elapsed, ${Math.floor(remaining / 1000)}s remaining)`);

            await this.sleep(this.checkInterval);
        }

        logger.log('FILE-LOCK', `Process ${this.processId} failed to acquire lock (timeout after ${timeout}ms)`);
        return false;
    }

    /**
     * Try to acquire lock (non-blocking)
     * Uses atomic file write with exclusive flag
     */
    private tryAcquire(): boolean {
        try {
            const lockData = {
                pid: this.processId,
                timestamp: Date.now(),
                hostname: require('os').hostname()
            };

            // Try to create lock file exclusively (fails if exists)
            // wx flag = open for writing, fails if path exists
            fs.writeFileSync(this.lockFile, JSON.stringify(lockData, null, 2), { flag: 'wx' });
            return true;
        } catch (error: any) {
            // EEXIST = file already exists (lock held by another process)
            if (error.code === 'EEXIST') {
                return false;
            }
            // Other errors - log and return false
            logger.error('FILE-LOCK', `Error acquiring lock: ${error.message}`);
            return false;
        }
    }

    /**
     * Release lock
     */
    release(): void {
        if (!this.lockAcquired) {
            return;
        }

        try {
            if (fs.existsSync(this.lockFile)) {
                // Verify this process owns the lock before releasing
                const lockInfo = this.readLockInfo();
                if (lockInfo && lockInfo.pid === this.processId) {
                    fs.unlinkSync(this.lockFile);
                    logger.log('FILE-LOCK', `Process ${this.processId} released lock`);
                } else {
                    logger.log('FILE-LOCK', `Process ${this.processId} does not own lock (owned by ${lockInfo?.pid}), skipping release`);
                }
            }
            this.lockAcquired = false;
        } catch (error: any) {
            logger.error('FILE-LOCK', `Error releasing lock: ${error.message}`);
        }
    }

    /**
     * Force release lock (used for stale locks)
     */
    private forceRelease(): void {
        try {
            if (fs.existsSync(this.lockFile)) {
                fs.unlinkSync(this.lockFile);
                logger.log('FILE-LOCK', `Force released lock`);
            }
        } catch (error: any) {
            logger.error('FILE-LOCK', `Error force releasing lock: ${error.message}`);
        }
    }

    /**
     * Check if lock is stale (process no longer exists or too old)
     */
    private isLockStale(): boolean {
        const lockInfo = this.readLockInfo();
        if (!lockInfo) {
            return true; // Can't read lock = stale
        }

        // Check if lock is too old
        const age = Date.now() - lockInfo.timestamp;
        if (age > this.staleThreshold) {
            logger.log('FILE-LOCK', `Lock is ${Math.floor(age / 1000)}s old (threshold: ${this.staleThreshold / 1000}s)`);
            return true;
        }

        // Check if process still exists
        if (!this.isProcessRunning(lockInfo.pid)) {
            logger.log('FILE-LOCK', `Lock held by dead process ${lockInfo.pid}`);
            return true;
        }

        return false;
    }

    /**
     * Read lock file info
     */
    private readLockInfo(): { pid: number; timestamp: number; hostname: string } | null {
        try {
            if (!fs.existsSync(this.lockFile)) {
                return null;
            }
            const content = fs.readFileSync(this.lockFile, 'utf-8');
            return JSON.parse(content);
        } catch (error) {
            return null;
        }
    }

    /**
     * Check if a process is still running
     */
    private isProcessRunning(pid: number): boolean {
        try {
            // Sending signal 0 checks if process exists without killing it
            process.kill(pid, 0);
            return true;
        } catch (error: any) {
            // ESRCH = no such process
            return error.code !== 'ESRCH';
        }
    }

    /**
     * Sleep helper
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Check if lock is currently held by this process
     */
    isAcquired(): boolean {
        return this.lockAcquired;
    }

    /**
     * Get lock file path
     */
    getLockFilePath(): string {
        return this.lockFile;
    }
}
