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
    const fallbackMessages =
      this.observedMessages.length > 0
        ? this.observedMessages
        : extractGeneratedMessages(this.finalValue, inputMessages);
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
    this.response.usage = converted.usage;

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
    const events: ResponsesStreamEvent[] = [];
    for (const part of item.summary) {
      if (typeof part.text === "string") {
        events.push(...this.emitReasoningDelta(part.text, item.id));
      }
    }
    events.push(...this.closeReasoningItem());
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
