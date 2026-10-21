import assert from "node:assert/strict";
import { test } from "node:test";
import {
  interceptSessionUpdates,
  interceptV2SessionUpdates,
} from "../src/acp/session_update_stream.ts";

function createStream(messages) {
  return {
    readable: new ReadableStream({
      start(controller) {
        for (const message of messages) controller.enqueue(message);
        controller.close();
      },
    }),
    writable: new WritableStream(),
  };
}

async function readAll(readable) {
  const messages = [];
  for await (const message of readable) messages.push(message);
  return messages;
}

test("ACP v1 forwards unknown session updates with their raw params", async () => {
  const knownParams = {
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "before" },
    },
  };
  const unknownParams = {
    sessionId: "session-1",
    update: {
      sessionUpdate: "future_update",
      detail: { retained: true },
    },
    _meta: { fixture: "raw-wire", ordinal: 2 },
    ordinal: 2,
  };
  const afterParams = {
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "after" },
    },
  };
  const response = {
    jsonrpc: "2.0",
    id: 7,
    result: { protocolVersion: 1 },
  };
  const received = [];
  const stream = interceptSessionUpdates(
    createStream([
      { jsonrpc: "2.0", method: "session/update", params: knownParams },
      { jsonrpc: "2.0", method: "session/update", params: unknownParams },
      { jsonrpc: "2.0", method: "session/update", params: afterParams },
      response,
    ]),
    (params) => received.push(params),
  );

  assert.deepEqual(await readAll(stream.readable), [response]);
  assert.deepEqual(received, [knownParams, unknownParams, afterParams]);
  assert.deepEqual(received[1], unknownParams);
});

test("ACP v2 forwards unknown updates from batches and preserves other entries", async () => {
  const unknownParams = {
    sessionId: "session-2",
    update: {
      sessionUpdate: "future_update",
      detail: { retained: true },
    },
    _meta: { fixture: "raw-wire", ordinal: 4 },
    ordinal: 4,
  };
  const response = {
    jsonrpc: "2.0",
    id: 9,
    result: { protocolVersion: 2 },
  };
  const received = [];
  const stream = interceptV2SessionUpdates(
    createStream([
      [
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: unknownParams,
        },
        response,
      ],
    ]),
    (params) => received.push(params),
  );

  assert.deepEqual(await readAll(stream.readable), [[response]]);
  assert.deepEqual(received, [unknownParams]);
});
