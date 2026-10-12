/**
 * W1-T7735 — A MAIN-MERGE REFRESH IS TAKEN ONLY WHEN IT IS WORTH A CI RUN.
 *
 * 2026-10-10: 37 of 108 head pushes since 09:30Z were main-merge refreshes (~600 PR-min of CI), each
 * voiding the exact-input review, while main's protection is NOT strict and GitHub never needs a
 * refresh to allow a merge. Every refresh slot now consults `decideRefresh` first and writes one
 * `sweep.refresh.decided` row; board-wide requests are paced one per pass.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  decideRefresh,
  judgeRefreshOverlap,
  nextRefreshRequest,
  parseRefreshJudgeReply,
  pendingRefreshJudgeAsks,
  readRefreshJudgeVerdict,
  REFRESH_DECIDED_STEP,
  REFRESH_JUDGE_OFF_FILE,
  refreshRequestRow,
} from "../src/lib/refresh-value.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { runLightPassReadyRefresh, type ArmedStalledPr } from "../src/lib/sweep.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  type BaseChangedFiles,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "./helpers/sweep-test.js";

const NOW = 1_800_000_000_000;
const MINE = "src/mine.ts";
const POLICY: SweepPolicy = {
  ...DEFAULT_SWEEP_POLICY,
  reviewWaitingBranchRefreshEnabled: true,
  reviewWaitingBranchRefreshThreshold: 10,
  // A 12-commit distance is past this ceiling, so before W1-T7735 it refreshed with zero overlap.
  reviewWaitingBranchRefreshCeiling: 11,
};

function pr(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 3_600_000).toISOString(),
    headSha: `head${prNumber}`,
    autoMergeArmed: false,
    mergeState: "clean",
    changedFiles: [MINE],
    ...over,
  };
}

const base = (files: string[]): BaseChangedFiles => ({ files, truncated: false });

function harness(prs: OpenPrView[], over: Partial<SweepDeps> & { ledger?: Record<string, unknown>[] } = {}) {
  const rows: Record<string, unknown>[] = [];
  const updated: ArmedStalledPr[] = [];
  const { ledger, ...rest } = over;
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: "/nonexistent-rmd-w1-t7735/ledger.ndjson",
    runId: "SWEEP-W1-T7735",
    now: () => NOW,
    readLedger: () => ledger ?? [],
    appendLine: (_path, row) => { rows.push(row); },
    updateBranch: (target) => { updated.push(target); return "updated"; },
    ...rest,
  };
  return { rows, updated, run: () => runSweep(prs, deps, POLICY) };
}

const decided = (rows: Record<string, unknown>[]) => rows.filter((r) => r.step === REFRESH_DECIDED_STEP);

test("W1-T7735: under non-strict protection a ready PR with no overlap with main delta is not refreshed", async () => {
  const ready = pr(7001);
  const facts = {
    behindMainByPr: new Map([[7001, 12]]),
    baseChangedFilesByPr: new Map([[7001, base(["src/other.ts", "docs/readme.md"])]]),
  };
  const nonStrict = harness([ready], { ...facts, readProtectionStrict: () => false });
  await nonStrict.run();
  assert.deepEqual(nonStrict.updated, [], "a ready PR 12 behind with zero overlap is not refreshed under non-strict protection");
  const [row, ...more] = decided(nonStrict.rows);
  assert.equal(more.length, 0);
  assert.equal(row?.decision, "skip");
  assert.equal(row?.pr_number, 7001);
  assert.equal(row?.head_sha, ready.headSha);
  assert.equal(row?.strict, false);
  assert.equal(row?.overlap, "staleness");
  assert.equal(row?.overlap_count, 0);
  assert.match(String(row?.why), /non-strict protection: staleness alone buys nothing/);
  assert.equal(nonStrict.rows.some((r) => r.step === "sweep.update_branch.attempted"), false);

  // The same PR under strict protection IS refreshed: strictness, not the distance, made the skip.
  const strict = harness([ready], { ...facts, readProtectionStrict: () => true });
  await strict.run();
  assert.deepEqual(strict.updated.map((c) => c.prNumber), [7001]);
  assert.equal(decided(strict.rows)[0]?.decision, "refresh");

  // A pass that reaches the same skip on the same head writes no second row.
  const again = harness([ready], { ...facts, readProtectionStrict: () => false, ledger: nonStrict.rows });
  await again.run();
  assert.deepEqual(decided(again.rows), []);
});

test("W1-T7735: an overlapping ready PR is refreshed once and its decision row names the overlap", async () => {
  const ready = pr(7002);
  const facts = {
    behindMainByPr: new Map([[7002, 3]]),
    baseChangedFilesByPr: new Map([[7002, base(["src/other.ts", MINE])]]),
    readProtectionStrict: () => false,
  };
  const first = harness([ready], facts);
  await first.run();
  assert.deepEqual(first.updated.map((c) => [c.prNumber, c.updateReason]), [[7002, "ready-overlap"]]);
  const [row] = decided(first.rows);
  assert.equal(row?.decision, "refresh");
  assert.equal(row?.overlap, "direct");
  assert.deepEqual(row?.overlap_files, [MINE]);
  assert.equal(row?.overlap_count, 1);
  assert.equal(row?.strict, false);
  assert.equal(row?.ci_in_flight, false);
  assert.equal(typeof row?.predicted_cost_ci_min, "number");
  assert.ok(Number(row?.predicted_benefit) > 0);

  // The same head on the next pass: the one update per (PR, head) is spent, so nothing is pressed.
  const second = harness([ready], { ...facts, ledger: first.rows });
  await second.run();
  assert.deepEqual(second.updated, []);

  // The light pass weighs the same PR through the same value test and names the overlap too.
  const lightRows: Record<string, unknown>[] = [];
  const lightUpdated: number[] = [];
  const refreshed = await runLightPassReadyRefresh([ready], {
    ledgerPath: "/nonexistent-rmd-w1-t7735/ledger.ndjson",
    runId: "LIGHT-W1-T7735",
    now: () => NOW,
    readLedger: () => [],
    appendLine: (_path, r) => { lightRows.push(r); },
    updateBranch: (target) => { lightUpdated.push(target.prNumber); return "updated"; },
    ...facts,
  }, POLICY);
  assert.equal(refreshed, 7002);
  assert.deepEqual(lightUpdated, [7002]);
  const lightRow = decided(lightRows)[0];
  assert.equal(lightRow?.path, "ready-light");
  assert.deepEqual(lightRow?.overlap_files, [MINE]);
});

test("W1-T7735: a PR with CI in flight is not refreshed unless the judge rules overlap", async () => {
  const running = pr(7003, { checksState: "pending", reviewState: "pending" });
  const facts = {
    behindMainByPr: new Map([[7003, 12]]),
    baseChangedFilesByPr: new Map([[7003, base([MINE])]]),
    readProtectionStrict: () => false,
  };
  const independent = harness([running], { ...facts, refreshJudgeVerdict: () => "independent" });
  await independent.run();
  assert.deepEqual(independent.updated, [], "the judge ruled independent: the running CI is left alone");
  const skip = decided(independent.rows)[0];
  assert.equal(skip?.decision, "skip");
  assert.equal(skip?.ci_in_flight, true);
  assert.equal(skip?.judge_verdict, "independent");

  const unruled = harness([running], { ...facts, refreshJudgeVerdict: () => undefined });
  await unruled.run();
  assert.deepEqual(unruled.updated, []);
  assert.equal(decided(unruled.rows)[0]?.decision, "ask-judge");

  const unavailable = harness([running], facts);
  await unavailable.run();
  assert.deepEqual(unavailable.updated, [], "no judge wired reads judge-unavailable, never a silent refresh");
  assert.equal(decided(unavailable.rows)[0]?.judge_verdict, "judge-unavailable");

  const overlap = harness([running], { ...facts, refreshJudgeVerdict: () => "overlap" });
  await overlap.run();
  assert.deepEqual(overlap.updated.map((c) => c.prNumber), [7003], "only the judge's overlap buys a refresh over a running CI");
  assert.equal(decided(overlap.rows)[0]?.decision, "refresh");

  // The pure rule, for every verdict.
  const input = { path: "general" as const, reason: "distance-overlap", overlap: "direct" as const, overlapFiles: [MINE],
    strict: false, ciInFlight: true };
  assert.equal(decideRefresh({ ...input, judge: "overlap" }).decision, "refresh");
  assert.equal(decideRefresh({ ...input, judge: "independent" }).decision, "skip");
  assert.equal(decideRefresh({ ...input, judge: "judge-unavailable" }).decision, "skip");
  assert.equal(decideRefresh({ ...input, judge: undefined }).decision, "ask-judge");
  assert.equal(decideRefresh({ ...input, ciInFlight: false, judge: undefined }).decision, "refresh");
});

test("W1-T7735: a board-wide refresh request is paced through the daemon lane, never fanned out at once", async () => {
  // Three PRs main has not moved under, so no other rung competes for the slot.
  const red = pr(7010, { checksState: "red", reviewState: "pending" });
  const pending = pr(7011, { checksState: "pending", reviewState: "pending" });
  const ready = pr(7012);
  const prs = [red, pending, ready];
  // One request row per PR, as a board-wide command writes them, the red PR's first.
  let ledger: Record<string, unknown>[] = [red, pending, ready].map((p, i) =>
    refreshRequestRow("OPERATOR-1", p.prNumber, "operator", new Date(NOW - 60_000 + i).toISOString()));
  const order: number[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const h = harness(prs, { ledger });
    await h.run();
    assert.ok(h.updated.length <= 1, `pass ${pass} pressed ${h.updated.length} updates`);
    order.push(...h.updated.map((c) => c.prNumber));
    const row = decided(h.rows)[0];
    if (h.updated.length === 1) {
      assert.equal(row?.path, "request");
      assert.equal(row?.forced_by, "request:operator");
      assert.equal(typeof row?.request_id, "string");
    }
    ledger = [...ledger, ...h.rows];
  }
  assert.deepEqual(order, [7012, 7011, 7010], "one per pass, closest to merge first: ready, then pending, then red");

  // The pure pacing: one request, closest to merge, a closed PR's request never chosen.
  const requests = [
    { requestId: "a", prNumber: 7010, requestedBy: "op" },
    { requestId: "b", prNumber: 9999, requestedBy: "op" },
    { requestId: "c", prNumber: 7012, requestedBy: "op" },
  ];
  assert.equal(nextRefreshRequest(requests, prs)?.request.requestId, "c");
  assert.equal(nextRefreshRequest([requests[1]!], prs), undefined);
});

test("W1-T7735: the overlap judge rules once per head, its failure is judge-unavailable, and its off switch is visible", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t7735-`));
  try {
    const ask = (prNumber: number) => ({ step: REFRESH_DECIDED_STEP, decision: "ask-judge", pr_number: prNumber,
      head_sha: `head${prNumber}`, overlap_files: ["package.json"] });
    const replies: Record<number, string | Error> = { 7020: '{"verdict": "overlap"}', 7021: "no json here", 7022: new Error("model down") };
    const prompts: string[] = [];
    const ports = (ledger: Record<string, unknown>[]) => ({
      stateDir,
      asks: () => pendingRefreshJudgeAsks(ledger, stateDir),
      prDiff: async () => "diff --git a/src/mine.ts b/src/mine.ts",
      mainDiff: async () => "diff --git a/package.json b/package.json",
      judge: async (prompt: string) => {
        prompts.push(prompt);
        const pr = Number(/pull request #(\d+)/.exec(prompt)?.[1]);
        const reply = replies[pr]!;
        if (reply instanceof Error) throw reply;
        return reply;
      },
      log: () => {},
      maxPerPass: 5,
    });
    const ledger = [ask(7020), ask(7021), ask(7022)];
    await judgeRefreshOverlap(ports(ledger));
    assert.equal(readRefreshJudgeVerdict(stateDir, 7020, "head7020"), "overlap");
    assert.equal(readRefreshJudgeVerdict(stateDir, 7021, "head7021"), "judge-unavailable", "a malformed reply is visible, never a guess");
    assert.equal(readRefreshJudgeVerdict(stateDir, 7022, "head7022"), "judge-unavailable", "a failed call is visible, never a guess");
    assert.equal(readRefreshJudgeVerdict(stateDir, 7023, "head7023"), undefined, "an unasked head has no ruling");
    assert.match(prompts[0]!, /UNTRUSTED DATA/);
    // A ruled head is never judged again.
    await judgeRefreshOverlap(ports(ledger));
    assert.equal(prompts.length, 3);
    // The off switch: no call, and every ruling reads judge-unavailable.
    writeFileSync(join(stateDir, REFRESH_JUDGE_OFF_FILE), "");
    const off = await judgeRefreshOverlap(ports([ask(7024)]));
    assert.equal(off.off, true);
    assert.equal(prompts.length, 3);
    assert.equal(readRefreshJudgeVerdict(stateDir, 7020, "head7020"), "judge-unavailable");
    assert.equal(parseRefreshJudgeReply('{"verdict": "independent"}'), "independent");
    assert.equal(parseRefreshJudgeReply('{"verdict": "skip everything"}'), "judge-unavailable");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
