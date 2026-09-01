import assert from "node:assert/strict";
import { test } from "node:test";
import { MountsError, validateMounts, type Mount, type Mounts } from "../src/lib/mounts.js";
import type { spawnWorker, WorkerResult } from "../src/lib/worker.js";
import {
  assessRisk,
  buildRiskJudgePrompt,
  buildRiskJudgeSpawnArgs,
  canonicalRiskJudgeInputKey,
  createInMemoryRiskJudgeCache,
  parseRiskJudgeVerdict,
  planRiskJudgeAction,
  realRiskJudge,
  resolveRiskJudgeMount,
  RISK_JUDGE_TOOLS,
  runRiskJudge,
  spawnRiskJudgeWorker,
  type RiskJudgeAction,
  type RiskJudgeConfig,
  type RiskJudgeInput,
  type RiskJudgeOrchestratorDeps,
  type RiskJudgeVerdict,
} from "../src/lib/risk-judge.js";

function baseInput(overrides: Partial<RiskJudgeInput> = {}): RiskJudgeInput {
  return {
    change: { description: "add a fuzzy-search helper to serve.ts", files: ["src/lib/serve.ts"] },
    gatesState: { lint: "pass", typecheck: "pass", tests: "pass" },
    planContext: { taskId: "W1-T900", planRefs: ["P34"] },
    ...overrides,
  };
}

function verdict(partial: Partial<RiskJudgeVerdict>): RiskJudgeVerdict {
  return { verdict: "low", reasons: ["well-trodden change, gates clean"], confidence: 0.9, ...partial };
}

// A minimal, VALID mounts table (mirrors test/mounts.test.ts's goodRaw()) — every risk
// cell is class → mount; `src` is the required default class.
function goodMountsRaw() {
  return {
    tiers: { haiku: 1, sonnet: 2, opus: 3 },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    judge: { model: "opus", effort: "high", max_turns: 60, context_budget: 150000 },
    synthesis: {
      retro: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
      triage: { model: "opus", effort: "low", max_turns: 60, context_budget: 180000 },
      inbox_draft: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    },
    routes: {
      implement: {
        low: { src: { model: "sonnet", effort: "medium", max_turns: 30, context_budget: 120000 } },
        high: { src: { model: "sonnet", effort: "high", max_turns: 50, context_budget: 180000 } },
      },
      recon: {
        low: { src: { model: "haiku", effort: "medium", max_turns: 20, context_budget: 60000 } },
      },
    },
  };
}

function goodMounts(): Mounts {
  return validateMounts(goodMountsRaw());
}

// ── Never the static risk: field, by construction ─────────────────────────

test("RiskJudgeInput carries no `risk` field anywhere — the static sizing artifact has nowhere to leak in", () => {
  const input = baseInput();
  assert.ok(!("risk" in input));
  assert.ok(!("risk" in input.change));
  assert.ok(!("risk" in input.planContext));
});

test("buildRiskJudgePrompt never mentions consulting a static risk: field, and instructs the judge NOT to", () => {
  const prompt = buildRiskJudgePrompt(baseInput());
  assert.match(prompt, /NEVER consult.*risk:/i);
  assert.match(prompt, /add a fuzzy-search helper to serve\.ts/);
  assert.match(prompt, /src\/lib\/serve\.ts/);
  assert.match(prompt, /lint/);
  assert.match(prompt, /W1-T900/);
  assert.match(prompt, /RISK_VERDICT:/);
  assert.match(prompt, /RISK_CONFIDENCE:/);
  assert.match(prompt, /RISK_REASON:/);
  assert.match(prompt, /OBSERVED/);
});

// ── parseRiskJudgeVerdict ───────────────────────────────────────────────

test("parseRiskJudgeVerdict parses a well-formed verdict, clamping confidence and collecting reasons", () => {
  const text = [
    "some prose the judge wrote",
    "RISK_VERDICT: high",
    "RISK_CONFIDENCE: 0.83",
    "RISK_REASON: touches auth middleware with no test coverage",
    "RISK_REASON: no precedent for this pattern in the codebase",
  ].join("\n");
  const v = parseRiskJudgeVerdict(text);
  assert.equal(v.verdict, "high");
  assert.equal(v.confidence, 0.83);
  assert.deepEqual(v.reasons, [
    "touches auth middleware with no test coverage",
    "no precedent for this pattern in the codebase",
  ]);
});

test("parseRiskJudgeVerdict clamps out-of-range confidence into [0,1]", () => {
  const over = parseRiskJudgeVerdict("RISK_VERDICT: low\nRISK_CONFIDENCE: 4.2");
  assert.equal(over.confidence, 1);
  const under = parseRiskJudgeVerdict("RISK_VERDICT: low\nRISK_CONFIDENCE: -1");
  assert.equal(under.confidence, 0);
});

test("parseRiskJudgeVerdict FAILS CLOSED (high, confidence 1) on unparseable output", () => {
  const v = parseRiskJudgeVerdict("not sure what to make of this diff, seems fine I guess");
  assert.equal(v.verdict, "high");
  assert.equal(v.confidence, 1);
  assert.ok(v.reasons.length > 0);
});

test("parseRiskJudgeVerdict FAILS CLOSED on an invalid verdict value", () => {
  const v = parseRiskJudgeVerdict("RISK_VERDICT: maybe\nRISK_CONFIDENCE: 0.9");
  assert.equal(v.verdict, "high");
});

test("parseRiskJudgeVerdict defaults confidence to 0 (never assumed) when absent", () => {
  const v = parseRiskJudgeVerdict("RISK_VERDICT: low");
  assert.equal(v.confidence, 0);
});

// ── acceptance 1: low + confident -> PROCEED; the static risk: field is never
// an input to this decision (planRiskJudgeAction takes no risk: parameter at all) ──

test("acceptance 1: a low-risk, high-confidence verdict PROCEEDS", () => {
  const action = planRiskJudgeAction(verdict({ verdict: "low", confidence: 0.95 }));
  assert.equal(action.kind, "proceed");
});

test("acceptance 1: planRiskJudgeAction takes only a verdict + config — no task.risk-shaped parameter exists to consult", () => {
  // planRiskJudgeAction(verdict, config = {}) — required params are verdict and an optional
  // config; neither is named/shaped like a task.risk field, so there is nowhere for one to enter.
  const action = planRiskJudgeAction(verdict({ verdict: "low", confidence: 0.9 }));
  assert.equal(action.kind, "proceed");
});

// ── acceptance 2: high-risk OR low-confidence -> ESCALATE, naming the OBSERVED
// blocker (W1-T186 emitter discipline), and never dispatches ──────────────

test("acceptance 2: a high-risk verdict ESCALATES even at high confidence, naming its own reasons", () => {
  const action = planRiskJudgeAction(
    verdict({ verdict: "high", confidence: 0.95, reasons: ["diff touches CI workflow files with no precedent"] }),
  );
  assert.equal(action.kind, "escalate");
  assert.match(action.reason, /diff touches CI workflow files with no precedent/);
});

test("acceptance 2: a LOW-risk but LOW-CONFIDENCE verdict ALSO escalates (confidence gates independently of verdict)", () => {
  const action = planRiskJudgeAction(
    verdict({ verdict: "low", confidence: 0.4, reasons: ["gates state was incomplete — no test run observed"] }),
  );
  assert.equal(action.kind, "escalate");
  assert.match(action.reason, /low-confidence/);
  assert.match(action.reason, /gates state was incomplete/);
});

test("acceptance 2: a low-risk, high-confidence verdict does NOT escalate", () => {
  const action = planRiskJudgeAction(verdict({ verdict: "low", confidence: 0.71 }));
  assert.equal(action.kind, "proceed");
});

test("acceptance 2: the confidence threshold is configurable", () => {
  const config: RiskJudgeConfig = { confidenceThreshold: 0.9 };
  const action = planRiskJudgeAction(verdict({ verdict: "low", confidence: 0.8 }), config);
  assert.equal(action.kind, "escalate");
});

// ── acceptance 3: judge-unavailable -> ESCALATE, never silent-proceed ─────

test("acceptance 3: assessRisk falls back to a fail-closed HIGH verdict when the judge spawn throws", async () => {
  const input = baseInput();
  const v = await assessRisk(input, {
    judge: async () => {
      throw new Error("spawn timed out after 400 turns");
    },
  });
  assert.equal(v.verdict, "high");
  assert.equal(v.confidence, 0);
  assert.match(v.reasons.join(" "), /judge unavailable/i);
  assert.match(v.reasons.join(" "), /spawn timed out after 400 turns/);
});

test("acceptance 3: runRiskJudge on judge-unavailable ESCALATES (never proceeds) and calls deps.escalate", async () => {
  const input = baseInput();
  const calls = { escalate: 0 };
  const deps: RiskJudgeOrchestratorDeps = {
    judge: async () => {
      throw new Error("no snapshot");
    },
    escalate: async () => {
      calls.escalate++;
      return "https://github.com/owner/repo/issues/42";
    },
  };
  const result = await runRiskJudge(input, deps);
  assert.equal(result.action.kind, "escalate");
  assert.notEqual(result.action.kind, "proceed");
  assert.equal(calls.escalate, 1);
  assert.equal(result.escalationUrl, "https://github.com/owner/repo/issues/42");
});

// ── acceptance 4: verdict + reasons + confidence ledgered VERBATIM per decision ──

test("acceptance 4: runRiskJudge ledgers verdict, reasons, AND confidence VERBATIM in one risk_judge.decision line", async () => {
  const input = baseInput();
  const log: { step: string; extra?: Record<string, unknown> }[] = [];
  const plantedVerdict = verdict({
    verdict: "high",
    confidence: 0.63,
    reasons: ["touches a migration path", "no reviewer pass yet observed"],
  });
  const deps: RiskJudgeOrchestratorDeps = {
    judge: async () => plantedVerdict,
    escalate: async () => "https://github.com/owner/repo/issues/7",
    log: (step, extra) => log.push({ step, extra }),
  };
  await runRiskJudge(input, deps);

  const decisionLine = log.find((l) => l.step === "risk_judge.decision");
  assert.ok(decisionLine, "a risk_judge.decision line must be ledgered");
  assert.equal(decisionLine!.extra?.verdict, "high");
  assert.deepEqual(decisionLine!.extra?.reasons, plantedVerdict.reasons);
  assert.equal(decisionLine!.extra?.confidence, 0.63);
});

test("acceptance 4: a PROCEED decision is ALSO ledgered verbatim (not just escalations)", async () => {
  const input = baseInput();
  const log: { step: string; extra?: Record<string, unknown> }[] = [];
  const plantedVerdict = verdict({ verdict: "low", confidence: 0.88, reasons: ["clean, well-trodden change"] });
  const deps: RiskJudgeOrchestratorDeps = {
    judge: async () => plantedVerdict,
    escalate: async () => {
      throw new Error("must not be called on a proceed decision");
    },
    log: (step, extra) => log.push({ step, extra }),
  };
  const result = await runRiskJudge(input, deps);
  assert.equal(result.action.kind, "proceed");
  const decisionLine = log.find((l) => l.step === "risk_judge.decision");
  assert.equal(decisionLine!.extra?.verdict, "low");
  assert.deepEqual(decisionLine!.extra?.reasons, plantedVerdict.reasons);
  assert.equal(decisionLine!.extra?.confidence, 0.88);
});

// ── W1-T970: the escalated row is sha-keyed — sweep.ts's priorActionsFromLedger reads
// pr_number/head_sha straight off THIS ledger line to build its riskRefused set. ────────

test("W1-T970: the escalated row carries the pr number and head sha", async () => {
  const input = baseInput({ prNumber: 970, headSha: "d00dfeed" });
  const log: { step: string; extra?: Record<string, unknown> }[] = [];
  const deps: RiskJudgeOrchestratorDeps = {
    judge: async () => verdict({ verdict: "high", confidence: 0.95 }),
    escalate: async () => "https://github.com/craigoley/remudero/issues/970",
    log: (step, extra) => log.push({ step, extra }),
  };
  await runRiskJudge(input, deps);

  const escalatedLine = log.find((l) => l.step === "risk_judge.escalated");
  assert.ok(escalatedLine, "a risk_judge.escalated line must be ledgered");
  assert.equal(escalatedLine!.extra?.pr_number, 970);
  assert.equal(escalatedLine!.extra?.head_sha, "d00dfeed");
  assert.equal(escalatedLine!.extra?.issue_url, "https://github.com/craigoley/remudero/issues/970");
});

test("W1-T970: an input with no identifiers supplied ledgers byte-identical to before — pr_number/head_sha are optional, never required", async () => {
  const log: { step: string; extra?: Record<string, unknown> }[] = [];
  const deps: RiskJudgeOrchestratorDeps = {
    judge: async () => verdict({ verdict: "high", confidence: 0.95 }),
    escalate: async () => "https://github.com/owner/repo/issues/1",
    log: (step, extra) => log.push({ step, extra }),
  };
  await runRiskJudge(baseInput(), deps);
  const escalatedLine = log.find((l) => l.step === "risk_judge.escalated");
  assert.deepEqual(Object.keys(escalatedLine!.extra ?? {}).sort(), ["issue_url"], "no pr_number/head_sha keys when the caller supplies none");
});

// ── acceptance 5: STABLE on unchanged input (W1-T178 doctrine) + cheapest
// (haiku-class) mount resolved from mounts.yaml (W1-T5) ───────────────────

test("acceptance 5: assessRisk is STABLE on unchanged input — a cached verdict survives even when the live judge would answer differently", async () => {
  const input = baseInput();
  const cache = createInMemoryRiskJudgeCache();
  let callCount = 0;
  const flappyJudge = async () => {
    callCount++;
    // Deliberately returns a DIFFERENT verdict each call — proving the SECOND
    // assessRisk call is served from the cache, not a fresh (flapped) judgment.
    return callCount === 1 ? verdict({ verdict: "low", confidence: 0.9 }) : verdict({ verdict: "high", confidence: 0.2 });
  };

  const first = await assessRisk(input, { judge: flappyJudge, cache });
  const second = await assessRisk(input, { judge: flappyJudge, cache });

  assert.deepEqual(first, second);
  assert.equal(callCount, 1, "the underlying judge must be invoked only ONCE for unchanged input");
});

test("acceptance 5: a DIFFERENT candidate change is judged fresh (the cache key is input-specific, not global)", async () => {
  const cache = createInMemoryRiskJudgeCache();
  let callCount = 0;
  const judge = async () => {
    callCount++;
    return verdict({ verdict: "low", confidence: 0.9 });
  };
  await assessRisk(baseInput(), { judge, cache });
  await assessRisk(baseInput({ change: { description: "a completely different change" } }), { judge, cache });
  assert.equal(callCount, 2);
});

test("acceptance 5: canonicalRiskJudgeInputKey is stable across key-insertion order (object identity doesn't matter, content does)", () => {
  const a: RiskJudgeInput = {
    change: { description: "x", files: ["a.ts", "b.ts"] },
    gatesState: { lint: "pass", tests: "pass" },
    planContext: { taskId: "T1" },
  };
  const b: RiskJudgeInput = {
    planContext: { taskId: "T1" },
    gatesState: { tests: "pass", lint: "pass" },
    change: { files: ["a.ts", "b.ts"], description: "x" },
  };
  assert.equal(canonicalRiskJudgeInputKey(a), canonicalRiskJudgeInputKey(b));
});

test("acceptance 5: resolveRiskJudgeMount resolves the CHEAPEST (haiku-class) tier configured in mounts.yaml, not a hardcoded literal", () => {
  const mounts = goodMounts();
  const mount = resolveRiskJudgeMount(mounts);
  assert.equal(mount.model, "haiku");
  assert.deepEqual(mount, { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 });
});

test("acceptance 5: resolveRiskJudgeMount is STABLE — the same table resolves to the identical mount every time", () => {
  const mounts = goodMounts();
  const a = resolveRiskJudgeMount(mounts);
  const b = resolveRiskJudgeMount(mounts);
  assert.deepEqual(a, b);
});

test("acceptance 5: resolveRiskJudgeMount also works against the SHIPPED .remudero/mounts.yaml table", async () => {
  const { loadMounts, mountsPath } = await import("../src/lib/mounts.js");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const shipped = loadMounts(mountsPath(repoRoot));
  const mount = resolveRiskJudgeMount(shipped);
  // The shipped table's cheapest configured tier is haiku (mounts.yaml's own `tiers` ordering).
  assert.equal(mount.model, "haiku");
});

// ── acceptance 6: REUSABLE — {change, gatesState, planContext} -> {verdict,
// reasons, confidence}, no dispatch-only coupling ─────────────────────────

test("acceptance 6: assessRisk's return shape is EXACTLY {verdict, reasons, confidence} — no dispatch-only fields leak in", async () => {
  const result = await assessRisk(baseInput(), { judge: async () => verdict({}) });
  assert.deepEqual(Object.keys(result).sort(), ["confidence", "reasons", "verdict"]);
});

test("acceptance 6: assessRisk is callable with ONLY {change, gatesState, planContext} + a judge dep — a P28-shaped caller needs nothing dispatch-specific", async () => {
  // Simulates a hypothetical P28 caller: no escalate.ts, no ledger, no run-task.ts
  // concept anywhere in reach — just the reusable organ.
  const p28Input: RiskJudgeInput = {
    change: { description: "graduate an auto-ratified plan clause", files: ["plan/tasks.yaml"] },
    gatesState: { planLint: "pass" },
    planContext: { planRefs: ["P28"] },
  };
  const result = await assessRisk(p28Input, { judge: async () => verdict({ verdict: "low", confidence: 0.9 }) });
  assert.equal(result.verdict, "low");
});

// ── runRiskJudge: escalate is called on escalate, never on proceed ────────

test("runRiskJudge never calls deps.escalate on a proceed decision", async () => {
  const calls = { escalate: 0 };
  const deps: RiskJudgeOrchestratorDeps = {
    judge: async () => verdict({ verdict: "low", confidence: 0.9 }),
    escalate: async () => {
      calls.escalate++;
      return "unused";
    },
  };
  const result = await runRiskJudge(baseInput(), deps);
  assert.equal(result.action.kind, "proceed");
  assert.equal(calls.escalate, 0);
  assert.equal(result.escalationUrl, undefined);
});

test("runRiskJudge accepts a synchronous deps.escalate (mirrors escalate.ts's own sync signature)", async () => {
  const deps: RiskJudgeOrchestratorDeps = {
    judge: async () => verdict({ verdict: "high", confidence: 0.9 }),
    escalate: () => "https://github.com/owner/repo/issues/99",
  };
  const result = await runRiskJudge(baseInput(), deps);
  assert.equal(result.escalationUrl, "https://github.com/owner/repo/issues/99");
});

// ── the real spawn args: cheapest mount, empty tool list ──────────────────

test("buildRiskJudgeSpawnArgs carries an EMPTY tool list — the judge cannot write/edit, by construction", () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const args = buildRiskJudgeSpawnArgs({ input: baseInput(), mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json" });
  assert.equal(args.tools, RISK_JUDGE_TOOLS);
  assert.equal((args.tools ?? []).length, 0);
  assert.equal(args.model, "haiku");
  assert.equal(args.effort, "medium");
  assert.equal(args.maxTurns, 20);
});

// ── resolveRiskJudgeMount: fail-closed on an empty routing table ──────────

test("resolveRiskJudgeMount throws MountsError when the routing table defines no routes at all — never silently returns an undefined mount", () => {
  const empty: Mounts = {
    tiers: { haiku: 1 },
    efforts: { medium: 1 },
    architect: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1 },
    judge: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1 },
    synthesis: {
      retro: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1 },
      triage: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1 },
      inbox_draft: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1 },
    },
    routes: {},
  };
  assert.throws(() => resolveRiskJudgeMount(empty), MountsError);
  assert.throws(() => resolveRiskJudgeMount(empty), /no worker mount found in mounts\.yaml routes/);
});

// ── spawnRiskJudgeWorker / realRiskJudge: the real-spawn wiring, injected ─

function fakeWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s-risk-judge",
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

test("spawnRiskJudgeWorker calls the injected spawn with buildRiskJudgeSpawnArgs' own output and returns its result verbatim", async () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const input = baseInput();
  const calls: unknown[] = [];
  const fakeText = "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.95\nRISK_REASON: routine, well-trodden change";
  const spawn = (async (args: unknown) => {
    calls.push(args);
    return fakeWorkerResult(fakeText);
  }) as typeof spawnWorker;

  const outcome = await spawnRiskJudgeWorker({ input, mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });

  assert.equal(calls.length, 1, "spawnRiskJudgeWorker must call the injected spawn exactly once");
  assert.deepEqual(calls[0], buildRiskJudgeSpawnArgs({ input, mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json" }));
  assert.equal(outcome.text, fakeText, "the raw WorkerResult is returned untouched — parsing happens one layer up");
});

test("realRiskJudge wires spawnRiskJudgeWorker's result through parseRiskJudgeVerdict — the production judge fn", async () => {
  const mount: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };
  const spawnCalls: unknown[] = [];
  const spawn = (async (args: unknown) => {
    spawnCalls.push(args);
    return fakeWorkerResult("RISK_VERDICT: high\nRISK_CONFIDENCE: 0.8\nRISK_REASON: touches an unreviewed area");
  }) as typeof spawnWorker;

  const judge = realRiskJudge({ mount, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  const verdictOut = await judge(baseInput());

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(verdictOut, {
    verdict: "high",
    confidence: 0.8,
    reasons: ["touches an unreviewed area"],
  });
});
