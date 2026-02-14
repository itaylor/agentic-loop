# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2024-02-12

### Added
- **Session object return value**: `runAgentSession()` now returns immediately with an `AgentSession` object containing:
  - `sessionId` - Available immediately, no need to wait for completion
  - `initialMessage` - The message that started/resumed the session
  - `promise` - Promise that resolves when session completes
  - Session object is "thenable" - can be awaited directly for simple cases
- **Session resumption**: New `initialMessages` parameter in `AgentSessionConfig`
  - Pass array of previous messages to resume a session after crash/restart
  - Automatically continues from where it left off
  - Useful for server restarts and crash recovery
- **Internal summarization**: Library now handles LLM calls for summarization
  - New `onBeforeSummarize` callback to modify messages before summarization
  - New `onAfterSummarize` callback to modify messages after summarization
  - Library calls the LLM internally - no setup needed by caller
  - Default behavior: summarize ALL messages (callbacks let you customize)
  - Simple, consistent API - both callbacks just transform message arrays

### Changed
- **Breaking**: `runAgentSession()` now returns `AgentSession` instead of `Promise<AgentSessionResult>`
  - Simple case: Still works with `await runAgentSession(...)`
  - Advanced case: Get `sessionId` immediately without waiting
- **Breaking**: Removed `onSummarize` callback (was leaky abstraction)
  - Replaced with `onBeforeSummarize` and `onAfterSummarize`
  - Library now handles all LLM interaction for summarization
- Return value now includes both immediate access to metadata and the completion promise

### Migration from 0.1.x

**Before:**
```typescript
const result = await runAgentSession(modelConfig, sessionConfig);
console.log("Session ID:", result.sessionId); // Had to wait for completion
```

**After (simple):**
```typescript
const result = await runAgentSession(modelConfig, sessionConfig);
console.log("Session ID:", result.sessionId); // Still works!
```

**After (advanced):**
```typescript
const session = runAgentSession(modelConfig, sessionConfig);
console.log("Session ID:", session.sessionId); // Available immediately!
await logSessionStart(session.sessionId);
const result = await session.promise;
```

**Summarization (new simplified design):**
```typescript
const result = await runAgentSession(modelConfig, {
  tokenLimit: 100000,
  callbacks: {
    // Optional: modify messages before summarization
    onBeforeSummarize: (sessionId, messages) => {
      // Return messages to summarize (default: all messages)
      return messages.slice(0, -10); // Example: keep last 10 out of summary
    },
    // Optional: modify messages after summarization
    onAfterSummarize: (sessionId, summarizedMessages) => {
      // Return final message array
      return [...summarizedMessages, ...recentMessages]; // Example: append recent
    },
  },
});
```

Simple, consistent API - both callbacks just transform message arrays. Library handles the LLM call.

**Resume after crash:**
```typescript
const savedMessages = await db.loadMessages(sessionId);
const session = runAgentSession(modelConfig, {
  sessionId,
  initialMessages: savedMessages, // Resume from here
  // ... rest of config
});
```

## [0.1.1] - 2024-02-12

### Added
- **sessionId support**: Sessions now include an optional `sessionId` parameter in `AgentSessionConfig`
  - If not provided, a UUID is automatically generated
  - The `sessionId` is passed as the first parameter to all callbacks
  - The `sessionId` is included in `AgentSessionResult`
  - This makes persistence and tracking much cleaner - no need for closure variables

### Changed
- **Breaking**: All callback signatures now include `sessionId` as the first parameter:
  - `onTurnStart(sessionId, turn)` - was `onTurnStart(turn)`
  - `onAssistantMessage(sessionId, text, turn)` - was `onAssistantMessage(text, turn)`
  - `onToolCall(sessionId, info)` - was `onToolCall(info)`
  - `onToolResult(sessionId, info)` - was `onToolResult(info)`
  - `onError(sessionId, info)` - was `onError(info)`
  - `onComplete(sessionId, info)` - was `onComplete(info)`
  - `onMessagesUpdate(sessionId, messages)` - was `onMessagesUpdate(messages)`
  - `onSummarize(sessionId, messages)` - was `onSummarize(messages)`

### Migration Guide for 0.1.0 → 0.1.1

**Before:**
```typescript
await runAgentSession(modelConfig, {
  systemPrompt: "...",
  tools: myTools,
  callbacks: {
    onToolCall: (info) => {
      const sessionId = "my-session"; // Had to use closure
      await db.saveToolCall(sessionId, info);
    }
  }
});
```

**After:**
```typescript
await runAgentSession(modelConfig, {
  sessionId: "my-session", // Provide sessionId in config
  systemPrompt: "...",
  tools: myTools,
  callbacks: {
    onToolCall: (sessionId, info) => {
      // sessionId passed directly
      await db.saveToolCall(sessionId, info);
    }
  }
});
```

Or let it be auto-generated:
```typescript
const result = await runAgentSession(modelConfig, {
  // No sessionId provided - auto-generated UUID
  systemPrompt: "...",
  tools: myTools,
});

console.log("Session ID:", result.sessionId); // UUID like "a1b2c3d4-..."
```

## [0.1.0] - 2024-02-12

### Added
- Initial release of `@waterfell/agentic-loop`
- Core agentic loop implementation with multi-turn conversations
- Support for multiple LLM providers (OpenAI, Anthropic, Ollama)
- Built-in `task_complete` tool for graceful session termination
- Error handling and automatic retry logic
- Idle agent detection with automatic reminders
- Token-based summarization hooks
- Event-driven callback system for all state changes
- Custom logger support
- MCP tool compatibility
- Configurable timeouts for LLM and tool calls
- Functional design pattern throughout
- Comprehensive documentation suite
- Working examples

### Features
- Multi-turn conversation management
- Tool calling with automatic execution
- Provider abstraction via Vercel AI SDK
- Graceful error recovery
- Session completion tracking
- Message history management
- Configurable turn limits
- Event callbacks for monitoring and persistence

### Documentation
- README.md - Full API documentation
- ARCHITECTURE.md - Technical design details
- MIGRATION.md - Integration guide
- QUICK_START.md - Getting started guide
- SUMMARY.md - Feature overview
- PROJECT_SUMMARY.md - Project overview
- INTEGRATION_CHECKLIST.md - Integration checklist
- examples/basic.ts - Working example

[0.2.0]: https://github.com/yourusername/agentic-loop/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/yourusername/agentic-loop/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yourusername/agentic-loop/releases/tag/v0.1.0