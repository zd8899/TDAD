/**
 * CLIOutputWatcher - Watches CLI output log file and streams to Slack
 * Sprint 15: Remote Control via Slack
 */

import * as fs from 'fs';
import * as path from 'path';
import { SlackService } from './SlackService';
import { logger } from '../../shared/utils/Logger';
import { filterTranscriptNoise } from '../../shared/utils/PowerShellTranscriptFilter';

const BATCH_INTERVAL_MS = 5000; // Send batches every 5 seconds
const MAX_CHUNK_SIZE = 3500; // Slack message limit with buffer

export class CLIOutputWatcher {
    private watcher: fs.FSWatcher | null = null;
    private lastPosition: number = 0;
    private batchBuffer: string = '';
    private batchTimer: NodeJS.Timeout | null = null;
    private logFilePath: string;
    private isWatching: boolean = false;

    constructor(
        private readonly slackService: SlackService,
        private readonly channelId: string,
        private readonly threadTs: string,
        private readonly workspacePath: string
    ) {
        this.logFilePath = path.join(workspacePath, '.tdad', 'logs', 'cli-output.log');
    }

    public startWatching(): void {
        if (this.isWatching) {
            logger.log('CLI-WATCHER', 'Already watching');
            return;
        }

        // Ensure logs directory exists
        const logsDir = path.dirname(this.logFilePath);
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        // Clear/create log file - handle EBUSY if file is locked
        try {
            fs.writeFileSync(this.logFilePath, '');
            this.lastPosition = 0;
        } catch (error: unknown) {
            const err = error as NodeJS.ErrnoException;
            if (err.code === 'EBUSY') {
                // File is locked by PowerShell - skip existing content (including header)
                try {
                    const stats = fs.statSync(this.logFilePath);
                    this.lastPosition = stats.size;
                    logger.log('CLI-WATCHER', `Log file is busy, starting from position ${this.lastPosition}`);
                } catch {
                    this.lastPosition = 0;
                }
            } else {
                throw error;
            }
        }
        this.batchBuffer = '';

        // Start file watcher
        try {
            this.watcher = fs.watch(this.logFilePath, (eventType) => {
                if (eventType === 'change') {
                    this.processNewContent();
                }
            });

            // Also poll periodically in case watch events are missed
            this.batchTimer = setInterval(() => {
                this.processNewContent();
                this.sendBatch();
            }, BATCH_INTERVAL_MS);

            this.isWatching = true;
            logger.log('CLI-WATCHER', `Started watching: ${this.logFilePath}`);

        } catch (error) {
            logger.error('CLI-WATCHER', 'Failed to start watching', error);
        }
    }

    public stopWatching(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }

        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }

        // Send any remaining content
        if (this.batchBuffer.length > 0) {
            this.sendBatch();
        }

        this.isWatching = false;
        logger.log('CLI-WATCHER', 'Stopped watching');
    }

    private processNewContent(): void {
        try {
            if (!fs.existsSync(this.logFilePath)) {
                return;
            }

            let stats: fs.Stats;
            try {
                stats = fs.statSync(this.logFilePath);
            } catch (statError: unknown) {
                // File might be locked by Start-Transcript on Windows - skip this cycle
                const error = statError as NodeJS.ErrnoException;
                if (error.code === 'EBUSY') {
                    return;
                }
                throw statError;
            }

            if (stats.size <= this.lastPosition) {
                return;
            }

            // Read new content using readFileSync which handles locks better than openSync
            // on Windows. We read the whole file and slice to get new content.
            let fileContent: string;
            try {
                fileContent = fs.readFileSync(this.logFilePath, 'utf-8');
            } catch (readError: unknown) {
                // File might be locked by Start-Transcript on Windows - skip this cycle
                const error = readError as NodeJS.ErrnoException;
                if (error.code === 'EBUSY') {
                    return;
                }
                throw readError;
            }

            // Extract only new content from last position
            let newContent = fileContent.substring(this.lastPosition);
            this.lastPosition = fileContent.length;

            // Filter out PowerShell transcript headers/footers
            newContent = filterTranscriptNoise(newContent);

            if (newContent.trim()) {
                this.batchBuffer += newContent;
            }

        } catch (error) {
            logger.error('CLI-WATCHER', 'Error reading log file', error);
        }
    }

    private async sendBatch(): Promise<void> {
        if (!this.batchBuffer.trim()) {
            return;
        }

        const content = this.batchBuffer;
        this.batchBuffer = '';

        // Split into chunks if too large
        const chunks = this.splitIntoChunks(content, MAX_CHUNK_SIZE);

        for (const chunk of chunks) {
            try {
                await this.slackService.sendCLIOutput(
                    this.channelId,
                    chunk,
                    this.threadTs
                );
            } catch (error) {
                logger.error('CLI-WATCHER', 'Failed to send chunk to Slack', error);
            }
        }
    }

    private splitIntoChunks(text: string, maxSize: number): string[] {
        const chunks: string[] = [];
        const lines = text.split('\n');
        let currentChunk = '';

        for (const line of lines) {
            if (currentChunk.length + line.length + 1 > maxSize) {
                if (currentChunk) {
                    chunks.push(currentChunk);
                }
                currentChunk = line;
            } else {
                currentChunk += (currentChunk ? '\n' : '') + line;
            }
        }

        if (currentChunk) {
            chunks.push(currentChunk);
        }

        return chunks;
    }

    public getLogFilePath(): string {
        return this.logFilePath;
    }
}
