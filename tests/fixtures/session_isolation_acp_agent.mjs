import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.ACP_TEST_LOG;
const protocol = process.env.ACP_TEST_PROTOCOL ?? "v1";
const sessions = new Map();
let nextSession = 1;

function log(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

log({ kind: "process_start", protocol });

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (!Object.hasOwn(request, "id")) continue;

  if (request.method === "initialize") {
    respond(
      request.id,
      protocol === "v2"
        ? {
            protocolVersion: 2,
            info: { name: "fake-agent", version: "1.0.0" },
            capabilities: {},
          }
        : { protocolVersion: 1, agentCapabilities: {} },
    );
  } else if (request.method === "session/new") {
    const sessionId = `session-${nextSession++}`;
    sessions.set(sessionId, []);
    log({ kind: "session_new", sessionId });
    respond(request.id, { sessionId, configOptions: [] });
  } else if (request.method === "session/prompt") {
    const sessionId = request.params.sessionId;
    const prompt = request.params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const history = sessions.get(sessionId);
    if (!history) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: "unknown session" },
        })}\n`,
      );
      continue;
    }
    history.push(prompt);
    log({
      kind: "prompt",
      sessionId,
      prompt,
      priorPrompts: history.length - 1,
    });
    const updates =
      protocol === "v2"
        ? [
            { sessionUpdate: "state_update", state: "running" },
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `answer from ${sessionId}` },
            },
            {
              sessionUpdate: "state_update",
              state: "idle",
              stopReason: "end_turn",
            },
          ]
        : [
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `answer from ${sessionId}` },
            },
          ];
    for (const update of updates) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update },
        })}\n`,
      );
    }
    respond(
      request.id,
      protocol === "v2"
        ? { messageId: `message-${sessionId}` }
        : { stopReason: "end_turn" },
    );
  } else if (request.method === "session/close") {
    const sessionId = request.params.sessionId;
    sessions.delete(sessionId);
    log({ kind: "session_close", sessionId });
    respond(request.id, {});
  } else {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      })}\n`,
    );
  }
}
