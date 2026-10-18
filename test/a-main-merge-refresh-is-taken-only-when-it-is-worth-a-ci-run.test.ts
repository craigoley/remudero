/**
 * W1-T7735 — A MAIN-MERGE REFRESH IS TAKEN ONLY WHEN IT IS WORTH A CI RUN.
 *
 * On 2026-10-10, 37 of 108 head pushes (34%) were main-merge refreshes. That is about 600 PR-min of
 * CI, and each one voided the exact-input review. Main's protection is NOT strict, so GitHub never
 * needed any of them to allow a merge. Each test drives the real `runSweep` (or the light pass) and
 * asserts the `updateBranch` presses and the `sweep.refresh.decided` row the value test writes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_CI_MINUTES,
  REFRESH_DECIDED_STEP,
  REFRESH_JUDGE_OFF_FILE,
  REFRESH_OUTCOME_STEP,
  askRefreshJudge,
  buildRefreshJudgePrompt,
  closenessToMerge,
  decideRefresh,
  dueRefreshOutcomes,
  forcedRefreshFields,
  observedRefreshBenefitWeight,
  parseRefreshJudgeReply,
  productionRefreshJudge,
  refreshRequestRows,
  selectPacedRefreshRequest,
  type RefreshJudgeQuestion,
} from "#src/lib/refresh-value.js";
import {
  DEFAULT_SWEEP_POLICY,
  recordForcedRefresh,
  refreshOverlapOf,
  runLightPassReadyRefresh,
  runSweep,
  type ArmedStalledPr,
  type BaseChangedFiles,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "#test/helpers/sweep-test.js";
import { buildSweepEffects } from "#src/lib/sweep.js";
import { BASE_RED_REFRESH_STEP, BASE_RED_STOOD_DOWN_STEP, REFRESH_ADMISSION_FORCED_BY, runLightPassRefreshAdmission } from "#test/helpers/sweep-test.js";
import { runFixRebase } from "#test/helpers/run-task-test.js";

const NOW = 1_800_000_000_000;
const POLICY: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, reviewWaitingBranchRefreshEnabled: true, reviewWaitingBranchRefreshThreshold: 10 };

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
    changedFiles: ["src/mine.ts", "test/mine.test.ts"],
    ...over,
  };
}

const base = (files: string[], truncated = false): BaseChangedFiles => ({ files, truncated });
const one = <T,>(prNumber: number, value: T) => new Map<number, T>([[prNumber, value]]);

function harness(over: Partial<SweepDeps> = {}, ledger: Array<Record<string, unknown>> = []) {
  const rows: Array<Record<string, unknown>> = [];
  const updated: ArmedStalledPr[] = [];
  const deps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: "/tmp/rmd-w1-t7735-ledger.ndjson",
    runId: "SWEEP-W1-T7735",
    now: () => NOW,
    readLedger: () => ledger,
    appendLine: (_path: string, row: Record<string, unknown>) => { rows.push(row); },
    updateBranch: (candidate: ArmedStalledPr) => { updated.push(candidate); return "updated" as const; },
    ...over,
  } as SweepDeps;
  return { deps, rows, updated };
}

const decided = (rows: Array<Record<string, unknown>>) => rows.filter((r) => r.step === REFRESH_DECIDED_STEP);

test("W1-T7735: under non-strict protection a ready PR with no overlap with main delta is not refreshed", async () => {
  // Ready, armed, and 12 commits behind (GitHub says `behind`), but main's delta touches none of its files.
  const stale = pr(7001, { autoMergeArmed: true, mergeState: "behind" });
  const facts = { behindMainByPr: one(7001, 12), baseChangedFilesByPr: one(7001, base(["src/other.ts", "docs/x.md"])) };

  const h = harness({ ...facts, readBranchProtectionStrict: () => false });
  await runSweep([stale], h.deps, POLICY);
  assert.deepEqual(h.updated, [], "non-strict protection: staleness alone is not worth a CI run");
  const [row] = decided(h.rows);
  assert.equal(row?.pr_number, 7001);
  assert.equal(row?.head_sha, "head7001");
  assert.equal(row?.decision, "skip");
  assert.equal(row?.strict, false);
  assert.equal(row?.overlap_count, 0);
  assert.deepEqual(row?.overlap_files, []);
  assert.match(String(row?.reason), /non-strict protection and no overlap/);
  assert.equal(typeof row?.predicted_cost_ci_min, "number");
  assert.equal(row?.predicted_benefit, 0);

  // The same skip on the same head writes no second row.
  const again = harness({ ...facts, readBranchProtectionStrict: () => false }, h.rows);
  await runSweep([stale], again.deps, POLICY);
  assert.deepEqual(again.updated, []);
  assert.equal(decided(again.rows).length, 0);

  // The value test reads strictness: strict protection, or an unread flag, keeps the refresh.
  const strict = harness({ ...facts, readBranchProtectionStrict: () => true });
  await runSweep([stale], strict.deps, POLICY);
  assert.deepEqual(strict.updated.map((c) => c.prNumber), [7001]);
  assert.match(String(decided(strict.rows)[0]?.reason), /strict protection/);
  const unread = harness({ ...facts, readBranchProtectionStrict: () => { throw new Error("403"); } });
  await runSweep([stale], unread.deps, POLICY);
  assert.deepEqual(unread.updated.map((c) => c.prNumber), [7001]);
  assert.equal(decided(unread.rows)[0]?.strict, null);
});

test("W1-T7735: an overlapping ready PR is refreshed once and its decision row names the overlap", async () => {
  const ready = pr(7010);
  const facts = { behindMainByPr: one(7010, 2), baseChangedFilesByPr: one(7010, base(["src/other.ts", "src/mine.ts"])) };
  const h = harness({ ...facts, readBranchProtectionStrict: () => false });
  await runSweep([ready], h.deps, POLICY);
  assert.deepEqual(h.updated.map((c) => c.prNumber), [7010]);
  const rows = decided(h.rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.decision, "refresh");
  assert.equal(rows[0]?.path, "general");
  assert.deepEqual(rows[0]?.overlap_files, ["src/mine.ts"]);
  assert.equal(rows[0]?.overlap_count, 1);
  assert.match(String(rows[0]?.reason), /overlap: main changed 1 of this PR's files/);
  // The decision is written before the press, and the press is the slot's only one.
  assert.ok(h.rows.indexOf(rows[0]!) < h.rows.findIndex((r) => r.step === "sweep.update_branch.updated"));

  // Once: the next pass reads its own attempted row at this head and presses nothing.
  const next = harness({ ...facts, readBranchProtectionStrict: () => false }, h.rows);
  await runSweep([ready], next.deps, POLICY);
  assert.deepEqual(next.updated, []);

  // The light pass consults the same value test, and writes its own row.
  const light = harness({ ...facts, readBranchProtectionStrict: () => false });
  assert.equal(await runLightPassReadyRefresh([ready], light.deps, POLICY), 7010);
  assert.deepEqual(light.updated.map((c) => c.prNumber), [7010]);
  assert.equal(decided(light.rows)[0]?.path, "ready-light");
  assert.deepEqual(decided(light.rows)[0]?.overlap_files, ["src/mine.ts"]);
  // ...and a light-pass ready PR whose only reach is a baseline path is ambiguous; with no judge, nothing is pressed.
  const baseline = harness({ behindMainByPr: one(7010, 2), baseChangedFilesByPr: one(7010, base(["package-lock.json"])),
    readBranchProtectionStrict: () => false });
  assert.equal(await runLightPassReadyRefresh([ready], baseline.deps, POLICY), undefined);
  assert.deepEqual(baseline.updated, []);
  assert.equal(decided(baseline.rows)[0]?.judge, "judge-unavailable");
});

test("W1-T7735: a PR with CI in flight is not refreshed unless the judge rules overlap", async () => {
  // 12 behind, main changed its file, but its required CI is mid-run.
  const running = pr(7020, { checksState: "pending", reviewState: "pending" });
  const facts = { behindMainByPr: one(7020, 12), baseChangedFilesByPr: one(7020, base(["src/mine.ts"])),
    readBranchProtectionStrict: () => false };
  const asked: RefreshJudgeQuestion[] = [];

  const independent = harness({ ...facts, refreshJudge: async (q) => { asked.push(q); return "independent"; } });
  await runSweep([running], independent.deps, POLICY);
  assert.deepEqual(independent.updated, [], "the judge ruled independent: the run in flight is kept");
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.ciInFlight, true);
  assert.deepEqual(asked[0]?.baseFiles, ["src/mine.ts"]);
  const row = decided(independent.rows)[0];
  assert.equal(row?.ci_in_flight, true);
  assert.equal(row?.judge, "independent");
  assert.equal(row?.decision, "skip");

  // A ruling is spent once per head: the next pass reuses it and asks nothing.
  const reuse = harness({ ...facts, refreshJudge: async (q) => { asked.push(q); return "overlap"; } }, independent.rows);
  await runSweep([running], reuse.deps, POLICY);
  assert.equal(asked.length, 1);
  assert.deepEqual(reuse.updated, []);

  const unavailable = harness({ ...facts, refreshJudge: async () => { throw new Error("model timeout"); } });
  await runSweep([running], unavailable.deps, POLICY);
  assert.deepEqual(unavailable.updated, [], "a judge failure is never a silent refresh");
  assert.equal(decided(unavailable.rows)[0]?.judge, "judge-unavailable");
  assert.equal(decided(unavailable.rows)[0]?.judge_error, "model timeout");

  const overlap = harness({ ...facts, refreshJudge: async () => "overlap" });
  await runSweep([running], overlap.deps, POLICY);
  assert.deepEqual(overlap.updated.map((c) => c.prNumber), [7020], "the judge ruled overlap: the refresh is worth the run");
  assert.equal(decided(overlap.rows)[0]?.decision, "refresh");
  assert.equal(decided(overlap.rows)[0]?.judge, "overlap");
});

test("W1-T7735: a board-wide refresh request is paced through the daemon lane, never fanned out at once", async () => {
  const red = pr(7031, { checksState: "red", reviewState: "pending" });
  const awaiting = pr(7032, { reviewState: "pending" });
  const readyReviewed = pr(7033);
  const prs = [red, awaiting, readyReviewed];
  // A board-wide request writes ROWS and presses nothing.
  const requests = refreshRequestRows(prs, "operator", NOW - 60_000, "OPERATOR");
  assert.ok(requests.every((r) => r.step === "sweep.refresh.requested"));
  const baseFiles = new Map(prs.map((p) => [p.prNumber, base(["src/mine.ts"])]));
  let ledger: Array<Record<string, unknown>> = [...requests];
  const order: number[] = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const h = harness({ baseChangedFilesByPr: baseFiles, readBranchProtectionStrict: () => false }, ledger);
    await runSweep(prs, h.deps, POLICY);
    assert.ok(h.updated.length <= 1, `pass ${pass} pressed ${h.updated.length} updates`);
    order.push(...h.updated.map((c) => c.prNumber));
    for (const c of h.updated) assert.equal(c.updateReason, "refresh-request");
    ledger = [...ledger, ...h.rows];
  }
  assert.deepEqual(order, [7033, 7032, 7031], "ready and reviewed first, then green awaiting review, then red");
  const consumed = ledger.filter((r) => r.step === REFRESH_DECIDED_STEP && typeof r.request_id === "string");
  assert.equal(consumed.length, 3);
  assert.equal(new Set(consumed.map((r) => r.request_id)).size, 3, "each request is consumed once");
});

test("W1-T7735: decideRefresh's arms, in order", () => {
  const input = { path: "general" as const, overlap: "none" as const, overlapFiles: [], repairNeeded: false, strict: false, ciInFlight: false };
  assert.equal(decideRefresh(input).decision, "skip");
  assert.equal(decideRefresh({ ...input, overlap: "direct", overlapFiles: ["a"] }).decision, "refresh");
  assert.equal(decideRefresh({ ...input, overlap: "ambiguous" }).decision, "ask-judge");
  assert.equal(decideRefresh({ ...input, overlap: "ambiguous", judge: "overlap" }).decision, "refresh");
  assert.equal(decideRefresh({ ...input, overlap: "ambiguous", judge: "independent" }).decision, "skip");
  assert.match(decideRefresh({ ...input, overlap: "ambiguous", judge: "judge-unavailable" }).reason, /judge-unavailable/);
  assert.equal(decideRefresh({ ...input, repairNeeded: true }).decision, "refresh");
  assert.equal(decideRefresh({ ...input, strict: undefined }).decision, "refresh");
  assert.equal(decideRefresh({ ...input, repairNeeded: true, ciInFlight: true }).decision, "ask-judge");
  const cost = decideRefresh({ ...input, queueDepth: 3 });
  assert.equal(cost.predictedCostCiMin, Math.round(DEFAULT_CI_MINUTES * 3 * 10) / 10);
  assert.equal(decideRefresh({ ...input, overlap: "direct", overlapFiles: ["a", "b"], benefitWeight: 0.5 }).predictedBenefit, 1);
  assert.deepEqual([{ checksState: "red" }, { checksState: "pending" }, { checksState: "green" }, { checksState: "green", reviewState: "success" }]
    .map(closenessToMerge), [3, 2, 1, 0]);
});

test("W1-T7735: overlap classification, requests, outcomes and the benefit weight", () => {
  const view = { changedFiles: ["src/a.ts"] };
  assert.equal(refreshOverlapOf({ updateReason: "distance-overlap" }, view, base(["src/a.ts"])).overlap, "direct");
  assert.equal(refreshOverlapOf({ updateReason: "distance-baseline", matchingBaseFiles: ["package.json"] }, view, base(["package.json"])).overlap, "ambiguous");
  assert.equal(refreshOverlapOf({ updateReason: "distance-unknown" }, view, base(["x"], true)).overlap, "ambiguous");
  assert.equal(refreshOverlapOf({ updateReason: "distance-ceiling" }, view, base(["x"])).overlap, "ambiguous");
  assert.equal(refreshOverlapOf({ updateReason: "armed-stalled" }, view, base(["x"])).overlap, "none");
  assert.equal(refreshOverlapOf({ updateReason: "stale-gate" }, view, base(["x"])).repairNeeded, true);

  const open = [{ prNumber: 1, headSha: "h1", checksState: "red" }, { prNumber: 2, headSha: "h2", checksState: "green" }];
  const rows = [...refreshRequestRows([{ prNumber: 1, headSha: "h1" }, { prNumber: 2, headSha: "old" }, { prNumber: 3, headSha: "h3" }], "op", 5, "R")];
  assert.equal(selectPacedRefreshRequest(rows, open)?.pr.prNumber, 1, "a moved head or a closed PR drops its request");
  assert.equal(selectPacedRefreshRequest([...rows, { step: REFRESH_DECIDED_STEP, request_id: rows[0]!.request_id }], open), undefined);

  const decisions = [
    { step: REFRESH_DECIDED_STEP, decision_id: "d1", pr_number: 1, decision: "skip" },
    { step: REFRESH_DECIDED_STEP, decision_id: "d2", pr_number: 2, decision: "refresh" },
    { step: REFRESH_DECIDED_STEP, decision_id: "d3", pr_number: 9, decision: "skip" },
    { step: REFRESH_DECIDED_STEP, decision_id: "d4", pr_number: 4, decision: "skip" },
  ];
  const due = dueRefreshOutcomes(decisions, [{ prNumber: 1, headSha: "h", checksState: "red" }, { prNumber: 2, headSha: "h", checksState: "green" },
    { prNumber: 4, headSha: "h", mergeState: "dirty" }]);
  assert.deepEqual(due.map((d) => [d.decisionId, d.outcome]), [["d1", "red"], ["d3", "left-open-set"], ["d4", "conflict"]]);
  assert.equal(observedRefreshBenefitWeight([]), 1);
  assert.equal(observedRefreshBenefitWeight(due.map((d) => ({ step: REFRESH_OUTCOME_STEP, outcome: d.outcome }))), 0.667);

  const forced: Array<Record<string, unknown>> = [];
  recordForcedRefresh({ runId: "R", ledgerPath: "/x", now: () => NOW, appendLine: (_p, row) => { forced.push(row); } },
    { prNumber: 5, headSha: "h5" }, "ci-timeout");
  assert.equal(forced[0]?.forced_by, "ci-timeout");
  assert.equal(forced[0]?.decision, "refresh");
  // The fix lane's `log` stamps run, task and step itself, and a head it never read is null, never guessed.
  const rebase = forcedRefreshFields({ prNumber: 6, forcedBy: "fix-rebase", nowMs: NOW });
  assert.equal(rebase.head_sha, null);
  assert.equal(rebase.forced_by, "fix-rebase");
  assert.equal("step" in rebase || "run_id" in rebase || "task_id" in rebase, false);
  assert.equal(forcedRefreshFields({ prNumber: 6, headSha: "h6", forcedBy: "fix-base-refresh", nowMs: NOW }).head_sha, "h6");
});

test("W1-T7735: a full pass joins a decision with its outcome once", async () => {
  const ledger = [{ step: REFRESH_DECIDED_STEP, decision_id: "7040@head7040:general:1", pr_number: 7040, decision: "skip" }];
  const h = harness({ repairAdmissionSurface: "full" } as Partial<SweepDeps>, ledger);
  await runSweep([pr(7041)], h.deps, POLICY);
  const outcome = h.rows.filter((r) => r.step === REFRESH_OUTCOME_STEP);
  assert.deepEqual(outcome.map((r) => [r.decision_id, r.outcome]), [["7040@head7040:general:1", "left-open-set"]]);
  const light = harness({}, ledger);
  await runSweep([pr(7041)], light.deps, POLICY);
  assert.equal(light.rows.filter((r) => r.step === REFRESH_OUTCOME_STEP).length, 0, "only a full pass sees the whole open set");
});

test("W1-T7735: the production refresh judge has an off switch, a single flight, a heads state and a bounded prompt", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-w1-t7735-"));
  try {
    const q: RefreshJudgeQuestion = { prNumber: 1, headSha: "h1", prFiles: ["a.ts"], baseFiles: ["b.ts"], baseTruncated: false,
      cause: "distance-baseline", ciInFlight: false };
    const spawned: string[] = [];
    let release: (() => void) | undefined;
    const spawn = (async (args: { prompt: string }) => {
      spawned.push(args.prompt);
      if (spawned.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      return { text: '{"verdict": "independent", "reason": "unrelated"}', costUsd: 0.01, numTurns: 1 };
    }) as unknown as Parameters<typeof productionRefreshJudge>[0]["spawn"];
    const logs: string[] = [];
    const judge = productionRefreshJudge({ repoRoot: process.cwd(), stateDir, diff: async () => "x".repeat(50_000), spawn,
      log: (step) => logs.push(step) });
    const first = judge(q);
    for (let i = 0; i < 50 && release === undefined; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await askRefreshJudge(judge, { ...q, prNumber: 2 })).verdict, "judge-unavailable", "single flight: a second ask is refused");
    release!();
    assert.equal(await first, "independent");
    assert.equal(await judge(q), "independent", "a judged head is not re-spent");
    assert.equal(spawned.length, 1);
    assert.match(spawned[0]!, /diff cut at 40000 characters/);
    assert.deepEqual(logs, ["sweep.refresh.judge_spend"]);

    writeFileSync(join(stateDir, REFRESH_JUDGE_OFF_FILE), "");
    const off = await askRefreshJudge(judge, { ...q, headSha: "h2" });
    assert.equal(off.verdict, "judge-unavailable");
    assert.match(String(off.error), /REFRESH_JUDGE_OFF/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
  assert.equal((await askRefreshJudge(undefined, {} as RefreshJudgeQuestion)).verdict, "judge-unavailable");
  assert.equal((await askRefreshJudge(async () => "maybe" as never, {} as RefreshJudgeQuestion)).error, "not a ruling: maybe");
  assert.throws(() => parseRefreshJudgeReply("no json"), /no JSON object/);
  assert.throws(() => parseRefreshJudgeReply('{"verdict": "perhaps"}'), /names no verdict/);
  assert.equal(parseRefreshJudgeReply('ok {"verdict": "overlap"}'), "overlap");
  const many = Array.from({ length: 205 }, (_, i) => `f${i}.ts`);
  assert.match(buildRefreshJudgePrompt({ prNumber: 1, headSha: "h", prFiles: many, baseFiles: [], baseTruncated: true,
    cause: "c", ciInFlight: true }, ""), /5 more cut[\s\S]*GitHub truncated this list/);
});

test("W1-T7735: the production sweep effects read main's protection strictness and wire the judge only for production", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t7735-effects-"));
  try {
    const reads: string[][] = [];
    const build = (productionProgressJudge: boolean, reply: unknown) => buildSweepEffects({
      owner: "craigoley", repo: "remudero", config: { claudeBin: "/usr/bin/true", root } as never,
      ledgerPath: join(root, "ledger.ndjson"), runId: "SWEEP-W1-T7735", plan: { tasks: [] } as never, log: () => {},
      policy: undefined, reviewRunner: undefined, spawnImpl: undefined, pushEmptyCommit: undefined,
      issuesImpl: { create: () => { throw new Error("no issue is filed here"); } } as never,
      stallNotice: undefined, armImpl: undefined, armSessionPrsOverride: undefined, updateBranchImpl: undefined,
      captureRepairFeedbackImpl: undefined, productionProgressJudge,
      ghJsonImpl: ((args: string[]) => { reads.push(args); return reply; }) as never,
    } as never);
    const fixture = build(false, { strict: false });
    assert.equal(fixture.readBranchProtectionStrict!(), false);
    assert.deepEqual(reads, [["api", "repos/craigoley/remudero/branches/main/protection/required_status_checks"]]);
    assert.equal(build(false, { strict: true }).readBranchProtectionStrict!(), true);
    assert.equal(build(false, { contexts: [] }).readBranchProtectionStrict!(), undefined, "no boolean strict is unread, never false");
    assert.equal(fixture.refreshJudge, undefined, "a fixture spends no model call");
    assert.equal(typeof build(true, {}).refreshJudge, "function");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T7735: the predicted cost prices CI at the newest median run main-health observed", async () => {
  const stale = pr(7041, { autoMergeArmed: true, mergeState: "behind" });
  const facts = { behindMainByPr: one(7041, 12), baseChangedFilesByPr: one(7041, base(["src/other.ts"])),
    readBranchProtectionStrict: () => false };
  const costOf = async (ledger: Array<Record<string, unknown>>) => {
    const h = harness(facts, ledger);
    await runSweep([stale], h.deps, POLICY);
    return decided(h.rows)[0]?.predicted_cost_ci_min;
  };
  // No observation yet: the measured 2026-10-10 median prices the run.
  assert.equal(await costOf([]), DEFAULT_CI_MINUTES);
  // The main-health rung's own median of main's completed runs; the newest one wins.
  const bisecting = (medianRunMs: number | null) =>
    ({ run_id: "SWEEP", task_id: "SWEEP", step: "main.repair.bisecting", median_run_ms: medianRunMs });
  assert.equal(await costOf([bisecting(20 * 60_000), bisecting(31.5 * 60_000)]), 31.5);
  // An unread median (null) is not an observation, so the newest real one still prices the run.
  assert.equal(await costOf([bisecting(25 * 60_000), bisecting(null)]), 25);
});

test("W1-T7735: a fix-lane rebase writes its forced decision row before it presses update-branch", async () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const order: string[] = [];
  const result = await runFixRebase({ prUrl: "https://github.com/o/r/pull/7", prerequisitePr: 2411, reviewPassed: false, strikes: 1 }, {
    log: (step, extra) => { rows.push({ step, extra }); order.push(step); },
    say: () => {},
    ledgerLines: () => [],
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 2 }),
    updateBranch: () => { order.push("update-branch"); return { ok: true }; },
  });
  assert.equal(result.rebased, true);
  const row = rows.find((r) => r.step === REFRESH_DECIDED_STEP);
  assert.equal(row?.extra?.forced_by, "fix-rebase");
  assert.equal(row?.extra?.decision, "refresh");
  assert.equal(row?.extra?.pr_number, 7);
  assert.equal(row?.extra?.head_sha, null, "the fix-rebase lane never read the head, so it records none");
  assert.ok(order.indexOf(REFRESH_DECIDED_STEP) < order.indexOf("update-branch"));
});

test("W1-T7735: a base-fixed admission still consults the value test and writes its forced decision row", async () => {
  const at = Date.parse("2026-10-15T15:30:00Z");
  const ago = (minutes: number) => new Date(at - minutes * 60_000).toISOString();
  const file = "test/held.test.ts";
  const held = pr(7050, { checksState: "red", reviewState: "pending", headSha: "1".repeat(40), headRefName: "run-W1-T7050-1",
    createdAt: ago(200), lastActivityAt: ago(1), ciFailures: [{ name: "ci", logTail: `not ok 1 - ${file}`, conclusion: "FAILURE" }] });
  const ledger: Array<Record<string, unknown>> = [
    { step: "main.health.observed", ts: ago(30), sha: "c".repeat(40), state: "green", failing_checks: [] },
    { step: BASE_RED_STOOD_DOWN_STEP, ts: ago(90), pr_number: 7050, head_sha: "1".repeat(40), check_name: "ci" },
  ];
  const updated: number[] = [];
  const order: string[] = [];
  await runSweep([held], {
    arm: () => {}, close: () => {}, escalate: () => {}, dispatchFix: () => {}, postReview: async () => {},
    updateBranch: (p: ArmedStalledPr) => { updated.push(p.prNumber); order.push("update-branch"); return "updated" as const; },
    reproduceFailingTestsOnMerge: async (_p: OpenPrView, files: readonly string[]) =>
      files.map((f) => ({ file: f, outcome: "passes" as const, duration_ms: 5, cached: false })),
    readBranchProtectionStrict: () => false,
    ledgerPath: "/dev/null/w1-t7735.ndjson", runId: "W1-T7735-admission", now: () => at,
    readLedger: () => [...ledger],
    appendLine: (_path: string, row: Record<string, unknown>) => { ledger.push(row); order.push(String(row.step)); },
  } as SweepDeps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(updated, [7050], "a repair is worth its CI run even under non-strict protection");
  const row = decided(ledger).find((r) => r.pr_number === 7050);
  assert.equal(row?.forced_by, REFRESH_ADMISSION_FORCED_BY);
  assert.equal(row?.path, "base-red");
  assert.equal(row?.decision, "refresh");
  assert.equal(row?.strict, false);
  assert.ok(order.indexOf(REFRESH_DECIDED_STEP) < order.indexOf("update-branch"), "the value test is consulted before the press");
  assert.equal(ledger.find((r) => r.step === BASE_RED_REFRESH_STEP && r.pr_number === 7050)?.outcome, "updated");

  // The light pass replays a held head the admission left waiting; it records the forced row too.
  const waitingPr = pr(7051, { checksState: "red", headSha: "2".repeat(40) });
  const lightRows: Array<Record<string, unknown>> = [
    { step: "main.health.observed", ts: ago(30), sha: "c".repeat(40), state: "green", failing_checks: [] },
    { step: "sweep.base_red.refresh_admission", ts: ago(5), signal: "clear", width: 2, admitted: [],
      waiting: [{ pr_number: 7051, head_sha: "2".repeat(40), arm: "base-red", held_since: ago(60),
        refresh_row: { run_id: "old", task_id: "W1-T7051", step: BASE_RED_REFRESH_STEP, pr_number: 7051, head_sha: "2".repeat(40) } }] },
  ];
  const lightUpdated: number[] = [];
  await runLightPassRefreshAdmission([waitingPr], {
    ledgerPath: "/dev/null/w1-t7735.ndjson", runId: "W1-T7735-light", now: () => at,
    updateBranch: (p: ArmedStalledPr) => { lightUpdated.push(p.prNumber); return "updated" as const; },
    readLedger: () => [...lightRows], appendLine: (_path: string, row: Record<string, unknown>) => { lightRows.push(row); },
  });
  assert.deepEqual(lightUpdated, [7051]);
  const lightRow = decided(lightRows)[0];
  assert.equal(lightRow?.forced_by, REFRESH_ADMISSION_FORCED_BY);
  assert.equal(lightRow?.decision_id, `7051@${"2".repeat(40)}:${REFRESH_ADMISSION_FORCED_BY}:${at}`);
});
