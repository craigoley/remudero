import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DECISION_RELEVANT_LEDGER_STEPS, appendLedger, ledgerExceedsRotationCeiling, rotateLedger, type LedgerLine } from "../src/lib/ledger.js";
import * as status from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T5966. Rotation retained fix.dispatch but not most of the rows that END a fix round, so after a
// rotation a finished round read as still in flight: status.ts clears its activeFixRunId only on a
// FIX_LANE_TERMINAL_STEPS row, and an investigator saw a round's cause with no outcome (#9450's
// fix.stood_down sat only in a rotated archive). A retained start step must keep its terminal steps.
//
// The terminal set is status.ts's own export, not restated here, so a step added there without a
// matching registration in DECISION_RELEVANT_LEDGER_STEPS fails this guard.

const START_STEP = "fix.dispatch";
const TASK = "W1-T9999";
const FIX_RUN = "FIX-ROUND-1";

/** BASE-ONLY FALLBACK: before W1-T5966 status.ts kept the set private, so a run at the parent commit
 *  (rmd check-proof) reads the members it held then. With the export present this is never read. */
const TERMINAL_STEPS_BEFORE_EXPORT: ReadonlySet<string> = new Set([
  "fix.done", "fix.resolved", "fix.exhausted", "fix.stood_down", "fix.superseded", "fix.superseded_unknown", "fix.spawn_abandoned",
]);

const TERMINAL_STEPS = [...((status as Partial<typeof status>).FIX_LANE_TERMINAL_STEPS ?? TERMINAL_STEPS_BEFORE_EXPORT)];

/** The two other rows a fix round writes that a deciding reader folds: sweep.ts's fix-rung error and
 *  ci-friction-gardener's priced fix.base_refreshed round. */
const ROUND_READ_BACK_STEPS = ["sweep.fix.error", "fix.base_refreshed"];

type Row = Record<string, unknown>;

function noiseRow(n: number): string {
  return JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) });
}

/** A dispatched fix round ending in `terminalStep`, padded with noise past four times its size, then
 *  really rotated. Returns the rows read after the rotation. */
function rotatedRound(terminalStep: string, retainedSteps?: ReadonlySet<string>): Row[] {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-terminal-rotation-`));
  try {
    const path = join(dir, "ledger.ndjson");
    const noCeiling = { ceilingBytes: Number.MAX_SAFE_INTEGER };
    const row = (step: string, extra: Row = {}) =>
      appendLedger(path, { task_id: TASK, run_id: FIX_RUN, step, pr_url: "https://github.com/o/r/pull/9002", ...extra } as LedgerLine, noCeiling);
    appendLedger(path, { task_id: TASK, run_id: "RUN-1", step: "run.start" } as LedgerLine, noCeiling);
    row(START_STEP);
    row("fix.ci_not_green");
    row(terminalStep, { reason: "merge state dirty" });
    const ceiling = statSync(path).size * 4;
    const padding = Math.ceil(ceiling / (noiseRow(0).length + 1)) + 50;
    for (let n = 0; n < padding; n++) appendFileSync(path, noiseRow(n) + "\n");
    assert.ok(ledgerExceedsRotationCeiling(path, ceiling), "setup: padded past the ceiling");
    assert.equal(rotateLedger(path, { ceilingBytes: ceiling, ...(retainedSteps ? { retainedSteps } : {}) }).rotated, true);
    const after = status.readLedgerLines(path);
    assert.ok(after.filter((l) => l.step === "ci.polling").length < 50, "the rotation really archived the noise");
    return after;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Dispatched fix rounds with no terminal row — what status.ts's projection would read as in flight. */
function openRounds(lines: Row[]): string[] {
  const open = new Set<string>();
  for (const l of lines) {
    if (typeof l.run_id !== "string" || typeof l.step !== "string") continue;
    if (l.step === START_STEP) open.add(l.run_id);
    else if (TERMINAL_STEPS.includes(l.step)) open.delete(l.run_id);
  }
  return [...open];
}

test("W1-T5966: every fix-lane terminal step is retained while fix.dispatch is", () => {
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(START_STEP), "sanity: the start step is retained");
  assert.ok(TERMINAL_STEPS.includes("fix.stood_down") && TERMINAL_STEPS.includes("fix.done"), "sanity: the set was read");
  const unretained = [...TERMINAL_STEPS, ...ROUND_READ_BACK_STEPS].filter((s) => !DECISION_RELEVANT_LEDGER_STEPS.has(s));
  assert.deepEqual(unretained, [], "register these in DECISION_RELEVANT_LEDGER_STEPS beside fix.dispatch");
});

for (const terminalStep of TERMINAL_STEPS) {
  test(`W1-T5966: after a real ledger rotation a dispatched fix round keeps its ${terminalStep} row`, () => {
    const after = rotatedRound(terminalStep);
    assert.equal(after.filter((l) => l.step === START_STEP).length, 1, "the round's fix.dispatch is still live");
    const live = after.filter((l) => l.step === terminalStep && l.run_id === FIX_RUN);
    assert.equal(live.length, 1, `${terminalStep} rotated away while its fix.dispatch stayed live`);
    assert.equal(live[0]!.reason, "merge state dirty", "the outcome's reason survives intact");
    assert.deepEqual(openRounds(after), [], "the finished round does not read as still in flight");
  });
}

for (const step of ROUND_READ_BACK_STEPS) {
  test(`W1-T5966: a fix round's ${step} row survives a real ledger rotation`, () => {
    const after = rotatedRound(step);
    assert.equal(after.filter((l) => l.step === step && l.run_id === FIX_RUN).length, 1, `${step} is still live`);
  });
}

test("W1-T5966: the guard can see a dropped terminal row — rotation without fix.stood_down strands the round", () => {
  // POSITIVE CONTROL: #9450's shape. The same rotation with fix.stood_down taken out of the retained
  // set keeps the round's fix.dispatch and archives its outcome, so the round reads as still open.
  const without = new Set([...DECISION_RELEVANT_LEDGER_STEPS].filter((s) => s !== "fix.stood_down"));
  const after = rotatedRound("fix.stood_down", without);
  assert.equal(after.some((l) => l.step === START_STEP), true);
  assert.equal(after.some((l) => l.step === "fix.stood_down"), false);
  assert.deepEqual(openRounds(after), [FIX_RUN]);
});
