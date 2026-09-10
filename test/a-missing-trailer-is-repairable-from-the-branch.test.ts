import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  missingTaskTrailerRepairDecision,
  runSweep,
  type MissingTaskTrailerRepair,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const RECENT = "2026-09-10T11:00:00.000Z";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-missing-trailer-")), "ledger.ndjson");
}

function subject(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 4862,
    prUrl: "https://github.com/craigoley/remudero/pull/4862",
    taskId: undefined,
    reviewState: "failure",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "abc1234",
    headRefName: "run-W1-T3283-1789010600618",
    autoMergeArmed: false,
    body: "## Summary\n\nImplementation details only.\n",
    taskExistsOnMain: true,
    introducedTaskIds: [],
    changedFiles: ["src/lib/sweep.ts", "test/a-missing-trailer-is-repairable-from-the-branch.test.ts"],
    taskDeclaredFiles: ["src/lib/sweep.ts", "test/a-missing-trailer-is-repairable-from-the-branch.test.ts"],
    ciFailures: [{ name: "acceptance-author-gate", logTail: "REFUSED (no-header)" }],
    ...over,
  };
}

function fakeDeps(over: Partial<SweepDeps> = {}): SweepDeps & {
  dispatches: OpenPrView[];
  escalations: OpenPrView[];
  edits: Array<{ pr: OpenPrView; repair: MissingTaskTrailerRepair }>;
  reruns: string[];
  rows: Array<Record<string, unknown>>;
} {
  const rows: Array<Record<string, unknown>> = [];
  const dispatches: OpenPrView[] = [];
  const escalations: OpenPrView[] = [];
  const edits: Array<{ pr: OpenPrView; repair: MissingTaskTrailerRepair }> = [];
  const reruns: string[] = [];
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: (pr) => {
      dispatches.push(pr);
    },
    escalate: (pr) => {
      escalations.push(pr);
    },
    repairMissingTaskTrailer: (pr, repair) => {
      edits.push({ pr, repair });
    },
    requeueCheck: (_pr, check) => {
      reruns.push(check.name);
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-W1-T3283",
    now: () => NOW,
    readLedger: () => rows,
    appendLine: (_path, line) => {
      rows.push(line);
    },
    log: () => {},
    dispatches,
    escalations,
    edits,
    reruns,
    rows,
    ...over,
  };
}

test("W1-T3283: a body with neither accepted gate input gains the branch-derived trailer", async () => {
  const deps = fakeDeps();

  const summary = await runSweep([subject()], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.edits.length, 1);
  assert.equal(deps.edits[0].repair.taskId, "W1-T3283");
  assert.equal(deps.edits[0].repair.trailer, "Remudero-Task: W1-T3283");
  assert.match(deps.edits[0].repair.repairedBody, /Remudero-Task: W1-T3283\n$/);
  assert.match(deps.edits[0].repair.repairedBody, /derived W1-T3283 from branch run-W1-T3283-1789010600618/);
  assert.deepEqual(deps.dispatches, [], "the ci-log fix rung must not spend a worker on this body-only repair");
  assert.deepEqual(deps.escalations, []);
  assert.equal(summary.byDisposition["blocked-fixable"], 1);
});

test("W1-T3283: a body that already carries a trailer or Acceptance block is left byte-for-byte unchanged", () => {
  const withTrailer = "Summary.\n\nRemudero-Task: W1-OTHER\n";
  const withAcceptance = "## Acceptance\n\n- it proves itself | unit test: test/x.test.ts\n";

  assert.deepEqual(
    missingTaskTrailerRepairDecision(subject({ body: withTrailer })),
    { action: "ignore", reason: "body already carries an accepted gate input" },
  );
  assert.deepEqual(
    missingTaskTrailerRepairDecision(subject({ body: withAcceptance })),
    { action: "ignore", reason: "body already carries an accepted gate input" },
  );
});

test("W1-T3283: a PR that adds its own task record is refused rather than self-credited", async () => {
  const deps = fakeDeps();
  const summary = await runSweep([subject({ introducedTaskIds: ["W1-T3283"] })], deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(deps.edits, []);
  assert.deepEqual(deps.dispatches, [], "self-credit refusal must not fall through to the ci-log worker");
  assert.equal(summary.actions[0].acted, false);
  assert.match(String(deps.rows.at(-1)?.stand_down_reason), /adds W1-T3283's own plan record/);
});

test("W1-T3283: a branch with no task id, or an id with no main-plan record, stands down", async () => {
  const noBranchTask = fakeDeps();
  await runSweep([subject({ headRefName: "fix/no-trailer" })], noBranchTask, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(noBranchTask.edits, []);
  assert.deepEqual(noBranchTask.dispatches, []);
  assert.match(String(noBranchTask.rows.at(-1)?.stand_down_reason), /head branch does not match run-<taskId>-<epoch>/);

  const noRecord = fakeDeps();
  await runSweep([subject({ taskExistsOnMain: false })], noRecord, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(noRecord.edits, []);
  assert.deepEqual(noRecord.dispatches, []);
  assert.match(String(noRecord.rows.at(-1)?.stand_down_reason), /no plan record for W1-T3283 on main/);
});

test("W1-T3283: the repair refires pull_request edited and never reruns a failed job", async () => {
  const deps = fakeDeps();
  await runSweep([subject()], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.edits[0].repair.refireEvent, "pull_request.edited");
  assert.equal(deps.edits[0].repair.rerunFailedJobs, false);
  assert.deepEqual(deps.reruns, [], "the old failed job payload must never be replayed");
  assert.equal(deps.rows.some((row) => row.step === "sweep.missing_task_trailer_repaired"), true);
});

test("W1-T3283: changed paths outside declared files are reported and do not block the repair", async () => {
  const deps = fakeDeps();
  await runSweep(
    [subject({ changedFiles: ["src/lib/sweep.ts", "src/lib/unexpected.ts"] })],
    deps,
    DEFAULT_SWEEP_POLICY,
  );

  assert.equal(deps.edits.length, 1);
  assert.deepEqual(deps.edits[0].repair.scopeOverrunPaths, ["src/lib/unexpected.ts"]);
  assert.match(deps.edits[0].repair.repairedBody, /src\/lib\/unexpected\.ts/);
  const row = deps.rows.find((entry) => entry.step === "sweep.missing_task_trailer_repaired");
  assert.deepEqual(row?.scope_overrun_paths, ["src/lib/unexpected.ts"]);
});

// ── THE FAIL-SAFE BRANCHES ────────────────────────────────────────────────────────────────────
//
// Every test above drives the HAPPY path or a refusal the decision function reaches on its own
// inputs. The four below drive the arms that only fire when the SWEEP's own state or wiring is
// degraded — an unobserved diff, a missing effect, a declining writer, a head already repaired.
// Each of those returns `handled: true` with a stand-down reason, which means a regression there
// is SILENT: the PR simply stops being repaired and the sweep reports it acted. They are asserted
// on the reason text because that text is the only observable the rung produces.

test("W1-T3283 FAIL-SAFE: an unobserved changed-file list stands down rather than risking self-credit", async () => {
  const deps = fakeDeps();
  const summary = await runSweep([subject({ introducedTaskIds: undefined })], deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(deps.edits, [], "a diff the sweep never observed must not be trusted enough to write a trailer");
  assert.deepEqual(deps.dispatches, [], "standing down must not fall through to the ci-log worker");
  assert.equal(summary.actions[0].acted, false);
  assert.match(String(deps.rows.at(-1)?.stand_down_reason), /were not observed, so self-credit cannot be ruled out/);
});

test("W1-T3283 FAIL-SAFE: an unwired repair effect says so instead of silently leaving the body unchanged", async () => {
  const deps = fakeDeps({ repairMissingTaskTrailer: undefined });
  await runSweep([subject()], deps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(deps.edits, []);
  // The DERIVED trailer is named in the reason: the decision succeeded and only the write was
  // missing, which is a different defect from the decision refusing, and must read differently.
  assert.match(String(deps.rows.at(-1)?.stand_down_reason), /not wired .* derived Remudero-Task: W1-T3283 but left the PR body unchanged/);
});

test("W1-T3283 FAIL-SAFE: a writer that declines leaves the repair to be re-derived, not recorded as done", async () => {
  const deps = fakeDeps({ repairMissingTaskTrailer: () => false });
  await runSweep([subject()], deps, DEFAULT_SWEEP_POLICY);

  assert.match(String(deps.rows.at(-1)?.stand_down_reason), /declined while writing .* re-derived next pass/);
  assert.equal(
    deps.rows.some((row) => row.step === "sweep.missing_task_trailer_repaired"),
    false,
    "a declined write must NOT leave a repaired row — the next pass reads that row and stands down forever",
  );
});

test("W1-T3283 FAIL-SAFE: a head already repaired is not repaired twice, and still never reruns the failed job", async () => {
  const deps = fakeDeps();
  await runSweep([subject()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.edits.length, 1, "precondition: the first pass repairs");

  // SAME deps, so the second pass reads the first pass's own ledger rows back through readLedger.
  await runSweep([subject()], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.edits.length, 1, "the same head must not be edited a second time");
  assert.match(String(deps.rows.at(-1)?.stand_down_reason), /already repaired for W1-T3283 on this head/);
  assert.deepEqual(deps.reruns, [], "and the stale failed job stays un-rerun on the repeat pass too");
});

test("W1-T3283: a declared-files GLOB covers the paths under it, so no scope overrun is reported", async () => {
  const deps = fakeDeps();
  await runSweep(
    [subject({ taskDeclaredFiles: ["src/lib/*"], changedFiles: ["src/lib/sweep.ts", "src/lib/merge-state.ts"] })],
    deps,
    DEFAULT_SWEEP_POLICY,
  );

  assert.equal(deps.edits.length, 1);
  assert.deepEqual(
    deps.edits[0].repair.scopeOverrunPaths,
    [],
    "every changed path is under the declared glob, so none is an overrun",
  );
  assert.equal(
    deps.edits[0].repair.repairedBody.includes("Changed paths outside"),
    false,
    "and the advisory line is omitted entirely rather than emitted empty",
  );
});
