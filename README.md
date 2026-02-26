# agentic-loop

A lightweight, functional library for running agentic loops with LLMs, tool calling, and summarization support.

## Installation

```bash
npm install @itaylor/agentic-loop
```

## Quick Start

```typescript
import { runAgentSession } from "@itaylor/agentic-loop";
import { z } from "zod";

// Simple case - await directly
const result = await runAgentSession(
  { provider: "openai", model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY },
  {
    tools: {
      search: {
        description: "Search for information",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ results: ["result1", "result2"] }),
      },
    },
  }
);

console.log(result.finalOutput);

// Advanced case - get sessionId immediately
const session = runAgentSession(modelConfig, sessionConfig);
console.log("Session started:", session.sessionId);
await logSessionStart(session.sessionId);
const result = await session.promise;
```

## Features

- **Multi-turn conversations** with automatic tool calling
- **Multiple LLM providers** (OpenAI, Anthropic, Ollama)
- **Built-in task completion** - agents call `task_complete` when done
- **Session suspension** - pause sessions to wait for external events (approval, async ops, etc.)
- **Session resumption** - continue from saved messages after crashes
- **Token management** - automatic summarization when approaching limits
- **Error handling** - automatic retries with errors added to conversation
- **Idle detection** - nudges agents stuck in thinking loops
- **Event callbacks** - hooks for logging, persistence, monitoring
- **Functional design** - no classes, pure functions

## API

### `runAgentSession(modelConfig, sessionConfig): AgentSession`

Returns immediately with session object containing `sessionId`, `initialMessage`, and `promise`.
The session object is "thenable" - you can await it directly.

**ModelConfig:**
```typescript
{
  provider: "openai" | "anthropic" | "ollama";
  model: string;
  apiKey?: string;      // Required for OpenAI/Anthropic
  baseURL?: string;     // For Ollama (default: http://127.0.0.1:11434)
}
```

**AgentSessionConfig:**
```typescript
{
  systemPrompt?: string;        // Optional — defaults to a generic helpful assistant prompt
  tools: Record<string, Tool>;
  sessionId?: string;           // Auto-generated if not provided
  messages?: Message[];         // Resume from saved messages (ignored if empty)
  initialMessage?: string;      // Starting message for fresh sessions (ignored if messages provided)
  maxTurns?: number;            // Default: 50
  tokenLimit?: number;          // Trigger summarization
  llmTimeout?: number;          // LLM call timeout (ms)
  toolTimeout?: number;         // Tool call timeout (ms)
  logger?: Logger;              // Custom logger
  callbacks?: SessionCallbacks; // Event hooks
  metadata?: Record<string, any>;
}
```

**AgentSession:**
```typescript
{
  sessionId: string;                // Available immediately
  initialMessage: string;           // The message that started the session
  promise: Promise<AgentSessionResult>;
  then: (...) => ...;               // Makes it awaitable
}
```

**AgentSessionResult:**
```typescript
{
  sessionId: string;
  finalOutput: string;
  totalTurns: number;
  completionReason: "task_complete" | "max_turns" | "error" | "suspended";
  messages: Message[];
  taskResult?: any;    // Data from task_complete tool
  suspendInfo?: SessionSuspendInfo;  // Present if suspended
  error?: Error;
}
```

### Callbacks

All callbacks receive `sessionId` as first parameter:

```typescript
{
  onTurnStart?: (sessionId: string, turn: number) => void | Promise<void>;
  onAssistantMessage?: (sessionId: string, text: string, turn: number) => void | Promise<void>;
  onToolCall?: (sessionId: string, info: ToolCallInfo) => void | Promise<void>;
  onToolResult?: (sessionId: string, info: ToolResultInfo) => void | Promise<void>;
  onError?: (sessionId: string, info: ErrorInfo) => void | Promise<void>;
  onComplete?: (sessionId: string, info: SessionCompleteInfo) => void | Promise<void>;
  onMessagesUpdate?: (sessionId: string, messages: Message[]) => void | Promise<void>;
  
  // Summarization callbacks (library handles the LLM call)
  onBeforeSummarize?: (sessionId: string, messages: Message[]) => Message[] | Promise<Message[]>;
  onAfterSummarize?: (sessionId: string, summarizedMessages: Message[]) => Message[] | Promise<Message[]>;
  
  // Suspension callback
  onSuspend?: (sessionId: string, info: SessionSuspendInfo) => void | Promise<void>;
}
```

### Messages

The `Message` type reflects the actual AI SDK message structure. Messages can contain simple text or complex content with tool calls, results, images, and files:

```typescript
type Message = 
  | {
      role: "user";
      content: string | Array<TextPart | ImagePart | FilePart>;
    }
  | {
      role: "assistant";
      content: string | Array<TextPart | FilePart | ToolCallPart | ToolResultPart>;
    };
```

**Simple text messages:**
```typescript
{ role: "user", content: "Hello!" }
{ role: "assistant", content: "Hi there!" }
```

**Complex messages with tool calls/results:**
When the agent calls tools, the AI SDK automatically creates messages with structured content arrays containing `ToolCallPart` and `ToolResultPart` objects. These are handled internally by the library.

**For most use cases**, you can treat message content as strings. The library handles the complex formats automatically when tools are used.

## Examples

### Basic Usage

```typescript
const result = await runAgentSession(
  { provider: "ollama", model: "qwen2.5:7b" },
  {
    tools: { /* your tools */ },
    initialMessage: "Summarize the three laws of thermodynamics.",
  }
);
```

### With Persistence

```typescript
const session = runAgentSession(modelConfig, {
  sessionId: generateId(),
  systemPrompt: "You are a specialized data analyst.",
  tools: myTools,
  callbacks: {
    onMessagesUpdate: async (sessionId, messages) => {
      await db.saveMessages(sessionId, messages);
    },
    onComplete: async (sessionId, info) => {
      await db.markComplete(sessionId, info);
    },
  },
});

console.log("Tracking session:", session.sessionId);
const result = await session.promise;
```

### Resume After Crash

```typescript
// Server crashed, restarting...
const savedMessages = await db.loadMessages("session-123");

const session = runAgentSession(modelConfig, {
  sessionId: "session-123",   // Same ID
  messages: savedMessages,    // Continue from here
  systemPrompt: "...",
  tools: myTools,
});

const result = await session.promise;
```

### With MCP Tools

```typescript
import { createMCPClient } from "@ai-sdk/mcp";

const mcpClient = await createMCPClient({ /* config */ });
const mcpTools = await mcpClient.tools();

const result = await runAgentSession(modelConfig, {
  tools: mcpTools,  // Pass MCP tools directly
  // ...
});

await mcpClient.close();
```

If you want to give your agent code editing capabilities (read/write files, search, apply patches, etc.), consider using [agent-mcp](https://github.com/itaylor/agent-mcp) — a fast stdio MCP server providing file system navigation, text search, code analysis, and patch application.

```typescript
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { createMCPClient } from "@ai-sdk/mcp";

const transport = new Experimental_StdioMCPTransport({
  command: "/path/to/agent-mcp",
  args: ["/path/to/your/repo"],
});

const mcpClient = await createMCPClient({ transport });
const mcpTools = await mcpClient.tools();

const result = await runAgentSession(modelConfig, {
  tools: mcpTools,
  initialMessage: "Review the codebase and fix any TypeScript errors you find.",
});

await mcpClient.close();
```

### Get SessionId Immediately

```typescript
const session = runAgentSession(modelConfig, sessionConfig);

// SessionId available right away
await monitoring.startTracking(session.sessionId);
await logSessionStart(session.sessionId, session.initialMessage);

// Then wait for completion
const result = await session.promise;
```

### Token Summarization

The library automatically summarizes messages when approaching the token limit:

```typescript
const result = await runAgentSession(modelConfig, {
  systemPrompt: "...",
  tools: myTools,
  tokenLimit: 100000, // ~25k tokens - triggers summarization
  callbacks: {
    // Optional: modify messages before summarization
    onBeforeSummarize: async (sessionId, messages) => {
      console.log(`[${sessionId}] Summarizing ${messages.length} messages`);
      // Example: keep last 10 messages out of summarization
      return messages.slice(0, -10);
    },
    
    // Optional: modify messages after summarization
    onAfterSummarize: async (sessionId, summarizedMessages) => {
      console.log(`[${sessionId}] Summary complete`);
      // Example: append the last 10 messages we kept
      return [...summarizedMessages, ...recentMessages];
    },
  },
});
```

**How it works:**
1. Library detects token limit approaching
2. Calls `onBeforeSummarize(sessionId, messages)` → returns messages to summarize
   - Default: all messages are summarized
   - Example: Remove system prompts, keep recent messages
3. Library calls the LLM to summarize the messages
4. Creates summary as 2 messages: "Previous conversation summary:" + summary text
5. Calls `onAfterSummarize(sessionId, summarizedMessages)` → returns final messages
   - Default: just the summary (2 messages)
   - Example: Add back system prompts, append recent messages
6. Replaces message history and continues

**Examples:**

```typescript
// Keep last 10 messages
onBeforeSummarize: (sessionId, messages) => messages.slice(0, -10),
onAfterSummarize: (sessionId, summary) => [...summary, ...messages.slice(-10)],

// Remove system prompts before, add back after
onBeforeSummarize: (sessionId, messages) => 
  messages.filter(m => !m.content.startsWith('You are')),
onAfterSummarize: (sessionId, summary) => 
  [{ role: 'user', content: systemPrompt }, ...summary],
```

**No LLM setup needed** - library handles the heavy lifting!

## Built-in Tools

### task_complete

Every session includes this tool automatically:

```typescript
// Agent calls this internally:
task_complete({
  summary: "Completed the analysis",
  result: { findings: [...] }
})
```

Signals graceful completion with `completionReason: "task_complete"`.

## Session Suspension

Agents can suspend their session to wait for external events (human approval, async operations, etc.). The session stops cleanly and can be resumed later, even after server restarts.

### Creating a Suspendable Tool

Any tool can suspend a session by returning a special `__suspend__` signal:

```typescript
const result = await runAgentSession(modelConfig, {
  systemPrompt: "You are a helpful assistant that needs approval.",
  initialMessage: "Please request approval to proceed.",
  tools: {
    request_approval: {
      description: "Request approval from a human. Your session will pause until they respond.",
      inputSchema: z.object({
        action: z.string().describe("The action that needs approval"),
        reason: z.string().describe("Why this action is needed"),
      }),
      execute: async (args) => {
        // Store the approval request somewhere
        await db.createApprovalRequest(args);
        
        // Return suspension signal
        return {
          __suspend__: true,
          reason: "waiting_for_approval",
          data: {
            action: args.action,
            requestId: generateId(),
          },
        };
      },
    },
  },
  callbacks: {
    onSuspend: async (sessionId, info) => {
      console.log(`Session ${sessionId} suspended: ${info.reason}`);
      // Save suspension state to database
      await db.saveSuspendedSession(sessionId, info);
    },
  },
});

// Session stopped with completionReason: "suspended"
console.log(result.completionReason); // "suspended"
console.log(result.suspendInfo); // { reason: "waiting_for_approval", data: {...}, turn: 1 }
```

### Resuming a Suspended Session

To resume, simply call `runAgentSession` again with the saved messages plus the response:

```typescript
// Later, when approval arrives...
const suspendedSession = await db.loadSuspendedSession(sessionId);

const result = await runAgentSession(modelConfig, {
  sessionId: sessionId,  // Same session ID
  systemPrompt: "You are a helpful assistant that needs approval.",
  messages: [
    ...suspendedSession.messages,  // All previous messages
    {
      role: "user",
      content: "Approval granted! You may proceed. Call task_complete when done.",
    },
  ],
  tools: {}, // Same tools or empty if no longer needed
});

// Agent continues from where it left off
console.log(resumedResult.completionReason); // "task_complete"
```

### Persistence Across Restarts

The suspension state is just data - it survives server restarts:

```typescript
// Before restart - save everything
const result = await runAgentSession(modelConfig, config);
if (result.completionReason === "suspended") {
  await fs.writeFile(`sessions/${result.sessionId}.json`, JSON.stringify({
    sessionId: result.sessionId,
    messages: result.messages,
    suspendInfo: result.suspendInfo,
  }));
}

// --- SERVER RESTART ---

// After restart - load and resume
const saved = JSON.parse(await fs.readFile(`sessions/${sessionId}.json`));
const resumedResult = await runAgentSession(modelConfig, {
  sessionId: saved.sessionId,
  messages: [
    ...saved.messages,
    { role: "user", content: "External data has arrived: {...}" },
  ],
  // ... rest of config
});
```

### Use Cases

- **Human approval workflows** - Agent requests permission, waits for response
- **Async API calls** - Wait for webhook callbacks or long-running operations
- **Multi-agent coordination** - Agent asks another agent a question, blocks until answered
- **Rate limiting** - Suspend when rate limited, resume when quota refreshes
- **Scheduled operations** - Suspend until a specific time

### Multiple Suspensions

Sessions can suspend and resume multiple times:

```typescript
let result = await runAgentSession(modelConfig, config);

// First suspension
assert.equal(result.completionReason, "suspended");
result = await runAgentSession(modelConfig, {
  messages: [...result.messages, { role: "user", content: "Step 1 done" }],
  // ...
});

// Second suspension
assert.equal(result.completionReason, "suspended");
result = await runAgentSession(modelConfig, {
  messages: [...result.messages, { role: "user", content: "Step 2 done" }],
  // ...
});

// Final completion
assert.equal(result.completionReason, "task_complete");
```

See [examples/suspension.ts](./examples/suspension.ts) for complete working examples.

## Error Handling

- **LLM errors** - Retry with error in conversation
- **Tool parsing errors** - Report to agent for correction
- **Tool execution errors** - Caught and logged
- **Timeouts** - Configurable for LLM and tools

```typescript
const result = await runAgentSession(modelConfig, {
  llmTimeout: 60000,  // 60 seconds
  toolTimeout: 30000, // 30 seconds
  callbacks: {
    onError: async (sessionId, info) => {
      console.error(`[${sessionId}] Error in ${info.phase}:`, info.error);
      await monitoring.logError(sessionId, info);
    },
  },
});
```

## Idle Detection

If agent produces text without calling tools for 2 turns, a reminder is automatically sent:

```
REMINDER: If you have completed your task, you must call the task_complete 
tool with a summary. If you are not done yet, please continue working.
```

## Architecture

**Functional design** - Pure functions, no classes
**Event-driven** - Callbacks for all state changes
**Provider-agnostic** - Works with OpenAI, Anthropic, Ollama
**Minimal dependencies** - No MCP, no file I/O, no frameworks
**Separation of concerns** - Library handles loop, caller handles tools/persistence

## License

MIT
