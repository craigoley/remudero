// W1-T10235: test/serve-view-events.test.ts asserted that the FIRST view event after a ledger append has cause
// "body". The 1 s judge sweep may flip the old body stale first (cause "judge"), so the event it wanted came second.
// This pins the ordering the fixed assertion relies on: a judge flip may precede the worker's body, never replace it.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createService } from "#src/lib/service.js";
import { createViewEvents, VIEW_EVENTS_PATH, VIEW_EVENTS_SWEEP_MS } from "#src/lib/view-events.js";
import { viewEtag, type ViewBodyEntry, type ViewSource } from "#src/lib/views.js";

const GEN = "2026-09-30T12:00:00.000Z";

function body(version: number, data: unknown): ViewBodyEntry {
  const sources: ViewSource[] = [{ name: "ledger:core", asOf: GEN, state: "fresh" }];
  return { view: "read-model", key: "", version, generation: version, etag: viewEtag("read-model", version, false, data), body: { view: "read-model", version, generatedAt: GEN, asOf: null, stale: false, sources, data } };
}

test("W1-T10235: check:test:test/serve-view-events.test.ts:flaky is prevented, not retried", async (t) => {
  let stalled = false;
  const bodies = new Map<string, ViewBodyEntry>([["read-model\u0000", body(1, "a")]]);
  const listeners = new Set<(e: ViewBodyEntry) => void>();
  let sweep: () => void = () => {};
  const events = createViewEvents({
    names: ["read-model"],
    readModel: {
      bodies,
      judge: (sources) => sources.map((s) => (stalled ? { ...s, state: "stale" as const, reason: "behind the ledger" } : s)),
      body: (view, key = "") => bodies.get(`${view}\u0000${key}`),
      switches: () => ({ projector: "on" as const, views: { "read-model": "serve" as const }, push: "on" as const }),
      onBody: (l) => (listeners.add(l), () => listeners.delete(l)),
      autoMode: (() => undefined) as never,
    },
    every: (run, ms) => {
      if (ms === VIEW_EVENTS_SWEEP_MS) sweep = run;
      return () => {};
    },
  });
  const server = createService({ tokens: { read: "r", write: "w" }, routes: events.routes });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    server.closeAllConnections();
    server.close();
  });
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${VIEW_EVENTS_PATH}`, { headers: { authorization: "Bearer r" }, signal: controller.signal });
  const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const views = (): Array<Record<string, unknown>> =>
    [...text.matchAll(/event: view\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
  const until = async (n: number): Promise<void> => {
    while (views().length < n) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("stream ended early");
      text += decoder.decode(chunk.value, { stream: true });
    }
  };
  while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value, { stream: true });

  stalled = true;
  sweep();
  const next = body(2, "b");
  bodies.set("read-model\u0000", { ...next, body: { ...next.body, stale: true } });
  for (const l of listeners) l(bodies.get("read-model\u0000")!);
  await until(2);
  const causes = views().map((v) => v.cause);
  assert.equal(causes[0], "judge", "the sweep's stale flip arrives first, as in the flaky run");
  assert.ok(causes.includes("body"), "the worker's body event still follows, so a test must wait for cause body, not take the first event");
});
