import { createOpenAiHttpServer } from "../src/openai/server.ts";

const config = {
  apiKey: "local-test-key",
  maxBodyBytes: 2 * 1024 * 1024,
  requestTimeoutMs: 10_000,
};

function schemaSample(schema) {
  if (!schema || typeof schema !== "object") return {};
  if (Array.isArray(schema.anyOf)) {
    const option = schema.anyOf.find((item) => item?.type !== "null");
    return schemaSample(option ?? schema.anyOf[0]);
  }
  if (Array.isArray(schema.oneOf)) return schemaSample(schema.oneOf[0]);
  const type = Array.isArray(schema.type)
    ? schema.type.find((item) => item !== "null")
    : schema.type;
  if (type === "object" || schema.properties) {
    const properties = schema.properties ?? {};
    const required = Array.isArray(schema.required)
      ? schema.required
      : Object.keys(properties);
    return Object.fromEntries(
      required
        .filter((key) => Object.hasOwn(properties, key))
        .map((key) => [key, schemaSample(properties[key])]),
    );
  }
  if (type === "array") return [];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (type === "string") return "mock memory value";
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return false;
  return null;
}

function fakeResponse(model, blocks) {
  const prompt = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (/tool_call_id=|Tool result \(/.test(prompt)) return "mock answer";
  if (model === "mock-structured") {
    return prompt.includes("JSON Schema:")
      ? JSON.stringify({
          category: "mock category",
          preference: "mock preference",
        })
      : "structured output schema was not forwarded";
  }
  const match = prompt.match(/Available tools: (\[[^\n]*\])/);
  if (!match) return "mock answer";
  const tools = JSON.parse(match[1]);
  const tool = tools[0];
  if (!tool) return "mock answer";
  return JSON.stringify({
    tool_calls: [
      {
        name: tool.name,
        arguments: schemaSample(tool.parameters),
      },
    ],
  });
}

const runtime = {
  hasModel: () => true,
  model: (id) => ({ id, object: "model" }),
  listModels: () => [{ id: "mock-model", object: "model" }],
  capabilitiesForModel: () => ({}),
  supportsInput: () => true,
  generate: async (model, blocks, _key, _signal, onSelected, onText) => {
    onSelected?.({ workerId: "langchain-fake-acp" });
    const text = fakeResponse(model, blocks);
    if (onText) await onText(text);
    return {
      text,
      stopReason: "end_turn",
      workerId: "langchain-fake-acp",
    };
  },
};

const server = createOpenAiHttpServer(config, runtime);
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to get local test server address");
  }
  console.log(`READY http://127.0.0.1:${address.port}`);
});

function close() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
