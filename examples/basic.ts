// Basic example of using @waterfell/agentic-loop

import { runAgentSession } from "../src/index.js";
import { z } from "zod";

// Define some simple tools
const tools = {
  add: {
    description: "Add two numbers together",
    inputSchema: z.object({
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    }),
    execute: async ({ a, b }: { a: number; b: number }) => {
      console.log(`  [Tool] Adding ${a} + ${b}`);
      return { result: a + b };
    },
  },
  multiply: {
    description: "Multiply two numbers",
    inputSchema: z.object({
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    }),
    execute: async ({ a, b }: { a: number; b: number }) => {
      console.log(`  [Tool] Multiplying ${a} * ${b}`);
      return { result: a * b };
    },
  },
};

async function main() {
  console.log("=== Basic Agent Session Example ===\n");

  // Example 1: Simple case - await directly
  console.log("Example 1: Await directly\n");
  const result1 = await runAgentSession(
    {
      provider: "ollama",
      model: "qwen2.5:7b",
      baseURL: "http://localhost:11434",
    },
    {
      systemPrompt: `You are a helpful assistant that can do math.
When you receive a task, complete it using the available tools and then call task_complete with a summary.`,
      tools,
      initialMessage: "Please calculate (5 + 3) * 2",
      maxTurns: 10,
    },
  );

  console.log("\nResult:", result1.finalOutput);
  console.log("Session ID:", result1.sessionId);
  console.log("Completion:", result1.completionReason);
  console.log();

  // Example 2: Get sessionId immediately
  console.log("\n=== Example 2: Get sessionId immediately ===\n");
  const session = runAgentSession(
    {
      provider: "ollama",
      model: "qwen2.5:7b",
    },
    {
      sessionId: "example-session-002",
      systemPrompt: `You are a helpful assistant that can do math.
When done, call task_complete with a summary.`,
      tools,
      initialMessage: "Calculate 10 + 5",
      maxTurns: 10,
      callbacks: {
        onToolCall: (sessionId, info) => {
          console.log(`[${sessionId}] Tool: ${info.toolName}`, info.args);
        },
        onToolResult: (sessionId, info) => {
          console.log(`[${sessionId}] Result:`, info.result);
        },
        onComplete: (sessionId, info) => {
          console.log(
            `[${sessionId}] Complete: ${info.completionReason} in ${info.totalTurns} turns`,
          );
        },
      },
    },
  );

  console.log("Session started:", session.sessionId);
  console.log("Initial message:", session.initialMessage);

  const result2 = await session.promise;
  console.log("Final output:", result2.finalOutput);
  console.log();

  // Example 3: Resume from messages
  console.log("\n=== Example 3: Resume from previous messages ===\n");

  // Simulate saved messages from previous session
  const savedMessages = [
    { role: "user" as const, content: "Calculate 7 + 8" },
    { role: "assistant" as const, content: "I'll add those numbers for you." },
    // Session crashed here...
  ];

  const resumedSession = runAgentSession(
    {
      provider: "ollama",
      model: "qwen2.5:7b",
    },
    {
      sessionId: "resumed-session-003",
      systemPrompt: "You are a helpful assistant that can do math.",
      tools,
      initialMessages: savedMessages, // Resume from here
      maxTurns: 10,
    },
  );

  console.log("Resumed session:", resumedSession.sessionId);
  console.log("Continuing from", savedMessages.length, "messages");

  const result3 = await resumedSession.promise;
  console.log("Result:", result3.finalOutput);
  console.log("Total messages:", result3.messages.length);
  console.log();

  // Example 4: Summarization
  console.log("\n=== Example 4: Token limit with summarization ===\n");

  // Save last 3 messages to append after summarization
  let recentMessages: (typeof import("../src/types.js").Message)[] = [];

  const summarizationSession = runAgentSession(
    {
      provider: "ollama",
      model: "qwen2.5:7b",
    },
    {
      systemPrompt: "You are a helpful assistant that can do math.",
      tools,
      initialMessage: "Calculate 1 + 1, then 2 + 2, then 3 + 3",
      tokenLimit: 500, // Very low limit to trigger summarization quickly
      maxTurns: 15,
      callbacks: {
        // Before summarization: keep last 3 messages out of summary
        onBeforeSummarize: (sessionId, messages) => {
          console.log(`[${sessionId}] Before: ${messages.length} messages`);
          recentMessages = messages.slice(-3);
          const toSummarize = messages.slice(0, -3);
          console.log(`  Summarizing ${toSummarize.length} messages`);
          return toSummarize;
        },
        // After summarization: append the 3 recent messages we kept
        onAfterSummarize: (sessionId, summarizedMessages) => {
          console.log(`  Summary: ${summarizedMessages.length} messages`);
          const final = [...summarizedMessages, ...recentMessages];
          console.log(`[${sessionId}] After: ${final.length} messages`);
          return final;
        },
      },
    },
  );

  console.log("Session with summarization:", summarizationSession.sessionId);
  const result4 = await summarizationSession.promise;
  console.log("Result:", result4.finalOutput);
  console.log();

  console.log("=== All examples complete ===");
}

main().catch(console.error);
