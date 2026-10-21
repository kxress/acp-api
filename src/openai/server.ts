import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import process from "node:process";
import type { AcpPromptBlock } from "../acp/protocol.ts";
import {
  AnthropicRequestError,
  anthropicError,
  anthropicResponse,
  buildAnthropicPrompt,
} from "../anthropic.ts";
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
  estimateTokens,
  promptTextForUsage,
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

function isAnthropicRequest(req: IncomingMessage): boolean {
  return (
    req.url?.startsWith("/v1/messages") === true ||
    typeof req.headers["anthropic-version"] === "string"
  );
}

function asError(
  error: unknown,
  anthropic = false,
): {
  status: number;
  body: ReturnType<typeof errorBody> | Record<string, unknown>;
} {
  let failure: { status: number; body: ReturnType<typeof errorBody> };
  if (error instanceof AnthropicRequestError) {
    failure = {
      status: error.status,
      body: errorBody(error.message, error.type),
    };
  } else if (error instanceof Error && error.name === "TimeoutError") {
    failure = {
      status: 504,
      body: errorBody(error.message, "server_error", "request_timeout"),
    };
  } else if (error instanceof OpenAiRequestError) {
    failure = {
      status: error.status,
      body: errorBody(error.message, error.type, error.code),
    };
  } else if (error instanceof SyntaxError) {
    failure = {
      status: 400,
      body: errorBody(
        "request body is not valid JSON",
        "invalid_request_error",
      ),
    };
  } else if (
    error instanceof Error &&
    error.message.startsWith("Model not found:")
  ) {
    failure = {
      status: 404,
      body: errorBody(
        error.message,
        "invalid_request_error",
        "model_not_found",
      ),
    };
  } else {
    failure = {
      status: 502,
      body: errorBody(
        error instanceof Error ? error.message : String(error),
        "acp_error",
        "upstream_error",
      ),
    };
  }
  if (!anthropic) return failure;
  const message = failure.body.error.message;
  const type =
    failure.status === 401
      ? "authentication_error"
      : failure.status === 404
        ? "not_found_error"
        : failure.status >= 500
          ? "api_error"
          : "invalid_request_error";
  return { status: failure.status, body: anthropicError(message, type) };
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

function authorized(
  req: IncomingMessage,
  apiKey: string,
  anthropic: boolean,
): boolean {
  if (!apiKey) return true;
  if (!anthropic) return bearerAuthorized(req, apiKey);
  const value = req.headers["x-api-key"];
  if (typeof value === "string") {
    const received = Buffer.from(value);
    const expected = Buffer.from(apiKey);
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  }
  return bearerAuthorized(req, apiKey);
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
  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? (body.metadata as Record<string, unknown>)
      : undefined;
  const key =
    body.conversation_id ??
    body.conversationId ??
    body.user ??
    metadata?.user_id ??
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
  const payload = data === "[DONE]" ? "[DONE]" : JSON.stringify(data);
  res.write(`data: ${payload}\n\n`);
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
  const built = buildResponsesPrompt(body, runtime.capabilitiesForModel(model));
  const { blocks } = built;
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
      streamed && !built.toolContext.instruction
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
    const toolCalls = extractClientToolCalls(result.text, body);
    if (!streamed) {
      setRequestHeaders(res, requestId, model, selected);
      const response = responsesResponse(
        model,
        blocks,
        result.text,
        result.stopReason,
        toolCalls,
      );
      response.id = responseId;
      if (response.output[0]?.type === "message") {
        response.output[0].id = itemId;
      }
      json(res, 200, response);
      return;
    }
    if (toolCalls.length) {
      setRequestHeaders(res, requestId, model, selected);
      sseHeaders(res);
      const response = responsesResponse(
        model,
        blocks,
        result.text,
        result.stopReason,
        toolCalls,
      );
      response.id = responseId;
      const base = {
        ...response,
        status: "in_progress",
        output: [],
        usage: null,
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
      for (const [index, item] of response.output.entries()) {
        const functionCall = item as {
          id: string;
          type: string;
          status: string;
          call_id: string;
          name: string;
          arguments: string;
        };
        const inProgress = {
          ...functionCall,
          status: "in_progress",
          arguments: "",
        };
        sendSse(
          res,
          {
            type: "response.output_item.added",
            output_index: index,
            item: inProgress,
          },
          "response.output_item.added",
        );
        sendSse(
          res,
          {
            type: "response.function_call_arguments.delta",
            item_id: functionCall.id,
            output_index: index,
            delta: functionCall.arguments,
          },
          "response.function_call_arguments.delta",
        );
        sendSse(
          res,
          {
            type: "response.function_call_arguments.done",
            item_id: functionCall.id,
            output_index: index,
            arguments: functionCall.arguments,
          },
          "response.function_call_arguments.done",
        );
        sendSse(
          res,
          {
            type: "response.output_item.done",
            output_index: index,
            item: functionCall,
          },
          "response.output_item.done",
        );
      }
      sendSse(
        res,
        { type: "response.completed", response },
        "response.completed",
      );
      res.end();
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

async function anthropicMessages(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  runtime: OpenAiRuntime,
  config: OpenAiProxyConfig,
  requestId: string,
): Promise<void> {
  const model = ensureModel(runtime, body);
  const built = buildAnthropicPrompt(body, runtime.capabilitiesForModel(model));
  if (!runtime.supportsInput(model, built.blocks)) {
    throw new AnthropicRequestError(
      `No ACP runtime backing model '${model}' advertises the requested input capabilities`,
      400,
    );
  }
  const abort = requestController(req, res, config.requestTimeoutMs);
  let selected: { workerId: string; upstreamModel?: string } | undefined;
  const streamed = body.stream === true;
  const streamText =
    streamed &&
    !built.toolContext.instruction &&
    !Array.isArray(body.stop_sequences);
  const messageId = makeId("msg");
  const inputTokens = estimateTokens(promptTextForUsage(built.blocks));
  let streamStarted = false;
  let textBlockStarted = false;
  const startStream = () => {
    if (streamStarted) return;
    if (selected) setRequestHeaders(res, requestId, model, selected);
    sseHeaders(res);
    streamStarted = true;
    sendSse(
      res,
      {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      },
      "message_start",
    );
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
      streamText
        ? (delta) => {
            startStream();
            if (!textBlockStarted) {
              sendSse(
                res,
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                },
                "content_block_start",
              );
              textBlockStarted = true;
            }
            sendSse(
              res,
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: delta },
              },
              "content_block_delta",
            );
          }
        : undefined,
    );
    selected = {
      workerId: result.workerId,
      upstreamModel: result.upstreamModel,
    };
    const response = anthropicResponse(
      model,
      built.blocks,
      result.text,
      result.stopReason,
      body,
    );
    response.id = messageId;
    if (!res.headersSent) setRequestHeaders(res, requestId, model, selected);
    if (!streamed) {
      json(res, 200, response);
      return;
    }

    startStream();
    if (textBlockStarted) {
      sendSse(
        res,
        { type: "content_block_stop", index: 0 },
        "content_block_stop",
      );
    } else {
      for (const [index, block] of response.content.entries()) {
        const initial =
          block.type === "tool_use"
            ? { ...block, input: {} }
            : { type: "text", text: "" };
        sendSse(
          res,
          {
            type: "content_block_start",
            index,
            content_block: initial,
          },
          "content_block_start",
        );
        if (block.type === "tool_use") {
          sendSse(
            res,
            {
              type: "content_block_delta",
              index,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input),
              },
            },
            "content_block_delta",
          );
        } else {
          sendSse(
            res,
            {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: block.text },
            },
            "content_block_delta",
          );
        }
        sendSse(
          res,
          { type: "content_block_stop", index },
          "content_block_stop",
        );
      }
    }
    sendSse(
      res,
      {
        type: "message_delta",
        delta: {
          stop_reason: response.stop_reason,
          stop_sequence: response.stop_sequence,
        },
        usage: { output_tokens: response.usage.output_tokens },
      },
      "message_delta",
    );
    sendSse(res, { type: "message_stop" }, "message_stop");
    res.end();
  } finally {
    abort.close();
  }
}

function anthropicModelList(runtime: OpenAiRuntime) {
  const data = runtime.listModels().map((model) => ({
    type: "model",
    id: model.id,
    display_name: model.id,
    created_at: new Date(0).toISOString(),
  }));
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  };
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
  const anthropic = isAnthropicRequest(req);
  if (
    req.method === "GET" &&
    (url.pathname === "/health" || url.pathname === "/healthz")
  ) {
    json(res, 200, {
      status: "ok",
      service: "acp-api",
      models: runtime.listModels().length,
    });
    return;
  }
  if (!authorized(req, config.apiKey, anthropic)) {
    if (anthropic) {
      json(
        res,
        401,
        anthropicError("invalid or missing API key", "authentication_error"),
      );
    } else {
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
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    if (anthropic) {
      json(res, 200, anthropicModelList(runtime));
      return;
    }
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
    json(
      res,
      200,
      anthropic
        ? {
            type: "model",
            id: model.id,
            display_name: model.id,
            created_at: new Date(0).toISOString(),
          }
        : model,
    );
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
  if (url.pathname === "/v1/messages/count_tokens") {
    const model = ensureModel(runtime, body);
    const built = buildAnthropicPrompt(
      body,
      runtime.capabilitiesForModel(model),
      { requireMaxTokens: false },
    );
    json(res, 200, {
      input_tokens: estimateTokens(promptTextForUsage(built.blocks)),
    });
  } else if (url.pathname === "/v1/messages") {
    await anthropicMessages(req, res, body, runtime, config, requestId);
  } else if (url.pathname === "/v1/chat/completions") {
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
      const failure = asError(error, isAnthropicRequest(req));
      if (res.headersSent) {
        if (isAnthropicRequest(req)) {
          sendSse(res, failure.body, "error");
        } else {
          sendSse(res, failure.body);
          sendSse(res, "[DONE]");
        }
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
