import assert from "node:assert/strict";
import { test } from "node:test";
import { raceWithAbort } from "../src/sessions/manager.ts";

test("an aborted race handles the rejection of the abandoned promise", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));
    let rejectStartup;
    const startup = new Promise((_, reject) => {
      rejectStartup = reject;
    });

    await assert.rejects(
      raceWithAbort(startup, controller.signal),
      /client disconnected/,
    );
    rejectStartup(new Error("ACP connection closed"));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
