import {
  isAIMessage,
  isAIMessageChunk,
  isBaseMessage,
  isBaseMessageChunk,
  isToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import {
  createItemId,
  extractGeneratedMessages,
  extractMessageText,
  extractMessages,
  extractReasoningSummary,
  isRecord,
  messagesToResponseOutput,
} from "./converters.js";
import type {
  ResponseFunctionCallItem,
  ResponseFunctionCallOutputItem,
  ResponseMessageItem,
  ResponseObject,
  ResponseReasoningItem,
  ResponseUsage,
  ResponsesStreamEvent,
} from "./types.js";

interface OpenTextItem {
  contentIndex: number;
  item: ResponseMessageItem;
  outputIndex: number;
  text: string;
}

interface OpenReasoningItem {
  item: ResponseReasoningItem;
  outputIndex: number;
  text: string;
}

export class ResponseStreamBuilder {
  private sequenceNumber = 0;

  private openTextItem: OpenTextItem | undefined;

  private openReasoningItem: OpenReasoningItem | undefined;

  private readonly observedMessages: BaseMessage[] = [];

  private finalValue: unknown;

  private streamedUsage: ResponseUsage | null = null;

  private hasTextOutput = false;

  private hasReasoningOutput = false;

  private readonly emittedToolCalls = new Set<string>();

  private readonly emittedToolOutputs = new Set<string>();

  private readonly response: ResponseObject;

  constructor(response: ResponseObject) {
    this.response = response;
  }

  created(): ResponsesStreamEvent {
    return this.event("response.created", {
      response: structuredClone(this.response),
    });
  }

  inProgress(): ResponsesStreamEvent {
    return this.event("response.in_progress", {
      response: structuredClone(this.response),
    });
  }

  handleChunk(chunk: unknown): ResponsesStreamEvent[] {
    const { mode, payload } = splitChunk(chunk);
    if (mode === "messages") {
      return this.handleMessagePayload(payload);
    }
    if (mode === "updates") {
      return this.handleUpdate(payload);
    }
    if (mode === "values") {
      this.finalValue = payload;
      return [];
    }

    const messageEvents = this.handleMessagePayload(payload);
    if (messageEvents.length > 0) {
      return messageEvents;
    }
    const updateMessages = extractUpdateMessages(payload);
    if (updateMessages.length > 0) {
      return this.handleUpdate(payload);
    }
    this.finalValue = payload;
    return [];
  }

  complete(inputMessages: BaseMessage[]): ResponsesStreamEvent[] {
    const events = this.closeOpenItems();
    const finalMessages = extractGeneratedMessages(
      this.finalValue,
      inputMessages
    );
    const fallbackMessages =
      finalMessages.length > 0 ? finalMessages : this.observedMessages;
    events.push(...this.emitFallbackMessages(fallbackMessages));
    this.response.status = "completed";
    this.response.error = null;
    events.push(
      this.event("response.completed", {
        response: structuredClone(this.response),
      })
    );
    return events;
  }

  failed(code: string, message: string): ResponsesStreamEvent[] {
    const events = this.closeOpenItems();
    this.response.status = "failed";
    this.response.error = { code, message };
    events.push(
      this.event("response.failed", {
        response: structuredClone(this.response),
      })
    );
    return events;
  }

  cancelled(): ResponsesStreamEvent[] {
    const events = this.closeOpenItems();
    this.response.status = "cancelled";
    this.response.error = {
      code: "cancelled",
      message: "Request was cancelled.",
    };
    events.push(
      this.event("response.failed", {
        response: structuredClone(this.response),
      })
    );
    return events;
  }

  private handleMessagePayload(payload: unknown): ResponsesStreamEvent[] {
    const candidate = extractMessageCandidate(payload);
    if (
      candidate === undefined ||
      !isBaseMessageChunk(candidate) ||
      !isAIMessageChunk(candidate)
    ) {
      return [];
    }

    if (candidate.usage_metadata !== undefined) {
      this.streamedUsage = mergeUsage(
        this.streamedUsage,
        candidate.usage_metadata
      );
    }

    const events: ResponsesStreamEvent[] = [];
    const reasoningFragments = extractReasoningSummary(candidate.content);
    for (const fragment of reasoningFragments) {
      events.push(...this.emitReasoningDelta(fragment));
    }

    const text = extractMessageText(candidate.content);
    if (text) {
      events.push(...this.closeReasoningItem());
      events.push(...this.emitTextDelta(text));
    }
    return events;
  }

  private handleUpdate(payload: unknown): ResponsesStreamEvent[] {
    const events: ResponsesStreamEvent[] = [];
    for (const message of extractUpdateMessages(payload)) {
      this.observedMessages.push(message);
      if (isAIMessage(message)) {
        for (const call of message.tool_calls ?? []) {
          if (!call.id || !call.name) {
            continue;
          }
          events.push(
            ...this.emitFunctionCall(
              call.id,
              call.name,
              typeof call.args === "string"
                ? call.args
                : JSON.stringify(call.args ?? {})
            )
          );
        }
      } else if (isToolMessage(message)) {
        events.push(
          ...this.emitFunctionCallOutput(
            message.tool_call_id,
            extractMessageText(message.content)
          )
        );
      }
    }
    return events;
  }

  private emitFallbackMessages(
    messages: BaseMessage[]
  ): ResponsesStreamEvent[] {
    const events: ResponsesStreamEvent[] = [];
    const emitText = !this.hasTextOutput;
    const emitReasoning = !this.hasReasoningOutput;
    const converted = messagesToResponseOutput(messages);
    this.response.usage = converted.usage ?? this.streamedUsage;

    for (const item of converted.output) {
      if (item.type === "message") {
        if (emitText) {
          events.push(...this.emitCompletedMessage(item));
        }
      } else if (item.type === "reasoning") {
        if (emitReasoning) {
          events.push(...this.emitCompletedReasoning(item));
        }
      } else if (item.type === "function_call") {
        events.push(
          ...this.emitFunctionCall(
            item.call_id,
            item.name,
            item.arguments,
            item.id
          )
        );
      } else {
        events.push(
          ...this.emitFunctionCallOutput(item.call_id, item.output, item.id)
        );
      }
    }
    return events;
  }

  private emitCompletedMessage(
    item: ResponseMessageItem
  ): ResponsesStreamEvent[] {
    const text = item.content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
    if (!text) {
      return [];
    }
    return [
      ...this.openText(item.id),
      ...this.emitTextDelta(text),
      ...this.closeTextItem(),
    ];
  }

  private emitCompletedReasoning(
    item: ResponseReasoningItem
  ): ResponsesStreamEvent[] {
    const parts = item.summary.flatMap((part) => {
      const { text } = part;
      return typeof text === "string" && text.length > 0
        ? [{ ...part, text }]
        : [];
    });
    if (parts.length === 0) {
      return [];
    }

    const events: ResponsesStreamEvent[] = [];
    const streamedItem: ResponseReasoningItem = {
      ...item,
      status: "in_progress",
      summary: [],
    };
    const outputIndex = this.response.output.length;
    this.response.output.push(streamedItem);
    this.hasReasoningOutput = true;
    events.push(
      this.event("response.output_item.added", {
        output_index: outputIndex,
        item: structuredClone(streamedItem),
      })
    );

    for (const part of parts) {
      const summaryIndex = streamedItem.summary.length;
      const streamedPart = { ...part, text: "" };
      streamedItem.summary.push(streamedPart);
      events.push(
        this.event("response.reasoning_summary_part.added", {
          item_id: streamedItem.id,
          output_index: outputIndex,
          summary_index: summaryIndex,
          part: structuredClone(streamedPart),
        }),
        this.event("response.reasoning_summary_text.delta", {
          item_id: streamedItem.id,
          output_index: outputIndex,
          summary_index: summaryIndex,
          delta: part.text,
        })
      );
      streamedPart.text = part.text;
      events.push(
        this.event("response.reasoning_summary_text.done", {
          item_id: streamedItem.id,
          output_index: outputIndex,
          summary_index: summaryIndex,
          text: part.text,
        }),
        this.event("response.reasoning_summary_part.done", {
          item_id: streamedItem.id,
          output_index: outputIndex,
          summary_index: summaryIndex,
          part: structuredClone(streamedPart),
        })
      );
    }

    streamedItem.status = "completed";
    events.push(
      this.event("response.output_item.done", {
        output_index: outputIndex,
        item: structuredClone(streamedItem),
      })
    );
    return events;
  }

  private openText(itemId = createItemId("msg")): ResponsesStreamEvent[] {
    if (this.openTextItem !== undefined) {
      return [];
    }

    const item: ResponseMessageItem = {
      id: itemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [{ type: "output_text", text: "" }],
    };
    const outputIndex = this.response.output.length;
    this.response.output.push(item);
    this.openTextItem = {
      item,
      outputIndex,
      contentIndex: 0,
      text: "",
    };
    this.hasTextOutput = true;

    return [
      this.event("response.output_item.added", {
        output_index: outputIndex,
        item: structuredClone(item),
      }),
      this.event("response.content_part.added", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: structuredClone(item.content[0]),
      }),
    ];
  }

  private emitTextDelta(text: string): ResponsesStreamEvent[] {
    const events = this.openText();
    const open = this.openTextItem;
    if (open === undefined) {
      return events;
    }

    open.text += text;
    open.item.content[open.contentIndex].text = open.text;
    events.push(
      this.event("response.output_text.delta", {
        item_id: open.item.id,
        output_index: open.outputIndex,
        content_index: open.contentIndex,
        delta: text,
        logprobs: [],
      })
    );
    return events;
  }

  private closeTextItem(): ResponsesStreamEvent[] {
    const open = this.openTextItem;
    if (open === undefined) {
      return [];
    }

    open.item.status = "completed";
    const events = [
      this.event("response.output_text.done", {
        item_id: open.item.id,
        output_index: open.outputIndex,
        content_index: open.contentIndex,
        text: open.text,
        logprobs: [],
      }),
      this.event("response.content_part.done", {
        item_id: open.item.id,
        output_index: open.outputIndex,
        content_index: open.contentIndex,
        part: structuredClone(open.item.content[open.contentIndex]),
      }),
      this.event("response.output_item.done", {
        output_index: open.outputIndex,
        item: structuredClone(open.item),
      }),
    ];
    this.openTextItem = undefined;
    return events;
  }

  private emitReasoningDelta(
    text: string,
    itemId = createItemId("rs")
  ): ResponsesStreamEvent[] {
    if (!text && this.openReasoningItem === undefined) {
      return [];
    }

    const events: ResponsesStreamEvent[] = [];
    if (this.openReasoningItem === undefined) {
      const item: ResponseReasoningItem = {
        id: itemId,
        type: "reasoning",
        status: "in_progress",
        summary: [{ type: "summary_text", text: "" }],
      };
      const outputIndex = this.response.output.length;
      this.response.output.push(item);
      this.openReasoningItem = { item, outputIndex, text: "" };
      this.hasReasoningOutput = true;
      events.push(
        this.event("response.output_item.added", {
          output_index: outputIndex,
          item: structuredClone(item),
        }),
        this.event("response.reasoning_summary_part.added", {
          item_id: item.id,
          output_index: outputIndex,
          summary_index: 0,
          part: structuredClone(item.summary[0]),
        })
      );
    }

    const open = this.openReasoningItem;
    if (open === undefined) {
      return events;
    }
    const delta = text || "\n";
    open.text += delta;
    open.item.summary[0].text = open.text;
    events.push(
      this.event("response.reasoning_summary_text.delta", {
        item_id: open.item.id,
        output_index: open.outputIndex,
        summary_index: 0,
        delta,
      })
    );
    return events;
  }

  private closeReasoningItem(): ResponsesStreamEvent[] {
    const open = this.openReasoningItem;
    if (open === undefined) {
      return [];
    }

    open.item.status = "completed";
    const events = [
      this.event("response.reasoning_summary_text.done", {
        item_id: open.item.id,
        output_index: open.outputIndex,
        summary_index: 0,
        text: open.text,
      }),
      this.event("response.reasoning_summary_part.done", {
        item_id: open.item.id,
        output_index: open.outputIndex,
        summary_index: 0,
        part: structuredClone(open.item.summary[0]),
      }),
      this.event("response.output_item.done", {
        output_index: open.outputIndex,
        item: structuredClone(open.item),
      }),
    ];
    this.openReasoningItem = undefined;
    return events;
  }

  private emitFunctionCall(
    callId: string,
    name: string,
    argumentsJson: string,
    itemId = createItemId("fc")
  ): ResponsesStreamEvent[] {
    if (this.emittedToolCalls.has(callId)) {
      return [];
    }
    this.emittedToolCalls.add(callId);

    const events = this.closeOpenItems();
    const item: ResponseFunctionCallItem = {
      id: itemId,
      type: "function_call",
      status: "in_progress",
      call_id: callId,
      name,
      arguments: "",
    };
    const outputIndex = this.response.output.length;
    this.response.output.push(item);
    events.push(
      this.event("response.output_item.added", {
        output_index: outputIndex,
        item: structuredClone(item),
      })
    );
    if (argumentsJson) {
      item.arguments = argumentsJson;
      events.push(
        this.event("response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: outputIndex,
          delta: argumentsJson,
        })
      );
    }
    events.push(
      this.event("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: outputIndex,
        arguments: argumentsJson,
      })
    );
    item.status = "completed";
    events.push(
      this.event("response.output_item.done", {
        output_index: outputIndex,
        item: structuredClone(item),
      })
    );
    return events;
  }

  private emitFunctionCallOutput(
    callId: string,
    output: string,
    itemId = createItemId("fco")
  ): ResponsesStreamEvent[] {
    if (this.emittedToolOutputs.has(callId)) {
      return [];
    }
    this.emittedToolOutputs.add(callId);

    const events = this.closeOpenItems();
    const item: ResponseFunctionCallOutputItem = {
      id: itemId,
      type: "function_call_output",
      status: "in_progress",
      call_id: callId,
      output,
    };
    const outputIndex = this.response.output.length;
    this.response.output.push(item);
    events.push(
      this.event("response.output_item.added", {
        output_index: outputIndex,
        item: structuredClone(item),
      })
    );
    item.status = "completed";
    events.push(
      this.event("response.output_item.done", {
        output_index: outputIndex,
        item: structuredClone(item),
      })
    );
    return events;
  }

  private closeOpenItems(): ResponsesStreamEvent[] {
    return [...this.closeReasoningItem(), ...this.closeTextItem()];
  }

  private event(
    type: string,
    fields: Omit<ResponsesStreamEvent, "type" | "sequence_number">
  ): ResponsesStreamEvent {
    const event = {
      type,
      sequence_number: this.sequenceNumber,
      ...fields,
    };
    this.sequenceNumber += 1;
    return event;
  }
}

function splitChunk(chunk: unknown): {
  mode: string | undefined;
  payload: unknown;
} {
  if (
    Array.isArray(chunk) &&
    chunk.length === 2 &&
    typeof chunk[0] === "string"
  ) {
    return { mode: chunk[0], payload: chunk[1] };
  }
  return { mode: undefined, payload: chunk };
}

function extractMessageCandidate(payload: unknown): unknown {
  if (isBaseMessage(payload) || isBaseMessageChunk(payload)) {
    return payload;
  }
  if (Array.isArray(payload) && payload.length > 0) {
    return payload[0];
  }
  return undefined;
}

function extractUpdateMessages(payload: unknown): BaseMessage[] {
  const direct = extractMessages(payload);
  if (direct.length > 0) {
    return direct;
  }
  if (!isRecord(payload)) {
    return [];
  }

  const messages: BaseMessage[] = [];
  for (const value of Object.values(payload)) {
    messages.push(...extractMessages(value));
  }
  return messages;
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
