import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import { escalateHeadroomReserve } from "../src/run-task.js";
import { HEADROOM_LIMIT_PCT, type UsageSnapshot } from "../src/lib/headroom.js";
import { runDaemon, type DaemonDeps, type HeadroomPolicy } from "../src/lib/daemon.js";

/**
 * P34 clause (c), W1-T249 — "budget is subscription HEADROOM, not dollars". These
 * four tests are this task's own named acceptance proof, one per claim. THE
 * MECHANISM ITSELF (the in-process idle heartbeat, the time-aware policy curve,
 * the bounded-degraded unreadable posture) is W1-T197's and is already proven
 * exhaustively in test/daemon.test.ts — this file does not re-derive it. What is
 * NEW here is the reserve gate's own vantage point on that mechanism (imputed
 * dollars are irrelevant to it) and the escalation it fires, which W1-T197 never
 * built (see `onHeadroomBreach`/`escalateHeadroomReserve`, lib/daemon.ts +
 * run-task.ts).
 */

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: b
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: C
  title: c
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "headroom-reserve-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string, costUsd: number): RunResult => ({
  taskId: id,
  runId: id + "-run",
  merged: true,
  costUsd,
  verdict: "merged",
});

/** Far from any reset — the time-aware curve holds at the plain reserve throughout. */
const FAR_FROM_RESET = () => new Date(2026, 6, 20, 12, 0, 0, 0); // Mon 2026-07-20 noon, 8 days from resets_at below

function snapshotAt(percentUsed: number): UsageSnapshot {
  return {
    billingMode: "subscription",
    session: { percentUsed: 10, resetsAt: "x" },
    weekly: [{ label: "all models", percentUsed, resetsAt: "Jul 28 at 12am" }],
  };
}

// ── claim 1: above the reserve, dispatch continues; imputed dollars gate nothing ──

test("W1-T249 claim 1: weekly headroom ABOVE the operator reserve — dispatch continues regardless of the imputed ledger dollar figure", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  // A deliberately huge notional cost on every run — if the gate ever consulted
  // dollars, a run this expensive would be exactly the shape that should trip it.
  // It must not, because P34 clause (c) reads the WEEKLY WINDOW ONLY.
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      merged.add(id);
      return okResult(id, 999_999.99);
    },
    readUsage: () => snapshotAt(40), // well below HEADROOM_LIMIT_PCT
    now: FAR_FROM_RESET,
    sleep: async () => {},
  }, { max: 3 });
  assert.equal(s.stopReason, "max_reached", "dispatch proceeded to its bound — nothing paused it");
  assert.equal(s.merged.length, 3, "every task dispatched despite each run reporting an enormous imputed cost");
  assert.ok(s.costUsd > 900_000, "the imputed dollar total is real in the summary, but it never gated dispatch above");
});

// ── claim 2: approaching the reserve pauses dispatch only, and escalates ──────────

test("W1-T249 claim 2: APPROACHING the reserve pauses DISPATCH ONLY — a task already dispatched still finishes, no new one starts, and the breach escalates EXACTLY ONCE", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  let spawned = 0;
  let reads = 0;
  const breaches: Array<{ window: string; percentUsed: number; limitPct: number; resetsAt: string }> = [];
  let sleeps = 0;
  const onHeadroomBreach: DaemonDeps["onHeadroomBreach"] = async (info) => {
    breaches.push(info);
  };
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      spawned++;
      merged.add(id);
      return okResult(id, 0.1);
    },
    // First read is comfortably under the reserve — dispatch proceeds and A
    // merges. Every read after that is AT the reserve ceiling — dispatch must
    // pause from here on, and A's already-completed merge must stand.
    readUsage: () => {
      reads++;
      return reads === 1 ? snapshotAt(40) : snapshotAt(HEADROOM_LIMIT_PCT);
    },
    now: FAR_FROM_RESET,
    onHeadroomBreach,
    sleep: async () => {
      sleeps++;
    },
    checkStop: () => (sleeps >= 4 ? "test done observing the sustained breach" : undefined),
  });
  assert.deepEqual(s.merged, ["A"], "the task dispatched BEFORE the breach finished (in-flight work completes)");
  assert.equal(spawned, 1, "no NEW dispatch happened once the reserve was reached — dispatch only, nothing else halted");
  assert.equal(s.stopReason, "stopped", "the loop kept idling through the sustained breach rather than exiting");
  assert.equal(
    breaches.length,
    1,
    "the breach escalated EXACTLY ONCE for this one sustained episode — never once per idle tick",
  );
  assert.equal(breaches[0].limitPct, HEADROOM_LIMIT_PCT);
  assert.equal(breaches[0].percentUsed, HEADROOM_LIMIT_PCT);
  assert.equal(breaches[0].window, "weekly (all models)");
});

test("W1-T249 claim 2 (a-fortiori): a breach that clears and recurs is a NEW episode — it escalates again", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const breaches: Array<{ resetsAt: string }> = [];
  let reads = 0;
  let sleeps = 0;
  // over, then clear (one dispatch lands), then over again, then sustained.
  const sequence: UsageSnapshot[] = [snapshotAt(HEADROOM_LIMIT_PCT), snapshotAt(10), snapshotAt(HEADROOM_LIMIT_PCT)];
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      merged.add(id);
      return okResult(id, 0);
    },
    readUsage: () => sequence[Math.min(reads++, sequence.length - 1)],
    now: FAR_FROM_RESET,
    onHeadroomBreach: async (info) => {
      breaches.push(info);
    },
    sleep: async () => {
      sleeps++;
    },
    checkStop: () => (sleeps >= 3 ? "test done observing two distinct episodes" : undefined),
  });
  assert.ok(reads >= 3, "the loop observed all three distinct readings");
  assert.deepEqual(s.merged, ["A"], "exactly one dispatch landed, during the brief clear window between the two breaches");
  assert.equal(breaches.length, 2, "the breach fired once for EACH of the two separate episodes, not once total");
});

// ── claim 3: the reserve/ceiling is policy data, overridable with zero code edit ──

test("W1-T249 claim 3: the reserve ceiling is POLICY DATA — a caller-supplied curve retunes it with no source change", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  // 60% is comfortably under the DEFAULT reserve (95%) — with the stock policy
  // this would dispatch freely. A custom curve tightening the hold rung to 50%
  // must pause it instead, proving the ceiling is data threaded through
  // DaemonOpts, never a recompiled constant.
  const tightPolicy: HeadroomPolicy = [{ maxHoursToReset: Infinity, limitPct: 50 }];
  let sleeps = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        merged.add(id);
        return okResult(id, 0.1);
      },
      readUsage: () => snapshotAt(60),
      now: FAR_FROM_RESET,
      sleep: async () => {
        sleeps++;
      },
      checkStop: () => (sleeps >= 2 ? "test done — policy curve holds" : undefined),
    },
    { headroomPolicy: tightPolicy },
  );
  assert.equal(s.merged.length, 0, "the RETUNED ceiling (50%) paused a 60% reading the STOCK reserve (95%) would have allowed");
  assert.ok(sleeps >= 2, "the loop idle-heartbeated under the custom curve, exactly as it does under the default one");
});

// ── claim 4: an unreadable read never silently proceeds as if unlimited ───────────

test("W1-T249 claim 4: an UNREADABLE headroom read does not silently proceed as if unlimited — it caps out at the bounded-degraded posture and stops dispatching", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  let sleeps = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        merged.add(id);
        return okResult(id, 0);
      },
      readUsage: () => undefined, // /usage never comes back readable
      now: FAR_FROM_RESET,
      sleep: async () => {
        sleeps++;
      },
      checkStop: () => (sleeps >= 5 ? "test done — degraded posture holds indefinitely" : undefined),
    },
    { unreadableDegradedLimit: 2 },
  );
  // Within the bounded allowance a handful of tasks may dispatch (recon R-7:
  // an unconditional fail-closed-on-first-miss would halt the fleet most of the
  // time, since /usage is unreadable ~78% of the time in the live ledger) — but
  // it MUST cap out rather than proceed as though the budget were unlimited.
  assert.equal(
    s.merged.length,
    2,
    "exactly the bounded allowance (2 consecutive misses) dispatched, then it capped out — never an unbounded run",
  );
  assert.equal(s.stopReason, "stopped");
  assert.ok(sleeps >= 5, "the loop kept idling (never dispatching again) rather than exiting or proceeding forever");
});

// ── escalateHeadroomReserve: the real onHeadroomBreach wiring (run-task.ts) ───────

test("escalateHeadroomReserve: opens an escalation and durably dedups on resets_at across process boots", () => {
  const dir = mkdtempSync(join(tmpdir(), "headroom-reserve-escalate-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const info = { window: "weekly (all models)", percentUsed: 96, limitPct: HEADROOM_LIMIT_PCT, resetsAt: "Jul 28 at 12am" };

  let calls = 0;
  const fake = {
    create() {
      calls++;
      return "https://github.com/o/r/issues/1";
    },
  };
  escalateHeadroomReserve(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: fake });
  assert.equal(calls, 1, "the first observation of this episode opens an issue");
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const marker = lines.find((l) => l.step === "daemon.headroom_reserve.escalated");
  assert.ok(marker, "a durable dedup marker is written, keyed on this episode's resets_at");
  assert.equal(marker.resets_at, info.resetsAt);
  assert.equal(marker.delivered, true);

  // A FRESH process (a daemon restart) re-observing the SAME still-open window
  // must not re-open a sibling issue.
  escalateHeadroomReserve(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-2", issues: fake });
  assert.equal(calls, 1, "the SAME episode (same resets_at) is deduped across the process restart");

  // Once the window actually resets, resets_at changes — a LATER breach is a
  // NEW episode and must escalate again, never staying silenced by the stale marker.
  escalateHeadroomReserve({ ...info, resetsAt: "Aug 4 at 12am" }, { owner: "o", repo: "r", ledgerPath, runId: "RUN-3", issues: fake });
  assert.equal(calls, 2, "a NEW resets_at is a NEW episode and escalates again");
});

test("escalateHeadroomReserve: a THROWING gh gateway still writes the dedup marker, so the next boot does not retry (mirrors escalateCircuitBreak, W1-T104)", () => {
  const dir = mkdtempSync(join(tmpdir(), "headroom-reserve-escalate-throw-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const info = { window: "weekly (all models)", percentUsed: 97, limitPct: HEADROOM_LIMIT_PCT, resetsAt: "Jul 28 at 12am" };
  const boom = {
    create() {
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  assert.doesNotThrow(() =>
    escalateHeadroomReserve(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: boom }),
  );
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const marker = lines.find((l) => l.step === "daemon.headroom_reserve.escalated");
  assert.ok(marker, "FALSIFIER: pre-fix this class of marker was written only on success");
  assert.equal(marker.delivered, false);

  let calls = 0;
  const counting = {
    create() {
      calls++;
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  escalateHeadroomReserve(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-2", issues: counting });
  assert.equal(calls, 0, "the failed delivery still deduped the SAME episode on the next boot");
});

// ── The escalation TITLE must name the window that actually breached ──────────────────────────
// MEASURED on issue #3483: the title read "weekly headroom reserve reached — dispatch paused
// until 2026-09-01T12:00:00.000Z" while its own body read "session (5h) is at 100% used", and the
// daemon's `daemon.headroom` telemetry named `session (5h)` on every tick of that episode. The
// summary hardcoded "weekly"; the detail had always interpolated `info.window` correctly. So an
// operator scanning issue TITLES saw a weekly cap they had not hit, on every session exhaustion.
// The daemon could always tell them apart — `resolveHeadroomWindows` (daemon.ts) labels them
// "session (5h)" and "weekly (<label>)" separately — and only this one line could not.

test("a SESSION breach names the session window in the title, not weekly", () => {
  const dir = mkdtempSync(join(tmpdir(), "headroom-reserve-window-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const info = { window: "session (5h)", percentUsed: 100, limitPct: 100, resetsAt: "2026-09-01T12:00:00.000Z" };
  const seen: Array<{ title: string; body: string }> = [];
  const fake = {
    create(title: string, body: string) {
      seen.push({ title, body });
      return "https://github.com/o/r/issues/1";
    },
  };
  escalateHeadroomReserve(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-S", issues: fake });
  assert.equal(seen.length, 1, "the breach opens exactly one issue");
  assert.match(seen[0]!.title, /session \(5h\)/, "the TITLE must name the window that actually breached");
  assert.equal(
    /weekly/.test(seen[0]!.title),
    false,
    `a session exhaustion must never be titled weekly — this is issue #3483's exact defect. Got: ${seen[0]!.title}`,
  );
  assert.match(seen[0]!.body, /session \(5h\)/, "and the detail keeps naming it too — unchanged, it was always right");
});

test("a WEEKLY breach still names the weekly window, label and all", () => {
  const dir = mkdtempSync(join(tmpdir(), "headroom-reserve-window-w-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const info = { window: "weekly (all models)", percentUsed: 96, limitPct: 95, resetsAt: "Sep 7 at 12am" };
  const seen: string[] = [];
  const fake = {
    create(title: string) {
      seen.push(title);
      return "https://github.com/o/r/issues/2";
    },
  };
  escalateHeadroomReserve(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-W", issues: fake });
  assert.equal(seen.length, 1, "the breach opens exactly one issue");
  assert.match(seen[0]!, /weekly \(all models\)/, "a real weekly breach keeps its own label, model name included");
});
