import { afterEach, describe, expect, test } from "@jest/globals";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";

import {
  InMemoryResponseStore,
  ResponsesHostServer,
  type ResponseObject,
  type ResponsesGraphInput,
  type ResponsesHostServerOptions,
  type ResponsesRunnable,
  type ResponsesStreamEvent,
} from "../agents/hosting/index.js";

const servers: ResponsesHostServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("ResponsesHostServer", () => {
  test("creates and retrieves a non-streaming response", async () => {
    const receivedInputs: ResponsesGraphInput[] = [];
    const server = await startServer(createEchoRunnable(receivedInputs));

    const create = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hello", model: "test-model" }),
    });

    expect(create.status).toBe(200);
    const created = (await create.json()) as ResponseObject;
    expect(created).toMatchObject({
      object: "response",
      status: "completed",
      model: "test-model",
    });
    expect(messageText(created)).toBe("Echo: hello");
    expect(receivedInputs).toHaveLength(1);
    expect(receivedInputs[0].messages[0]).toBeInstanceOf(HumanMessage);

    const get = await fetch(`${server.url}/responses/${created.id}`);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(created);
  });

  test("emits Responses lifecycle and text delta SSE events", async () => {
    const runnable: ResponsesRunnable = {
      invoke: async () => ({ messages: [new AIMessage("Hello, world!")] }),
      stream: async () =>
        generate([
          ["messages", [new AIMessageChunk("Hello, "), {}]],
          ["messages", [new AIMessageChunk("world!"), {}]],
        ]),
    };
    const server = await startServer(runnable);

    const response = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "ignored", stream: true }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await response.text());
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.done",
        "response.output_item.done",
        "response.completed",
      ])
    );
    expect(
      events
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => event.delta)
        .join("")
    ).toBe("Hello, world!");
  });

  test("lists normalized input items with pagination metadata", async () => {
    const server = await startServer(createEchoRunnable());
    const create = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "hello" },
        ],
      }),
    });
    const created = (await create.json()) as ResponseObject;

    const inputItems = await fetch(
      `${server.url}/responses/${created.id}/input_items?order=asc&limit=1`
    );
    const payload = (await inputItems.json()) as {
      object: string;
      data: Array<{ id: string; role: string; type: string }>;
      first_id: string;
      last_id: string;
      has_more: boolean;
    };

    expect(payload.object).toBe("list");
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]).toMatchObject({
      type: "message",
      role: "system",
    });
    expect(payload.first_id).toBe(payload.data[0].id);
    expect(payload.last_id).toBe(payload.data[0].id);
    expect(payload.has_more).toBe(true);
  });

  test("continues previous-response history for stateless runnables", async () => {
    const receivedInputs: ResponsesGraphInput[] = [];
    const runnable = {
      ...createEchoRunnable(receivedInputs),
      checkpointer: false,
    };
    const server = await startServer(runnable);
    const first = await createResponse(server.url, { input: "one" });
    const second = await createResponse(server.url, {
      input: "two",
      previous_response_id: first.id,
    });

    expect(messageText(second)).toBe("Echo: two");
    expect(
      receivedInputs[1].messages.map((message) =>
        typeof message.content === "string" ? message.content : ""
      )
    ).toEqual(["one", "Echo: one", "two"]);
  });

  test("cancels an active stream and persists cancelled status", async () => {
    const runnable: ResponsesRunnable = {
      invoke: async () => ({ messages: [] }),
      stream: async () => ignoreCancellation(),
    };
    const server = await startServer(runnable);

    const streamingResponse = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "wait", stream: true }),
    });
    const record = server.instance.store.values()[0];
    expect(record).toBeDefined();

    const cancel = await fetch(
      `${server.url}/responses/${record.response.id}/cancel`,
      { method: "POST" }
    );
    const cancelled = (await cancel.json()) as ResponseObject;
    expect(cancelled.status).toBe("cancelled");

    const events = parseSse(
      await Promise.race([streamingResponse.text(), timeoutAfter(1000)])
    );
    expect(events.at(-1)?.type).toBe("response.failed");
    const stored = await fetch(`${server.url}/responses/${record.response.id}`);
    expect((await stored.json()) as ResponseObject).toMatchObject({
      status: "cancelled",
      error: { code: "cancelled" },
    });
  });

  test("deletes responses and returns OpenAI-style not-found errors", async () => {
    const server = await startServer(createEchoRunnable());
    const created = await createResponse(server.url, { input: "delete me" });

    const remove = await fetch(`${server.url}/responses/${created.id}`, {
      method: "DELETE",
    });
    expect(remove.status).toBe(204);

    const missing = await fetch(`${server.url}/responses/${created.id}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "response_not_found",
      },
    });
  });

  test("streams function calls and outputs from graph updates", async () => {
    const runnable: ResponsesRunnable = {
      invoke: async () => ({ messages: [] }),
      stream: async () =>
        generate([
          [
            "updates",
            {
              agent: {
                messages: [
                  new AIMessage({
                    content: "",
                    tool_calls: [
                      {
                        id: "call_weather",
                        name: "get_weather",
                        args: { city: "Seattle" },
                      },
                    ],
                  }),
                ],
              },
            },
          ],
          [
            "updates",
            {
              tools: {
                messages: [
                  new ToolMessage({
                    content: "sunny",
                    tool_call_id: "call_weather",
                  }),
                ],
              },
            },
          ],
        ]),
    };
    const server = await startServer(runnable);

    const response = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "weather", stream: true }),
    });
    const events = parseSse(await response.text());

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.output_item.done",
        "response.completed",
      ])
    );
    const completed = events.find(
      (event) => event.type === "response.completed"
    );
    const completedResponse = completed?.response as ResponseObject;
    expect(completedResponse.output.map((item) => item.type)).toEqual([
      "function_call",
      "function_call_output",
    ]);
  });

  test("runs a real LangGraph 0.4.9 MessagesAnnotation graph", async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("echo", (state) => {
        const last = state.messages[state.messages.length - 1];
        const text =
          typeof last?.content === "string" ? last.content : "unknown";
        return { messages: [new AIMessage(`LangGraph: ${text}`)] };
      })
      .addEdge(START, "echo")
      .addEdge("echo", END)
      .compile();
    const server = await startServer(graph);

    const response = await createResponse(server.url, {
      input: "compatible",
    });

    expect(response.status).toBe("completed");
    expect(messageText(response)).toBe("LangGraph: compatible");

    const streamed = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "streamed", stream: true }),
    });
    const completed = parseSse(await streamed.text()).find(
      (event) => event.type === "response.completed"
    );
    expect(messageText(completed?.response as ResponseObject)).toBe(
      "LangGraph: streamed"
    );
  });

  test("rejects unsupported background and malformed input requests", async () => {
    const server = await startServer(createEchoRunnable());

    const background = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hello", background: true }),
    });
    expect(background.status).toBe(400);

    const malformed = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: [{ type: "computer_call" }] }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: "unsupported_input_item" },
    });
  });

  test("does not persist responses when store is false", async () => {
    const server = await startServer(createEchoRunnable());
    const created = await createResponse(server.url, {
      input: "ephemeral",
      store: false,
    });

    expect(created.status).toBe("completed");
    const get = await fetch(`${server.url}/responses/${created.id}`);
    expect(get.status).toBe(404);
  });

  test("bounds stored responses and expires terminal records", async () => {
    let now = 0;
    const store = new InMemoryResponseStore({
      maxRecords: 1,
      ttlMs: 10,
      now: () => now,
    });
    const server = await startServer(createEchoRunnable(), { store });
    const first = await createResponse(server.url, { input: "first" });
    const second = await createResponse(server.url, { input: "second" });

    expect(
      await fetch(`${server.url}/responses/${first.id}`).then(
        (response) => response.status
      )
    ).toBe(404);
    expect(
      await fetch(`${server.url}/responses/${second.id}`).then(
        (response) => response.status
      )
    ).toBe(200);

    now = 11;
    expect(
      await fetch(`${server.url}/responses/${second.id}`).then(
        (response) => response.status
      )
    ).toBe(404);
  });

  test("rejects new work at capacity and promptly cancels ignored invokes", async () => {
    const runnable: ResponsesRunnable = {
      invoke: async () => neverResolves(),
      stream: async () => generate([]),
    };
    const store = new InMemoryResponseStore({
      maxRecords: 1,
      ttlMs: 60_000,
    });
    const server = await startServer(runnable, { store });
    const firstRequest = fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "wait" }),
    });
    await waitFor(() => store.values().length === 1);
    const record = store.values()[0];

    const full = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "rejected" }),
    });
    expect(full.status).toBe(503);
    expect(await full.json()).toMatchObject({
      error: { code: "response_store_full" },
    });

    await fetch(`${server.url}/responses/${record.response.id}/cancel`, {
      method: "POST",
    });
    const cancelled = (await Promise.race([
      firstRequest.then((response) => response.json()),
      timeoutAfter(1000),
    ])) as ResponseObject;
    expect(cancelled.status).toBe("cancelled");
  });

  test("reports internal errors without exposing their details", async () => {
    const internalError = new Error("secret backend path");
    const reported: unknown[] = [];
    const runnable: ResponsesRunnable = {
      invoke: async () => Promise.reject(internalError),
      stream: async () => generate([]),
    };
    const server = await startServer(runnable, {
      onError: (error) => reported.push(error),
    });

    const response = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "fail" }),
    });
    const payload = (await response.json()) as ResponseObject;

    expect(response.status).toBe(500);
    expect(payload.error).toMatchObject({ code: "internal_error" });
    expect(payload.error?.message).not.toContain("secret backend path");
    expect(reported).toEqual([internalError]);
  });
});

function createEchoRunnable(
  receivedInputs: ResponsesGraphInput[] = []
): ResponsesRunnable {
  return {
    invoke: async (input) => {
      receivedInputs.push(input);
      const lastHuman = [...input.messages]
        .reverse()
        .find((message) => message.getType() === "human");
      const text =
        typeof lastHuman?.content === "string" ? lastHuman.content : "";
      return {
        messages: [...input.messages, new AIMessage(`Echo: ${text}`)],
      };
    },
    stream: async () => generate([]),
  };
}

async function startServer(
  runnable: ResponsesRunnable,
  options: ResponsesHostServerOptions = {}
): Promise<{ instance: ResponsesHostServer; url: string }> {
  const instance = new ResponsesHostServer(runnable, options);
  servers.push(instance);
  const address = await instance.listen(0, "127.0.0.1");
  return {
    instance,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function createResponse(
  url: string,
  request: Record<string, unknown>
): Promise<ResponseObject> {
  const response = await fetch(`${url}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ResponseObject;
}

function messageText(response: ResponseObject): string {
  return response.output
    .flatMap((item) => (item.type === "message" ? item.content : []))
    .map((part) => part.text ?? "")
    .join("");
}

async function* generate(items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) {
    yield item;
  }
}

async function* ignoreCancellation(): AsyncGenerator<unknown> {
  yield ["messages", [new AIMessageChunk("waiting"), {}]];
  await neverResolves();
}

function neverResolves<T = void>(): Promise<T> {
  return new Promise<T>(() => {
    // Intentionally left pending to verify host-side cancellation.
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for test condition.");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation did not settle within ${ms}ms.`));
    }, ms);
    timer.unref();
  });
}

function parseSse(body: string): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [];
  for (const frame of body.split("\n\n")) {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (!data || data === "[DONE]") {
      continue;
    }
    events.push(JSON.parse(data) as ResponsesStreamEvent);
  }
  return events;
}
