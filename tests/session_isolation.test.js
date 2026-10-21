import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { OpenAiRuntime } from "../src/openai/runtime.ts";

async function verifySessionIsolation(protocol) {
  const tempDir = await mkdtemp(join(tmpdir(), "acp-api-session-test-"));
  const logPath = join(tempDir, "agent.jsonl");
  const fixture = fileURLToPath(
    new URL("./fixtures/session_isolation_acp_agent.mjs", import.meta.url),
  );
  const definition = {
    command: process.execPath,
    args: [fixture],
    env: { ACP_TEST_LOG: logPath, ACP_TEST_PROTOCOL: protocol },
    acpProtocol: protocol,
  };
  const runtime = await OpenAiRuntime.start({
    path: tempDir,
    host: "127.0.0.1",
    port: 0,
    apiKey: "",
    routingStrategy: "primary_failover",
    maxRetries: 0,
    failureCooldownMs: 0,
    retryBackoffMs: 0,
    maxSessions: 2,
    maxBodyBytes: 1024 * 1024,
    requestTimeoutMs: 5000,
    agents: [
      {
        id: "isolated-agent",
        name: "Isolated fake agent",
        command: process.execPath,
        args: [fixture],
        cwd: tempDir,
        env: { ACP_TEST_LOG: logPath, ACP_TEST_PROTOCOL: protocol },
        models: ["test-model"],
        permissionPolicy: "deny_all",
        definition,
      },
    ],
  });

  try {
    const signal = AbortSignal.timeout(5000);
    const first = await runtime.generate(
      "test-model",
      [
        { type: "text", text: "System: shared instruction" },
        { type: "text", text: "user: first turn" },
      ],
      "conversation-one",
      signal,
    );
    const second = await runtime.generate(
      "test-model",
      [
        { type: "text", text: "System: shared instruction" },
        { type: "text", text: "user: first turn" },
        { type: "text", text: "assistant: first answer" },
        { type: "text", text: "user: second turn" },
      ],
      "conversation-one",
      signal,
    );
    const third = await runtime.generate(
      "test-model",
      [{ type: "text", text: "user: independent conversation" }],
      "conversation-two",
      signal,
    );

    const entries = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const processStarts = entries.filter(
      (entry) => entry.kind === "process_start",
    );
    const newSessions = entries.filter((entry) => entry.kind === "session_new");
    const prompts = entries.filter((entry) => entry.kind === "prompt");
    const closedSessions = entries.filter(
      (entry) => entry.kind === "session_close",
    );

    assert.equal(first.text, "answer from session-1");
    assert.equal(second.text, "answer from session-2");
    assert.equal(third.text, "answer from session-3");
    assert.equal(processStarts.length, 1);
    assert.equal(newSessions.length, 3);
    assert.equal(prompts.length, 3);
    assert.equal(new Set(prompts.map((entry) => entry.sessionId)).size, 3);
    assert.deepEqual(
      prompts.map((entry) => entry.priorPrompts),
      [0, 0, 0],
    );
    assert.match(prompts[0].prompt, /first turn/);
    assert.doesNotMatch(prompts[0].prompt, /second turn/);
    assert.match(prompts[1].prompt, /first turn/);
    assert.match(prompts[1].prompt, /second turn/);
    assert.match(prompts[2].prompt, /independent conversation/);
    assert.doesNotMatch(prompts[2].prompt, /first turn|second turn/);
    assert.equal(closedSessions.length, 3);
    assert.equal(runtime.manager.sessionCount, 0);
  } finally {
    await runtime.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("ACP v1 uses isolated sessions on one warm agent", async () => {
  await verifySessionIsolation("v1");
});

test("ACP v2 uses isolated sessions on one warm agent", async () => {
  await verifySessionIsolation("v2");
});
