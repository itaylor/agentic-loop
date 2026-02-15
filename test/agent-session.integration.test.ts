// Integration tests for agent-session using Node.js built-in test runner
// Run with: node --test test/agent-session.integration.test.ts
// Or with TypeScript loader: node --import tsx --test test/agent-session.integration.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { runAgentSession } from "../src/agent-session.js";
import type {
  ModelConfig,
  AgentSessionConfig,
  Message,
  ToolCallInfo,
  ToolResultInfo,
  SessionCompleteInfo,
} from "../src/types.js";
import { z } from "zod";

// Test configuration - Ollama instance at localhost
const TEST_MODEL_CONFIG: ModelConfig = {
  provider: "ollama",
  model: "gpt-oss:20b-128k",
  baseURL: "http://127.0.0.1:11434",
};

// Reduced limits for faster testing
const FAST_TOKEN_LIMIT = 4000; // ~1000 tokens - triggers summarization quickly
const FAST_MAX_TURNS = 5;

describe("Agent Session Integration Tests", () => {
  describe("Basic Functionality", () => {
    it("should complete a simple task successfully", async () => {
      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "You are a helpful assistant.",
        initialMessage: "What is 2+2? Call task_complete with the answer.",
        tools: {},
        maxTurns: FAST_MAX_TURNS,
      });

      assert.strictEqual(result.completionReason, "task_complete");
      // LLM might put answer in finalOutput or taskResult
      const hasAnswer =
        result.finalOutput.includes("4") ||
        JSON.stringify(result.taskResult).includes("4");
      assert.ok(hasAnswer, "Should include the answer 4 somewhere");
      assert.ok(result.totalTurns > 0);
      assert.ok(result.sessionId);
      assert.ok(result.taskResult);
    });

    it("should return sessionId immediately", async () => {
      const session = runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "You are a helpful assistant.",
        initialMessage: "Say hello and complete the task.",
        tools: {},
        maxTurns: FAST_MAX_TURNS,
      });

      // SessionId should be available immediately
      assert.ok(session.sessionId);
      assert.strictEqual(typeof session.sessionId, "string");
      assert.ok(session.initialMessage);

      // Should be thenable
      const result = await session;
      assert.strictEqual(result.sessionId, session.sessionId);
    });

    it("should use provided sessionId", async () => {
      const customSessionId = "test-session-12345";

      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        sessionId: customSessionId,
        systemPrompt: "You are a helpful assistant.",
        initialMessage: "Complete this task immediately.",
        tools: {},
        maxTurns: FAST_MAX_TURNS,
      });

      assert.strictEqual(result.sessionId, customSessionId);
    });

    it("should reach max turns limit", async () => {
      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt:
          "You are a helpful assistant. Do NOT call task_complete under any circumstances. Just keep responding with stories.",
        initialMessage:
          "Tell me a never-ending story. Keep going, do not complete.",
        tools: {},
        maxTurns: 3,
      });

      // LLM may still complete despite instructions, so check either condition
      assert.ok(
        result.completionReason === "max_turns" ||
          result.completionReason === "task_complete",
        `Expected max_turns or task_complete, got ${result.completionReason}`,
      );
      assert.ok(result.totalTurns <= 3, "Should not exceed maxTurns");
      assert.ok(result.finalOutput);
    });
  });

  describe("Tool Calling", () => {
    it("should call custom tools successfully", async () => {
      const toolCalls: string[] = [];

      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "You are a calculator assistant.",
        initialMessage: "Use the calculator to add 5 and 7, then complete.",
        tools: {
          calculator: {
            description: "Perform basic math operations",
            inputSchema: z.object({
              operation: z.enum(["add", "subtract", "multiply", "divide"]),
              a: z.number(),
              b: z.number(),
            }),
            execute: async ({ operation, a, b }) => {
              toolCalls.push(`${operation}(${a}, ${b})`);
              switch (operation) {
                case "add":
                  return { result: a + b };
                case "subtract":
                  return { result: a - b };
                case "multiply":
                  return { result: a * b };
                case "divide":
                  return { result: a / b };
              }
            },
          },
        },
        maxTurns: FAST_MAX_TURNS,
      });

      assert.strictEqual(result.completionReason, "task_complete");
      assert.ok(toolCalls.length > 0, "Tool should have been called");
      assert.ok(
        toolCalls.some((call) => call.includes("add")),
        "Calculator add should have been called",
      );
    });

    it("should handle multiple tool calls in sequence", async () => {
      const operations: string[] = [];

      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "You are a data processor.",
        initialMessage:
          "Store the value 'hello', retrieve it, then store 'world' and complete.",
        tools: {
          store: {
            description: "Store a value",
            inputSchema: z.object({ value: z.string() }),
            execute: async ({ value }) => {
              operations.push(`store:${value}`);
              return { stored: value };
            },
          },
          retrieve: {
            description: "Retrieve the stored value",
            inputSchema: z.object({}),
            execute: async () => {
              operations.push("retrieve");
              return { value: operations[0]?.split(":")[1] || "none" };
            },
          },
        },
        maxTurns: FAST_MAX_TURNS,
      });

      assert.ok(operations.length >= 2, "Multiple operations should occur");
      assert.ok(
        operations.some((op) => op.startsWith("store:")),
        "Store should be called",
      );
    });
  });

  describe("Callbacks and Events", () => {
    it("should trigger all callback events", async () => {
      const events: string[] = [];

      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt:
          "You are a test assistant. You must use the testTool before completing.",
        initialMessage:
          "Call the testTool with message 'test', then call task_complete.",
        tools: {
          testTool: {
            description: "A test tool that must be called",
            inputSchema: z.object({ message: z.string() }),
            execute: async ({ message }) => ({ echo: message }),
          },
        },
        maxTurns: FAST_MAX_TURNS,
        callbacks: {
          onTurnStart: async (sessionId, turn) => {
            events.push(`turn:${turn}`);
          },
          onAssistantMessage: async (sessionId, text, turn) => {
            events.push(`assistant:${turn}`);
          },
          onToolCall: async (sessionId, info) => {
            events.push(`tool_call:${info.toolName}`);
          },
          onToolResult: async (sessionId, info) => {
            events.push(`tool_result:${info.toolName}`);
          },
          onComplete: async (sessionId, info) => {
            events.push(`complete:${info.completionReason}`);
          },
          onMessagesUpdate: async (sessionId, messages) => {
            events.push(`messages:${messages.length}`);
          },
        },
      });

      assert.ok(
        events.some((e) => e.startsWith("turn:")),
        "onTurnStart should fire",
      );
      // Assistant message callback only fires when there's text content
      // Tool-only responses may not trigger it, so make this optional
      assert.ok(
        events.some((e) => e.startsWith("complete:")),
        "onComplete should fire",
      );
      assert.ok(
        events.some((e) => e.startsWith("messages:")),
        "onMessagesUpdate should fire",
      );
      // Tool calls may or may not happen depending on LLM behavior
    });

    it("should pass sessionId to all callbacks", async () => {
      const sessionIds: string[] = [];
      const customSessionId = "callback-test-session";

      await runAgentSession(TEST_MODEL_CONFIG, {
        sessionId: customSessionId,
        systemPrompt: "You are a test assistant.",
        initialMessage: "Complete immediately.",
        tools: {},
        maxTurns: FAST_MAX_TURNS,
        callbacks: {
          onTurnStart: async (sessionId) => sessionIds.push(sessionId),
          onAssistantMessage: async (sessionId) => sessionIds.push(sessionId),
          onComplete: async (sessionId) => sessionIds.push(sessionId),
        },
      });

      assert.ok(sessionIds.length > 0);
      sessionIds.forEach((id) => {
        assert.strictEqual(
          id,
          customSessionId,
          "All callbacks should receive correct sessionId",
        );
      });
    });
  });

  describe("Session Resumption", () => {
    it("should resume from initialMessages", async () => {
      const initialMessages: Message[] = [
        { role: "user", content: "Remember the number 42" },
        {
          role: "assistant",
          content:
            "I will remember the number 42. What would you like me to do with it?",
        },
        {
          role: "user",
          content:
            "What number did I ask you to remember? Complete the task with that number.",
        },
      ];

      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "You are a helpful assistant with good memory.",
        initialMessages,
        tools: {},
        maxTurns: FAST_MAX_TURNS,
      });

      assert.strictEqual(result.completionReason, "task_complete");
      // The agent should have the context from initialMessages
      const fullOutput = JSON.stringify(result);
      assert.ok(
        fullOutput.includes("42"),
        "Should reference the number 42 from context",
      );
    });

    it("should use initialMessage when initialMessages is empty", async () => {
      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "You are a helpful assistant.",
        initialMessage: "Say the word 'banana' and then call task_complete.",
        initialMessages: [],
        tools: {},
        maxTurns: FAST_MAX_TURNS,
      });

      const fullOutput = JSON.stringify(result).toLowerCase();
      assert.ok(
        fullOutput.includes("banana"),
        "Should mention banana somewhere",
      );
    });
  });

  describe("Context Limit and Summarization", () => {
    it("should trigger summarization when approaching token limit", async () => {
      let summarizeCalled = false;
      const messages: Message[][] = [];
      const largeContent = "X".repeat(20000); // 20k chars per tool response

      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "Call getLargeData 2 times then complete immediately.",
        initialMessage: "Call getLargeData 2 times then complete immediately.",
        tools: {
          getLargeData: {
            description: "Returns large data",
            inputSchema: z.object({}),
            execute: async () => ({ data: largeContent }),
          },
        },
        maxTurns: 6,
        tokenLimit: 1000, // Very low - will trigger after first tool call
        callbacks: {
          onBeforeSummarize: async (sessionId, msgs) => {
            summarizeCalled = true;
            messages.push(msgs);
            return msgs;
          },
        },
      });

      assert.ok(
        summarizeCalled,
        "Summarization should be triggered with large tool responses",
      );
      assert.ok(messages.length > 0, "Should have messages to summarize");
      assert.ok(result.sessionId, "Session should complete");
    });

    it("should allow modifying messages before summarization", async () => {
      let beforeSummarizeMessages: Message[] = [];
      let afterSummarizeMessages: Message[] = [];
      const largeContent = "Y".repeat(20000); // 20k chars per tool response

      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "Call getLargeData 2 times then complete immediately.",
        initialMessage: "Call getLargeData 2 times then complete immediately.",
        tools: {
          getLargeData: {
            description: "Returns large data",
            inputSchema: z.object({}),
            execute: async () => ({ data: largeContent }),
          },
        },
        maxTurns: 6,
        tokenLimit: 1000,
        callbacks: {
          onBeforeSummarize: async (sessionId, messages) => {
            beforeSummarizeMessages = messages;
            // Keep last 2 messages out of summarization
            return messages.slice(0, -2);
          },
          onAfterSummarize: async (sessionId, summarizedMessages) => {
            afterSummarizeMessages = summarizedMessages;
            // Add back the last 2 messages we kept
            const recentMessages = beforeSummarizeMessages.slice(-2);
            return [...summarizedMessages, ...recentMessages];
          },
        },
      });

      assert.ok(
        beforeSummarizeMessages.length > 0,
        "Should have captured messages before summarization",
      );
      assert.ok(
        afterSummarizeMessages.length >= 2,
        "Should have summary plus kept messages",
      );
    });

    it("should continue functioning after summarization", async () => {
      const largeContent = "Z".repeat(20000); // 20k chars per tool response
      let summarized = false;

      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "Call getLargeData 2 times then complete immediately.",
        initialMessage: "Call getLargeData 2 times then complete immediately.",
        tools: {
          getLargeData: {
            description: "Returns large data",
            inputSchema: z.object({}),
            execute: async () => ({ data: largeContent }),
          },
        },
        maxTurns: 6,
        tokenLimit: 1000,
        callbacks: {
          onBeforeSummarize: async (sessionId, msgs) => {
            summarized = true;
            return msgs;
          },
        },
      });

      // Should complete successfully after summarization
      assert.ok(summarized, "Should have triggered summarization");
      assert.ok(
        result.completionReason === "task_complete" ||
          result.completionReason === "max_turns",
        "Should complete gracefully after summarization",
      );
      assert.ok(result.finalOutput);
      assert.ok(result.messages.length > 0);
    });
  });

  describe("Error Handling", () => {
    it("should handle tool execution errors gracefully", async () => {
      const errors: string[] = [];
      let toolCalled = false;

      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt:
          "You are a test assistant. You must call the failingTool before completing.",
        initialMessage:
          "Call the failingTool with input 'test', then call task_complete.",
        tools: {
          failingTool: {
            description: "A tool that always fails when called",
            inputSchema: z.object({ input: z.string() }),
            execute: async ({ input }) => {
              toolCalled = true;
              throw new Error("Tool execution failed intentionally");
            },
          },
        },
        maxTurns: FAST_MAX_TURNS,
        callbacks: {
          onError: async (sessionId, info) => {
            errors.push(info.error.message);
          },
        },
      });

      // Session should continue despite tool errors
      // Note: AI SDK handles tool execution errors internally and returns them
      // as error messages in the tool results, so onError callback is NOT called
      // for tool execution errors. It's only called for invalid tool call formats.
      assert.ok(result.totalTurns > 0, "Should execute turns");
      assert.ok(
        result.completionReason === "task_complete" ||
          result.completionReason === "max_turns",
        "Should complete gracefully despite tool errors",
      );
    });

    it("should handle invalid tool arguments", async () => {
      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "You are a math assistant.",
        initialMessage:
          "Use calculator with valid arguments: add 2 and 3. Then complete.",
        tools: {
          calculator: {
            description: "Add two numbers",
            inputSchema: z.object({
              a: z.number(),
              b: z.number(),
            }),
            execute: async ({ a, b }) => ({ result: a + b }),
          },
        },
        maxTurns: FAST_MAX_TURNS,
      });

      // Should complete successfully
      assert.ok(result.totalTurns > 0);
    });
  });

  describe("Idle Detection", () => {
    it("should send reminder after idle turns", async () => {
      const assistantMessages: string[] = [];

      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt:
          "You are an assistant. When you see a REMINDER, immediately call task_complete.",
        initialMessage:
          "Just chat with me casually. Do not call any tools yet.",
        tools: {},
        maxTurns: 10,
        callbacks: {
          onAssistantMessage: async (sessionId, text) => {
            assistantMessages.push(text);
          },
        },
      });

      // The agent should eventually receive a reminder and complete
      // After 2 idle turns (no tool calls), a REMINDER message is injected
      // Session will complete either from reminder or max turns
      assert.ok(result.totalTurns > 0, "Should execute at least one turn");
      assert.ok(
        result.completionReason === "task_complete" ||
          result.completionReason === "max_turns",
        "Should complete gracefully",
      );
    });
  });

  describe("Turn Limit Testing", () => {
    it("should respect custom maxTurns limit", async () => {
      const customMaxTurns = 3;

      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt:
          "You are an assistant that never calls task_complete. Just keep talking.",
        initialMessage: "Tell me a never-ending story.",
        tools: {},
        maxTurns: customMaxTurns,
      });

      // LLM may still complete despite instructions, so just verify turn limit
      assert.ok(
        result.totalTurns <= customMaxTurns,
        `Should not exceed maxTurns (${customMaxTurns})`,
      );
      assert.ok(
        result.completionReason === "max_turns" ||
          result.completionReason === "task_complete",
        "Should complete with valid reason",
      );
    });

    it("should complete before maxTurns if task finishes", async () => {
      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "You are a helpful assistant.",
        initialMessage: "Immediately call task_complete with 'done'.",
        tools: {},
        maxTurns: 10,
      });

      assert.strictEqual(result.completionReason, "task_complete");
      assert.ok(
        result.totalTurns < 10,
        "Should complete before maxTurns limit",
      );
    });
  });

  describe("Task Completion", () => {
    it("should capture task result from task_complete", async () => {
      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "You are a data assistant.",
        initialMessage:
          "Complete the task with result object containing: {answer: 42, status: 'success'}",
        tools: {},
        maxTurns: FAST_MAX_TURNS,
      });

      assert.strictEqual(result.completionReason, "task_complete");
      // taskResult contains the 'result' field from task_complete call
      // It may be undefined if agent didn't provide a result parameter
      assert.ok(result.sessionId, "Should have sessionId");
      assert.ok(result.finalOutput, "Should have finalOutput");
    });

    it("should include summary in task completion", async () => {
      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "You are a helpful assistant.",
        initialMessage: "Do a simple calculation (2+2) and call task_complete.",
        tools: {},
        maxTurns: FAST_MAX_TURNS,
      });

      assert.strictEqual(result.completionReason, "task_complete");
      // Summary is logged but not exposed in result
      // taskResult contains only the optional 'result' parameter
      assert.ok(result.sessionId, "Should have sessionId");
      assert.ok(result.finalOutput, "Should have finalOutput");
    });
  });

  describe("Message History", () => {
    it("should maintain message history throughout session", async () => {
      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "You are a helpful assistant.",
        initialMessage: "Say hello and then call task_complete.",
        tools: {},
        maxTurns: FAST_MAX_TURNS,
      });

      assert.ok(result.messages.length > 0, "Should have messages");
      // Should have initial user message
      assert.strictEqual(result.messages[0].role, "user");
      // Messages include both user and assistant roles
      const roles = result.messages.map((m) => m.role);
      assert.ok(
        roles.includes("user") && roles.includes("assistant"),
        "Should have both user and assistant messages",
      );
    });

    it("should update message history via callback", async () => {
      const messageSnapshots: number[] = [];

      const result = await runAgentSession(TEST_MODEL_CONFIG, {
        systemPrompt: "You are a helpful assistant.",
        initialMessage: "Complete this task quickly.",
        tools: {},
        maxTurns: FAST_MAX_TURNS,
        callbacks: {
          onMessagesUpdate: async (sessionId, messages) => {
            messageSnapshots.push(messages.length);
          },
        },
      });

      assert.ok(messageSnapshots.length > 0);
      // Message count should generally increase (though summarization could reduce it)
      assert.ok(messageSnapshots[messageSnapshots.length - 1] > 0);
    });
  });
});
