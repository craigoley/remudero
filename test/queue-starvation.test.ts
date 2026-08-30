import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { escalateStarvation } from "../src/run-task.js";
import { runDaemon, type StarvationCensus } from "../src/lib/daemon.js";
import { DECISION_RELEVANT_LEDGER_STEPS, appendLedger } from "../src/lib/ledger.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";

/**
 * oper#queue-starvation-2026-08-03 — "an EMPTY dispatch queue escalates nothing: the fleet
 * starved for ~12h with 14% headroom spent and the only symptom was `daemon.idle` in a log
 * nobody reads." THE ASYMMETRY THIS FIXES: a FAILING run already escalates
 * (`escalateCircuitBreak` fires once per tripped breaker) — but a queue that has run OUT of
 * dispatchable work used to be indistinguishable in the ledger from one quietly healthy
 * between tasks, because both emit only `daemon.idle`. `daemon.idle_reasons` already carries
 * the full census every tick it changes; this is the first reader that turns "everything is
 * merged/human-only" apart from "something recoverable is stuck" into an actual notification.
 */

// Ids without a leading digit sort LEXICOGRAPHICALLY under dispatchOrder's tiebreak
// (idOrdinal has nothing to read), so this plan's walk order is deterministic:
// BL, CB, DEP, HU, M — every one of the five formerly-silent/circuit-break declines, once.
const STARVED_YAML = `
- id: BL
  title: an explicitly blocked task
  repo: remudero
  type: implement
  depends_on: []
  status: blocked
- id: CB
  title: a circuit-broken task
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: DEP
  title: depends on the blocked task, so it is unmet-deps too
  repo: remudero
  type: implement
  depends_on: [BL]
  status: queued
- id: HU
  title: needs a human, never becomes machine-dispatchable
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
- id: M
  title: already merged — the plan's DONE half
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

// Every task is EITHER already-merged OR verify:human — the DONE case, never starved.
const DONE_YAML = `
- id: M
  title: already merged
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: HU
  title: needs a human forever
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`;

function planFrom(yaml: string, tag: string): Plan {
  const dir = mkdtempSync(join(tmpdir(), `queue-starvation-${tag}-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, yaml);
  return loadPlan(f);
}

/** A fake clock that counts polls and, after `stopAfter` of them, requests a fleet STOP — the
 *  same idiom test/daemon.test.ts's own P29(ii) "x10 spin" test uses to prove a dedup holds
 *  across MANY idle ticks of the PERSISTENT daemon loop, not just the first one. */
function pollingClock(root: string, stopAfter: number): { sleep: (ms: number) => Promise<void>; calls: () => number } {
  let calls = 0;
  return {
    sleep: async () => {
      calls++;
      if (calls >= stopAfter) requestStop(root, "test done polling");
    },
    calls: () => calls,
  };
}

// ── claim 1: a starved queue escalates exactly once, naming the census and the ids ─────────

test("a queue with zero dispatchable tasks and at least one recoverable-class blocker escalates exactly once, naming the class census and the blocked ids", async () => {
  const plan = planFrom(STARVED_YAML, "starved");
  const merged = new Set(["M"]); // M is already-merged; nothing else ever merges in this test
  const root = mkdtempSync(join(tmpdir(), "queue-starvation-root-"));
  const clock = pollingClock(root, 6);
  const censuses: StarvationCensus[] = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    isCircuitTripped: (id) => id === "CB",
    onStarvation: (census) => {
      censuses.push(census);
    },
    runOne: async (id) => {
      throw new Error(`FALSIFIER: ${id} was dispatched — nothing in this plan should ever be eligible`);
    },
    checkStop: () => stopDetail(root),
    sleep: clock.sleep,
  });

  assert.equal(s.stopReason, "stopped");
  assert.ok(clock.calls() >= 6, "the loop really idle-polled many times before the test stopped it");
  assert.equal(censuses.length, 1, "starvation escalates exactly ONCE across many idle polls, never once per tick");
  assert.deepEqual(censuses[0], {
    circuitBroken: { count: 1, ids: ["CB"], truncated: 0 },
    blocked: { count: 1, ids: ["BL"], truncated: 0 },
    unmetDeps: { count: 1, ids: ["DEP"], truncated: 0 },
    retired: { count: 0, ids: [], truncated: 0 },
  });
});

// ── claim 2: an all-DONE plan (merged + human-only) is DONE, not starved, and stays silent ──

test("a plan whose every task is already merged or needs a human is DONE, not starved, and escalates nothing", async () => {
  const plan = planFrom(DONE_YAML, "done");
  const merged = new Set(["M"]);
  const root = mkdtempSync(join(tmpdir(), "queue-starvation-done-root-"));
  const clock = pollingClock(root, 6);
  const censuses: StarvationCensus[] = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    onStarvation: (census) => {
      censuses.push(census);
    },
    runOne: async (id) => {
      throw new Error(`FALSIFIER: ${id} was dispatched — nothing in this plan should ever be eligible`);
    },
    checkStop: () => stopDetail(root),
    sleep: clock.sleep,
  });

  assert.equal(s.stopReason, "stopped");
  assert.ok(clock.calls() >= 6, "the loop really idle-polled many times before the test stopped it");
  assert.equal(censuses.length, 0, "an all-merged/verify-human plan is DONE, not starved — the distinction is the whole point");
});

// ── claim 3: the dedup step is registered so a ledger rotation cannot re-arm the page ───────

test("DECISION_RELEVANT_LEDGER_STEPS: registers the starvation dedup step, so a rotation cannot silently re-page the operator", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has("dispatch.starvation.escalated"),
    "dispatch.starvation.escalated must survive rotation — it IS escalateStarvation's dedup key",
  );
});

test("escalateStarvation: opens an escalation and durably dedups until a task actually dispatches again", () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-starvation-escalate-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const census: StarvationCensus = {
    circuitBroken: { count: 1, ids: ["CB"], truncated: 0 },
    blocked: { count: 1, ids: ["BL"], truncated: 0 },
    unmetDeps: { count: 0, ids: [], truncated: 0 },
    retired: { count: 0, ids: [], truncated: 0 },
  };
  let calls = 0;
  const fake = {
    create() {
      calls++;
      return "https://github.com/o/r/issues/1";
    },
  };

  escalateStarvation(census, { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: fake });
  assert.equal(calls, 1, "the first observation of this episode opens an issue");
  let lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const marker = lines.find((l) => l.step === "dispatch.starvation.escalated");
  assert.ok(marker, "a durable dedup marker is written naming the census");
  assert.equal(marker.delivered, true);
  assert.equal(marker.circuit_broken, 1);
  assert.equal(marker.blocked, 1);
  assert.deepEqual(marker.circuit_broken_ids, ["CB"]);
  assert.deepEqual(marker.blocked_ids, ["BL"]);

  // A FRESH process (a daemon restart mid-episode) re-observing the SAME still-starved queue —
  // nothing has dispatched since — must not re-open a sibling issue.
  escalateStarvation(census, { owner: "o", repo: "r", ledgerPath, runId: "RUN-2", issues: fake });
  assert.equal(calls, 1, "the SAME episode (nothing dispatched since) is deduped across the restart");

  // A task actually dispatches — `run.start`, the SAME marker the dispatch circuit breaker
  // itself relies on (status.ts's dispatchesWithoutNewOwnedPr) — ending the episode. A LATER
  // starvation notice, even with an identical census, must escalate again.
  appendLedger(ledgerPath, { run_id: "RUN-2", task_id: "D", step: "run.start" });
  escalateStarvation(census, { owner: "o", repo: "r", ledgerPath, runId: "RUN-3", issues: fake });
  assert.equal(calls, 2, "a dispatch since the last notice ends the prior episode and this one escalates again");

  lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const escalations = lines.filter((l) => l.step === "dispatch.starvation.escalated");
  assert.equal(escalations.length, 2, "two distinct episodes wrote two distinct markers");
});

test("escalateStarvation: a THROWING gh gateway still writes the dedup marker, so the next boot does not retry (mirrors escalateCircuitBreak, W1-T104)", () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-starvation-escalate-throw-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const census: StarvationCensus = {
    circuitBroken: { count: 0, ids: [], truncated: 0 },
    blocked: { count: 0, ids: [], truncated: 0 },
    unmetDeps: { count: 2, ids: ["W1-T1", "W1-T2"], truncated: 0 },
    retired: { count: 0, ids: [], truncated: 0 },
  };
  const boom = {
    create() {
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  assert.doesNotThrow(() =>
    escalateStarvation(census, { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: boom }),
  );
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const marker = lines.find((l) => l.step === "dispatch.starvation.escalated");
  assert.ok(marker, "FALSIFIER: pre-fix this class of marker was written only on success");
  assert.equal(marker.delivered, false);

  let calls = 0;
  const counting = {
    create() {
      calls++;
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  escalateStarvation(census, { owner: "o", repo: "r", ledgerPath, runId: "RUN-2", issues: counting });
  assert.equal(calls, 0, "the failed delivery still deduped the SAME episode on the next boot");
});
