import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiHttpServer } from "../src/openai/server.ts";
import { buildAnthropicPrompt } from "../src/anthropic.ts";

const config = {
  apiKey: "local-test-key",
  maxBodyBytes: 1024 * 1024,
  requestTimeoutMs: 5000,
};

async function startServer(t, responseText = "Hello from the fake ACP agent.") {
  const runtime = {
    generated: 0,
    lastBlocks: [],
    hasModel: (model) => model === "test-model",
    model: (model) => ({ id: model, object: "model" }),
    listModels: () => [{ id: "test-model", object: "model" }],
    capabilitiesForModel: () => ({}),
    supportsInput: () => true,
    generate: async (_model, blocks, _key, _signal, onSelected, onText) => {
      runtime.generated++;
      runtime.lastBlocks = blocks;
      onSelected?.({ workerId: "fake-acp" });
      if (onText) await onText(responseText);
      return {
        text: responseText,
        stopReason: "end_turn",
        workerId: "fake-acp",
      };
    },
  };
  const server = createOpenAiHttpServer(config, runtime);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { baseUrl, runtime };
}

function anthropicHeaders() {
  return {
    "content-type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01",
  };
}

test("Anthropic tool definitions become ACP prompt instructions", () => {
  const built = buildAnthropicPrompt({
    max_tokens: 128,
    tools: [
      {
        name: "lookup_weather",
        description: "Look up current weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ],
    messages: [{ role: "user", content: "Weather in Oslo?" }],
  });
  const prompt = built.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.match(prompt, /lookup_weather/);
  assert.match(prompt, /Do not execute these tools/);
  assert.match(prompt, /user: Weather in Oslo\?/);
});

test("Anthropic tool results are carried into the next ACP prompt", () => {
  const built = buildAnthropicPrompt({
    max_tokens: 128,
    tools: [{ name: "lookup_weather", input_schema: { type: "object" } }],
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_previous",
            name: "lookup_weather",
            input: { city: "Oslo" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_previous",
            content: "Cloudy, 8 C",
          },
        ],
      },
    ],
  });
  const prompt = built.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.match(prompt, /toolu_previous/);
  assert.match(prompt, /Cloudy, 8 C/);
});

test("Anthropic Messages returns client tool_use blocks using a fake ACP result", async (t) => {
  const toolJson = JSON.stringify({
    tool_calls: [{ name: "lookup_weather", arguments: { city: "Oslo" } }],
  });
  const { baseUrl, runtime } = await startServer(t, toolJson);
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: "test-model",
      max_tokens: 128,
      tools: [
        {
          name: "lookup_weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
      messages: [{ role: "user", content: "Weather in Oslo?" }],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.type, "message");
  assert.equal(body.stop_reason, "tool_use");
  assert.deepEqual(body.content[0], {
    type: "tool_use",
    id: body.content[0].id,
    name: "lookup_weather",
    input: { city: "Oslo" },
  });
  assert.equal(runtime.generated, 1);
  assert.ok(
    runtime.lastBlocks.some((block) => block.text?.includes("lookup_weather")),
  );
});

test("Anthropic streaming emits the Messages event sequence", async (t) => {
  const { baseUrl } = await startServer(t);
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: "test-model",
      max_tokens: 128,
      stream: true,
      messages: [{ role: "user", content: "Say hello." }],
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /event: message_start/);
  assert.match(body, /event: content_block_delta/);
  assert.match(body, /event: message_stop/);
  assert.match(body, /Hello from the fake ACP agent\./);
});

test("Anthropic count_tokens is local and does not call the ACP runtime", async (t) => {
  const { baseUrl, runtime } = await startServer(t);
  const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "Count this locally." }],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(body.input_tokens > 0);
  assert.equal(runtime.generated, 0);
});

test("OpenAI chat tool calls work with a mocked ACP return", async (t) => {
  const toolJson = JSON.stringify({
    tool_calls: [{ name: "lookup_weather", arguments: { city: "Oslo" } }],
  });
  const { baseUrl, runtime } = await startServer(t, toolJson);
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "Weather in Oslo?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        },
      ],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(
    body.choices[0].message.tool_calls[0].function.name,
    "lookup_weather",
  );
  assert.equal(runtime.generated, 1);
});

test("OpenAI Responses returns function_call items with a mocked ACP result", async (t) => {
  const toolJson = JSON.stringify({
    tool_calls: [{ name: "lookup_weather", arguments: { city: "Oslo" } }],
  });
  const { baseUrl, runtime } = await startServer(t, toolJson);
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: "test-model",
      input: "Weather in Oslo?",
      tools: [
        {
          type: "function",
          name: "lookup_weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.output[0].type, "function_call");
  assert.equal(body.output[0].name, "lookup_weather");
  assert.deepEqual(JSON.parse(body.output[0].arguments), { city: "Oslo" });
  assert.equal(runtime.generated, 1);
});

test("OpenAI Responses streams function-call events for tools", async (t) => {
  const toolJson = JSON.stringify({
    tool_calls: [{ name: "lookup_weather", arguments: { city: "Oslo" } }],
  });
  const { baseUrl } = await startServer(t, toolJson);
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: "test-model",
      input: "Weather in Oslo?",
      stream: true,
      tools: [
        {
          type: "function",
          name: "lookup_weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /event: response\.function_call_arguments\.delta/);
  assert.match(body, /event: response\.completed/);
  assert.match(body, /lookup_weather/);
});
