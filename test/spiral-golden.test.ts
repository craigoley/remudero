import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { evaluateFlightSignals, extractTurnSnapshots, type FlightSignalConfig } from "../src/lib/flight-signals.js";
import {
  extractJudgeTurnEvidence,
  runFlightJudge,
  INITIAL_FLIGHT_JUDGE_STATE,
  type FlightJudgeConfig,
  type FlightJudgeDeps,
  type JudgeInput,
  type JudgeVerdict,
} from "../src/lib/flight-judge.js";

/**
 * P1 spiral golden (W1-T59, MASTER-PLAN §4B) — an engineered-to-spiral run
 * trips a Layer-1 predicate (flight-signals.ts, W1-T20) and DISPATCHES the
 * Layer-2 flight judge (flight-judge.ts, W1-T21) in the ledger, BEFORE any
 * budget cliff. This is the END-TO-END wiring that flight-signals.test.ts and
 * flight-judge.test.ts each exercise only in isolation: the former never
 * drives a judge dispatch, the latter is fed a hand-built verdict rather than
 * a Layer-1 trip. Here ONE raw stream-json transcript feeds BOTH reducers
 * (extractTurnSnapshots for Layer 1, extractJudgeTurnEvidence for Layer 2),
 * exactly as a real run would, and a REAL ledger file (not a collecting fake)
 * is the assertion surface for "dispatches the flight judge in the ledger".
 */

const TASK_ID = "W1-Tspiral";
const CRITERIA: AcceptanceCriterion[] = [
  { claim: "fixes the off-by-one in the paginator", proof: "test/paginator.test.ts passes" },
];

// The engineered-to-spiral transcript: the SAME edit applied then reverted,
// turn after turn (flat burn — a fixed, modest per-turn spend; no diff ever
// nets forward) — the exact "same edit reverted / flat burn" case §4B and the
// W1-T59 acceptance name. 6 turns is enough to clear repeatedToolCallThreshold
// (default 3) while staying nowhere near a budget cliff.
const EDIT = { file_path: "src/paginator.ts", old_string: "i <= n", new_string: "i < n" };
const REVERT = { file_path: "src/paginator.ts", old_string: "i < n", new_string: "i <= n" };
const PER_TURN_COST = 0.35; // flat — no burn-rate spike, the trip must come from repetition alone
const SPIRAL_RAW_TRANSCRIPT: unknown[] = Array.from({ length: 6 }, (_, i) => [
  {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Let me try flipping the comparison operator..." },
        { type: "tool_use", name: "Edit", input: i % 2 === 0 ? EDIT : REVERT },
      ],
    },
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", content: "edit applied" }] },
  },
]).flat();

// The task's real budget cap (mirrors run-task.ts's DEFAULT_BUDGET_USD = 100;
// a `blocked_budget` verdict is only reachable via that $100 hard tripwire,
// see run-task.ts's WorkerErrorVerdict). The spiral's total spend below stays
// two orders of magnitude under it.
const TASK_BUDGET_USD = 100.0;

function verdict(partial: Partial<JudgeVerdict>): JudgeVerdict {
  return { state: "productive", evidence: [], recommendation: "continue", confidence: 0.5, ...partial };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-spiral-golden-")), "ledger.ndjson");
}

test("acceptance: an engineered-to-spiral fixture trips a Layer-1 predicate and dispatches the flight judge in the ledger, with NO blocked_budget reached", async () => {
  // ── Layer 1: the SAME raw transcript, reduced for the deterministic tripwire ──
  const snapshots = extractTurnSnapshots(SPIRAL_RAW_TRANSCRIPT).map((snap, i) => ({
    ...snap,
    cumulativeCostUsd: (i + 1) * PER_TURN_COST,
    elapsedMs: (i + 1) * 60_000,
  }));
  const signalConfig: FlightSignalConfig = { burnRateBaselineUsdPerTurn: 1.0 }; // tolerance*3 => $3/turn limit; PER_TURN_COST is well under it
  const flightSignalVerdict = evaluateFlightSignals(snapshots, signalConfig);

  assert.equal(flightSignalVerdict.tripped, true, "the spiral must trip SOME Layer-1 predicate");
  const repeated = flightSignalVerdict.predicates.find((p) => p.predicate === "repeated_tool_call");
  assert.ok(repeated, "repeated_tool_call predicate must be present");
  assert.equal(repeated!.tripped, true, "the reverted-edit pattern must trip repetition, not some other predicate");
  // Confirm the burn-rate predicate specifically did NOT trip — this is a flat-burn
  // spiral, not a cost spike; the catch must come from repetition, exactly as engineered.
  const burnRate = flightSignalVerdict.predicates.find((p) => p.predicate === "burn_rate");
  assert.equal(burnRate!.tripped, false, "flat per-turn spend must not itself trip burn_rate");

  // ── BEFORE any budget cliff: the trip fires while spend is a sliver of the cap ──
  const totalSpendAtTrip = snapshots[snapshots.length - 1].cumulativeCostUsd;
  assert.ok(
    totalSpendAtTrip < TASK_BUDGET_USD * 0.1,
    `spend at trip ($${totalSpendAtTrip}) must sit far under the $${TASK_BUDGET_USD} budget cliff`,
  );

  // ── Layer 2: the SAME transcript, reduced into judge evidence (never the
  // worker's own narration — extractJudgeTurnEvidence drops the "text" block) ──
  const recentTurns = extractJudgeTurnEvidence(SPIRAL_RAW_TRANSCRIPT);
  const judgeInput: JudgeInput = { taskId: TASK_ID, goal: "fix the paginator", acceptanceCriteria: CRITERIA, recentTurns };

  // The deterministic controller only invokes the judge because Layer 1 tripped
  // (§4B: a trip only INVOKES Layer 2; it never judges by itself) — that gating
  // is the caller's job in a real run-loop; here it is asserted explicitly as
  // the precondition for the dispatch below, so the ledger write below can only
  // ever happen downstream of the Layer-1 trip proven above.
  assert.ok(flightSignalVerdict.tripped, "Layer 2 must only be invoked on a Layer-1 trip");

  const ledgerPath = tmpLedgerPath();
  const runId = "run-spiral-golden-1";
  const judgeConfig: FlightJudgeConfig = { maxInvocationsPerRun: 3 };
  const deps: FlightJudgeDeps = {
    // Simulates what a real fresh-context judge returns for "same edit reverted N times" —
    // parseJudgeVerdict's text-format parsing is exercised elsewhere (flight-judge.test.ts).
    judge: async () =>
      verdict({
        state: "spiraling",
        recommendation: "halt_and_diagnose",
        confidence: 0.93,
        evidence: ["the same Edit on src/paginator.ts was applied and reverted repeatedly across 6 turns"],
      }),
    diagnose: async () => ({ text: "root cause: the comparison operator flip is being applied then reverted" }),
    escalate: async () => "https://github.com/owner/repo/issues/1",
    log: (step, extra) => appendLedger(ledgerPath, { run_id: runId, task_id: TASK_ID, step, ...extra }),
  };

  const result = await runFlightJudge(judgeInput, INITIAL_FLIGHT_JUDGE_STATE, judgeConfig, deps);

  assert.equal(result.verdict.state, "spiraling");
  assert.equal(result.action.kind, "halt_and_diagnose");
  assert.equal(result.diagnosed, true);

  // ── "dispatches the flight judge in the ledger" — read the REAL ledger back ──
  const lines = readLedgerLines(ledgerPath).filter((l) => l.task_id === TASK_ID);
  const steps = lines.map((l) => l.step);
  assert.ok(steps.includes("flight_judge.verdict"), "the judge's verdict must be ledgered");
  assert.ok(steps.includes("flight_judge.action"), "the controller's action must be ledgered");
  assert.ok(steps.includes("flight_judge.diagnose_dispatched"), "the diagnose dispatch must be ledgered");

  const verdictLine = lines.find((l) => l.step === "flight_judge.verdict")!;
  assert.equal(verdictLine.state, "spiraling");

  // ── NO blocked_budget reached anywhere in this path ──
  // 1. No ledger line names blocked_budget (the only place that verdict shape
  //    is produced is run-task.ts's error_max_budget_usd branch — a wholly
  //    different code path this fixture never touches).
  assert.ok(!lines.some((l) => l.step === "blocked_budget" || l.verdict === "blocked_budget"));
  // 2. ControllerActionKind (the flight judge's entire outcome space) has no
  //    "blocked_budget" member at all — structurally, this path cannot produce one.
  const POSSIBLE_ACTION_KINDS = ["continue", "raise_threshold_and_continue", "halt_and_diagnose", "halt_and_escalate"];
  assert.ok(POSSIBLE_ACTION_KINDS.includes(result.action.kind));
  // 3. The spend that accompanied the trip stayed far under the cap (re-asserted
  //    here against the SAME totalSpendAtTrip figure the Layer-1 section proved).
  assert.ok(totalSpendAtTrip < TASK_BUDGET_USD);
});

test("control: a healthy varied transcript at the SAME flat per-turn cost trips NOTHING, and the judge is never invoked", async () => {
  const healthyRaw: unknown[] = Array.from({ length: 6 }, (_, i) => [
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `src/file${i}.ts`, marker: i } }] },
    },
    { type: "user", message: { content: [{ type: "tool_result", content: "edit applied" }] } },
  ]).flat();

  const snapshots = extractTurnSnapshots(healthyRaw).map((snap, i) => ({
    ...snap,
    cumulativeCostUsd: (i + 1) * PER_TURN_COST,
    elapsedMs: (i + 1) * 60_000,
  }));
  const signalConfig: FlightSignalConfig = { burnRateBaselineUsdPerTurn: 1.0 };
  const flightSignalVerdict = evaluateFlightSignals(snapshots, signalConfig);
  assert.equal(flightSignalVerdict.tripped, false);

  let judgeInvoked = false;
  const deps: FlightJudgeDeps = {
    judge: async () => {
      judgeInvoked = true;
      return verdict({});
    },
    diagnose: async () => ({ text: "" }),
    escalate: async () => "",
  };
  // A real run-loop gates the judge behind the Layer-1 trip; since it never
  // tripped here, a correct caller never invokes runFlightJudge at all.
  if (flightSignalVerdict.tripped) {
    await runFlightJudge(
      { taskId: TASK_ID, goal: "g", acceptanceCriteria: CRITERIA, recentTurns: [] },
      INITIAL_FLIGHT_JUDGE_STATE,
      { maxInvocationsPerRun: 3 },
      deps,
    );
  }
  assert.equal(judgeInvoked, false, "no Layer-1 trip must mean no Layer-2 dispatch");
});
