import type { AcpPromptBlock } from "../acp/protocol.ts";
import { isIP } from "node:net";

export class OpenAiRequestError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;

  constructor(
    message: string,
    status = 400,
    type = "invalid_request_error",
    code: string | null = null,
  ) {
    super(message);
    this.name = "OpenAiRequestError";
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function requireSingleChoice(body: Record<string, unknown>): void {
  const n = body.n;
  if (n !== undefined && n !== 1) {
    throw new OpenAiRequestError("only n=1 is supported");
  }
}

export function jsonSchemaInstruction(
  schema: unknown,
  name?: unknown,
  description?: unknown,
): string {
  if (!isRecord(schema)) {
    throw new OpenAiRequestError(
      "JSON schema format requires an object schema",
    );
  }
  const details = [
    "The client requested structured JSON output.",
    "Return only a JSON value that matches the supplied JSON Schema.",
  ];
  if (typeof name === "string" && name) details.push(`Schema name: ${name}`);
  if (typeof description === "string" && description)
    details.push(`Schema description: ${description}`);
  details.push(`JSON Schema: ${JSON.stringify(schema)}`);
  return details.join("\n");
}

function responseFormatInstruction(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new OpenAiRequestError("response_format must include a type");
  }
  if (value.type === "text") return "";
  if (value.type === "json_object") {
    return [
      "The client requested JSON object output.",
      "Return only a valid JSON object without markdown fences or surrounding text.",
    ].join("\n");
  }
  if (value.type === "json_schema") {
    const format = value.json_schema;
    if (!isRecord(format)) {
      throw new OpenAiRequestError(
        "response_format.json_schema must be an object",
      );
    }
    return jsonSchemaInstruction(
      format.schema,
      format.name,
      format.description,
    );
  }
  throw new OpenAiRequestError(
    "response_format.type must be text, json_object, or json_schema",
  );
}

function promptCapabilities(capabilities: unknown): Record<string, unknown> {
  if (!isRecord(capabilities)) return {};
  const prompt =
    capabilities.promptCapabilities ?? capabilities.prompt_capabilities;
  return isRecord(prompt) ? prompt : {};
}

function requireCapability(
  capabilities: unknown,
  name: string,
  message: string,
): void {
  if (!promptCapabilities(capabilities)[name]) {
    throw new OpenAiRequestError(
      message,
      400,
      "invalid_request_error",
      "unsupported_capability",
    );
  }
}

const DATA_URI = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/i;
const AUDIO_MIME_BY_FORMAT: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mp4: "audio/mp4",
  m4a: "audio/mp4",
  webm: "audio/webm",
  flac: "audio/flac",
  ogg: "audio/ogg",
};

function dataUri(value: string): { mime: string; data: string } | undefined {
  const match = DATA_URI.exec(value);
  return match
    ? { mime: match[1], data: match[2].replace(/\s/g, "") }
    : undefined;
}

function remoteResource(
  value: unknown,
  name: unknown,
  mimeType: unknown,
): AcpPromptBlock {
  if (typeof value !== "string" || !value.trim()) {
    throw new OpenAiRequestError("resource content requires a URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenAiRequestError("resource URL must be absolute");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpenAiRequestError(
      "only HTTP and HTTPS resource URLs are supported",
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLocalResourceHost(hostname)) {
    throw new OpenAiRequestError(
      "local and private resource URLs are not supported",
    );
  }
  return {
    type: "resource_link",
    uri: url.toString(),
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof mimeType === "string" ? { mimeType } : {}),
  };
}

function isLocalResourceHost(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return true;
  }
  if (isIP(hostname) === 4) {
    const [a, b] = hostname.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b !== undefined && b >= 64 && b <= 127)
    );
  }
  if (isIP(hostname) === 6) {
    const normalized = hostname.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

function contentPartToBlock(
  part: unknown,
  capabilities: unknown,
): AcpPromptBlock[] {
  if (typeof part === "string") return [{ type: "text", text: part }];
  if (!isRecord(part))
    throw new OpenAiRequestError("message content parts must be objects");
  const type = part.type;
  if (type === "text" || type === "input_text" || type === "output_text") {
    return typeof part.text === "string"
      ? [{ type: "text", text: part.text }]
      : [];
  }
  if (type === "image_url" || type === "input_image") {
    const image = part.image_url ?? part.imageUrl ?? part;
    const url =
      typeof image === "string"
        ? image
        : isRecord(image)
          ? image.url
          : undefined;
    if (typeof url !== "string")
      throw new OpenAiRequestError("image content requires image_url.url");
    const inline = dataUri(url);
    if (inline) {
      if (!inline.mime.toLowerCase().startsWith("image/"))
        throw new OpenAiRequestError(
          "image data URI must use an image/* MIME type",
        );
      requireCapability(
        capabilities,
        "image",
        "ACP agent does not advertise image prompt support",
      );
      return [{ type: "image", mimeType: inline.mime, data: inline.data }];
    }
    return [remoteResource(url, part.name, part.mime_type ?? part.mimeType)];
  }
  if (type === "input_audio" || type === "audio") {
    const audio = isRecord(part.input_audio) ? part.input_audio : part;
    const raw = audio.data ?? part.data;
    if (typeof raw === "string" && raw) {
      const inline = dataUri(raw);
      const format = String(audio.format ?? part.format ?? "").toLowerCase();
      const mime =
        inline?.mime ??
        AUDIO_MIME_BY_FORMAT[format] ??
        String(part.mime_type ?? part.mimeType ?? "audio/wav");
      if (!mime.toLowerCase().startsWith("audio/"))
        throw new OpenAiRequestError(
          "audio content must use an audio/* MIME type",
        );
      requireCapability(
        capabilities,
        "audio",
        "ACP agent does not advertise audio prompt support",
      );
      return [
        {
          type: "audio",
          mimeType: mime,
          data: inline?.data ?? raw.replace(/\s/g, ""),
        },
      ];
    }
    const url = audio.audio_url ?? part.audio_url ?? audio.url ?? part.url;
    return [
      remoteResource(
        isRecord(url) ? url.url : url,
        part.name,
        part.mime_type ?? part.mimeType,
      ),
    ];
  }
  if (type === "file" || type === "input_file") {
    const fileId = part.file_id ?? part.fileId;
    if (fileId)
      throw new OpenAiRequestError(
        "file_id is not supported because a local ACP agent cannot access OpenAI-hosted files",
      );
    const url = part.file_url ?? part.fileUrl ?? part.url ?? part.uri;
    if (typeof url === "string")
      return [
        remoteResource(
          url,
          part.filename ?? part.name,
          part.mime_type ?? part.mimeType,
        ),
      ];
    const data = part.file_data ?? part.fileData ?? part.data;
    const text = part.text ?? part.content;
    requireCapability(
      capabilities,
      "embeddedContext",
      "ACP agent does not advertise embedded-context prompt support",
    );
    if (typeof text === "string") {
      return [
        {
          type: "resource",
          resource: {
            uri: String(part.filename ?? part.name ?? "attachment.txt"),
            mimeType: String(part.mime_type ?? part.mimeType ?? "text/plain"),
            text,
          },
        },
      ];
    }
    if (typeof data === "string") {
      const inline = dataUri(data);
      return [
        {
          type: "resource",
          resource: {
            uri: String(part.filename ?? part.name ?? "attachment"),
            mimeType:
              inline?.mime ??
              String(
                part.mime_type ?? part.mimeType ?? "application/octet-stream",
              ),
            blob: inline?.data ?? data.replace(/\s/g, ""),
          },
        },
      ];
    }
    throw new OpenAiRequestError(
      "file content requires a URL, text, or base64 data",
    );
  }
  throw new OpenAiRequestError(
    `unsupported content part type: ${String(type)}`,
  );
}

function messageContent(
  content: unknown,
  capabilities: unknown,
): AcpPromptBlock[] {
  if (typeof content === "string")
    return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return [];
    throw new OpenAiRequestError(
      "message content must be a string or an array of content parts",
    );
  }
  return content.flatMap((part) => contentPartToBlock(part, capabilities));
}

export interface ClientTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface ClientToolContext {
  tools: ClientTool[];
  choice: { mode: "auto" | "none" | "required" | "function"; name?: string };
  instruction: string;
}

function normalizeTools(body: Record<string, unknown>): ClientTool[] {
  const source = body.tools ?? body.functions;
  if (source === undefined) return [];
  if (!Array.isArray(source))
    throw new OpenAiRequestError("tools must be an array");
  const result: ClientTool[] = [];
  for (const [index, item] of source.entries()) {
    const fn =
      isRecord(item) && item.type === undefined && isRecord(item.function)
        ? item.function
        : isRecord(item) && item.type === undefined
          ? item
          : isRecord(item) && item.type === "function"
            ? isRecord(item.function)
              ? item.function
              : item
            : undefined;
    if (!fn) {
      throw new OpenAiRequestError(`tools[${index}] must be a function tool`);
    }
    const name = stringify(fn.name);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
      throw new OpenAiRequestError(`tools[${index}].function.name is invalid`);
    result.push({
      type: "function",
      function: {
        name,
        ...(typeof fn.description === "string"
          ? { description: fn.description }
          : {}),
        ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
      },
    });
  }
  return result;
}

function normalizeToolChoice(
  body: Record<string, unknown>,
  tools: ClientTool[],
): ClientToolContext["choice"] {
  const value =
    body.tool_choice ??
    body.toolChoice ??
    body.function_call ??
    body.functionCall;
  if (value === undefined || value === "auto") return { mode: "auto" };
  if (value === "none") return { mode: "none" };
  if (value === "required" || value === "any") return { mode: "required" };
  if (isRecord(value)) {
    const fn = isRecord(value.function) ? value.function : value;
    const name = stringify(fn.name);
    if (!tools.some((tool) => tool.function.name === name))
      throw new OpenAiRequestError(
        `tool_choice references unknown function ${JSON.stringify(name)}`,
      );
    return { mode: "function", name };
  }
  throw new OpenAiRequestError(
    "tool_choice must be auto, none, required, or a function tool choice",
  );
}

export function clientToolContext(
  body: Record<string, unknown>,
): ClientToolContext {
  const tools = normalizeTools(body);
  const choice = normalizeToolChoice(body, tools);
  if (
    !tools.length &&
    (choice.mode === "required" || choice.mode === "function")
  ) {
    throw new OpenAiRequestError(
      "tool_choice requires at least one function tool",
    );
  }
  if (!tools.length || choice.mode === "none")
    return { tools, choice, instruction: "" };
  const allowed =
    choice.mode === "function"
      ? tools.filter((item) => item.function.name === choice.name)
      : tools;
  const lines = [
    "The HTTP client supplied function tools. Do not execute these tools; the client will execute them after you request them.",
    'When a tool is needed, respond with only a JSON object in this shape: {"tool_calls":[{"name":"function_name","arguments":{}}]}.',
    "Do not use markdown around the JSON. After a tool result is provided in the conversation, use it to answer the user.",
    `Available tools: ${JSON.stringify(allowed.map((item) => item.function))}`,
  ];
  if (choice.mode === "required")
    lines.push("You must call at least one supplied tool.");
  if (choice.mode === "function") lines.push(`You must call ${choice.name}.`);
  return { tools, choice, instruction: lines.join("\n") };
}

export function extractClientToolCalls(
  text: string,
  body: Record<string, unknown>,
): Array<{
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}> {
  const context = clientToolContext(body);
  if (!context.tools.length || context.choice.mode === "none") return [];
  const match = text.trim().match(/^(?:tool_calls:\s*)?(\{[\s\S]*\})$/);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[1]);
    const calls =
      isRecord(parsed) && Array.isArray(parsed.tool_calls)
        ? parsed.tool_calls
        : [];
    const allowed = new Set(context.tools.map((item) => item.function.name));
    return calls.flatMap((raw) => {
      if (
        !isRecord(raw) ||
        typeof raw.name !== "string" ||
        !allowed.has(raw.name)
      )
        return [];
      const args =
        isRecord(raw.arguments) || Array.isArray(raw.arguments)
          ? JSON.stringify(raw.arguments)
          : typeof raw.arguments === "string"
            ? raw.arguments
            : "{}";
      return [
        {
          id: `call_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "function" as const,
          function: { name: raw.name, arguments: args },
        },
      ];
    });
  } catch {
    return [];
  }
}

export function buildChatPrompt(
  body: Record<string, unknown>,
  capabilities: unknown = {},
): { blocks: AcpPromptBlock[]; toolContext: ClientToolContext } {
  requireSingleChoice(body);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new OpenAiRequestError("messages must be a non-empty array");
  }
  const toolContext = clientToolContext(body);
  const blocks: AcpPromptBlock[] = [];
  const formatInstruction = responseFormatInstruction(body.response_format);
  if (formatInstruction) blocks.push({ type: "text", text: formatInstruction });
  if (toolContext.instruction)
    blocks.push({ type: "text", text: toolContext.instruction });
  for (const [index, raw] of body.messages.entries()) {
    if (!isRecord(raw))
      throw new OpenAiRequestError(`messages[${index}] must be an object`);
    const role = nonEmptyRole(raw.role, index);
    const content = messageContent(raw.content, capabilities);
    const toolCalls = raw.tool_calls ?? raw.toolCalls;
    const legacyFunctionCall = raw.function_call ?? raw.functionCall;
    if ((role === "assistant" || role === "tool") && toolCalls !== undefined) {
      content.push({
        type: "text",
        text: `tool_calls: ${JSON.stringify(toolCalls)}`,
      });
    }
    if (legacyFunctionCall !== undefined)
      content.push({
        type: "text",
        text: `function_call: ${JSON.stringify(legacyFunctionCall)}`,
      });
    const name = typeof raw.name === "string" ? ` (${raw.name})` : "";
    const toolCallId =
      role === "tool" && typeof raw.tool_call_id === "string"
        ? ` [tool_call_id=${raw.tool_call_id}]`
        : "";
    const prefix =
      role === "system" || role === "developer"
        ? `System${name}: `
        : `${role}${name}${toolCallId}: `;
    if (!content.length) {
      blocks.push({ type: "text", text: prefix.trimEnd() });
    } else {
      const first = content[0];
      if (first.type === "text") {
        first.text = `${prefix}${String(first.text ?? "")}`;
      } else {
        blocks.push({ type: "text", text: prefix.trimEnd() });
      }
      blocks.push(...content);
    }
  }
  if (blocks.length === 0)
    throw new OpenAiRequestError("request did not contain prompt content");
  return { blocks, toolContext };
}

function nonEmptyRole(value: unknown, index: number): string {
  const role = typeof value === "string" ? value : "";
  if (
    !["system", "developer", "user", "assistant", "tool", "function"].includes(
      role,
    )
  ) {
    throw new OpenAiRequestError(`messages[${index}].role is unsupported`);
  }
  return role;
}

export function buildCompletionPrompt(
  body: Record<string, unknown>,
): AcpPromptBlock[] {
  requireSingleChoice(body);
  const prompt = Array.isArray(body.prompt)
    ? body.prompt.map(stringify).join("\n")
    : stringify(body.prompt);
  if (!prompt) throw new OpenAiRequestError("prompt must not be empty");
  return [{ type: "text", text: prompt }];
}

export function buildResponsesPrompt(
  body: Record<string, unknown>,
  capabilities: unknown = {},
): { blocks: AcpPromptBlock[]; toolContext: ClientToolContext } {
  const blocks: AcpPromptBlock[] = [];
  const toolContext = clientToolContext(body);
  if (toolContext.instruction) {
    blocks.push({ type: "text", text: toolContext.instruction });
  }
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    blocks.push({
      type: "text",
      text: `System instructions: ${body.instructions}`,
    });
  }
  const input = body.input;
  if (typeof input === "string") {
    if (input) blocks.push({ type: "text", text: input });
  } else if (Array.isArray(input)) {
    for (const [index, item] of input.entries()) {
      if (!isRecord(item))
        throw new OpenAiRequestError(`input[${index}] must be an object`);
      if (item.type === "input_text") {
        if (typeof item.text !== "string")
          throw new OpenAiRequestError(`input[${index}].text must be a string`);
        blocks.push({ type: "text", text: item.text });
        continue;
      }
      if (
        item.type === "input_image" ||
        item.type === "input_audio" ||
        item.type === "input_file"
      ) {
        blocks.push(...contentPartToBlock(item, capabilities));
        continue;
      }
      if (item.type === "function_call_output") {
        blocks.push({
          type: "text",
          text: `tool result (${String(item.call_id ?? item.name ?? "function")}): ${stringify(item.output)}`,
        });
        continue;
      }
      if (item.type === "function_call") {
        blocks.push({
          type: "text",
          text: `tool call: ${JSON.stringify({ name: item.name, arguments: item.arguments })}`,
        });
        continue;
      }
      const role = typeof item.role === "string" ? item.role : "user";
      const prefix =
        role === "system" || role === "developer" ? "System: " : `${role}: `;
      if (typeof item.content === "string") {
        blocks.push({ type: "text", text: `${prefix}${item.content}` });
      } else {
        const parts = messageContent(item.content, capabilities);
        if (parts.length && parts[0].type === "text") {
          parts[0].text = `${prefix}${String(parts[0].text ?? "")}`;
        } else if (parts.length) {
          blocks.push({ type: "text", text: prefix.trimEnd() });
        }
        blocks.push(...parts);
      }
    }
  } else if (input !== undefined && input !== null) {
    throw new OpenAiRequestError("input must be a string or an array");
  }
  if (!blocks.length) throw new OpenAiRequestError("input must not be empty");
  return { blocks, toolContext };
}

export function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

export function promptTextForUsage(blocks: AcpPromptBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") return String(block.text ?? "");
      if (block.type === "resource_link")
        return String(block.uri ?? block.name ?? "");
      if (block.type === "resource")
        return String(
          (block.resource as Record<string, unknown> | undefined)?.uri ??
            "[resource]",
        );
      if (block.type === "image" || block.type === "audio")
        return `[${block.type}:${String(block.mimeType ?? "unknown")}]`;
      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join("\n");
}

export function usage(blocks: AcpPromptBlock[], completionText: string) {
  const prompt_tokens = estimateTokens(promptTextForUsage(blocks));
  const completion_tokens = estimateTokens(completionText);
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

export function finishReason(stopReason?: string): string {
  return (
    (
      {
        end_turn: "stop",
        max_tokens: "length",
        max_turn_requests: "length",
        refusal: "content_filter",
        cancelled: "stop",
      } as Record<string, string>
    )[stopReason ?? ""] ?? "stop"
  );
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function chatResponse(
  model: string,
  blocks: AcpPromptBlock[],
  text: string,
  stopReason: string | undefined,
  toolCalls: ReturnType<typeof extractClientToolCalls>,
) {
  return {
    id: makeId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: toolCalls.length
          ? { role: "assistant", content: null, tool_calls: toolCalls }
          : { role: "assistant", content: text },
        finish_reason: toolCalls.length
          ? "tool_calls"
          : finishReason(stopReason),
      },
    ],
    usage: usage(blocks, text),
  };
}

export function completionResponse(
  model: string,
  blocks: AcpPromptBlock[],
  text: string,
  stopReason?: string,
) {
  return {
    id: makeId("cmpl"),
    object: "text_completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        text,
        finish_reason: finishReason(stopReason),
        logprobs: null,
      },
    ],
    usage: usage(blocks, text),
  };
}

export function responsesResponse(
  model: string,
  blocks: AcpPromptBlock[],
  text: string,
  stopReason?: string,
  toolCalls: ReturnType<typeof extractClientToolCalls> = [],
) {
  const incomplete = [
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
  ].includes(stopReason ?? "");
  const id = makeId("resp");
  const outputId = makeId("msg");
  const output = toolCalls.length
    ? toolCalls.map((call) => ({
        id: makeId("fc"),
        type: "function_call",
        status: "completed",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }))
    : [
        {
          id: outputId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ];
  const resultText = toolCalls.length ? JSON.stringify(toolCalls) : text;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: incomplete ? "incomplete" : "completed",
    model,
    output,
    output_text: toolCalls.length ? "" : text,
    error: null,
    incomplete_details: incomplete
      ? {
          reason:
            stopReason === "cancelled"
              ? "cancelled"
              : stopReason === "refusal"
                ? "content_filter"
                : "max_output_tokens",
        }
      : null,
    usage: {
      input_tokens: estimateTokens(promptTextForUsage(blocks)),
      output_tokens: estimateTokens(resultText),
      total_tokens:
        estimateTokens(promptTextForUsage(blocks)) + estimateTokens(resultText),
    },
    metadata: {},
  };
}
