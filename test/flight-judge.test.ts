import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import type { Mount } from "../src/lib/mounts.js";
import {
  buildFlightJudgeSpawnArgs,
  buildJudgePrompt,
  extractJudgeTurnEvidence,
  INITIAL_FLIGHT_JUDGE_STATE,
  JUDGE_TOOLS,
  parseJudgeVerdict,
  planJudgeAction,
  runFlightJudge,
  type ControllerAction,
  type FlightJudgeConfig,
  type FlightJudgeDeps,
  type FlightJudgeState,
  type JudgeInput,
  type JudgeTurnEvidence,
  type JudgeVerdict,
} from "../src/lib/flight-judge.js";

const CRITERIA: AcceptanceCriterion[] = [{ claim: "does the thing", proof: "test/thing.test.ts passes" }];

function baseInput(recentTurns: JudgeTurnEvidence[]): JudgeInput {
  return { taskId: "W1-Txx", goal: "implement the thing", acceptanceCriteria: CRITERIA, recentTurns };
}

const DEFAULT_CONFIG: FlightJudgeConfig = { maxInvocationsPerRun: 3 };

// ── extractJudgeTurnEvidence: never the worker's reasoning ────────────────

test("extractJudgeTurnEvidence keeps tool_use calls and tool_result content, and DROPS assistant text blocks", () => {
  const raw = [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I think I should try editing this file because..." },
          { type: "tool_use", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "edit applied" }],
      },
    },
  ];
  const turns = extractJudgeTurnEvidence(raw);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turn, 1);
  assert.deepEqual(turns[0].toolCalls, [
    { name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } },
  ]);
  assert.deepEqual(turns[0].toolResults, ["edit applied"]);
  // No field anywhere on the turn carries the dropped "text" reasoning block.
  assert.equal(JSON.stringify(turns).includes("I think I should"), false);
});

test("extractJudgeTurnEvidence: multiple turns, tool_result content stringified when non-string", () => {
  const raw = [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: { ok: false, code: 1 } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] } },
  ];
  const turns = extractJudgeTurnEvidence(raw);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].toolResults[0], JSON.stringify({ ok: false, code: 1 }));
  assert.deepEqual(turns[1].toolResults, []);
});

// ── buildJudgePrompt: carries goal/criteria/turns, no tool grant implied ───

test("buildJudgePrompt includes the goal, task id, criteria, and turn evidence", () => {
  const input = baseInput([{ turn: 1, toolCalls: [{ name: "Edit", input: { file_path: "a.ts" } }], toolResults: ["ok"] }]);
  const prompt = buildJudgePrompt(input);
  assert.match(prompt, /W1-Txx/);
  assert.match(prompt, /implement the thing/);
  assert.match(prompt, /does the thing/);
  assert.match(prompt, /test\/thing\.test\.ts passes/);
  assert.match(prompt, /Edit/);
  assert.match(prompt, /JUDGE_STATE:/);
  assert.match(prompt, /JUDGE_RECOMMENDATION:/);
  assert.match(prompt, /JUDGE_CONFIDENCE:/);
  assert.match(prompt, /NO tools/);
});

// ── parseJudgeVerdict ───────────────────────────────────────────────────

test("parseJudgeVerdict parses a well-formed verdict, clamping confidence and collecting evidence", () => {
  const text = [
    "some prose the judge wrote",
    "JUDGE_STATE: spiraling",
    "JUDGE_RECOMMENDATION: halt_and_diagnose",
    "JUDGE_CONFIDENCE: 0.92",
    "JUDGE_EVIDENCE: same edit reverted at turns 2, 4, 6, 8",
    "JUDGE_EVIDENCE: no new file ever touched",
  ].join("\n");
  const v = parseJudgeVerdict(text);
  assert.equal(v.state, "spiraling");
  assert.equal(v.recommendation, "halt_and_diagnose");
  assert.equal(v.confidence, 0.92);
  assert.deepEqual(v.evidence, ["same edit reverted at turns 2, 4, 6, 8", "no new file ever touched"]);
});

test("parseJudgeVerdict clamps an out-of-range confidence into [0,1]", () => {
  const over = parseJudgeVerdict("JUDGE_STATE: productive\nJUDGE_RECOMMENDATION: continue\nJUDGE_CONFIDENCE: 4.2");
  assert.equal(over.confidence, 1);
  const under = parseJudgeVerdict("JUDGE_STATE: productive\nJUDGE_RECOMMENDATION: continue\nJUDGE_CONFIDENCE: -1");
  assert.equal(under.confidence, 0);
});

test("parseJudgeVerdict FAILS CLOSED (off_track/escalate) on unparseable output", () => {
  const v = parseJudgeVerdict("the worker seems to be doing... something? not sure.");
  assert.equal(v.state, "off_track");
  assert.equal(v.recommendation, "escalate");
  assert.equal(v.confidence, 1);
  assert.ok(v.evidence.length > 0);
});

test("parseJudgeVerdict FAILS CLOSED on an invalid state/recommendation value", () => {
  const v = parseJudgeVerdict("JUDGE_STATE: confused\nJUDGE_RECOMMENDATION: continue\nJUDGE_CONFIDENCE: 0.5");
  assert.equal(v.state, "off_track");
  assert.equal(v.recommendation, "escalate");
});

// ── planJudgeAction: the deterministic controller (pure — no LLM inside) ──

function verdict(partial: Partial<JudgeVerdict>): JudgeVerdict {
  return { state: "productive", evidence: [], recommendation: "continue", confidence: 0.5, ...partial };
}

test("acceptance: spiraling + high confidence -> HALT and dispatch DIAGNOSE (never a third blind patch)", () => {
  const action = planJudgeAction(
    INITIAL_FLIGHT_JUDGE_STATE,
    verdict({ state: "spiraling", recommendation: "halt_and_diagnose", confidence: 0.9 }),
    DEFAULT_CONFIG,
  );
  assert.equal(action.kind, "halt_and_diagnose");
});

test("spiraling at LOW confidence does not force a halt by itself (defers to recommendation)", () => {
  const action = planJudgeAction(
    INITIAL_FLIGHT_JUDGE_STATE,
    verdict({ state: "spiraling", recommendation: "nudge", confidence: 0.2 }),
    DEFAULT_CONFIG,
  );
  assert.equal(action.kind, "continue");
});

test("acceptance: off_track -> HALT and escalate", () => {
  const action = planJudgeAction(INITIAL_FLIGHT_JUDGE_STATE, verdict({ state: "off_track" }), DEFAULT_CONFIG);
  assert.equal(action.kind, "halt_and_escalate");
});

test("acceptance: converging -> raise the tripped threshold ONCE, then plain continue after that", () => {
  const first = planJudgeAction(INITIAL_FLIGHT_JUDGE_STATE, verdict({ state: "converging" }), DEFAULT_CONFIG);
  assert.equal(first.kind, "raise_threshold_and_continue");
  assert.equal(first.state.thresholdRaised, true);

  const second = planJudgeAction(first.state, verdict({ state: "converging" }), DEFAULT_CONFIG);
  assert.equal(second.kind, "continue");
  assert.equal(second.state.thresholdRaised, true);
});

test("acceptance: the Kth invocation MUST decide — a deferring verdict at the K-cap is forced to halt_and_escalate", () => {
  const config: FlightJudgeConfig = { maxInvocationsPerRun: 2 };
  const deferring = verdict({ state: "productive", recommendation: "continue", confidence: 0.3 });
  const first = planJudgeAction(INITIAL_FLIGHT_JUDGE_STATE, deferring, config);
  assert.equal(first.kind, "continue");
  assert.equal(first.state.invocations, 1);

  const second = planJudgeAction(first.state, deferring, config); // invocation 2 == K
  assert.equal(second.kind, "halt_and_escalate");
  assert.equal(second.state.invocations, 2);
});

test("the K-cap also forces a decision when the natural action is 'converging' (not just plain continue)", () => {
  const config: FlightJudgeConfig = { maxInvocationsPerRun: 1 };
  const action = planJudgeAction(INITIAL_FLIGHT_JUDGE_STATE, verdict({ state: "converging" }), config);
  assert.equal(action.kind, "halt_and_escalate");
});

test("a judge recommendation of halt_and_diagnose/escalate is honored outside the three named states", () => {
  const diag = planJudgeAction(
    INITIAL_FLIGHT_JUDGE_STATE,
    verdict({ state: "blocked", recommendation: "halt_and_diagnose", confidence: 0.4 }),
    DEFAULT_CONFIG,
  );
  assert.equal(diag.kind, "halt_and_diagnose");

  const esc = planJudgeAction(
    INITIAL_FLIGHT_JUDGE_STATE,
    verdict({ state: "blocked", recommendation: "escalate", confidence: 0.4 }),
    DEFAULT_CONFIG,
  );
  assert.equal(esc.kind, "halt_and_escalate");
});

// ── runFlightJudge: the DI orchestrator (fixture-injected judge, per design —
// L2 judgment is an LLM call, so tests inject the verdict a real spawn would
// have produced, exactly as review.ts's reviewer "semantic" verdicts are
// fixture-injected rather than derived from a live model) ─────────────────

function collectingDeps(judgeVerdict: JudgeVerdict): {
  deps: FlightJudgeDeps;
  log: { step: string; extra?: Record<string, unknown> }[];
  calls: { diagnose: number; escalate: number };
} {
  const log: { step: string; extra?: Record<string, unknown> }[] = [];
  const calls = { diagnose: 0, escalate: 0 };
  const deps: FlightJudgeDeps = {
    judge: async () => judgeVerdict,
    diagnose: async () => {
      calls.diagnose++;
      return { text: "root cause: the same edit was reapplied and reverted repeatedly" };
    },
    escalate: async () => {
      calls.escalate++;
      return "https://github.com/owner/repo/issues/1";
    },
    log: (step, extra) => log.push({ step, extra }),
  };
  return { deps, log, calls };
}

test("acceptance 1: a PLANTED spiraling transcript (same edit reverted 4x) -> judge state=spiraling -> controller HALTS + dispatches diagnose, never a third blind patch", async () => {
  // The planted transcript: the identical Edit issued and reverted across 8 turns.
  const editCall = { name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } };
  const revertCall = { name: "Edit", input: { file_path: "a.ts", old_string: "y", new_string: "x" } };
  const revertedTranscript: JudgeTurnEvidence[] = Array.from({ length: 8 }, (_, i) => ({
    turn: i + 1,
    toolCalls: [i % 2 === 0 ? editCall : revertCall],
    toolResults: ["ok"],
  }));
  const input = baseInput(revertedTranscript);

  // Simulates what a real fresh-context judge would return for this pattern
  // (parseJudgeVerdict is exercised separately above; here we drive the
  // controller with the verdict such a judge would have produced).
  const { deps, log, calls } = collectingDeps(
    verdict({
      state: "spiraling",
      recommendation: "halt_and_diagnose",
      confidence: 0.92,
      evidence: ["the same Edit on a.ts was applied and reverted 4 times across turns 1-8"],
    }),
  );

  const result = await runFlightJudge(input, INITIAL_FLIGHT_JUDGE_STATE, DEFAULT_CONFIG, deps);

  assert.equal(result.verdict.state, "spiraling");
  assert.equal(result.action.kind, "halt_and_diagnose");
  assert.equal(result.diagnosed, true);
  assert.equal(calls.diagnose, 1);
  assert.equal(calls.escalate, 0); // off_track path never touched
  // "a diagnose dispatch in the ledger" — the log carries a diagnose-dispatched line.
  assert.ok(log.some((l) => l.step === "flight_judge.diagnose_dispatched"));
  // "never a third blind patch": this module exposes NO patch/attempt dependency
  // at all — FlightJudgeDeps has only judge/diagnose/escalate/log, so there is
  // structurally no code path here that could apply a third edit.
  assert.deepEqual(Object.keys(deps).sort(), ["diagnose", "escalate", "judge", "log"]);
});

test("acceptance 2: a healthy slow (converging) transcript is NOT halted — threshold raised once, run continues", async () => {
  const growingTranscript: JudgeTurnEvidence[] = Array.from({ length: 6 }, (_, i) => ({
    turn: i + 1,
    toolCalls: [{ name: "Edit", input: { file_path: `f${i}.ts` } }],
    toolResults: ["ok"],
  }));
  const input = baseInput(growingTranscript);
  const { deps, log, calls } = collectingDeps(
    verdict({ state: "converging", recommendation: "continue", confidence: 0.55, evidence: ["slow but steady progress"] }),
  );

  const first = await runFlightJudge(input, INITIAL_FLIGHT_JUDGE_STATE, DEFAULT_CONFIG, deps);
  assert.equal(first.action.kind, "raise_threshold_and_continue");
  assert.equal(first.diagnosed, false);
  assert.equal(calls.diagnose, 0);
  assert.equal(calls.escalate, 0);
  assert.ok(!log.some((l) => l.step.includes("diagnose")));
  assert.ok(!log.some((l) => l.step.includes("escalate")));

  const second = await runFlightJudge(input, first.state, DEFAULT_CONFIG, deps);
  assert.equal(second.action.kind, "continue");
  assert.equal(calls.diagnose, 0);
  assert.equal(calls.escalate, 0);
});

test("runFlightJudge on halt_and_escalate calls deps.escalate and records the issue url", async () => {
  const input = baseInput([]);
  const { deps, calls } = collectingDeps(verdict({ state: "off_track" }));
  const result = await runFlightJudge(input, INITIAL_FLIGHT_JUDGE_STATE, DEFAULT_CONFIG, deps);
  assert.equal(result.action.kind, "halt_and_escalate");
  assert.equal(result.escalationUrl, "https://github.com/owner/repo/issues/1");
  assert.equal(calls.escalate, 1);
  assert.equal(calls.diagnose, 0);
});

// ── acceptance 4: read-only + K-cap ────────────────────────────────────────

test("acceptance 4a: the judge's spawn args carry an EMPTY tool list — no write tool is reachable", () => {
  const input = baseInput([]);
  const mount: Mount = { model: "opus", effort: "high", maxTurns: 400, contextBudget: 150000 };
  const args = buildFlightJudgeSpawnArgs({ input, mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json" });
  const tools = args.tools ?? [];
  assert.equal(tools.length, 0);
  assert.equal(args.tools, JUDGE_TOOLS);
  for (const forbidden of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) {
    assert.ok(!tools.includes(forbidden), `judge tools must not include ${forbidden}`);
  }
});

test("acceptance 4b: a run that would exceed K forces a decision on the Kth call, not another deferral", async () => {
  const config: FlightJudgeConfig = { maxInvocationsPerRun: 3 };
  const input = baseInput([]);
  const { deps, calls } = collectingDeps(
    verdict({ state: "productive", recommendation: "continue", confidence: 0.3 }),
  );

  let state: FlightJudgeState = INITIAL_FLIGHT_JUDGE_STATE;
  const actions: ControllerAction["kind"][] = [];
  for (let i = 0; i < 3; i++) {
    const result = await runFlightJudge(input, state, config, deps);
    actions.push(result.action.kind);
    state = result.state;
  }
  assert.deepEqual(actions, ["continue", "continue", "halt_and_escalate"]);
  assert.equal(state.invocations, 3);
  assert.equal(calls.escalate, 1); // the forced Kth decision actually escalated
  assert.equal(calls.diagnose, 0);
});
