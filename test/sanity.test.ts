// Quick sanity test to verify Ollama is running and accessible
// Run with: node --import tsx --test test/sanity.test.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { runAgentSession } from "../src/agent-session.js";
import type { ModelConfig } from "../src/types.js";

const TEST_MODEL_CONFIG: ModelConfig = process.env.OPENAI_API_KEY
  ? { provider: "openai", model: "gpt-4.1-nano" }
  : {
      provider: "ollama",
      model: "gpt-oss:20b-128k",
      baseURL: "http://127.0.0.1:11434",
    };

describe("Sanity Test", () => {
  it("should connect to Ollama and complete a simple task", async () => {
    const result = await runAgentSession(TEST_MODEL_CONFIG, {
      systemPrompt: "You are a helpful assistant.",
      initialMessage: "Say 'hello' and immediately call task_complete.",
      tools: {},
      maxTurns: 3,
    });

    assert.ok(result.sessionId, "Should have a sessionId");
    assert.ok(result.finalOutput, "Should have finalOutput");
    assert.ok(result.totalTurns > 0, "Should have executed at least one turn");
    assert.ok(
      ["task_complete", "max_turns"].includes(result.completionReason),
      "Should complete with valid reason",
    );

    console.log("✓ Ollama connection verified");
    console.log(`  Session ID: ${result.sessionId}`);
    console.log(`  Completion: ${result.completionReason}`);
    console.log(`  Turns: ${result.totalTurns}`);
  });
});
