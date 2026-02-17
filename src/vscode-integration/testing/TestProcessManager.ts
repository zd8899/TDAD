import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

export interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
}

export class TestProcessManager {
    private outputChannel: vscode.OutputChannel;
    currentProcess: ChildProcess | null = null;
    private activeProcesses: Map<number, { process: ChildProcess; workingDir: string }> = new Map();
    private observedWorkingDirs: Set<string> = new Set();
    cancelRequested = false;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    executeCommandWithTimeout(command: string, workingDir: string, timeout?: number, env?: Record<string, string>): Promise<CommandResult> {
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            let processExited = false;
            let resolved = false;

            const isWindows = process.platform === 'win32';
            const shell = isWindows ? 'cmd.exe' : '/bin/sh';
            const shellFlag = isWindows ? '/c' : '-c';

            this.outputChannel.appendLine(`\n🚀 Starting process...`);
            this.outputChannel.appendLine(`   Shell: ${shell} ${shellFlag}`);
            this.outputChannel.appendLine(`   CWD: ${workingDir}`);
            if (env) {
                this.outputChannel.appendLine(`   ENV: ${Object.keys(env).join(', ')}`);
            }

            const childProcess = spawn(shell, [shellFlag, command], {
                cwd: workingDir,
                windowsHide: true,
                env: env ? { ...process.env, ...env } : process.env
            });
            this.currentProcess = childProcess;
            this.trackActiveProcess(childProcess, workingDir);

            this.outputChannel.appendLine(`✅ Process spawned (PID: ${childProcess.pid})\n`);

            // Timeout disabled by default. Keep optional support only when a positive timeout is explicitly passed.
            const timeoutHandle = timeout && timeout > 0 ? setTimeout(() => {
                if (!processExited && !resolved) {
                    timedOut = true;
                    processExited = true;
                    clearInterval(progressInterval);
                    const pid = childProcess.pid;
                    if (pid) {
                        this.untrackActiveProcess(pid);
                    }
                    if (this.currentProcess?.pid === pid) {
                        this.currentProcess = null;
                    }
                    resolved = true;
                    resolve({ stdout, stderr, exitCode: null, timedOut });
                }
            }, timeout) : null;

            childProcess.stdout?.on('data', (data) => {
                const text = data.toString();
                stdout += text;
                this.outputChannel.append(cleanTestOutput(text));
            });

            childProcess.stderr?.on('data', (data) => {
                const text = data.toString();
                stderr += text;
                this.outputChannel.append(cleanTestOutput(text));
            });

            const startTime = Date.now();

            // Log progress every 5 seconds
            const progressInterval = setInterval(() => {
                if (!processExited) {
                    const elapsed = Date.now() - startTime;
                    this.outputChannel.appendLine(`\n⏱️  Still running... (${Math.floor(elapsed / 1000)}s elapsed)`);
                }
            }, 5000);

            // Handle process exit
            childProcess.on('close', (code) => {
                if (resolved) { return; }
                processExited = true;
                if (timeoutHandle) { clearTimeout(timeoutHandle); }
                clearInterval(progressInterval);
                const pid = childProcess.pid;
                if (pid) { this.untrackActiveProcess(pid); }
                if (this.currentProcess?.pid === pid) { this.currentProcess = null; }

                const elapsed = Date.now() - startTime;
                this.outputChannel.appendLine(`\n✅ Process exited with code ${code} after ${Math.floor(elapsed / 1000)}s`);

                // For Playwright commands, ALWAYS resolve even with non-zero exit codes
                // Playwright exits with code 1 when tests fail, but still provides valid JSON output
                if (command.includes('playwright')) {
                    resolved = true;
                    resolve({ stdout, stderr, exitCode: code, timedOut });
                } else if (timedOut) {
                    resolved = true;
                    resolve({ stdout, stderr, exitCode: code, timedOut });
                } else if (code !== 0) {
                    reject(new Error(`Process exited with code ${code}\n${stderr}`));
                } else {
                    resolved = true;
                    resolve({ stdout, stderr, exitCode: code, timedOut });
                }
            });

            // Handle process errors
            childProcess.on('error', (error) => {
                if (resolved) { return; }
                processExited = true;
                if (timeoutHandle) { clearTimeout(timeoutHandle); }
                clearInterval(progressInterval);
                const pid = childProcess.pid;
                if (pid) { this.untrackActiveProcess(pid); }
                if (this.currentProcess?.pid === pid) { this.currentProcess = null; }
                this.outputChannel.appendLine(`\n❌ Process error: ${error.message}`);
                reject(error);
            });
        });
    }

    cancelAll(): void {
        this.cancelRequested = true;
        if (this.activeProcesses.size > 0) {
            this.outputChannel.appendLine('\n🛑 Canceling test execution...');
            for (const pid of this.activeProcesses.keys()) {
                this.terminateProcessTree(pid);
            }
            this.releaseStaleTestLocks();
            this.activeProcesses.clear();
            this.currentProcess = null;
        } else {
            this.outputChannel.appendLine('\nCancel requested for queued/waiting test executions.');
            this.releaseStaleTestLocks();
        }
    }

    isRunning(): boolean {
        return this.activeProcesses.size > 0;
    }

    dispose(): void {
        if (this.activeProcesses.size > 0) {
            for (const pid of this.activeProcesses.keys()) {
                this.terminateProcessTree(pid);
            }
            this.releaseStaleTestLocks();
            this.activeProcesses.clear();
            this.currentProcess = null;
        }
    }

    private trackActiveProcess(childProcess: ChildProcess, workingDir: string): void {
        const pid = childProcess.pid;
        this.observedWorkingDirs.add(workingDir);
        if (!pid) { return; }
        this.activeProcesses.set(pid, { process: childProcess, workingDir });
    }

    private untrackActiveProcess(pid: number): void {
        this.activeProcesses.delete(pid);
    }

    private releaseStaleTestLocks(): void {
        try {
            const candidateDirs = new Set<string>(this.observedWorkingDirs);
            for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
                candidateDirs.add(workspaceFolder.uri.fsPath);
            }

            for (const dir of candidateDirs) {
                const lockFile = path.join(dir, '.tdad', '.test-lock');
                if (fs.existsSync(lockFile)) {
                    fs.unlinkSync(lockFile);
                }
            }
        } catch {
            // Best-effort cleanup only.
        }
    }

    private terminateProcessTree(pid: number): void {
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/PID', `${pid}`, '/T', '/F'], { windowsHide: true });
            } else {
                try {
                    process.kill(pid, 'SIGTERM');
                } catch {
                    return;
                }
                setTimeout(() => {
                    try {
                        process.kill(pid, 'SIGKILL');
                    } catch {
                        // Ignore if already gone.
                    }
                }, 2000);
            }
        } catch {
            // Best-effort termination.
        }
    }
}

/**
 * Clean up Playwright test output for better readability
 */
export function cleanTestOutput(output: string): string {
    return output
        .replace(/([\\\/])([^\\\/]+)[\\\/]\2\.test\.js:(\d+):\d+/g, '$1$2.test.js:$3')
        .replace(/^(\s*\S+\s+\d+\s+)\[[^\]]+\]\s+/gm, '$1')
        .replace(/^(\s*)ok(\s+\d+)/gm, '$1✅$2')
        .replace(/^(\s*)x(\s+\d+)/gm, '$1❌$2');
}
