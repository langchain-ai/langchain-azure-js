import { randomUUID } from "node:crypto";

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  isAIMessage,
  isBaseMessage,
  isToolMessage,
  type BaseMessage,
  type ContentBlock,
  type MessageContent,
} from "@langchain/core/messages";

import type {
  ResponseContentPart,
  ResponseInputItem,
  ResponseItem,
  ResponseMessageItem,
  ResponseOutputItem,
  ResponseRole,
  ResponseUsage,
} from "./types.js";

export class ResponsesValidationError extends Error {
  readonly isResponsesValidationError = true;

  constructor(
    message: string,
    readonly param: string | null = null,
    readonly code = "invalid_request"
  ) {
    super(message);
    this.name = "ResponsesValidationError";
  }
}

export function isResponsesValidationError(
  value: unknown
): value is ResponsesValidationError {
  return (
    isRecord(value) &&
    value.isResponsesValidationError === true &&
    typeof value.message === "string"
  );
}

export function createItemId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function normalizeResponseInput(
  input: string | unknown[]
): ResponseInputItem[] {
  if (typeof input === "string") {
    return [createMessageItem("user", input)];
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new ResponsesValidationError(
      "'input' must be a non-empty string or array.",
      "input"
    );
  }

  return input.map((item, index) => normalizeInputItem(item, index));
}

function normalizeInputItem(item: unknown, index: number): ResponseInputItem {
  if (!isRecord(item)) {
    throw new ResponsesValidationError(
      `Input item at index ${index} must be an object.`,
      `input[${index}]`
    );
  }

  let type: string | undefined;
  if (typeof item.type === "string") {
    type = item.type;
  } else if (typeof item.role === "string") {
    type = "message";
  }

  if (type === "message") {
    const role = normalizeRole(item.role, index);
    return {
      id: optionalString(item.id) ?? createItemId("msg"),
      type: "message",
      status: "completed",
      role,
      content: normalizeContent(item.content, role, index),
    };
  }

  if (type === "function_call") {
    const callId = requiredString(item.call_id, `input[${index}].call_id`);
    const name = requiredString(item.name, `input[${index}].name`);
    return {
      id: optionalString(item.id) ?? createItemId("fc"),
      type: "function_call",
      status: "completed",
      call_id: callId,
      name,
      arguments: normalizeJsonString(item.arguments),
    };
  }

  if (type === "function_call_output") {
    const callId = requiredString(item.call_id, `input[${index}].call_id`);
    return {
      id: optionalString(item.id) ?? createItemId("fco"),
      type: "function_call_output",
      status: "completed",
      call_id: callId,
      output: valueToText(item.output),
    };
  }

  throw new ResponsesValidationError(
    `Unsupported input item type '${String(type ?? "unknown")}'.`,
    `input[${index}].type`,
    "unsupported_input_item"
  );
}

function normalizeRole(value: unknown, index: number): ResponseRole {
  if (
    value === "user" ||
    value === "assistant" ||
    value === "system" ||
    value === "developer"
  ) {
    return value;
  }
  throw new ResponsesValidationError(
    `Input message at index ${index} has an unsupported role.`,
    `input[${index}].role`
  );
}

function normalizeContent(
  value: unknown,
  role: ResponseRole,
  index: number
): ResponseContentPart[] {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof value === "string") {
    return [{ type: textType, text: value }];
  }
  if (!Array.isArray(value)) {
    throw new ResponsesValidationError(
      `Input message at index ${index} must have string or array content.`,
      `input[${index}].content`
    );
  }

  return value.map((part, partIndex) => {
    if (typeof part === "string") {
      return { type: textType, text: part };
    }
    if (!isRecord(part) || typeof part.type !== "string") {
      throw new ResponsesValidationError(
        `Content part at input[${index}].content[${partIndex}] is invalid.`,
        `input[${index}].content[${partIndex}]`
      );
    }
    return { ...part, type: part.type };
  });
}

function createMessageItem(
  role: ResponseRole,
  text: string
): ResponseMessageItem {
  return {
    id: createItemId("msg"),
    type: "message",
    status: "completed",
    role,
    content: [
      {
        type: role === "assistant" ? "output_text" : "input_text",
        text,
      },
    ],
  };
}

export function responseItemsToMessages(items: ResponseItem[]): BaseMessage[] {
  const messages: BaseMessage[] = [];
  let index = 0;

  while (index < items.length) {
    const item = items[index];
    if (item.type === "function_call") {
      const toolCalls = [];
      while (index < items.length && items[index].type === "function_call") {
        const functionCall = items[index];
        if (functionCall.type !== "function_call") {
          break;
        }
        toolCalls.push({
          id: functionCall.call_id,
          name: functionCall.name,
          args: parseArguments(functionCall.arguments),
          type: "tool_call" as const,
        });
        index += 1;
      }
      messages.push(new AIMessage({ content: "", tool_calls: toolCalls }));
      continue;
    }

    if (item.type === "message") {
      const content = contentPartsToMessageContent(item.content);
      if (item.role === "user") {
        messages.push(new HumanMessage({ content }));
      } else if (item.role === "assistant") {
        messages.push(new AIMessage({ content }));
      } else {
        messages.push(new SystemMessage({ content }));
      }
    } else if (item.type === "function_call_output") {
      messages.push(
        new ToolMessage({
          content: item.output,
          tool_call_id: item.call_id,
        })
      );
    }
    index += 1;
  }

  return filterIncompleteToolCalls(messages);
}

function contentPartsToMessageContent(
  parts: ResponseContentPart[]
): MessageContent {
  if (parts.every((part) => typeof part.text === "string")) {
    return parts.map((part) => part.text ?? "").join("");
  }

  const content: ContentBlock[] = [];
  for (const part of parts) {
    if (
      (part.type === "input_text" ||
        part.type === "output_text" ||
        part.type === "text") &&
      typeof part.text === "string"
    ) {
      content.push({ type: "text", text: part.text });
    } else if (
      part.type === "input_image" &&
      typeof part.image_url === "string"
    ) {
      content.push({ type: "image_url", image_url: part.image_url });
    } else {
      content.push({ ...part });
    }
  }
  return content;
}

function filterIncompleteToolCalls(messages: BaseMessage[]): BaseMessage[] {
  const responseIds = new Set(
    messages
      .filter(isToolMessage)
      .map((message) => message.tool_call_id)
      .filter(Boolean)
  );
  const validCallIds = new Set<string>();
  const result: BaseMessage[] = [];

  for (const message of messages) {
    if (isAIMessage(message) && message.tool_calls?.length) {
      const callIds = message.tool_calls
        .map((call) => call.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (
        callIds.length !== message.tool_calls.length ||
        !callIds.every((id) => responseIds.has(id))
      ) {
        continue;
      }
      callIds.forEach((id) => validCallIds.add(id));
      result.push(message);
    } else if (isToolMessage(message)) {
      if (validCallIds.has(message.tool_call_id)) {
        result.push(message);
      }
    } else {
      result.push(message);
    }
  }
  return result;
}

export function extractMessages(value: unknown): BaseMessage[] {
  if (isBaseMessage(value)) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter(isBaseMessage);
  }
  if (isRecord(value) && Array.isArray(value.messages)) {
    return value.messages.filter(isBaseMessage);
  }
  return [];
}

export function extractGeneratedMessages(
  value: unknown,
  inputMessages: BaseMessage[]
): BaseMessage[] {
  const outputMessages = extractMessages(value);
  if (inputMessages.length === 0) {
    return outputMessages;
  }

  for (
    let start = outputMessages.length - inputMessages.length;
    start >= 0;
    start -= 1
  ) {
    const matches = inputMessages.every((message, offset) =>
      messagesEquivalent(outputMessages[start + offset], message)
    );
    if (matches) {
      return outputMessages.slice(start + inputMessages.length);
    }
  }

  return outputMessages;
}

function messagesEquivalent(left: BaseMessage, right: BaseMessage): boolean {
  return (
    left.getType() === right.getType() &&
    JSON.stringify(left.content) === JSON.stringify(right.content) &&
    (!isToolMessage(left) ||
      (isToolMessage(right) && left.tool_call_id === right.tool_call_id))
  );
}

export function messagesToResponseOutput(messages: BaseMessage[]): {
  output: ResponseOutputItem[];
  usage: ResponseUsage | null;
} {
  const output: ResponseOutputItem[] = [];
  let usage: ResponseUsage | null = null;

  for (const message of messages) {
    if (isAIMessage(message)) {
      const reasoning = extractReasoningSummary(message.content);
      if (reasoning.length > 0) {
        output.push({
          id: createItemId("rs"),
          type: "reasoning",
          status: "completed",
          summary: reasoning.map((text) => ({
            type: "summary_text",
            text,
          })),
        });
      }

      const text = extractMessageText(message.content);
      if (text) {
        output.push({
          id: optionalString(message.id) ?? createItemId("msg"),
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }

      for (const call of message.tool_calls ?? []) {
        if (!call.id || !call.name) {
          continue;
        }
        output.push({
          id: createItemId("fc"),
          type: "function_call",
          status: "completed",
          call_id: call.id,
          name: call.name,
          arguments: normalizeJsonString(call.args),
        });
      }

      if (message.usage_metadata !== undefined) {
        usage = mergeUsage(usage, message.usage_metadata);
      }
    } else if (isToolMessage(message)) {
      output.push({
        id: createItemId("fco"),
        type: "function_call_output",
        status: "completed",
        call_id: message.tool_call_id,
        output: extractMessageText(message.content),
      });
    }
  }

  return { output, usage };
}

export function extractMessageText(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (
        "text" in part &&
        typeof part.text === "string" &&
        part.type !== "reasoning" &&
        part.type !== "summary_text"
      ) {
        return part.text;
      }
      return "";
    })
    .join("");
}

export function extractReasoningSummary(content: MessageContent): string[] {
  if (typeof content === "string") {
    return [];
  }

  const fragments: string[] = [];
  for (const part of content) {
    if (part.type !== "reasoning" || !Array.isArray(part.summary)) {
      continue;
    }
    for (const summary of part.summary) {
      if (isRecord(summary) && typeof summary.text === "string") {
        fragments.push(summary.text);
      }
    }
  }
  return fragments;
}

function mergeUsage(
  current: ResponseUsage | null,
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_token_details?: { cache_read?: number };
    output_token_details?: { reasoning?: number };
  }
): ResponseUsage {
  const previous =
    current ??
    ({
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    } satisfies ResponseUsage);

  return {
    input_tokens: previous.input_tokens + usage.input_tokens,
    input_tokens_details: {
      cached_tokens:
        previous.input_tokens_details.cached_tokens +
        (usage.input_token_details?.cache_read ?? 0),
    },
    output_tokens: previous.output_tokens + usage.output_tokens,
    output_tokens_details: {
      reasoning_tokens:
        previous.output_tokens_details.reasoning_tokens +
        (usage.output_token_details?.reasoning ?? 0),
    },
    total_tokens: previous.total_tokens + usage.total_tokens,
  };
}

function parseArguments(value: string): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeJsonString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? {});
}

function valueToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        return isRecord(part) && typeof part.text === "string" ? part.text : "";
      })
      .join("");
  }
  return value === undefined ? "" : JSON.stringify(value);
}

function requiredString(value: unknown, param: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new ResponsesValidationError(`'${param}' must be a string.`, param);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
