import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";

export type ResponseStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type ResponseRole = "user" | "assistant" | "system" | "developer";

export interface ResponseContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ResponseMessageItem {
  id: string;
  type: "message";
  status: "in_progress" | "completed";
  role: ResponseRole;
  content: ResponseContentPart[];
}

export interface ResponseFunctionCallItem {
  id: string;
  type: "function_call";
  status: "in_progress" | "completed";
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponseFunctionCallOutputItem {
  id: string;
  type: "function_call_output";
  status: "in_progress" | "completed";
  call_id: string;
  output: string;
}

export interface ResponseReasoningItem {
  id: string;
  type: "reasoning";
  status: "in_progress" | "completed";
  summary: ResponseContentPart[];
}

export type ResponseInputItem =
  | ResponseMessageItem
  | ResponseFunctionCallItem
  | ResponseFunctionCallOutputItem;

export type ResponseOutputItem =
  | ResponseMessageItem
  | ResponseFunctionCallItem
  | ResponseFunctionCallOutputItem
  | ResponseReasoningItem;

export type ResponseItem = ResponseInputItem | ResponseOutputItem;

export interface CreateResponseRequest {
  input: string | unknown[];
  background?: boolean;
  conversation?: string | { id: string };
  include?: string[];
  instructions?: string | null;
  max_output_tokens?: number | null;
  metadata?: Record<string, string>;
  model?: string;
  parallel_tool_calls?: boolean;
  previous_response_id?: string | null;
  reasoning?: Record<string, unknown> | null;
  store?: boolean;
  stream?: boolean;
  temperature?: number | null;
  text?: Record<string, unknown>;
  tool_choice?: unknown;
  tools?: unknown[];
  top_p?: number | null;
  truncation?: string;
}

export interface ResponseError {
  code: string;
  message: string;
}

export interface ResponseUsage {
  input_tokens: number;
  input_tokens_details: {
    cached_tokens: number;
  };
  output_tokens: number;
  output_tokens_details: {
    reasoning_tokens: number;
  };
  total_tokens: number;
}

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: ResponseStatus;
  background: boolean;
  conversation?: { id: string };
  error: ResponseError | null;
  incomplete_details: null;
  instructions: string | null;
  max_output_tokens: number | null;
  metadata: Record<string, string>;
  model: string;
  output: ResponseOutputItem[];
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: Record<string, unknown> | null;
  store: boolean;
  temperature: number | null;
  text: Record<string, unknown>;
  tool_choice: unknown;
  tools: unknown[];
  top_p: number | null;
  truncation: string;
  usage: ResponseUsage | null;
}

export interface ResponsesStreamEvent {
  type: string;
  sequence_number: number;
  [key: string]: unknown;
}

export interface ResponsesGraphInput {
  messages: BaseMessage[];
}

export interface ResponsesRunnableConfig extends RunnableConfig {
  streamMode?: "updates" | "messages" | ("updates" | "messages")[];
}

export interface ResponsesRunnable {
  checkpointer?: unknown;
  invoke(
    input: ResponsesGraphInput,
    options?: Partial<ResponsesRunnableConfig>
  ): Promise<unknown>;
  stream(
    input: ResponsesGraphInput,
    options?: Partial<ResponsesRunnableConfig>
  ): Promise<AsyncIterable<unknown>>;
}
