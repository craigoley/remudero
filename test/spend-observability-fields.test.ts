/**
 * test/spend-observability-fields.test.ts — W1-T2383, ranks 1 and 2 only.
 *
 * FIVE SPEND QUESTIONS ARE UNANSWERABLE AND FOUR ARE ONE FIELD ON A ROW THAT ALREADY EXISTS.
 * This suite covers the two highest-ranked, which is where this PR stops:
 *
 *  RANK 1 — `cost_usd` (and the mount that spent it) on `risk_judge.decision`. Measured
 *  2026-08-27: 276 risk-judge rows, ZERO carrying a cost and ZERO carrying a mount, so
 *  `resolveRiskJudgeMount`'s DELIBERATE choice of the cheapest configured tier at a floor is a
 *  design decision whose consequence cannot be read off anything on disk.
 *
 *  RANK 2 — `max_turns` beside `num_turns` on `fix.done`. Absent on 233 of 233 rows against
 *  $629.99 of fix-rung spend, on a surface verdict rows do not contain at all (16 of 109 fix run
 *  ids carry a verdict), so an EXHAUSTED fix run is indistinguishable from a merely long one.
 *
 * DECLARED IS NOT POPULATED. Every test below DRIVES the real code path and READS THE ROW BACK —
 * never an assertion that a type has a key. That is the shipped-but-unwired shape this repo has
 * found repeatedly, and `compaction_events` (rank 4, deliberately NOT built here) is on the
 * shard's own list precisely because it was declared and left empty.
 *
 * NOTHING HERE CHANGES BEHAVIOUR, and the last three tests are what says so.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { realRiskJudge, riskJudgeSpendCollector, runRiskJudge, type RiskJudgeInput } from "../src/lib/risk-judge.js";
import { runFixRung } from "../src/run-task.js";
import { buildDigest } from "../src/lib/digest.js";
import { groupSpendByAccount } from "../src/lib/ledger.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

const JUDGE_MOUNT: Mount = { model: "haiku", effort: "low", maxTurns: 40, contextBudget: 40000 };
const FIX_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function worker(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

const JUDGE_INPUT: RiskJudgeInput = {
  change: { description: "W1-X — https://github.com/acme/r/pull/1", files: ["src/a.ts"] },
  gatesState: { review_state: "success", review_capped: false, ci: "green", arm_decision: "armed" },
  planContext: { taskId: "W1-X", taskType: "implement" },
};

function captureRows(): {
  rows: Array<{ step: string } & Record<string, unknown>>;
  log: (step: string, extra?: Record<string, unknown>) => void;
} {
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  return { rows, log: (step, extra) => rows.push({ step, ...(extra ?? {}) }) };
}

const PARSED_LOW = "RISK_VERDICT: low\nCONFIDENCE: 0.9\nREASONS:\n- nothing adverse";

// ══ RANK 1 — the risk judge prices itself ══════════════════════════════════════════════════════

test("W1-T2383 (rank 1): a driven risk-judge decision row carries the cost, the turns, the cap and the mount that spent them", async () => {
  const { rows, log } = captureRows();
  const spend = riskJudgeSpendCollector();
  await runRiskJudge(
    JUDGE_INPUT,
    {
      judge: realRiskJudge({
        mount: JUDGE_MOUNT,
        cwd: "/tmp",
        settingsFile: "/tmp/s.json",
        spend,
        spawn: async (args) =>
          worker({ text: PARSED_LOW, costUsd: 0.0123, numTurns: 4, maxTurns: args.maxTurns, accountLabel: "acct-A" }),
      }),
      escalate: () => "https://example.invalid/issues/1",
      log,
      spend,
    },
  );

  const row = rows.find((r) => r.step === "risk_judge.decision");
  assert.ok(row, "the decision row is still written");
  assert.equal(row!.cost_usd, 0.0123, "POPULATED, not declared — the real spawn's costUsd reached the row");
  assert.equal(row!.num_turns, 4);
  assert.equal(row!.max_turns, 40, "the cap rides BESIDE the count (W1-T303/W1-T2238), off the mount, never read back");
  assert.equal(row!.model, "haiku", "the tier whose price this makes readable");
  assert.equal(row!.effort, "low");
  assert.equal(row!.account_label, "acct-A", "so a spend reader credits the row instead of refusing it as unlabelled");
  assert.equal(row!.attempts, 1, "the healthy path spawns exactly once (W1-T2212)");
  assert.equal(row!.verdict, "low", "the verdict itself is untouched by measuring what it cost");
});

test("W1-T2383 (rank 1): a RETRIED judgment reports what every attempt cost, not only the last", async () => {
  const { rows, log } = captureRows();
  const spend = riskJudgeSpendCollector();
  let call = 0;
  await runRiskJudge(
    JUDGE_INPUT,
    {
      judge: realRiskJudge({
        mount: JUDGE_MOUNT,
        cwd: "/tmp",
        settingsFile: "/tmp/s.json",
        spend,
        spawn: async (args) => {
          call++;
          return worker({
            text: call === 1 ? "no verdict here at all" : PARSED_LOW,
            costUsd: call === 1 ? 0.02 : 0.03,
            numTurns: call,
            maxTurns: args.maxTurns,
          });
        },
      }),
      escalate: () => "https://example.invalid/issues/1",
      log,
      spend,
    },
  );

  const row = rows.find((r) => r.step === "risk_judge.decision")!;
  assert.equal(call, 2, "the unparseable first attempt really was retried");
  assert.equal(Number(row.cost_usd).toFixed(4), "0.0500", "an unparseable attempt still cost real money and is counted");
  assert.equal(row.num_turns, 3);
  assert.equal(row.attempts, 2);
});

test("W1-T2383 (rank 1): a judgment that SPAWNED NOTHING omits every spend key rather than reporting a zero", async () => {
  const { rows, log } = captureRows();
  const spend = riskJudgeSpendCollector();
  await runRiskJudge(
    JUDGE_INPUT,
    {
      judge: async () => {
        throw new Error("judge unavailable before any spawn");
      },
      escalate: () => "https://example.invalid/issues/1",
      log,
      spend,
    },
  );

  const row = rows.find((r) => r.step === "risk_judge.decision")!;
  assert.equal("cost_usd" in row, false, "a zero would read as 'measured, free' — absence is the honest report");
  assert.equal("model" in row, false);
  assert.equal("attempts" in row, false);
  assert.equal(row.verdict, "high", "and the fail-closed judge-unavailable verdict is unchanged");
});

test("W1-T2383 (rank 1): a caller that wires NO collector ledgers the row byte-identically to before this task", async () => {
  const { rows, log } = captureRows();
  await runRiskJudge(
    JUDGE_INPUT,
    {
      judge: async () => ({ verdict: "low" as const, confidence: 0.5, reasons: ["r"] }),
      escalate: () => "https://example.invalid/issues/1",
      log,
    },
  );
  const row = rows.find((r) => r.step === "risk_judge.decision")!;
  assert.deepEqual(Object.keys(row).sort(), ["action", "confidence", "reason", "reasons", "step", "verdict"]);
});

// ══ RANK 2 — the fix rung records the cap it ran under ═════════════════════════════════════════

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function review(state: "success" | "failure", criteria: CriterionVerdict[], headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "met" : "unmet",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

const issues: IssueGateway = { create: () => "https://example.invalid/issues/2" };

async function driveOneFixRound(spawnResult: WorkerResult): Promise<Array<{ step: string } & Record<string, unknown>>> {
  const { rows, log } = captureRows();
  await runFixRung({
    taskId: "W1-F",
    runId: "W1-F-1730000000000",
    task: { id: "W1-F", title: "A task" },
    prUrl: "https://github.com/acme/r/pull/9",
    branch: "run-W1-F-1730000000000",
    worktreePath: "/tmp/rmd-t2383-wt",
    initialSessionId: "session-0",
    mount: FIX_MOUNT,
    settingsFile: "/tmp/rmd-t2383-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "r", headCheckoutDir: "/tmp/rmd-t2383-wt", reviewerMount: FIX_MOUNT },
    strikeCap: 2,
    initialReview: review("failure", [criterion({ claim: "criterion A", met: false, reason: "r" })], "head0"),
    deps: {
      spawn: async () => spawnResult,
      waitForCiGreen: async () => ({ state: "green" }) as never,
      runReview: async () => review("success", [criterion({ claim: "criterion A", met: true })], "head1") as never,
      push: () => {},
      issues,
      ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-t2383-")), "ledger.ndjson"),
      log,
      say: () => {},
      account: (r: WorkerResult) => r,
    },
  });
  return rows;
}

test("W1-T2383 (rank 2): a driven fix.done row carries the cap it ran under, beside the turns it used", async () => {
  const rows = await driveOneFixRound(worker({ costUsd: 1.25, numTurns: 37, maxTurns: FIX_MOUNT.maxTurns, sessionId: "s1" }));
  const done = rows.find((r) => r.step === "fix.done");
  assert.ok(done, "the fix.done row is still written");
  assert.equal(done!.max_turns, 400, "POPULATED from SpawnWorkerArgs.maxTurns, i.e. the mount's cap");
  assert.equal(done!.num_turns, 37, "beside the count, never replacing it");
  assert.equal(done!.cost_usd, 1.25, "and every field the row already carried is unchanged");
});

test("W1-T2383 (rank 2): a spawn configured with NO cap omits max_turns rather than writing undefined", async () => {
  const rows = await driveOneFixRound(worker({ costUsd: 0.5, numTurns: 3, maxTurns: undefined, sessionId: "s2" }));
  const done = rows.find((r) => r.step === "fix.done")!;
  assert.equal("max_turns" in done, false, "never a guessed value — the same W1-T303 discipline");
  assert.equal(done.num_turns, 3);
});

// ══ Q3 — every reader of a touched row, shown unchanged ════════════════════════════════════════

test("W1-T2383 (Q3): the digest's cost total is step-gated on `verdict`, so a priced risk-judge row moves it by nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t2383-digest-"));
  const path = join(dir, "ledger.ndjson");
  const base = [
    { ts: "2026-08-27T10:00:00.000Z", run_id: "R", task_id: "W1-A", step: "verdict", verdict: "merged", cost_usd: 2 },
  ];
  const withJudge = [
    ...base,
    { ts: "2026-08-27T10:01:00.000Z", run_id: "R", task_id: "W1-A", step: "risk_judge.decision", verdict: "low", cost_usd: 99 },
  ];
  const render = (lines: Array<Record<string, unknown>>): string => {
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return buildDigest(path, "2026-08-27T00:00:00.000Z");
  };
  const before = render(base);
  const after = render(withJudge);
  const costLine = (s: string): string => s.split("\n").find((l) => l.includes("notional cost:")) ?? "";
  assert.equal(costLine(after), costLine(before), "the $99 judge row contributes nothing — the fold reads `verdict` rows only");
  assert.match(costLine(before), /notional cost: \$2\.00/, "CONTROL: the line really is the cost line and really carries the verdict row s 2 dollars");
});

test("W1-T2383 (Q3): the board's spend fold still reads only cost_usd and num_turns on implement.done/fix.done, so max_turns is inert there", () => {
  const src = readFileSync(new URL("../src/lib/board.ts", import.meta.url), "utf8");
  const from = src.indexOf('if (line.step !== "implement.done" && line.step !== "fix.done") continue;');
  assert.ok(from >= 0, "the fold must still exist under that exact predicate");
  const region = src.slice(from, from + 260);
  assert.match(region, /line\.cost_usd/);
  assert.match(region, /line\.num_turns/);
  assert.equal(/line\.max_turns/.test(region), false, "the added key is read by nothing in this fold");
});

test("W1-T2383 (Q3): the one step-agnostic spend reader credits the new row instead of refusing it as unlabelled", () => {
  const priced = groupSpendByAccount([
    { ts: "2026-08-27T10:00:00.000Z", step: "risk_judge.decision", cost_usd: 0.01, account_label: "acct-A" },
  ] as never);
  assert.deepEqual(priced.byAccount, [{ accountLabel: "acct-A", totalCostUsd: 0.01, lineCount: 1 }]);
  assert.equal(priced.refused.unlabelledCount, 0, "carrying account_label is what keeps this out of the refusal bucket");
});
