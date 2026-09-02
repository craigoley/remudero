import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { renderDigest, summarize } from "../src/lib/digest.js";
import { feedbackDir, feedbackEntryPath, readFeedbackEntry, type FeedbackEntry, type FeedbackStatus } from "../src/lib/feedback.js";
import type { RepairFilingCapture } from "../src/lib/sweep.js";
import { captureRepairFeedbackWithPriorVerdict, latestPriorVerdictSuppresses } from "../src/run-task.js";

/**
 * W1-T2416 — "THE REPAIR-RECURRENCE FILER HAS NO MEMORY OF ITS OWN VERDICT". Falsifies every
 * acceptance claim in plan/tasks.d/W1-T2416-a-rejected-recurrence-refiles-every-window.yaml:
 * a due surface whose most recent `repair#<surface>` entry was REJECTED must file no new
 * feedback entry, matched on the origin surface (never the window-keyed id), scoped to that one
 * surface, ledgering a `sweep.repair_filing_suppressed` row so the suppression is never silent,
 * failing OPEN on a read error, and leaving both the "no prior entry" and "same window" cases
 * exactly as they behave today.
 */

function root(): string {
  return mkdtempSync(join(tmpdir(), "rmd-repair-verdict-root-"));
}

/** A plain (in-memory, no disk) {@link FeedbackEntry} fixture — every required field defaulted
 *  so a test only spells out what it cares about. */
function feedbackEntry(over: Pick<FeedbackEntry, "id" | "origin" | "status"> & Partial<FeedbackEntry>): FeedbackEntry {
  return {
    ts: new Date().toISOString(),
    raw: "seed entry",
    attachments: [],
    reply_to: null,
    proposal_pr: null,
    summary: null,
    expansion: null,
    submission_key: null,
    ...over,
  };
}

/** Write a {@link FeedbackEntry} straight to `plan/feedback/<id>.yaml`, bypassing
 *  `captureFeedback` (its landing/upstream side effects, and its wall-clock `ts`) so a test can
 *  pin `ts`/`status` exactly. Mirrors `captureFeedback`'s own write shape byte-for-byte. */
function seedEntry(r: string, e: FeedbackEntry): FeedbackEntry {
  mkdirSync(feedbackDir(r), { recursive: true });
  writeFileSync(feedbackEntryPath(r, e.id), stringifyYaml(e));
  return e;
}

/** One `RepairFilingCapture` fixture — the exact shape `runSweep` (sweep.ts) hands
 *  `SweepDeps.captureRepairFeedback`, `raw` carrying THREE `- PR #` evidence lines (mirroring
 *  `renderRepairFilingRaw`'s own per-instance line) so the distinct-PR count parse has something
 *  real to count. */
function filing(over: Partial<RepairFilingCapture> = {}): RepairFilingCapture {
  return {
    id: "fb-repair-blocked-fixable-999",
    origin: "repair#blocked-fixable",
    raw: [
      'SWEEP REPAIR RECURRENCE: the "blocked-fixable" surface was repaired for 3 distinct PRs ' +
        "between 2026-08-27T00:00:00.000Z and 2026-09-03T00:00:00.000Z (threshold 3, window 7d).",
      "",
      "Root cause is UNOBSERVED — this is a recurrence report, not a diagnosis.",
      "",
      "EVIDENCE (read verbatim off each PR's own sweep.disposed ledger row, never invented):",
      "- PR #101 (https://github.com/o/r/pull/101) at aaa1111: required checks red — ci-log fix, strike 1/2",
      "- PR #102 (https://github.com/o/r/pull/102) at bbb2222: required checks red — ci-log fix, strike 2/2",
      "- PR #103 (https://github.com/o/r/pull/103) at ccc3333: required checks red — ci-log fix, strike 1/2",
    ].join("\n"),
    ...over,
  };
}

/** Records every `log(step, extra)` call a test's `captureRepairFeedbackWithPriorVerdict` call
 *  makes, so a suppression row is assertable without a real ledger file. */
function recorder(): { calls: Array<{ step: string; extra?: Record<string, unknown> }>; log: (step: string, extra?: Record<string, unknown>) => void } {
  const calls: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { calls, log: (step, extra) => calls.push({ step, extra }) };
}

// ── latestPriorVerdictSuppresses (pure) ───────────────────────────────────────

test("latestPriorVerdictSuppresses: no prior entries for this origin suppresses nothing", () => {
  assert.equal(latestPriorVerdictSuppresses([]), undefined);
});

test("latestPriorVerdictSuppresses: the most recent entry BY TS (not array order) rejected -- suppresses, returning that entry", () => {
  const newer = feedbackEntry({ id: "b", origin: "repair#blocked-fixable", status: "rejected", ts: "2026-08-20T00:00:00.000Z" });
  const older = feedbackEntry({ id: "a", origin: "repair#blocked-fixable", status: "rejected", ts: "2026-08-13T00:00:00.000Z" });
  // Deliberately passed OLDER-first so a naive "last element wins" implementation would fail.
  assert.equal(latestPriorVerdictSuppresses([older, newer]), newer);
});

test("latestPriorVerdictSuppresses: an OLDER rejected entry does not out-rule a NEWER non-rejected one (design ii)", () => {
  const older = feedbackEntry({ id: "a", origin: "repair#blocked-fixable", status: "rejected", ts: "2026-08-13T00:00:00.000Z" });
  const newer = feedbackEntry({ id: "b", origin: "repair#blocked-fixable", status: "accepted", ts: "2026-08-27T00:00:00.000Z" });
  assert.equal(latestPriorVerdictSuppresses([older, newer]), undefined, "the SURFACE'S OWN LATEST VERDICT rules, not any prior rejection");
});

for (const status of ["new", "grilling", "proposed", "accepted", "answered"] satisfies FeedbackStatus[]) {
  test(`latestPriorVerdictSuppresses: a lone prior entry with status "${status}" suppresses nothing`, () => {
    const entry = feedbackEntry({ id: "a", origin: "repair#blocked-fixable", status, ts: "2026-08-20T00:00:00.000Z" });
    assert.equal(latestPriorVerdictSuppresses([entry]), undefined);
  });
}

test("latestPriorVerdictSuppresses: a lone prior entry with status \"rejected\" suppresses, returning it", () => {
  const entry = feedbackEntry({ id: "a", origin: "repair#blocked-fixable", status: "rejected", ts: "2026-08-20T00:00:00.000Z" });
  assert.equal(latestPriorVerdictSuppresses([entry]), entry);
});

// ── captureRepairFeedbackWithPriorVerdict (effectful, real filesystem) ────────

test("captureRepairFeedbackWithPriorVerdict: a due surface with NO prior entry for its origin files exactly as it does today (acceptance: no prior entry)", () => {
  const r = root();
  const rec = recorder();
  captureRepairFeedbackWithPriorVerdict(r, filing(), rec.log);
  const entry = readFeedbackEntry(r, "fb-repair-blocked-fixable-999");
  assert.equal(entry.status, "new");
  assert.equal(entry.origin, "repair#blocked-fixable");
  assert.equal(rec.calls.length, 0, "no suppression row when nothing suppresses");
});

test("captureRepairFeedbackWithPriorVerdict: most recent prior entry for the SAME origin rejected -- files no new feedback entry (acceptance 1)", () => {
  const r = root();
  seedEntry(r, feedbackEntry({ id: "fb-repair-blocked-fixable-2954", origin: "repair#blocked-fixable", status: "rejected", ts: "2026-08-13T00:00:00.000Z" }));
  seedEntry(r, feedbackEntry({ id: "fb-repair-blocked-fixable-2955", origin: "repair#blocked-fixable", status: "rejected", ts: "2026-08-20T00:00:00.000Z" }));
  const rec = recorder();
  captureRepairFeedbackWithPriorVerdict(r, filing({ id: "fb-repair-blocked-fixable-2956" }), rec.log);
  assert.equal(existsSync(feedbackEntryPath(r, "fb-repair-blocked-fixable-2956")), false, "the new window's entry must never be written");
});

for (const status of ["new", "grilling", "proposed", "accepted", "answered"] satisfies FeedbackStatus[]) {
  test(`captureRepairFeedbackWithPriorVerdict: a prior entry status "${status}" suppresses nothing (acceptance 3)`, () => {
    const r = root();
    seedEntry(r, feedbackEntry({ id: "fb-repair-blocked-fixable-2954", origin: "repair#blocked-fixable", status, ts: "2026-08-13T00:00:00.000Z" }));
    const rec = recorder();
    captureRepairFeedbackWithPriorVerdict(r, filing({ id: "fb-repair-blocked-fixable-2956" }), rec.log);
    assert.equal(existsSync(feedbackEntryPath(r, "fb-repair-blocked-fixable-2956")), true, `status "${status}" must not suppress filing`);
    assert.equal(rec.calls.length, 0, `status "${status}" must not ledger a suppression row`);
  });
}

test("captureRepairFeedbackWithPriorVerdict: matched on the ORIGIN SURFACE, never on the window-keyed id (acceptance 4)", () => {
  const r = root();
  // An id that shares NOTHING with the `fb-repair-<surface>-<bucket>` shape — proves the match
  // is on `origin`, never a string comparison against the new filing's own id.
  seedEntry(r, feedbackEntry({ id: "fb-1690000000000-abc123", origin: "repair#blocked-fixable", status: "rejected", ts: "2026-08-20T00:00:00.000Z" }));
  const rec = recorder();
  captureRepairFeedbackWithPriorVerdict(r, filing({ id: "fb-repair-blocked-fixable-2956" }), rec.log);
  assert.equal(existsSync(feedbackEntryPath(r, "fb-repair-blocked-fixable-2956")), false);
  assert.equal(rec.calls[0]?.extra?.rejected_entry_id, "fb-1690000000000-abc123");
});

test("captureRepairFeedbackWithPriorVerdict: a rejected entry for a DIFFERENT surface never suppresses this one (acceptance 5)", () => {
  const r = root();
  seedEntry(r, feedbackEntry({ id: "fb-repair-stale-2954", origin: "repair#stale", status: "rejected", ts: "2026-08-13T00:00:00.000Z" }));
  const rec = recorder();
  captureRepairFeedbackWithPriorVerdict(r, filing({ id: "fb-repair-blocked-fixable-2956", origin: "repair#blocked-fixable" }), rec.log);
  assert.equal(existsSync(feedbackEntryPath(r, "fb-repair-blocked-fixable-2956")), true, "a different surface's rejection must not cross-suppress");
  assert.equal(rec.calls.length, 0);
});

test("captureRepairFeedbackWithPriorVerdict: a suppressed filing ledgers sweep.repair_filing_suppressed naming the surface, the distinct-PR count, and the rejected entry (acceptance 6)", () => {
  const r = root();
  seedEntry(r, feedbackEntry({ id: "fb-repair-blocked-fixable-2955", origin: "repair#blocked-fixable", status: "rejected", ts: "2026-08-20T00:00:00.000Z" }));
  const rec = recorder();
  captureRepairFeedbackWithPriorVerdict(r, filing({ id: "fb-repair-blocked-fixable-2956" }), rec.log);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].step, "sweep.repair_filing_suppressed");
  assert.equal(rec.calls[0].extra?.surface, "blocked-fixable");
  assert.equal(rec.calls[0].extra?.distinct_pr_count, 3, "the filing's own evidence names 3 distinct PRs");
  assert.equal(rec.calls[0].extra?.rejected_entry_id, "fb-repair-blocked-fixable-2955");
  assert.equal(rec.calls[0].extra?.id, "fb-repair-blocked-fixable-2956");
});

test("captureRepairFeedbackWithPriorVerdict: an unchanged suppressed filing logs once per process instead of once per daemon poll", () => {
  const r = root();
  seedEntry(r, feedbackEntry({ id: "fb-repair-stale-2955", origin: "repair#stale", status: "rejected", ts: "2026-08-20T00:00:00.000Z" }));
  const rec = recorder();
  const f = filing({ id: "fb-repair-stale-2956", origin: "repair#stale" });

  captureRepairFeedbackWithPriorVerdict(r, f, rec.log);
  captureRepairFeedbackWithPriorVerdict(r, f, rec.log);
  captureRepairFeedbackWithPriorVerdict(r, f, rec.log);

  assert.equal(rec.calls.length, 1, "three identical daemon polls must emit one suppression row, not three");
  assert.equal(existsSync(feedbackEntryPath(r, f.id)), false, "telemetry dedup must not turn a rejected filing into a file");
});

test("captureRepairFeedbackWithPriorVerdict: new distinct-PR evidence logs a fresh suppression row in the same window", () => {
  const r = root();
  seedEntry(r, feedbackEntry({ id: "fb-repair-stale-2955", origin: "repair#stale", status: "rejected", ts: "2026-08-20T00:00:00.000Z" }));
  const rec = recorder();
  const first = filing({ id: "fb-repair-stale-2956", origin: "repair#stale" });
  const fourthEvidenceLine = "- PR #104 (https://github.com/o/r/pull/104) at ddd4444: stale -- updated branch";

  captureRepairFeedbackWithPriorVerdict(r, first, rec.log);
  captureRepairFeedbackWithPriorVerdict(r, { ...first, raw: `${first.raw}\n${fourthEvidenceLine}` }, rec.log);

  assert.equal(rec.calls.length, 2, "a changed evidence count is signal, not a duplicate poll");
  assert.deepEqual(rec.calls.map((call) => call.extra?.distinct_pr_count), [3, 4]);
});

test("captureRepairFeedbackWithPriorVerdict: an unreadable/malformed prior entry FAILS OPEN -- the filing still happens (acceptance 7)", () => {
  const r = root();
  mkdirSync(feedbackDir(r), { recursive: true });
  // listFeedback (feedback.ts) parses EVERY file in plan/feedback/ before any origin filter
  // runs, so one malformed neighbour is enough to make the whole read throw (design v).
  writeFileSync(join(feedbackDir(r), "fb-broken.yaml"), ": : : not valid yaml : : [\n  - unterminated");
  const rec = recorder();
  captureRepairFeedbackWithPriorVerdict(r, filing({ id: "fb-repair-blocked-fixable-2956" }), rec.log);
  assert.equal(existsSync(feedbackEntryPath(r, "fb-repair-blocked-fixable-2956")), true, "a read error must never silence a real filing");
  assert.equal(rec.calls.length, 0, "no suppression row when the read itself failed -- filing open, not a false suppression");
});

test("captureRepairFeedbackWithPriorVerdict: the SAME-WINDOW dedup still refuses a second filing inside one window (acceptance 8)", () => {
  const r = root();
  const rec = recorder();
  const f = filing({ id: "fb-repair-blocked-fixable-999" });
  captureRepairFeedbackWithPriorVerdict(r, f, rec.log);
  const firstWrite = readFeedbackEntry(r, f.id);

  captureRepairFeedbackWithPriorVerdict(r, f, rec.log);
  const secondRead = readFeedbackEntry(r, f.id);

  assert.deepEqual(secondRead, firstWrite, "a second call for the SAME window-keyed id must be a pure no-op");
  assert.equal(rec.calls.length, 0, "the same-window dedup exits before the verdict read even runs -- no ledger row either");
});

// ── digest.ts's `sweep.repair_filing_suppressed` reader (design iii) ──────────
//
// captureRepairFeedbackWithPriorVerdict ledgers the row above via its own `log` callback; run-
// task.ts's real logger writes that call straight to the fleet ledger. These tests exercise the
// READER side directly (summarize + renderDigest, both pure) so the row this task's filer already
// writes has an assertable consumer, mirroring W1-T2345's `sweep.repeat_escalated` precedent.

test("digest: a `sweep.repair_filing_suppressed` row renders the surface, its distinct-PR count and the rejecting entry", () => {
  const summary = summarize(
    [
      {
        ts: "2026-08-27T09:05:00.000Z",
        step: "sweep.repair_filing_suppressed",
        id: "fb-repair-blocked-fixable-2956",
        surface: "blocked-fixable",
        distinct_pr_count: 3,
        rejected_entry_id: "fb-repair-blocked-fixable-2955",
      },
    ],
    "2026-08-27T00:00:00.000Z",
  );
  assert.equal(summary.repairFilingsSuppressed?.length, 1);
  const text = renderDigest(summary);
  assert.match(text, /^repair filings suppressed \(prior rejection\): blocked-fixable x3 — suppressed by fb-repair-blocked-fixable-2955$/m);
});

test("digest: two DIFFERENT suppressed surfaces both render — additive, never latest-wins", () => {
  const summary = summarize(
    [
      {
        ts: "2026-08-27T09:05:00.000Z",
        step: "sweep.repair_filing_suppressed",
        id: "fb-repair-blocked-fixable-2956",
        surface: "blocked-fixable",
        distinct_pr_count: 3,
        rejected_entry_id: "fb-repair-blocked-fixable-2955",
      },
      {
        ts: "2026-08-27T09:06:00.000Z",
        step: "sweep.repair_filing_suppressed",
        id: "fb-repair-stale-2956",
        surface: "stale",
        distinct_pr_count: 5,
        rejected_entry_id: "fb-repair-stale-2955",
      },
    ],
    "2026-08-27T00:00:00.000Z",
  );
  const text = renderDigest(summary);
  assert.match(text, /blocked-fixable x3 — suppressed by fb-repair-blocked-fixable-2955/);
  assert.match(text, /stale x5 — suppressed by fb-repair-stale-2955/, "the second suppressed surface is not hidden by the first");
});

test("digest: a suppression row missing every optional field still renders, honestly", () => {
  const summary = summarize([{ ts: "2026-08-27T09:05:00.000Z", step: "sweep.repair_filing_suppressed" }], "2026-08-27T00:00:00.000Z");
  const text = renderDigest(summary);
  assert.match(text, /^repair filings suppressed \(prior rejection\): \(surface unknown\)$/m);
  assert.doesNotMatch(text, /undefined/);
});

test("digest: a QUIET board omits the line entirely — soft-composed, never a placeholder", () => {
  const summary = summarize([{ ts: "2026-08-27T09:00:00.000Z", step: "run.start", task_id: "W1-T1" }], "2026-08-27T00:00:00.000Z");
  const text = renderDigest(summary);
  assert.doesNotMatch(text, /repair filings suppressed/, "no line at all");
});
