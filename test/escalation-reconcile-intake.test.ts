import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runEscalationReconcile, type EscalationReconcileCandidate } from "../src/lib/sweep.js";
import {
  buildEscalationReconcileCandidates,
  renderEscalationReconcileSummary,
  sweepEscalationReconcile,
  type EscalationIntake,
  type SweepEscalationReconcileSummary,
} from "../src/run-task.js";
import type { Plan } from "../src/lib/plan.js";

/**
 * `sweep.escalation_reconcile.summary` logged `total` = `candidates.length`, counted AFTER the open
 * issues became candidates — so `total: 0` read identically whether nothing was open or everything
 * open was dropped. That ambiguity cost a full recon, and the defective reading was real the same
 * afternoon: 23 of 24 summaries reported `total: 0` while two issues were open and labelled.
 *
 * The reconciler is healthy right now and the repo has ZERO open needs-human issues, so the
 * non-zero case cannot be observed live. Every test here CONSTRUCTS it from fixtures.
 */

const NOTHING: Plan = { tasks: [], byId: new Map() };

/** Capture the emitted ledger lines rather than writing any. */
function recorder(): { log: (s: string, e?: Record<string, unknown>) => void; lines: Array<[string, Record<string, unknown>]> } {
  const lines: Array<[string, Record<string, unknown>]> = [];
  return { log: (s, e) => void lines.push([s, e ?? {}]), lines };
}

function summaryOf(lines: Array<[string, Record<string, unknown>]>): Record<string, unknown> {
  const hit = lines.find(([s]) => s === "sweep.escalation_reconcile.summary");
  assert.ok(hit, "the summary line must always be emitted");
  return hit![1];
}

/** An issue gateway returning exactly the rows given. */
function gatewayOf(rows: Array<{ number: number; url: string; title: string; body: string }>) {
  return { listOpen: () => rows.map((r) => ({ ...r, state: "open" })) } as never;
}

/** Drive the whole rung — builder then reconciler — the way production wires them. */
async function driveReconcile(rows: Parameters<typeof gatewayOf>[0], github: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-intake-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const rec = recorder();
  let intake: EscalationIntake | undefined;
  const candidates = buildEscalationReconcileCandidates("craigoley", "remudero", NOTHING, ledgerPath, rec.log, {
    issues: gatewayOf(rows),
    github: github as never,
    onIntake: (i) => {
      intake = i;
    },
  });
  const raw = await runEscalationReconcile(candidates as EscalationReconcileCandidate[], {
    closeIssue: () => {},
    ledgerPath,
    runId: "TEST",
    log: rec.log,
    dryRun: true,
    intake,
  });
  // W1-T1101: this helper holds `intake` for the same reason `sweepEscalationReconcile` does — it
  // owns the builder call that measures it — so it merges the counts the same way the production
  // caller does. `runEscalationReconcile`'s own return shape (lib/sweep.ts) is untouched.
  const summary: SweepEscalationReconcileSummary = intake
    ? { ...raw, issuesSeen: intake.issuesSeen, droppedNoTaskTrailer: intake.droppedNoTaskTrailer, droppedNoReferent: intake.droppedNoReferent }
    : raw;
  return { summary, line: summaryOf(rec.lines), candidates, lines: rec.lines };
}

/** A gateway that resolves no PR — so a referent-bearing issue still becomes a candidate. */
const NO_PRS = { prByRef: () => undefined, prByTrailer: () => undefined, mergedNewestFirst: () => [] };

test("issues exist and ALL are dropped — issues_seen is non-zero while total is 0", async () => {
  // THE SIGNATURE THAT WAS PREVIOUSLY INEXPRESSIBLE. Three open issues, none carrying a `**Task:**`
  // trailer and none naming a PR anywhere, so every one is dropped before becoming a candidate.
  const { line, candidates } = await driveReconcile(
    [
      { number: 1, url: "u1", title: "needs a human", body: "no trailer here" },
      { number: 2, url: "u2", title: "also human", body: "still nothing" },
      { number: 3, url: "u3", title: "third", body: "" },
    ],
    NO_PRS,
  );
  assert.equal(candidates.length, 0);
  assert.equal(line.total, 0);
  assert.equal(line.issues_seen, 3, "the old line could not say this");
  assert.deepEqual(line.dropped, { no_task_trailer: 3, no_referent: 0 }, "and it names WHY");
});

test("no issues exist — issues_seen and total are both 0, the healthy case now positively identifiable", async () => {
  const { line } = await driveReconcile([], NO_PRS);
  assert.equal(line.total, 0);
  assert.equal(line.issues_seen, 0, "distinguishable from the three-dropped case above");
  assert.equal(line.dropped, undefined, "no detail on the healthy path — the line stays small");
});

test("issues exist and become candidates — the two counts agree", async () => {
  const { line, candidates } = await driveReconcile(
    [
      { number: 10, url: "u10", title: "t", body: "**Task:** PR-707\n" },
      { number: 11, url: "u11", title: "t", body: "**Task:** PR-708\n" },
    ],
    NO_PRS,
  );
  assert.equal(candidates.length, 2);
  assert.equal(line.total, 2);
  assert.equal(line.issues_seen, 2);
  assert.equal(line.dropped, undefined, "nothing was dropped, so nothing is explained");
});

test("a PARTIAL drop is visible — issues_seen exceeds total and the reason tally names the split", async () => {
  const { line } = await driveReconcile(
    [
      { number: 20, url: "u20", title: "t", body: "**Task:** PR-707\n" },
      { number: 21, url: "u21", title: "t", body: "no trailer" },
      { number: 22, url: "u22", title: "t", body: "**Task:** W1-NOTINPLAN\n" },
    ],
    NO_PRS,
  );
  assert.equal(line.issues_seen, 3);
  assert.equal(line.total, 1);
  assert.deepEqual(line.dropped, { no_task_trailer: 1, no_referent: 1 });
});

test("the summary line still emits when the intake count is unavailable", async () => {
  // TRAP 3. A caller that supplies no intake — every pre-existing caller, and any future one —
  // must get exactly the line it got before: no crash, and no fabricated zero that would read as
  // "nothing was open" when nothing was measured.
  const rec = recorder();
  const dir = mkdtempSync(join(tmpdir(), "rmd-intake-none-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const summary = await runEscalationReconcile([], {
    closeIssue: () => {},
    ledgerPath,
    runId: "TEST",
    log: rec.log,
    dryRun: true,
  });
  const line = summaryOf(rec.lines);
  assert.equal(summary.total, 0);
  assert.equal(line.total, 0);
  assert.equal("issues_seen" in line, false, "absent, never a misleading 0");
});

test("a throwing intake observer never takes out the reconciler", async () => {
  // TRAP 3, the other half: this runs every pass on the live fleet. An observer that throws must
  // not become an outage, so the builder still returns its candidates.
  const dir = mkdtempSync(join(tmpdir(), "rmd-intake-throw-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const rec = recorder();
  const candidates = buildEscalationReconcileCandidates("craigoley", "remudero", NOTHING, ledgerPath, rec.log, {
    issues: gatewayOf([{ number: 30, url: "u30", title: "t", body: "**Task:** PR-707\n" }]),
    github: NO_PRS as never,
    onIntake: () => {
      throw new Error("observer exploded");
    },
  });
  assert.equal(candidates.length, 1, "the candidate survived a throwing observer");
});

test("BEHAVIOUR LOCK: the same fixture yields the same closes and the same candidate set", async () => {
  // OBSERVABILITY ONLY. The reconciler's dispositions must be untouched — same candidates built,
  // same closes performed, for a fixture that actually closes something.
  const dir = mkdtempSync(join(tmpdir(), "rmd-intake-lock-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const rec = recorder();
  const closes: string[] = [];
  const mergedGithub = { prByRef: () => ({ state: "MERGED", number: 707 }), prByTrailer: () => undefined, mergedNewestFirst: () => [] };
  const candidates = buildEscalationReconcileCandidates("craigoley", "remudero", NOTHING, ledgerPath, rec.log, {
    issues: gatewayOf([{ number: 40, url: "u40", title: "t", body: "**Task:** PR-707\n" }]),
    github: mergedGithub as never,
    onIntake: () => {},
  });
  const summary = await runEscalationReconcile(candidates as EscalationReconcileCandidate[], {
    closeIssue: (url) => void closes.push(url),
    ledgerPath,
    runId: "TEST",
    log: rec.log,
  });
  assert.equal(candidates.length, 1, "one candidate, exactly as before");
  assert.equal(summary.closed, 1, "and it still closes");
  assert.deepEqual(closes, ["u40"], "the same issue, by url");
  assert.equal(summaryOf(rec.lines).total, 1);
});

test("THE RUNG WIRES IT: sweepEscalationReconcile carries the intake from builder to summary", async () => {
  // THE SEAM. Every other test here calls the builder and the reconciler directly; this one drives
  // the production rung that joins them, which is the only place the new plumbing actually runs.
  // Without it the wiring is unexecuted — the shape that let a declared field sit unproduced for
  // fifteen days elsewhere in this codebase.
  const dir = mkdtempSync(join(tmpdir(), "rmd-intake-rung-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const rec = recorder();
  const summary = await sweepEscalationReconcile("craigoley", "remudero", NOTHING, ledgerPath, "TEST", rec.log, {
    dryRun: true,
    issues: gatewayOf([
      { number: 50, url: "u50", title: "t", body: "**Task:** PR-707\n" },
      { number: 51, url: "u51", title: "t", body: "no trailer at all" },
    ]),
    github: NO_PRS as never,
  });
  const line = summaryOf(rec.lines);
  assert.equal(summary.total, 1);
  assert.equal(line.issues_seen, 2, "the builder's count reached the reconciler's log line");
  assert.deepEqual(line.dropped, { no_task_trailer: 1, no_referent: 0 });
});

// ── W1-T1101 — the CLI SUMMARY LINE (`rmd sweep`'s console output), as opposed to the ledger row
// above (#1084 already fixed the row; this task never re-touches it — see the BEHAVIOUR test at
// the bottom of this file). `renderEscalationReconcileSummary` is the pure function the `rmd
// sweep` call site now renders instead of interpolating `reconcileSummary.total` directly.

test("W1-T1101: the summary reports the issues the read returned", async () => {
  // Three open issues, only one becomes a candidate — the exact shape rationale (2) measured live
  // (`issues_seen: 13, total: 9`). The OLD line would have said "1 open needs-human issue(s)
  // checked"; the fix must say "3", because 3 is how many the read actually returned.
  const { summary } = await driveReconcile(
    [
      { number: 20, url: "u20", title: "t", body: "**Task:** PR-707\n" },
      { number: 21, url: "u21", title: "t", body: "no trailer" },
      { number: 22, url: "u22", title: "t", body: "**Task:** W1-NOTINPLAN\n" },
    ],
    NO_PRS,
  );
  assert.equal(summary.issuesSeen, 3, "the read returned three issues");
  assert.equal(summary.total, 1, "only one survived to become a candidate");
  const rendered = renderEscalationReconcileSummary(summary);
  assert.match(rendered, /\b3 open needs-human issue\(s\) checked\b/, "the seen count, not the post-drop count, sits under the label");
  assert.doesNotMatch(rendered, /\b1 open needs-human issue\(s\) checked\b/, "the old, misleading number must not appear under that label");
});

test("W1-T1101: a failed read renders differently from an empty queue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-intake-failed-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const rec = recorder();
  const failingGateway = { listOpen: () => { throw new Error("gh api: rate limited"); } } as never;

  // THE READ FAILS OUTRIGHT. `buildEscalationReconcileCandidates`'s `[]`-on-failure contract means
  // `onIntake` is never invoked, so `sweepEscalationReconcile`'s returned summary carries no
  // `issuesSeen` at all — distinct from "the read succeeded and found zero".
  const failedSummary: SweepEscalationReconcileSummary = await sweepEscalationReconcile(
    "craigoley",
    "remudero",
    NOTHING,
    ledgerPath,
    "TEST",
    rec.log,
    { dryRun: true, issues: failingGateway, github: NO_PRS as never },
  );
  assert.equal(failedSummary.issuesSeen, undefined, "no intake reached the summary — the read never got that far");
  assert.equal(failedSummary.total, 0);

  // THE READ SUCCEEDS AND FINDS NOTHING. Same `total: 0`, but `issuesSeen` is a measured zero.
  const emptySummary: SweepEscalationReconcileSummary = await sweepEscalationReconcile(
    "craigoley",
    "remudero",
    NOTHING,
    ledgerPath,
    "TEST",
    rec.log,
    { dryRun: true, issues: gatewayOf([]), github: NO_PRS as never },
  );
  assert.equal(emptySummary.issuesSeen, 0, "the read succeeded and measured an empty queue");
  assert.equal(emptySummary.total, 0);

  const failedLine = renderEscalationReconcileSummary(failedSummary);
  const emptyLine = renderEscalationReconcileSummary(emptySummary);
  assert.notEqual(failedLine, emptyLine, "a failed read must not render the same line as an empty queue");
  assert.match(failedLine, /FAILED/, "the failed read names itself as failed");
  assert.doesNotMatch(emptyLine, /FAILED/, "a genuinely empty queue is not a failure");
});

test("W1-T1101: an all-dropped tick names its drops", async () => {
  // THE SIGNATURE FROM RATIONALE (3): three open issues, all dropped, so `total: 0` — but this is
  // neither an empty queue nor a failed read. The line must say so rather than rendering a bare
  // "0 open needs-human issue(s) checked · 0 closed", which is indistinguishable from either.
  const { summary } = await driveReconcile(
    [
      { number: 1, url: "u1", title: "needs a human", body: "no trailer here" },
      { number: 2, url: "u2", title: "also human", body: "still nothing" },
      { number: 3, url: "u3", title: "third", body: "" },
    ],
    NO_PRS,
  );
  assert.equal(summary.issuesSeen, 3);
  assert.equal(summary.total, 0);
  const rendered = renderEscalationReconcileSummary(summary);
  assert.match(rendered, /\b3 open needs-human issue\(s\) checked\b/, "the seen count is visible, not swallowed by the zero");
  assert.match(rendered, /\b3 dropped\b/, "the drop count names the all-dropped tick");
  assert.match(rendered, /3 no-task-trailer, 0 no-referent/, "and the reason split is visible, not just a bare count");
  assert.notEqual(
    rendered,
    "escalation reconcile: 0 open needs-human issue(s) checked · 0 closed",
    "must not read identically to a genuinely empty queue",
  );
});

test("W1-T1101: the reconciler's behaviour and ledger row are unchanged", async () => {
  // Same fixture shape as the pre-existing BEHAVIOUR LOCK test above (one candidate that resolves
  // and closes, one dropped for lacking a trailer) — this task must not move either the reconciler's
  // dispositions or the #1084 ledger row; only the CLI's own rendering changes.
  const dir = mkdtempSync(join(tmpdir(), "rmd-intake-behavior-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const rec = recorder();
  const closes: string[] = [];
  const mergedGithub = { prByRef: () => ({ state: "MERGED", number: 707 }), prByTrailer: () => undefined, mergedNewestFirst: () => [] };
  let intake: EscalationIntake | undefined;
  const candidates = buildEscalationReconcileCandidates("craigoley", "remudero", NOTHING, ledgerPath, rec.log, {
    issues: gatewayOf([
      { number: 60, url: "u60", title: "t", body: "**Task:** PR-707\n" },
      { number: 61, url: "u61", title: "t", body: "no trailer" },
    ]),
    github: mergedGithub as never,
    onIntake: (i) => {
      intake = i;
    },
  });
  const summary = await runEscalationReconcile(candidates as EscalationReconcileCandidate[], {
    closeIssue: (url) => void closes.push(url),
    ledgerPath,
    runId: "TEST",
    log: rec.log,
    intake,
  });

  // BEHAVIOUR: identical dispositions to what this fixture produced before this task existed —
  // one candidate resolved and closed, one dropped for lacking a trailer.
  assert.equal(candidates.length, 1, "the trailer-less issue is still not a candidate");
  assert.equal(summary.closed, 1, "the reconciler still closes the resolved candidate");
  assert.deepEqual(closes, ["u60"], "the same issue, by url — closing is untouched");

  // LEDGER ROW: the exact field set #1084 shipped, untouched — the new `issuesSeen`/drop fields
  // ride on the RETURNED summary object (asserted above), never on this ledger line's shape.
  const line = summaryOf(rec.lines);
  assert.deepEqual(
    Object.keys(line).sort(),
    ["closed", "dropped", "issues_seen", "total"].sort(),
    "the ledger row's field set is exactly what #1084 shipped",
  );
  assert.equal(line.total, 1);
  assert.equal(line.closed, 1);
  assert.equal(line.issues_seen, 2);
  assert.deepEqual(line.dropped, { no_task_trailer: 1, no_referent: 0 });
});
