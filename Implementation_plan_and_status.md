# Slack Integration Implementation Plan

## Overview
Add Slack remote control capability to TDAD - allowing users to control autopilot, see CLI outputs, and send commands from their phone via Slack.

## Architecture

```
┌─────────────┐     Socket Mode      ┌──────────────────┐
│   Slack     │ ◄──────────────────► │  SlackService    │
│  (Phone)    │                      │  (Extension)     │
└─────────────┘                      └────────┬─────────┘
       │                                      │
       │ /tdad commands                       │ Triggers
       │ Thread replies                       ▼
       │                             ┌──────────────────┐
       │                             │ SlackHandlers    │
       │                             │ (Routes to       │
       │                             │  existing code)  │
       │                             └────────┬─────────┘
       │                                      │
       │                                      ▼
       │                             ┌──────────────────┐
       │                             │ Existing TDAD    │
       │                             │ - AutomationH.   │
       │                             │ - NodeManager    │
       │                             │ - TestRunner     │
       │                             └────────┬─────────┘
       │                                      │
       │ CLI Output                           │ tee to file
       │ (chunks)                             ▼
       │                             ┌──────────────────┐
       ◄─────────────────────────────│ CLIOutputWatcher │
                                     │ (File → Slack)   │
                                     └──────────────────┘
```

## Files to Create/Modify

### New Files

| File | Purpose | Lines (est) |
|------|---------|-------------|
| `src/infrastructure/slack/SlackService.ts` | Socket Mode connection, message sending | ~150 |
| `src/infrastructure/slack/SlackCommandHandler.ts` | Parse & route slash commands | ~100 |
| `src/infrastructure/slack/CLIOutputWatcher.ts` | Watch log file, send chunks to Slack | ~80 |
| `src/shared/types/slack.ts` | Slack-related type definitions | ~40 |

### Modified Files

| File | Change | Lines (est) |
|------|--------|-------------|
| `package.json` | Add @slack/bolt dependency | +1 |
| `src/shared/types/index.ts` | Export slack types | +1 |
| `src/vscode-integration/CLIAgentLauncher.ts` | Add `\| tee` to capture output | ~10 |
| `src/extension.ts` | Initialize SlackService | ~20 |
| `src/vscode-integration/providers/handlers/SettingsHandlers.ts` | Handle Slack settings | ~30 |

## Implementation Steps

### Phase 1: Types & Dependencies

1. **Add dependency**
   ```bash
   npm install @slack/bolt
   ```

2. **Create `src/shared/types/slack.ts`**
   ```typescript
   export interface SlackSettings {
       enabled: boolean;
       botToken: string;      // xoxb-...
       appToken: string;      // xapp-...
       defaultChannel: string;
   }

   export interface SlackMessageContext {
       channelId: string;
       threadTs?: string;     // For thread replies
       userId: string;
   }
   ```

### Phase 2: SlackService (Core)

**File:** `src/infrastructure/slack/SlackService.ts`

```typescript
import { App } from '@slack/bolt';

export class SlackService {
    private app: App | null = null;
    private static instance: SlackService | null = null;

    // Singleton
    static getInstance(): SlackService

    // Connection
    async connect(botToken: string, appToken: string): Promise<void>
    async disconnect(): Promise<void>
    isConnected(): boolean

    // Messaging
    async sendMessage(channel: string, text: string, threadTs?: string): Promise<string>
    async sendCodeBlock(channel: string, code: string, threadTs?: string): Promise<void>

    // Command registration
    onSlashCommand(callback: (command, context) => Promise<void>): void
    onMessage(callback: (message, context) => Promise<void>): void
}
```

### Phase 3: SlackCommandHandler

**File:** `src/infrastructure/slack/SlackCommandHandler.ts`

```typescript
export class SlackCommandHandler {
    constructor(
        private slackService: SlackService,
        private nodeManager: SimpleNodeManager,
        private automationHandlers: AutomationHandlers,
        private storage: FeatureMapStorage
    )

    // Command routing
    async handleCommand(command: string, args: string[], context: SlackMessageContext): Promise<void>

    // Individual handlers
    private async handleNodeCreate(name: string, ctx): Promise<void>
    private async handleAutopilotStart(ctx): Promise<void>
    private async handleAutopilotStop(ctx): Promise<void>
    private async handleTest(nodeName: string, ctx): Promise<void>
    private async handleStatus(ctx): Promise<void>
    private async handleNodes(ctx): Promise<void>
    private async handleSay(message: string, ctx): Promise<void>  // Send to terminal
    private async handleHelp(ctx): Promise<void>
}
```

**Supported Commands:**
- `/tdad node create <name>` - Create a new node
- `/tdad autopilot start` - Start automation
- `/tdad autopilot stop` - Stop automation
- `/tdad test <node-name>` - Run tests for a node
- `/tdad status` - Get current status
- `/tdad nodes` - List all nodes
- `/tdad say <message>` - Send message to CLI terminal
- `/tdad help` - Show available commands

### Phase 4: CLI Output Capture

**Modify:** `src/vscode-integration/CLIAgentLauncher.ts`

```typescript
// In triggerAgent() method, modify command building:
private buildCommandWithLogging(command: string): string {
    const logFile = path.join(this.workspacePath, '.tdad', 'logs', 'cli-output.log');
    // Clear previous log
    fs.writeFileSync(logFile, '');
    // Wrap command with tee
    return `${command} 2>&1 | tee "${logFile}"`;
}
```

### Phase 5: CLIOutputWatcher

**File:** `src/infrastructure/slack/CLIOutputWatcher.ts`

```typescript
export class CLIOutputWatcher {
    private watcher: fs.FSWatcher | null = null;
    private lastPosition: number = 0;
    private batchBuffer: string = '';
    private batchTimer: NodeJS.Timeout | null = null;

    constructor(
        private slackService: SlackService,
        private channelId: string,
        private threadTs: string
    )

    // Start watching
    startWatching(logFilePath: string): void

    // Stop watching
    stopWatching(): void

    // Read new content and batch send
    private async processNewContent(): Promise<void>

    // Send batched content (every 5 seconds)
    private async sendBatch(): Promise<void>
}
```

### Phase 6: Settings Integration

**Add to VS Code configuration in `package.json`:**
```json
"tdad.slack.enabled": {
    "type": "boolean",
    "default": false
},
"tdad.slack.defaultChannel": {
    "type": "string",
    "default": ""
}
```

**Tokens stored via:** `context.secrets.store('tdad.slack.botToken', token)`

### Phase 7: Extension Integration

**Modify:** `src/extension.ts`

```typescript
// In activate()
let slackService: SlackService | null = null;

// Initialize Slack if configured
const slackEnabled = vscode.workspace.getConfiguration('tdad').get('slack.enabled');
if (slackEnabled) {
    const botToken = await context.secrets.get('tdad.slack.botToken');
    const appToken = await context.secrets.get('tdad.slack.appToken');
    if (botToken && appToken) {
        slackService = SlackService.getInstance();
        await slackService.connect(botToken, appToken);

        // Initialize command handler with dependencies
        const slackCommandHandler = new SlackCommandHandler(
            slackService,
            nodeManager,
            automationHandlers,
            storage
        );

        // Register slash command handler
        slackService.onSlashCommand(async (cmd, ctx) => {
            await slackCommandHandler.handleCommand(cmd.command, cmd.args, ctx);
        });
    }
}
```

## Slack App Setup (User Instructions)

1. Go to https://api.slack.com/apps
2. Create New App → From scratch
3. Enable Socket Mode (Settings → Socket Mode → Enable)
4. Create App-Level Token with `connections:write` scope
5. Add Bot Token Scopes:
   - `chat:write`
   - `commands`
   - `channels:read`
6. Create Slash Command `/tdad`
7. Install to Workspace
8. Copy Bot Token (xoxb-...) and App Token (xapp-...)
9. Paste into TDAD Settings

## Verification

1. **Connection test:** `/tdad status` → Should respond with current state
2. **Node creation:** `/tdad node create "Test Feature"` → Check canvas
3. **Autopilot:** `/tdad autopilot start` → See output streaming to thread
4. **Send command:** `/tdad say stop and focus on login` → CLI receives it

## Status: Complete

- [x] Phase 1: Types & Dependencies
- [x] Phase 2: SlackService
- [x] Phase 3: SlackCommandHandler
- [x] Phase 4: CLI Output Capture
- [x] Phase 5: CLIOutputWatcher
- [x] Phase 6: Settings Integration
- [x] Phase 7: Extension Integration
- [ ] Testing & Polish (manual testing required)

## Files Created/Modified

### New Files:
- `src/shared/types/slack.ts` - Slack type definitions
- `src/infrastructure/slack/SlackService.ts` - Socket Mode connection
- `src/infrastructure/slack/SlackCommandHandler.ts` - Command routing
- `src/infrastructure/slack/CLIOutputWatcher.ts` - Output streaming
- `src/infrastructure/slack/index.ts` - Module exports

### Modified Files:
- `package.json` - Added @slack/bolt, Slack config properties, commands
- `src/extension.ts` - Slack initialization, commands
- `src/vscode-integration/CLIAgentLauncher.ts` - Output capture with tee
- `src/vscode-integration/providers/SimplifiedWorkflowCanvasProvider.ts` - Slack helper methods
- `src/vscode-integration/providers/handlers/AutomationHandlers.ts` - getState() method
