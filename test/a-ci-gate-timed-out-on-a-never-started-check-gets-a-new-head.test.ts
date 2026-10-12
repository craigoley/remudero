// W1-T5921 — a ci-gate red that is exactly W1-T312's wait-cap TIMEOUT (plus W1-T3345's SHARD HANG
// aggregates) carries no verdict about the diff. The gate itself names the remedy: a NEW sha. This
// suite pins that the sweep answers it with one update-branch base refresh per head (never a
// same-sha job requeue or a paid ci-log fix strike), keeps genuine failures on the fix rung, and
// escalates once at the BACKSTOP or when no refresh is possible.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readLedgerLines } from "../src/lib/status.js";
import { DECISION_RELEVANT_LEDGER_STEPS, appendLedger } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  CI_TIMEOUT_REFRESH_BACKSTOP,
  DEFAULT_SWEEP_POLICY,
  ciTimeoutRefreshDecision,
  classifyCiTimeoutNoVerdict,
  runSweep,
  type CancelledRequiredCheck,
  type CiFailure,
  type FixDispatchEvidence,
  type LiveStateResult,
  type OpenPrView,
  type RollupCheckEntry,
  type SweepDeps,
  type UpdateBranchOutcome,
} from "./helpers/sweep-test.js";

// The #9388 evidence, verbatim in shape: the gate's own error line, then its not-ready list.
const TIMEOUT_LINE =
  "ci-gate: TIMED OUT waiting for required check(s) to complete (this is NOT a check failure -- a NEW sha " +
  "is the only remedy, re-running this same sha will not help):";
const GATE_LOG_TAIL = [
  "2026-10-05T21:29:59.1000000Z waiting for required check(s) to complete:",
  "2026-10-05T21:29:59.1000000Z   - rule-checks",
  `2026-10-05T21:30:01.0000000Z ##[error]${TIMEOUT_LINE}`,
  "2026-10-05T21:30:01.0000000Z   - rule-checks",
  "2026-10-05T21:30:01.2000000Z ##[error]Process completed with exit code 1.",
].join("\n");

function hang(name: string): CiFailure {
  return {
    name,
    conclusion: "FAILURE",
    jobId: `${name.length}00`,
    logTail:
      `${name}: SHARD HANG — the matrix was cancelled while the PR head\n` +
      "  (befbe485) was unchanged, so nothing superseded it: a shard was killed at its\n" +
      "  timeout-minutes ceiling. THE TESTS DID NOT RUN — this is NOT a failure of this diff\n" +
      "  Last started unfinished test: unavailable (no started-without-finished TAP test found).",
  };
}

function gate(logTail = GATE_LOG_TAIL): CiFailure {
  return { name: "ci-gate", conclusion: "FAILURE", jobId: "900", logTail };
}

const SHARDS: CancelledRequiredCheck[] = Array.from({ length: 4 }, (_, i) => ({
  name: `test (${i + 1}/8)`,
  jobId: `7${i}`,
}));

const HEAD = "befbe485aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function subject(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9388,
    prUrl: "https://github.com/craigoley/remudero/pull/9388",
    taskId: "W1-T5885",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-05T21:30:00Z", // expiring-fixture: exempt -- every runSweep below injects `now` pinned ten minutes later (deps()), so the age comparison never reads the wall clock
    headSha: HEAD,
    headRefName: "run-W1-T5885-1791230000000",
    autoMergeArmed: false,
    redRequiredChecks: ["ci", "coverage-ratchet"],
    ciFailures: [gate(), hang("ci"), hang("coverage-ratchet")],
    cancelledRequiredChecks: SHARDS,
    ...overrides,
  };
}

interface Harness {
  d: SweepDeps;
  updated: string[];
  requeued: string[];
  fixed: FixDispatchEvidence[];
  escalated: string[];
  reaggregated: string[];
}

function harness(
  ledgerPath: string,
  opts: {
    update?: (pr: { headSha: string }) => UpdateBranchOutcome;
    live?: () => LiveStateResult;
    rollup?: RollupCheckEntry[];
    behind?: number;
    unwired?: boolean;
  } = {},
): Harness {
  const h: Harness = { d: undefined as unknown as SweepDeps, updated: [], requeued: [], fixed: [], escalated: [], reaggregated: [] };
  h.d = {
    arm: () => {},
    close: () => {},
    dispatchFix: (_pr, evidence) => {
      h.fixed.push(evidence);
    },
    escalate: (_pr, reason) => {
      h.escalated.push(reason);
    },
    requeueCheck: (_pr, check) => {
      h.requeued.push(check.name);
      return true;
    },
    reaggregateCiGate: (_pr, transition) => {
      h.reaggregated.push(transition.siblingName);
    },
    ...(opts.rollup ? { readCiGateRollup: () => opts.rollup } : {}),
    ...(opts.behind !== undefined ? { behindMainByPr: new Map([[9388, opts.behind]]) } : {}),
    readLiveState: (pr) => (opts.live ? opts.live() : { ok: true, state: "OPEN", headSha: pr.headSha }),
    ...(opts.unwired
      ? {}
      : {
          updateBranch: (pr) => {
            // Durable BEFORE the mutation: a crash after the call still bounds the next pass.
            const before = readLedgerLines(ledgerPath).find(
              (line) => line.step === "sweep.ci_timeout_refresh.attempted" && line.head_sha === pr.headSha,
            );
            assert.ok(before, "the attempt is ledgered before update-branch is called");
            h.updated.push(pr.headSha);
            return opts.update ? opts.update(pr) : "updated";
          },
        }),
    ledgerPath,
    runId: "SWEEP-W1-T5921",
    now: () => Date.parse("2026-10-05T21:40:00Z"),
  };
  return h;
}

function ledger(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5921-${label}-`)), "ledger.ndjson");
}

function disposed(ledgerPath: string, head = HEAD): Record<string, unknown> | undefined {
  return readLedgerLines(ledgerPath).findLast((line) => line.step === "sweep.disposed" && line.head_sha === head);
}

test("classifyCiTimeoutNoVerdict: the #9388 shape classifies, naming the never-started check and the hung aggregates", () => {
  assert.deepEqual(
    classifyCiTimeoutNoVerdict([gate(), hang("ci"), hang("coverage-ratchet")], ["ci", "coverage-ratchet"], []),
    { notReady: ["rule-checks"], hung: ["ci", "coverage-ratchet"] },
  );
  // The annotation fallback carries only the error line, never the list that follows it.
  assert.deepEqual(classifyCiTimeoutNoVerdict([gate(TIMEOUT_LINE)], [], []), { notReady: [], hung: [] });
  // A cancelled required check carries no verdict either; a red name the gate listed is tolerated.
  assert.deepEqual(
    classifyCiTimeoutNoVerdict(
      [gate(), { name: "test (1/8)", conclusion: "CANCELLED", logTail: "" }],
      ["rule-checks", "test (1/8)"],
      ["test (1/8)"],
    ),
    { notReady: ["rule-checks"], hung: [] },
  );
});

test("classifyCiTimeoutNoVerdict: any genuine verdict disqualifies the shape", () => {
  const genuine = [
    { name: "test (3/8)", conclusion: "FAILURE", logTail: "not ok 3 - a real assertion\n# fail 1" },
    { name: "typecheck", conclusion: "FAILURE", logTail: "src/x.ts(1,1): error TS2322: nope" },
    { name: "diff-coverage", conclusion: "FAILURE", logTail: "diff-coverage: FAIL -- 3 added line(s) uncovered" },
    { name: "rule-checks", conclusion: "FAILURE", logTail: "rule 15: a plan record rides along" },
  ];
  for (const failure of genuine) {
    assert.equal(
      classifyCiTimeoutNoVerdict([gate(), hang("ci"), failure], [], []),
      undefined,
      `a ${failure.name} failure keeps the fix rung`,
    );
  }
  assert.equal(classifyCiTimeoutNoVerdict([hang("ci")], ["ci"], []), undefined, "no TIMED OUT line, no shape");
  assert.equal(
    classifyCiTimeoutNoVerdict([gate()], ["acceptance-author-gate"], []),
    undefined,
    "a red required check with no evidence and not named by the gate is not proven verdict-free",
  );
  assert.equal(
    classifyCiTimeoutNoVerdict([gate(`${TIMEOUT_LINE}\nAssertionError: boom`)], [], []),
    undefined,
    "even the gate's own tail is refused when it carries a genuine failure",
  );
});

test("the #9388 shape gets ONE update-branch refresh, with no job requeue and no fix strike", async () => {
  const path = ledger("refresh");
  const h = harness(path);
  await runSweep([subject()], h.d, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(h.updated, [HEAD], "one base refresh — a real two-parent merge of main into the head");
  assert.deepEqual(h.requeued, [], "no same-sha job requeue");
  assert.equal(h.fixed.length, 0, "no paid ci-log fix worker");
  assert.equal(h.escalated.length, 0);
  const rows = readLedgerLines(path);
  const outcome = rows.find((line) => line.step === "sweep.ci_timeout_refresh.outcome");
  assert.equal(outcome?.outcome, "updated");
  assert.deepEqual(outcome?.not_ready_checks, ["rule-checks"]);
  const row = disposed(path);
  assert.equal(row?.acted, false, "nothing seeds prior.fixed");
  assert.match(String(row?.stand_down_reason), /rule-checks/);
  assert.match(String(row?.stand_down_reason), /base refresh requested/);

  // The same head on the next pass waits for the new head; it never refreshes or strikes twice.
  const again = harness(path);
  await runSweep([subject()], again.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(again.updated, []);
  assert.deepEqual(again.requeued, []);
  assert.equal(again.fixed.length, 0);
  assert.equal(again.escalated.length, 0);
  assert.match(String(disposed(path)?.stand_down_reason), /awaiting the new head/);
});

test("a head with a genuine test failure still dispatches the fix rung and is never refreshed", async () => {
  const path = ledger("genuine");
  const h = harness(path);
  const real: CiFailure = { name: "test (3/8)", conclusion: "FAILURE", jobId: "33", logTail: "not ok 7 - real\n# fail 1" };
  await runSweep(
    [subject({ ciFailures: [gate(), hang("ci"), real], cancelledRequiredChecks: [] })],
    h.d,
    DEFAULT_SWEEP_POLICY,
  );
  assert.deepEqual(h.updated, []);
  assert.equal(h.fixed.length, 1, "the ordinary fix rung");
  assert.equal(readLedgerLines(path).filter((line) => String(line.step).startsWith("sweep.ci_timeout_refresh")).length, 0);
});

test("each new head gets its own refresh; at the BACKSTOP the sweep escalates ONCE naming the never-started checks", async () => {
  const path = ledger("bound");
  for (let i = 0; i < CI_TIMEOUT_REFRESH_BACKSTOP; i += 1) {
    const h = harness(path);
    await runSweep([subject({ headSha: `head-${i}` })], h.d, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(h.updated, [`head-${i}`], `head ${i} is refreshed`);
  }
  const atBound = harness(path);
  await runSweep([subject({ headSha: "head-bound" })], atBound.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(atBound.updated, [], "the BACKSTOP stops the refresh loop");
  assert.equal(atBound.fixed.length, 0);
  assert.deepEqual(atBound.requeued, []);
  assert.equal(atBound.escalated.length, 1);
  assert.match(atBound.escalated[0], /rule-checks/);
  assert.match(atBound.escalated[0], /BACKSTOP/);

  const repeat = harness(path);
  await runSweep([subject({ headSha: "head-bound" })], repeat.d, DEFAULT_SWEEP_POLICY);
  assert.equal(repeat.escalated.length, 0, "escalated once per (PR, head)");
  assert.deepEqual(repeat.updated, []);
  assert.equal(repeat.fixed.length, 0);

  // A head the operator pushes after the escalation starts a fresh count.
  const fresh = harness(path);
  await runSweep([subject({ headSha: "head-operator" })], fresh.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(fresh.updated, ["head-operator"], "a new head after the escalation restarts the count");
});

test("ciTimeoutRefreshDecision: a genuine fix dispatch between refreshes breaks the consecutive count", () => {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < CI_TIMEOUT_REFRESH_BACKSTOP; i += 1) {
    rows.push({ step: "sweep.ci_timeout_refresh.attempted", pr_number: 9388, head_sha: `h${i}` });
  }
  assert.equal(ciTimeoutRefreshDecision(rows, { prNumber: 9388, headSha: "next" }).kind, "escalate");
  rows.push({ step: "sweep.disposed", pr_number: 9388, head_sha: "h9", disposition: "blocked-fixable", acted: true });
  assert.equal(ciTimeoutRefreshDecision(rows, { prNumber: 9388, headSha: "next" }).kind, "refresh");
  assert.equal(ciTimeoutRefreshDecision(rows, { prNumber: 1, headSha: "next" }).kind, "refresh", "another PR's rows never count");
  // A crash between the attempt and its outcome is not a refresh this sweep may assume happened.
  const crashed = [{ step: "sweep.ci_timeout_refresh.attempted", pr_number: 9388, head_sha: "c" }];
  assert.equal(ciTimeoutRefreshDecision(crashed, { prNumber: 9388, headSha: "c" }).kind, "escalate");
});

test("a head not behind main is escalated once, never refreshed", async () => {
  const path = ledger("not-behind");
  const h = harness(path, { behind: 0 });
  await runSweep([subject()], h.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.updated, []);
  assert.equal(h.fixed.length, 0);
  assert.deepEqual(h.requeued, []);
  assert.equal(h.escalated.length, 1);
  assert.match(h.escalated[0], /not behind main/);
  const again = harness(path, { behind: 0 });
  await runSweep([subject()], again.d, DEFAULT_SWEEP_POLICY);
  assert.equal(again.escalated.length, 0);
});

test("a behind head still refreshes when the behind count says so", async () => {
  const path = ledger("behind");
  const h = harness(path, { behind: 4 });
  await runSweep([subject()], h.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.updated, [HEAD]);
});

test("a conflicting refresh is ledgered and escalated once, and does not loop", async () => {
  const path = ledger("conflict");
  const h = harness(path, { update: () => "conflict" });
  await runSweep([subject()], h.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.updated, [HEAD]);
  assert.equal(h.escalated.length, 1);
  assert.match(h.escalated[0], /conflict/);
  assert.equal(readLedgerLines(path).find((line) => line.step === "sweep.ci_timeout_refresh.outcome")?.outcome, "conflict");
  const again = harness(path, { update: () => "conflict" });
  await runSweep([subject()], again.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(again.updated, []);
  assert.equal(again.escalated.length, 0);
  assert.equal(again.fixed.length, 0);
});

test("a throwing update-branch is recorded as an error outcome and escalated, never read as a refresh", async () => {
  const path = ledger("throws");
  const h = harness(path, {
    update: () => {
      throw new Error("gh exploded");
    },
  });
  await runSweep([subject()], h.d, DEFAULT_SWEEP_POLICY);
  const outcome = readLedgerLines(path).find((line) => line.step === "sweep.ci_timeout_refresh.outcome");
  assert.equal(outcome?.outcome, "error");
  assert.match(String(outcome?.error), /gh exploded/);
  assert.equal(h.escalated.length, 1);
  assert.match(h.escalated[0], /error/);
  assert.equal(h.fixed.length, 0);
});

test("an unwired update-branch defers rather than falling through to a fix strike (W1-T5954)", async () => {
  const path = ledger("unwired");
  const h = harness(path, { unwired: true });
  await runSweep([subject()], h.d, DEFAULT_SWEEP_POLICY);
  assert.equal(h.fixed.length, 0);
  assert.deepEqual(h.requeued, []);
  assert.equal(h.escalated.length, 0);
  assert.match(String(disposed(path)?.stand_down_reason), /deferred to full sweep/);
});

test("a fresh read that shows the head moved, or cannot be read, refuses the refresh", async () => {
  const movedPath = ledger("moved");
  let reads = 0;
  // The arm's first read sees the snapshot head; the refresh's own re-read sees a push land.
  const moved = harness(movedPath, {
    live: () => ({ ok: true, state: "OPEN", headSha: (reads += 1) === 1 ? HEAD : "pushed" }),
  });
  await runSweep([subject()], moved.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(moved.updated, []);
  assert.equal(moved.fixed.length, 0);
  assert.equal(moved.escalated.length, 0);
  assert.match(String(disposed(movedPath)?.stand_down_reason), /head moved/);

  const mergedPath = ledger("merged");
  let mergedReads = 0;
  const merged = harness(mergedPath, {
    live: () => ({ ok: true, state: (mergedReads += 1) === 1 ? "OPEN" : "MERGED", headSha: HEAD }),
  });
  await runSweep([subject()], merged.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(merged.updated, []);
  assert.match(String(disposed(mergedPath)?.stand_down_reason), /refresh refused: state is MERGED/);

  const unreadablePath = ledger("unreadable");
  let calls = 0;
  const unreadable = harness(unreadablePath, {
    live: () => ((calls += 1) === 1 ? { ok: true, state: "OPEN", headSha: HEAD } : { ok: false }),
  });
  await runSweep([subject()], unreadable.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(unreadable.updated, []);
  assert.equal(unreadable.fixed.length, 0);
  assert.match(String(disposed(unreadablePath)?.stand_down_reason), /unreadable/);
  assert.equal(
    readLedgerLines(unreadablePath).filter((line) => line.step === "sweep.ci_timeout_refresh.attempted").length,
    0,
    "an unread head spends no attempt",
  );
});

test("a stale ci-gate re-drive is skipped unless its transition proves the not-ready check completed", async () => {
  const rollup = (sibling: string): RollupCheckEntry[] => [
    { name: "ci-gate", conclusion: "FAILURE", status: "COMPLETED", startedAt: "2026-10-05T21:00:00Z" },
    { name: sibling, conclusion: "SUCCESS", status: "COMPLETED", startedAt: "2026-10-05T21:31:00Z" },
    { name: "ci", conclusion: "FAILURE", status: "COMPLETED", startedAt: "2026-10-05T21:01:00Z" },
    { name: "coverage-ratchet", conclusion: "FAILURE", status: "COMPLETED", startedAt: "2026-10-05T21:01:00Z" },
  ];
  const other = harness(ledger("redrive-other"), { rollup: rollup("lint") });
  await runSweep([subject()], other.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(other.reaggregated, [], "a same-sha re-drive over an unrelated sibling cannot clear a timeout");
  assert.deepEqual(other.updated, [HEAD]);

  const completed = harness(ledger("redrive-kept"), { rollup: rollup("rule-checks") });
  await runSweep([subject()], completed.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(completed.reaggregated, ["rule-checks"], "the not-ready check has a verdict now — re-aggregate");
  assert.deepEqual(completed.updated, []);
});

test("a timed-out gate that is green or in flight on the fresh rollup is not red (W1-T5654 runs first)", async () => {
  const h = harness(ledger("fresh"), {
    rollup: [
      { name: "ci-gate", status: "IN_PROGRESS", startedAt: "2026-10-05T21:35:00Z" },
      { name: "ci", conclusion: "SUCCESS", status: "COMPLETED", startedAt: "2026-10-05T21:35:00Z" },
      { name: "coverage-ratchet", conclusion: "SUCCESS", status: "COMPLETED", startedAt: "2026-10-05T21:35:00Z" },
    ],
  });
  await runSweep([subject({ cancelledRequiredChecks: [] })], h.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.updated, []);
  assert.equal(h.fixed.length, 0);
});

test("the refresh and escalation rows survive rotation, because the bound reads them back", () => {
  for (const step of [
    "sweep.ci_timeout_refresh.attempted",
    "sweep.ci_timeout_refresh.outcome",
    "sweep.ci_timeout_refresh.escalated",
  ]) {
    assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(step), step);
  }
  // appendLedger is the writer the sweep defaults to; a row it writes is what the decision reads.
  const path = ledger("rows");
  appendLedger(path, { run_id: "R", task_id: "W1-T5885", step: "sweep.ci_timeout_refresh.escalated", pr_number: 9388, head_sha: HEAD });
  assert.equal(ciTimeoutRefreshDecision(readLedgerLines(path), { prNumber: 9388, headSha: HEAD }).kind, "escalated");
});
