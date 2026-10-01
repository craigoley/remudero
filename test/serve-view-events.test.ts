// P2-02: GET /v1/views/events wired into the assembled serve. A real read-model worker projects a real
// ledger and posts bodies; the stream is read over real HTTP. The recycle test drives the real drain, so
// it proves both that an open stream is not read attention and that a drain hands every stream over.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { buildServeServer, resolveConsoleSha, type ServeDeps } from "../src/lib/serve.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { VIEW_EVENTS_PATH } from "../src/lib/view-events.js";
import { readModelSwitchesPath } from "../src/lib/read-model-worker.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const READ = { authorization: "Bearer read-token" };
const SILENT_WORKER = new URL("data:text/javascript,setInterval(() => {}, 1000)");
type TestCtx = { after: (fn: () => void | Promise<void>) => void };

function row(i: number): string {
  return `${JSON.stringify({ ts: new Date(T0 + i).toISOString(), step: "run.start", task_id: `T${i}`, run_id: `r-${i}` })}\n`;
}

function deps(extra: Partial<ServeDeps>): { deps: ServeDeps; ledgerPath: string; root: string } {
  const root = makeTempDir("serve-view-events");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, row(0) + row(1));
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ push: "on" }));
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  return {
    root,
    ledgerPath,
    deps: {
      board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
      panelGraph: { root, planPath: join(root, "plan.yaml"), ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } },
      ledgerPath,
      issues: { close: () => {} },
      fleetControlRoot: root,
      questionsRoot: root,
      tokens: { read: "read-token", write: "write-token" },
      githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
      ...extra,
    } as ServeDeps,
  };
}

async function listen(t: TestCtx, server: Server, root: string): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Frame { event: string; data: Record<string, unknown>; at: number }

async function stream(t: TestCtx, url: string): Promise<{ frames: Frame[]; ended: () => boolean }> {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(url, { headers: READ, signal: controller.signal });
  assert.equal(res.status, 200);
  const frames: Frame[] = [];
  let done = false;
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const lines = buffer.slice(0, cut).split("\n");
          buffer = buffer.slice(cut + 2);
          const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
          const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
          if (event && data) frames.push({ event, data: JSON.parse(data), at: performance.now() });
        }
      }
    } catch {
      // Aborted by the test's cleanup.
    }
    done = true;
  })();
  return { frames, ended: () => done };
}

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

test("a ledger row reaches an events subscriber of the assembled serve over real HTTP", async (t) => {
  const { deps: d, ledgerPath, root } = deps({ readModel: { tickMs: 20 } });
  const url = await listen(t, buildServeServer(d), root);
  const { frames } = await stream(t, `${url}${VIEW_EVENTS_PATH}?views=read-model`);
  await until(() => frames.some((f) => f.event === "hello"), 5_000, "hello");
  const hello = frames.find((f) => f.event === "hello")!;
  assert.deepEqual(hello.data.disabled, [], "the read model's own status serves with no switch file");
  const etagOf = (): string | undefined => {
    const last = frames.filter((f) => f.event === "view").at(-1);
    return (last?.data.etag as string | undefined) ?? ((hello.data.views as Record<string, Record<string, string>>)["read-model"]?.[""]);
  };
  await until(() => {
    const served = etagOf();
    return served !== undefined && frames.filter((f) => f.event === "view").every((f) => f.data.view === "read-model");
  }, 20_000, "the worker's first read-model body");
  await sleep(200);
  const before = etagOf();
  const seen = frames.length;
  const appendedAt = performance.now();
  appendFileSync(ledgerPath, row(2));
  await until(() => frames.slice(seen).some((f) => f.event === "view" && f.data.etag !== before), 10_000, "the new row's view event");
  const event = frames.slice(seen).find((f) => f.event === "view")!;
  assert.equal(event.data.view, "read-model");
  assert.equal(event.data.cause, "body");
  const res = await fetch(`${url}/v1/views/read-model`, { headers: READ });
  assert.equal(res.headers.get("etag"), event.data.etag, "the event's etag is the one the refetch answers with");
  t.diagnostic(`ledger append -> SSE view event: ${Math.round(event.at - appendedAt)} ms (tick 20 ms)`);
});

test("an events subscriber alone does not extend recycle patience", async (t) => {
  let recheck: () => void = () => {};
  const exits: number[] = [];
  const { deps: d, root } = deps({
    consoleSha: resolveConsoleSha(),
    gatewayCheckout: async () => ({ state: { head: "a".repeat(40), behindBy: 2, dirty: false, checkedAt: new Date(T0).toISOString() }, restartDue: true }),
    staleExitSeams: { scheduleRecheck: (run) => ((recheck = run), () => {}), exit: (code) => void exits.push(code) },
    readModel: { workerUrl: SILENT_WORKER, every: () => () => {} },
  });
  const url = await listen(t, buildServeServer(d), root);
  const { frames, ended } = await stream(t, `${url}${VIEW_EVENTS_PATH}`);
  await until(() => frames.some((f) => f.event === "hello"), 5_000, "hello");
  await sleep(50);
  recheck();
  await until(() => exits.length > 0, 5_000, "the due restart, which an attentive reader would have postponed");
  assert.deepEqual(exits, [0]);
  assert.deepEqual(frames.at(-1)?.data, { reason: "recycle", retryMs: 0 }, "the drain handed the stream over");
  await until(ended, 2_000, "the stream's end");
});
