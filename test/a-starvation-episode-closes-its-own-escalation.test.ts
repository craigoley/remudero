import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { escalateStarvation, escalateStarvationCleared } from "../src/run-task.js";
import type { RunResult } from "../src/run-task.js";
import { runDaemon, type StarvationCensus, type StarvationClearedInfo } from "../src/lib/daemon.js";
import { DECISION_RELEVANT_LEDGER_STEPS, appendLedger } from "../src/lib/ledger.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";

/**
 * W1-T2476 — "A STARVATION EPISODE ENDS TWICE IN THE DAEMON'S OWN WORDS AND NOBODY OUTSIDE THE
 * PROCESS IS TOLD": `onStarvation` (daemon.ts) had no counterpart, so the two sites that reset
 * `starvationEscalated` re-armed an in-process boolean and told nothing outside the process — the
 * escalation issue `escalateStarvation` opened stayed open forever, even once the fleet merged
 * roughly twenty-five PRs across the same window. This suite proves the mirrored
 * `onStarvationCleared` hook fires on exactly the right edges, names which of the two sites ended
 * the episode (plus the task where there is one), and that the real wiring
 * (`escalateStarvationCleared`) closes the escalation `escalateStarvation` opened — never any
 * other issue, never by throwing into the daemon loop.
 */

function planFrom(yaml: string, tag: string): Plan {
  const dir = mkdtempSync(join(tmpdir(), `starvation-cleared-${tag}-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, yaml);
  return loadPlan(f);
}

/** Same idiom as test/queue-starvation.test.ts's `pollingClock`: counts polls and, after
 *  `stopAfter` of them, requests a fleet STOP — proves a dedup holds across MANY idle ticks of
 *  the PERSISTENT daemon loop, never just the first one. */
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

const okResult = (id: string): RunResult =>
  ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0, verdict: "merged" }) as RunResult;

// Ids without a leading digit sort lexicographically under dispatchOrder's tiebreak (idOrdinal
// has nothing to read), matching test/queue-starvation.test.ts's own walk-order discipline.

// SITE 1 fixture: BL is explicitly blocked (never becomes dispatchable itself); reloading the
// plan below drops the block WITHOUT anything ever becoming dispatchable — "nothing recoverable
// is blocking this tick" (daemon.ts's own comment at that site), never a dispatch.
const SITE1_STARVED_YAML = `
- id: BL
  title: an explicitly blocked task
  repo: remudero
  type: implement
  depends_on: []
  status: blocked
- id: HU
  title: needs a human, never becomes machine-dispatchable
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`;

const SITE1_CLEARED_YAML = `
- id: HU
  title: needs a human, never becomes machine-dispatchable
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`;

// SITE 2 fixture: DEP is unmet-deps on BL, a verify:human task that never gets AUTO-dispatched
// but CAN be externally merged (a human merged it by hand) — once merged, DEP itself becomes
// dispatchable, which is "a dispatchable task ends any starvation episode" (the other site's own
// comment).
const SITE2_YAML = `
- id: BL
  title: a human-verified task that later merges, unblocking DEP
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
- id: DEP
  title: depends on BL until it merges
  repo: remudero
  type: implement
  depends_on: [BL]
  status: queued
`;

// A plan that is DONE (merged/human-only), never starved — mirrors queue-starvation.test.ts's
// DONE_YAML exactly, for the "never escalated, never cleared" claim.
const NEVER_STARVED_YAML = `
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

// ── claim: names which site ended the episode + the task where there is one ────────────────────
// (site 2: "a dispatchable task appeared", covering claim 1 too — fires exactly once)

test("SITE 2 (dispatchable task appears): the cleared hook fires exactly once, naming the site and the task that ended the episode", async () => {
  const plan = planFrom(SITE2_YAML, "site2");
  const merged = new Set<string>(); // BL starts unmerged, so DEP starts unmet-deps (starved)
  const root = mkdtempSync(join(tmpdir(), "starvation-cleared-site2-root-"));
  const censuses: StarvationCensus[] = [];
  const cleared: StarvationClearedInfo[] = [];
  let dispatched: string[] = [];
  let idleTicks = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    onStarvation: (census) => { censuses.push(census); },
    onStarvationCleared: (info) => { cleared.push(info); },
    runOne: async (id) => {
      dispatched.push(id);
      return okResult(id);
    },
    checkStop: () => {
      // Give the loop exactly one dispatchable tick, then stop — the escape hatch this test
      // relies on so a broken guard cannot spin forever (test/daemon-freshness-wiring.test.ts's
      // own discipline).
      if (dispatched.length > 0) {
        requestStop(root, "dispatched once");
      } else if (idleTicks > 20) {
        // A second escape hatch: if the census never escalates (a regression in the fixture
        // itself), fail fast instead of hanging the test suite.
        requestStop(root, "gave up waiting for the episode to escalate");
      }
      return stopDetail(root);
    },
    sleep: async () => {
      idleTicks++;
      // Idle ticks only: this fires while DEP is still unmet-deps. Merge BL the tick right
      // after the census first escalates, so the NEXT tick admits DEP.
      if (censuses.length > 0) merged.add("BL");
    },
  });

  assert.equal(s.stopReason, "stopped");
  assert.equal(censuses.length, 1, "the episode escalates exactly once before it ends");
  assert.equal(cleared.length, 1, "the cleared hook fires exactly once when the episode ends");
  assert.deepEqual(
    cleared[0],
    { reason: "dispatchable-task", taskId: "DEP" },
    "the hook names the SITE (a dispatchable task appeared) and the task that ended the episode",
  );
  assert.deepEqual(dispatched, ["DEP"], "DEP is the task that actually ended the episode");
});

// ── claim: names which site ended the episode (site 1: no task to name) ────────────────────────

test("SITE 1 (nothing recoverable is blocking): the cleared hook fires exactly once, naming the site with NO task (nothing dispatched)", async () => {
  let plan = planFrom(SITE1_STARVED_YAML, "site1-starved");
  const clearedPlan = planFrom(SITE1_CLEARED_YAML, "site1-cleared");
  const root = mkdtempSync(join(tmpdir(), "starvation-cleared-site1-root-"));
  const clock = pollingClock(root, 6);
  const censuses: StarvationCensus[] = [];
  const cleared: StarvationClearedInfo[] = [];
  let swapped = false;

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    onStarvation: (census) => { censuses.push(census); },
    onStarvationCleared: (info) => { cleared.push(info); },
    reloadPlan: () => {
      // Swap to a plan where BL no longer exists (never merged, never dispatched — its
      // block simply stopped being reported) once the episode has escalated at least once.
      if (!swapped && censuses.length > 0) {
        swapped = true;
        return clearedPlan;
      }
      return null;
    },
    runOne: async () => {
      throw new Error("FALSIFIER: nothing in this fixture is ever dispatchable — BL is blocked, HU is verify:human");
    },
    checkStop: () => stopDetail(root),
    sleep: clock.sleep,
  });

  assert.equal(s.stopReason, "stopped");
  assert.ok(clock.calls() >= 6, "the loop really idle-polled many times before the test stopped it");
  assert.equal(censuses.length, 1, "the episode escalates exactly once before it ends");
  assert.equal(cleared.length, 1, "the cleared hook fires exactly once when the episode ends");
  assert.deepEqual(
    cleared[0],
    { reason: "no-recoverable-blockers" },
    "the hook names the SITE (nothing recoverable is blocking) and carries NO task — nothing dispatched to end this episode",
  );
});

// ── claim: a daemon that never escalated fires the cleared hook not at all ─────────────────────

test("a daemon that never escalates (an all-merged/verify-human plan) fires the cleared hook not at all", async () => {
  const plan = planFrom(NEVER_STARVED_YAML, "never-starved");
  const merged = new Set(["M"]);
  const root = mkdtempSync(join(tmpdir(), "starvation-cleared-never-root-"));
  const clock = pollingClock(root, 8);
  const censuses: StarvationCensus[] = [];
  const cleared: StarvationClearedInfo[] = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    onStarvation: (census) => { censuses.push(census); },
    onStarvationCleared: (info) => { cleared.push(info); },
    runOne: async () => {
      throw new Error("FALSIFIER: nothing in this plan should ever be eligible");
    },
    checkStop: () => stopDetail(root),
    sleep: clock.sleep,
  });

  assert.equal(s.stopReason, "stopped");
  assert.ok(clock.calls() >= 8, "the loop really idle-polled many times before the test stopped it");
  assert.equal(censuses.length, 0, "DONE is not starved — the hook this task adds must never fire without its opening counterpart");
  assert.equal(cleared.length, 0, "nothing escalated, so there is nothing to clear — the guard on the flag it is clearing held");
});

// ── claim: two consecutive unstarved ticks fire the hook once, never once per tick ─────────────

test("two consecutive unstarved ticks after the episode ends fire the cleared hook once, never once per tick", async () => {
  let plan = planFrom(SITE1_STARVED_YAML, "site1-repeat-starved");
  const clearedPlan = planFrom(SITE1_CLEARED_YAML, "site1-repeat-cleared");
  const root = mkdtempSync(join(tmpdir(), "starvation-cleared-repeat-root-"));
  // Run for MANY more ticks than needed to clear once, so a per-tick re-fire is falsified rather
  // than merely unobserved.
  const clock = pollingClock(root, 12);
  const censuses: StarvationCensus[] = [];
  const cleared: StarvationClearedInfo[] = [];
  let swapped = false;

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    onStarvation: (census) => { censuses.push(census); },
    onStarvationCleared: (info) => { cleared.push(info); },
    reloadPlan: () => {
      if (!swapped && censuses.length > 0) {
        swapped = true;
        return clearedPlan;
      }
      return null;
    },
    runOne: async () => {
      throw new Error("FALSIFIER: nothing in this fixture is ever dispatchable");
    },
    checkStop: () => stopDetail(root),
    sleep: clock.sleep,
  });

  assert.equal(s.stopReason, "stopped");
  assert.ok(clock.calls() >= 12, "many unstarved ticks ran after the episode cleared");
  assert.equal(cleared.length, 1, "the cleared hook fires ONCE on the edge, never once per subsequent unstarved tick");
});

// ── claim: the open starvation escalation is closed with a comment citing that reason ──────────

test("escalateStarvationCleared: closes the open starvation escalation with a comment citing the reason (both sites)", () => {
  const dir = mkdtempSync(join(tmpdir(), "starvation-cleared-close-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  appendLedger(ledgerPath, {
    run_id: "RUN-1",
    task_id: "daemon",
    step: "dispatch.starvation.escalated",
    issue_url: "https://github.com/o/r/issues/3207",
    delivered: true,
  });

  const closeCalls: Array<{ url: string; comment: string }> = [];
  const fake = { create: () => "unused", closeWithComment: (url: string, comment: string) => closeCalls.push({ url, comment }) };

  escalateStarvationCleared({ reason: "no-recoverable-blockers" }, { owner: "o", repo: "r", ledgerPath, runId: "RUN-2", issues: fake });

  assert.equal(closeCalls.length, 1, "the open escalation is closed exactly once");
  assert.equal(closeCalls[0].url, "https://github.com/o/r/issues/3207", "the SAME issue the episode opened is closed — never a different referent");
  assert.match(closeCalls[0].comment, /nothing recoverable/i, "the closing comment cites WHY the episode ended, not a bare 'resolved'");

  // Site 2's reason, naming the task.
  const dir2 = mkdtempSync(join(tmpdir(), "starvation-cleared-close2-"));
  const ledgerPath2 = join(dir2, "ledger.ndjson");
  appendLedger(ledgerPath2, {
    run_id: "RUN-1",
    task_id: "daemon",
    step: "dispatch.starvation.escalated",
    issue_url: "https://github.com/o/r/issues/2063",
    delivered: true,
  });
  const closeCalls2: Array<{ url: string; comment: string }> = [];
  const fake2 = { create: () => "unused", closeWithComment: (url: string, comment: string) => closeCalls2.push({ url, comment }) };
  escalateStarvationCleared(
    { reason: "dispatchable-task", taskId: "W1-T269" },
    { owner: "o", repo: "r", ledgerPath: ledgerPath2, runId: "RUN-2", issues: fake2 },
  );
  assert.equal(closeCalls2.length, 1);
  assert.match(closeCalls2[0].comment, /W1-T269/, "the closing comment names the task that ended the episode, where there is one");
});

// ── claim: a gateway that cannot close leaves the issue open and costs one logged line ─────────

test("escalateStarvationCleared: a gateway that cannot close leaves the issue open and costs one logged (ledger) line, never a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "starvation-cleared-nocap-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  appendLedger(ledgerPath, {
    run_id: "RUN-1",
    task_id: "daemon",
    step: "dispatch.starvation.escalated",
    issue_url: "https://github.com/o/r/issues/3207",
    delivered: true,
  });

  const capless = { create: () => "unused" }; // no closeWithComment at all
  assert.doesNotThrow(() =>
    escalateStarvationCleared({ reason: "no-recoverable-blockers" }, { owner: "o", repo: "r", ledgerPath, runId: "RUN-2", issues: capless }),
  );

  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cleared = lines.filter((l) => l.step === "dispatch.starvation.cleared");
  assert.equal(cleared.length, 1, "exactly one logged (ledger) line records the failed close");
  assert.equal(cleared[0].delivered, false, "never a close on a capability-less gateway — the issue is left open");
  assert.ok(typeof cleared[0].failure === "string" && cleared[0].failure.length > 0, "the failure reason is recorded, not silently dropped");
});

// ── claim: a throw in the closer never ends the daemon loop ────────────────────────────────────

test("escalateStarvationCleared: a THROWING closeWithComment leaves the issue open, costs one logged line, and never throws itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "starvation-cleared-throw-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  appendLedger(ledgerPath, {
    run_id: "RUN-1",
    task_id: "daemon",
    step: "dispatch.starvation.escalated",
    issue_url: "https://github.com/o/r/issues/3207",
    delivered: true,
  });
  const boom = {
    create: () => "unused",
    closeWithComment: () => {
      throw new Error("gh: HTTP 500");
    },
  };
  assert.doesNotThrow(() =>
    escalateStarvationCleared({ reason: "no-recoverable-blockers" }, { owner: "o", repo: "r", ledgerPath, runId: "RUN-2", issues: boom }),
  );
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cleared = lines.filter((l) => l.step === "dispatch.starvation.cleared");
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].delivered, false);
  assert.match(cleared[0].failure, /HTTP 500/);
});

test("runDaemon: a hook that throws synchronously never ends the daemon loop — the loop keeps polling and stops cleanly", async () => {
  const plan = planFrom(SITE1_STARVED_YAML, "site1-throwing-hook");
  const clearedPlan = planFrom(SITE1_CLEARED_YAML, "site1-throwing-hook-cleared");
  const root = mkdtempSync(join(tmpdir(), "starvation-cleared-loop-throw-root-"));
  const clock = pollingClock(root, 10);
  const censuses: StarvationCensus[] = [];
  let swapped = false;

  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    onStarvation: (census) => { censuses.push(census); },
    onStarvationCleared: () => {
      throw new Error("BOOM: a broken hook must never take the daemon down");
    },
    reloadPlan: () => {
      if (!swapped && censuses.length > 0) {
        swapped = true;
        return clearedPlan;
      }
      return null;
    },
    runOne: async () => {
      throw new Error("FALSIFIER: nothing in this fixture is ever dispatchable");
    },
    checkStop: () => stopDetail(root),
    sleep: clock.sleep,
  });

  assert.equal(s.stopReason, "stopped", "the throwing hook is caught and the loop keeps polling to its normal stop");
  assert.ok(clock.calls() >= 10, "the loop survived the throw and kept polling for many more ticks");
});

// ── claim: the ledger carries a cleared row so an episode ending is countable ───────────────────

test("DECISION_RELEVANT_LEDGER_STEPS: registers the starvation-cleared referent step, so a rotation cannot silently orphan the close-vs-reopen boundary", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has("dispatch.starvation.cleared"),
    "dispatch.starvation.cleared must survive rotation — escalateStarvationCleared reads it back to find the CURRENT episode's referent",
  );
});

test("escalateStarvationCleared: writes a countable ledger row on a successful close", () => {
  const dir = mkdtempSync(join(tmpdir(), "starvation-cleared-countable-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  appendLedger(ledgerPath, {
    run_id: "RUN-1",
    task_id: "daemon",
    step: "dispatch.starvation.escalated",
    issue_url: "https://github.com/o/r/issues/3207",
    delivered: true,
  });
  const fake = { create: () => "unused", closeWithComment: () => {} };
  escalateStarvationCleared({ reason: "no-recoverable-blockers" }, { owner: "o", repo: "r", ledgerPath, runId: "RUN-2", issues: fake });

  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cleared = lines.find((l) => l.step === "dispatch.starvation.cleared");
  assert.ok(cleared, "an episode ending is countable — a ledger row is written every time");
  assert.equal(cleared.delivered, true);
  assert.equal(cleared.reason, "no-recoverable-blockers");
});

// ── claim: no escalation of another class is closed by this path ───────────────────────────────

test("escalateStarvationCleared: touches nothing when no starvation escalation is open, even alongside a DIFFERENT open escalation", () => {
  const dir = mkdtempSync(join(tmpdir(), "starvation-cleared-other-class-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  // A DIFFERENT class's escalation (headroom breach) — NOT dispatch.starvation.escalated.
  appendLedger(ledgerPath, {
    run_id: "RUN-1",
    task_id: "daemon",
    step: "daemon.headroom_reserve.escalated",
    issue_url: "https://github.com/o/r/issues/9999",
  });

  const closeCalls: string[] = [];
  const fake = { create: () => "unused", closeWithComment: (url: string) => closeCalls.push(url) };
  escalateStarvationCleared({ reason: "no-recoverable-blockers" }, { owner: "o", repo: "r", ledgerPath, runId: "RUN-2", issues: fake });

  assert.equal(closeCalls.length, 0, "no starvation escalation was open, so nothing is closed — least of all a DIFFERENT class's issue");

  // A starvation episode that ALREADY cleared — the referent is gone; a second clear call must
  // not re-derive the older, already-closed issue and close it again.
  const dir2 = mkdtempSync(join(tmpdir(), "starvation-cleared-already-"));
  const ledgerPath2 = join(dir2, "ledger.ndjson");
  appendLedger(ledgerPath2, {
    run_id: "RUN-1",
    task_id: "daemon",
    step: "dispatch.starvation.escalated",
    issue_url: "https://github.com/o/r/issues/2438",
    delivered: true,
  });
  appendLedger(ledgerPath2, {
    run_id: "RUN-1",
    task_id: "daemon",
    step: "dispatch.starvation.cleared",
    reason: "no-recoverable-blockers",
    issue_url: "https://github.com/o/r/issues/2438",
    delivered: true,
  });
  const closeCalls2: string[] = [];
  const fake2 = { create: () => "unused", closeWithComment: (url: string) => closeCalls2.push(url) };
  escalateStarvationCleared({ reason: "no-recoverable-blockers" }, { owner: "o", repo: "r", ledgerPath: ledgerPath2, runId: "RUN-3", issues: fake2 });
  assert.equal(closeCalls2.length, 0, "an already-cleared episode's issue is never re-closed");
});

// ── claim: deleting the cleared call leaves the issue open and reddens this suite ──────────────

test("REACHABILITY, end to end: runDaemon → escalateStarvation opens → the episode ends → escalateStarvationCleared closes the SAME issue", async () => {
  const plan = planFrom(SITE2_YAML, "reachability");
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "starvation-cleared-reachability-root-"));
  const dir = mkdtempSync(join(tmpdir(), "starvation-cleared-reachability-ledger-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  let created = 0;
  let dispatched: string[] = [];
  let idleTicks = 0;
  const closeCalls: Array<{ url: string; comment: string }> = [];
  const fake = {
    create() {
      created++;
      return "https://github.com/o/r/issues/3207";
    },
    closeWithComment(url: string, comment: string) {
      closeCalls.push({ url, comment });
    },
  };

  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    // The REAL production wiring (run-task.ts's daemonCommand), not a test double: if either
    // reset site's call to `onStarvationCleared`, or `escalateStarvationCleared`'s own close,
    // is ever deleted, this assertion goes red.
    onStarvation: (census) => escalateStarvation(census, { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: fake }),
    onStarvationCleared: (info) => escalateStarvationCleared(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: fake }),
    runOne: async (id) => {
      dispatched.push(id);
      return okResult(id);
    },
    checkStop: () => {
      if (dispatched.length > 0) requestStop(root, "dispatched once");
      else if (idleTicks > 20) requestStop(root, "gave up waiting for the episode to escalate");
      return stopDetail(root);
    },
    sleep: async () => {
      idleTicks++;
      // Merge BL the tick right after the escalation opens, so DEP becomes dispatchable next.
      if (created > 0) merged.add("BL");
    },
  });

  assert.equal(s.stopReason, "stopped");
  assert.equal(created, 1, "the starved episode opened exactly one escalation");
  assert.equal(closeCalls.length, 1, "the episode ending closed exactly one escalation");
  assert.equal(closeCalls[0].url, "https://github.com/o/r/issues/3207", "the SAME issue that was opened is the one that gets closed");
  assert.deepEqual(dispatched, ["DEP"], "a dispatchable task appearing is what ended this episode");
});

// ── THE WIRING. Every test above injects its OWN `onStarvationCleared`, so the production hook
// could be absent entirely and all of them would still pass. MEASURED while reviewing this PR:
// deleting `daemonCommand`'s `onStarvationCleared:` line left the suite at 12/12 green — the
// "ships unwired" class (W1-T322), and the exact thing acceptance criterion 10 claims is covered.
// Asserted over source text, deliberately on the CALL rather than a position, and with a
// comment-stripped copy so a mention in prose can never satisfy it (the #339/W1-T281 bug class:
// a proof that only greps a COMMENT passes on entirely unbuilt wiring).

const RUN_TASK_SRC = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
/**
 * Source with COMMENT LINES dropped — what remains is code that actually runs.
 *
 * Deliberately a LINE FILTER, not a `/* … *\/` span strip. MEASURED while writing this: a global
 * block-comment regex on a 32k-line file swallows a whole region, because `/*` occurs inside
 * regex literals and strings here; it removed the very call site under test while leaving the
 * function definition, so the assertion failed for the wrong reason. A line filter cannot
 * over-reach, and a prose mention of the hook still lives on a `//` line, which is all this needs.
 */
const RUN_TASK_CODE = RUN_TASK_SRC.split("\n")
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

test("daemonCommand WIRES onStarvationCleared to escalateStarvationCleared — the hook is reachable in production, not only from these fixtures", () => {
  const wired = RUN_TASK_CODE.match(/onStarvationCleared\s*:/g) ?? [];
  assert.ok(
    wired.length >= 1,
    `run-task.ts must pass onStarvationCleared into runDaemon's deps; found ${wired.length} non-comment occurrence(s). ` +
      "Without this the closer ships unwired and every test above still passes, because each injects its own hook.",
  );
  assert.match(
    RUN_TASK_CODE,
    /onStarvationCleared\s*:\s*\([^)]*\)\s*=>\s*escalateStarvationCleared\(/,
    "the wired hook must call escalateStarvationCleared — a hook wired to something else closes no issue",
  );
});

test("CONTROL: the comment-stripped source is not vacuous — it still carries the code this file tests", () => {
  // If the stripper ate the file, the assertions above would pass or fail for the wrong reason.
  assert.match(RUN_TASK_CODE, /export function escalateStarvationCleared\(/, "the function under test must survive comment-stripping");
  // ANTI-VACUITY, BOTH WAYS: the code line survives, and a comment line naming the same symbol
  // does not — otherwise a mention in prose could satisfy the wiring assertion above.
  assert.match(RUN_TASK_CODE, /onStarvationCleared: \(info\) =>/, "the wired call line itself must survive the filter");
  assert.ok(
    /\/\/ This task: the cleared half/.test(RUN_TASK_SRC),
    "the fixture comment must exist in the raw source, or the negative below proves nothing",
  );
  assert.ok(
    !/\/\/ This task: the cleared half/.test(RUN_TASK_CODE),
    "and it must NOT survive the filter — a comment must never be able to satisfy the wiring assertion",
  );
});
