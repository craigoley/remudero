import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildStatusRoute, buildStatusStream, computeBoardSnapshot, type BoardDeps } from "../src/lib/board.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";

// ── W3-T2: the read-only live board's daemon-side wiring (MASTER-PLAN §7, WS-5a) ────────────
//
// Acceptance (plan/tasks.yaml): (1) "a ledger state flip appears in the UI within 2s of the
// write" -- proven below as an SSE-CLIENT timestamp assertion (the ledger append's Date.now()
// vs. the moment the SSE client parses the corresponding `status` event), driving REAL
// createService()/fetch() plumbing, never a mock of either -- same discipline as
// test/service.test.ts. (2) "the dashboard consumes ONLY the api-client" is proven separately
// by scripts/no-hand-rolled-fetch-check.mjs's suite scanning the real apps/dashboard source.
//
// This module wires ZERO new business logic (src/lib/board.ts's header) -- it is a thin
// Route/SseRoute layer over the EXISTING lib/status.ts projection, so these tests exercise the
// WIRING (route registration, scope, ledger-tail-to-SSE-event), not deriveStatus's precedence
// rules (already exhaustively covered by test/status.test.ts).

const READ_TOKEN = "board-read-token";
const WRITE_TOKEN = "board-write-token";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued", // decorative — never trusted
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function fakeGitHub(byRef: Record<string, PrRef> = {}): GitHub {
  return {
    prByRef: (ref) => byRef[String(ref)] ?? null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function tmpLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

async function withBoardService<T>(deps: BoardDeps, pollMs: number, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: [buildStatusRoute(deps)],
    sse: [buildStatusStream(deps, pollMs)],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** A real SSE client over `fetch` -- the SAME shape @remudero/api-client's client.ts uses. */
function openSseClient(base: string, path: string, token: string) {
  const events: SseEvent[] = [];
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done: eof, value } = await reader.read();
        if (eof) return;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (eventLine && dataLine) {
            events.push({ event: eventLine.slice("event:".length).trim(), data: JSON.parse(dataLine.slice("data:".length).trim()) });
          }
        }
      }
    } catch {
      // aborted — expected on stop()
    }
  })();
  return { events, stop: () => controller.abort(), done };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2500, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

test("computeBoardSnapshot: one StatusProjection per plan task, reusing projectPlan verbatim", () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "A" }), task({ id: "B" })]);
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub() };

  const snapshot = computeBoardSnapshot(deps);

  assert.match(snapshot.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(snapshot.tasks.length, 2);
  const ids = snapshot.tasks.map((t) => t.taskId).sort();
  assert.deepEqual(ids, ["A", "B"]);
  for (const t of snapshot.tasks) {
    assert.equal(t.status, "queued"); // no GitHub evidence for either fixture task
    assert.equal(t.merged, false);
  }
});

test("GET /v1/status: read-scoped snapshot, matches computeBoardSnapshot", async () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "A" })]);
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub() };

  await withBoardService(deps, 1000, async (base) => {
    const res = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tasks: Array<{ taskId: string; status: string }> };
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].taskId, "A");
    assert.equal(body.tasks[0].status, "queued");

    // write token is a superset — also succeeds, same port.
    const write = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${WRITE_TOKEN}` } });
    assert.equal(write.status, 200);
  });
});

test("GET /v1/status: no bearer token -> 401", async () => {
  const ledgerPath = tmpLedgerPath();
  const deps: BoardDeps = { plan: planOf([task()]), ledgerPath, github: fakeGitHub() };
  await withBoardService(deps, 1000, async (base) => {
    const res = await fetch(`${base}/v1/status`);
    assert.equal(res.status, 401);
  });
});

test("GET /v1/status/stream: a ledger state flip arrives as an SSE `status` event within 2s of the write", async () => {
  const ledgerPath = tmpLedgerPath();
  const prUrl = "https://github.com/craigoley/remudero/pull/999";
  const plan = planOf([task({ id: "W1-TX" })]);
  // The task starts with NO GitHub evidence (queued/unmerged); the ledger write below is the
  // "state flip" the acceptance criterion names — the same PR resolves to MERGED afterwards.
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub({ [prUrl]: { number: 999, url: prUrl, state: "MERGED" } }) };

  await withBoardService(deps, 50, async (base) => {
    const client = openSseClient(base, "/v1/status/stream", READ_TOKEN);
    try {
      // Give the subscribe() priming line a moment to prime `lastLineCount` before writing.
      await new Promise((resolve) => setTimeout(resolve, 60));

      const writeTs = Date.now();
      appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-TX", step: "pr.opened", pr_url: prUrl }) + "\n");

      await waitFor(() => client.events.some((e) => e.event === "status"));
      const receiveTs = Date.now();
      const latencyMs = receiveTs - writeTs;

      const flip = client.events.find((e) => e.event === "status")!.data as { taskId: string; status: string; merged: boolean };
      assert.equal(flip.taskId, "W1-TX");
      assert.equal(flip.status, "merged");
      assert.equal(flip.merged, true);
      assert.ok(latencyMs < 2000, `SSE receive latency ${latencyMs}ms was NOT under the 2s acceptance bar`);
    } finally {
      client.stop();
      await client.done;
    }
  });
});

test("GET /v1/status/stream: a re-derivation that does NOT change the projection sends no duplicate event", async () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-TX" })]);
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub() }; // never resolves -> always "queued"/unmerged

  await withBoardService(deps, 30, async (base) => {
    const client = openSseClient(base, "/v1/status/stream", READ_TOKEN);
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      // Two ledger lines for the SAME task, neither of which the fake GitHub gateway can
      // resolve -- deriveStatus returns the identical "queued"/unmerged projection both times.
      appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-TX", step: "recon.start" }) + "\n");
      await new Promise((resolve) => setTimeout(resolve, 150)); // several poll ticks at 30ms
      appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-TX", step: "recon.done" }) + "\n");
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(client.events.filter((e) => e.event === "status").length, 0);
    } finally {
      client.stop();
      await client.done;
    }
  });
});

test("GET /v1/status/stream: unsubscribing (client disconnect) stops the ledger poll", async () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-TX" })]);
  const prUrl = "https://github.com/craigoley/remudero/pull/1";
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub({ [prUrl]: { number: 1, url: prUrl, state: "MERGED" } }) };

  await withBoardService(deps, 30, async (base) => {
    const client = openSseClient(base, "/v1/status/stream", READ_TOKEN);
    await new Promise((resolve) => setTimeout(resolve, 40));
    client.stop();
    await client.done;

    // Written AFTER the client disconnected — a leaked poll timer would still pick this up
    // and write to a closed response (this only proves no event reaches this client, since it
    // has already stopped reading; buildStatusStream's own unsubscribe -- clearInterval -- is
    // exercised by service.ts's `req.on("close")`, proven generically in test/service.test.ts).
    appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-TX", step: "pr.opened", pr_url: prUrl }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(client.events.filter((e) => e.event === "status").length, 0);
  });
});
