import assert from "node:assert/strict";
import fs, { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import {
  buildRecentRoute,
  buildStatusRoute,
  buildStatusStream,
  compareByAge,
  compareById,
  compareByRecency,
  compareByStatus,
  computeBoardSnapshot,
  computeRecentActivity,
  createBoardSnapshotCache,
  createRecentActivityCache,
  DEFAULT_POLL_MS,
  sortBoardRows,
  type BoardDeps,
  type BoardRow,
} from "../src/lib/board.js";
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

test("W1-T155: computeBoardSnapshot carries the full status taxonomy through for free — an in-flight task's phase/startedAt/elapsedMs pass through projectPlan unchanged", () => {
  const ledgerPath = tmpLedgerPath();
  appendFileSync(
    ledgerPath,
    JSON.stringify({ ts: "2026-07-20T10:00:00.000Z", run_id: "r1", task_id: "A", step: "run.start" }) + "\n",
  );
  const plan = planOf([task({ id: "A" })]);
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub(), now: () => Date.parse("2026-07-20T10:00:10.000Z") };

  const snapshot = computeBoardSnapshot(deps);

  assert.equal(snapshot.tasks.length, 1);
  const [proj] = snapshot.tasks;
  assert.equal(proj.status, "running");
  assert.equal(proj.phase, "recon");
  assert.equal(proj.startedAt, "2026-07-20T10:00:00.000Z");
  assert.equal(proj.elapsedMs, 10_000);
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

// ── W1-T157: the BoardRow title/risk/lastActivityAt join + the FIND-layer sort comparators ──

test("W1-T157: computeBoardSnapshot joins each row with its plan Task's title + risk (the FIND search/facet fields StatusProjection does not carry)", () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([
    task({ id: "W1-T1", title: "shell IA overhaul", risk: "high" }),
    task({ id: "W2-T2", title: "drain preview", risk: "low" }),
  ]);
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub() };

  const rows = computeBoardSnapshot(deps).tasks;
  const byId = new Map(rows.map((r) => [r.taskId, r]));
  assert.equal(byId.get("W1-T1")!.title, "shell IA overhaul");
  assert.equal(byId.get("W1-T1")!.risk, "high");
  assert.equal(byId.get("W2-T2")!.title, "drain preview");
  assert.equal(byId.get("W2-T2")!.risk, "low");
});

test("W1-T157: computeBoardSnapshot sets lastActivityAt to the ts of the LAST ledger line naming the task; a task with no ledger line has none", () => {
  const ledgerPath = tmpLedgerPath();
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T10:00:00.000Z", run_id: "r1", task_id: "A", step: "run.start" }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T10:05:00.000Z", run_id: "r1", task_id: "A", step: "recon.done" }) + "\n");
  const plan = planOf([task({ id: "A" }), task({ id: "B" })]);
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub() };

  const byId = new Map(computeBoardSnapshot(deps).tasks.map((r) => [r.taskId, r]));
  assert.equal(byId.get("A")!.lastActivityAt, "2026-07-20T10:05:00.000Z"); // the LAST line, not the first
  assert.equal(byId.get("B")!.lastActivityAt, undefined); // no ledger line at all
});

function row(over: Partial<BoardRow>): BoardRow {
  return { taskId: "X", status: "queued", merged: false, source: "none", title: "t", risk: "medium", ...over };
}

test("W1-T157: compareById is lexicographic; dir flips it", () => {
  const a = row({ taskId: "W1-T1" });
  const b = row({ taskId: "W1-T2" });
  assert.ok(compareById(a, b, "asc") < 0);
  assert.ok(compareById(a, b, "desc") > 0);
});

test("W1-T157: compareByStatus orders by TASK_STATUSES index (queued before running before merged)", () => {
  const queued = row({ status: "queued" });
  const running = row({ status: "running" });
  const merged = row({ status: "merged" });
  assert.ok(compareByStatus(queued, running, "asc") < 0);
  assert.ok(compareByStatus(running, merged, "asc") < 0);
  assert.ok(compareByStatus(merged, queued, "asc") > 0);
  assert.ok(compareByStatus(queued, merged, "desc") > 0);
});

test("W1-T157: compareByRecency orders by lastActivityAt; a task with NONE sorts last in BOTH directions", () => {
  const older = row({ taskId: "OLD", lastActivityAt: "2026-07-20T10:00:00.000Z" });
  const newer = row({ taskId: "NEW", lastActivityAt: "2026-07-20T12:00:00.000Z" });
  const none = row({ taskId: "NONE" });
  assert.ok(compareByRecency(older, newer, "asc") < 0); // older first ascending
  assert.ok(compareByRecency(newer, older, "desc") < 0); // newer first descending
  // "none" (no activity) always sorts AFTER a task that has activity, whichever direction:
  assert.ok(compareByRecency(none, newer, "asc") > 0);
  assert.ok(compareByRecency(none, newer, "desc") > 0);
  assert.ok(compareByRecency(none, older, "asc") > 0);
  assert.ok(compareByRecency(none, older, "desc") > 0);
});

test("W1-T157: compareByAge orders by elapsedMs; a task with none sorts last in BOTH directions", () => {
  const young = row({ taskId: "Y", elapsedMs: 1000 });
  const old = row({ taskId: "O", elapsedMs: 9000 });
  const noAge = row({ taskId: "N" });
  assert.ok(compareByAge(young, old, "asc") < 0);
  assert.ok(compareByAge(old, young, "desc") < 0);
  assert.ok(compareByAge(noAge, young, "asc") > 0);
  assert.ok(compareByAge(noAge, young, "desc") > 0);
});

test("W1-T157: sortBoardRows applies the chosen column/dir with a stable id-ascending tiebreak", () => {
  const rows = [
    row({ taskId: "W1-T3", status: "merged", lastActivityAt: "2026-07-20T10:00:00.000Z" }),
    row({ taskId: "W1-T1", status: "queued" }),
    row({ taskId: "W1-T2", status: "merged", lastActivityAt: "2026-07-20T11:00:00.000Z" }),
  ];
  assert.deepEqual(sortBoardRows(rows, "id", "asc").map((r) => r.taskId), ["W1-T1", "W1-T2", "W1-T3"]);
  assert.deepEqual(sortBoardRows(rows, "id", "desc").map((r) => r.taskId), ["W1-T3", "W1-T2", "W1-T1"]);
  // recency desc: most-recent first, then the no-activity task (W1-T1) last:
  assert.deepEqual(sortBoardRows(rows, "recency", "desc").map((r) => r.taskId), ["W1-T2", "W1-T3", "W1-T1"]);
  // status asc: queued (W1-T1) first, then the two merged tie broken by id ascending:
  assert.deepEqual(sortBoardRows(rows, "status", "asc").map((r) => r.taskId), ["W1-T1", "W1-T2", "W1-T3"]);
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

test("W1-T184: GET /v1/status/stream carries LIVE accumulated spend/turns too, not just the bare StatusProjection — and re-sends on a spend-only change with no status/phase change", async () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-T1" })]);
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub() };

  await withBoardService(deps, 20, async (base) => {
    const client = openSseClient(base, "/v1/status/stream", READ_TOKEN);
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "run.start" }) + "\n");
      appendFileSync(
        ledgerPath,
        JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "implement.done", cost_usd: 1.24, num_turns: 38 }) + "\n",
      );
      await waitFor(() => client.events.some((e) => (e.data as { liveSpendUsd?: number }).liveSpendUsd !== undefined));
      const first = client.events.find((e) => (e.data as { liveSpendUsd?: number }).liveSpendUsd !== undefined)!
        .data as { liveSpendUsd: number; liveTurns: number; phase: string };
      assert.equal(first.liveSpendUsd, 1.24);
      assert.equal(first.liveTurns, 38);
      assert.equal(first.phase, "review"); // deriveRunState: implement.done advances the phase to "review"

      // A SECOND fix.done line: phase/status stay IDENTICAL (still "review", still no verdict),
      // but the accumulated spend advances -- this must still emit a fresh SSE event (the
      // pre-fix "no actual flip" dedup compared only the bare, spend-less StatusProjection, so a
      // spend-only change was silently swallowed and never reached the client at all).
      appendFileSync(
        ledgerPath,
        JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "fix.done", strike: 1, cost_usd: 1.3, num_turns: 38 }) + "\n",
      );
      await waitFor(() => client.events.filter((e) => e.event === "status").length >= 2);
      const spendEvents = client.events.filter((e) => e.event === "status").map((e) => e.data as { liveSpendUsd?: number });
      assert.ok(spendEvents.some((d) => d.liveSpendUsd === 2.54), "the spend-only update must reach the client over SSE, live");
    } finally {
      client.stop();
      await client.done;
    }
  });
});

// ── W1-T184: LEDGER-FIRST RENDERING ─────────────────────────────────────────────────────────
//
// RECENT becomes an activity feed sourced from the LOCAL ledger; NOW rows carry live per-run
// spend/turns; GitHub decorates (never gates) — see board.ts's own header comment on
// computeRecentActivity/decoratePrTitle for the full design rationale (the 2026-07-20 outage +
// invisible-burn fixtures this task exists to fix).

test("W1-T184: computeRecentActivity classifies every ledger event class the design note names — merged, verdict, fix (dispatch/done/exhausted), escalated, spend — each carrying task id + title", () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-T1", title: "task one" }), task({ id: "W1-T2", title: "task two" })]);
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub() };
  const cache = createRecentActivityCache();

  appendFileSync(
    ledgerPath,
    [
      JSON.stringify({ ts: "2026-07-20T10:00:00Z", run_id: "r1", task_id: "W1-T1", step: "pr.opened", pr_url: "https://github.com/o/r/pull/1" }),
      JSON.stringify({ ts: "2026-07-20T10:00:01Z", run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 3.5 }),
      JSON.stringify({ ts: "2026-07-20T10:01:00Z", run_id: "r2", task_id: "W1-T2", step: "fix.dispatch", strike: 1 }),
      JSON.stringify({ ts: "2026-07-20T10:02:00Z", run_id: "r2", task_id: "W1-T2", step: "fix.done", strike: 1, cost_usd: 1.24, num_turns: 38 }),
      JSON.stringify({ ts: "2026-07-20T10:03:00Z", run_id: "r2", task_id: "W1-T2", step: "fix.exhausted", strikes: 2, issue_url: "https://github.com/o/r/issues/5" }),
      JSON.stringify({ ts: "2026-07-20T10:04:00Z", run_id: "r2", task_id: "W1-T2", step: "escalation.issue_opened", class: "BLOCKED", issue_url: "https://github.com/o/r/issues/5" }),
      JSON.stringify({ ts: "2026-07-20T10:05:00Z", run_id: "r3", task_id: "W1-T2", step: "implement.done", cost_usd: 0.42, num_turns: 5 }),
      // pseudo-ids the daemon/sweep/drain log under -- never a real plan task, must be filtered out.
      JSON.stringify({ ts: "2026-07-20T10:06:00Z", run_id: "r9", task_id: "DAEMON", step: "verdict", verdict: "merged", cost_usd: 99 }),
    ].join("\n") + "\n",
  );

  const entries = computeRecentActivity(deps, cache, 20);
  // most-recent-first: implement.done, escalation, fix.exhausted, fix.done, fix.dispatch, then the W1-T1 merge.
  assert.deepEqual(entries.map((e) => e.taskId), ["W1-T2", "W1-T2", "W1-T2", "W1-T2", "W1-T2", "W1-T1"]);
  assert.deepEqual(entries.map((e) => e.verb), ["spend", "escalated", "fix", "fix", "fix", "merged"]);
  assert.ok(entries.every((e) => e.title === (e.taskId === "W1-T1" ? "task one" : "task two")));
  assert.ok(!entries.some((e) => e.taskId === "DAEMON"), "a pseudo run-id task must never surface as a feed row");

  const merged = entries.find((e) => e.verb === "merged")!;
  assert.equal(merged.costUsd, 3.5);
  assert.equal(merged.prUrl, "https://github.com/o/r/pull/1");
  assert.equal(merged.prNumber, 1);

  const fixDone = entries.find((e) => e.verb === "fix" && e.detail?.startsWith("done"))!;
  assert.equal(fixDone.costUsd, 1.24);
  assert.equal(fixDone.numTurns, 38);
});

test("W1-T184: GitHub outage renders the IDENTICAL activity feed as a healthy read — GitHub decorates (PR title), it never gates the row", () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-T1", title: "a task" })]);
  const prUrl = "https://github.com/o/r/pull/1";
  appendFileSync(
    ledgerPath,
    [
      JSON.stringify({ ts: "2026-07-20T10:00:00Z", run_id: "r1", task_id: "W1-T1", step: "pr.opened", pr_url: prUrl }),
      JSON.stringify({ ts: "2026-07-20T10:00:01Z", run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 1 }),
    ].join("\n") + "\n",
  );

  const healthy = computeRecentActivity(
    { plan, ledgerPath, github: fakeGitHub({ [prUrl]: { number: 1, url: prUrl, state: "MERGED", title: "real PR title" } }) },
    createRecentActivityCache(),
  );

  const darkGithub: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => true,
    readFailureReason: () => "buffer_overflow",
  };
  const dark = computeRecentActivity({ plan, ledgerPath, github: darkGithub }, createRecentActivityCache());

  assert.equal(dark.length, healthy.length);
  const strip = (e: { taskId: string; verb: string; prUrl?: string; costUsd?: number }) => ({ taskId: e.taskId, verb: e.verb, prUrl: e.prUrl, costUsd: e.costUsd });
  assert.deepEqual(dark.map(strip), healthy.map(strip));
  assert.equal(healthy[0]!.prTitle, "real PR title");
  assert.equal(dark[0]!.prTitle, undefined);
  assert.equal(dark[0]!.githubUnavailable, true);
});

test("W1-T184: a GitHub gateway that THROWS (not merely fail-soft-nulls) still degrades one row, it never crashes the whole feed", () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-T1", title: "a task" }), task({ id: "W1-T2", title: "another task" })]);
  const prUrl1 = "https://github.com/o/r/pull/1";
  const prUrl2 = "https://github.com/o/r/pull/2";
  appendFileSync(
    ledgerPath,
    [
      JSON.stringify({ ts: "2026-07-20T10:00:00Z", run_id: "r1", task_id: "W1-T1", step: "pr.opened", pr_url: prUrl1 }),
      JSON.stringify({ ts: "2026-07-20T10:00:01Z", run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 1 }),
      JSON.stringify({ ts: "2026-07-20T10:01:00Z", run_id: "r2", task_id: "W1-T2", step: "pr.opened", pr_url: prUrl2 }),
      JSON.stringify({ ts: "2026-07-20T10:01:01Z", run_id: "r2", task_id: "W1-T2", step: "verdict", verdict: "merged", cost_usd: 2 }),
    ].join("\n") + "\n",
  );
  // A fixture that violates the documented fail-soft contract on purpose -- exactly the shape a
  // malfunctioning/misconfigured real gateway could produce (an uncaught error propagating out of
  // `execFileSync`'s wrapper, say) -- this must degrade the SAME as a well-behaved failed read,
  // never take the whole /v1/recent computation down with it.
  const throwingGithub: GitHub = {
    prByRef: () => {
      throw new Error("boom: simulated gateway crash, not a fail-soft null");
    },
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
  const entries = computeRecentActivity({ plan, ledgerPath, github: throwingGithub }, createRecentActivityCache());
  assert.equal(entries.length, 2, "both rows still render despite the throwing gateway");
  assert.ok(entries.every((e) => e.prTitle === undefined));
  assert.ok(entries.every((e) => e.githubUnavailable === true));
});

test("W1-T184: a gateway that throws from readFailed() ITSELF (not merely prByRef) still degrades one row, never drops it — the empty-RECENT fixture must not reproduce via a crash in the health check", () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-T1", title: "a task" }), task({ id: "W1-T2", title: "another task" })]);
  const prUrl1 = "https://github.com/o/r/pull/1";
  const prUrl2 = "https://github.com/o/r/pull/2";
  appendFileSync(
    ledgerPath,
    [
      JSON.stringify({ ts: "2026-07-20T10:00:00Z", run_id: "r1", task_id: "W1-T1", step: "pr.opened", pr_url: prUrl1 }),
      JSON.stringify({ ts: "2026-07-20T10:00:01Z", run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 1 }),
      JSON.stringify({ ts: "2026-07-20T10:01:00Z", run_id: "r2", task_id: "W1-T2", step: "pr.opened", pr_url: prUrl2 }),
      JSON.stringify({ ts: "2026-07-20T10:01:01Z", run_id: "r2", task_id: "W1-T2", step: "verdict", verdict: "merged", cost_usd: 2 }),
    ].join("\n") + "\n",
  );
  // prByRef fail-soft-nulls (a well-behaved "PR not found" answer), but the SEPARATE readFailed()
  // health check itself throws -- a malformed/misconfigured gateway shape that is just as real as
  // the already-covered "prByRef throws" one, and was NOT wrapped by the try/catch that used to
  // sit around prByRef alone.
  const flakyHealthCheck: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => {
      throw new Error("boom: the health check itself is broken");
    },
  };
  const entries = computeRecentActivity({ plan, ledgerPath, github: flakyHealthCheck }, createRecentActivityCache());
  assert.equal(entries.length, 2, "both rows still render despite the throwing readFailed()");
  assert.ok(entries.every((e) => e.githubUnavailable === true), "degrades exactly like a well-behaved failed read");
});

test("W1-T184: GET /v1/recent never 500s when readFailed() throws — reachable through the real assembled route, not just the pure function", async () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-T1", title: "a task" })]);
  const prUrl = "https://github.com/o/r/pull/1";
  appendFileSync(
    ledgerPath,
    [
      JSON.stringify({ ts: "2026-07-20T10:00:00Z", run_id: "r1", task_id: "W1-T1", step: "pr.opened", pr_url: prUrl }),
      JSON.stringify({ ts: "2026-07-20T10:00:01Z", run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 1 }),
    ].join("\n") + "\n",
  );
  const flakyHealthCheck: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => {
      throw new Error("boom: the health check itself is broken");
    },
  };
  const deps: BoardDeps = { plan, ledgerPath, github: flakyHealthCheck };
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: [buildRecentRoute(deps)] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/v1/recent`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 200, "a broken health check must never 500 the request — that would empty the feed exactly like FIXTURE 1");
    const body = (await res.json()) as { entries: Array<{ githubUnavailable?: boolean }> };
    assert.equal(body.entries.length, 1, "the row still renders, ledger-sourced");
    assert.equal(body.entries[0]!.githubUnavailable, true);
  } finally {
    server.close();
  }
});

test("W1-T184: the activity feed tails the ledger — a render never re-decorates (re-fetches GitHub for) an already-seen line, only the new ones", () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-T1", title: "t1" }), task({ id: "W1-T2", title: "t2" })]);
  let calls = 0;
  const prUrl = "https://github.com/o/r/pull/1";
  const github: GitHub = {
    prByRef: (ref) => {
      calls++;
      return String(ref) === prUrl ? { number: 1, url: prUrl, state: "MERGED" } : null;
    },
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
  const deps: BoardDeps = { plan, ledgerPath, github };
  const cache = createRecentActivityCache();

  appendFileSync(
    ledgerPath,
    [
      JSON.stringify({ ts: "2026-07-20T10:00:00Z", run_id: "r1", task_id: "W1-T1", step: "pr.opened", pr_url: prUrl }),
      JSON.stringify({ ts: "2026-07-20T10:00:01Z", run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 1 }),
    ].join("\n") + "\n",
  );
  computeRecentActivity(deps, cache);
  assert.equal(calls, 1, "one PR-decoration call for the one PR-linked row minted so far");
  computeRecentActivity(deps, cache); // re-render, ledger unchanged -> no new lines to classify/decorate
  computeRecentActivity(deps, cache);
  assert.equal(calls, 1, "re-rendering an unchanged ledger must not re-decorate already-minted rows");

  appendFileSync(
    ledgerPath,
    JSON.stringify({ ts: "2026-07-20T10:01:00Z", run_id: "r2", task_id: "W1-T2", step: "implement.done", cost_usd: 0.1, num_turns: 2 }) + "\n",
  );
  computeRecentActivity(deps, cache);
  assert.equal(calls, 1, "a new row with NO prUrl triggers no GitHub call at all");
});

test("W1-T184: computeRecentActivity's underlying ledger read is INCREMENTAL — an unchanged ledger costs no readFileSync/read at all, and a grown one reads only the NEW bytes, never a full re-read of the whole file (the O(history)-per-render performance criterion, proven at the actual fs boundary, not merely the classification layer)", (t) => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-T1", title: "t1" })]);
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub() };
  const cache = createRecentActivityCache();

  // A sizeable BASELINE the ledger already carries before the render loop starts — large enough
  // that "read the whole file again" and "read only the new bytes" are trivially distinguishable
  // by byte count, not just call count. Lines a real task never names ("PAD") so they occupy real
  // file bytes without affecting classification.
  const baseline =
    Array.from({ length: 500 }, (_, i) => JSON.stringify({ ts: "2026-07-20T09:00:00Z", run_id: `pad-${i}`, task_id: "PAD", step: "noop" })).join(
      "\n",
    ) + "\n";
  appendFileSync(ledgerPath, baseline);
  computeRecentActivity(deps, cache); // prime the tail cursor past the baseline

  const readFileSyncSpy = t.mock.method(fs, "readFileSync");
  const readSyncSpy = t.mock.method(fs, "readSync");

  computeRecentActivity(deps, cache); // re-render, ledger UNCHANGED
  assert.equal(readFileSyncSpy.mock.calls.length, 0, "an unchanged ledger must never call the whole-file reader");
  assert.equal(readSyncSpy.mock.calls.length, 0, "an unchanged ledger costs one statSync, not a read");

  appendFileSync(
    ledgerPath,
    JSON.stringify({ ts: "2026-07-20T10:00:00Z", run_id: "r1", task_id: "W1-T1", step: "implement.done", cost_usd: 0.1, num_turns: 2 }) + "\n",
  );
  const entries = computeRecentActivity(deps, cache);
  assert.equal(entries.length, 1);
  assert.equal(readFileSyncSpy.mock.calls.length, 0, "growth is read via the incremental byte-range reader, never the whole-file reader");
  assert.equal(readSyncSpy.mock.calls.length, 1, "exactly one incremental read for the one grown chunk");
  const length = (readSyncSpy.mock.calls[0]!.arguments as unknown[])[3] as number; // fs.readSync(fd, buffer, offset, length, position)
  assert.ok(length < baseline.length, "the incremental read pulls only the NEW bytes, nowhere near the whole (500-line) baseline");
});

test("W1-T184: NOW rows carry LIVE accumulated spend/turns, summed from implement.done/fix.done lines of the task's CURRENT run, ticking as more lines land", () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-T1" })]);
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub(), now: () => Date.parse("2026-07-20T10:10:00Z") };

  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T10:00:00Z", run_id: "r1", task_id: "W1-T1", step: "run.start" }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T10:01:00Z", run_id: "r1", task_id: "W1-T1", step: "implement.done", cost_usd: 1.24, num_turns: 38 }) + "\n");
  // a mid-run running-total line (budget.warning) must NOT be double-counted into the sum.
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T10:01:30Z", run_id: "r1", task_id: "W1-T1", step: "budget.warning", cost_usd: 1.24 }) + "\n");

  let row = computeBoardSnapshot(deps).tasks.find((t) => t.taskId === "W1-T1")!;
  assert.equal(row.phase, "review"); // deriveRunState: implement.done advances the phase to "review"
  assert.equal(row.liveSpendUsd, 1.24);
  assert.equal(row.liveTurns, 38);

  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T10:02:00Z", run_id: "r1", task_id: "W1-T1", step: "fix.done", strike: 1, cost_usd: 1.3, num_turns: 38 }) + "\n");
  row = computeBoardSnapshot(deps).tasks.find((t) => t.taskId === "W1-T1")!;
  assert.equal(row.liveSpendUsd, 2.54, "ticks upward as further lines are appended (the FIXTURE 2 shape: ~2.54 USD total)");
  assert.equal(row.liveTurns, 76);
});

test("W1-T184: live spend/turns accumulate a COLD fix-rung dispatch's cost too, even though its fix.dispatch/fix.done lines carry the SWEEP/FIX invocation's OWN pseudo run_id, not the task's original run.start run_id (the real PR #388/#398 post-merge-review-fix shape: run-task.ts's buildSweepEffects stamps task_id: task.id but run_id: `SWEEP-<ts>`/`FIX-<ts>`)", () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-T1" })]);
  // Fixed `now` close to every ledger ts below (W1-T179's liveness bound is 30 minutes) — same
  // discipline the "NOW rows carry LIVE accumulated spend/turns" test above already uses, so an
  // in-flight ledger-only trace with no open PR still renders `running`/`phase`, not `orphaned`.
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub(), now: () => Date.parse("2026-07-20T22:10:00Z") };

  // The ORIGINAL `rmd run-task` attempt: run.start under its own run_id, an implement.done, then
  // a failing review leaves the task in-flight with no verdict yet (the process has since exited
  // — this is exactly the "PR discovered cold on a poll" shape sweep/fix pick up afterward).
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T22:00:00Z", run_id: "r1", task_id: "W1-T1", step: "run.start" }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T22:01:00Z", run_id: "r1", task_id: "W1-T1", step: "implement.done", cost_usd: 0, num_turns: 0 }) + "\n");

  // `rmd sweep`'s cold dispatchFix (run-task.ts buildSweepEffects): the OUTER log stamps every
  // line with the sweep invocation's OWN run_id ("SWEEP-<ts>") but overrides task_id to the REAL
  // task — see run-task.ts's own comment: "`fix.dispatch`/`fix.review` lines need the REAL task
  // id ... `extra`'s own `task_id` wins over the outer default". No fresh run.start is logged for
  // this dispatch (dispatchFix calls runFixRung directly, never runTask) — deriveRunState's own
  // task_id-keyed scan (never run_id-keyed) is exactly why the task still renders phase:
  // "fix-rung" here; liveRunSpend must track that SAME rule, not a narrower run_id match.
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T22:02:00Z", run_id: "SWEEP-1784000000000", task_id: "W1-T1", step: "fix.dispatch", strike: 1 }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T22:03:00Z", run_id: "SWEEP-1784000000000", task_id: "W1-T1", step: "fix.done", strike: 1, cost_usd: 1.24, num_turns: 38 }) + "\n");

  let row = computeBoardSnapshot(deps).tasks.find((t) => t.taskId === "W1-T1")!;
  assert.equal(row.phase, "fix-rung");
  assert.equal(row.liveSpendUsd, 1.24, "the cold fix-rung's spend must not be invisible just because its run_id differs from run.start's");
  assert.equal(row.liveTurns, 38);

  // A second cold dispatch (`rmd fix`, a different pseudo run_id again) piles onto the SAME total.
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T22:04:00Z", run_id: "FIX-1784100000000", task_id: "W1-T1", step: "fix.dispatch", strike: 2 }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T22:05:00Z", run_id: "FIX-1784100000000", task_id: "W1-T1", step: "fix.done", strike: 2, cost_usd: 1.3, num_turns: 38 }) + "\n");
  row = computeBoardSnapshot(deps).tasks.find((t) => t.taskId === "W1-T1")!;
  assert.equal(row.liveSpendUsd, 2.54, "tonight's post-merge-review burn: ~1.24 USD/38 turns then ~1.30 USD/38 turns, ~2.54 USD total");
  assert.equal(row.liveTurns, 76);
});

test("W1-T184: a terminal (non-in-flight) task never carries liveSpendUsd/liveTurns — those are a NOW-only, in-flight concept", () => {
  const ledgerPath = tmpLedgerPath();
  const prUrl = "https://github.com/o/r/pull/1";
  const plan = planOf([task({ id: "W1-T1" })]);
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T10:00:00Z", run_id: "r1", task_id: "W1-T1", step: "run.start" }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T10:00:30Z", run_id: "r1", task_id: "W1-T1", step: "implement.done", cost_usd: 1, num_turns: 10 }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T10:01:00Z", run_id: "r1", task_id: "W1-T1", step: "pr.opened", pr_url: prUrl }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T10:01:01Z", run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 1 }) + "\n");
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub({ [prUrl]: { number: 1, url: prUrl, state: "MERGED" } }) };

  const row = computeBoardSnapshot(deps).tasks.find((t) => t.taskId === "W1-T1")!;
  assert.equal(row.status, "merged");
  assert.equal(row.phase, undefined);
  assert.equal(row.liveSpendUsd, undefined);
  assert.equal(row.liveTurns, undefined);
});

test("W1-T184: createBoardSnapshotCache recomputes ONLY when the ledger has grown — an unchanged ledger across repeated/'concurrent' calls triggers no re-projection", () => {
  const ledgerPath = tmpLedgerPath();
  writeFileSync(ledgerPath, "");
  const prUrl = "https://github.com/o/r/pull/1";
  let calls = 0;
  const github: GitHub = {
    prByRef: (ref) => {
      calls++;
      return String(ref) === "1" ? { number: 1, url: prUrl, state: "OPEN" } : null;
    },
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
  // rung (b), `task.pr` -- forces a prByRef call on EVERY derivation, so `calls` is a direct
  // proxy for "did a real recompute happen" (a cache hit calls github zero times).
  const plan = planOf([task({ id: "W1-T1", pr: 1 })]);
  const deps: BoardDeps = { plan, ledgerPath, github };
  const cache = createBoardSnapshotCache();

  cache.get(deps);
  assert.equal(calls, 1);
  // Node's real GitHub gateways shell `gh` synchronously (execFileSync), blocking the ONE event
  // loop thread for the whole call -- so N calls arriving in a burst before the ledger changes
  // (simulated here as N synchronous calls in a row) can never trigger more than the one
  // recompute the first call already performed; every one of these is a cache hit.
  cache.get(deps);
  cache.get(deps);
  cache.get(deps);
  assert.equal(calls, 1, "unchanged ledger across repeated/'concurrent' calls -> exactly one recompute");

  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "run.start" }) + "\n");
  cache.get(deps);
  assert.equal(calls, 2, "the ledger grew -> exactly one fresh recompute");
  cache.get(deps);
  assert.equal(calls, 2, "and it settles back to a cache hit once the new length is captured");
});

test("W1-T184: createBoardSnapshotCache holds ACROSS MANY poll ticks over real wall-clock time (not merely a burst) — the cache is NOT time/TTL-based", async () => {
  const ledgerPath = tmpLedgerPath();
  writeFileSync(ledgerPath, "");
  let calls = 0;
  const github: GitHub = {
    prByRef: () => {
      calls++;
      return null;
    },
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
  const plan = planOf([task({ id: "W1-T1", pr: 1 })]);
  const deps: BoardDeps = { plan, ledgerPath, github };
  const cache = createBoardSnapshotCache();

  cache.get(deps);
  assert.equal(calls, 1);
  // Poll at the SAME DEFAULT_POLL_MS cadence the SSE stream uses, for several ticks' worth of
  // real elapsed time -- a clock/TTL-based cache set anywhere near that cadence would expire
  // and recompute on almost every one of these; a cache with NO time dimension at all does not.
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_MS));
    cache.get(deps);
  }
  assert.equal(calls, 1, "an unchanged ledger triggers no re-projection no matter how much real time elapses");
});

test("W1-T184: createBoardSnapshotCache recomputes the instant GitHub's OWN observable health flips — even with the ledger completely untouched", () => {
  const ledgerPath = tmpLedgerPath();
  writeFileSync(ledgerPath, "");
  const ghState = { failed: true };
  let calls = 0;
  const github: GitHub = {
    prByRef: () => {
      calls++;
      return null;
    },
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => ghState.failed,
    readFailureReason: () => "transport",
  };
  const plan = planOf([task({ id: "W1-T1", pr: 1 })]);
  const deps: BoardDeps = { plan, ledgerPath, github };
  const cache = createBoardSnapshotCache();

  cache.get(deps);
  assert.equal(calls, 1);
  cache.get(deps);
  cache.get(deps);
  assert.equal(calls, 1, "readFailed() unchanged (still true) -> cache hits, ledger untouched throughout");

  ghState.failed = false; // GitHub recovers -- no ledger write at all.
  cache.get(deps);
  assert.equal(calls, 2, "GitHub's own health flipped -> exactly one fresh recompute, with no ledger change to key off");
  cache.get(deps);
  assert.equal(calls, 2, "and it settles back to a cache hit once the new health reading is captured");
});

test("W1-T184: createBoardSnapshotCache's cache-KEY check is itself INCREMENTAL — a cache HIT costs one statSync, never a full readFileSync of the whole ledger, however large it has grown. This is the fix for the 2026-07-20 GET /v1/status outage (58.7s/54.0s/34.5s, no warm improvement): memoizing the EXPENSIVE projectPlan/gh work was not enough while computing the cache key still paid a full re-read+re-parse of the whole file on every single poll tick", (t) => {
  const ledgerPath = tmpLedgerPath();
  writeFileSync(ledgerPath, "");
  const plan = planOf([task({ id: "W1-T1" })]);
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub() };
  const cache = createBoardSnapshotCache();

  // A sizeable ledger BEFORE the poll loop starts -- large enough to make "full re-read" and
  // "one statSync" trivially distinguishable.
  const baseline =
    Array.from({ length: 500 }, (_, i) => JSON.stringify({ ts: "2026-07-20T09:00:00Z", run_id: `pad-${i}`, task_id: "PAD", step: "noop" })).join(
      "\n",
    ) + "\n";
  appendFileSync(ledgerPath, baseline);
  cache.get(deps); // prime

  const readFileSyncSpy = t.mock.method(fs, "readFileSync");
  const readSyncSpy = t.mock.method(fs, "readSync");

  // "N concurrent requests" simulated as N synchronous calls in a row (Node's single event-loop
  // thread makes true interleaving impossible while a synchronous handler runs — see
  // createBoardSnapshotCache's own doc) -- every one of these must be a cheap cache hit.
  cache.get(deps);
  cache.get(deps);
  cache.get(deps);
  assert.equal(readFileSyncSpy.mock.calls.length, 0, "N repeated/'concurrent' cache hits must never fall back to a full-file read");
  assert.equal(readSyncSpy.mock.calls.length, 0, "and must cost nothing beyond the statSync already inside a cache-hit ledgerLen check");

  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-07-20T10:00:00Z", run_id: "r1", task_id: "W1-T1", step: "run.start" }) + "\n");
  cache.get(deps);
  assert.equal(readFileSyncSpy.mock.calls.length, 0, "even a genuine recompute reads the ledger incrementally, never the whole file again");
  assert.ok(readSyncSpy.mock.calls.length >= 1, "the grown tail is pulled via the incremental byte-range reader");
});

test("GET /v1/recent: reachable through the real assembled route (not just the pure function), still ledger-first", async () => {
  const ledgerPath = tmpLedgerPath();
  const plan = planOf([task({ id: "W1-T1", title: "a task" })]);
  const prUrl = "https://github.com/o/r/pull/1";
  appendFileSync(
    ledgerPath,
    [
      JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "pr.opened", pr_url: prUrl }),
      JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 2 }),
    ].join("\n") + "\n",
  );
  const deps: BoardDeps = { plan, ledgerPath, github: fakeGitHub({ [prUrl]: { number: 1, url: prUrl, state: "MERGED" } }) };
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: [buildRecentRoute(deps)] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/recent`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
    assert.deepEqual(body.entries, [
      { taskId: "W1-T1", verb: "merged", detail: "merged", title: "a task", costUsd: 2, prUrl, prNumber: 1, ts: body.entries[0]!.ts },
    ]);
  } finally {
    server.close();
  }
});
