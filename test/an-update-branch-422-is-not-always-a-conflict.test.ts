// W1-T5933 — AN UPDATE-BRANCH 422 IS NOT ALWAYS A CONFLICT. GitHub's PUT pulls/{n}/update-branch
// answers 422 for a merge conflict, for an expected_head_sha that no longer matches the head (the
// head moved under the read), and for a branch with nothing to merge. The classifier used to read
// every 422 as `conflict`, so W1-T5921's ci-gate-timeout lane escalated a PR whose only problem was
// a stale read. This suite pins the split verdict, an unknown 422 reading `error`, and each changed
// caller's handling of the two new outcomes: named on its row, never escalated for the outcome.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY,
  ciTimeoutRefreshDecision,
  runSweep,
  type CiFailure,
  type OpenPrView,
  type SweepDeps,
  type UpdateBranchOutcome,
} from "../src/lib/sweep.js";
// run-task.ts re-exports the classifier from src/lib/fix-rung-classify.ts (W1-T2891).
import { classifyUpdateBranchFailure, ghUpdateBranch as fixRungUpdateBranch, updateBranchViaGh } from "../src/run-task.js";
import { ghUpdateBranch as armUpdateBranch } from "../src/lib/arm-auto-merge.js";
import { ghShim } from "./helpers/gh-shim.js";

// The three 422 bodies GitHub returns for this endpoint, as `gh api` prints them on stderr.
const CONFLICT_422 = "gh: merge conflict between base and head (HTTP 422)";
const HEAD_MOVED_422 = "gh: expected head sha didn't match current head ref. (HTTP 422)";
const UP_TO_DATE_422 = "gh: There are no new commits on the base branch. (HTTP 422)";

test("W1-T5933: conflict only when GitHub names a merge conflict, head-moved, up-to-date, and any other 422 is error", () => {
  assert.equal(classifyUpdateBranchFailure(CONFLICT_422), "conflict");
  assert.equal(classifyUpdateBranchFailure("Merge conflict in src/run-task.ts"), "conflict");
  for (const s of [
    HEAD_MOVED_422,
    "gh: expected head sha didn’t match current head ref. (HTTP 422)", // GitHub's typographic apostrophe
    "HTTP 422: expected_head_sha does not match the pull request head",
  ]) {
    assert.equal(classifyUpdateBranchFailure(s), "head-moved", `"${s}" says the head moved`);
  }
  assert.equal(classifyUpdateBranchFailure(UP_TO_DATE_422), "up-to-date");
  for (const s of ["HTTP 422", "gh: Validation Failed (HTTP 422)", "HTTP 500: internal server error", ""]) {
    assert.equal(classifyUpdateBranchFailure(s), "error", `"${s}" is an unrecognised failure, never conflict`);
  }
});

test("W1-T5933: the real update-branch leaf reports head-moved and up-to-date from gh's own stderr", async () => {
  const target = { prNumber: 7, prUrl: "https://github.com/acme/remudero/pull/7", headSha: "d00d" };
  const oldPath = process.env.PATH;
  try {
    for (const [stderr, verdict] of [[HEAD_MOVED_422, "head-moved"], [UP_TO_DATE_422, "up-to-date"]] as const) {
      const shim = ghShim([{ when: "update-branch", stderr, exit: 1 }], { kind: "w1t5933-gh" });
      process.env.PATH = `${shim.dir}:${oldPath}`;
      assert.equal(await withLiveWritesAllowed(() => updateBranchViaGh(target)), verdict);
      assert.equal(shim.calls().length, 1, "one call — the leaf never retries");
    }
  } finally {
    process.env.PATH = oldPath;
  }
});

// #10470 (2026-10-09): an update-branch merged main into a PR and no ledger row said who asked.
test("every update-branch writer ledgers one row naming the path that asked for it", async () => {
  const rows: Record<string, unknown>[] = [];
  const record = (row: Record<string, unknown>) => { rows.push(row); };
  const target = { prNumber: 7, prUrl: "https://github.com/acme/remudero/pull/7", headSha: "d00d", updateReason: "distance" as const };
  const oldPath = process.env.PATH;
  try {
    const shim = ghShim([{ when: "update-branch", stdout: "{}", exit: 0 }], { kind: "branch-update-row-gh" });
    process.env.PATH = `${shim.dir}:${oldPath}`;
    assert.equal(await withLiveWritesAllowed(() => updateBranchViaGh(target, record)), "updated");
  } finally {
    process.env.PATH = oldPath;
  }
  const ok = () => Buffer.from("");
  withLiveWritesAllowed(() => fixRungUpdateBranch("acme", "remudero", 8, ok as never, "fix-rung", record));
  withLiveWritesAllowed(() => armUpdateBranch("acme", "remudero", 9, ok as never, record));
  assert.deepEqual(rows.map((r) => [r.step, r.pr_number, r.via, r.outcome]), [
    ["branch.update_requested", 7, "sweep:distance", "updated"],
    ["branch.update_requested", 8, "fix-rung", "updated"],
    ["branch.update_requested", 9, "arm-direct-merge-preflight", "updated"],
  ]);
  assert.equal(rows[0]!.expected_head_sha, "d00d");
});

test("a refused update-branch request still ledgers its row with the refusal", () => {
  const rows: Record<string, unknown>[] = [];
  const refuse = () => { throw new Error("gh: merge conflict between base and head (HTTP 422)"); };
  const result = withLiveWritesAllowed(() => fixRungUpdateBranch("acme", "remudero", 8, refuse as never, "fix-rung", (r) => rows.push(r)));
  assert.equal(result.ok, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, "error");
  assert.match(String(rows[0]!.error), /merge conflict/);
});

// ── W1-T5921's ci-gate-timeout lane ───────────────────────────────────────────────────────────

const TIMEOUT_TAIL = [
  "2026-10-05T21:30:01.0000000Z ##[error]ci-gate: TIMED OUT waiting for required check(s) to complete " +
    "(this is NOT a check failure -- a NEW sha is the only remedy):",
  "2026-10-05T21:30:01.0000000Z   - rule-checks",
].join("\n");
const HEAD = "befbe485aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function timedOut(): OpenPrView {
  const gate: CiFailure = { name: "ci-gate", conclusion: "FAILURE", jobId: "900", logTail: TIMEOUT_TAIL };
  return {
    prNumber: 9388,
    prUrl: "https://github.com/craigoley/remudero/pull/9388",
    taskId: "W1-T5885",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-05T21:30:00Z", // expiring-fixture: exempt -- `now` below is pinned ten minutes later, never the wall clock
    headSha: HEAD,
    headRefName: "run-W1-T5885-1791230000000",
    autoMergeArmed: false,
    redRequiredChecks: [],
    ciFailures: [gate],
  };
}

function lane(ledgerPath: string, outcome: UpdateBranchOutcome, liveHead = HEAD) {
  const h = { updated: [] as string[], escalated: [] as string[], fixed: 0 };
  const d: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => void (h.fixed += 1),
    escalate: (_pr, reason) => void h.escalated.push(reason),
    readLiveState: () => ({ ok: true, state: "OPEN", headSha: liveHead }),
    updateBranch: (pr) => {
      h.updated.push(pr.headSha);
      return outcome;
    },
    ledgerPath,
    runId: "SWEEP-W1-T5933",
    now: () => Date.parse("2026-10-05T21:40:00Z"),
  };
  return { h, d };
}

const ledger = (label: string): string =>
  join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5933-${label}-`)), "ledger.ndjson");
const standDown = (path: string): string =>
  String(readLedgerLines(path).findLast((l) => l.step === "sweep.disposed")?.stand_down_reason);

test("W1-T5933: a head-moved refresh in the ci-gate-timeout lane is re-read next pass, never escalated", async () => {
  const path = ledger("moved");
  const first = lane(path, "head-moved");
  await runSweep([timedOut()], first.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(first.h.updated, [HEAD]);
  assert.deepEqual(first.h.escalated, [], "a stale read is not a conflict to escalate");
  assert.equal(first.h.fixed, 0);
  const row = readLedgerLines(path).find((l) => l.step === "sweep.ci_timeout_refresh.outcome");
  assert.equal(row?.outcome, "head-moved", "the outcome is named on the row");
  assert.match(standDown(path), /head moved.*re-read next pass/);

  // The listing still shows the old head; the next pass's live re-read sees the push and refuses.
  const next = lane(path, "updated", "pushed-head");
  await runSweep([timedOut()], next.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(next.h.updated, [], "the live re-read refuses before any second write");
  assert.deepEqual(next.h.escalated, []);
  assert.match(standDown(path), /head (moved|advanced from \S+) to pushed-head/, "the re-read names the new head");
});

test("W1-T5933: an up-to-date refresh in the ci-gate-timeout lane needs no refresh and is never escalated", async () => {
  const path = ledger("current");
  const first = lane(path, "up-to-date");
  await runSweep([timedOut()], first.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(first.h.escalated, []);
  assert.equal(first.h.fixed, 0);
  assert.equal(readLedgerLines(path).find((l) => l.step === "sweep.ci_timeout_refresh.outcome")?.outcome, "up-to-date");
  assert.match(standDown(path), /nothing to merge.*no refresh needed/);
  const next = lane(path, "up-to-date");
  await runSweep([timedOut()], next.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(next.h.escalated, [], "a later pass at the same head is not escalated for the outcome");
});

test("W1-T5933: ciTimeoutRefreshDecision lets head-moved and up-to-date retry under the BACKSTOP, conflict still escalates", () => {
  const rows = (outcome: string) => [
    { step: "sweep.ci_timeout_refresh.attempted", pr_number: 9388, head_sha: "h" },
    { step: "sweep.ci_timeout_refresh.outcome", pr_number: 9388, head_sha: "h", outcome },
  ];
  assert.equal(ciTimeoutRefreshDecision(rows("head-moved"), { prNumber: 9388, headSha: "h" }).kind, "refresh");
  assert.equal(ciTimeoutRefreshDecision(rows("up-to-date"), { prNumber: 9388, headSha: "h" }).kind, "refresh");
  assert.equal(ciTimeoutRefreshDecision(rows("conflict"), { prNumber: 9388, headSha: "h" }).kind, "escalate");
  assert.equal(ciTimeoutRefreshDecision(rows("error"), { prNumber: 9388, headSha: "h" }).kind, "escalate");
});

// ── W1-T2789's stale-base release before strike-cap escalation ──────────────────────────────────

async function staleBaseRelease(outcome: UpdateBranchOutcome) {
  const appended: Record<string, unknown>[] = [];
  const escalated: number[] = [];
  const pr: OpenPrView = {
    prNumber: 9100,
    prUrl: "https://github.com/acme/remudero/pull/9100",
    taskId: "W1-T2789",
    reviewState: "success",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
    lastActivityAt: "2026-09-02T12:00:00Z", // expiring-fixture: exempt -- `now` below is pinned, never the wall clock
    headSha: "head-9100",
    headRefName: "run-W1-T2789-1",
    autoMergeArmed: false,
    ciFailures: [{
      name: "ci",
      logTail: "not ok 1 - stale base\n at TestContext.<anonymous> (file:///workspace/remudero/test/base-caused-release.test.ts:88:3)",
    }],
  };
  await runSweep([pr], {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: (candidate) => void escalated.push(candidate.prNumber),
    ledgerPath: "/dev/null/w1-t5933.ndjson",
    runId: "W1-T5933-test",
    readLedger: () => [],
    appendLine: (_path, line) => void appended.push(line),
    now: () => Date.parse("2026-09-03T12:00:00Z"),
    readMainTip: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    readRedBaseRefreshFacts: () => ({ behindBy: 3, baseChangedFiles: ["test/base-caused-release.test.ts"] }),
    readLiveState: (candidate) => ({ ok: true, state: "OPEN", headSha: candidate.headSha }),
    updateBranch: async () => outcome,
  });
  return { appended, escalated };
}

test("W1-T5933: a head-moved stale-base release stands down for a re-read instead of escalating", async () => {
  const { appended, escalated } = await staleBaseRelease("head-moved");
  assert.deepEqual(escalated, [], "the strike-cap escalation waits for a fresh read of the moved head");
  assert.ok(appended.some((l) => l.step === "sweep.red_base_refresh.head-moved"), "the outcome is named on the row");
  const disposed = appended.find((l) => l.step === "sweep.disposed" && l.pr_number === 9100);
  assert.equal(disposed?.acted, false);
  assert.match(String(disposed?.stand_down_reason), /head moved.*re-read next pass/);
});

test("W1-T5933: an up-to-date stale-base release names the outcome and leaves the strike-cap escalation as it was", async () => {
  const { appended, escalated } = await staleBaseRelease("up-to-date");
  assert.ok(appended.some((l) => l.step === "sweep.red_base_refresh.up-to-date"));
  // Not escalated FOR the outcome: no refresh was needed, so the release did not apply and the
  // exhausted PR's own escalation stands, exactly as when no release was selected (W1-T2789).
  assert.deepEqual(escalated, [9100]);
});

// ── the shared update-branch lane (distance / stale-gate / armed-stalled) ──────────────────────

test("W1-T5933: the shared update-branch lane names head-moved and up-to-date on its own row", async () => {
  for (const outcome of ["head-moved", "up-to-date"] as const) {
    const rows: Record<string, unknown>[] = [];
    const escalated: number[] = [];
    await runSweep(
      [{
        prNumber: 4807,
        prUrl: "https://github.com/craigoley/remudero/pull/4807",
        taskId: "W1-T4800",
        reviewState: "pending",
        checksState: "green",
        unmetCriteria: [],
        priorStrikes: 0,
        lastActivityAt: "2026-09-09T11:00:00Z", // expiring-fixture: exempt -- `now` below is pinned, never the wall clock
        headSha: "head4807",
        autoMergeArmed: false,
        mergeState: "behind",
      }],
      {
        arm: () => {},
        close: () => {},
        dispatchFix: () => {},
        escalate: (candidate) => void escalated.push(candidate.prNumber),
        ledgerPath: "/dev/null/w1-t5933-distance.ndjson",
        runId: "SWEEP-W1-T5933",
        now: () => Date.parse("2026-09-09T12:00:00Z"),
        readLedger: () => [],
        appendLine: (_path, row) => void rows.push(row),
        behindMainByPr: new Map([[4807, 12]]),
        updateBranch: () => outcome,
      },
      { ...DEFAULT_SWEEP_POLICY, reviewWaitingBranchRefreshEnabled: true, reviewWaitingBranchRefreshThreshold: 10 },
    );
    assert.equal(rows.find((r) => r.step === `sweep.update_branch.${outcome}`)?.behind_by, 12, outcome);
    assert.deepEqual(escalated, [], `${outcome} is never escalated`);
  }
});
