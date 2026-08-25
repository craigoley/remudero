import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  dispatchFixSpent,
  dueRepairFilings,
  renderRepairFilingRaw,
  runSweep,
  type CiFailure,
  type FixDispatchEvidence,
  type OpenPrView,
  type RepairFilingCapture,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";

/**
 * W1-T2231 — `acted: true` proves only that the `blocked-fixable`/`conflicted` lane was
 * INVOKED, never that it repaired anything: `case "blocked-fixable"` (and its `"conflicted"`
 * sibling) `await deps.dispatchFix(...)` and never assign `acted`, so a dispatch that stands
 * down INSIDE itself — the merge-state-dirty refusal is the live example, run-task.ts's own
 * `dispatchStarted` names the shape — writes no `fix.dispatch` row at all and the disposed line
 * still reads `acted: true`. `dueRepairFilings` counted that row as one of the DISTINCT PRs
 * "repaired" toward `policy.repairFilingThreshold`, and could carry its `reason`/`head_sha` as
 * the filed §7B exemplar.
 *
 * The remedy (design note (i) of the plan record) is a SECOND field, never a redefinition of
 * `acted`: `deps.dispatchFix` may now return whether it demonstrably spent a strike, sweep.ts
 * records that on the disposed line as `spent`, and `dueRepairFilings` excludes only an EXPLICIT
 * `spent: false` — never re-joining on `task_id` (rationale (5): a `task_id: "SWEEP"` seed is
 * unjoinable BY CONSTRUCTION and must never be conflated with a genuine no-spend stand-down).
 *
 * Six acceptance claims, each proven below:
 *   1. a dispatch that opened no strike is not counted as a repair.
 *   2. a dispatch that did open a strike is still counted exactly as today.
 *   3. the filed exemplar never cites a row whose lane spent nothing.
 *   4. a seed row carrying the synthetic SWEEP task id is not silently counted as a repair.
 *   5. the dedup gate still seeds from acted true — untouched by this task (design (ii)/(iii)).
 *   6. a cancelled-check stand-down still records acted false and still avoids seeding the fix
 *      dedup — an existing, unrelated `acted:false` path this task must not disturb.
 */

const NOW = Date.parse("2026-08-16T12:00:00Z");
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const THRESHOLD = 3;
const POLICY: Pick<SweepPolicy, "repairFilingThreshold" | "repairFilingWindowDays"> = {
  repairFilingThreshold: THRESHOLD,
  repairFilingWindowDays: WINDOW_DAYS,
};

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-repair-filing-invocations-")), "ledger.ndjson");
}

/** One synthetic `sweep.disposed acted:true` ledger row — the exact shape `finalizeDisposition`
 *  (src/lib/sweep.ts) writes, built directly (mirroring test/sweep-repair-filing.test.ts's own
 *  "seed raw ledger rows" style) for the pure-fold tests below. */
function disposedRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    run_id: "SWEEP-1",
    task_id: "W1-FIX",
    step: "sweep.disposed",
    pr_number: 1,
    pr_url: "https://github.com/o/r/pull/1",
    disposition: "blocked-fixable",
    acted: true,
    reason: "required checks red — ci-log fix, strike 1/2",
    head_sha: "aaaa111",
    ts: new Date(NOW).toISOString(),
    ...over,
  };
}

/** N distinct-PR `blocked-fixable` rows, all inside the current window, sharing one `spent`
 *  verdict (or carrying none at all when omitted — "today's" pre-existing shape). */
function distinctRows(n: number, spent?: boolean, taskId?: string): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) =>
    disposedRow({
      pr_number: 100 + i,
      pr_url: `https://github.com/o/r/pull/${100 + i}`,
      head_sha: `sha${i}`,
      task_id: taskId ?? `W1-FIX${i}`,
      reason: `required checks red — ci-log fix, strike 1/2 (pr ${100 + i})`,
      ...(spent !== undefined ? { spent } : {}),
    }),
  );
}

// ── dueRepairFilings (pure fold) — acceptance 1, 2, 4 ────────────────────────────────────────

test("dueRepairFilings: acted:true rows whose dispatch spent NOTHING (spent:false) are not counted as a repair (acceptance 1)", () => {
  const rows = distinctRows(THRESHOLD, false);
  assert.deepEqual(dueRepairFilings(rows, NOW, POLICY), [], "every row was invoked but spent nothing — no recurrence is due");
});

test("dueRepairFilings: mixing spending and non-spending rows only counts the spending ones toward the threshold", () => {
  // THRESHOLD - 1 real repairs plus enough no-spend invocations to reach the threshold on raw
  // acted:true rows alone — if the count still read `acted`, this would be due; it must not be.
  const spending = distinctRows(THRESHOLD - 1, true);
  const notSpending = distinctRows(5, false).map((r, i) => ({ ...r, pr_number: (r.pr_number as number) + 1000, head_sha: `nospend${i}` }));
  assert.deepEqual(dueRepairFilings([...spending, ...notSpending], NOW, POLICY), []);
});

test("dueRepairFilings: a dispatch that DID open a strike (spent:true) is still counted exactly as today (acceptance 2)", () => {
  const rows = distinctRows(THRESHOLD, true);
  const due = dueRepairFilings(rows, NOW, POLICY);
  assert.equal(due.length, 1);
  assert.equal(due[0].surface, "blocked-fixable");
  assert.deepEqual(
    due[0].instances.map((i) => i.prNumber),
    [100, 101, 102],
  );
});

test("dueRepairFilings: a row carrying NO spent field at all (every pre-2231 ledger row, and every non-dispatch surface) counts exactly as before (acceptance 2)", () => {
  const rows = distinctRows(THRESHOLD); // no `spent` key — the shape every existing ledger row has
  const due = dueRepairFilings(rows, NOW, POLICY);
  assert.equal(due.length, 1, "undefined is never read as a no-spend exclusion — only an explicit false is");
  assert.equal(due[0].instances.length, THRESHOLD);
});

test("dueRepairFilings: `stale`/`blocked-ambiguous` rows (no dispatch verb, no spend concept) count off acted alone, unchanged", () => {
  const rows = Array.from({ length: THRESHOLD }, (_, i) =>
    disposedRow({ pr_number: 200 + i, pr_url: `https://github.com/o/r/pull/${200 + i}`, head_sha: `stale${i}`, disposition: "stale", reason: "abandoned" }),
  );
  const due = dueRepairFilings(rows, NOW, POLICY);
  assert.equal(due.length, 1, "a surface this task never touches (design note (vii)) still files exactly as before");
});

test("dueRepairFilings: a seed row carrying the synthetic SWEEP task id is not silently counted as a repair when it spent nothing (acceptance 4)", () => {
  const rows = distinctRows(THRESHOLD, false, "SWEEP");
  assert.deepEqual(dueRepairFilings(rows, NOW, POLICY), [], "task_id is never the join key — spent:false alone excludes it");
});

test("dueRepairFilings: a seed row carrying the synthetic SWEEP task id IS counted when it genuinely spent — the exclusion is keyed off `spent`, never off task_id (acceptance 4)", () => {
  const rows = distinctRows(THRESHOLD, true, "SWEEP");
  const due = dueRepairFilings(rows, NOW, POLICY);
  assert.equal(due.length, 1, "an unjoinable task_id must never be conflated with a no-spend stand-down (rationale (5))");
});

// ── the filed exemplar — acceptance 3 ────────────────────────────────────────────────────────

test("dueRepairFilings: the filed exemplar never cites a row whose lane spent nothing, even when it is the MOST RECENT row for that PR (acceptance 3)", () => {
  // Each of THRESHOLD distinct PRs gets TWO rows in append order: an earlier REAL repair
  // (spent:true) and a later invocation that stood down internally and spent nothing
  // (spent:false) — the exact "dispatchFix can stand down cleanly... and write no fix.dispatch
  // row at all" shape the plan record's rationale (1) names. Last-write-wins per PR must never
  // let the later no-spend row overwrite the earlier real repair's evidence.
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < THRESHOLD; i++) {
    const prNumber = 100 + i;
    const prUrl = `https://github.com/o/r/pull/${prNumber}`;
    rows.push(
      disposedRow({
        pr_number: prNumber,
        pr_url: prUrl,
        head_sha: `sha${i}-real`,
        spent: true,
        reason: `REAL REPAIR: fix landed for pr ${prNumber}`,
        ts: new Date(NOW - 2000).toISOString(),
      }),
    );
    rows.push(
      disposedRow({
        pr_number: prNumber,
        pr_url: prUrl,
        head_sha: `sha${i}-real`,
        spent: false,
        reason: `STOOD DOWN, NOTHING SPENT for pr ${prNumber}`,
        ts: new Date(NOW - 1000).toISOString(),
      }),
    );
  }

  const due = dueRepairFilings(rows, NOW, POLICY);
  assert.equal(due.length, 1);
  assert.equal(due[0].instances.length, THRESHOLD);
  for (const instance of due[0].instances) {
    assert.match(instance.reason, /^REAL REPAIR:/, "the exemplar must carry the SPENDING row's own reason");
    assert.doesNotMatch(instance.reason, /STOOD DOWN/, "a no-spend invocation must never become the filed exemplar");
  }

  const raw = renderRepairFilingRaw(due[0]);
  assert.doesNotMatch(raw, /STOOD DOWN/, "the rendered evidence body must never quote a no-spend row either");
});

test("dispatchFixSpent: undefined (void return — every pre-existing fake, and today's real wiring) reads as spent, unchanged from before this task", () => {
  assert.equal(dispatchFixSpent(undefined), true);
  assert.equal(dispatchFixSpent(true), true);
  assert.equal(dispatchFixSpent(false), false);
});

// ── runSweep wiring: dispatchFix's own return value drives `spent` end to end ───────────────

const RECENT = new Date(NOW - 60_000).toISOString();

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

/** A distinct blocked-fixable PR (checks red, positively fixable) — same shape as
 *  test/sweep-repair-filing.test.ts's own `blockedFixablePrN`, each failing a DIFFERENTLY named
 *  check so `classifyRedCause` never reads them as "base-caused" (which would stand down before
 *  ever reaching `dispatchFix`). */
function blockedFixablePrN(n: number): OpenPrView {
  return pr({
    prNumber: n,
    prUrl: `https://github.com/o/r/pull/${n}`,
    taskId: `W1-FIX${n}`,
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    headSha: `sha-fix-${n}`,
    ciFailures: [{ name: `commitlint-${n}`, logTail: "header too long" } as CiFailure],
  });
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & { captures: RepairFilingCapture[] } {
  const captures: RepairFilingCapture[] = [];
  return {
    captures,
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: ledgerPath(),
    runId: "SWEEP-1",
    now: () => NOW,
    // Same seam test/sweep-repair-filing.test.ts documents at length: `dueRepairFilings` buckets
    // by absolute epoch time off each row's OWN `ts`, and `appendLedger` stamps a REAL wall-clock
    // `ts` unless the injected `appendLine` overrides it — so every row a real `runSweep` pass
    // writes here is pinned to the fixed `NOW` rather than silently drifting out of its window.
    appendLine: (path, line) => appendLedger(path, { ...line, ts: new Date(NOW).toISOString() }),
    captureRepairFeedback: (filing) => {
      captures.push(filing);
    },
    ...overrides,
  };
}

test("runSweep: THRESHOLD distinct blocked-fixable PRs whose dispatchFix reports NO spend never invoke captureRepairFeedback (acceptance 1, end to end)", async () => {
  const deps = fakeDeps({ dispatchFix: () => false });
  const prs = Array.from({ length: THRESHOLD }, (_, i) => blockedFixablePrN(300 + i));
  const summary = await runSweep(prs, deps, { ...DEFAULT_SWEEP_POLICY, ...POLICY });

  // The lane WAS invoked — `acted` is untouched by this task and stays true, exactly as the
  // plan record's rationale (1) describes.
  assert.equal(summary.actionsTaken, THRESHOLD, "acted stays true — the lane fired, this task never redefines it");
  for (const a of summary.actions) assert.equal(a.acted, true);

  // But nothing was REPAIRED — no strike was spent — so the surface must never reach filing.
  assert.equal(deps.captures.length, 0, "an invocation that spent nothing must never file a repair recurrence");

  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, THRESHOLD);
  for (const line of disposed) {
    assert.equal(line.acted, true);
    assert.equal(line.spent, false, "the disposed row itself carries the no-spend verdict dueRepairFilings reads");
  }
});

test("runSweep: THRESHOLD distinct blocked-fixable PRs whose dispatchFix reports a real spend still files exactly as today (acceptance 2, end to end)", async () => {
  const deps = fakeDeps({ dispatchFix: () => true });
  const prs = Array.from({ length: THRESHOLD }, (_, i) => blockedFixablePrN(400 + i));
  await runSweep(prs, deps, { ...DEFAULT_SWEEP_POLICY, ...POLICY });

  assert.equal(deps.captures.length, 1, "a genuinely spending surface still files exactly once");
  assert.equal(deps.captures[0].origin, "repair#blocked-fixable");
});

test("runSweep: a dispatchFix fake returning nothing (void — today's real wiring) still files exactly as before this task (acceptance 2, real-wiring parity)", async () => {
  const deps = fakeDeps(); // default dispatchFix: () => {} — returns void, like run-task.ts today
  const prs = Array.from({ length: THRESHOLD }, (_, i) => blockedFixablePrN(1500 + i));
  await runSweep(prs, deps, { ...DEFAULT_SWEEP_POLICY, ...POLICY });

  assert.equal(deps.captures.length, 1, "a void-returning dispatchFix (unmodified real wiring) must not regress today's filing behavior");
  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  for (const line of disposed) assert.equal(line.spent, undefined, "a void return writes no `spent` field at all — no existing row's shape changes");
});

// ── acceptance 5 — the dedup gate still seeds off acted:true, untouched ─────────────────────

test("runSweep: the fix-rung dedup gate still seeds from acted:true alone, never from spent (acceptance 5)", async () => {
  const shared = ledgerPath();
  const subject = blockedFixablePrN(600);
  const fixedCalls: unknown[] = [];

  // The fix rung's own worker DID demonstrably run and write its OWNING `fix.dispatch` row —
  // W1-T1110's SEPARATE "no owning row" re-arm (test/sweep.test.ts's `noRowDispatchFix` cases)
  // must not confound this test, which is about `spent` alone, never about that other gate.
  // Reporting `spent: false` here anyway proves the dedup gate ignores `spent` entirely: a row
  // this task itself would exclude from `dueRepairFilings` must still suppress a repeat dispatch.
  const first = fakeDeps({
    ledgerPath: shared,
    dispatchFix: (p, evidence) => {
      fixedCalls.push({ p, evidence });
      appendLedger(shared, { run_id: "SWEEP-1", task_id: p.taskId ?? "SWEEP", step: "fix.dispatch", strike: 1 });
      return false;
    },
  });
  await runSweep([subject], first, DEFAULT_SWEEP_POLICY);
  assert.equal(fixedCalls.length, 1, "the first pass dispatched once");
  const seeded = readLedgerLines(shared).find((l) => l.step === "sweep.disposed");
  assert.equal(seeded?.acted, true, "acted:true, unchanged by this task");
  assert.equal(seeded?.spent, false, "this row would be EXCLUDED from dueRepairFilings — the point of this task");

  // Second pass, SAME ledger, SAME PR/head — `priorActionsFromLedger`'s `fixed` set (the dedup
  // gate) is keyed off `acted:true` on the `sweep.disposed` row alone, never off `spent` (design
  // note (ii)/(iii): "nothing in this task touches that call site or its five sets"). It must
  // keep suppressing this head exactly as it always has, even though `dueRepairFilings` would
  // now read the seeding row as no repair at all.
  const second = fakeDeps({ ledgerPath: shared, dispatchFix: (p, evidence) => { fixedCalls.push({ p, evidence }); return true; } });
  await runSweep([subject], second, DEFAULT_SWEEP_POLICY);
  assert.equal(fixedCalls.length, 1, "the SAME head is still deduped — the gate never re-derived a second dispatch for it");
});

// ── acceptance 6 — an existing, unrelated acted:false path is left untouched ─────────────────

test("runSweep: a cancelled-check stand-down still records acted:false and never seeds the fix dedup, unaffected by this task (acceptance 6)", async () => {
  const shared = ledgerPath();
  // Red ONLY because its one required check was cancelled — the SAME #2434/#2444 shape
  // test/cancelled-required-check-requeue.test.ts covers: `genuineFailures` is empty, so the
  // "blocked-fixable" case stands down BEFORE ever reaching `dispatchFix`.
  const subject = blockedFixablePrN(700);
  subject.ciFailures = [{ name: "coverage-ratchet", logTail: "" }];
  subject.cancelledRequiredChecks = [{ name: "coverage-ratchet", jobId: "12345" }];

  const fixedCalls: unknown[] = [];
  const first = fakeDeps({
    ledgerPath: shared,
    dispatchFix: (p, evidence) => {
      fixedCalls.push({ p, evidence });
      return true;
    },
    requeueCheck: async () => {},
  });
  const summary = await runSweep([subject], first, DEFAULT_SWEEP_POLICY);

  assert.equal(fixedCalls.length, 0, "a cancelled-only red verdict never reaches dispatchFix — untouched by this task");
  assert.equal(summary.actions[0].acted, false, "this stand-down still records acted:false exactly as before");
  const disposed = readLedgerLines(shared).find((l) => l.step === "sweep.disposed");
  assert.equal(disposed?.acted, false);
  assert.equal(disposed?.spent, undefined, "no dispatch ever ran — spent is never written for it");

  // A later pass over the SAME still-cancelled head must still be free to re-dispatch/re-queue —
  // acted:false never seeded `prior.fixed`, so nothing here dedupes it away.
  const second = fakeDeps({
    ledgerPath: shared,
    dispatchFix: (p, evidence) => {
      fixedCalls.push({ p, evidence });
      return true;
    },
    requeueCheck: async () => {},
  });
  await runSweep([subject], second, DEFAULT_SWEEP_POLICY);
  assert.equal(fixedCalls.length, 0, "still no fix-rung strike spent on a cancelled-only verdict, second pass included");
});

test("dueRepairFilings: WINDOW_MS import guard — the exemplar test's two-row-per-PR fixture stays inside ONE window bucket", () => {
  // Sanity check on the fixture's own timing math above (a silent drift here would make the
  // acceptance-3 test pass for the wrong reason: rows landing in different buckets entirely).
  const bucket = Math.floor(NOW / WINDOW_MS);
  const earlier = Math.floor((NOW - 2000) / WINDOW_MS);
  assert.equal(bucket, earlier, "both rows in the exemplar fixture must land in the SAME window bucket as NOW");
});
