import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SWEEP_POLICY,
  classifyRedCause,
  runSweep,
  type OpenPrView,
  type RedBaseRefreshFacts,
} from "../src/lib/sweep.js";

const NOW = Date.parse("2026-09-03T12:00:00Z");
const MAIN_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MAIN_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9100,
    prUrl: "https://github.com/acme/remudero/pull/9100",
    taskId: "W1-T2789",
    reviewState: "success",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
    lastActivityAt: "2026-09-02T12:00:00Z",
    headSha: "head-9100",
    headRefName: "run-W1-T2789-1",
    autoMergeArmed: false,
    ciFailures: [{
      name: "ci",
      logTail: "not ok 1 - stale base\n at TestContext.<anonymous> (file:///workspace/remudero/test/base-caused-release.test.ts:88:3)",
    }],
    ...over,
  };
}

async function sweep(
  prs: OpenPrView[],
  over: {
    prior?: Record<string, unknown>[];
    mainTip?: string;
    facts?: (pr: OpenPrView) => RedBaseRefreshFacts | Promise<RedBaseRefreshFacts>;
    live?: (pr: OpenPrView) => { ok: boolean; state?: string; headSha?: string };
    updateOutcome?: "updated" | "conflict" | "error";
    staleGate?: boolean;
  } = {},
) {
  const appended: Record<string, unknown>[] = [];
  const updated: number[] = [];
  const escalated: number[] = [];
  const dispatched: number[] = [];
  const reviewed: number[] = [];
  const armed: number[] = [];
  const summary = await runSweep(prs, {
    arm: (candidate) => { armed.push(candidate.prNumber); },
    close: () => {},
    dispatchFix: (candidate) => { dispatched.push(candidate.prNumber); },
    escalate: (candidate) => { escalated.push(candidate.prNumber); },
    postReview: async (candidate) => { reviewed.push(candidate.prNumber); },
    ledgerPath: "/dev/null/w1-t2789.ndjson",
    runId: "W1-T2789-test",
    readLedger: () => over.prior ?? [],
    appendLine: (_path, line) => { appended.push(line); },
    now: () => NOW,
    readMainTip: () => over.mainTip ?? MAIN_A,
    readRedBaseRefreshFacts: over.facts ?? (() => ({
      behindBy: 3,
      baseChangedFiles: ["test/base-caused-release.test.ts"],
    })),
    readLiveState: over.live ?? ((candidate) => ({ ok: true, state: "OPEN", headSha: candidate.headSha })),
    updateBranch: async (candidate) => {
      updated.push(candidate.prNumber);
      return over.updateOutcome ?? "updated";
    },
    staleGateWorkflowsByPr: over.staleGate ? new Map([[9100, ["ci"]]]) : undefined,
  });
  return { summary, appended, updated, escalated, dispatched, reviewed, armed };
}

test("W1-T2789: an exhausted red PR with an exact newer-base path refreshes before blocked-ambiguous escalation and spends zero strikes", async () => {
  const stale = pr();
  const green = pr({
    prNumber: 9200,
    prUrl: "https://github.com/acme/remudero/pull/9200",
    taskId: "W1-T9200",
    checksState: "green",
    priorStrikes: 0,
    headSha: "head-9200",
    ciFailures: undefined,
  });
  assert.equal(classifyRedCause(stale, [stale, green]), "in-diff", "the mixed cohort must defeat the cohort-wide base-caused shortcut");

  const result = await sweep([stale, green], { staleGate: true });

  assert.deepEqual(result.updated, [9100], "the older end-of-pass update lane must not write the same stale snapshot twice");
  assert.deepEqual(result.escalated, [], "the accepted refresh replaces this pass's exhausted escalation");
  assert.deepEqual(result.dispatched, [], "the release is queue maintenance, never a fix strike");
  assert.deepEqual(result.reviewed, [], "the release never posts a review");
  assert.deepEqual(result.armed, [9200], "an unrelated mergeable PR keeps its ordinary action");
  const release = result.appended.find(
    (line) => line.step === "sweep.update_branch.updated" && line.release_kind === "red-base",
  );
  assert.deepEqual(release && {
    pr_number: release.pr_number,
    head_sha: release.head_sha,
    main_tip_sha: release.main_tip_sha,
    behind_by: release.behind_by,
    matching_base_files: release.matching_base_files,
  }, {
    pr_number: 9100,
    head_sha: "head-9100",
    main_tip_sha: MAIN_A,
    behind_by: 3,
    matching_base_files: ["test/base-caused-release.test.ts"],
  });
  const disposed = result.appended.find((line) => line.step === "sweep.disposed" && line.pr_number === 9100)!;
  assert.equal(disposed.disposition, "blocked-ambiguous", "the observed disposition is preserved");
  assert.equal(disposed.acted, false, "the queue-maintenance release must not seed the escalation/fix-strike dedup");
  assert.match(String(disposed.stand_down_reason), /base refresh requested.*no strike spent/i);
});

test("W1-T2789: oldest eligible input wins and a successful (PR, head, main tip) release is deduplicated", async () => {
  const newer = pr({ prNumber: 9102, prUrl: "https://github.com/acme/remudero/pull/9102", headSha: "head-9102", lastActivityAt: "2026-09-03T10:00:00Z" });
  const older = pr({ prNumber: 9101, prUrl: "https://github.com/acme/remudero/pull/9101", headSha: "head-9101", lastActivityAt: "2026-09-01T10:00:00Z" });
  const first = await sweep([newer, older]);
  assert.deepEqual(first.updated, [9101], "only the oldest eligible PR is updated");

  const prior = first.appended.filter(
    (line) => line.step === "sweep.update_branch.updated" && line.release_kind === "red-base",
  );
  const duplicate = await sweep([older], { prior });
  assert.deepEqual(duplicate.updated, [], "the same PR, input head, and main tip is not released twice");

  const newMain = await sweep([older], { prior, mainTip: MAIN_B });
  assert.deepEqual(newMain.updated, [9101], "a genuinely newer main tip creates a new release input");
});

test("W1-T2789: current, unreadable, malformed, and unrelated base evidence preserves the existing blocked disposition", async () => {
  const cases: Array<[string, () => RedBaseRefreshFacts | Promise<RedBaseRefreshFacts>]> = [
    ["current", () => ({ behindBy: 0, baseChangedFiles: ["test/base-caused-release.test.ts"] })],
    ["unreadable", async () => { throw new Error("compare unavailable"); }],
    ["malformed", () => ({})],
    ["unrelated", () => ({ behindBy: 4, baseChangedFiles: ["test/unrelated.test.ts"] })],
  ];
  for (const [name, facts] of cases) {
    const result = await sweep([pr()], { facts });
    assert.deepEqual(result.updated, [], `${name}: no update`);
    assert.deepEqual(result.escalated, [9100], `${name}: existing escalation remains reachable`);
    assert.equal(
      result.appended.some((line) => line.step === "sweep.update_branch.updated" && line.release_kind === "red-base"),
      false,
    );
  }
});

test("W1-T2789: the live recheck refuses closed, moved-head, and indeterminate targets, while a failed write stays retryable", async () => {
  for (const [name, live] of [
    ["closed", () => ({ ok: true, state: "CLOSED", headSha: "head-9100" })],
    ["moved", () => ({ ok: true, state: "OPEN", headSha: "new-head" })],
    ["indeterminate", () => ({ ok: false })],
  ] as const) {
    const result = await sweep([pr()], { live });
    assert.deepEqual(result.updated, [], `${name}: the stale snapshot is never written`);
    assert.equal(
      result.appended.some((line) => line.step === "sweep.update_branch.updated" && line.release_kind === "red-base"),
      false,
    );
  }

  const failed = await sweep([pr()], { updateOutcome: "error" });
  assert.deepEqual(failed.updated, [9100], "the write was attempted once");
  assert.equal(
    failed.appended.some((line) => line.step === "sweep.update_branch.updated" && line.release_kind === "red-base"),
    false,
  );
  assert.ok(failed.appended.some((line) => line.step === "sweep.red_base_refresh.error"));
  const retry = await sweep([pr()], { prior: failed.appended, updateOutcome: "updated" });
  assert.deepEqual(retry.updated, [9100], "a failed attempt does not poison this input");
});

test("W1-T2789: Serve has no stale-base GitHub reader or queue-maintenance write", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const serve = readFileSync(`${root}/src/lib/serve.ts`, "utf8");
  assert.doesNotMatch(serve, /readRedBaseRefreshFacts|red_base_refresh|updateBranch/);
});
