import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiHttpServer } from "../src/openai/server.ts";
import { buildAnthropicPrompt } from "../src/anthropic.ts";
import { clientToolContext } from "../src/openai/compat.ts";

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
      const text =
        typeof responseText === "function"
          ? responseText(runtime.generated, blocks)
          : responseText;
      if (onText) await onText(text);
      return {
        text,
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

function openAiHeaders() {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  };
}

test("contract: OpenAI Chat Completions text request and response", async (t) => {
  const { baseUrl } = await startServer(t, "A mocked answer.");
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: openAiHeaders(),
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "Say hello." }],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.id, /^chatcmpl_/);
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "test-model");
  assert.deepEqual(body.choices[0].message, {
    role: "assistant",
    content: "A mocked answer.",
  });
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.ok(body.usage.prompt_tokens > 0);
  assert.ok(body.usage.completion_tokens > 0);
  assert.equal(response.headers.get("x-acp-agent"), "fake-acp");
});

test("contract: Anthropic Messages text request and response", async (t) => {
  const { baseUrl } = await startServer(t, "A mocked answer.");
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: "test-model",
      max_tokens: 100,
      messages: [{ role: "user", content: "Say hello." }],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.id, /^msg_/);
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  assert.equal(body.model, "test-model");
  assert.deepEqual(body.content, [{ type: "text", text: "A mocked answer." }]);
  assert.equal(body.stop_reason, "end_turn");
  assert.equal(body.stop_sequence, null);
  assert.ok(body.usage.input_tokens > 0);
  assert.ok(body.usage.output_tokens > 0);
});

test("contract: OpenAI Chat Completions streams deltas and a terminal marker", async (t) => {
  const { baseUrl } = await startServer(t, "A streamed answer.");
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: openAiHeaders(),
    body: JSON.stringify({
      model: "test-model",
      stream: true,
      messages: [{ role: "user", content: "Say hello." }],
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /"object":"chat\.completion\.chunk"/);
  assert.match(body, /"content":"A streamed answer\."/);
  assert.match(body, /"finish_reason":"stop"/);
  assert.match(body, /data: \[DONE\]/);
});

test("contract: model listing uses each API's response shape", async (t) => {
  const { baseUrl } = await startServer(t);
  const openAiResponse = await fetch(`${baseUrl}/v1/models`, {
    headers: openAiHeaders(),
  });
  const openAiBody = await openAiResponse.json();
  assert.deepEqual(openAiBody, {
    object: "list",
    data: [{ id: "test-model", object: "model" }],
  });

  const anthropicResponse = await fetch(`${baseUrl}/v1/models`, {
    headers: anthropicHeaders(),
  });
  const anthropicBody = await anthropicResponse.json();
  assert.equal(anthropicBody.data[0].type, "model");
  assert.equal(anthropicBody.data[0].id, "test-model");
  assert.equal(anthropicBody.has_more, false);
});

test("contract: authentication errors follow the requested API shape", async (t) => {
  const { baseUrl } = await startServer(t);
  const openAiResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const openAiBody = await openAiResponse.json();
  assert.equal(openAiResponse.status, 401);
  assert.equal(openAiBody.error.type, "authentication_error");

  const anthropicResponse = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const anthropicBody = await anthropicResponse.json();
  assert.equal(anthropicResponse.status, 401);
  assert.equal(anthropicBody.type, "error");
  assert.equal(anthropicBody.error.type, "authentication_error");
});

test("contract: OpenAI required and named tool choices reach the ACP prompt", () => {
  const tools = [
    {
      type: "function",
      function: { name: "remember", parameters: { type: "object" } },
    },
    {
      type: "function",
      function: { name: "search", parameters: { type: "object" } },
    },
  ];
  const required = clientToolContext({ tools, tool_choice: "required" });
  assert.equal(required.choice.mode, "required");
  assert.match(required.instruction, /must call at least one/);
  const any = clientToolContext({ tools, tool_choice: "any" });
  assert.equal(any.choice.mode, "required");

  const named = clientToolContext({
    tools,
    tool_choice: {
      type: "function",
      function: { name: "remember" },
    },
  });
  assert.equal(named.choice.mode, "function");
  assert.equal(named.choice.name, "remember");
  assert.match(named.instruction, /must call remember/);
  assert.doesNotMatch(named.instruction, /"name":"search"/);
});

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
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: "Weather in Oslo?" }],
  });
  const prompt = built.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.match(prompt, /lookup_weather/);
  assert.match(prompt, /Do not execute these tools/);
  assert.match(prompt, /must call at least one/);
  assert.match(prompt, /user: Weather in Oslo\?/);
});

test("contract: Anthropic can force a named tool", () => {
  const built = buildAnthropicPrompt({
    max_tokens: 128,
    tools: [
      { name: "remember", input_schema: { type: "object" } },
      { name: "search", input_schema: { type: "object" } },
    ],
    tool_choice: { type: "tool", name: "remember" },
    messages: [{ role: "user", content: "Save this preference." }],
  });
  const prompt = built.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.match(prompt, /must call remember/);
  assert.match(prompt, /"name":"remember"/);
  assert.doesNotMatch(prompt, /"name":"search"/);
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

test("contract: Anthropic tool_use and tool_result complete a client tool loop", async (t) => {
  const toolJson = JSON.stringify({
    tool_calls: [{ name: "search_memory", arguments: { query: "dark mode" } }],
  });
  const { baseUrl, runtime } = await startServer(t, (turn) =>
    turn === 1 ? toolJson : "You prefer dark mode.",
  );
  const tools = [
    {
      name: "search_memory",
      description: "Search saved memories",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  ];
  const firstResponse = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: "test-model",
      max_tokens: 100,
      tools,
      messages: [{ role: "user", content: "What lighting do I prefer?" }],
    }),
  });
  const firstBody = await firstResponse.json();
  const toolUse = firstBody.content[0];
  assert.equal(firstBody.stop_reason, "tool_use");

  const secondResponse = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: "test-model",
      max_tokens: 100,
      tools,
      messages: [
        { role: "user", content: "What lighting do I prefer?" },
        { role: "assistant", content: firstBody.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: "Saved memory: prefers dark mode.",
            },
          ],
        },
      ],
    }),
  });
  const secondBody = await secondResponse.json();
  assert.equal(secondResponse.status, 200);
  assert.equal(secondBody.content[0].text, "You prefer dark mode.");
  assert.equal(runtime.generated, 2);
  assert.ok(
    runtime.lastBlocks.some((block) =>
      block.text?.includes("Saved memory: prefers dark mode."),
    ),
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

test("contract: Anthropic streaming encodes tool_use input", async (t) => {
  const toolJson = JSON.stringify({
    tool_calls: [{ name: "search_memory", arguments: { query: "dark mode" } }],
  });
  const { baseUrl } = await startServer(t, toolJson);
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: "test-model",
      max_tokens: 100,
      stream: true,
      tools: [
        {
          name: "search_memory",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
      messages: [{ role: "user", content: "Search my memory." }],
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /event: content_block_start/);
  assert.match(body, /"type":"tool_use"/);
  assert.match(body, /event: content_block_delta/);
  assert.match(body, /"type":"input_json_delta"/);
  assert.match(body, /"stop_reason":"tool_use"/);
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

test("contract: OpenAI Chat Completions streams function tool calls", async (t) => {
  const toolJson = JSON.stringify({
    tool_calls: [{ name: "search_memory", arguments: { query: "dark mode" } }],
  });
  const { baseUrl } = await startServer(t, toolJson);
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: openAiHeaders(),
    body: JSON.stringify({
      model: "test-model",
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "search_memory",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
        },
      ],
      messages: [{ role: "user", content: "Search my memory." }],
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /"tool_calls":\[/);
  assert.match(body, /"name":"search_memory"/);
  assert.match(body, /"finish_reason":"tool_calls"/);
  assert.match(body, /data: \[DONE\]/);
});

test("contract: OpenAI tool_calls and tool results complete a client tool loop", async (t) => {
  const toolJson = JSON.stringify({
    tool_calls: [{ name: "search_memory", arguments: { query: "dark mode" } }],
  });
  const { baseUrl, runtime } = await startServer(t, (turn) =>
    turn === 1 ? toolJson : "You prefer dark mode.",
  );
  const tools = [
    {
      type: "function",
      function: {
        name: "search_memory",
        description: "Search saved memories",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    },
  ];
  const firstResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: openAiHeaders(),
    body: JSON.stringify({
      model: "test-model",
      tools,
      messages: [{ role: "user", content: "What lighting do I prefer?" }],
    }),
  });
  const firstBody = await firstResponse.json();
  const toolCall = firstBody.choices[0].message.tool_calls[0];
  assert.equal(firstBody.choices[0].finish_reason, "tool_calls");

  const secondResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: openAiHeaders(),
    body: JSON.stringify({
      model: "test-model",
      tools,
      messages: [
        { role: "user", content: "What lighting do I prefer?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
        },
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: "Saved memory: prefers dark mode.",
        },
      ],
    }),
  });
  const secondBody = await secondResponse.json();
  assert.equal(secondResponse.status, 200);
  assert.equal(secondBody.choices[0].message.content, "You prefer dark mode.");
  assert.equal(runtime.generated, 2);
  assert.ok(
    runtime.lastBlocks.some((block) =>
      block.text?.includes("Saved memory: prefers dark mode."),
    ),
  );
  assert.ok(
    runtime.lastBlocks.some((block) =>
      block.text?.includes(`tool_call_id=${toolCall.id}`),
    ),
  );
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
