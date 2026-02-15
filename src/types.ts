// Core types for the agentic loop library

import type { Tool } from "ai";
import type {
  UserContent,
  AssistantContent,
  TextPart,
  ImagePart,
  FilePart,
  ToolCallPart,
  ToolResultPart,
} from "@ai-sdk/provider-utils";

// Re-export the AI SDK types for convenience
export type {
  UserContent,
  AssistantContent,
  TextPart,
  ImagePart,
  FilePart,
  ToolCallPart,
  ToolResultPart,
};

/**
 * Configuration for the LLM model provider
 */
export interface ModelConfig {
  /** Provider: "ollama", "openai", or "anthropic" */
  provider: "ollama" | "openai" | "anthropic";
  /** Model name (e.g., "gpt-4o", "claude-3-5-sonnet-20241022", "gpt-oss:20b-128k") */
  model: string;
  /** API key for OpenAI/Anthropic (not needed for Ollama) */
  apiKey?: string;
  /** Base URL for Ollama */
  baseURL?: string;
}

/**
 * A message in the conversation history
 * Reflects the actual AI SDK message structure where content can be:
 * - string: for simple text messages
 * - array: for messages with tool calls/results, images, files, etc.
 */
export type Message =
  | {
      role: "user";
      content: UserContent;
    }
  | {
      role: "assistant";
      content: AssistantContent;
    };

/**
 * Information about a tool call
 */
export interface ToolCallInfo {
  toolName: string;
  args: any;
  turn: number;
}

/**
 * Information about a tool result
 */
export interface ToolResultInfo {
  toolName: string;
  result: any;
  turn: number;
}

/**
 * Error information
 */
export interface ErrorInfo {
  error: Error;
  turn: number;
  phase: "llm" | "tool_call" | "tool_execution";
}

/**
 * Information about a session suspension
 */
export interface SessionSuspendInfo {
  reason: string;
  data?: any; // Arbitrary data about why/what we're waiting for
  turn: number;
}

/**
 * Session completion info
 */
export interface SessionCompleteInfo {
  finalOutput: string;
  totalTurns: number;
  completionReason: "task_complete" | "max_turns" | "error" | "suspended";
  taskResult?: any;
  suspendInfo?: SessionSuspendInfo;
}

/**
 * Logging interface - pass your own implementation or use defaults
 */
export interface Logger {
  error: (message: string, ...args: any[]) => void;
  info: (message: string, ...args: any[]) => void;
  trace: (message: string, ...args: any[]) => void;
}

/**
 * Session event callbacks
 * All callbacks receive sessionId as first parameter for easy persistence
 */
export interface SessionCallbacks {
  /** Called when a new turn starts */
  onTurnStart?: (sessionId: string, turn: number) => void | Promise<void>;

  /** Called when the assistant produces a text response */
  onAssistantMessage?: (
    sessionId: string,
    text: string,
    turn: number,
  ) => void | Promise<void>;

  /** Called when a tool is about to be called */
  onToolCall?: (sessionId: string, info: ToolCallInfo) => void | Promise<void>;

  /** Called when a tool call completes */
  onToolResult?: (
    sessionId: string,
    info: ToolResultInfo,
  ) => void | Promise<void>;

  /** Called when an error occurs */
  onError?: (sessionId: string, info: ErrorInfo) => void | Promise<void>;

  /** Called when the session completes */
  onComplete?: (
    sessionId: string,
    info: SessionCompleteInfo,
  ) => void | Promise<void>;

  /** Called when message history is updated (after each turn) */
  onMessagesUpdate?: (
    sessionId: string,
    messages: Message[],
  ) => void | Promise<void>;

  /**
   * Called before summarization - allows modifying messages before summarization
   * Return modified messages array (e.g., remove system prompts, keep recent messages)
   * Default: all messages are summarized
   */
  onBeforeSummarize?: (
    sessionId: string,
    messages: Message[],
  ) => Message[] | Promise<Message[]>;

  /**
   * Called after summarization - allows modifying the summarized messages
   * Receives array with summary messages, return modified array
   * Use this to add back system prompts, append recent messages, etc.
   */
  onAfterSummarize?: (
    sessionId: string,
    summarizedMessages: Message[],
  ) => Message[] | Promise<Message[]>;

  /**
   * Called when the session is suspended (agent is blocked waiting for something)
   * The session has stopped and its state is in the result.
   * To resume, call runAgentSession again with initialMessages from the result,
   * optionally adding a message with the information the agent was waiting for.
   */
  onSuspend?: (
    sessionId: string,
    info: SessionSuspendInfo,
  ) => void | Promise<void>;
}

/**
 * Configuration for an agent session
 */
export interface AgentSessionConfig {
  /** System prompt for the agent */
  systemPrompt: string;

  /** Tools available to the agent (including any MCP tools) */
  tools: Record<string, Tool>;

  /** Session ID for tracking and persistence (passed to all callbacks) */
  sessionId?: string;

  /** Resume from previous messages (for session recovery) */
  initialMessages?: Message[];

  /** Initial user message to start the session (ignored if initialMessages provided) */
  initialMessage?: string;

  /** Maximum number of turns before forcing completion (default: 50) */
  maxTurns?: number;

  /** Maximum tokens before triggering summarization (optional) */
  tokenLimit?: number;

  /** Timeout in milliseconds for LLM calls (optional) */
  llmTimeout?: number;

  /** Timeout in milliseconds for tool calls (optional) */
  toolTimeout?: number;

  /** Logger implementation (defaults to console) */
  logger?: Logger;

  /** Session event callbacks */
  callbacks?: SessionCallbacks;

  /** Additional session metadata (optional) */
  metadata?: Record<string, any>;
}

/**
 * Agent session handle returned immediately from runAgentSession
 * Can be awaited directly or access promise/metadata separately
 */
export interface AgentSession {
  /** Session ID (from config or auto-generated) */
  sessionId: string;

  /** Initial message that started/resumed the session */
  initialMessage: string;

  /** Promise that resolves when session completes */
  promise: Promise<AgentSessionResult>;

  /** Make the session object awaitable (thenable) */
  then: <T>(
    onfulfilled?: (value: AgentSessionResult) => T | Promise<T>,
    onrejected?: (reason: any) => T | Promise<T>,
  ) => Promise<T>;
}

/**
 * Result of running an agent session
 */
export interface AgentSessionResult {
  /** Session ID (from config or auto-generated) */
  sessionId: string;

  /** Final output text from the agent */
  finalOutput: string;

  /** Total number of turns executed */
  totalTurns: number;

  /** How the session completed */
  completionReason: "task_complete" | "max_turns" | "error" | "suspended";

  /** Full message history */
  messages: Message[];

  /** Result from task_complete tool if called */
  taskResult?: any;

  /** Suspension info if session was suspended */
  suspendInfo?: SessionSuspendInfo;

  /** Error if session ended due to error */
  error?: Error;
}

/**
 * Internal state of an agent session
 */
export interface SessionState {
  messages: Message[];
  turnCount: number;
  finalOutput: string;
  shouldContinue: boolean;
  taskResult?: any;
  suspendInfo?: SessionSuspendInfo;
  completionReason: "task_complete" | "max_turns" | "error" | "suspended";
}

/**
 * Default logger that uses console
 */
export const defaultLogger: Logger = {
  error: (message: string, ...args: any[]) => console.error(message, ...args),
  info: (message: string, ...args: any[]) => console.log(message, ...args),
  trace: (_message: string, ..._args: any[]) => {}, // No-op by default
};
