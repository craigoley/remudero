import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureFeedback,
  feedbackEntryPath,
  isValidFeedbackOrigin,
  readFeedbackEntry,
  type FeedbackOrigin,
} from "../src/lib/feedback.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  dueRepairFilings,
  renderRepairFilingRaw,
  runSweep,
  type CiFailure,
  type FixDispatchEvidence,
  type OpenPrView,
  type RepairFilingCapture,
  type RepairFilingRecurrence,
  type SweepDeps,
  type SweepPolicy,
} from "../src/lib/sweep.js";

/**
 * W1-T905 — "repair the instance, FILE THE CLASS" (fb-1784842083584-6cc22a, second half).
 * Falsifies every acceptance claim in plan/tasks.d/W1-T905-repair-files-the-class.yaml:
 *   1) a classified surface repaired >= threshold times inside the window files EXACTLY ONE
 *      machine-origin feedback entry naming that surface.
 *   2) fewer than threshold files NOTHING, and threshold/window are policy-driven, never a
 *      sweep.ts literal.
 *   3) a second pass over the same recurring surface files nothing new — the deterministic id
 *      is the whole dedup, no second store.
 *   4) the entry carries observed evidence (PR numbers, disposition reason, failing-check
 *      names) off the existing sweep.disposed rows, and is a feedback entry (status new),
 *      never a task.
 *   5) a capture/landing failure is best-effort — it never blocks the repair or the rest of
 *      the pass.
 *   6) `repair#<surface>` is a first-class term in the closed origin grammar (also grepped
 *      directly in src/lib/feedback.ts, per this task's own proof).
 */

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-repair-filing-")), "ledger.ndjson");
}

function root(): string {
  return mkdtempSync(join(tmpdir(), "rmd-repair-filing-root-"));
}

// A window-anchored "now" — an exact integer ms, matching Date.parse's own contract, so the
// bucket math (`Math.floor(now / windowMs)`) is exact and every fixture below can reason about
// which window it falls in without approximation.
const NOW = Date.parse("2026-08-16T12:00:00Z");
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const THRESHOLD = 3;
const POLICY: Pick<SweepPolicy, "repairFilingThreshold" | "repairFilingWindowDays"> = {
  repairFilingThreshold: THRESHOLD,
  repairFilingWindowDays: WINDOW_DAYS,
};

/** One synthetic `sweep.disposed acted:true` ledger row — the exact shape `finalizeDisposition`
 *  (src/lib/sweep.ts) writes, built directly (never via a full runSweep pass) for the pure-fold
 *  tests below, mirroring the house "seed raw ledger rows" style. */
function disposedRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    run_id: "SWEEP-1",
    task_id: "SWEEP",
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

/** N distinct-PR `blocked-fixable` rows for one surface, all inside the current window. */
function distinctRows(n: number, disposition = "blocked-fixable", reason?: (i: number) => string): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) =>
    disposedRow({
      pr_number: 100 + i,
      pr_url: `https://github.com/o/r/pull/${100 + i}`,
      head_sha: `sha${i}`,
      disposition,
      reason: reason ? reason(i) : `required checks red — ci-log fix, strike 1/2 (pr ${100 + i})`,
    }),
  );
}

// ── dueRepairFilings (pure fold) ──────────────────────────────────────────────

test("dueRepairFilings: fewer than threshold distinct PRs for a surface files NOTHING (acceptance 2)", () => {
  const rows = distinctRows(THRESHOLD - 1);
  assert.deepEqual(dueRepairFilings(rows, NOW, POLICY), []);
});

test("dueRepairFilings: exactly threshold distinct PRs for one surface is due — ONE candidate, sized to the count (acceptance 1)", () => {
  const rows = distinctRows(THRESHOLD);
  const due = dueRepairFilings(rows, NOW, POLICY);
  assert.equal(due.length, 1);
  assert.equal(due[0].surface, "blocked-fixable");
  assert.equal(due[0].instances.length, THRESHOLD);
  assert.deepEqual(
    due[0].instances.map((i) => i.prNumber),
    [100, 101, 102],
  );
});

test("dueRepairFilings: a SINGLE PR re-dispatched many times counts ONCE — distinct PRs, never raw rows (the flood-risk this task's own risk note names)", () => {
  const rows = Array.from({ length: THRESHOLD + 5 }, (_, i) =>
    disposedRow({ pr_number: 42, head_sha: `sha${i}`, reason: `strike ${i + 1}/2` }),
  );
  assert.deepEqual(dueRepairFilings(rows, NOW, POLICY), [], "one PR retried repeatedly is one instance, not a recurrence");
});

test("dueRepairFilings: 'mergeable' (armed, the HEALTHY outcome) never files however many distinct PRs recur — it is not a defect surface", () => {
  const rows = distinctRows(THRESHOLD + 10, "mergeable");
  assert.deepEqual(dueRepairFilings(rows, NOW, POLICY), []);
});

test("dueRepairFilings: a row NOT acted (deduped/stood-down) never counts toward recurrence", () => {
  const rows = distinctRows(THRESHOLD).map((r) => ({ ...r, acted: false }));
  assert.deepEqual(dueRepairFilings(rows, NOW, POLICY), []);
});

test("dueRepairFilings: an instance outside the CURRENT window is excluded — an old repair does not count toward today's recurrence", () => {
  const stale = distinctRows(THRESHOLD).map((r) => ({ ...r, ts: new Date(NOW - WINDOW_MS * 2).toISOString() }));
  assert.deepEqual(dueRepairFilings(stale, NOW, POLICY), []);
});

test("dueRepairFilings: threshold/window are POLICY-DRIVEN, not a sweep.ts literal — the SAME rows are due under a loose policy and not due under a strict one", () => {
  const rows = distinctRows(THRESHOLD);
  assert.equal(dueRepairFilings(rows, NOW, { repairFilingThreshold: THRESHOLD, repairFilingWindowDays: WINDOW_DAYS }).length, 1);
  assert.equal(
    dueRepairFilings(rows, NOW, { repairFilingThreshold: THRESHOLD + 1, repairFilingWindowDays: WINDOW_DAYS }).length,
    0,
    "raising the threshold by ONE policy edit, no code change, must un-file the same rows",
  );
});

test("dueRepairFilings: the SHIPPED plan/policy.yaml carries a real P37 threshold/window row — DEFAULT_SWEEP_POLICY is not a hand-built test double", () => {
  assert.equal(typeof DEFAULT_SWEEP_POLICY.repairFilingThreshold, "number");
  assert.ok(DEFAULT_SWEEP_POLICY.repairFilingThreshold >= 2, "design ii: a threshold of 1 would file on the first repair");
  assert.equal(typeof DEFAULT_SWEEP_POLICY.repairFilingWindowDays, "number");
  assert.ok(DEFAULT_SWEEP_POLICY.repairFilingWindowDays >= 1);
});

test("dueRepairFilings: the id is DETERMINISTIC for the SAME surface+window (acceptance 3's underpinning) and CHANGES for a different window", () => {
  const rows = distinctRows(THRESHOLD);
  const firstCall = dueRepairFilings(rows, NOW, POLICY);
  const secondCall = dueRepairFilings([...rows, ...distinctRows(2).map((r) => ({ ...r, pr_number: (r.pr_number as number) + 1000 }))], NOW, POLICY);
  assert.equal(firstCall[0].id, secondCall[0].id, "same surface, same window — the id must not depend on how many extra instances piled on");
  const nextWindow = dueRepairFilings(rows.map((r) => ({ ...r, ts: new Date(NOW + WINDOW_MS).toISOString() })), NOW + WINDOW_MS, POLICY);
  assert.notEqual(nextWindow[0].id, firstCall[0].id, "a genuinely later window must mint a fresh id, or a persisting defect could never be reported twice");
});

test("dueRepairFilings: distinct surfaces due in the same pass are reported independently, each with its own id", () => {
  const rows = [...distinctRows(THRESHOLD, "blocked-fixable"), ...distinctRows(THRESHOLD, "stale", () => "abandoned")];
  const due = dueRepairFilings(rows, NOW, POLICY);
  assert.equal(due.length, 2);
  assert.deepEqual(
    due.map((d) => d.surface).sort(),
    ["blocked-fixable", "stale"],
  );
  assert.notEqual(due[0].id, due[1].id);
});

// ── renderRepairFilingRaw (pure evidence render) ──────────────────────────────

test("renderRepairFilingRaw: carries every PR number/url/sha and its own ledgered reason verbatim — including an embedded failing-check name+sha — never invents a cause (acceptance 4)", () => {
  const filing: RepairFilingRecurrence = {
    surface: "blocked-ambiguous",
    threshold: THRESHOLD,
    windowDays: WINDOW_DAYS,
    windowStart: new Date(NOW - WINDOW_MS).toISOString(),
    windowEnd: new Date(NOW).toISOString(),
    instances: [
      { prNumber: 201, prUrl: "https://github.com/o/r/pull/201", headSha: "deadbeef", ts: new Date(NOW).toISOString(), reason: "fix strikes exhausted (2/2) — commitlint failed on deadbee — escalating" },
      { prNumber: 202, prUrl: "https://github.com/o/r/pull/202", headSha: "cafef00d", ts: new Date(NOW).toISOString(), reason: "fix strikes exhausted (2/2) — tsc failed on cafef00 — escalating" },
      { prNumber: 203, prUrl: "https://github.com/o/r/pull/203", headSha: "0ff1ce00", ts: new Date(NOW).toISOString(), reason: "fix strikes exhausted (2/2) — lint failed on 0ff1ce0 — escalating" },
    ],
    id: "fb-repair-blocked-ambiguous-1",
  };
  const raw = renderRepairFilingRaw(filing);
  assert.match(raw, /blocked-ambiguous/);
  assert.match(raw, /3 distinct PRs/);
  for (const i of filing.instances) {
    assert.ok(raw.includes(`#${i.prNumber}`), `must name PR #${i.prNumber}`);
    assert.ok(raw.includes(i.prUrl), `must carry ${i.prUrl}`);
    assert.ok(raw.includes(i.reason), `must carry ${i.prNumber}'s own reason verbatim, including its embedded check name/sha`);
  }
  assert.match(raw, /commitlint failed on deadbee/, "a failing check name+sha already ledgered on a row must survive into the evidence");
  assert.match(raw, /UNOBSERVED/i, "root cause must be stated as unobserved, never invented (design v)");
});

// ── runSweep wiring — SweepDeps.captureRepairFeedback ─────────────────────────

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

/** A distinct blocked-fixable (checks red, positively fixable) PR — same shape as
 *  test/sweep.test.ts's own `blockedFixablePr`, parameterized so N distinct PRs are cheap. Each
 *  PR fails a DIFFERENT named check (W1-T527's `isPositivelyFixable` classifier stands down a
 *  fix dispatch as "base-caused" when the SAME check name fails on every open PR in the pass —
 *  distinct names keep every one of these positively fixable, per-diff). */
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
    captureRepairFeedback: (filing) => {
      captures.push(filing);
    },
    ...overrides,
  };
}

test("runSweep: THRESHOLD distinct blocked-fixable PRs in ONE pass invoke captureRepairFeedback EXACTLY ONCE, naming the surface (acceptance 1)", async () => {
  const deps = fakeDeps();
  const prs = Array.from({ length: THRESHOLD }, (_, i) => blockedFixablePrN(300 + i));
  await runSweep(prs, deps, { ...DEFAULT_SWEEP_POLICY, ...POLICY });

  assert.equal(deps.captures.length, 1, "exactly one filing for the one recurring surface");
  const filing = deps.captures[0];
  assert.equal(filing.origin, "repair#blocked-fixable");
  assert.ok(isValidFeedbackOrigin(filing.origin), "the produced origin must be well-formed per the closed grammar (acceptance 6)");
  for (const p of prs) assert.ok(filing.raw.includes(`#${p.prNumber}`), `evidence must name PR #${p.prNumber}`);
});

test("runSweep: FEWER than threshold distinct PRs never invokes captureRepairFeedback (acceptance 2)", async () => {
  const deps = fakeDeps();
  const prs = Array.from({ length: THRESHOLD - 1 }, (_, i) => blockedFixablePrN(400 + i));
  await runSweep(prs, deps, { ...DEFAULT_SWEEP_POLICY, ...POLICY });
  assert.equal(deps.captures.length, 0);
});

test("runSweep: captureRepairFeedback omitted — no crash, the sweep behaves exactly as before this task", async () => {
  const deps = fakeDeps({ captureRepairFeedback: undefined });
  const prs = Array.from({ length: THRESHOLD }, (_, i) => blockedFixablePrN(500 + i));
  const summary = await runSweep(prs, deps, { ...DEFAULT_SWEEP_POLICY, ...POLICY });
  assert.equal(summary.actionsTaken, THRESHOLD);
});

test("runSweep: --dry-run leaves NO repair-filing trace, exactly like every other action in this module", async () => {
  const deps = fakeDeps({ dryRun: true });
  const prs = Array.from({ length: THRESHOLD }, (_, i) => blockedFixablePrN(600 + i));
  await runSweep(prs, deps, { ...DEFAULT_SWEEP_POLICY, ...POLICY });
  assert.equal(deps.captures.length, 0);
});

test("runSweep: a captureRepairFeedback throw is swallowed — the pass still returns its summary and every PR's own disposition is untouched (acceptance 5)", async () => {
  const deps = fakeDeps({
    captureRepairFeedback: () => {
      throw new Error("landing exploded");
    },
  });
  const prs = Array.from({ length: THRESHOLD }, (_, i) => blockedFixablePrN(700 + i));
  const summary = await runSweep(prs, deps, { ...DEFAULT_SWEEP_POLICY, ...POLICY });

  assert.equal(summary.actionsTaken, THRESHOLD, "every PR's own repair still counted — the filing failure never touched it");
  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, THRESHOLD, "every PR's own sweep.disposed row still landed");

  // The pass is not left corrupted: a later pass over the SAME ledger still works normally
  // (a FRESH PR, never seen before — a re-swept PR at the same head would legitimately dedup).
  const again = await runSweep([blockedFixablePrN(799)], { ...deps, captureRepairFeedback: undefined }, { ...DEFAULT_SWEEP_POLICY, ...POLICY });
  assert.equal(again.actionsTaken, 1);
});

test("runSweep: one due surface's capture throwing does not stop a DIFFERENT due surface's capture in the same pass", async () => {
  const seen: string[] = [];
  const deps = fakeDeps({
    captureRepairFeedback: (filing) => {
      seen.push(filing.origin);
      if (filing.origin === "repair#blocked-fixable") throw new Error("boom");
    },
  });
  const fixable = Array.from({ length: THRESHOLD }, (_, i) => blockedFixablePrN(800 + i));
  const stale = Array.from({ length: THRESHOLD }, (_, i) =>
    pr({ prNumber: 900 + i, prUrl: `url/${900 + i}`, taskId: `W1-STALE${i}`, headSha: `sha-stale-${i}`, supersededBy: 999, lastActivityAt: RECENT }),
  );
  await runSweep([...fixable, ...stale], deps, { ...DEFAULT_SWEEP_POLICY, ...POLICY });
  assert.deepEqual(seen.sort(), ["repair#blocked-fixable", "repair#stale"], "both surfaces were attempted despite the first one throwing");
});

// ── Real wiring: SweepDeps.captureRepairFeedback bound to the ACTUAL captureFeedback +
// existsSync dedup (mirrors src/run-task.ts's buildSweepEffects default, without importing
// run-task.ts) — the strongest available proof of acceptance 3 and 4's "feedback entry with
// status new, never a task" claim, since this exercises the real filesystem write.

function realCaptureRepairFeedback(r: string): (filing: RepairFilingCapture) => void {
  return (filing) => {
    if (existsSync(feedbackEntryPath(r, filing.id))) return; // the whole dedup — no second store
    captureFeedback(r, { id: filing.id, raw: filing.raw, origin: filing.origin as FeedbackOrigin });
  };
}

test("runSweep + real captureFeedback: files plan/feedback/<id>.yaml with status new, origin repair#<surface>, and creates NO task (acceptance 4)", async () => {
  const r = root();
  const deps = fakeDeps({ captureRepairFeedback: realCaptureRepairFeedback(r) });
  const prs = Array.from({ length: THRESHOLD }, (_, i) => blockedFixablePrN(1000 + i));
  await runSweep(prs, deps, { ...DEFAULT_SWEEP_POLICY, ...POLICY });

  const due = dueRepairFilings(readLedgerLines(deps.ledgerPath), NOW, POLICY);
  assert.equal(due.length, 1);
  const entry = readFeedbackEntry(r, due[0].id);
  assert.equal(entry.status, "new");
  assert.equal(entry.origin, "repair#blocked-fixable");
  assert.ok(entry.raw.length > 0);
  assert.equal(existsSync(join(r, "plan", "tasks.d")), false, "never a task — no plan/tasks.d/ directory was ever created");
});

test("runSweep + real captureFeedback: a SECOND pass over the SAME recurring surface, SAME window, files NOTHING NEW — the deterministic id is the whole dedup (acceptance 3)", async () => {
  const r = root();
  const first = fakeDeps({ captureRepairFeedback: realCaptureRepairFeedback(r) });
  const prs = Array.from({ length: THRESHOLD }, (_, i) => blockedFixablePrN(1100 + i));
  await runSweep(prs, first, { ...DEFAULT_SWEEP_POLICY, ...POLICY });

  const filedBefore = readFeedbackEntry(r, dueRepairFilings(readLedgerLines(first.ledgerPath), NOW, POLICY)[0]?.id ?? "missing");
  assert.equal(filedBefore.status, "new");

  // A second pass, same ledger, one MORE distinct PR recurring on the SAME surface inside the
  // SAME window — the surface is still due (same id), but the real dedup must file nothing new.
  const second = fakeDeps({ ledgerPath: first.ledgerPath, captureRepairFeedback: realCaptureRepairFeedback(r) });
  await runSweep([blockedFixablePrN(1200)], second, { ...DEFAULT_SWEEP_POLICY, ...POLICY });

  const { readdirSync } = await import("node:fs");
  const filedEntries = readdirSync(join(r, "plan", "feedback")).filter((f: string) => f.endsWith(".yaml"));
  assert.equal(filedEntries.length, 1, "one recurring surface, one window, ONE entry — the second pass filed nothing new");
});
