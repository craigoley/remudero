import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test, { type TestContext } from "node:test";
import {
  FIX_ROUTING_LEARNER, fixArmEvidence, fixRoutingWeights, type FixLearnedArms, type FixRoutingCandidate,
} from "#src/lib/fix-routing-learner.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { writeProviderRoutingPolicyOverride } from "#src/lib/provider-routing-policy.js";
import type { ProviderCapacity } from "#src/lib/worker-provider.js";
import {
  createClaudeExecutableCache,
  spawnWorker,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "#src/lib/worker.js";
import { gitWorkTreeAncestor } from "#src/lib/worker-home.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14297. DECIDED by the operator on 2026-11-22 (routing option A): Claude is kept for reviews, and balanced
// builds and fixes prefer Codex. The committed table adds `balanced: codex` under provider_preference; the reviewer
// keeps Claude through role_preference, which the router applies first. The fix-routing learner used to stand aside
// whenever the AUCTION's preference was not automatic, so the new row would have switched it off for every fix; it
// now stands aside only for the operator's own preference or a live task experiment, and under a serving preference
// it ranks only the preferred provider's models. Every test runs the real spawnWorker; only the capacity reads and
// the provider calls are stubbed.

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const COMMITTED = readFileSync(mountsPath(REPO_ROOT), "utf8");
const BALANCED_ROW = "    balanced: codex\n";
/** The committed table without the new row: origin/main's preferences, everything else as committed. */
const WITHOUT_ROW = COMMITTED.replace(BALANCED_ROW, "");

type Role = "reviewer" | "implementer" | "fixer";
type Row = Record<string, unknown>;

interface Run {
  role: Role;
  taskId: string;
  model?: string;
  effort?: string;
  claudeUsed?: number;
  codexUsed?: number;
  claude?: ProviderCapacity;
  codex?: ProviderCapacity;
  /** The model the Codex read serves unless the learner asks for another. */
  served?: string;
  excludeProviders?: SpawnWorkerArgs["excludeProviders"];
  /** Fix-lane evidence: present, the spawn carries the learner's arms as runFixRung passes them. */
  evidence?: Row[];
}

interface Routed {
  assignment: WorkerSelectionAssignment;
  decisions: Row[];
  asked: string[];
  weighed: FixRoutingCandidate[][];
}

function capacity(provider: "claude" | "codex", usedPercent: number, model?: string): ProviderCapacity {
  return {
    provider,
    readable: true,
    windows: [{ name: `${provider} weekly`, usedPercent, resetsAt: NOW / 1000 + 30 * 3600 }],
    ...(model ? { model, effort: "high" } : {}),
  };
}

/** `accepted` clean and `refused` commit_refused fix rounds for one arm. */
function arm(provider: "claude" | "codex", model: string, accepted: number, refused: number): Row[] {
  const row = (subtype: string) => ({ ts: new Date(NOW).toISOString(), task_id: "W1-T1", step: "fix.done", subtype, provider, selected_model: model });
  return [...Array.from({ length: accepted }, () => row("success")), ...Array.from({ length: refused }, () => row("commit_refused"))];
}

/** Fix-lane evidence favouring Claude: the learner's own mix would send most balanced fixes to Claude. */
const FAVOURS_CLAUDE = [...arm("claude", "claude-sonnet-5-5", 900, 100), ...arm("codex", "gpt-6.2-sol", 300, 700)];
/** Fix-lane evidence favouring Codex: the learner's own mix would send some frontier fixes to Codex. */
const FAVOURS_CODEX = [...arm("claude", "claude-opus-5-5", 300, 700), ...arm("codex", "gpt-6.2-sol", 900, 100)];

/** A checkout with no mounts file routes by the committed table; one with `raw` routes by that table. */
function checkout(t: TestContext, raw?: string): string {
  const root = ownedFixtureDir(t, "rmd-option-a-").dir;
  assert.equal(gitWorkTreeAncestor(root), undefined, "the fixture checkout must sit outside every Git work tree");
  if (raw !== undefined) {
    mkdirSync(dirname(mountsPath(root)), { recursive: true });
    writeFileSync(mountsPath(root), raw);
  }
  return root;
}

function codexResult(): WorkerResult {
  return {
    provider: "codex", sessionId: "codex-session", costUsd: 0, numTurns: 1, text: "done", blocks: ["done"], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "gpt-6.2-sol",
    effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    compactionConfigured: false, compactionFailures: [], qualitySuspect: false, servedModel: null, servedModelReason: "none",
  };
}

function config(root: string) {
  return {
    claudeBin: "/unused",
    root,
    workerProviders: { enabled: ["claude", "codex"], codexBin: "/unused/codex", reservePercent: 5, capacityCacheMs: 60_000 },
  } as NonNullable<SpawnWorkerArgs["config"]>;
}

/** Route one spawn the way its lane does: the reviewer runs in the disposable review sandbox, a fixer carries the arms. */
async function route(root: string, run: Run): Promise<Routed> {
  const assignments: WorkerSelectionAssignment[] = [];
  const decisions: Row[] = [];
  const asked: string[] = [];
  const weighed: FixRoutingCandidate[][] = [];
  const evidence = run.evidence ? fixArmEvidence(run.evidence, NOW) : undefined;
  const learnedArms: FixLearnedArms | undefined = evidence && {
    evidence,
    weigh: (candidates, seed) => {
      weighed.push(candidates.map((candidate) => ({ ...candidate })));
      return fixRoutingWeights(evidence, candidates, seed);
    },
    onDecision: (fields) => decisions.push(fields),
  };
  const result = await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions" as const,
    settingsFile: `${REPO_ROOT}/settings/worker.json`,
    prompt: `${run.role} work`,
    model: run.model ?? "sonnet",
    effort: run.effort ?? "medium",
    taskId: run.taskId,
    runId: `run-${run.taskId}-2`,
    ...(run.role === "reviewer" ? { tools: ["Read", "Grep", "Glob"], sandboxIntent: "disposable-review" as const } : {}),
    ...(run.role === "fixer" ? { workerClass: "fix" as const } : {}),
    ...(run.excludeProviders ? { excludeProviders: run.excludeProviders } : {}),
    config: config(root),
    providerRouting: {
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
      readClaude: async () => run.claude ?? capacity("claude", run.claudeUsed ?? 10),
      readCodex: async (_config, request) => {
        if (request.preferredModel?.model) asked.push(request.preferredModel.model);
        return run.codex ?? capacity("codex", run.codexUsed ?? 50, request.preferredModel?.model ?? run.served ?? "gpt-6.2-sol");
      },
      spawnCodex: async () => codexResult(),
      writeStatus: () => undefined,
      now: () => NOW,
      ...(learnedArms ? { learnedArms } : {}),
    },
    onSelectionAssignment: (assignment) => assignments.push(assignment),
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" }, home: root, exists: () => true, which: () => "/fake/claude", canExecute: () => true, locations: [] },
    },
    keychain: {
      platform: "linux" as const,
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 } }),
    },
    queryFn: (() => (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", total_cost_usd: 0, num_turns: 1 };
    })()) as never,
  });
  const assignment = assignments.at(-1);
  assert.ok(assignment, "every spawn records its assignment before the provider call");
  assert.equal(result.provider, assignment.selected.provider, "the worker ran on the provider its row names");
  if (learnedArms) assert.equal(decisions.length, 1, "one fix.routing_decision row per fix spawn");
  return { assignment, decisions, asked, weighed };
}

function tasks(count: number, from = 14_297): string[] {
  return Array.from({ length: count }, (_, index) => `W1-T${from + index}`);
}

/** What a routing decision is: the provider, the rule, the odds and the recorded preference. Row ids are random. */
function decided(assignment: WorkerSelectionAssignment) {
  return {
    provider: assignment.selected.provider,
    model: assignment.selected.model,
    rule: assignment.routing.decision?.rule,
    ab: assignment.routing.decision?.ab,
    propensity: assignment.routing.propensity,
    experiment: assignment.routing.experiment,
    policy: assignment.routing.policy,
    preferenceBypass: assignment.routing.preferenceBypass,
    rolePreference: assignment.routing.rolePreference,
    capabilityPreference: assignment.routing.capabilityPreference,
  };
}

function odds(assignment: WorkerSelectionAssignment, provider: "claude" | "codex"): number | "unavailable" | undefined {
  return assignment.routing.propensity?.candidates.find((candidate) => candidate.provider === provider)?.probability;
}

test("W1-T14297 criterion 1: the committed table prefers Codex for balanced builds and fixes, Claude for the reviewer and for frontier work", async (t) => {
  assert.ok(COMMITTED.includes(`  provider_preference:\n    frontier: claude\n${BALANCED_ROW}`), "the row sits under provider_preference");
  const table = loadMounts(mountsPath(REPO_ROOT)).capabilities;
  assert.deepEqual(table?.providerPreference, { frontier: "claude", balanced: "codex", economy: "claude" });
  assert.deepEqual(table?.rolePreference, { reviewer: "claude" }, "the reviewer row is unchanged");

  const committed = checkout(t);
  const before = checkout(t, WITHOUT_ROW);
  const beforeProviders = new Set<string>();
  // Claude holds far more headroom (90% against 50%), so the headroom auction alone would send it most of the work.
  for (const taskId of tasks(8)) {
    for (const role of ["implementer", "fixer"] as const) {
      const run = { role, taskId, ...(role === "fixer" ? { evidence: FAVOURS_CLAUDE } : {}) };
      const { assignment } = await route(committed, run);
      assert.equal(assignment.selected.provider, "codex", `${role} ${taskId}`);
      assert.equal(assignment.routing.decision?.rule, "capability-preference", `${role} ${taskId}`);
      assert.deepEqual(assignment.routing.capabilityPreference, { capability: "balanced", provider: "codex" });
      assert.equal(assignment.routing.preferenceBypass, undefined);
      assert.equal(assignment.routing.policy.preference, "automatic", "the row keeps the operator's own policy");
      assert.equal(odds(assignment, "codex"), 1);
      assert.equal(odds(assignment, "claude"), 0);

      // On origin/main's table the same spawn is a headroom auction.
      const was = (await route(before, run)).assignment;
      assert.equal(was.routing.decision?.rule, "headroom-auction", `${role} ${taskId} on origin/main's table`);
      assert.equal(was.routing.capabilityPreference, undefined);
      beforeProviders.add(was.selected.provider);
    }
    const reviewer = (await route(committed, { role: "reviewer", taskId })).assignment;
    assert.equal(reviewer.selected.provider, "claude", `reviewer ${taskId}`);
    assert.equal(reviewer.routing.decision?.rule, "role-preference");
    assert.deepEqual(reviewer.routing.rolePreference, { role: "reviewer", provider: "claude" });
    const frontier = (await route(committed, { role: "implementer", taskId, model: "opus" })).assignment;
    assert.equal(frontier.selected.provider, "claude", `frontier ${taskId}`);
    assert.equal(frontier.routing.decision?.rule, "capability-preference");
    assert.deepEqual(frontier.routing.capabilityPreference, { capability: "frontier", provider: "claude" });
  }
  assert.ok(beforeProviders.has("claude"), "on origin/main's table the auction gave Claude some of the balanced work");
});

test("W1-T14297 criterion 1: a balanced build leaves the live experiment it joined on origin/main's table", async (t) => {
  // sol61-vs-sonnet55 enrols a balanced high-effort spawn only while the auction is automatic.
  const committed = checkout(t);
  const before = checkout(t, WITHOUT_ROW);
  const run = { role: "implementer" as const, taskId: "W1-T14297", effort: "high", served: "gpt-6.1-sol", claudeUsed: 40, codexUsed: 40 };
  const was = (await route(before, run)).assignment;
  assert.equal(was.routing.decision?.ab, "sol61-vs-sonnet55", "on origin/main's table the build joins the experiment");
  assert.ok(was.routing.experiment, "and records its intention-to-treat row");
  const is = (await route(committed, run)).assignment;
  assert.equal(is.routing.decision?.rule, "capability-preference");
  assert.equal(is.routing.decision?.ab, undefined, "under the row the build joins no experiment");
  assert.equal(is.routing.experiment, undefined, "and records no assigned arm, so no crossover");
  // The reviewer keeps recording the arm its task drew.
  const review = (await route(committed, { ...run, role: "reviewer" })).assignment;
  assert.equal(review.routing.decision?.ab, "sol61-vs-sonnet55");
});

test("W1-T14297 criterion 2: a balanced build or fix returns to today's auction when Codex is below its reserve, unreadable or excluded", async (t) => {
  const committed = checkout(t);
  const before = checkout(t, WITHOUT_ROW);
  const unreadable: ProviderCapacity = { provider: "codex", readable: false, windows: [], detail: "usage read failed" };
  const cases: Array<{ name: string; run: Partial<Run>; reason: string }> = [
    { name: "below reserve", run: { codexUsed: 97 }, reason: "below-reserve" },
    { name: "unreadable", run: { codex: unreadable }, reason: "unreadable" },
    { name: "excluded", run: { excludeProviders: ["codex"] }, reason: "unreadable" },
  ];
  for (const { name, run, reason } of cases) {
    for (const role of ["implementer", "fixer"] as const) {
      for (const taskId of tasks(3)) {
        const full = { role, taskId, claudeUsed: 40, ...run, ...(role === "fixer" ? { evidence: FAVOURS_CODEX } : {}) };
        const is = await route(committed, full);
        const was = await route(before, full);
        assert.equal(is.assignment.selected.provider, "claude", `${name} ${role} ${taskId}`);
        assert.equal(is.assignment.routing.decision?.rule, "preference-bypassed", `${name} ${role}`);
        assert.deepEqual(is.assignment.routing.preferenceBypass, { provider: "codex", reason }, `${name} ${role}`);
        assert.deepEqual(is.assignment.routing.capabilityPreference, { capability: "balanced", provider: "codex" },
          "the row names the bypassed capability preference");
        // Today's auction: the same provider and the same odds as on origin/main's table.
        assert.equal(is.assignment.selected.provider, was.assignment.selected.provider);
        assert.deepEqual(is.assignment.routing.propensity?.candidates, was.assignment.routing.propensity?.candidates, `${name} ${role} odds`);
        if (role === "fixer") {
          assert.equal(is.decisions[0]?.applied, true, `${name}: the learner's auction runs once the preference is bypassed`);
          assert.equal(is.assignment.routing.decision?.learner, FIX_ROUTING_LEARNER);
        }
      }
    }
  }
});

test("W1-T14297 criterion 2: an operator's own routing policy still wins over the row", async (t) => {
  const root = checkout(t);
  // The pre-reset override the operator set on 2026-11-21: prefer Claude.
  writeProviderRoutingPolicyOverride(root, {
    enabledProviders: ["claude", "codex"], preference: "claude", reservePercent: 5, parks: [],
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
  }, { config: config(root), writerFingerprint: "unknown", now: () => NOW });
  for (const taskId of tasks(4)) {
    for (const role of ["implementer", "fixer"] as const) {
      const { assignment, decisions } = await route(root, { role, taskId, claudeUsed: 60, codexUsed: 5, ...(role === "fixer" ? { evidence: FAVOURS_CODEX } : {}) });
      assert.equal(assignment.selected.provider, "claude", `${role} ${taskId}`);
      assert.equal(assignment.routing.decision?.rule, "operator-preference");
      assert.equal(assignment.routing.policy.preference, "claude");
      assert.equal(assignment.routing.capabilityPreference, undefined, "the row does not apply under an operator preference");
      if (role === "fixer") assert.deepEqual(decisions[0], { learner: FIX_ROUTING_LEARNER, applied: false, reason: "operator-preference" });
    }
  }
});

test("W1-T14297 criterion 3: a balanced fix whose evidence favours Claude goes to Codex at p=1, and the learner still applies", async (t) => {
  const root = checkout(t);
  for (const taskId of tasks(6)) {
    const { assignment, decisions, weighed } = await route(root, { role: "fixer", taskId, evidence: FAVOURS_CLAUDE });
    assert.equal(decisions[0]?.applied, true, `${taskId}: the learner is not stood aside by a capability preference`);
    assert.equal(decisions[0]?.reason, undefined);
    assert.equal(assignment.selected.provider, "codex", taskId);
    assert.equal(assignment.routing.decision?.rule, "capability-preference");
    assert.deepEqual(assignment.routing.capabilityPreference, { capability: "balanced", provider: "codex" });
    assert.equal(assignment.routing.decision?.learner, FIX_ROUTING_LEARNER);
    assert.equal(odds(assignment, "codex"), 1, "the preferred provider holds the whole share");
    for (const candidates of weighed) {
      assert.deepEqual(candidates.map((candidate) => candidate.provider), candidates.map(() => "codex"), "only Codex arms are weighed");
    }
    const shared = ((decisions[0]?.arms ?? []) as Row[]).filter((entry) => entry.p_final !== null);
    assert.deepEqual(shared.map((entry) => [entry.provider, entry.p_final]), [["codex", 1]], "only the served Codex arm holds a share");
  }
});

test("W1-T14297 criterion 3: under the preference the learner still ranks the mounted Codex models ahead of the served one", async (t) => {
  const root = checkout(t);
  // The read fell back to gpt-6.1-sol; the row's lead gpt-6.2-sol out-scores it, so the learner re-reads the lead.
  const evidence = [...arm("claude", "claude-sonnet-5-5", 900, 100), ...arm("codex", "gpt-6.2-sol", 990, 10), ...arm("codex", "gpt-6.1-sol", 300, 700)];
  const { assignment, decisions, asked } = await route(root, { role: "fixer", taskId: "W1-T14297", served: "gpt-6.1-sol", evidence });
  assert.deepEqual(asked, ["gpt-6.2-sol"]);
  assert.equal(assignment.selected.provider, "codex");
  assert.equal(assignment.selected.model, "gpt-6.2-sol");
  assert.equal(decisions[0]?.selected_model, "gpt-6.2-sol");
  assert.equal(assignment.routing.decision?.rule, "capability-preference");
});

test("W1-T14297 criterion 3: a frontier step-up fix whose evidence favours Codex goes to Claude at p=1, as on origin/main", async (t) => {
  const root = checkout(t);
  for (const taskId of tasks(6)) {
    const run = { role: "fixer" as const, taskId, model: "opus" };
    const learned = await route(root, { ...run, evidence: FAVOURS_CODEX });
    // Without the arms the spawn takes the router's unchanged preference path: origin/main's provider, rule and odds.
    const plain = await route(root, run);
    assert.equal(learned.decisions[0]?.applied, true, `${taskId}: the learner applies under the frontier preference`);
    assert.equal(learned.assignment.selected.provider, "claude", taskId);
    assert.equal(odds(learned.assignment, "claude"), 1);
    assert.equal(odds(learned.assignment, "codex"), 0);
    assert.deepEqual(learned.asked, [], "a Claude preference re-reads no Codex model");
    for (const candidates of learned.weighed) {
      assert.deepEqual(candidates.map((candidate) => candidate.provider), candidates.map(() => "claude"), "only the Claude arm is weighed");
    }
    assert.deepEqual(decided(learned.assignment), decided(plain.assignment), `${taskId}: the same provider, rule, odds and preference`);
  }
});

test("W1-T14297 criterion 3: the learner's mixed auction runs when the preference is absent, and stands aside for a live task experiment", async (t) => {
  const before = checkout(t, WITHOUT_ROW);
  const { decisions, assignment } = await route(before, { role: "fixer", taskId: "W1-T14297", evidence: FAVOURS_CLAUDE, claudeUsed: 40, codexUsed: 40 });
  assert.equal(decisions[0]?.applied, true);
  assert.equal(assignment.routing.decision?.rule, "headroom-auction");
  const drawn = ((decisions[0]?.arms ?? []) as Row[]).filter((entry) => entry.draw !== null);
  assert.deepEqual(drawn.map((entry) => entry.provider).sort(), ["claude", "codex"], "both providers' served arms are weighed");
  for (const entry of drawn) assert.ok(typeof entry.p_final === "number" && entry.p_final > 0, `${String(entry.provider)} holds a share`);

  // A balanced high-effort fix in a live experiment keeps its task-keyed arm: the learner stands aside, as today.
  const experiment = await route(before, { role: "fixer", taskId: "W1-T14297", effort: "high", served: "gpt-6.1-sol", evidence: FAVOURS_CLAUDE, claudeUsed: 40, codexUsed: 40 });
  assert.deepEqual(experiment.decisions[0], { learner: FIX_ROUTING_LEARNER, applied: false, reason: "live-routing-experiment" });
});

test("W1-T14297 criterion 4: reviews, frontier work and economy work route exactly as on origin/main's table", async (t) => {
  const committed = checkout(t);
  const before = checkout(t, WITHOUT_ROW);
  // Without the row the table holds origin/main's preferences, so the comparison below is against origin/main's routing.
  const baseline = loadMounts(mountsPath(before)).capabilities;
  assert.deepEqual(baseline?.providerPreference, { frontier: "claude", economy: "claude" }, "origin/main's capability preference");
  assert.deepEqual(baseline?.rolePreference, { reviewer: "claude" }, "origin/main's role preference");
  // And the rule origin/main gives each of them while both subscriptions have headroom.
  for (const [run, provider, rule] of [
    [{ role: "reviewer" as const }, "claude", "role-preference"],
    [{ role: "implementer" as const, model: "opus" }, "claude", "capability-preference"],
    // W1-T15178: economy prefers Claude while Claude has headroom.
    [{ role: "implementer" as const, model: "haiku" }, "claude", "capability-preference"],
  ] as const) {
    const { assignment } = await route(committed, { ...run, taskId: "W1-T14297", claudeUsed: 10, codexUsed: 50 });
    assert.equal(assignment.routing.decision?.rule, rule, JSON.stringify(run));
    if (provider) assert.equal(assignment.selected.provider, provider, JSON.stringify(run));
  }
  // Capacities production emits: both with headroom either way round, one below its reserve, one unreadable.
  const unreadable = (provider: "claude" | "codex"): ProviderCapacity => ({ provider, readable: false, windows: [], detail: "usage read failed" });
  const readings: Array<Partial<Run>> = [
    { claudeUsed: 10, codexUsed: 50 }, { claudeUsed: 55, codexUsed: 30 }, { claudeUsed: 97, codexUsed: 40 },
    { claudeUsed: 40, codexUsed: 97 }, { claude: unreadable("claude"), codexUsed: 40 }, { claudeUsed: 40, codex: unreadable("codex") },
  ];
  const spawns: Array<{ name: string; run: Partial<Run> & { role: Role } }> = [
    { name: "reviewer", run: { role: "reviewer", effort: "high", served: "gpt-6.1-sol" } },
    { name: "frontier", run: { role: "implementer", model: "opus" } },
    { name: "economy", run: { role: "implementer", model: "haiku" } },
  ];
  let compared = 0;
  for (const reading of readings) {
    for (const { name, run } of spawns) {
      for (const taskId of tasks(4)) {
        const full = { ...run, ...reading, taskId };
        assert.deepEqual(decided((await route(committed, full)).assignment), decided((await route(before, full)).assignment),
          `${name} ${taskId} ${JSON.stringify(reading)}`);
        compared += 1;
      }
    }
  }
  assert.equal(compared, readings.length * spawns.length * 4, "every reading was routed for every spawn kind");
});
