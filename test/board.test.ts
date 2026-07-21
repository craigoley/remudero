import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
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
