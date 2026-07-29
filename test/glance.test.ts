import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import {
  buildGlanceRoute,
  computeDaemonHeartbeat,
  computeGlanceAnomalies,
  computeGlanceCounts,
  computeGlanceSnapshot,
  createProbeCache,
  readDiskFreeBytes,
  readGithubRateLimitRemaining,
  type GlanceDeps,
} from "../src/lib/glance.js";
import { DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS } from "../src/lib/serve.js";
import { deriveWeekCostUsd, startOfUtcWeekIso } from "../src/lib/sweep.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { BoardRow } from "../src/lib/board.js";
import type { GitHub, PrRef } from "../src/lib/status.js";

// ── W1-T159 GLANCE layer — a pinned summary strip (running/needs-me/blocked/queued/
// merged-today/spend-today), a daemon-health widget, and a browser-tab needs-me badge.
//
// This file proves the SERVER side: every strip number traces to a NAMED source (criterion 1,
// with a falsifier proving it is not hardcoded), spend-this-week beside spend-today (criterion
// 2), anomaly emphasis for a phase-threshold breach and a stale (>24h) needs-me item (criterion
// 3), and the daemon-health widget's four fields each from a real source (criterion 5). The
// browser-tab-badge criterion (4) is proven in test/board.test.ts (the SSE `needs-human` event
// itself) — this file only proves the counts that event's payload must match.

const READ_TOKEN = "glance-read-token";
const WRITE_TOKEN = "glance-write-token";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
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
  const dir = mkdtempSync(join(tmpdir(), "rmd-glance-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

const TODAY = Date.parse("2026-07-29T18:00:00.000Z"); // a Wednesday — mid-week, so week != day

function baseDeps(over: Partial<GlanceDeps> = {}): GlanceDeps {
  return {
    plan: planOf([task({ id: "W1-T1" })]),
    ledgerPath: tmpLedgerPath(),
    github: fakeGitHub(),
    phaseElapsedThresholdsMs: DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS,
    execFile: () => {
      throw new Error("no gh in this fixture");
    },
    statfs: () => {
      throw new Error("no statfs in this fixture");
    },
    ...over,
  };
}

// ── criterion 1: TRACEABILITY, with a falsifier ─────────────────────────────────────────────

test("computeGlanceCounts: running/needsMe/blocked/queued derive from the SAME taxonomy fields W1-T155 already computes — changing the input tasks changes the output (the falsifier: a hardcoded number could never do this)", () => {
  const lines: Record<string, unknown>[] = [];
  const tasksA = [
    { taskId: "A", phase: "implement", status: "running", needsHuman: undefined } as unknown as BoardRow,
    { taskId: "B", phase: undefined, status: "blocked", needsHuman: undefined } as unknown as BoardRow,
    { taskId: "C", phase: undefined, status: "queued", needsHuman: undefined } as unknown as BoardRow,
    { taskId: "D", phase: undefined, status: "queued", needsHuman: true } as unknown as BoardRow,
  ];
  const countsA = computeGlanceCounts(tasksA, lines, TODAY, true);
  assert.deepEqual(
    { running: countsA.running, needsMe: countsA.needsMe, blocked: countsA.blocked, queued: countsA.queued },
    { running: 1, needsMe: 1, blocked: 1, queued: 2 },
  );

  // FALSIFIER: flip ONE task's taxonomy fields and the counts must move accordingly — a
  // hardcoded/decorative number would stay frozen no matter what the input says.
  const tasksB = [...tasksA, { taskId: "E", phase: "review", status: "running", needsHuman: undefined } as unknown as BoardRow];
  const countsB = computeGlanceCounts(tasksB, lines, TODAY, true);
  assert.equal(countsB.running, 2, "adding a second in-flight row must move the running count");
  assert.equal(countsB.total, 5);
});

test("computeGlanceCounts: mergedToday is traceable to ledger verdict=merged lines dated TODAY's UTC calendar day — a merge yesterday, or a non-merge verdict today, does not count", () => {
  const lines = [
    { ts: "2026-07-28T23:59:00.000Z", run_id: "r0", task_id: "OLD", step: "verdict", verdict: "merged" }, // yesterday
    { ts: "2026-07-29T09:00:00.000Z", run_id: "r1", task_id: "A", step: "verdict", verdict: "merged" },
    { ts: "2026-07-29T10:00:00.000Z", run_id: "r2", task_id: "B", step: "verdict", verdict: "blocked_review" }, // not a merge
    { ts: "2026-07-29T11:00:00.000Z", run_id: "r3", task_id: "A", step: "verdict", verdict: "merged" }, // same task again — distinct count, not double
  ];
  const counts = computeGlanceCounts([], lines, TODAY, true);
  assert.equal(counts.mergedToday, 1, "only task A has a merge dated today (yesterday's OLD, and B's non-merge verdict, are excluded); A's second merge line is the SAME task id, deduped to one");
});

test("computeGlanceCounts: taxonomy_known mirrors board.ts's merged_known convention — false during a GitHub outage, never silently 0-as-fact", () => {
  const counts = computeGlanceCounts([], [], TODAY, false);
  assert.equal(counts.taxonomy_known, false);
});

// ── criterion 2: spend-today AND spend-this-week, both ledger-cost_usd-traceable ────────────

test("deriveWeekCostUsd: sums the SAME per-run dedup as deriveDayCostUsd, but across the whole UTC week-to-date, not just today", () => {
  const mondayIso = startOfUtcWeekIso(TODAY);
  assert.match(mondayIso, /^2026-07-27T00:00:00\.000Z$/, "2026-07-29 is a Wednesday; that week's Monday is 2026-07-27");

  const lines = [
    // last week — must NOT bleed into this week's total.
    { ts: "2026-07-20T10:00:00.000Z", run_id: "LASTWEEK", task_id: "W1-TY", step: "verdict", cost_usd: 999 },
    // earlier THIS week (Monday) — counts.
    { ts: "2026-07-27T08:00:00.000Z", run_id: "MON", task_id: "W1-T1", step: "verdict", cost_usd: 2 },
    // today, before `now` — counts.
    { ts: "2026-07-29T09:00:00.000Z", run_id: "TODAY1", task_id: "W1-T2", step: "verdict", cost_usd: 5 },
    // AFTER `now` (the future, relative to the TODAY fixture instant) — must not count.
    { ts: "2026-07-29T23:00:00.000Z", run_id: "FUTURE", task_id: "W1-T3", step: "verdict", cost_usd: 777 },
  ];
  assert.equal(deriveWeekCostUsd(lines, TODAY), 7, "Monday's $2 + today's $5 = $7 — last week's $999 and the future $777 excluded");
});

test("computeGlanceSnapshot: spend.todayUsd and spend.weekUsd both derive from the SAME ledger cost_usd lines W1-T148 already reads — a week total is never less than the day total it contains", () => {
  const ledgerPath = tmpLedgerPath();
  appendFileSync(
    ledgerPath,
    [
      JSON.stringify({ ts: "2026-07-27T08:00:00.000Z", run_id: "MON", task_id: "W1-T1", step: "verdict", cost_usd: 2 }),
      JSON.stringify({ ts: "2026-07-29T09:00:00.000Z", run_id: "TODAY1", task_id: "W1-T2", step: "verdict", cost_usd: 2.54 }),
    ].join("\n") + "\n",
  );
  const snap = computeGlanceSnapshot(baseDeps({ ledgerPath }), TODAY);
  assert.equal(snap.spend.todayUsd, 2.54);
  assert.equal(snap.spend.weekUsd, 4.54, "the week figure includes Monday's $2 PLUS today's $2.54");
  assert.ok(
    snap.spend.weekUsd >= snap.spend.todayUsd,
    "FALSIFIER GUARD: a week-to-date total can never read lower than the day it contains — the W1-T159 design note's whole point (today's $2.54 burn 'looked unremarkable in isolation')",
  );
});

// ── criterion 3: ANOMALY EMPHASIS — a phase-threshold breach, and a stale (>24h) needs-me item ──

test("computeGlanceAnomalies: an in-flight row past ITS OWN phase's elapsed threshold is flagged — a row still under threshold is not", () => {
  const thresholds = { implement: 90 * 60 * 1000, default: 60 * 60 * 1000 };
  const rows = [
    // W1-T1 sat in NOW at 27h21m (the task's own falsifier fixture) — a "recon"-less phase name
    // falls back to `default` (60m); 27h21m is WAY past it.
    { taskId: "W1-T1", phase: "implement", elapsedMs: 27 * 60 * 60 * 1000 + 21 * 60 * 1000, needsHuman: undefined } as unknown as BoardRow,
    { taskId: "W1-T2", phase: "implement", elapsedMs: 10 * 60 * 1000, needsHuman: undefined } as unknown as BoardRow, // well under threshold
    { taskId: "W1-T3", phase: undefined, elapsedMs: undefined, needsHuman: undefined } as unknown as BoardRow, // not in flight at all
  ];
  const anomalies = computeGlanceAnomalies(rows, [], TODAY, thresholds);
  assert.deepEqual(anomalies.phaseBreachTaskIds, ["W1-T1"]);
  assert.equal(anomalies.hasAnomaly, true);
});

test("computeGlanceAnomalies: a needs-me item whose escalation opened over 24h ago is flagged stale; one opened 1h ago is not (both from the SAME escalation.issue_opened ledger line)", () => {
  const lines = [
    // W1-T1: opened 30 hours before `now` -- stale.
    { ts: "2026-07-28T12:00:00.000Z", run_id: "r1", task_id: "W1-T1", step: "escalation.issue_opened", class: "BLOCKED", issue_url: "u1" },
    // W1-T2: opened 1 hour before `now` -- fresh, not stale.
    { ts: "2026-07-29T17:00:00.000Z", run_id: "r2", task_id: "W1-T2", step: "escalation.issue_opened", class: "BLOCKED", issue_url: "u2" },
  ];
  const rows = [
    { taskId: "W1-T1", phase: undefined, elapsedMs: undefined, needsHuman: true } as unknown as BoardRow,
    { taskId: "W1-T2", phase: undefined, elapsedMs: undefined, needsHuman: true } as unknown as BoardRow,
    { taskId: "W1-T3", phase: undefined, elapsedMs: undefined, needsHuman: undefined } as unknown as BoardRow, // not needs-me at all
  ];
  const anomalies = computeGlanceAnomalies(rows, lines, TODAY, DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS);
  assert.deepEqual(anomalies.staleNeedsMeTaskIds, ["W1-T1"]);
  assert.equal(anomalies.hasAnomaly, true);
});

test("computeGlanceAnomalies: hasAnomaly is false, and both lists empty, on an entirely ordinary fleet (the falsifier's inverse — never a permanently-on banner)", () => {
  const rows = [{ taskId: "W1-T1", phase: "implement", elapsedMs: 5000, needsHuman: undefined } as unknown as BoardRow];
  const anomalies = computeGlanceAnomalies(rows, [], TODAY, DEFAULT_PHASE_ELAPSED_THRESHOLDS_MS);
  assert.deepEqual(anomalies, { phaseBreachTaskIds: [], staleNeedsMeTaskIds: [], hasAnomaly: false });
});

// ── criterion 5: the daemon-health widget's four fields, each from its own named source ─────

test("computeDaemonHeartbeat: last-poll + poll-interval come from the daemon's OWN most recent heartbeat ledger line, never a placeholder", () => {
  const lines = [
    { ts: "2026-07-29T17:58:00.000Z", run_id: "DAEMON", task_id: "DAEMON", step: "daemon.idle", tick: 10, poll_interval_ms: 60000 },
    { ts: "2026-07-29T17:59:00.000Z", run_id: "DAEMON", task_id: "DAEMON", step: "daemon.idle", tick: 11, poll_interval_ms: 60000 },
  ];
  const hb = computeDaemonHeartbeat(lines);
  assert.equal(hb.lastPollAt, "2026-07-29T17:59:00.000Z", "the LATEST heartbeat line, not the first");
  assert.equal(hb.pollIntervalMs, 60000);
});

test("computeDaemonHeartbeat: an empty ledger (no daemon heartbeat yet) reports undefined, never a fabricated timestamp", () => {
  const hb = computeDaemonHeartbeat([]);
  assert.equal(hb.lastPollAt, undefined);
  assert.equal(hb.pollIntervalMs, undefined);
});

test("computeGlanceSnapshot: daemonHealth.nextPollEta is lastPollAt + pollIntervalMs — a real, computable ETA, not a decorative countdown", () => {
  const ledgerPath = tmpLedgerPath();
  appendFileSync(
    ledgerPath,
    JSON.stringify({ ts: "2026-07-29T17:59:00.000Z", run_id: "DAEMON", task_id: "DAEMON", step: "daemon.idle", tick: 1, poll_interval_ms: 60000 }) + "\n",
  );
  const snap = computeGlanceSnapshot(baseDeps({ ledgerPath }), TODAY);
  assert.equal(snap.daemonHealth.lastPollAt, "2026-07-29T17:59:00.000Z");
  assert.equal(snap.daemonHealth.pollIntervalMs, 60000);
  assert.equal(snap.daemonHealth.nextPollEta, "2026-07-29T18:00:00.000Z");
});

test("readDiskFreeBytes: a real statfs read reports bavail*bsize; a failing read fails soft to undefined, never a fabricated number", () => {
  const ok = readDiskFreeBytes("/whatever", (() => ({ bavail: 1000, bsize: 4096 })) as unknown as typeof import("node:fs").statfsSync);
  assert.equal(ok, 1000 * 4096);
  const failed = readDiskFreeBytes("/whatever", (() => {
    throw new Error("ENOENT");
  }) as unknown as typeof import("node:fs").statfsSync);
  assert.equal(failed, undefined);
});

test("readGithubRateLimitRemaining: a real gh probe reports the numeric remaining count; a failing probe fails soft to undefined", () => {
  const ok = readGithubRateLimitRemaining((() => "4231\n") as unknown as typeof import("node:child_process").execFileSync);
  assert.equal(ok, 4231);
  const failed = readGithubRateLimitRemaining((() => {
    throw new Error("gh: command not found");
  }) as unknown as typeof import("node:child_process").execFileSync);
  assert.equal(failed, undefined);
});

test("computeGlanceSnapshot: diskFreeBytes and rateLimitRemaining are wired through from the injected statfs/execFile — real sources, not omitted fields", () => {
  const snap = computeGlanceSnapshot(
    baseDeps({
      statfs: (() => ({ bavail: 500, bsize: 4096 })) as unknown as typeof import("node:fs").statfsSync,
      execFile: (() => "7000") as unknown as typeof import("node:child_process").execFileSync,
    }),
    TODAY,
  );
  assert.equal(snap.daemonHealth.diskFreeBytes, 500 * 4096);
  assert.equal(snap.daemonHealth.rateLimitRemaining, 7000);
});

// ── GET /v1/glance: reachable through a real assembled server, cache-fronted ────────────────

async function withGlanceService<T>(deps: GlanceDeps, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: [buildGlanceRoute(deps)] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("GET /v1/glance: read-scoped, matches computeGlanceSnapshot's shape end-to-end", async () => {
  const ledgerPath = tmpLedgerPath();
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "verdict", cost_usd: 1 }) + "\n");
  await withGlanceService(baseDeps({ ledgerPath }), async (base) => {
    const res = await fetch(`${base}/v1/glance`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { counts: unknown; spend: { todayUsd: number }; anomalies: unknown; daemonHealth: unknown };
    assert.ok(body.counts && body.spend && body.anomalies && body.daemonHealth, "every strip section must be present");
    assert.equal(body.spend.todayUsd, 1);
  });
});

test("GET /v1/glance: no bearer token -> 401, same as every other read route on this surface", async () => {
  await withGlanceService(baseDeps(), async (base) => {
    const res = await fetch(`${base}/v1/glance`);
    assert.equal(res.status, 401);
  });
});

test("createProbeCache: repeat gets within the TTL return the SAME probed disk/rate-limit values (no re-shelling to gh/statfs on every poll); a get past the TTL recomputes", () => {
  let execCalls = 0;
  const exec = (() => {
    execCalls++;
    return "1000";
  }) as unknown as typeof import("node:child_process").execFileSync;
  const statfs = (() => ({ bavail: 1, bsize: 1 })) as unknown as typeof import("node:fs").statfsSync;
  const cache = createProbeCache(1000);
  cache.get(exec, statfs, "/whatever", 1000);
  cache.get(exec, statfs, "/whatever", 1500); // within the 1000ms TTL -> cache hit, no new exec call
  assert.equal(execCalls, 1);
  cache.get(exec, statfs, "/whatever", 3000); // past the TTL -> recompute
  assert.equal(execCalls, 2);
});

test("GET /v1/glance: a ledger change (a fresh escalation) is reflected on the VERY NEXT request — counts/anomalies are never held back by the probe cache (the fix for a stale needs-me count fighting the faster SSE needs-human event)", async () => {
  const ledgerPath = tmpLedgerPath();
  const issueUrl = "https://github.com/o/r/issues/1";
  const github: GitHub = { ...fakeGitHub(), issueByUrl: (url) => (url === issueUrl ? { state: "OPEN", title: "x" } : null) };
  await withGlanceService(baseDeps({ ledgerPath, plan: planOf([task({ id: "W1-T1" })]), github }), async (base) => {
    const before = (await (await fetch(`${base}/v1/glance`, { headers: { authorization: `Bearer ${READ_TOKEN}` } })).json()) as {
      counts: { needsMe: number };
    };
    assert.equal(before.counts.needsMe, 0);

    appendFileSync(
      ledgerPath,
      JSON.stringify({ ts: new Date().toISOString(), run_id: "r1", task_id: "W1-T1", step: "escalation.issue_opened", issue_url: issueUrl, class: "BLOCKED" }) + "\n",
    );
    const after = (await (await fetch(`${base}/v1/glance`, { headers: { authorization: `Bearer ${READ_TOKEN}` } })).json()) as {
      counts: { needsMe: number };
    };
    assert.equal(after.counts.needsMe, 1, "the very next poll must see the fresh ledger state, not a cached stale count");
  });
});
