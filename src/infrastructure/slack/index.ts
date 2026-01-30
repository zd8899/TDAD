/**
 * Slack Integration Module
 * Sprint 15: Remote Control via Slack
 */

export { SlackService } from './SlackService';
export { SlackCommandHandler } from './SlackCommandHandler';
export { CLIOutputWatcher } from './CLIOutputWatcher';

// Re-export types from shared
export type { SlackCommandDependencies, AutomationStatus } from '../../shared/types/slack';
