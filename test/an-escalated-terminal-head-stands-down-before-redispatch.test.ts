/**
 * test/an-escalated-terminal-head-stands-down-before-redispatch.test.ts — W1-T2752.
 *
 * THE DEFECT. `buildSweepEffects.dispatchFix` (run-task.ts) already owns a durable,
 * PR@head-SHA-keyed cache of terminal `not_a_run_branch` declines (W1-T2723) and returns
 * immediately — no GitHub read, no duplicate issue — once that head's escalation has been
 * DELIVERED. But that cache is private to the effect: `runSweep` (sweep.ts) cannot see it, so it
 * still records `acted: true` and still counts the poll as a real invocation of the fix lane every
 * single sweep, for a head the lane declined the moment it was first seen. Measured on the live
 * fleet: one delivered terminal row, eleven more `sweep.disposed acted:true` rows for the SAME
 * unchanged head before an operator pushed a new one.
 *
 * THE FIX. `SweepDeps` gains an optional, synchronous, read-only admission seam —
 * `terminalFixStandDown` — that `runSweep` consults immediately before EITHER dispatch surface
 * (`blocked-fixable`, `conflicted`) invokes `deps.dispatchFix`. `buildSweepEffects` supplies it
 * from the SAME `terminalUncreditableHeads` map `dispatchFix`'s own internal check already reads —
 * no second cache, no new persistence format. It declines only the exact PR@head whose escalation
 * was already delivered; every other case (no cached entry, a cached entry whose delivery FAILED,
 * a new head SHA) returns `undefined` and the ordinary path — including the failed-delivery retry
 * — runs exactly as it did before this task.
 *
 * NO NETWORK, NO SPAWN, NO REAL `gh`. Section A drives `runSweep`/`runSweepLightPass` directly
 * against a fake `terminalFixStandDown`, proving the OUTER admission contract sweep.ts owns.
 * Section B drives the REAL `buildSweepEffects`-supplied predicate against ledger rows on disk,
 * proving it reads the SAME durable cache `dispatchFix` already reads and distinguishes delivered
 * from undelivered without any GitHub call.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SWEEP_POLICY,
  drainDetachedSweepActions,
  detachedSweepActionCount,
  runSweep,
  runSweepLightPass,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";
import { buildSweepEffects } from "../src/run-task.js";
import type { Plan, Task } from "../src/lib/plan.js";

const RECENT = "2026-07-19T12:00:00Z";
const NOW = Date.parse("2026-07-29T18:00:00Z");

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-t2752-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

/** The golden blocked-fixable shape every sweep suite in this repo already uses. */
function blockedFixablePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    prNumber: 11,
    prUrl: "url/11",
    taskId: "W1-B",
    reviewState: "failure",
    checksState: "green",
    priorStrikes: 0,
    unmetCriteria: [
      { claim: "still needs work", proof: "unit test: x", met: false, reason: "not done", proof_exec: "executed_fail" },
    ],
    reviewSummary: "one criterion unmet",
    ...over,
  });
}

/** The golden conflicted shape every sweep suite in this repo already uses. */
function conflictedPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    prNumber: 21,
    prUrl: "url/21",
    taskId: "W1-C",
    reviewState: "pending",
    checksState: "pending",
    headSha: "cccc333",
    mergeState: "dirty",
    // A PURE CONCURRENT ADDITION (isPureConcurrentAddition) — the ONLY empty-files shape the
    // "conflicted" row's own `when` admits; an empty `files: []` array falls through to
    // "blocked-ambiguous" instead, since both admission predicates require `files.length > 0`.
    mergeConflict: {
      files: [{ path: "src/new-thing.ts", oursDeleted: 0, theirsDeleted: 0 }],
      oursLog: "abc ours",
      theirsLog: "def theirs",
    },
    ...over,
  });
}

function baseDeps(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: ledgerPath(),
    runId: "SWEEP-T2752",
    now: () => NOW,
    ...over,
  };
}

/** A `dispatchFix` recorder — never called at all is the property most tests here assert. */
function recordingDispatch(): {
  dispatchFix: SweepDeps["dispatchFix"];
  calls: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
} {
  const calls: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  return {
    calls,
    dispatchFix: (p, evidence) => {
      calls.push({ pr: p, evidence });
      return undefined;
    },
  };
}

/** Same held-promise shape test/light-pass-tick-is-not-bounded-by-ci.test.ts already uses, so the
 *  detached contract this task must not disturb is proved the SAME way it was proved there. */
function heldDispatch(): {
  dispatchFix: SweepDeps["dispatchFix"];
  calls: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  release: () => void;
  settled: () => boolean;
} {
  const calls: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  let release!: () => void;
  let settled = false;
  const gate = new Promise<void>((resolve) => {
    release = () => {
      settled = true;
      resolve();
    };
  });
  return {
    calls,
    release,
    settled: () => settled,
    dispatchFix: (p, evidence) => {
      calls.push({ pr: p, evidence });
      return gate as unknown as ReturnType<NonNullable<SweepDeps["dispatchFix"]>>;
    },
  };
}

function disposedRow(path: string, prNumber: number): Record<string, unknown> | undefined {
  return readLedgerLines(path).find((l) => l.step === "sweep.disposed" && l.pr_number === prNumber);
}

// ── Section A: the outer admission seam, driven directly against `runSweep`/`runSweepLightPass` ──

test("acceptance 1: a delivered terminal decision stands the blocked-fixable dispatch down without invoking it, and names the reason", async () => {
  const rec = recordingDispatch();
  const path = ledgerPath();
  const target = blockedFixablePr({ prNumber: 111, headSha: "sha-delivered" });
  const deps = baseDeps({
    ledgerPath: path,
    dispatchFix: rec.dispatchFix,
    terminalFixStandDown: (p) =>
      p.prNumber === 111 && p.headSha === "sha-delivered"
        ? "terminal uncreditable head already escalated for this PR@head"
        : undefined,
  });

  await runSweep([target], deps);

  assert.equal(rec.calls.length, 0, "dispatchFix is never invoked once the outer seam declines");
  const row = disposedRow(path, 111);
  assert.equal(row?.disposition, "blocked-fixable");
  assert.equal(row?.acted, false, "the poll is reported honestly — no phantom action");
  assert.equal(
    row?.stand_down_reason,
    "terminal uncreditable head already escalated for this PR@head",
    "the stand-down carries a stable, explicit, named reason",
  );

  // The SAME light-sweep path (the detached daemon tick) must decline identically.
  const lightPath = ledgerPath();
  const lightDeps = { ...deps, ledgerPath: lightPath };
  await runSweepLightPass([target], lightDeps);
  assert.equal(rec.calls.length, 0, "the light pass declines the same way — never invoked");
  const lightRow = disposedRow(lightPath, 111);
  assert.equal(lightRow?.acted, false);
  assert.equal(detachedSweepActionCount(), 0, "declining before dispatch never registers a detached wait");
});

test("acceptance 1 (conflicted twin): the same delivered terminal decision stands the conflicted dispatch down", async () => {
  const rec = recordingDispatch();
  const path = ledgerPath();
  const target = conflictedPr({ prNumber: 211, headSha: "sha-conflict-delivered" });
  const deps = baseDeps({
    ledgerPath: path,
    dispatchFix: rec.dispatchFix,
    terminalFixStandDown: () => "terminal uncreditable head already escalated for this PR@head",
  });

  await runSweep([target], deps);

  assert.equal(rec.calls.length, 0, "dispatchFix is never invoked for the conflicted twin either");
  const row = disposedRow(path, 211);
  assert.equal(row?.disposition, "conflicted");
  assert.equal(row?.acted, false);
  assert.equal(row?.stand_down_reason, "terminal uncreditable head already escalated for this PR@head");
});

test("acceptance 2: the first terminal evaluation still invokes once and preserves the detached light-pass return contract", async () => {
  const held = heldDispatch();
  const deps = baseDeps({
    dispatchFix: held.dispatchFix,
    // Nothing is cached yet — the outer seam has nothing to decline on the first poll.
    terminalFixStandDown: () => undefined,
  });

  let passResolved = false;
  const pass = runSweepLightPass([blockedFixablePr({ prNumber: 112, headSha: "sha-first" })], deps).then((s) => {
    passResolved = true;
    return s;
  });
  await new Promise<void>((r) => setImmediate(r));

  assert.equal(held.calls.length, 1, "the first evaluation invokes dispatchFix exactly once");
  assert.equal(held.settled(), false, "the invocation is still in flight");
  assert.equal(passResolved, true, "yet the light pass already returned — W1-T2379's contract is untouched");
  assert.equal(detachedSweepActionCount(), 1, "the in-flight wait is held for the drain, exactly as before this task");

  held.release();
  await drainDetachedSweepActions();
  await pass;
});

test("acceptance 3: a new head SHA on the same PR is admitted and judged afresh, no operator reset or elapsed-time wait", async () => {
  const rec = recordingDispatch();
  const path = ledgerPath();
  const deps = baseDeps({
    ledgerPath: path,
    dispatchFix: rec.dispatchFix,
    // Only the OLD sha is cached as delivered; the predicate is keyed by exact PR@head.
    terminalFixStandDown: (p) => (p.prNumber === 113 && p.headSha === "sha-old" ? "terminal head already escalated" : undefined),
  });

  await runSweep([blockedFixablePr({ prNumber: 113, headSha: "sha-old" })], deps);
  assert.equal(rec.calls.length, 0, "the old, already-escalated head is declined");

  await runSweep([blockedFixablePr({ prNumber: 113, headSha: "sha-new" })], deps);
  assert.equal(rec.calls.length, 1, "a new head sha on the SAME PR number is invoked — a fresh fact, judged afresh");
  assert.equal(rec.calls[0]?.pr.headSha, "sha-new");
});

test("acceptance 4: a cached terminal head whose escalation delivery FAILED is re-admitted so the existing retry can run", async () => {
  const rec = recordingDispatch();
  const path = ledgerPath();
  const target = blockedFixablePr({ prNumber: 114, headSha: "sha-undelivered" });
  const deps = baseDeps({
    ledgerPath: path,
    dispatchFix: rec.dispatchFix,
    // The design's own contract: the outer seam declines ONLY a delivered escalation. A cached
    // entry whose delivery failed must return undefined here, exactly like "nothing cached at all"
    // — the effect itself owns retrying the failed delivery, never the outer admission seam.
    terminalFixStandDown: () => undefined,
  });

  await runSweep([target], deps);

  assert.equal(rec.calls.length, 1, "the undelivered terminal head still reaches dispatchFix so it can retry delivery");
  const row = disposedRow(path, 114);
  assert.equal(row?.acted, true, "a real invocation happened — this is not a silent stand-down");
});

test("acceptance 5: blocked-fixable and conflicted share one terminal admission rule, and omitting the seam changes nothing", async () => {
  const path = ledgerPath();
  const declineBoth = recordingDispatch();
  const deps = baseDeps({
    ledgerPath: path,
    dispatchFix: declineBoth.dispatchFix,
    terminalFixStandDown: () => "terminal head already escalated for this PR@head",
  });
  await runSweep(
    [blockedFixablePr({ prNumber: 115, headSha: "sha-a" }), conflictedPr({ prNumber: 215, headSha: "sha-b" })],
    deps,
  );
  assert.equal(declineBoth.calls.length, 0, "the SAME rule declines both dispatch surfaces");
  assert.equal(disposedRow(path, 115)?.acted, false);
  assert.equal(disposedRow(path, 215)?.acted, false);

  // Every EXISTING caller/fixture omits `terminalFixStandDown` entirely (it is optional). Nothing
  // about this task may change that caller's behaviour: dispatch must still fire normally.
  const unchangedPath = ledgerPath();
  const rec = recordingDispatch();
  const unchangedDeps = baseDeps({ ledgerPath: unchangedPath, dispatchFix: rec.dispatchFix });
  await runSweep(
    [blockedFixablePr({ prNumber: 116, headSha: "sha-c" }), conflictedPr({ prNumber: 216, headSha: "sha-d" })],
    unchangedDeps,
  );
  assert.equal(rec.calls.length, 2, "with the seam omitted, both surfaces dispatch exactly as they did before this task");
  assert.equal(disposedRow(unchangedPath, 116)?.acted, true);
  assert.equal(disposedRow(unchangedPath, 216)?.acted, true);
});

test("acceptance 6: the two-strike ceiling, acted-invocation semantics and the detached-action drain are unchanged", async () => {
  assert.equal(DEFAULT_SWEEP_POLICY.strikeCap, 2, "this task does not touch the strike cap");

  // The ceiling still binds even with the new seam wired but silent (not a terminal head).
  const rec = recordingDispatch();
  const path = ledgerPath();
  const atCap = blockedFixablePr({ prNumber: 117, headSha: "sha-at-cap", priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap });
  const deps = baseDeps({ ledgerPath: path, dispatchFix: rec.dispatchFix, terminalFixStandDown: () => undefined });
  await runSweep([atCap], deps);
  assert.equal(rec.calls.length, 0, "the pre-existing ceiling still refuses dispatch — the new seam never widens it");

  // `spent`/`acted` semantics (W1-T2231) are untouched: an ordinary, non-terminal dispatch that
  // returns `false` still reports `spent:false` while `acted` stays `true` — this task's seam only
  // ever governs whether dispatchFix is invoked AT ALL, never what its return value means.
  const spentPath = ledgerPath();
  const spentDeps = baseDeps({
    ledgerPath: spentPath,
    dispatchFix: () => false,
    terminalFixStandDown: () => undefined,
  });
  await runSweep([blockedFixablePr({ prNumber: 118, headSha: "sha-spent" })], spentDeps);
  const spentRow = disposedRow(spentPath, 118);
  assert.equal(spentRow?.acted, true, "acted invocation semantics (W1-T2231) are untouched");

  // The detached-action drain still empties normally when the terminal seam does NOT fire.
  const held = heldDispatch();
  const drainDeps = baseDeps({ dispatchFix: held.dispatchFix, terminalFixStandDown: () => undefined });
  await runSweepLightPass([blockedFixablePr({ prNumber: 119, headSha: "sha-drain" })], drainDeps);
  assert.equal(detachedSweepActionCount(), 1);
  held.release();
  await drainDetachedSweepActions();
  assert.equal(detachedSweepActionCount(), 0, "the drain still empties exactly as before this task");
});

// ── Section B: the REAL `buildSweepEffects`-supplied predicate, against ledger rows on disk ────

const TASK_ID = "W1-T2752B";
const TASK = {
  id: TASK_ID,
  title: TASK_ID,
  risk: "high",
  acceptance: [],
  verify: "auto",
  files: [],
  status: "queued",
} as unknown as Task;
const PLAN = { tasks: [TASK], byId: new Map([[TASK_ID, TASK]]) } as Plan;

function fixtureLedgerRoot(): { root: string; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-t2752-effects-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPathVal = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPathVal, "");
  return { root, ledgerPath: ledgerPathVal };
}

test("buildSweepEffects.terminalFixStandDown reads the SAME durable cache dispatchFix consults, and only a delivered escalation stands down", () => {
  const { root, ledgerPath: path } = fixtureLedgerRoot();
  appendLedger(path, {
    run_id: "SWEEP-prior",
    task_id: "SWEEP",
    step: "sweep.fix.uncreditable_head",
    pr_number: 5000,
    head_sha: "sha-delivered",
    head: "codex/manual-fix",
    synthetic: false,
    reason: "not_a_run_branch",
    terminal: true,
    repair_task_id: TASK_ID,
    cause: "review",
  });
  appendLedger(path, {
    run_id: "SWEEP-prior",
    task_id: "SWEEP",
    step: "sweep.fix.uncreditable_head_escalated",
    pr_number: 5000,
    head_sha: "sha-delivered",
    issue_url: "https://github.com/acme/scratch/issues/9001",
  });
  // A second, terminal head whose escalation NEVER delivered — no `_escalated` row at all.
  appendLedger(path, {
    run_id: "SWEEP-prior",
    task_id: "SWEEP",
    step: "sweep.fix.uncreditable_head",
    pr_number: 5001,
    head_sha: "sha-undelivered",
    head: "codex/manual-fix-2",
    synthetic: false,
    reason: "not_a_run_branch",
    terminal: true,
    repair_task_id: TASK_ID,
    cause: "ci",
  });

  const effects = buildSweepEffects(
    "acme",
    "scratch",
    { root } as never,
    path,
    "SWEEP-t2752-effects",
    PLAN,
    () => {},
    DEFAULT_SWEEP_POLICY,
  );
  assert.equal(typeof effects.terminalFixStandDown, "function", "the seam is wired by production `buildSweepEffects`");
  const standDown = effects.terminalFixStandDown!;

  const delivered = standDown({ prNumber: 5000, headSha: "sha-delivered" } as OpenPrView);
  assert.ok(delivered, "the delivered escalation stands down");
  assert.match(String(delivered), /escalated/, "the reason names what happened, not a generic sentence");

  assert.equal(
    standDown({ prNumber: 5001, headSha: "sha-undelivered" } as OpenPrView),
    undefined,
    "an entry whose escalation never delivered is NOT stood down here — dispatchFix must still run to retry it",
  );

  assert.equal(
    standDown({ prNumber: 5000, headSha: "sha-new-push" } as OpenPrView),
    undefined,
    "a fresh push mints a new head sha, missing the old cache entry entirely — admitted afresh",
  );

  assert.equal(
    standDown({ prNumber: 9999, headSha: "never-seen" } as OpenPrView),
    undefined,
    "a PR@head this cache never observed is never declined",
  );
});
