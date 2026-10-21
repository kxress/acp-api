import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });

for await (const line of input) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (!Object.hasOwn(request, "id")) continue;

  let result;
  if (request.method === "initialize") {
    result = { protocolVersion: 1, agentCapabilities: {} };
  } else if (request.method === "session/new") {
    result = { sessionId: "release-smoke-session", configOptions: [] };
  } else if (request.method === "session/close") {
    result = {};
  } else {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      })}\n`,
    );
    continue;
  }

  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
  );
}
