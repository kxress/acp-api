import type { AcpPromptBlock } from "./acp/protocol.ts";
import {
  buildChatPrompt,
  estimateTokens,
  extractClientToolCalls,
  jsonSchemaInstruction,
  promptTextForUsage,
  type ClientToolContext,
  type ClientTool,
  type OpenAiRequestError,
} from "./openai/compat.ts";

export class AnthropicRequestError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(message: string, status = 400, type = "invalid_request_error") {
    super(message);
    this.name = "AnthropicRequestError";
    this.status = status;
    this.type = type;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function anthropicTools(value: unknown): ClientTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AnthropicRequestError("tools must be an array");
  }
  return value.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name.trim()) {
      throw new AnthropicRequestError(`tools[${index}].name is required`);
    }
    return {
      type: "function",
      function: {
        name: raw.name,
        ...(typeof raw.description === "string"
          ? { description: raw.description }
          : {}),
        ...(raw.input_schema !== undefined
          ? { parameters: raw.input_schema }
          : {}),
      },
    };
  });
}

function anthropicToolChoice(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new AnthropicRequestError("tool_choice must be an object");
  }
  switch (value.type) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: value.name } };
    default:
      throw new AnthropicRequestError("tool_choice.type is unsupported");
  }
}

function imageBlock(block: Record<string, unknown>): Record<string, unknown> {
  const source = block.source;
  if (!isRecord(source)) {
    throw new AnthropicRequestError("image blocks require a source");
  }
  if (
    source.type === "base64" &&
    typeof source.media_type === "string" &&
    typeof source.data === "string"
  ) {
    return {
      type: "image_url",
      image_url: {
        url: `data:${source.media_type};base64,${source.data}`,
      },
    };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  throw new AnthropicRequestError(
    "image source must use base64 or url content",
  );
}

function textFromToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return asText(value);
  return value
    .map((part) =>
      isRecord(part) && part.type === "text" ? asText(part.text) : asText(part),
    )
    .join("\n");
}

function message(raw: unknown, index: number): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new AnthropicRequestError(`messages[${index}] must be an object`);
  }
  if (raw.role !== "user" && raw.role !== "assistant") {
    throw new AnthropicRequestError(
      `messages[${index}].role must be user or assistant`,
    );
  }
  const role = raw.role;
  const content = raw.content;
  if (typeof content === "string") return { role, content };
  if (!Array.isArray(content)) {
    throw new AnthropicRequestError(
      `messages[${index}].content must be a string or array`,
    );
  }

  const textParts: Record<string, unknown>[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const [partIndex, part] of content.entries()) {
    if (!isRecord(part)) {
      throw new AnthropicRequestError(
        `messages[${index}].content[${partIndex}] must be an object`,
      );
    }
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push({ type: "text", text: part.text });
    } else if (part.type === "image" && role === "user") {
      textParts.push(imageBlock(part));
    } else if (part.type === "tool_use" && role === "assistant") {
      if (typeof part.id !== "string" || typeof part.name !== "string") {
        throw new AnthropicRequestError(
          `messages[${index}].content[${partIndex}] tool_use requires id and name`,
        );
      }
      toolCalls.push({
        id: part.id,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        },
      });
    } else if (part.type === "tool_result" && role === "user") {
      const result = textFromToolResult(part.content);
      textParts.push({
        type: "text",
        text: `Tool result (${asText(part.tool_use_id)}): ${result}`,
      });
    } else if (part.type === "text" || part.type === "image") {
      throw new AnthropicRequestError(
        `content block ${part.type} is not valid for role ${role}`,
      );
    } else {
      throw new AnthropicRequestError(
        `messages[${index}].content[${partIndex}].type is unsupported`,
      );
    }
  }
  return {
    role,
    content: textParts,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

export function buildAnthropicPrompt(
  body: Record<string, unknown>,
  capabilities: unknown = {},
  options: { requireMaxTokens?: boolean } = {},
): { blocks: AcpPromptBlock[]; toolContext: ClientToolContext } {
  const hasValidMaxTokens =
    Number.isInteger(body.max_tokens) && Number(body.max_tokens) >= 1;
  if (
    (options.requireMaxTokens !== false && !hasValidMaxTokens) ||
    (body.max_tokens !== undefined && !hasValidMaxTokens)
  ) {
    throw new AnthropicRequestError("max_tokens must be a positive integer");
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new AnthropicRequestError("messages must be a non-empty array");
  }

  const tools = anthropicTools(body.tools);
  const messages = body.messages.map(message);
  const toolChoice = anthropicToolChoice(body.tool_choice);
  let outputInstruction = "";
  const outputConfig = body.output_config;
  if (outputConfig !== undefined && outputConfig !== null) {
    if (!isRecord(outputConfig)) {
      throw new AnthropicRequestError("output_config must be an object");
    }
    const format = outputConfig.format;
    if (format !== undefined && format !== null) {
      if (!isRecord(format) || format.type !== "json_schema") {
        throw new AnthropicRequestError(
          "output_config.format.type must be json_schema",
        );
      }
      try {
        outputInstruction = jsonSchemaInstruction(format.schema);
      } catch (error) {
        if (error instanceof Error && error.name === "OpenAiRequestError") {
          throw new AnthropicRequestError(error.message);
        }
        throw error;
      }
    }
  }
  const systemText =
    typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system
            .filter(
              (part): part is Record<string, unknown> =>
                isRecord(part) && part.type === "text",
            )
            .map((part) => asText(part.text))
            .join("\n")
        : "";
  const openAiBody: Record<string, unknown> = {
    messages: [
      ...(systemText || outputInstruction
        ? [
            {
              role: "system",
              content: [systemText, outputInstruction]
                .filter(Boolean)
                .join("\n\n"),
            },
          ]
        : []),
      ...(hasValidMaxTokens
        ? [
            {
              role: "system",
              content: `Keep the response within ${body.max_tokens} output tokens.`,
            },
          ]
        : []),
      ...messages,
    ],
    ...(tools.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };
  try {
    return buildChatPrompt(openAiBody, capabilities);
  } catch (error) {
    if (error instanceof Error && error.name === "OpenAiRequestError") {
      const compatError = error as OpenAiRequestError;
      throw new AnthropicRequestError(compatError.message, compatError.status);
    }
    throw error;
  }
}

export function anthropicResponse(
  model: string,
  blocks: AcpPromptBlock[],
  text: string,
  stopReason: string | undefined,
  requestBody: Record<string, unknown>,
) {
  const stopSequences = Array.isArray(requestBody.stop_sequences)
    ? requestBody.stop_sequences.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];
  let finalText = text;
  let matchedStopSequence: string | null = null;
  for (const sequence of stopSequences) {
    const index = finalText.indexOf(sequence);
    if (
      index >= 0 &&
      (matchedStopSequence === null ||
        index < finalText.indexOf(matchedStopSequence))
    ) {
      matchedStopSequence = sequence;
    }
  }
  if (matchedStopSequence !== null) {
    finalText = finalText.slice(0, finalText.indexOf(matchedStopSequence));
  }
  let toolCalls = extractClientToolCalls(text, {
    tools: anthropicTools(requestBody.tools),
    tool_choice: anthropicToolChoice(requestBody.tool_choice),
  });
  if (
    isRecord(requestBody.tool_choice) &&
    requestBody.tool_choice.disable_parallel_tool_use === true
  ) {
    toolCalls = toolCalls.slice(0, 1);
  }
  const content: Array<Record<string, unknown>> = [];
  if (!toolCalls.length && finalText)
    content.push({ type: "text", text: finalText });
  for (const call of toolCalls) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
      name: call.function.name,
      input,
    });
  }
  const inputTokens = estimateTokens(promptTextForUsage(blocks));
  const outputTokens = estimateTokens(finalText);
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: toolCalls.length
      ? "tool_use"
      : matchedStopSequence !== null
        ? "stop_sequence"
        : stopReason === "max_tokens" || stopReason === "max_turn_requests"
          ? "max_tokens"
          : "end_turn",
    stop_sequence: matchedStopSequence,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

export function anthropicError(
  message: string,
  type: string,
): Record<string, unknown> {
  return { type: "error", error: { type, message } };
}
