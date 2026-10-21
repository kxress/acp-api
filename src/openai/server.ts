import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import process from "node:process";
import type { AcpPromptBlock } from "../acp/protocol.ts";
import type { OpenAiProxyConfig } from "./config.ts";
import {
  buildChatPrompt,
  buildCompletionPrompt,
  buildResponsesPrompt,
  chatResponse,
  completionResponse,
  extractClientToolCalls,
  finishReason,
  makeId,
  OpenAiRequestError,
  responsesResponse,
} from "./compat.ts";
import { OpenAiRuntime } from "./runtime.ts";

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function errorBody(message: string, type: string, code: string | null = null) {
  return { error: { message, type, param: null, code } };
}

function asError(error: unknown): {
  status: number;
  body: ReturnType<typeof errorBody>;
} {
  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      status: 504,
      body: errorBody(error.message, "server_error", "request_timeout"),
    };
  }
  if (error instanceof OpenAiRequestError) {
    return {
      status: error.status,
      body: errorBody(error.message, error.type, error.code),
    };
  }
  if (error instanceof SyntaxError) {
    return {
      status: 400,
      body: errorBody(
        "request body is not valid JSON",
        "invalid_request_error",
      ),
    };
  }
  if (error instanceof Error && error.message.startsWith("Model not found:")) {
    return {
      status: 404,
      body: errorBody(
        error.message,
        "invalid_request_error",
        "model_not_found",
      ),
    };
  }
  return {
    status: 502,
    body: errorBody(
      error instanceof Error ? error.message : String(error),
      "acp_error",
      "upstream_error",
    ),
  };
}

function bearerAuthorized(req: IncomingMessage, apiKey: string): boolean {
  if (!apiKey) return true;
  const header = req.headers.authorization;
  if (typeof header !== "string" || !/^Bearer /i.test(header)) return false;
  const received = Buffer.from(header.slice(7));
  const expected = Buffer.from(apiKey);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

async function readJson(
  req: IncomingMessage,
  limit: number,
): Promise<Record<string, unknown>> {
  const contentType = req.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().includes("application/json")
  ) {
    throw new OpenAiRequestError(
      "content-type must be application/json",
      415,
      "invalid_request_error",
    );
  }
  const length = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(length) && length > limit) {
    throw new OpenAiRequestError(
      "request body is too large",
      413,
      "invalid_request_error",
      "request_too_large",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > limit) {
      throw new OpenAiRequestError(
        "request body is too large",
        413,
        "invalid_request_error",
        "request_too_large",
      );
    }
    chunks.push(chunk);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpenAiRequestError("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function modelFrom(body: Record<string, unknown>): string {
  if (typeof body.model !== "string" || !body.model.trim()) {
    throw new OpenAiRequestError("model is required");
  }
  return body.model;
}

function affinityKey(
  req: IncomingMessage,
  body: Record<string, unknown>,
  blocks: AcpPromptBlock[],
): string {
  const routingHeader = req.headers["x-acp-routing-key"];
  if (typeof routingHeader === "string" && routingHeader) return routingHeader;
  const key =
    body.conversation_id ??
    body.conversationId ??
    body.user ??
    body.routing_key ??
    body.routingKey;
  if (typeof key === "string" && key) return key;
  return blocks
    .map((block) =>
      block.type === "text" ? String(block.text ?? "") : JSON.stringify(block),
    )
    .join("\n")
    .slice(0, 4096);
}

function setRequestHeaders(
  res: ServerResponse,
  requestId: string,
  model: string,
  selection: { workerId: string; upstreamModel?: string },
): void {
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-acp-agent", selection.workerId);
  res.setHeader("x-acp-model", model);
  if (selection.upstreamModel)
    res.setHeader("x-acp-upstream-model", selection.upstreamModel);
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function sendSse(res: ServerResponse, data: unknown, event?: string): void {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendChatChunk(
  res: ServerResponse,
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finish: string | null = null,
): void {
  sendSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
}

function sendCompletionChunk(
  res: ServerResponse,
  id: string,
  created: number,
  model: string,
  text: string,
  finish: string | null = null,
): void {
  sendSse(res, {
    id,
    object: "text_completion",
    created,
    model,
    choices: [{ index: 0, text, logprobs: null, finish_reason: finish }],
  });
}

function ensureModel(
  runtime: OpenAiRuntime,
  body: Record<string, unknown>,
): string {
  const model = modelFrom(body);
  if (!runtime.hasModel(model)) throw new Error(`Model not found: ${model}`);
  return model;
}

function requestController(
  req: IncomingMessage,
  res: ServerResponse,
  timeoutMs: number,
): { controller: AbortController; close: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException("Request timed out", "TimeoutError")),
    timeoutMs,
  );
  const onAborted = () => controller.abort(new Error("client disconnected"));
  const onClosed = () => {
    if (!res.writableEnded) controller.abort(new Error("client disconnected"));
  };
  req.once("aborted", onAborted);
  res.once("close", onClosed);
  return {
    controller,
    close: () => {
      clearTimeout(timer);
      req.off("aborted", onAborted);
      res.off("close", onClosed);
    },
  };
}

async function chatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  runtime: OpenAiRuntime,
  config: OpenAiProxyConfig,
  requestId: string,
): Promise<void> {
  const model = ensureModel(runtime, body);
  const built = buildChatPrompt(body, runtime.capabilitiesForModel(model));
  if (!runtime.supportsInput(model, built.blocks)) {
    throw new OpenAiRequestError(
      `No ACP runtime backing model '${model}' advertises the requested input capabilities`,
      400,
      "invalid_request_error",
      "unsupported_capability",
    );
  }
  const streamed = body.stream === true;
  const includeUsage =
    (body.stream_options as Record<string, unknown> | undefined)
      ?.include_usage === true;
  const id = makeId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const abort = requestController(req, res, config.requestTimeoutMs);
  let selected: { workerId: string; upstreamModel?: string } | undefined;
  let started = false;
  const start = () => {
    if (started) return;
    if (selected) setRequestHeaders(res, requestId, model, selected);
    sseHeaders(res);
    started = true;
    sendChatChunk(res, id, created, model, { role: "assistant" });
  };
  try {
    const result = await runtime.generate(
      model,
      built.blocks,
      affinityKey(req, body, built.blocks),
      abort.controller.signal,
      (value) => {
        selected = value;
      },
      streamed && !built.toolContext.instruction
        ? (delta) => {
            start();
            sendChatChunk(res, id, created, model, { content: delta });
          }
        : undefined,
    );
    selected = {
      workerId: result.workerId,
      upstreamModel: result.upstreamModel,
    };
    const toolCalls = extractClientToolCalls(result.text, body);
    if (!streamed) {
      setRequestHeaders(res, requestId, model, selected);
      json(
        res,
        200,
        chatResponse(
          model,
          built.blocks,
          result.text,
          result.stopReason,
          toolCalls,
        ),
      );
      return;
    }
    start();
    if (toolCalls.length) {
      sendChatChunk(res, id, created, model, {
        tool_calls: toolCalls.map((call, index) => ({
          index,
          id: call.id,
          type: call.type,
          function: call.function,
        })),
      });
    }
    const reason = toolCalls.length
      ? "tool_calls"
      : finishReason(result.stopReason);
    sendChatChunk(res, id, created, model, {}, reason);
    if (includeUsage) {
      const completion = chatResponse(
        model,
        built.blocks,
        result.text,
        result.stopReason,
        toolCalls,
      );
      sendSse(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: completion.usage,
      });
    }
    sendSse(res, "[DONE]");
    res.end();
  } finally {
    abort.close();
  }
}

async function completions(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  runtime: OpenAiRuntime,
  config: OpenAiProxyConfig,
  requestId: string,
): Promise<void> {
  const model = ensureModel(runtime, body);
  const blocks = buildCompletionPrompt(body);
  const streamed = body.stream === true;
  const id = makeId("cmpl");
  const created = Math.floor(Date.now() / 1000);
  const abort = requestController(req, res, config.requestTimeoutMs);
  let selected: { workerId: string; upstreamModel?: string } | undefined;
  let started = false;
  const start = () => {
    if (started) return;
    if (selected) setRequestHeaders(res, requestId, model, selected);
    sseHeaders(res);
    started = true;
  };
  try {
    const result = await runtime.generate(
      model,
      blocks,
      affinityKey(req, body, blocks),
      abort.controller.signal,
      (value) => {
        selected = value;
      },
      streamed
        ? (delta) => {
            start();
            sendCompletionChunk(res, id, created, model, delta);
          }
        : undefined,
    );
    selected = {
      workerId: result.workerId,
      upstreamModel: result.upstreamModel,
    };
    if (!streamed) {
      setRequestHeaders(res, requestId, model, selected);
      json(
        res,
        200,
        completionResponse(model, blocks, result.text, result.stopReason),
      );
      return;
    }
    start();
    sendCompletionChunk(
      res,
      id,
      created,
      model,
      "",
      finishReason(result.stopReason),
    );
    sendSse(res, "[DONE]");
    res.end();
  } finally {
    abort.close();
  }
}

async function responses(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  runtime: OpenAiRuntime,
  config: OpenAiProxyConfig,
  requestId: string,
): Promise<void> {
  const model = ensureModel(runtime, body);
  const blocks = buildResponsesPrompt(
    body,
    runtime.capabilitiesForModel(model),
  );
  if (!runtime.supportsInput(model, blocks)) {
    throw new OpenAiRequestError(
      `No ACP runtime backing model '${model}' advertises the requested input capabilities`,
      400,
      "invalid_request_error",
      "unsupported_capability",
    );
  }
  const streamed = body.stream === true;
  const abort = requestController(req, res, config.requestTimeoutMs);
  const responseId = makeId("resp");
  const itemId = makeId("msg");
  let selected: { workerId: string; upstreamModel?: string } | undefined;
  let started = false;
  let fullText = "";
  const start = () => {
    if (started) return;
    if (selected) setRequestHeaders(res, requestId, model, selected);
    sseHeaders(res);
    started = true;
    const base = {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model,
      output: [],
      error: null,
      incomplete_details: null,
      usage: null,
      metadata: {},
    };
    sendSse(
      res,
      { type: "response.created", response: base },
      "response.created",
    );
    sendSse(
      res,
      { type: "response.in_progress", response: base },
      "response.in_progress",
    );
    const item = {
      id: itemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    sendSse(
      res,
      { type: "response.output_item.added", output_index: 0, item },
      "response.output_item.added",
    );
    const part = { type: "output_text", text: "", annotations: [] };
    sendSse(
      res,
      {
        type: "response.content_part.added",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part,
      },
      "response.content_part.added",
    );
  };
  try {
    const result = await runtime.generate(
      model,
      blocks,
      affinityKey(req, body, blocks),
      abort.controller.signal,
      (value) => {
        selected = value;
      },
      streamed
        ? async (delta) => {
            start();
            fullText += delta;
            sendSse(
              res,
              {
                type: "response.output_text.delta",
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                delta,
              },
              "response.output_text.delta",
            );
          }
        : undefined,
    );
    selected = {
      workerId: result.workerId,
      upstreamModel: result.upstreamModel,
    };
    if (!streamed) {
      setRequestHeaders(res, requestId, model, selected);
      const response = responsesResponse(
        model,
        blocks,
        result.text,
        result.stopReason,
      );
      response.id = responseId;
      response.output[0].id = itemId;
      json(res, 200, response);
      return;
    }
    start();
    fullText = result.text;
    sendSse(
      res,
      {
        type: "response.output_text.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text: fullText,
      },
      "response.output_text.done",
    );
    const part = { type: "output_text", text: fullText, annotations: [] };
    sendSse(
      res,
      {
        type: "response.content_part.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part,
      },
      "response.content_part.done",
    );
    const item = {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [part],
    };
    sendSse(
      res,
      { type: "response.output_item.done", output_index: 0, item },
      "response.output_item.done",
    );
    const response = responsesResponse(
      model,
      blocks,
      fullText,
      result.stopReason,
    );
    response.id = responseId;
    response.output[0].id = itemId;
    sendSse(
      res,
      { type: "response.completed", response },
      "response.completed",
    );
    res.end();
  } finally {
    abort.close();
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: OpenAiProxyConfig,
  runtime: OpenAiRuntime,
): Promise<void> {
  const requestId = makeId("req");
  res.setHeader("x-request-id", requestId);
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  if (
    req.method === "GET" &&
    (url.pathname === "/health" || url.pathname === "/healthz")
  ) {
    json(res, 200, {
      status: "ok",
      service: "acp-openai-proxy",
      models: runtime.listModels().length,
    });
    return;
  }
  if (!bearerAuthorized(req, config.apiKey)) {
    res.setHeader("www-authenticate", "Bearer");
    json(
      res,
      401,
      errorBody(
        "invalid or missing API key",
        "authentication_error",
        "invalid_api_key",
      ),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    const data = runtime.listModels();
    json(res, 200, { object: "list", data });
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/v1/models/")) {
    let id: string;
    try {
      id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
    } catch {
      throw new OpenAiRequestError("model id is not valid URL encoding", 400);
    }
    const model = runtime.model(id);
    if (!model) {
      json(
        res,
        404,
        errorBody(
          `Model not found: ${id}`,
          "invalid_request_error",
          "model_not_found",
        ),
      );
      return;
    }
    json(res, 200, model);
    return;
  }
  if (req.method !== "POST") {
    json(
      res,
      404,
      errorBody("route not found", "invalid_request_error", "route_not_found"),
    );
    return;
  }

  const body = await readJson(req, config.maxBodyBytes);
  if (url.pathname === "/v1/chat/completions") {
    await chatCompletions(req, res, body, runtime, config, requestId);
  } else if (url.pathname === "/v1/completions") {
    await completions(req, res, body, runtime, config, requestId);
  } else if (url.pathname === "/v1/responses") {
    await responses(req, res, body, runtime, config, requestId);
  } else {
    json(
      res,
      404,
      errorBody("route not found", "invalid_request_error", "route_not_found"),
    );
  }
}

export function createOpenAiHttpServer(
  config: OpenAiProxyConfig,
  runtime: OpenAiRuntime,
): Server {
  return createServer((req, res) => {
    void handleRequest(req, res, config, runtime).catch((error) => {
      if (res.writableEnded || res.destroyed) return;
      const failure = asError(error);
      if (res.headersSent) {
        sendSse(res, failure.body);
        sendSse(res, "[DONE]");
        res.end();
      } else {
        json(res, failure.status, failure.body);
      }
    });
  });
}

export async function startOpenAiServer(
  config: OpenAiProxyConfig,
): Promise<void> {
  const runtime = await OpenAiRuntime.start(config);
  const server = createOpenAiHttpServer(config, runtime);
  let shutdown: Promise<void> | undefined;
  const close = () => {
    if (!shutdown) {
      shutdown = new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      }).then(async () => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        await runtime.close();
      });
    }
    return shutdown;
  };
  const onSignal = () => {
    void close().finally(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
    console.log(
      `OpenAI-compatible API listening at http://${config.host}:${config.port}`,
    );
    console.log(
      `ACP models: ${runtime
        .listModels()
        .map((model) => model.id)
        .join(", ")}`,
    );
  } catch (error) {
    await runtime.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    throw error;
  }
}
