import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUncertainVerdict,
  runRiskJudge,
  type RiskJudgeChangeView,
  type RiskJudgeDiffSource,
  type RiskJudgeInput,
  type RiskJudgeOrchestratorDeps,
  type RiskJudgeVerdict,
} from "#src/lib/risk-judge.js";

// PR #16213 (W1-T10857) was green with a remudero-review PASS from 02:17Z and the fleet never armed it. The
// handed-off-head judge returned `high` at confidence 0.60, below the 0.70 threshold, "on the change's
// description/files alone, no diff was read", and every reason was a metadata gap the diff would settle
// (test files missing from `files:`, a seam not shown as merged). W1-T7724 re-judged only an uncertain `low`
// with the diff, so an uncertain `high` escalated on the title alone. Now both labels get the second look.

const PATCH = "@@ -1,3 +1,4 @@ export function arms()\n-const a = 1;\n+const a = 2;\n+const b = 3;";

function input(): RiskJudgeInput {
  return {
    change: {
      description: "the open-weight arms join the deployment bake-off — https://github.com/o/r/pull/16213",
      files: ["src/lib/inbox-bakeoff.ts"],
    },
    gatesState: { review_state: "success", checks_state: "green", owner: "sweep (handed-off head)" },
    planContext: { taskId: "W1-T10857" },
    prNumber: 16213,
    headSha: "5c177ab9a",
  };
}

function view(): RiskJudgeChangeView {
  return {
    files: [
      { path: "src/lib/inbox-bakeoff.ts", additions: 2, deletions: 1, patch: PATCH },
      { path: "test/inbox-bakeoff.test.ts", additions: 5, deletions: 0, patch: "@@ -0,0 +1,5 @@\n+test body" },
    ],
    truncated: false,
  };
}

const uncertainHigh: RiskJudgeVerdict = {
  verdict: "high",
  confidence: 0.6,
  reasons: ["3 test files are not declared in files:", "the W1-T10856 seam is not shown as merged"],
};

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
    judge: async (judged) => {
      h.calls.push(judged);
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

test("PR-16213: an uncertain high-risk verdict is re-judged with the diff and a confident low on the diff proceeds", async () => {
  const h = harness([uncertainHigh, { verdict: "low", confidence: 0.9, reasons: ["the diff is a narrow, tested change"] }]);
  const result = await runRiskJudge(input(), h.deps, CONFIG);
  assert.equal(h.calls.length, 2, "the judge is called a second time");
  assert.equal(h.calls[0].change.diff, undefined, "tier 1 carries no diff");
  assert.ok(h.calls[1].change.diff, "tier 2 carries the diff");
  assert.equal(h.reads, 1, "the diff is read once");
  assert.equal(result.action.kind, "proceed");
  assert.equal(result.evidenceTier, "diff");
  assert.equal(h.escalations, 0, "no issue is filed");
  assert.equal(h.rows.filter((r) => r.step === "risk_judge.escalated").length, 0);
  const decisions = h.rows.filter((r) => r.step === "risk_judge.decision");
  assert.equal(decisions.length, 1, "ONE decision row, the deciding one");
  assert.equal(decisions[0].extra?.evidence_tier, "diff");
  assert.equal(decisions[0].extra?.tier1_verdict, "high", "the row keeps the description-tier high it replaced");
  assert.equal(decisions[0].extra?.tier1_confidence, 0.6);
});

test("PR-16213: an uncertain high that the diff confirms escalates on the diff tier", async () => {
  const h = harness([uncertainHigh, { verdict: "high", confidence: 0.85, reasons: ["rewrites the merge gate"] }]);
  const result = await runRiskJudge(input(), h.deps, CONFIG);
  assert.equal(result.action.kind, "escalate");
  assert.equal(h.escalations, 1);
  assert.match(result.action.reason, /judged on the diff/);
  assert.doesNotMatch(result.action.reason, /no diff was read/);

  const stillUnsure = harness([uncertainHigh, { verdict: "low", confidence: 0.6, reasons: ["unclear"] }]);
  const unsure = await runRiskJudge(input(), stillUnsure.deps, CONFIG);
  assert.equal(unsure.action.kind, "escalate", "a low still below the threshold on the diff escalates");
});

test("PR-16213: an uncertain high with no readable diff still escalates and names why", async () => {
  const unreadable = harness([uncertainHigh], {
    read: () => {
      throw new Error("files read failed");
    },
  });
  const result = await runRiskJudge(input(), unreadable.deps, CONFIG);
  assert.equal(result.action.kind, "escalate", "an unread diff never turns a high into a proceed");
  assert.equal(unreadable.calls.length, 1);
  assert.match(result.action.reason, /^high-risk verdict at confidence 0\.60/);
  assert.match(result.action.reason, /diff not read: files read failed/);

  const unwired = harness([uncertainHigh], "none");
  const unwiredResult = await runRiskJudge(input(), unwired.deps, CONFIG);
  assert.equal(unwiredResult.action.kind, "escalate", "no diff source: the high stands as before");
  assert.equal(unwired.calls.length, 1);
});

test("PR-16213: a confident high or a STOP escalates without reading the diff", async () => {
  const confident = harness([{ verdict: "high", confidence: 0.9, reasons: ["touches the merge gate"] }]);
  const result = await runRiskJudge(input(), confident.deps, CONFIG);
  assert.equal(result.action.kind, "escalate");
  assert.equal(confident.calls.length, 1, "no second judgment");
  assert.equal(confident.reads, 0, "the diff is never read");

  const stop = harness([{ ...uncertainHigh, gateConsequence: "STOP" }]);
  await runRiskJudge(input(), stop.deps, CONFIG);
  assert.equal(stop.calls.length, 1, "a STOP is never re-judged");

  // The band applies to both labels alike, and the threshold is the live policy value.
  assert.equal(isUncertainVerdict({ verdict: "high", confidence: 0.72, reasons: [] }, CONFIG), false);
  assert.equal(isUncertainVerdict({ verdict: "high", confidence: 0.72, reasons: [] }, { ...CONFIG, borderlineBand: 0.1 }), true);
  assert.equal(isUncertainVerdict({ verdict: "high", confidence: 0.6, reasons: [], availability: "unavailable" }, CONFIG), false);
});
