import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGather,
  mutationGateVerdictLine,
  mutationGateLifetime,
  parseLedger,
  recordMutationGateVerdict,
  renderGather,
  renderMutationGateLifetime,
  MUTATION_GATE_VERDICT_STEP,
  type MutationGateVerdictInput,
} from "../src/lib/retro.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";

// ── W1-T393 (MASTER-PLAN §11 D-10) ──────────────────────────────────────────
// D-10 has stood OPEN for seven retro cycles on a standing prose demand — "report, WITH DATA,
// mutants killed vs survived over `mutation-ratchet`'s LIFETIME, and whether it has EVER caught a
// real escape" — that no gather rung ever executed. This file proves the rung that finally does:
// design clause (i) (read the gate's own history, never re-run Stryker), clause (ii) (the escape
// count is the headline, never stood in for by totals), clause (iii) (P48 — no naked zero, a
// zero-record history must fail the positive control, never render as "zero escapes"), and
// clause (vi)'s falsifier, both directions.

const SUCCESS_LINE = (runId: string, ts: string, killed: number, survived: number) =>
  JSON.stringify({
    ts,
    run_id: runId,
    task_id: "mutation-ratchet",
    step: MUTATION_GATE_VERDICT_STEP,
    conclusion: "success",
    killed,
    survived,
    timeout: 0,
    no_coverage: 0,
  });

const FAILURE_LINE = (runId: string, ts: string, prUrl: string, killed: number, survived: number) =>
  JSON.stringify({
    ts,
    run_id: runId,
    task_id: "mutation-ratchet",
    pr_url: prUrl,
    step: MUTATION_GATE_VERDICT_STEP,
    conclusion: "failure",
    killed,
    survived,
    timeout: 0,
    no_coverage: 0,
  });

// ── mutationGateVerdictLine / recordMutationGateVerdict (the emission half) ─

test("mutationGateVerdictLine: builds the ledger line's shape, pure — never writes", () => {
  const input: MutationGateVerdictInput = {
    runId: "abc123",
    prUrl: "https://github.com/o/r/pull/999",
    conclusion: "failure",
    killed: 70,
    survived: 26,
    timeout: 12,
    noCoverage: 0,
  };
  const line = mutationGateVerdictLine(input);
  assert.equal(line.step, MUTATION_GATE_VERDICT_STEP);
  assert.equal(line.run_id, "abc123");
  assert.equal(line.task_id, "mutation-ratchet"); // no taskId supplied — falls back, never throws
  assert.equal(line.pr_url, "https://github.com/o/r/pull/999");
  assert.equal(line.conclusion, "failure");
  assert.equal(line.killed, 70);
  assert.equal(line.survived, 26);
  assert.equal(line.timeout, 12);
  assert.equal(line.no_coverage, 0);
});

test("recordMutationGateVerdict: writes via the injectable writer, never touching disk in a test", () => {
  const written: unknown[] = [];
  recordMutationGateVerdict(
    { runId: "def456", conclusion: "success", killed: 10, survived: 0, timeout: 0, noCoverage: 0 },
    { ledgerPath: "/dev/null/unused", writeLedger: (_path, line) => void written.push(line) },
  );
  assert.equal(written.length, 1);
  assert.equal((written[0] as { step: string }).step, MUTATION_GATE_VERDICT_STEP);
});

// ── mutationGateLifetime (the read side — clause i/ii/iii) ─────────────────

test("mutationGateLifetime: an EMPTY history fails the positive control, never reports zero escapes as a result (clause iii, P48)", () => {
  const report = mutationGateLifetime([]);
  assert.equal(report.positiveControl, false, "no verdict records at all — an UNMEASURED history, not a measured zero");
  assert.equal(report.runCount, 0);
  assert.equal(report.escapeCount, 0);
  assert.deepEqual(report.escapes, []);
});

test("mutationGateLifetime: unrelated ledger steps mixed in are ignored — only MUTATION_GATE_VERDICT_STEP lines are counted", () => {
  const records = parseLedger(
    [
      `{"ts":"2026-05-01T00:00:00.000Z","run_id":"R1","task_id":"W1-T1","step":"run.start"}`,
      `{"ts":"2026-05-01T00:01:00.000Z","run_id":"R1","task_id":"W1-T1","step":"verdict","verdict":"merged"}`,
    ].join("\n"),
  );
  assert.equal(mutationGateLifetime(records).positiveControl, false, "no mutation-ratchet verdict among these — still fails the control");
});

test("mutationGateLifetime: a history of only SUCCESS runs reports ZERO escapes AND a non-zero run count (clause vi, direction 2)", () => {
  const records = parseLedger(
    [SUCCESS_LINE("sha-1", "2026-06-01T00:00:00.000Z", 70, 26), SUCCESS_LINE("sha-2", "2026-06-02T00:00:00.000Z", 71, 25)].join("\n"),
  );
  const report = mutationGateLifetime(records);
  assert.equal(report.positiveControl, true, "two real verdict records were read — the control is satisfied");
  assert.equal(report.runCount, 2);
  assert.equal(report.escapeCount, 0);
  assert.deepEqual(report.escapes, []);
  assert.equal(report.killed, 141, "supporting totals still sum across every run");
  assert.equal(report.survived, 51);
});

test("mutationGateLifetime: a history containing a FAILURE run reports a non-zero escape count and NAMES that run (clause vi, direction 1)", () => {
  const records = parseLedger(
    [
      SUCCESS_LINE("sha-1", "2026-06-01T00:00:00.000Z", 70, 26),
      FAILURE_LINE("sha-2", "2026-06-02T00:00:00.000Z", "https://github.com/o/r/pull/777", 60, 36),
      SUCCESS_LINE("sha-3", "2026-06-03T00:00:00.000Z", 72, 24),
    ].join("\n"),
  );
  const report = mutationGateLifetime(records);
  assert.equal(report.positiveControl, true);
  assert.equal(report.runCount, 3);
  assert.equal(report.escapeCount, 1);
  assert.equal(report.escapes.length, 1);
  assert.equal(report.escapes[0]!.runId, "sha-2", "the escaping run is NAMED, not just counted");
  assert.equal(report.escapes[0]!.prUrl, "https://github.com/o/r/pull/777");
  // the escape count is the headline (clause ii) — totals are the supporting column, never a
  // stand-in: killed/survived still reflect ALL three runs, not just the escape.
  assert.equal(report.killed, 202);
  assert.equal(report.survived, 86);
});

// ── renderMutationGateLifetime (clause iii: the two zero-shaped states must render differently) ─

test("renderMutationGateLifetime: NO POSITIVE CONTROL renders distinctly from a genuine zero-escapes result", () => {
  const noControl = renderMutationGateLifetime(mutationGateLifetime([]));
  assert.match(noControl, /NO POSITIVE CONTROL/);
  assert.match(noControl, /starts now, N=0/);
  assert.doesNotMatch(noControl, /escape\(s\)/, "an unmeasured history must never be phrased as a completed escape count");

  const zeroEscapes = renderMutationGateLifetime(
    mutationGateLifetime(parseLedger(SUCCESS_LINE("sha-1", "2026-06-01T00:00:00.000Z", 70, 26))),
  );
  assert.doesNotMatch(zeroEscapes, /NO POSITIVE CONTROL/);
  assert.match(zeroEscapes, /1 run\(s\) recorded/);
  assert.match(zeroEscapes, /NO \(0 escape\(s\)\)/);
});

test("renderMutationGateLifetime: an escape is named in the rendered output, and the headline reads YES", () => {
  const rendered = renderMutationGateLifetime(
    mutationGateLifetime(parseLedger(FAILURE_LINE("sha-9", "2026-06-09T00:00:00.000Z", "https://github.com/o/r/pull/9", 1, 1))),
  );
  assert.match(rendered, /YES \(1 escape\(s\)\)/);
  assert.match(rendered, /sha-9/);
  assert.match(rendered, /pull\/9/);
});

// ── Reached from the retro gather, not merged unwired (4th acceptance claim) ─

test("buildGather/renderGather: the mutation-gate-lifetime rung is present on the gather object and rendered in the full report", () => {
  const ledgerNdjson = [
    SUCCESS_LINE("sha-1", "2026-06-01T00:00:00.000Z", 70, 26),
    FAILURE_LINE("sha-2", "2026-06-02T00:00:00.000Z", "https://github.com/o/r/pull/42", 60, 36),
  ].join("\n");
  const g = buildGather({ ledgerNdjson, learningsMd: "# L\n" });
  assert.equal(g.mutationGateLifetime.positiveControl, true);
  assert.equal(g.mutationGateLifetime.runCount, 2);
  assert.equal(g.mutationGateLifetime.escapeCount, 1);
  const rendered = renderGather(g);
  assert.match(rendered, /Mutation gate lifetime \(D-10, W1-T393\)/, "the rung must be reached from renderGather, not left unwired");
  assert.match(rendered, /YES \(1 escape\(s\)\)/);
  assert.match(rendered, /sha-2/);
});

test("buildGather/renderGather: today's real ledger (no verdicts recorded yet) correctly reports the NO-POSITIVE-CONTROL state end to end", () => {
  const g = buildGather({ ledgerNdjson: "", learningsMd: "# L\n" });
  assert.equal(g.mutationGateLifetime.positiveControl, false);
  const rendered = renderGather(g);
  assert.match(rendered, /NO POSITIVE CONTROL/, "the honest state of the world today — never a false zero-escapes claim");
});

test("buildGather: mutationGateLifetime is computed over the FULL ledger, never truncated to sinceTs — a lifetime figure must survive the marker window", () => {
  const ledgerNdjson = [SUCCESS_LINE("sha-old", "2020-01-01T00:00:00.000Z", 5, 5)].join("\n");
  const g = buildGather({ ledgerNdjson, learningsMd: "# L\n", sinceTs: "2026-01-01T00:00:00.000Z" });
  assert.equal(g.mutationGateLifetime.runCount, 1, "a run far older than sinceTs still counts toward the LIFETIME total");
});

// ── DECISION_RELEVANT_LEDGER_STEPS registration (clause iv's own instruction) ─

test("MUTATION_GATE_VERDICT_STEP survives ledger rotation — registered in DECISION_RELEVANT_LEDGER_STEPS in this same change", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has(MUTATION_GATE_VERDICT_STEP),
    "a LIFETIME figure that ledger rotation could silently reset reproduces the exact defect this task exists to close (clause iv, the sweep.absent_repush precedent)",
  );
});
