import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildStatusStream } from "../src/lib/board.js";
import { createService, type SseRoute } from "../src/lib/service.js";
import type { BoardDeps } from "../src/lib/status.js";

const TOKEN = "status-stream-wire-read";

async function readFrames(route: SseRoute, headers: Record<string, string>, until: (text: string) => boolean) {
  const server = createService({ tokens: { read: TOKEN, write: "status-stream-wire-write" }, sse: [route] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
      headers: { authorization: `Bearer ${TOKEN}`, ...headers }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 2_000;
    while (!until(text) && Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(), new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("SSE frame did not arrive")), 2_000)),
      ]);
      if (result.done) break;
      text += decoder.decode(result.value);
    }
    return text;
  } finally {
    controller.abort();
    server.close();
  }
}

test("status stream transport writes id fields and comment heartbeats as SSE frames", async () => {
  const route: SseRoute = {
    path: "/events", scope: "read",
    subscribe: (send) => {
      send("status", { taskId: "W1-TX" }, "boot:7");
      send.comment?.("hb");
      return () => {};
    },
  };
  const frames = await readFrames(route, {}, (text) => text.includes(": hb\n\n"));
  assert.match(frames, /id: boot:7\nevent: status\ndata: \{"taskId":"W1-TX"\}\n\n/);
  assert.match(frames, /: hb\n\n/);
  assert.doesNotMatch(frames, /event: heartbeat/);
});

test("status stream route forwards Last-Event-ID to the publisher", async () => {
  const deps = {
    plan: { tasks: [], byId: new Map() }, ledgerPath: "/unused",
    github: { prByRef: () => null, findMergedByTrailer: () => null,
      headRefName: () => undefined, prBody: () => undefined },
    readLedger: () => [],
  } as BoardDeps;
  const frames = await readFrames(buildStatusStream(deps, 1_000), { "last-event-id": "older-boot:1" },
    (text) => text.includes("event: resync"));
  assert.match(frames, /event: resync\ndata: \{"reason":"gap"\}\n\n/);
});
