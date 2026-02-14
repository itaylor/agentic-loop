# Migrating Waterfell to Use @waterfell/agentic-loop

This guide shows how to replace the existing `AgentRunner` class with the new library.

## Why Migrate

- **Better testability** - Core loop isolated from Waterfell concerns
- **Cleaner separation** - Tools, persistence, and orchestration stay in Waterfell
- **Session resumption** - Built-in support for crash recovery
- **Immediate sessionId** - Available before session completes

## Overview

The library extracts the agentic loop. Waterfell keeps:
- AgentContextAssembler (system prompt building)
- CoordinationTools (ask, tell, hire, etc.)
- ToolFilter (role/phase policies)
- TranscriptManager (TOML logging)
- Orchestrator (state management)

## Integration Steps

### 1. Install the Library

```bash
cd waterfell
npm install
```

Library is already in `package.json` as `file:./packages/agentic-loop`.

### 2. Create Wrapper

Create `src/agent-session-wrapper.ts`:

```typescript
import { runAgentSession } from "@waterfell/agentic-loop";
import { createMCPClient, MCPClient } from "@ai-sdk/mcp";
import { TranscriptManager } from "./transcript-manager.js";
import { config as loadEnv } from "dotenv";

export interface WaterfellSessionConfig {
  agentName: string;
  agentContext: string;
  initialMessage?: string;
  coordinationTools: Record<string, any>;
  allowedTools?: string[];
  projectId: string;
  agentDay: number;
  maxTurns?: number;
  onTranscriptUpdate?: (metadata: any) => void;
}

export async function runWaterfellAgentSession(
  config: WaterfellSessionConfig
) {
  loadEnv();

  // Get model config from environment
  const modelConfig = {
    provider: (process.env.AI_PROVIDER || "ollama") as any,
    model: process.env.AI_MODEL || "gpt-oss:20b-128k",
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  };

  // Initialize MCP clients
  const mcpClient = await createMCPClient({ /* agent-mcp config */ });
  const mcpTools = await mcpClient.tools();

  // Filter tools by policy
  const filteredTools = config.allowedTools
    ? filterTools(mcpTools, config.allowedTools)
    : mcpTools;

  // Merge with coordination tools
  const allTools = { ...filteredTools, ...config.coordinationTools };

  // Initialize transcript
  const transcript = new TranscriptManager(
    config.projectId,
    config.agentName,
    config.agentDay,
    config.onTranscriptUpdate
  );
  await transcript.initialize();
  await transcript.addEntry("assistant_thinking", `# Agent Context\n\n${config.agentContext}`);

  try {
    const session = runAgentSession(modelConfig, {
      systemPrompt: config.agentContext,
      tools: allTools,
      initialMessage: config.initialMessage,
      maxTurns: config.maxTurns || 50,
      callbacks: {
        onAssistantMessage: async (sessionId, text, turn) => {
          await transcript.addEntry("assistant_text", text, { turn });
        },
        onToolCall: async (sessionId, info) => {
          const content = `# Tool Call: ${info.toolName}\n\n\`\`\`json\n${JSON.stringify(info.args, null, 2)}\n\`\`\``;
          await transcript.addEntry("tool_call", content, { turn: info.turn, tool_name: info.toolName });
        },
        onToolResult: async (sessionId, info) => {
          const content = `# Tool Result: ${info.toolName}\n\n\`\`\`json\n${JSON.stringify(info.result, null, 2)}\n\`\`\``;
          await transcript.addEntry("tool_result", content, { turn: info.turn, tool_name: info.toolName });
        },
        onError: async (sessionId, info) => {
          await transcript.addEntry("error", `Error in ${info.phase}: ${info.error.message}`, { turn: info.turn });
        },
        onComplete: async () => {
          await transcript.complete();
        },
      },
    });

    const result = await session.promise;
    return { finalOutput: result.finalOutput, totalTurns: result.totalTurns, taskResult: result.taskResult };
  } finally {
    await mcpClient.close();
  }
}

function filterTools(tools: Record<string, any>, allowedTools: string[]) {
  const filtered: Record<string, any> = {};
  for (const toolName of allowedTools) {
    if (tools[toolName]) filtered[toolName] = tools[toolName];
  }
  return filtered;
}
```

### 3. Update Orchestrator

In `src/orchestrator.ts`:

```typescript
// Remove:
// import { AgentRunner } from "./agent-runner.js";
// private agentRunner: AgentRunner;
// this.agentRunner = new AgentRunner();
// await this.agentRunner.initialize();

// Add:
import { runWaterfellAgentSession } from "./agent-session-wrapper.js";

// Update runAgentSession method:
async runAgentSession(agentName: string, message?: string, onTranscriptUpdate?: any) {
  const state = await this.stateManager.getState();
  const agent = state.agents.find((a) => a.name === agentName);
  if (!agent) throw new Error(`Agent ${agentName} not found`);

  const agentContext = await this.generateAgentContext(agentName);
  const coordinationTools = createCoordinationTools({
    orchestrator: this,
    projectId: state.project_id,
    agentName,
  });
  const allowedTools = await this.getAllowedToolsForAgent(agent);

  const result = await runWaterfellAgentSession({
    agentName,
    agentContext,
    initialMessage: message,
    coordinationTools,
    allowedTools,
    projectId: state.project_id,
    agentDay: agent.day,
    maxTurns: 50,
    onTranscriptUpdate,
  });

  return result.finalOutput;
}
```

### 4. Update Server

In `src/server.ts`:

```typescript
// Remove:
// import { AgentRunner } from "./agent-runner.js";
// private agentRunner: AgentRunner;
// this.agentRunner = new AgentRunner();
// await this.agentRunner.initialize();
// await this.agentRunner.cleanup();

// handleRunAgent now just delegates to orchestrator
private async handleRunAgent(req: Request, res: Response) {
  const { projectId, agentName } = req.params;
  const { message } = req.body;

  const output = await this.orchestrator.runAgentSession(agentName as string, message);
  res.json({ output });
}
```

### 5. Update CLI

In `src/index.ts`:

```typescript
// Remove:
// import { AgentRunner } from "./agent-runner.js";

// Update run-agent command:
case "run-agent": {
  const projectId = args[0];
  const agentName = args[1];
  const message = args.slice(2).join(" ");

  const orchestrator = new Orchestrator(process.cwd());
  await orchestrator.initialize();
  await orchestrator.loadProject(projectId);

  const output = await orchestrator.runAgentSession(agentName, message);
  console.log("\n=== Agent Output ===");
  console.log(output);
  break;
}
```

### 6. Delete Old Code

```bash
rm src/agent-runner.ts
```

### 7. Test

```bash
npm run build
node dist/index.js run-agent <project-id> <agent-name> "test message"
```

Verify:
- Agent executes successfully
- Transcripts are created
- Tools work
- Task completion works

## Key Differences

**Before:**
```typescript
const runner = new AgentRunner();
await runner.initialize();
const output = await runner.runAgent({
  agentName: "Morgan#1",
  agentContext: context,
  // ... other config
});
await runner.cleanup();
```

**After:**
```typescript
const result = await runWaterfellAgentSession({
  agentName: "Morgan#1",
  agentContext: context,
  // ... other config
});
// MCP cleanup happens in wrapper
```

## Session Resumption

To add crash recovery:

```typescript
// Save messages in onMessagesUpdate callback
callbacks: {
  onMessagesUpdate: async (sessionId, messages) => {
    await db.saveMessages(projectId, agentName, agentDay, messages);
  }
}

// Resume after crash
const savedMessages = await db.loadMessages(projectId, agentName, agentDay);
const session = runAgentSession(modelConfig, {
  initialMessages: savedMessages,  // Resume from here
  // ... rest of config
});
```

## Troubleshooting

**"task_complete tool not found"**
- It's built into the library. Remove from coordination tools if added.

**"MCP client connection failed"**
- Check MCP client initialization in wrapper. Add error handling.

**"Transcript entries missing"**
- Verify all callbacks are wired up in wrapper.

**"Tool filtering not working"**
- Ensure `filterTools()` is called before passing to runAgentSession.

## Next Steps

Once migration is complete:
1. Add summarization callback for long sessions
2. Implement session resumption for crash recovery
3. Consider token counting improvements
4. Add metrics/telemetry via callbacks