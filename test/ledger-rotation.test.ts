import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DECISION_RELEVANT_LEDGER_STEPS,
  LedgerLine,
  appendLedger,
  ledgerExceedsRotationCeiling,
  rotateLedger,
} from "../src/lib/ledger.js";
import { dispatchesWithoutNewOwnedPr, isDispatchBreakerTripped, readLedgerLines } from "../src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runCreditBackfill, runSweep, type OpenPrView } from "../src/lib/sweep.js";
import { escalateCircuitBreak, deriveStrikeHistory } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { isRatifiedInLedger } from "../src/lib/inbox.js";
import { priorEscalatedAlertIds } from "../src/lib/ops.js";

// ── W1-T209: "the ledger grows unbounded with no archival, and any rotation that hides a
// decision-relevant line silently zeroes the dispatch breaker it also backs" (RECON R-9,
// coupled to R-16). rotateLedger (src/lib/ledger.ts) is the fix: archive the full history to
// a dated roll, verbatim, then keep ONLY the decision-relevant tail live — the lines the
// dispatch breaker, sweep dedup, and credit-backfill actually consult. THE ACCEPTANCE TEST IS
// THE BREAKER, NOT THE FILE SIZE — see test/breaker-survives-rotation.test.ts for the load-
// bearing before/after invariant; this file covers the ceiling detection, the decision-
// relevant-step survival, and sweep's own dedup surviving a rotation. ─────────────────────

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-ledger-rotation-"));
}

function noiseLine(n: number): string {
  // Realistic high-frequency, no-decision-consequence traffic (ci.polling/pr.polling —
  // exactly what plan/tasks.yaml's design note calls "everything else... archivable"),
  // padded so a handful of these alone can cross a small test ceiling.
  return JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) });
}

test("ledgerExceedsRotationCeiling: a ledger over the ceiling with no archived roll present reports true (FAILS the check)", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const ceiling = 500;
    writeFileSync(ledgerPath, Array.from({ length: 20 }, (_, i) => noiseLine(i)).join("\n") + "\n");

    assert.equal(
      ledgerExceedsRotationCeiling(ledgerPath, ceiling),
      true,
      "an oversized ledger with no rotation ever having run must be flagged, not silently accepted",
    );
    const archivesBefore = readdirSync(dir).filter((f) => f !== "ledger.ndjson");
    assert.deepEqual(archivesBefore, [], "no archived roll exists yet — rotation has not run");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    assert.ok(result.archivePath, "a rotation that fires must name the archive it wrote");
    const archiveContent = readFileSync(result.archivePath as string, "utf8");
    assert.equal(archiveContent.trim().split("\n").length, 20, "the archive holds every pre-rotation line verbatim");

    assert.equal(
      ledgerExceedsRotationCeiling(ledgerPath, ceiling),
      false,
      "after archiving pure noise, the live ledger is back under the ceiling",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledgerExceedsRotationCeiling: an absent ledger never exceeds anything — nothing to rotate", () => {
  const dir = tmpDir();
  try {
    assert.equal(ledgerExceedsRotationCeiling(join(dir, "never-created.ndjson"), 10), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateLedger: every decision-relevant step survives into the live view, derived from the exported consumer-sourced set (not a stale hardcoded list)", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-DECISIONS";

    // One genuine line per decision-relevant step this task's own DECISION_RELEVANT_LEDGER_STEPS
    // constant names — built FROM the export itself, so if a future edit trims that set, this
    // test still proves whatever remains in it survives; the breaker/sweep tests below prove the
    // set is not missing anything a real consumer needs.
    let i = 0;
    for (const step of DECISION_RELEVANT_LEDGER_STEPS) {
      appendLedger(ledgerPath, { run_id: `r${i}`, task_id: taskId, step, marker: i } as LedgerLine, {
        ceilingBytes: Number.MAX_SAFE_INTEGER, // don't let appendLedger's own opportunistic rotation fire mid-setup
      });
      i++;
    }
    const expectedCount = DECISION_RELEVANT_LEDGER_STEPS.size;

    // Pad with enough noise to force a real rotation.
    for (let n = 0; n < 200; n++) {
      writeFileSync(ledgerPath, noiseLine(n) + "\n", { flag: "a" });
    }

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "test setup sanity: padded past the ceiling");
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const linesAfter = readLedgerLines(ledgerPath);
    assert.equal(linesAfter.torn, 0, "rotation must not tear any surviving line");

    const survivingSteps = new Set(
      linesAfter.filter((l) => l.task_id === taskId).map((l) => l.step as string),
    );
    for (const step of DECISION_RELEVANT_LEDGER_STEPS) {
      assert.ok(survivingSteps.has(step), `decision-relevant step "${step}" was dropped by rotation`);
    }
    assert.equal(survivingSteps.size, expectedCount, "no decision-relevant line was lost or duplicated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateLedger: the dispatch breaker's own predicates read identically for a task's history before and after rotation", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-BREAKER-ROT";

    for (let i = 0; i < 6; i++) {
      appendLedger(
        ledgerPath,
        { run_id: `r${i}`, task_id: taskId, step: "run.start" } as LedgerLine,
        { ceilingBytes: Number.MAX_SAFE_INTEGER },
      );
    }
    for (let n = 0; n < 300; n++) {
      writeFileSync(ledgerPath, noiseLine(n) + "\n", { flag: "a" });
    }

    const before = readLedgerLines(ledgerPath);
    const countBefore = dispatchesWithoutNewOwnedPr(before, taskId);
    const trippedBefore = isDispatchBreakerTripped(before, taskId, 5);

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling));
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const after = readLedgerLines(ledgerPath);
    const countAfter = dispatchesWithoutNewOwnedPr(after, taskId);
    const trippedAfter = isDispatchBreakerTripped(after, taskId, 5);

    assert.equal(countAfter, countBefore, "dispatch count must be identical across rotation");
    assert.equal(trippedAfter, trippedBefore, "breaker verdict must be identical across rotation");
    assert.equal(trippedAfter, true, "sanity: 6 dispatches >= maxDispatches(5) really was tripped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateLedger: sweep's credit-backfill dedup still suppresses a duplicate correction after rotation (no re-credit of an already-credited merge)", async () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const taskId = "W1-CREDITED";
    const prUrl = "https://github.com/acme/widgets/pull/42";

    // The ledger already carries merge credit for this task — runCreditBackfill's own
    // idempotence contract (hasMergeCredit) says a repeat pass must append nothing further.
    appendLedger(
      ledgerPath,
      { run_id: "r0", task_id: taskId, step: "verdict.merged", pr_url: prUrl } as LedgerLine,
      { ceilingBytes: Number.MAX_SAFE_INTEGER },
    );
    for (let n = 0; n < 250; n++) {
      writeFileSync(ledgerPath, noiseLine(n) + "\n", { flag: "a" });
    }

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling));
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const summary = await runCreditBackfill(
      [{ taskId, prNumber: 42, prUrl, merged: true }],
      { ledgerPath, runId: "post-rotation-run", dryRun: false },
    );

    assert.equal(summary.corrected, 0, "a rotation must not cause an already-credited merge to be re-credited");
    assert.equal(summary.results[0]?.alreadyCredited, true, "credit dedup must still see the credit after rotation");
    assert.equal(summary.results[0]?.corrected, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── THE FALSIFIER (review round 1's unmet criterion): the tests above prove rotateLedger's
// OUTPUT matches a self-referential expectation, which is non-responsive to "a rotation that
// drops a decision-relevant line FAILS" — that claim needs an observed FAILURE when a line is
// dropped, not merely a survival check against the same constant the code already filters by.
//
// Each test below runs the SAME real production consumer three times against three ledgers
// built from ONE original (decision line + realistic noise, exceeding the ceiling):
//   1. GROUND TRUTH  — the untouched original: what the consumer should answer.
//   2. LINE DROPPED  — the original with ONLY the one decision-relevant line under test
//      removed (everything else, including all noise, identical) — simulating exactly what
//      "a rotation that drops a decision-relevant line" looks like from the consumer's side.
//      Asserts the consumer's answer is WRONG (differs from ground truth) — the FAILURE the
//      claim names, observed for real, not merely asserted never to happen.
//   3. REAL ROTATION — rotateLedger's actual output on the SAME original. Asserts the
//      consumer's answer MATCHES ground truth — proving THIS specific step is retained
//      because a real consumer needs it (derived from consumers), not because it happens to
//      appear in a list this test could not have caught being wrong. ─────────────────────────

function noiseBlock(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, i) => noiseLine(offset + i)).join("\n") + "\n";
}

/** The counterfactual ledger content: `original` with every line whose `step` is
 *  `droppedStep` removed, all else byte-identical — "a rotation that drops a
 *  decision-relevant line from the reader's view", isolated to exactly one step. */
function withoutStep(original: string, droppedStep: string): string {
  return original
    .split("\n")
    .filter((raw) => {
      const t = raw.trim();
      if (!t) return true;
      try {
        return (JSON.parse(t) as { step?: unknown }).step !== droppedStep;
      } catch {
        return true;
      }
    })
    .join("\n");
}

test("FALSIFIER — dispatch breaker: dropping run.start lines un-trips an actually-tripped breaker; a real rotation never does", () => {
  const dir = tmpDir();
  try {
    const taskId = "W1-FALSIFY-BREAKER";
    const original =
      Array.from({ length: 6 }, (_, i) => JSON.stringify({ run_id: `r${i}`, task_id: taskId, step: "run.start" })).join(
        "\n",
      ) +
      "\n" +
      noiseBlock(300);

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    const groundTruth = readLedgerLines(groundTruthPath);
    const trippedGroundTruth = isDispatchBreakerTripped(groundTruth, taskId, 5);
    assert.equal(trippedGroundTruth, true, "sanity: 6 dispatches >= maxDispatches(5) really is tripped");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "run.start"));
    const dropped = readLedgerLines(droppedPath);
    const trippedAfterDrop = isDispatchBreakerTripped(dropped, taskId, 5);
    assert.equal(
      trippedAfterDrop,
      false,
      "FALSIFIER: dropping run.start lines silently un-trips the breaker — this is the exact bug this task fixes",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    const rotated = readLedgerLines(rotatedPath);
    const trippedAfterRealRotation = isDispatchBreakerTripped(rotated, taskId, 5);
    assert.equal(
      trippedAfterRealRotation,
      trippedGroundTruth,
      "the REAL rotation retains run.start — it must read identically to ground truth, unlike the naive drop above",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — escalation dedup: dropping the dispatch.circuit_broken.escalated line re-opens a duplicate escalation issue; a real rotation never does", () => {
  const dir = tmpDir();
  try {
    const taskId = "W1-FALSIFY-ESCALATION";
    const task: Task = {
      id: taskId,
      title: "falsifier fixture",
      repo: "acme/widgets",
      depends_on: [],
      type: "implement",
      verify: "auto",
      risk: "medium",
      status: "blocked",
      attempts: 5,
    };
    const original =
      JSON.stringify({ run_id: "r0", task_id: taskId, step: "dispatch.circuit_broken.escalated", issue_url: "https://github.com/acme/widgets/issues/1", delivered: true }) +
      "\n" +
      noiseBlock(300);

    function issuesCreatingFake(): { calls: number; issues: IssueGateway } {
      const fake = {
        calls: 0,
        issues: {
          create: (_title: string, _body: string, _labels: string[]) => {
            fake.calls++;
            return `https://github.com/acme/widgets/issues/${100 + fake.calls}`;
          },
        },
      };
      return fake;
    }

    // Ground truth: the dedup line is present -> escalateCircuitBreak must be a no-op.
    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    const gtFake = issuesCreatingFake();
    escalateCircuitBreak(task, { owner: "acme", repo: "widgets", ledgerPath: groundTruthPath, runId: "run-gt", issues: gtFake.issues });
    assert.equal(gtFake.calls, 0, "sanity: already-escalated must not create a second issue");

    // Line dropped: the SAME dedup line removed -> escalateCircuitBreak (wrongly) fires again.
    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "dispatch.circuit_broken.escalated"));
    const dropFake = issuesCreatingFake();
    escalateCircuitBreak(task, { owner: "acme", repo: "widgets", ledgerPath: droppedPath, runId: "run-drop", issues: dropFake.issues });
    assert.equal(
      dropFake.calls,
      1,
      "FALSIFIER: dropping the escalation-dedup line causes a DUPLICATE escalation issue to be opened",
    );

    // Real rotation retains the dedup line -> still a no-op.
    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    const rotFake = issuesCreatingFake();
    escalateCircuitBreak(task, { owner: "acme", repo: "widgets", ledgerPath: rotatedPath, runId: "run-rot", issues: rotFake.issues });
    assert.equal(rotFake.calls, 0, "the REAL rotation retains the dedup line — no duplicate escalation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — credit-backfill dedup: dropping the verdict.merged line re-credits an already-credited merge; a real rotation never does", async () => {
  const dir = tmpDir();
  try {
    const taskId = "W1-FALSIFY-CREDIT";
    const prUrl = "https://github.com/acme/widgets/pull/42";
    const original =
      JSON.stringify({ run_id: "r0", task_id: taskId, step: "verdict.merged", pr_url: prUrl }) + "\n" + noiseBlock(300);
    const candidate = [{ taskId, prNumber: 42, prUrl, merged: true }];

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    const gtSummary = await runCreditBackfill(candidate, { ledgerPath: groundTruthPath, runId: "run-gt", dryRun: false });
    assert.equal(gtSummary.results[0]?.corrected, false, "sanity: already-credited must not re-correct");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "verdict.merged"));
    const dropSummary = await runCreditBackfill(candidate, { ledgerPath: droppedPath, runId: "run-drop", dryRun: false });
    assert.equal(
      dropSummary.results[0]?.corrected,
      true,
      "FALSIFIER: dropping the verdict.merged line causes a DUPLICATE verdict.merged correction to be appended",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    const rotSummary = await runCreditBackfill(candidate, { ledgerPath: rotatedPath, runId: "run-rot", dryRun: false });
    assert.equal(rotSummary.results[0]?.corrected, false, "the REAL rotation retains verdict.merged — no re-credit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — sweep dedup: dropping the sweep.disposed(armed) line re-arms an already-armed PR; a real rotation never does", async () => {
  const dir = tmpDir();
  try {
    const prNumber = 7;
    const pr: OpenPrView = {
      prNumber,
      prUrl: "https://github.com/acme/widgets/pull/7",
      taskId: "W1-FALSIFY-SWEEP",
      reviewState: "success",
      checksState: "green",
      unmetCriteria: [],
      priorStrikes: 0,
      lastActivityAt: new Date().toISOString(),
      headSha: "deadbeef",
      autoMergeArmed: false,
    };
    const original =
      JSON.stringify({ run_id: "r0", task_id: pr.taskId, step: "sweep.disposed", disposition: "mergeable", pr_number: prNumber, acted: true }) +
      "\n" +
      noiseBlock(300);

    async function armCount(ledgerPath: string): Promise<number> {
      let arms = 0;
      await runSweep(
        [pr],
        {
          arm: () => {
            arms++;
          },
          close: () => {},
          dispatchFix: () => {},
          escalate: () => {},
          ledgerPath,
          runId: "run-armcount",
        },
        DEFAULT_SWEEP_POLICY,
      );
      return arms;
    }

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    assert.equal(await armCount(groundTruthPath), 0, "sanity: already-armed must not re-arm");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "sweep.disposed"));
    assert.equal(
      await armCount(droppedPath),
      1,
      "FALSIFIER: dropping the sweep.disposed(armed) line causes a DUPLICATE arm() call",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    assert.equal(await armCount(rotatedPath), 0, "the REAL rotation retains sweep.disposed — no duplicate arm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — ratify dedup: dropping the ratify.approved line makes an already-ratified proposal look un-ratified; a real rotation never does", () => {
  const dir = tmpDir();
  try {
    const proposalId = "W1-FALSIFY-RATIFY";
    const original =
      JSON.stringify({ run_id: "r0", task_id: proposalId, step: "ratify.approved" }) + "\n" + noiseBlock(300);

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    assert.equal(isRatifiedInLedger(readLedgerLines(groundTruthPath), proposalId), true, "sanity: recorded as ratified");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "ratify.approved"));
    assert.equal(
      isRatifiedInLedger(readLedgerLines(droppedPath), proposalId),
      false,
      "FALSIFIER: dropping ratify.approved makes an already-ratified proposal look un-ratified — re-offering it",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    assert.equal(
      isRatifiedInLedger(readLedgerLines(rotatedPath), proposalId),
      true,
      "the REAL rotation retains ratify.approved — still reads ratified",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — alert-escalation dedup: dropping the escalation.issue_opened line forgets a prior alert escalation; a real rotation never does", () => {
  const dir = tmpDir();
  try {
    const alertTaskId = "W1-FALSIFY-ALERT";
    const original =
      JSON.stringify({ run_id: "r0", task_id: alertTaskId, step: "escalation.issue_opened", class: "MANUAL" }) +
      "\n" +
      noiseBlock(300);

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    assert.ok(priorEscalatedAlertIds(readLedgerLines(groundTruthPath)).has(alertTaskId), "sanity: recorded as escalated");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "escalation.issue_opened"));
    assert.equal(
      priorEscalatedAlertIds(readLedgerLines(droppedPath)).has(alertTaskId),
      false,
      "FALSIFIER: dropping escalation.issue_opened forgets a prior alert escalation — it would re-fire",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    assert.ok(
      priorEscalatedAlertIds(readLedgerLines(rotatedPath)).has(alertTaskId),
      "the REAL rotation retains escalation.issue_opened — still remembered",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER — fix-strike history: dropping a fix.review line hides that a strike already reached CI-green; a real rotation never does", () => {
  const dir = tmpDir();
  try {
    const taskId = "W1-FALSIFY-STRIKE";
    const original =
      JSON.stringify({ run_id: "r0", task_id: taskId, step: "fix.dispatch", strike: 1, round: "fresh", unmet_count: 2 }) +
      "\n" +
      JSON.stringify({ run_id: "r1", task_id: taskId, step: "fix.review", strike: 1, state: "success" }) +
      "\n" +
      noiseBlock(300);

    const groundTruthPath = join(dir, "ground-truth.ndjson");
    writeFileSync(groundTruthPath, original);
    const gtHistory = deriveStrikeHistory(readLedgerLines(groundTruthPath), taskId);
    assert.equal(gtHistory[0]?.ciGreen, true, "sanity: strike 1 reached CI green");

    const droppedPath = join(dir, "line-dropped.ndjson");
    writeFileSync(droppedPath, withoutStep(original, "fix.review"));
    const dropHistory = deriveStrikeHistory(readLedgerLines(droppedPath), taskId);
    assert.equal(
      dropHistory[0]?.ciGreen,
      false,
      "FALSIFIER: dropping fix.review hides that strike 1 ever reached CI green — history now looks incomplete",
    );

    const rotatedPath = join(dir, "real-rotation.ndjson");
    writeFileSync(rotatedPath, original);
    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(rotatedPath, ceiling));
    const result = rotateLedger(rotatedPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    const rotHistory = deriveStrikeHistory(readLedgerLines(rotatedPath), taskId);
    assert.equal(rotHistory[0]?.ciGreen, true, "the REAL rotation retains fix.review — history still complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
