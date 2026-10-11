import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  boundRiskJudgeDiff,
  buildRiskJudgePrompt,
  parseRiskPolicy,
  riskJudgeDiffInputBudget,
  runRiskJudge,
  type RiskJudgeChangeView,
  type RiskJudgeDiffSource,
  type RiskJudgeInput,
  type RiskJudgeOrchestratorDeps,
  type RiskJudgeVerdict,
} from "../src/lib/risk-judge.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { WorkerResult } from "../src/lib/worker.js";
import * as runTaskModule from "../src/run-task.js";
import { changeView, changeViewAsync } from "../src/run-task.js";

// W1-T7724 — PR #10339 (W1-T7092) had a review PASS and green checks, and the handed-off-head judge
// still opened issue #10670 at low risk / confidence 0.60 "on the change's description/files alone, no
// diff was read". An uncertain `low` is now judged a second time WITH the diff before it may escalate.

const PATCH = "@@ -1,3 +1,4 @@ export function widen()\n-const a = 1;\n+const a = 2;\n+const b = 3;";

function baseInput(): RiskJudgeInput {
  return {
    change: { description: "widen the cache key — https://github.com/o/r/pull/10339", files: ["src/lib/cache.ts"] },
    gatesState: { review_state: "success", checks_state: "green" },
    planContext: { taskId: "W1-T7092" },
    prNumber: 10339,
    headSha: "abc1234",
  };
}

function view(): RiskJudgeChangeView {
  return {
    files: [
      { path: "src/lib/cache.ts", additions: 2, deletions: 1, patch: PATCH },
      { path: "test/cache.test.ts", additions: 5, deletions: 0, patch: "@@ -0,0 +1,5 @@\n+test body" },
    ],
    truncated: false,
  };
}

function low(confidence: number, reason = "narrow, well-covered change"): RiskJudgeVerdict {
  return { verdict: "low", confidence, reasons: [reason] };
}

interface Harness {
  deps: RiskJudgeOrchestratorDeps;
  calls: RiskJudgeInput[];
  escalations: number;
  reads: number;
  rows: Array<{ step: string; extra?: Record<string, unknown> }>;
}

function harness(verdicts: RiskJudgeVerdict[], source: Partial<RiskJudgeDiffSource> | "none" = {}): Harness {
  const h: Harness = { calls: [], escalations: 0, reads: 0, rows: [], deps: undefined as unknown as RiskJudgeOrchestratorDeps };
  h.deps = {
    judge: async (input) => {
      h.calls.push(input);
      const next = verdicts[h.calls.length - 1];
      if (next === undefined) throw new Error("unexpected extra judge call");
      return next;
    },
    escalate: async () => {
      h.escalations += 1;
      return "https://github.com/o/r/issues/1";
    },
    log: (step, extra) => h.rows.push({ step, extra }),
    ...(source === "none"
      ? {}
      : {
          diffSource: {
            read: () => {
              h.reads += 1;
              return view();
            },
            inputBudgetChars: () => 100_000,
            ...source,
          },
        }),
  };
  return h;
}

const CONFIG = { confidenceThreshold: 0.7 };

test("W1-T7724: an uncertain low-risk verdict is re-judged with the diff", async () => {
  const h = harness([low(0.6), low(0.9)]);
  await runRiskJudge(baseInput(), h.deps, CONFIG);
  assert.equal(h.calls.length, 2, "the judge is called a second time");
  assert.equal(h.calls[0].change.diff, undefined, "tier 1 carries no diff");
  assert.ok(h.calls[1].change.diff, "tier 2 carries the diff");
  assert.equal(h.reads, 1, "the diff is read once");
  const prompt = buildRiskJudgePrompt(h.calls[1]);
  assert.match(prompt, /THE DIFF IS SHOWN/);
  assert.match(prompt, /const a = 2;/, "the patch text is in the tier-2 prompt");
  assert.doesNotMatch(prompt, /YOU ARE NOT SHOWN A DIFF/);
  assert.match(buildRiskJudgePrompt(h.calls[0]), /YOU ARE NOT SHOWN A DIFF/, "tier 1 is unchanged");

  // The borderline band: a low verdict just ABOVE the threshold is uncertain too, and it is policy, not a literal.
  const banded = harness([low(0.72), low(0.95)]);
  await runRiskJudge(baseInput(), banded.deps, { ...CONFIG, borderlineBand: 0.1 });
  assert.equal(banded.calls.length, 2, "0.72 sits inside [0.70, 0.80): re-judged");
  const unbanded = harness([low(0.72)]);
  await runRiskJudge(baseInput(), unbanded.deps, CONFIG);
  assert.equal(unbanded.calls.length, 1, "with no band, 0.72 is confident");
  assert.equal(parseRiskPolicy({ borderlineBand: { value: 0.1 } }).borderlineBand, 0.1);
  assert.equal(parseRiskPolicy(undefined).borderlineBand, 0);
});

test("W1-T7724: a confident low-risk verdict on the diff proceeds unattended", async () => {
  const h = harness([low(0.6), low(0.9)]);
  const result = await runRiskJudge(baseInput(), h.deps, CONFIG);
  assert.equal(result.action.kind, "proceed");
  assert.equal(result.escalationUrl, undefined);
  assert.equal(h.escalations, 0, "no issue is filed");
  assert.equal(h.rows.filter((r) => r.step === "risk_judge.escalated").length, 0, "no escalated row is written");
  assert.match(result.action.reason, /judged on the diff: 2 files in full, 0 summarised/);
});

test("W1-T7724: a verdict still uncertain with the diff escalates on the diff tier", async () => {
  const h = harness([low(0.6), low(0.65, "the cache key change might alter eviction")]);
  const result = await runRiskJudge(baseInput(), h.deps, CONFIG);
  assert.equal(result.action.kind, "escalate");
  assert.equal(h.escalations, 1);
  assert.match(result.action.reason, /judged on the diff: 2 files in full, 0 summarised/);
  assert.doesNotMatch(result.action.reason, /no diff was read/);
  assert.equal(h.rows.filter((r) => r.step === "risk_judge.escalated").length, 1);

  const high = harness([low(0.6), { verdict: "high", confidence: 0.9, reasons: ["rewrites the eviction path"] }]);
  const highResult = await runRiskJudge(baseInput(), high.deps, CONFIG);
  assert.equal(highResult.action.kind, "escalate", "a high verdict on the diff escalates");
  assert.match(highResult.action.reason, /judged on the diff/);
});

test("W1-T7724: a high-risk description verdict escalates without a diff re-judgment", async () => {
  const h = harness([{ verdict: "high", confidence: 0.55, reasons: ["touches the merge gate"] }]);
  const result = await runRiskJudge(baseInput(), h.deps, CONFIG);
  assert.equal(result.action.kind, "escalate");
  assert.equal(h.calls.length, 1, "no second judgment");
  assert.equal(h.reads, 0, "the diff is never read");
  assert.match(result.action.reason, /no diff was read/);

  const stop = harness([{ verdict: "low", confidence: 0.3, reasons: ["x"], gateConsequence: "STOP" }]);
  await runRiskJudge(baseInput(), stop.deps, CONFIG);
  assert.equal(stop.calls.length, 1, "a STOP consequence is never re-judged");
});

test("W1-T7724: a confident low-risk description verdict proceeds without the diff", async () => {
  const h = harness([low(0.9)]);
  const result = await runRiskJudge(baseInput(), h.deps, CONFIG);
  assert.equal(result.action.kind, "proceed");
  assert.equal(h.calls.length, 1);
  assert.equal(h.reads, 0, "the diff is never read");
  assert.equal(h.escalations, 0);
});

test("W1-T7724: the decision row records the evidence tier that decided", async () => {
  const diffTier = harness([low(0.6), low(0.9)]);
  await runRiskJudge(baseInput(), diffTier.deps, CONFIG);
  const diffRows = diffTier.rows.filter((r) => r.step === "risk_judge.decision");
  assert.equal(diffRows.length, 1, "ONE decision row per judgment, the deciding one");
  assert.equal(diffRows[0].extra?.evidence_tier, "diff");
  assert.equal(diffRows[0].extra?.confidence, 0.9, "the row is the tier-2 verdict");
  assert.equal(diffRows[0].extra?.tier1_verdict, "low");
  assert.equal(diffRows[0].extra?.tier1_confidence, 0.6, "the superseded tier-1 confidence rides on the row");
  assert.deepEqual(diffRows[0].extra?.diff_files_full, ["src/lib/cache.ts", "test/cache.test.ts"]);
  assert.deepEqual(diffRows[0].extra?.diff_files_summarised, []);

  const descTier = harness([low(0.9)]);
  await runRiskJudge(baseInput(), descTier.deps, CONFIG);
  const descRow = descTier.rows.find((r) => r.step === "risk_judge.decision");
  assert.equal(descRow?.extra?.evidence_tier, "description");
  assert.equal(descRow?.extra?.tier1_verdict, undefined);
});

test("W1-T7724: the diff is bounded by the input budget and a large diff is summarised", async () => {
  const big = "@@ -1,1 +1,9 @@ function big()\n" + "+x\n".repeat(400);
  const bounded: RiskJudgeChangeView = {
    files: [
      { path: "test/small.test.ts", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+t" },
      { path: "src/big.ts", additions: 400, deletions: 0, patch: big },
      { path: "src/small.ts", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
      { path: "assets/huge.bin", additions: 0, deletions: 0 },
    ],
    truncated: false,
  };
  const whole = boundRiskJudgeDiff(bounded, 100_000);
  assert.deepEqual(whole.full.map((f) => f.path).sort(), ["src/big.ts", "src/small.ts", "test/small.test.ts"]);
  assert.deepEqual(whole.summarised.map((f) => f.path), ["assets/huge.bin"], "a row with no patch is summarised");

  const tight = boundRiskJudgeDiff(bounded, 200);
  assert.deepEqual(tight.summarised.map((f) => f.path).sort(), ["assets/huge.bin", "src/big.ts"]);
  assert.deepEqual(tight.full.map((f) => f.path), ["src/small.ts", "test/small.test.ts"], "source files come before tests");
  const bigSummary = tight.summarised.find((f) => f.path === "src/big.ts");
  assert.deepEqual(bigSummary?.hunkHeaders, ["@@ -1,1 +1,9 @@ function big()"], "a summary keeps the hunk headers");
  assert.ok(!JSON.stringify(tight).includes("+x\n+x"), "the summarised patch body is not carried");

  // The seam: the budget callback is given the rendered tier-1 prompt length and its answer bounds the diff.
  let seen = -1;
  const h = harness([low(0.6), low(0.9)], {
    read: () => bounded,
    inputBudgetChars: (tier1Chars) => {
      seen = tier1Chars;
      return 200;
    },
  });
  await runRiskJudge(baseInput(), h.deps, CONFIG);
  assert.equal(seen, buildRiskJudgePrompt(h.calls[0]).length, "the budget is asked against the tier-1 prompt");
  const prompt = buildRiskJudgePrompt(h.calls[1]);
  assert.match(prompt, /SUMMARISED FILES/);
  assert.match(prompt, /src\/big\.ts: \+400\/-0 \(its patch did not fit/);
  assert.match(prompt, /assets\/huge\.bin: \+0\/-0 \(GitHub returned no patch/);
  const row = h.rows.find((r) => r.step === "risk_judge.decision");
  assert.deepEqual((row?.extra?.diff_files_summarised as string[]).sort(), ["assets/huge.bin", "src/big.ts"]);

  assert.equal(riskJudgeDiffInputBudget({ contextBudget: 1000 })(500), 2500, "the default is the mount's context less the tier-1 prompt");
  assert.equal(riskJudgeDiffInputBudget({ contextBudget: 100 })(5000), 0, "never negative");
});

test("W1-T7724: the change view keeps the patch the files read already returned", async () => {
  const rows = [
    { filename: "src/a.ts", additions: 2, deletions: 1, patch: PATCH },
    { filename: "big.bin", additions: 0, deletions: 0 },
  ];
  const calls: string[][] = [];
  const v = changeView("https://github.com/o/r/pull/7", (args) => {
    calls.push(args);
    return rows;
  });
  assert.equal(calls.length, 1, "one gh call");
  assert.equal(v.files[0].patch, PATCH, "the row's patch is kept");
  assert.equal("patch" in v.files[1], false, "no patch key when GitHub sent none");
  const asyncView = await changeViewAsync("https://github.com/o/r/pull/7", async () => rows);
  assert.equal(asyncView.files[0].patch, PATCH);

  // The sweep wiring reads the change view ONCE for both tiers: no second GitHub call.
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t7724-"));
  const config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
  const task = { id: "W1-T7092", title: "widen the cache key", type: "implement", files: ["src/a.ts"] } as unknown as Task;
  const plan: Plan = { tasks: [task], byId: new Map([["W1-T7092", task]]) };
  const prompts: string[] = [];
  let reads = 0;
  const texts = [
    "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.60\nRISK_REASON: narrow",
    "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.92\nRISK_REASON: the diff swaps one constant",
  ];
  const judge = runTaskModule.handedOffHeadRiskJudge(
    "o", "r", config, plan, join(root, "ledger.ndjson"), "SWEEP-7724", () => {},
    async (args) => {
      prompts.push(String(args.prompt));
      return { text: texts[prompts.length - 1], costUsd: 0.01, numTurns: 1 } as unknown as WorkerResult;
    },
    () => "https://github.com/o/r/issues/2",
    () => {
      reads += 1;
      return v;
    },
  );
  const judgment = await judge({
    prNumber: 7, prUrl: "https://github.com/o/r/pull/7", taskId: "W1-T7092", reviewState: "success",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, lastActivityAt: "2026-10-10T00:00:00Z",
    headSha: "abc", autoMergeArmed: false,
  } as never);
  assert.equal(judgment.action, "proceed", "a confident low on the diff proceeds");
  assert.equal(prompts.length, 2);
  assert.equal(reads, 1, "the change view is read once");
  assert.doesNotMatch(prompts[0], /const a = 2;/, "tier 1 does not carry the patch");
  assert.match(prompts[1], /const a = 2;/, "tier 2 carries it");
});

test("W1-T7724: an unreadable diff escalates as today and names why", async () => {
  const h = harness([low(0.6)], {
    read: () => {
      throw new Error("REST files read failed");
    },
  });
  const result = await runRiskJudge(baseInput(), h.deps, { ...CONFIG, judgeUnavailableAction: "proceed" });
  assert.equal(result.action.kind, "escalate", "an unreadable diff is never a confident proceed");
  assert.equal(h.calls.length, 1, "no second judgment");
  assert.match(result.action.reason, /no diff was read/);
  assert.match(result.action.reason, /diff not read: REST files read failed/);
  const row = h.rows.find((r) => r.step === "risk_judge.decision");
  assert.equal(row?.extra?.evidence_tier, "description");
  assert.match(String(row?.extra?.diff_unread), /REST files read failed/);

  // No diff source wired: today's behaviour, unchanged.
  const none = harness([low(0.6)], "none");
  const noneResult = await runRiskJudge(baseInput(), none.deps, CONFIG);
  assert.equal(noneResult.action.kind, "escalate");
  assert.match(noneResult.action.reason, /low-confidence verdict \(0\.60 < 0\.7\)/);

  // A truncated view, a view with nothing in full, and an unavailable second judge are all unread.
  for (const source of [
    { read: () => ({ files: view().files, truncated: true }) },
    { read: () => ({ files: [{ path: "a.bin", additions: 0, deletions: 0 }], truncated: false }) },
  ]) {
    const other = harness([low(0.6)], source);
    const r = await runRiskJudge(baseInput(), other.deps, CONFIG);
    assert.equal(r.action.kind, "escalate");
    assert.match(r.action.reason, /diff not read/);
  }
  const failing = harness([low(0.6)]); // the second judge call throws -> unavailable
  const failed = await runRiskJudge(baseInput(), failing.deps, { ...CONFIG, judgeUnavailableAction: "proceed" });
  assert.equal(failed.action.kind, "escalate", "an unavailable diff judge keeps the tier-1 verdict, which escalates");
  assert.match(failed.action.reason, /diff re-judgment unavailable/);
});
