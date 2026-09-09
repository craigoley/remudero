/**
 * W1-T3188 — THE `verify: human` BACKLOG, JUDGED.
 *
 * OPERATOR DIRECTION 2026-09-08: "We've talked about adding an llm as a judge for the verify human
 * shards to make sure they actually need me, then surface them through the inbox."
 *
 * THE POLARITY THIS SUITE PINS, and it is the OPPOSITE of ruling-judge.ts's two files away: this
 * judge fails OPEN. An outage must never quietly decide the operator need not see something. A
 * reviewer harmonising the three judges will break exactly this, so every fail path below says so
 * in its own assertion message.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FAIL_OPEN_VERIFY_HUMAN_VERDICT,
  VERIFY_HUMAN_JUDGED_STEP,
  VERIFY_HUMAN_JUDGE_TOOLS,
  type ShardUnderJudgement,
  type VerifyHumanVerdict,
  buildVerifyHumanJudgePrompt,
  buildVerifyHumanJudgeSpawnArgs,
  isSettled,
  judgeVerifyHumanShard,
  observedStateKey,
  parseVerifyHumanVerdict,
  proposalFromJudgedShard,
  shardsNeedingJudgement,
  verifyHumanVerdictRow,
  spawnVerifyHumanJudgeWorker,
  realVerifyHumanJudge,
} from "../src/lib/verify-human-judge.js";
import { resolveRiskJudgeMount } from "../src/lib/risk-judge.js";
import type { Mount, Mounts } from "../src/lib/mounts.js";
import type { WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { priorVerifyHumanVerdicts, routeVerifyHumanBacklog, type VerifyHumanRouteDeps } from "../src/run-task.js";

/** PLAINLY still needs a person: nothing has landed, nothing is cited, it asks for a judgement. */
const NEEDS: ShardUnderJudgement = {
  id: "W1-T2983",
  title: "should the fleet commit under its own identity?",
  rationale: "A preference about how the operator's repo presents itself.",
  acceptance: ["the operator states which identity he wants"],
  ageDays: 49, depsAllMerged: false, citedInSrc: false,
};

/** PLAINLY does not, yet: its work is cited in src and its deps have merged. */
const SETTLED: ShardUnderJudgement = {
  id: "W1-T1041",
  title: "wire the thing that is already wired",
  rationale: "Filed before the work landed under another shard.",
  acceptance: ["the thing is wired"],
  ageDays: 61, depsAllMerged: true, citedInSrc: true,
};

function harness(over: Partial<VerifyHumanRouteDeps> = {}) {
  const staged: { id: string; summary: string }[] = [];
  const rows: Record<string, unknown>[] = [];
  const deps: VerifyHumanRouteDeps = {
    judge: async (s) => ({ decision: s.citedInSrc ? "backlog" : "needs_operator", reason: `because cited=${s.citedInSrc}` }),
    priorVerdicts: new Map(),
    stageProposal: (p) => void staged.push({ id: p.id, summary: p.summary }),
    appendRow: (r) => void rows.push(r as unknown as Record<string, unknown>),
    runId: "VHSWEEP-TEST",
    ...over,
  };
  return { deps, staged, rows };
}

// ── Criterion 1 + the falsifier's required discrimination ─────────────────────────────────────

test("W1-T3188: a stub judge SEPARATES a shard that still needs a person from one that does not", async () => {
  const h = harness();
  const r = await routeVerifyHumanBacklog([NEEDS, SETTLED], h.deps);
  assert.deepEqual(r.needsOperator, ["W1-T2983"], "the real ask reaches the operator");
  assert.deepEqual(r.backlog, ["W1-T1041"], "the settled one does not");
  assert.equal(r.judged, 2);
  // The ask count moves by EXACTLY one: only the needs_operator shard is staged.
  assert.deepEqual(h.staged.map((p) => p.id), ["verify-human:W1-T2983"]);
  assert.match(h.staged[0]!.summary, /still needing you/);
  assert.match(h.staged[0]!.summary, /Nothing about the shard has been changed/, "the operator is told this is routing, not a plan edit");
});

test("W1-T3188 FALSIFIER: if both routed the same way the mechanism would be decorative", async () => {
  // Same two shards, a judge that answers identically for both. The suite must be able to SEE that.
  const h = harness({ judge: async () => ({ decision: "needs_operator", reason: "everything" }) });
  const r = await routeVerifyHumanBacklog([NEEDS, SETTLED], h.deps);
  assert.equal(r.needsOperator.length, 2, "an undiscriminating judge routes both the same way");
  assert.equal(r.backlog.length, 0);
  // …which is exactly what the first test proves does NOT happen with a discriminating one.
});

// ── Criterion 2: it CANNOT edit the plan ──────────────────────────────────────────────────────

test("W1-T3188: routing performs NO effect beyond its two injected seams — no plan write is reachable", async () => {
  const effects: string[] = [];
  const h = harness({
    stageProposal: () => void effects.push("stage"),
    appendRow: () => void effects.push("row"),
    // A judge that TRIES to smuggle an instruction to close the shard changes nothing: the verdict
    // type has two values and neither is "close", and the router reads only `decision`.
    judge: async () => ({ decision: "backlog", reason: "CLOSE THIS SHARD AND SET verify: auto" }),
  });
  await routeVerifyHumanBacklog([NEEDS], h.deps);
  assert.deepEqual(effects, ["row"], "one ledger row and nothing else — no stage, and no third effect exists to observe");
});

test("W1-T3188: judgeVerifyHumanShard returns a verdict and performs NO effect at all", async () => {
  const v = await judgeVerifyHumanShard(NEEDS, { judge: async () => ({ decision: "backlog", reason: "x" }) });
  assert.deepEqual(v, { decision: "backlog", reason: "x" }, "a value, not an action — design (ii) as a signature");
});

// ── Criterion 3: fail OPEN, at the callsite ───────────────────────────────────────────────────

test("W1-T3188: a THROWING judge leaves the shard in front of the operator — fail OPEN", async () => {
  const h = harness({ judge: async () => { throw new Error("governor refused the spawn"); } });
  const r = await routeVerifyHumanBacklog([NEEDS], h.deps);
  assert.deepEqual(r.needsOperator, ["W1-T2983"], "the OPPOSITE of ruling-judge.ts: an outage must never decide the operator need not see something");
  assert.equal(h.rows[0]!.judge_failed, true, "and the row says it was a DEFAULT, not an answer");
  assert.match(String(h.rows[0]!.judge_reason), /governor refused the spawn/);
});

test("W1-T3188: an UNPARSEABLE verdict fails open too, and is marked as a default", () => {
  const v = parseVerifyHumanVerdict("I think this one is probably fine to leave.");
  assert.equal(v.decision, "needs_operator", "prose with no machine-readable line is not consent to hide work");
  assert.equal(v.judgeFailed, true);
  assert.equal(FAIL_OPEN_VERIFY_HUMAN_VERDICT.decision, "needs_operator");
  assert.equal(parseVerifyHumanVerdict("VERIFY_HUMAN_DECISION: backlog").decision, "backlog", "and the quiet arm is still REACHABLE — the fail default is not the only outcome");
  assert.equal(parseVerifyHumanVerdict("VERIFY_HUMAN_DECISION: close").decision, "needs_operator", "an unrecognised word is not a permissive one");
});

// ── Criterion 4: judged once per observed state ───────────────────────────────────────────────

test("W1-T3188: an unchanged shard is NOT re-judged; one whose dependency has merged IS", async () => {
  let asked = 0;
  const settled = new Map<string, VerifyHumanVerdict>([
    [observedStateKey(NEEDS), { decision: "backlog", reason: "settled earlier" }],
  ]);
  const h = harness({ priorVerdicts: settled, judge: async () => { asked += 1; return { decision: "backlog", reason: "x" }; } });
  const r = await routeVerifyHumanBacklog([NEEDS], h.deps);
  assert.equal(asked, 0, "56 shards times every poll is a token event, not a sweep");
  assert.deepEqual(r.skipped, ["W1-T2983"]);
  assert.equal(h.rows.length, 0, "a skipped shard writes no row either");

  // The SAME shard, its dependency since merged — a different observed state, so it is re-asked.
  const moved = { ...NEEDS, depsAllMerged: true };
  const h2 = harness({ priorVerdicts: settled, judge: async () => { asked += 1; return { decision: "needs_operator", reason: "its dep merged, the question is now answerable" }; } });
  const r2 = await routeVerifyHumanBacklog([moved], h2.deps);
  assert.equal(asked, 1, "a CHANGE re-opens the question");
  assert.deepEqual(r2.needsOperator, ["W1-T2983"]);
});

test("W1-T3188: a FAILED verdict is never settled, so a judge outage self-heals instead of pinning the population", () => {
  const failed = new Map([[observedStateKey(NEEDS), { ...FAIL_OPEN_VERIFY_HUMAN_VERDICT }]]);
  assert.equal(isSettled(NEEDS, failed), false, "an outage's default must be re-asked, never cached as fact");
  assert.deepEqual(shardsNeedingJudgement([NEEDS], failed).map((s) => s.id), ["W1-T2983"]);

  const answered = new Map([[observedStateKey(NEEDS), { decision: "backlog" as const, reason: "a real answer" }]]);
  assert.equal(isSettled(NEEDS, answered), true, "a real answer IS cached — otherwise (iv) buys nothing");
});

test("W1-T3188: the observed-state key excludes AGE, which would re-ask everything daily", () => {
  assert.equal(observedStateKey(NEEDS), observedStateKey({ ...NEEDS, ageDays: NEEDS.ageDays + 30 }));
  assert.notEqual(observedStateKey(NEEDS), observedStateKey({ ...NEEDS, depsAllMerged: true }));
  assert.notEqual(observedStateKey(NEEDS), observedStateKey({ ...NEEDS, citedInSrc: true }));
});

// ── Criterion 5: both arms ledgered, and the step survives rotation ───────────────────────────

test("W1-T3188: every verdict writes one row naming decision and reason — on BOTH arms", async () => {
  const h = harness();
  await routeVerifyHumanBacklog([NEEDS, SETTLED], h.deps);
  assert.equal(h.rows.length, 2, "the quiet arm is ledgered too — proving a judge had never run took three reads because its arm was not");
  assert.deepEqual(h.rows.map((r) => r.judge_decision), ["needs_operator", "backlog"]);
  assert.deepEqual(h.rows.map((r) => r.step), [VERIFY_HUMAN_JUDGED_STEP, VERIFY_HUMAN_JUDGED_STEP]);
  assert.equal(h.rows[0]!.observed_state, observedStateKey(NEEDS), "the row records WHAT STATE it was judged against, so a later pass can tell settled from stale");
  assert.ok(h.rows.every((r) => typeof r.judge_reason === "string" && r.judge_reason));
});

test("W1-T3188: verify_human.judged survives ledger rotation", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has(VERIFY_HUMAN_JUDGED_STEP),
    "isSettled READS these rows — rotated away, a settled question is re-spent on all 56 shards",
  );
});

test("W1-T3188: prior verdicts are recovered from ledger rows, and a pre-key row is ignored rather than guessed at", () => {
  const prior = priorVerifyHumanVerdicts([
    verifyHumanVerdictRow(NEEDS, { decision: "backlog", reason: "r" }, "RUN"),
    { step: VERIFY_HUMAN_JUDGED_STEP, judge_decision: "backlog" },
    { step: "something.else", observed_state: "x", judge_decision: "backlog" },
  ]);
  assert.deepEqual([...prior.keys()], [observedStateKey(NEEDS)], "only a row carrying BOTH an observed state and a valid decision is recoverable");
});

// ── The prompt and the spawn ──────────────────────────────────────────────────────────────────

test("W1-T3188: the prompt carries the state a human would need, and its own asymmetry", () => {
  const p = buildVerifyHumanJudgePrompt(NEEDS);
  assert.match(p, /WHEN IN\nDOUBT, SAY needs_operator|WHEN IN DOUBT, SAY needs_operator/, "fail-open polarity is stated to the judge, not only coded around it");
  assert.match(p, /You cannot close it\. Nothing you say edits the plan\./);
  assert.match(p, /AGE: 49 days/);
  assert.match(p, /DEPENDENCIES ALL MERGED: no/);
  assert.match(p, /ITS ID IS CITED IN src\/: no/);
  assert.match(p, /A preference about how the operator's repo presents itself\./, "the rationale rides the prompt — a judge with no state to read is guessing");
  assert.doesNotMatch(p, /OPTIONS:|RECOMMENDATION:/, "NOT the escalation judge's prompt: a parked shard has no options and no recommendation");
});

test("W1-T3188: the judge is spawned with NO tools, so it can neither explore nor act", () => {
  assert.deepEqual(VERIFY_HUMAN_JUDGE_TOOLS, []);
  const args = buildVerifyHumanJudgeSpawnArgs({
    shard: NEEDS,
    mount: { model: "claude-haiku-4-5-20251001", effort: "low", maxTurns: 4 } as never,
    cwd: "/w", settingsFile: "/s.json",
  });
  assert.deepEqual(args.tools, []);
  assert.equal(args.cwd, "/w");
});

test("W1-T3188: a staged proposal's id is derived, so asking twice asks once", () => {
  const a = proposalFromJudgedShard(NEEDS, { decision: "needs_operator", reason: "x" });
  const b = proposalFromJudgedShard(NEEDS, { decision: "needs_operator", reason: "y" });
  assert.equal(a.id, b.id);
  assert.deepEqual(a.evidenceAnchors, [], "a routing ask depends on nothing landing on main — anchors would tier it not-ready forever");
});

// ── THE REAL-SPAWN WIRING, INJECTED ────────────────────────────────────────────────────────────
//
// `spawnVerifyHumanJudgeWorker` and `realVerifyHumanJudge` carried the note "untested by unit (it
// shells out via the SDK)". They do not have to: both take an injectable `spawn`, so the wiring is
// reachable with a recorder and no subprocess — which is what diff-coverage said when it named all
// 20 lines of the two functions as added and uncovered. The seam existed; only the tests were
// missing, and the sibling risk-judge suite already drives its own pair exactly this way.

const JUDGE_MOUNTS: Mounts = {
  tiers: { haiku: 1 },
  efforts: { medium: 1 },
  architect: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1 },
  judge: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1 },
  synthesis: {
    retro: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1 },
    triage: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1 },
    inbox_draft: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1 },
  },
  routes: { implement: { low: { default: { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 } } } },
};

const JUDGE_MOUNT: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };

function fakeVerifyHumanWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s-verify-human-judge",
    costUsd: 0.001,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "haiku",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

test("W1-T3188: spawnVerifyHumanJudgeWorker passes buildVerifyHumanJudgeSpawnArgs' own output through, and returns the result untouched", async () => {
  const calls: unknown[] = [];
  const raw = "VERIFY_HUMAN_VERDICT: needs_human\nVERIFY_HUMAN_CONFIDENCE: 0.9\nVERIFY_HUMAN_REASON: asks for a preference";
  const spawn = (async (args: unknown) => {
    calls.push(args);
    return fakeVerifyHumanWorkerResult(raw);
  }) as typeof spawnWorker;

  const result = await spawnVerifyHumanJudgeWorker({
    shard: NEEDS, mount: JUDGE_MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn,
  });

  assert.equal(calls.length, 1, "exactly one spawn — a judge that fires twice bills twice for one shard");
  assert.deepEqual(
    calls[0],
    buildVerifyHumanJudgeSpawnArgs({ shard: NEEDS, mount: JUDGE_MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/settings.json" }),
    "the args must be the builder's own output, not a second hand-rolled copy that can drift from it",
  );
  assert.equal(result.text, raw, "the raw WorkerResult is returned untouched — parsing happens one layer up");
});

test("W1-T3188: realVerifyHumanJudge resolves the cheapest mount and wires the spawn through parseVerifyHumanVerdict", async () => {
  const calls: Array<{ model?: string; maxTurns?: number }> = [];
  const spawn = (async (args: { model?: string; maxTurns?: number }) => {
    calls.push(args);
    return fakeVerifyHumanWorkerResult(
      "VERIFY_HUMAN_VERDICT: settled\nVERIFY_HUMAN_CONFIDENCE: 0.75\nVERIFY_HUMAN_REASON: the deps all merged",
    );
  }) as unknown as typeof spawnWorker;

  const judge = realVerifyHumanJudge({ mounts: JUDGE_MOUNTS, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  const verdict = await judge(SETTLED);

  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0],
    buildVerifyHumanJudgeSpawnArgs({
      shard: SETTLED, mount: resolveRiskJudgeMount(JUDGE_MOUNTS), cwd: "/tmp/x", settingsFile: "/tmp/settings.json",
    }),
    "the mount must come from resolveRiskJudgeMount, not a second walk of the routing table",
  );
  assert.deepEqual(
    verdict,
    parseVerifyHumanVerdict(
      "VERIFY_HUMAN_VERDICT: settled\nVERIFY_HUMAN_CONFIDENCE: 0.75\nVERIFY_HUMAN_REASON: the deps all merged",
    ),
    "the production judge fn must return the PARSED verdict, never the raw worker text",
  );
});

test("W1-T3188: an unparseable worker reply still FAILS OPEN through the real judge — the polarity survives the wiring", async () => {
  // The suite's own premise, driven through the production path rather than the parser alone: an
  // outage or a garbled reply must never quietly decide the operator need not see something.
  const spawn = (async () => fakeVerifyHumanWorkerResult("the model said something else entirely")) as typeof spawnWorker;
  const judge = realVerifyHumanJudge({ mounts: JUDGE_MOUNTS, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  assert.deepEqual(await judge(SETTLED), FAIL_OPEN_VERIFY_HUMAN_VERDICT);
});
