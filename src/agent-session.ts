// Agent session - core agentic loop implementation using functional approach

import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { ollama } from "ai-sdk-ollama";
import { generateText } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  ModelConfig,
  AgentSessionConfig,
  AgentSessionResult,
  AgentSession,
  SessionState,
  Message,
  defaultLogger,
  Logger,
  ToolCallInfo,
  ToolResultInfo,
  ErrorInfo,
  SessionCompleteInfo,
} from "./types.js";

/**
 * Get the appropriate model instance based on provider configuration
 */
function getModelInstance(config: ModelConfig) {
  switch (config.provider) {
    case "openai":
      if (!config.apiKey) {
        throw new Error(
          "API key is required for OpenAI provider. Please provide it in ModelConfig.",
        );
      }
      process.env.OPENAI_API_KEY = config.apiKey;
      return openai(config.model);

    case "anthropic":
      if (!config.apiKey) {
        throw new Error(
          "API key is required for Anthropic provider. Please provide it in ModelConfig.",
        );
      }
      process.env.ANTHROPIC_API_KEY = config.apiKey;
      return anthropic(config.model);

    case "ollama":
      if (config.baseURL) {
        process.env.OLLAMA_BASE_URL = config.baseURL;
      }
      return ollama(config.model);

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Create the built-in task_complete tool
 */
function createTaskCompleteTool(): Tool {
  return {
    description:
      "Mark the current task as complete. Call this when you have finished all work and deliverables. Provide a summary of what was accomplished.",
    inputSchema: z.object({
      summary: z
        .string()
        .describe("Summary of what was accomplished and delivered"),
      result: z.any().optional().describe("Optional structured result data"),
    }),
    execute: async (args: { summary: string; result?: any }) => {
      // Return a special signal that will be caught by the session runner
      return {
        __task_complete__: true,
        summary: args.summary,
        result: args.result,
      };
    },
  };
}

/**
 * Create a reminder tool (internal use - for nudging agents who go idle)
 */
function createReminderMessage(): string {
  return `REMINDER: If you have completed your task, you must call the task_complete tool with a summary of what you accomplished. If you are not done yet, please continue working or explain what you need.`;
}

/**
 * Estimate token count (rough approximation)
 * This is a simple heuristic: ~4 characters per token
 */
function estimateTokenCount(messages: Message[]): number {
  const totalChars = messages.reduce((sum, msg) => {
    const content = msg.content;
    // Handle both string content (text messages) and array content (tool calls/results)
    if (typeof content === "string") {
      return sum + content.length;
    }
    // AI SDK messages with tool calls have content as arrays
    // Stringify to get actual character count
    return sum + JSON.stringify(content).length;
  }, 0);
  return Math.ceil(totalChars / 4);
}

/**
 * Summarize messages using the LLM
 */
async function summarizeMessages(
  modelConfig: ModelConfig,
  messages: Message[],
): Promise<string> {
  const conversationText = messages
    .map((m) => {
      const content = m.content;
      const contentStr =
        typeof content === "string" ? content : JSON.stringify(content);
      return `${m.role}: ${contentStr}`;
    })
    .join("\n\n");

  const summaryPrompt = `Summarize the following conversation concisely, preserving all key decisions, facts, context, and important details. Focus on what was accomplished and what information is essential for continuing the conversation:\n\n${conversationText}`;

  const result = await generateText({
    model: getModelInstance(modelConfig),
    prompt: summaryPrompt,
  });

  return result.text;
}

/**
 * Run a single turn of the agentic loop
 */
async function runTurn(
  modelConfig: ModelConfig,
  sessionConfig: AgentSessionConfig,
  state: SessionState,
  logger: Logger,
  sessionId: string,
): Promise<void> {
  state.turnCount++;
  logger.trace(`Starting turn ${state.turnCount}`);

  // Notify turn start
  if (sessionConfig.callbacks?.onTurnStart) {
    await sessionConfig.callbacks.onTurnStart(sessionId, state.turnCount);
  }

  // Merge tools with built-in task_complete
  const allTools = {
    ...sessionConfig.tools,
    task_complete: createTaskCompleteTool(),
  };

  let result: any;
  try {
    // Call LLM with timeout if specified
    const generatePromise = generateText({
      model: getModelInstance(modelConfig),
      system: sessionConfig.systemPrompt,
      messages: state.messages,
      tools: allTools,
    });

    if (sessionConfig.llmTimeout) {
      result = (await Promise.race([
        generatePromise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("LLM call timeout")),
            sessionConfig.llmTimeout,
          ),
        ),
      ])) as Awaited<ReturnType<typeof generateText>>;
    } else {
      result = await generatePromise;
    }
  } catch (error: any) {
    // LLM call error - notify and add to conversation for retry
    logger.error(`LLM call error on turn ${state.turnCount}: ${error.message}`);

    const errorInfo: ErrorInfo = {
      error,
      turn: state.turnCount,
      phase: "llm",
    };

    if (sessionConfig.callbacks?.onError) {
      await sessionConfig.callbacks.onError(sessionId, errorInfo);
    }

    // Add error to conversation so agent can retry
    const retryMessage = `ERROR: LLM call failed with: ${error.message}\n\nPlease try again.`;
    state.messages.push({
      role: "user",
      content: retryMessage,
    });

    if (sessionConfig.callbacks?.onMessagesUpdate) {
      await sessionConfig.callbacks.onMessagesUpdate(sessionId, state.messages);
    }

    return; // Continue to next turn
  }

  // Log assistant response
  if (result.text) {
    logger.trace(`Assistant response: ${result.text.substring(0, 200)}...`);
    state.finalOutput = result.text;

    if (sessionConfig.callbacks?.onAssistantMessage) {
      await sessionConfig.callbacks.onAssistantMessage(
        sessionId,
        result.text,
        state.turnCount,
      );
    }
  }

  // Handle tool calls
  if (result.toolCalls && result.toolCalls.length > 0) {
    logger.trace(`Tool calls: ${result.toolCalls.length}`);

    for (const toolCall of result.toolCalls) {
      const tc = toolCall as any;

      // Check for invalid tool calls
      if (tc.invalid === true) {
        const error = new Error(
          tc.error?.message || "Invalid tool call format",
        );
        const errorInfo: ErrorInfo = {
          error,
          turn: state.turnCount,
          phase: "tool_call",
        };

        logger.error(`Invalid tool call for ${tc.toolName}: ${error.message}`);

        if (sessionConfig.callbacks?.onError) {
          await sessionConfig.callbacks.onError(sessionId, errorInfo);
        }
        continue;
      }

      const args = tc.input;

      // Notify tool call
      const toolCallInfo: ToolCallInfo = {
        toolName: tc.toolName,
        args,
        turn: state.turnCount,
      };

      logger.trace(`Tool call: ${tc.toolName}`, args);

      if (sessionConfig.callbacks?.onToolCall) {
        await sessionConfig.callbacks.onToolCall(sessionId, toolCallInfo);
      }
    }

    // Execute tool results (they're already available from generateText)
    if (result.toolResults && result.toolResults.length > 0) {
      for (const toolResult of result.toolResults) {
        const tr = toolResult as any;
        const resultData = tr.output;

        // Check for task completion
        if (
          resultData &&
          typeof resultData === "object" &&
          resultData.__task_complete__
        ) {
          logger.info(`Task completed: ${resultData.summary}`);
          state.shouldContinue = false;
          state.completionReason = "task_complete";
          state.taskResult = resultData.result;

          // Add SDK's response messages (includes tool calls and results)
          state.messages.push(...result.response.messages);

          // Add completion message
          state.messages.push({
            role: "user",
            content: `Task marked as complete. Session ending.`,
          });

          return;
        }

        // Notify tool result
        const toolResultInfo: ToolResultInfo = {
          toolName: tr.toolName,
          result: resultData,
          turn: state.turnCount,
        };

        logger.trace(`Tool result: ${tr.toolName}`, resultData);

        if (sessionConfig.callbacks?.onToolResult) {
          await sessionConfig.callbacks.onToolResult(sessionId, toolResultInfo);
        }
      }
    }

    // Add SDK's response messages (includes assistant message with tool calls and tool result messages)
    // This is the proper format that includes tool call IDs and can be fed back to the LLM
    state.messages.push(...result.response.messages);
  } else {
    // No tool calls - agent produced final response without completing task
    // Add SDK's response message (assistant message with text)
    state.messages.push(...result.response.messages);

    // Don't end the session - agent might be thinking or waiting
    // The idle check will nudge them if needed
  }

  // Notify message history update
  if (sessionConfig.callbacks?.onMessagesUpdate) {
    await sessionConfig.callbacks.onMessagesUpdate(sessionId, state.messages);
  }

  // Check for token limit and trigger summarization
  if (sessionConfig.tokenLimit) {
    const estimatedTokens = estimateTokenCount(state.messages);
    if (estimatedTokens > sessionConfig.tokenLimit) {
      logger.info(
        `Token limit approaching (${estimatedTokens}/${sessionConfig.tokenLimit}), triggering summarization`,
      );
      try {
        const originalCount = state.messages.length;

        // Let caller modify messages before summarization (optional)
        let messagesToSummarize = state.messages;
        if (sessionConfig.callbacks?.onBeforeSummarize) {
          messagesToSummarize = await sessionConfig.callbacks.onBeforeSummarize(
            sessionId,
            state.messages,
          );
          logger.trace(
            `onBeforeSummarize: ${state.messages.length} → ${messagesToSummarize.length} messages`,
          );
        }

        // Call LLM to do the summarization
        const summary = await summarizeMessages(
          modelConfig,
          messagesToSummarize,
        );

        // Build new message array with summary
        let summarizedMessages: Message[] = [
          {
            role: "user",
            content: "Previous conversation summary:",
          },
          {
            role: "assistant",
            content: summary,
          },
        ];

        // Let caller modify messages after summarization (optional)
        if (sessionConfig.callbacks?.onAfterSummarize) {
          summarizedMessages = await sessionConfig.callbacks.onAfterSummarize(
            sessionId,
            summarizedMessages,
          );
          logger.trace(
            `onAfterSummarize: 2 → ${summarizedMessages.length} messages`,
          );
        }

        state.messages = summarizedMessages;

        logger.info(
          `Messages summarized: ${originalCount} → ${state.messages.length}`,
        );

        // Notify message history update
        if (sessionConfig.callbacks?.onMessagesUpdate) {
          await sessionConfig.callbacks.onMessagesUpdate(
            sessionId,
            state.messages,
          );
        }
      } catch (error: any) {
        logger.error(`Summarization failed: ${error.message}`);
      }
    }
  }
}

/**
 * Check if the agent seems idle (last message was from assistant, no tool calls)
 */
function isAgentIdle(state: SessionState): boolean {
  if (state.messages.length === 0) return false;

  const lastMessage = state.messages[state.messages.length - 1];
  return lastMessage.role === "assistant";
}

/**
 * Run an agent session with the agentic loop
 * Returns immediately with session object containing sessionId and promise
 */
export function runAgentSession(
  modelConfig: ModelConfig,
  sessionConfig: AgentSessionConfig,
): AgentSession {
  const logger = sessionConfig.logger || defaultLogger;
  const maxTurns = sessionConfig.maxTurns || 50;
  const sessionId = sessionConfig.sessionId || randomUUID();

  // Determine initial messages
  const initialMessages = sessionConfig.initialMessages || [];
  let derivedInitialMessage: string;

  if (initialMessages.length > 0) {
    // Resuming from previous messages
    derivedInitialMessage = `Resumed from ${initialMessages.length} previous messages`;
    logger.info(
      `Resuming session ${sessionId} from ${initialMessages.length} messages`,
    );
  } else {
    // New session
    derivedInitialMessage =
      sessionConfig.initialMessage || "Begin working on your assigned task.";
    logger.info(`Starting new session: ${sessionId}`);
  }

  logger.info(`  Provider: ${modelConfig.provider}`);
  logger.info(`  Model: ${modelConfig.model}`);
  logger.info(`  Max turns: ${maxTurns}`);

  // Initialize session state
  const state: SessionState = {
    messages: initialMessages.length > 0 ? [...initialMessages] : [],
    turnCount: Math.floor(initialMessages.length / 2), // Rough estimate of turns from messages
    finalOutput: "",
    shouldContinue: true,
    completionReason: "max_turns",
  };

  // If no initial messages, add the initial user message
  if (initialMessages.length === 0) {
    state.messages.push({
      role: "user",
      content: derivedInitialMessage,
    });
  } else if (initialMessages[initialMessages.length - 1].role === "assistant") {
    // If resuming and last message was assistant, add continuation prompt
    state.messages.push({
      role: "user",
      content: "Please continue.",
    });
  }

  // Create the promise that executes the session
  const promise = (async (): Promise<AgentSessionResult> => {
    // Notify initial messages
    if (sessionConfig.callbacks?.onMessagesUpdate) {
      await sessionConfig.callbacks.onMessagesUpdate(sessionId, state.messages);
    }

    let idleTurns = 0;
    const maxIdleTurns = 2; // Nudge after 2 turns of idle behavior

    try {
      while (state.shouldContinue && state.turnCount < maxTurns) {
        // Check for idle behavior before turn
        if (state.turnCount > 0 && isAgentIdle(state)) {
          idleTurns++;
          if (idleTurns >= maxIdleTurns) {
            logger.info(`Agent idle for ${idleTurns} turns, sending reminder`);
            state.messages.push({
              role: "user",
              content: createReminderMessage(),
            });
            idleTurns = 0; // Reset counter after nudge

            if (sessionConfig.callbacks?.onMessagesUpdate) {
              await sessionConfig.callbacks.onMessagesUpdate(
                sessionId,
                state.messages,
              );
            }
          }
        } else {
          idleTurns = 0; // Reset if agent is active
        }

        await runTurn(modelConfig, sessionConfig, state, logger, sessionId);
      }

      // Check if we hit max turns
      if (state.turnCount >= maxTurns && state.shouldContinue) {
        logger.info(`Max turns (${maxTurns}) reached - ending session`);
        state.completionReason = "max_turns";
        state.finalOutput += "\n\n(Session ended - max turns reached)";
      }

      // Notify completion
      const completeInfo: SessionCompleteInfo = {
        finalOutput: state.finalOutput,
        totalTurns: state.turnCount,
        completionReason: state.completionReason,
        taskResult: state.taskResult,
      };

      if (sessionConfig.callbacks?.onComplete) {
        await sessionConfig.callbacks.onComplete(sessionId, completeInfo);
      }

      logger.info(
        `Session completed after ${state.turnCount} turns (${state.completionReason})`,
      );

      return {
        sessionId,
        finalOutput: state.finalOutput || "(no output)",
        totalTurns: state.turnCount,
        completionReason: state.completionReason,
        messages: state.messages,
        taskResult: state.taskResult,
      };
    } catch (error: any) {
      logger.error(`Session error: ${error.message}`);

      // Notify error
      const errorInfo: ErrorInfo = {
        error,
        turn: state.turnCount,
        phase: "llm",
      };

      if (sessionConfig.callbacks?.onError) {
        await sessionConfig.callbacks.onError(sessionId, errorInfo);
      }

      state.completionReason = "error";

      // Notify completion with error
      const completeInfo: SessionCompleteInfo = {
        finalOutput: state.finalOutput,
        totalTurns: state.turnCount,
        completionReason: "error",
        taskResult: state.taskResult,
      };

      if (sessionConfig.callbacks?.onComplete) {
        await sessionConfig.callbacks.onComplete(sessionId, completeInfo);
      }

      return {
        sessionId,
        finalOutput: state.finalOutput || "(no output)",
        totalTurns: state.turnCount,
        completionReason: "error",
        messages: state.messages,
        taskResult: state.taskResult,
        error,
      };
    }
  })();

  // Return session object with sessionId and promise
  // Make it thenable so it can be awaited directly
  return {
    sessionId,
    initialMessage: derivedInitialMessage,
    promise,
    then: <T>(
      onfulfilled?: (value: AgentSessionResult) => T | Promise<T>,
      onrejected?: (reason: any) => T | Promise<T>,
    ) => promise.then(onfulfilled, onrejected),
  };
}
