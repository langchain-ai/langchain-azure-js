import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { SystemMessage } from "@langchain/core/messages";

import {
  extractGeneratedMessages,
  isRecord,
  isResponsesValidationError,
  messagesToResponseOutput,
  normalizeResponseInput,
  responseItemsToMessages,
} from "./converters.js";
import {
  InMemoryResponseStore,
  isResponseStoreCapacityError,
  type StoredResponse,
} from "./response_store.js";
import { ResponseStreamBuilder } from "./response_stream.js";
import type {
  CreateResponseRequest,
  ResponseInputItem,
  ResponseObject,
  ResponsesGraphInput,
  ResponsesRunnable,
  ResponsesRunnableConfig,
  ResponsesStreamEvent,
} from "./types.js";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const INTERNAL_ERROR_MESSAGE =
  "The response could not be completed due to an internal error.";

export interface ResponsesHostServerOptions {
  defaultModel?: string;
  maxRequestBodyBytes?: number;
  onError?: (error: unknown) => void;
  prefix?: string;
  store?: InMemoryResponseStore;
}

class ResponsesHttpError extends Error {
  readonly isResponsesHttpError = true;

  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: string,
    readonly param: string | null = null
  ) {
    super(message);
    this.name = "ResponsesHttpError";
  }
}

export class ResponsesHostServer {
  readonly graph: ResponsesRunnable;

  readonly store: InMemoryResponseStore;

  readonly server: Server;

  private readonly prefix: string;

  private readonly defaultModel: string;

  private readonly maxRequestBodyBytes: number;

  private readonly onError: (error: unknown) => void;

  constructor(
    graph: ResponsesRunnable,
    options: ResponsesHostServerOptions = {}
  ) {
    if (
      typeof graph?.invoke !== "function" ||
      typeof graph?.stream !== "function"
    ) {
      throw new Error(
        "ResponsesHostServer requires a runnable with invoke() and stream()."
      );
    }
    if (
      options.maxRequestBodyBytes !== undefined &&
      (!Number.isInteger(options.maxRequestBodyBytes) ||
        options.maxRequestBodyBytes <= 0)
    ) {
      throw new Error("'maxRequestBodyBytes' must be a positive integer.");
    }

    this.graph = graph;
    this.store = options.store ?? new InMemoryResponseStore();
    this.prefix = normalizePrefix(options.prefix ?? "");
    this.defaultModel = options.defaultModel ?? "langchain-agent";
    this.maxRequestBodyBytes =
      options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
    this.onError = options.onError ?? defaultErrorReporter;
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        this.handleUnexpectedError(error, response);
      });
    });
  }

  listen(port = 8088, host = "127.0.0.1"): Promise<AddressInfo> {
    if (this.server.listening) {
      return Promise.reject(
        new Error("ResponsesHostServer is already running.")
      );
    }

    return new Promise<AddressInfo>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("error", onError);
        reject(error);
      };
      this.server.once("error", onError);
      this.server.listen(port, host, () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (address === null || typeof address === "string") {
          reject(
            new Error("ResponsesHostServer did not bind to a TCP address.")
          );
          return;
        }
        resolve(address);
      });
    });
  }

  run(port = 8088, host = "127.0.0.1"): Promise<AddressInfo> {
    return this.listen(port, host);
  }

  async close(): Promise<void> {
    for (const record of this.store.values()) {
      if (record.response.status === "in_progress") {
        record.abortController.abort();
      }
    }
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error?: Error) => {
        if (error !== undefined) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const route = this.parseRoute(url.pathname);

      if (route.kind === "create" && request.method === "POST") {
        await this.handleCreate(request, response);
        return;
      }
      if (route.kind === "response" && request.method === "GET") {
        this.handleGet(route.responseId, response);
        return;
      }
      if (route.kind === "response" && request.method === "DELETE") {
        this.handleDelete(route.responseId, response);
        return;
      }
      if (route.kind === "cancel" && request.method === "POST") {
        this.handleCancel(route.responseId, response);
        return;
      }
      if (route.kind === "input_items" && request.method === "GET") {
        this.handleInputItems(route.responseId, url, response);
        return;
      }

      if (route.kind !== "not_found") {
        throw new ResponsesHttpError(
          405,
          `Method ${
            request.method ?? "UNKNOWN"
          } is not allowed for this route.`,
          "method_not_allowed"
        );
      }
      throw new ResponsesHttpError(
        404,
        `Route '${url.pathname}' was not found.`,
        "not_found"
      );
    } catch (error) {
      this.handleRequestError(error, response);
    }
  }

  private async handleCreate(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const body = await readJsonBody(request, this.maxRequestBodyBytes);
    const createRequest = parseCreateRequest(body);
    if (createRequest.background === true) {
      throw new ResponsesHttpError(
        400,
        "Background responses are not supported by the in-memory host.",
        "unsupported_parameter",
        "background"
      );
    }

    const inputItems = normalizeResponseInput(createRequest.input);
    const previousChain = this.validatePreviousResponse(
      createRequest.previous_response_id
    );

    const responseObject = createResponseObject(
      createRequest,
      this.defaultModel,
      findLatestConversationId(previousChain)
    );
    const record: StoredResponse = {
      request: createRequest,
      response: responseObject,
      inputItems,
      abortController: new AbortController(),
    };
    try {
      this.store.create(record);
    } catch (error) {
      if (isResponseStoreCapacityError(error)) {
        throw new ResponsesHttpError(
          503,
          "The response store is at capacity. Try again later.",
          "response_store_full"
        );
      }
      throw error;
    }

    const onClose = () => {
      if (!response.writableEnded && record.response.status === "in_progress") {
        record.abortController.abort();
      }
    };
    response.once("close", onClose);
    try {
      if (createRequest.stream === true) {
        await this.executeStreaming(record, response);
        return;
      }

      await this.executeNonStreaming(record);
      if (!response.destroyed && !response.writableEnded) {
        const statusCode = record.response.status === "failed" ? 500 : 200;
        sendJson(response, statusCode, structuredClone(record.response));
      }
    } finally {
      response.off("close", onClose);
      this.deleteEphemeralResponse(record);
    }
  }

  private handleGet(responseId: string, response: ServerResponse): void {
    const record = this.requireResponse(responseId);
    sendJson(response, 200, structuredClone(record.response));
  }

  private handleCancel(responseId: string, response: ServerResponse): void {
    const record = this.requireResponse(responseId);
    if (record.response.status === "in_progress") {
      record.response.status = "cancelled";
      record.response.error = {
        code: "cancelled",
        message: "Request was cancelled.",
      };
      record.abortController.abort();
    }
    sendJson(response, 200, structuredClone(record.response));
  }

  private handleDelete(responseId: string, response: ServerResponse): void {
    const record = this.requireResponse(responseId);
    if (record.response.status === "in_progress") {
      record.abortController.abort();
    }
    this.store.delete(responseId);
    response.writeHead(204);
    response.end();
  }

  private handleInputItems(
    responseId: string,
    url: URL,
    response: ServerResponse
  ): void {
    const record = this.requireResponse(responseId);
    const order = url.searchParams.get("order") ?? "desc";
    if (order !== "asc" && order !== "desc") {
      throw new ResponsesHttpError(
        400,
        "'order' must be either 'asc' or 'desc'.",
        "invalid_request",
        "order"
      );
    }
    const limit = parseLimit(url.searchParams.get("limit"));
    const after = url.searchParams.get("after");
    let items = [...record.inputItems];
    if (order === "desc") {
      items.reverse();
    }
    if (after !== null) {
      const afterIndex = items.findIndex((item) => item.id === after);
      items = afterIndex >= 0 ? items.slice(afterIndex + 1) : [];
    }
    const data = items.slice(0, limit);
    sendJson(response, 200, {
      object: "list",
      data: structuredClone(data),
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
      has_more: items.length > data.length,
    });
  }

  private async executeNonStreaming(record: StoredResponse): Promise<void> {
    const input = this.buildGraphInput(record);
    const config = this.buildRunnableConfig(record);
    const { response } = record;

    try {
      const result = await waitForOperation(
        this.graph.invoke(input, config),
        record.abortController.signal
      );
      if (record.abortController.signal.aborted) {
        markCancelled(response);
        return;
      }
      const generated = extractGeneratedMessages(result, input.messages);
      const converted = messagesToResponseOutput(generated);
      response.output = converted.output;
      response.usage = converted.usage;
      response.status = "completed";
      response.error = null;
    } catch (error) {
      if (record.abortController.signal.aborted) {
        markCancelled(response);
      } else {
        this.reportInternalError(error);
        markFailed(response, "internal_error", INTERNAL_ERROR_MESSAGE);
      }
    }
  }

  private async executeStreaming(
    record: StoredResponse,
    httpResponse: ServerResponse
  ): Promise<void> {
    httpResponse.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    httpResponse.flushHeaders();

    const input = this.buildGraphInput(record);
    const config = this.buildRunnableConfig(record, true);
    const builder = new ResponseStreamBuilder(record.response);
    if (!(await writeSseEvent(httpResponse, builder.created()))) {
      record.abortController.abort();
      markCancelled(record.response);
      return;
    }
    if (!(await writeSseEvent(httpResponse, builder.inProgress()))) {
      record.abortController.abort();
      markCancelled(record.response);
      return;
    }

    let iterator: AsyncIterator<unknown> | undefined;
    let iteratorCompleted = false;
    try {
      const stream = await waitForOperation(
        this.graph.stream(input, config),
        record.abortController.signal
      );
      if (!isAsyncIterable(stream)) {
        throw new Error(
          "The runnable's stream() method was not async iterable."
        );
      }
      iterator = stream[Symbol.asyncIterator]();
      let clientConnected = true;
      while (clientConnected) {
        const next = await waitForOperation(
          Promise.resolve(iterator.next()),
          record.abortController.signal
        );
        if (next.done) {
          iteratorCompleted = true;
          break;
        }
        for (const event of builder.handleChunk(next.value)) {
          if (!(await writeSseEvent(httpResponse, event))) {
            clientConnected = false;
            record.abortController.abort();
            break;
          }
        }
      }

      const terminalEvents = record.abortController.signal.aborted
        ? builder.cancelled()
        : builder.complete(input.messages);
      await writeTerminalEvents(httpResponse, terminalEvents);
    } catch (error) {
      const cancelled = record.abortController.signal.aborted;
      if (!cancelled) {
        this.reportInternalError(error);
      }
      const terminalEvents = cancelled
        ? builder.cancelled()
        : builder.failed("internal_error", INTERNAL_ERROR_MESSAGE);
      await writeTerminalEvents(httpResponse, terminalEvents);
    } finally {
      if (iterator !== undefined && !iteratorCompleted) {
        closeAsyncIterator(iterator, (error) =>
          this.reportInternalError(error)
        );
      }
    }
  }

  private buildGraphInput(record: StoredResponse): ResponsesGraphInput {
    const items: (
      | ResponseInputItem
      | (typeof record.response.output)[number]
    )[] = [];
    const usesCheckpointer = this.usesCheckpointer();
    if (!usesCheckpointer) {
      const history = this.getHistory(record);
      for (const previous of history) {
        items.push(...previous.inputItems, ...previous.response.output);
      }
    }
    items.push(...record.inputItems);

    const messages = responseItemsToMessages(items, {
      allowUnmatchedToolOutputs: usesCheckpointer,
    });
    if (record.request.instructions) {
      messages.unshift(new SystemMessage(record.request.instructions));
    }
    return { messages };
  }

  private buildRunnableConfig(
    record: StoredResponse,
    streaming = false
  ): Partial<ResponsesRunnableConfig> {
    return {
      configurable: {
        thread_id: this.resolveThreadId(record),
      },
      signal: record.abortController.signal,
      ...(streaming
        ? { streamMode: ["updates", "messages"] as ("updates" | "messages")[] }
        : {}),
    };
  }

  private getHistory(record: StoredResponse): StoredResponse[] {
    const previousResponseId = record.response.previous_response_id;
    if (previousResponseId !== null) {
      return this.requireResponseChain(previousResponseId);
    }
    const conversationId = record.response.conversation?.id;
    return conversationId === undefined
      ? []
      : this.store.getConversation(record.response.id, conversationId);
  }

  private resolveThreadId(record: StoredResponse): string {
    const conversationId = record.response.conversation?.id;
    if (conversationId !== undefined) {
      return conversationId;
    }
    const previousResponseId = record.response.previous_response_id;
    if (previousResponseId !== null) {
      const chain = this.requireResponseChain(previousResponseId);
      return `resp-${chain[0].response.id}`;
    }
    return `resp-${record.response.id}`;
  }

  private usesCheckpointer(): boolean {
    return (
      this.graph.checkpointer !== undefined &&
      this.graph.checkpointer !== null &&
      this.graph.checkpointer !== false
    );
  }

  private validatePreviousResponse(
    previousResponseId: string | null | undefined
  ): StoredResponse[] | undefined {
    if (previousResponseId === undefined || previousResponseId === null) {
      return undefined;
    }
    const previous = this.store.get(previousResponseId);
    if (previous === undefined) {
      throw new ResponsesHttpError(
        404,
        `Response '${previousResponseId}' was not found.`,
        "response_not_found",
        "previous_response_id"
      );
    }
    if (previous.response.status !== "completed") {
      throw new ResponsesHttpError(
        409,
        `Response '${previousResponseId}' is not completed.`,
        "response_not_completed",
        "previous_response_id"
      );
    }
    return this.requireResponseChain(previousResponseId);
  }

  private requireResponseChain(responseId: string): StoredResponse[] {
    const chain = this.store.getResponseChain(responseId);
    if (chain === undefined) {
      throw new ResponsesHttpError(
        409,
        `Response chain for '${responseId}' is incomplete.`,
        "response_chain_incomplete",
        "previous_response_id"
      );
    }
    return chain;
  }

  private requireResponse(responseId: string): StoredResponse {
    const record = this.store.get(responseId);
    if (record === undefined) {
      throw new ResponsesHttpError(
        404,
        `Response '${responseId}' was not found.`,
        "response_not_found"
      );
    }
    return record;
  }

  private deleteEphemeralResponse(record: StoredResponse): void {
    if (record.request.store === false) {
      this.store.delete(record.response.id);
    }
  }

  private parseRoute(
    pathname: string
  ):
    | { kind: "create" }
    | { kind: "response"; responseId: string }
    | { kind: "cancel"; responseId: string }
    | { kind: "input_items"; responseId: string }
    | { kind: "not_found" } {
    if (
      this.prefix &&
      pathname !== this.prefix &&
      !pathname.startsWith(`${this.prefix}/`)
    ) {
      return { kind: "not_found" };
    }

    const relative = (
      this.prefix ? pathname.slice(this.prefix.length) : pathname
    ).replace(/\/+$/, "");
    const segments = relative
      .split("/")
      .filter(Boolean)
      .map((segment) => decodePathSegment(segment));

    if (segments.length === 1 && segments[0] === "responses") {
      return { kind: "create" };
    }
    if (segments.length === 2 && segments[0] === "responses") {
      return { kind: "response", responseId: segments[1] };
    }
    if (
      segments.length === 3 &&
      segments[0] === "responses" &&
      segments[2] === "cancel"
    ) {
      return { kind: "cancel", responseId: segments[1] };
    }
    if (
      segments.length === 3 &&
      segments[0] === "responses" &&
      segments[2] === "input_items"
    ) {
      return { kind: "input_items", responseId: segments[1] };
    }
    return { kind: "not_found" };
  }

  private handleRequestError(error: unknown, response: ServerResponse): void {
    if (response.headersSent) {
      if (!response.writableEnded) {
        response.end();
      }
      return;
    }
    if (isResponsesHttpError(error)) {
      sendError(
        response,
        error.statusCode,
        error.message,
        error.code,
        error.param
      );
      return;
    }
    if (isResponsesValidationError(error)) {
      sendError(response, 400, error.message, error.code, error.param);
      return;
    }
    this.reportInternalError(error);
    sendError(response, 500, INTERNAL_ERROR_MESSAGE, "internal_error");
  }

  private handleUnexpectedError(
    error: unknown,
    response: ServerResponse
  ): void {
    this.reportInternalError(error);
    if (!response.headersSent) {
      sendError(response, 500, INTERNAL_ERROR_MESSAGE, "internal_error");
    } else if (!response.writableEnded) {
      response.end();
    }
  }

  private reportInternalError(error: unknown): void {
    try {
      this.onError(error);
    } catch (reportingError) {
      defaultErrorReporter(reportingError);
    }
  }
}

function createResponseObject(
  request: CreateResponseRequest,
  defaultModel: string,
  inheritedConversationId?: string
): ResponseObject {
  const conversationId =
    typeof request.conversation === "string"
      ? request.conversation
      : request.conversation?.id ?? inheritedConversationId;
  return {
    id: `resp_${randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    background: false,
    ...(conversationId ? { conversation: { id: conversationId } } : {}),
    error: null,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    metadata: request.metadata ?? {},
    model: request.model ?? defaultModel,
    output: [],
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: request.previous_response_id ?? null,
    reasoning: request.reasoning ?? null,
    store: request.store ?? true,
    temperature: request.temperature ?? null,
    text: request.text ?? { format: { type: "text" } },
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    top_p: request.top_p ?? null,
    truncation: request.truncation ?? "disabled",
    usage: null,
  };
}

function findLatestConversationId(
  records: StoredResponse[] | undefined
): string | undefined {
  if (records === undefined) {
    return undefined;
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const conversationId = records[index].response.conversation?.id;
    if (conversationId !== undefined) {
      return conversationId;
    }
  }
  return undefined;
}

function parseCreateRequest(value: unknown): CreateResponseRequest {
  if (!isRecord(value)) {
    throw new ResponsesHttpError(
      400,
      "Request body must be a JSON object.",
      "invalid_request"
    );
  }
  if (typeof value.input !== "string" && !Array.isArray(value.input)) {
    throw new ResponsesHttpError(
      400,
      "'input' must be a string or array.",
      "invalid_request",
      "input"
    );
  }

  return {
    input: value.input,
    background: optionalBoolean(value.background, "background"),
    conversation: optionalConversation(value.conversation),
    include: optionalStringArray(value.include, "include"),
    instructions: optionalNullableString(value.instructions, "instructions"),
    max_output_tokens: optionalNullableNumber(
      value.max_output_tokens,
      "max_output_tokens"
    ),
    metadata: optionalMetadata(value.metadata),
    model: optionalString(value.model, "model"),
    parallel_tool_calls: optionalBoolean(
      value.parallel_tool_calls,
      "parallel_tool_calls"
    ),
    previous_response_id: optionalNullableString(
      value.previous_response_id,
      "previous_response_id"
    ),
    reasoning: optionalRecordOrNull(value.reasoning, "reasoning"),
    store: optionalBoolean(value.store, "store"),
    stream: optionalBoolean(value.stream, "stream"),
    temperature: optionalNullableNumber(value.temperature, "temperature"),
    text: optionalRecord(value.text, "text"),
    tool_choice: value.tool_choice,
    tools: optionalArray(value.tools, "tools"),
    top_p: optionalNullableNumber(value.top_p, "top_p"),
    truncation: optionalString(value.truncation, "truncation"),
  };
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new ResponsesHttpError(
        413,
        `Request body exceeds the ${maxBytes} byte limit.`,
        "request_too_large"
      );
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new ResponsesHttpError(
      400,
      "Request body is required.",
      "invalid_json"
    );
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ResponsesHttpError(
      400,
      "Request body is not valid JSON.",
      "invalid_json"
    );
  }
}

function markFailed(
  response: ResponseObject,
  code: string,
  message: string
): void {
  response.status = "failed";
  response.error = { code, message };
}

function markCancelled(response: ResponseObject): void {
  response.status = "cancelled";
  response.error = {
    code: "cancelled",
    message: "Request was cancelled.",
  };
}

async function writeTerminalEvents(
  response: ServerResponse,
  events: ResponsesStreamEvent[]
): Promise<void> {
  for (const event of events) {
    if (!(await writeSseEvent(response, event))) {
      return;
    }
  }
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.end("data: [DONE]\n\n");
}

async function writeSseEvent(
  response: ServerResponse,
  event: ResponsesStreamEvent
): Promise<boolean> {
  if (response.destroyed || response.writableEnded) {
    return false;
  }
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (response.write(frame)) {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    function cleanup() {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onClose);
    }
    function onDrain() {
      cleanup();
      resolve(true);
    }
    function onClose() {
      cleanup();
      resolve(false);
    }
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
  });
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  const content = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
  });
  response.end(content);
}

function sendError(
  response: ServerResponse,
  statusCode: number,
  message: string,
  code: string,
  param: string | null = null
): void {
  sendJson(response, statusCode, {
    error: {
      message,
      type: "invalid_request_error",
      param,
      code,
    },
  });
}

function isResponsesHttpError(value: unknown): value is ResponsesHttpError {
  return (
    isRecord(value) &&
    value.isResponsesHttpError === true &&
    typeof value.statusCode === "number" &&
    typeof value.message === "string" &&
    typeof value.code === "string"
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function waitForOperation<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("Response operation was cancelled."));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (!settled) {
        settled = true;
        reject(new Error("Response operation was cancelled."));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      }
    );
  });
}

function closeAsyncIterator(
  iterator: AsyncIterator<unknown>,
  onError: (error: unknown) => void
): void {
  if (iterator.return === undefined) {
    return;
  }
  try {
    void Promise.resolve(iterator.return()).catch(onError);
  } catch (error) {
    onError(error);
  }
}

function defaultErrorReporter(error: unknown): void {
  const message =
    isRecord(error) && typeof error.stack === "string"
      ? error.stack
      : errorMessage(error);
  process.emitWarning(message, { type: "ResponsesHostServerError" });
}

function normalizePrefix(prefix: string): string {
  if (!prefix || prefix === "/") {
    return "";
  }
  return `/${prefix.replace(/^\/+|\/+$/g, "")}`;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ResponsesHttpError(
      400,
      "Request path contains invalid URL encoding.",
      "invalid_path"
    );
  }
}

function parseLimit(value: string | null): number {
  if (value === null) {
    return 20;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ResponsesHttpError(
      400,
      "'limit' must be an integer between 1 and 100.",
      "invalid_request",
      "limit"
    );
  }
  return limit;
}

function optionalBoolean(value: unknown, param: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw invalidParameter(param, "a boolean");
}

function optionalString(value: unknown, param: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw invalidParameter(param, "a non-empty string");
}

function optionalNullableString(
  value: unknown,
  param: string
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return optionalString(value, param);
}

function optionalNullableNumber(
  value: unknown,
  param: string
): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw invalidParameter(param, "a finite number or null");
}

function optionalArray(value: unknown, param: string): unknown[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value;
  }
  throw invalidParameter(param, "an array");
}

function optionalStringArray(
  value: unknown,
  param: string
): string[] | undefined {
  const array = optionalArray(value, param);
  if (array === undefined) {
    return undefined;
  }
  if (array.every((item) => typeof item === "string")) {
    return array.map((item) => String(item));
  }
  throw invalidParameter(param, "an array of strings");
}

function optionalRecord(
  value: unknown,
  param: string
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isRecord(value)) {
    return { ...value };
  }
  throw invalidParameter(param, "an object");
}

function optionalRecordOrNull(
  value: unknown,
  param: string
): Record<string, unknown> | null | undefined {
  if (value === null) {
    return null;
  }
  return optionalRecord(value, param);
}

function optionalMetadata(value: unknown): Record<string, string> | undefined {
  const metadata = optionalRecord(value, "metadata");
  if (metadata === undefined) {
    return undefined;
  }
  if (Object.values(metadata).every((item) => typeof item === "string")) {
    return Object.fromEntries(
      Object.entries(metadata).map(([key, item]) => [key, String(item)])
    );
  }
  throw invalidParameter("metadata", "an object with string values");
}

function optionalConversation(
  value: unknown
): string | { id: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) {
    return { id: value.id };
  }
  throw invalidParameter("conversation", "a string or object with an id");
}

function invalidParameter(param: string, expected: string): ResponsesHttpError {
  return new ResponsesHttpError(
    400,
    `'${param}' must be ${expected}.`,
    "invalid_request",
    param
  );
}

function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === "string"
    ? error.message
    : String(error);
}
