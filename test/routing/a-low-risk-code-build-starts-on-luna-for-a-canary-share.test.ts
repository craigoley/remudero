import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { ProbeExecResult } from "#src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "#src/lib/isolation.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import {
  DEFAULT_LUNA_BUILD_CANARY_POLICY,
  decideLunaBuildCanary,
  lunaBuildCanaryArmFor,
  lunaBuildCanaryEligible,
  lunaBuildCanaryPolicy,
  lunaBuildCanaryStopReason,
  readLunaBuildCanaryRows,
  summarizeLunaBuildCanary,
} from "#src/lib/luna-build-canary.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { writeProviderRoutingPolicyOverride } from "#src/lib/provider-routing-policy.js";
import type { GitHub } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs, type WorkerResult,
  type WorkerSelectionAssignment } from "#src/lib/worker.js";
import * as codex from "#src/lib/worker-provider.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { runTask } from "#test/helpers/run-task-test.js";

// W1-T14549: a randomized share of risk:low src builds starts its FIRST implement attempt on Luna (the Codex economy
// tier below the sonnet mount); retries, the step-up and review route as on main, and the arm holds itself on evidence.

type Row = Record<string, unknown>;
const LUNA = "gpt-6-luna";
const SOL = "gpt-6.2-sol";
const capabilities = loadMounts(mountsPath(REPO_ROOT)).capabilities!;
const NOW = Date.parse("2026-11-23T12:00:00Z");
const CANDIDATES = [LUNA, SOL].map(id => ({ id, supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }));
const policy = DEFAULT_LUNA_BUILD_CANARY_POLICY;

/** A task id whose canary draw at `share` is `arm`. */
function taskInArm(arm: "luna" | "control", share = policy.sharePercent): string {
  for (let i = 0; i < 400; i++) if (lunaBuildCanaryArmFor(`T-LUNA-${i}`, share) === arm) return `T-LUNA-${i}`;
  throw new Error(`no task id in 400 draws lands in ${arm}`);
}

// ── The worker auction ──────────────────────────────────────────────────────────────────────────

function checkout(t: TestContext): Config {
  const root = ownedFixtureDir(t, "luna-build-canary").dir;
  return { root, claudeBin: "/unused", workerProviders: { enabled: ["claude", "codex"], codexBin: "/unused/codex",
    reservePercent: 5 } } as Config;
}

function result(provider: "codex" | "claude", model: string): WorkerResult {
  return { provider, model, routedModel: model, servedModel: model, effort: "medium", subtype: "success", isError: false,
    sessionId: "fixture", costUsd: 0, numTurns: 1, text: "done", blocks: [], stderr: "", apiError: false,
    permissionDenials: [], childEnvKeys: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

async function route(config: Config, options: { economyFirst?: boolean; economy?: "healthy" | "exhausted" | "unreadable";
  draw?: number }) {
  const starts: string[] = [];
  const assignments: WorkerSelectionAssignment[] = [];
  const routing: NonNullable<SpawnWorkerArgs["providerRouting"]> = {
    now: () => NOW, draw: options.draw ?? 0, writeStatus: () => {},
    readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: NOW }),
    readClaude: async () => ({ provider: "claude", readable: true,
      windows: [{ name: "weekly", usedPercent: 5, resetsAt: NOW / 1000 + 3600 }] }),
    readCodex: async (_config, request) => {
      const economy = request.codexCapability === "economy" ? options.economy ?? "healthy" : "healthy";
      const rateLimits = economy === "unreadable" ? undefined : { primary: { usedPercent: economy === "healthy" ? 60 : 99 } };
      return codex.selectCodexModel(CANDIDATES, { rateLimits }, config, request.requestedModel, request.requestedEffort,
        request.capabilities, { codexCapability: request.codexCapability, preferredModel: request.preferredModel,
          reservePercent: request.reservePercent, headroomTiming: request.headroomTiming,
          ...(request.economyReason ? { economyReason: request.economyReason } : {}) });
    },
    spawnCodex: async (_args, _config, selection) => result("codex", selection!.model!),
  };
  await spawnWorker({
    cwd: config.root, settingsFile: join(REPO_ROOT, "settings/worker.json"), permissionMode: "bypassPermissions",
    model: "sonnet", effort: "medium", prompt: "build this task", config, providerRouting: routing,
    ...(options.economyFirst ? { economyFirst: { codexCapability: "economy" as const, reason: "build-economy-first" as const,
      onDecision: (reason: string) => starts.push(reason) } } : {}),
    onSelectionAssignment: (assignment) => assignments.push(assignment),
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: { env: { RMD_CLAUDE_BIN: "/fake/claude" },
      home: config.root, exists: () => true, which: () => "/fake/claude", canExecute: () => true, locations: [] } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub",
      expiresAt: 4_102_444_800_000 } }) },
    queryFn: (() => (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "fixture",
        total_cost_usd: 0, num_turns: 1 };
    })()) as never,
  });
  assert.equal(assignments.length, 1);
  return { assignment: assignments[0]!, selected: assignments[0]!.selected, starts };
}

// ── The real dispatch ───────────────────────────────────────────────────────────────────────────

const OFFLINE_GITHUB: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
const HOLDING_CONTAINMENT = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });
const CLEAN_ISOLATION = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

function workerResult(text: string, failed = false): WorkerResult {
  return {
    sessionId: "s", costUsd: 0, numTurns: 0, text, blocks: [], stderr: "", subtype: failed ? "error_during_execution" : "success",
    isError: failed, apiError: false, permissionDenials: [], childEnvKeys: [], model: failed ? LUNA : "default", servedModel: failed ? LUNA : undefined,
    effort: "default", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, ...(failed ? { selectionAssignmentId: "ASSIGN-LUNA-1" } : {}),
  };
}

const RECON = "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n";

/** One real `runTask` dispatch over a seeded ledger. The fake spawn answers each economy start as `economy-first`. */
async function dispatch(taskId: string, over: { risk?: string; files?: string; canary?: Record<string, unknown>;
  failFirstImplement?: boolean; seed?: Row[] } = {}): Promise<{ spawns: SpawnWorkerArgs[]; rows: Row[] }> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}luna-canary-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, [`- id: ${taskId}`, "  title: luna build canary probe", "  repo: remudero", "  type: implement",
    "  verify: auto", `  risk: ${over.risk ?? "low"}`, `  files: [${over.files ?? "src/lib/thing.ts"}]`, "  origin: architect",
    "  status: queued", ""].join("\n"));
  const origin = gitRepo({ bare: true, kind: "luna-canary-origin" });
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "luna-canary-seed" });
  writeFileSync(join(clone.dir, "README.md"), "seed\n");
  clone.git("add", "-A");
  clone.git("commit", "-q", "-m", "seed");
  clone.git("push", "-q", "origin", "main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "luna-canary@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "luna-canary"]);
  mkdirSync(join(root, "state"), { recursive: true });
  const ledger = writeLedger(over.seed ?? [], { dir: join(root, "state") });
  const spawns: SpawnWorkerArgs[] = [];
  const spawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    spawns.push(args);
    if (spawns.length === 1) return workerResult(RECON);
    args.economyFirst?.onDecision?.("economy-first");
    return workerResult("REPORT\nno PR opened yet\n", over.failFirstImplement === true && spawns.length === 2);
  };
  try {
    await withLiveWritesAllowed(() => runTask(taskId, {
      skipGitSync: true, planPath, github: OFFLINE_GITHUB, spawn, containmentExec: HOLDING_CONTAINMENT, isolationExec: CLEAN_ISOLATION,
      config: { claudeBin: "/bin/true", root, installRoot: process.cwd(), dailyCapUsd: 25,
        workerProviders: { enabled: ["claude", "codex"], ...(over.canary ? { lunaBuildCanary: over.canary } : {}) } } as Config,
    }));
    const rows = readFileSync(ledger.path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
    return { spawns, rows };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const canaryRows = (rows: Row[]) => rows.filter((row) => row.step === "implement.luna_canary");

// ── Criteria ────────────────────────────────────────────────────────────────────────────────────

test("W1-T14549 criterion 1: a Luna-arm build's first attempt starts on Codex gpt-6-luna and keeps the sonnet request", async t => {
  const config = checkout(t);
  const baseline = await route(config, {});
  assert.equal(baseline.selected.provider, "claude", "at base the same capacities and draw select Claude");
  const first = await route(config, { economyFirst: true });
  assert.deepEqual(first.selected, { provider: "codex", model: LUNA, effort: "medium" });
  assert.equal(first.assignment.requested.model, "sonnet");
  assert.equal(first.assignment.routing.decision?.rule, "build-economy-first");
  const decision = first.assignment.candidates.find(candidate => candidate.provider === "codex")?.modelDecision;
  assert.equal(decision?.requestedCapability, "economy");
  assert.deepEqual(decision?.capabilityOverride, { from: "balanced", reason: "build-economy-first" });
  assert.deepEqual(first.starts, ["economy-first"]);

  const { spawns, rows } = await dispatch(taskInArm("luna"));
  const implement = spawns[1]!;
  assert.equal(implement.model, "sonnet", "the spawn still requests the mount's model");
  assert.equal(implement.economyFirst?.codexCapability, "economy");
  assert.equal(implement.economyFirst?.reason, "build-economy-first");
  const [row] = canaryRows(rows);
  assert.equal(row?.arm, "luna");
  assert.equal(row?.start_reason, "economy-first");
});

test("W1-T14549 criterion 2: control and ineligible tasks spawn with no economy start", async () => {
  const control = await dispatch(taskInArm("control"));
  assert.equal(control.spawns[1]!.economyFirst, undefined);
  assert.equal(control.spawns[1]!.model, "sonnet");
  assert.deepEqual(canaryRows(control.rows).map((row) => row.arm), ["control"]);

  for (const over of [{ files: "docs/guide.md" }, { risk: "medium" }]) {
    const ineligible = await dispatch(taskInArm("luna"), over);
    assert.equal(ineligible.spawns[1]!.economyFirst, undefined, JSON.stringify(over));
    assert.deepEqual(canaryRows(ineligible.rows), [], `${JSON.stringify(over)} writes no canary row`);
  }
  assert.equal(lunaBuildCanaryEligible({ type: "implement", risk: "low" }, "src", "cash"), false, "a mount provider is ineligible");
  assert.equal(lunaBuildCanaryEligible({ type: "implement", risk: "low" }, "plan-lint", undefined), false);
  assert.equal(lunaBuildCanaryEligible({ type: "recon", risk: "low" }, "src", undefined), false);
  assert.equal(lunaBuildCanaryEligible({ type: "implement", risk: "low" }, "src", undefined), true);
});

test("W1-T14549 criterion 3: with no Codex economy capacity, or an operator preference, the build routes as on main", async t => {
  const config = checkout(t);
  const baseline = await route(config, {});
  for (const economy of ["exhausted", "unreadable"] as const) {
    const attempt = await route(config, { economyFirst: true, economy });
    assert.deepEqual(attempt.starts, ["no-codex-capacity"], economy);
    assert.deepEqual(attempt.selected, baseline.selected, economy);
    assert.notEqual(attempt.assignment.routing.decision?.rule, "build-economy-first", economy);
  }
  writeProviderRoutingPolicyOverride(config.root, {
    enabledProviders: ["claude", "codex"], preference: "claude", reservePercent: 5, parks: [],
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
  }, { config, now: () => NOW, writerFingerprint: "unknown" });
  const preferred = await route(config, { draw: 0.9999 });
  const attempt = await route(config, { economyFirst: true, draw: 0.9999 });
  assert.deepEqual(attempt.starts, ["operator-preference"]);
  assert.deepEqual(attempt.selected, preferred.selected);
});

test("W1-T14549 criterion 4: a failed Luna first attempt retries on the mount route and names the failed assignment", async () => {
  const { spawns, rows } = await dispatch(taskInArm("luna"), { failFirstImplement: true });
  const attempts = spawns.slice(1).filter((args) => args.model === "sonnet" || args.model === "opus");
  assert.ok(attempts.length >= 2, `a retry ran (${spawns.length} spawns)`);
  assert.equal(attempts[0]!.economyFirst?.codexCapability, "economy");
  for (const later of attempts.slice(1)) assert.equal(later.economyFirst, undefined, "every later attempt routes as on main");
  const escalated = rows.find((row) => row.step === "implement.luna_canary_escalated");
  assert.equal(escalated?.failed_assignment_id, "ASSIGN-LUNA-1");
  assert.equal(escalated?.from_model, LUNA);
  assert.equal(escalated?.to_mount, "sonnet");
  assert.equal(canaryRows(rows).length, 1, "only the first attempt writes the luna row");
});

test("W1-T14549 criterion 5: the canary holds itself on its evidence, its policy or an unreadable ledger", async () => {
  assert.deepEqual(lunaBuildCanaryPolicy({}), { enabled: true, sharePercent: 25, minSample: 20, minRelativeSuccess: 0.8, windowDays: 7 });
  const run = (id: string, arm: string, opened: boolean, firstAttempt: boolean): Row[] => [
    { run_id: id, step: "implement.luna_canary", arm },
    ...(firstAttempt ? [{ run_id: id, step: "retry.success", attempts: 1 }] : [{ run_id: id, step: "retry.success", attempts: 2 }]),
    { run_id: id, step: "verdict", verdict: opened ? "pr_opened" : "failed", ...(opened ? { pr_url: `https://x/${id}` } : {}) },
  ];
  const rows = [...run("L1", "luna", true, true), ...run("L2", "luna", true, false), ...run("C1", "control", true, true),
    { run_id: "L3", step: "implement.luna_canary", arm: "luna" },
    ...run("L4", "luna", true, true), { run_id: "L4", step: "implement.luna_canary_escalated" }];
  assert.deepEqual(summarizeLunaBuildCanary(rows), { luna: { runs: 3, prs: 1 }, control: { runs: 1, prs: 1 } },
    "a mount-rescued or escalated Luna run counts against Luna; a run with no verdict is not counted");

  const p = policy;
  assert.equal(lunaBuildCanaryStopReason({ luna: { runs: 4, prs: 0 }, control: { runs: 0, prs: 0 } }, p), undefined, "4 failures fit the bar");
  assert.match(lunaBuildCanaryStopReason({ luna: { runs: 5, prs: 0 }, control: { runs: 0, prs: 0 } }, p) ?? "", /exceed the 4/);
  assert.equal(lunaBuildCanaryStopReason({ luna: { runs: 20, prs: 16 }, control: { runs: 20, prs: 20 } }, p), undefined);
  assert.match(lunaBuildCanaryStopReason({ luna: { runs: 20, prs: 15 }, control: { runs: 20, prs: 20 } }, p) ?? "", /below 0.8 x control 100%/);
  assert.match(lunaBuildCanaryStopReason({ luna: { runs: 20, prs: 15 }, control: { runs: 3, prs: 3 } }, p) ?? "", /unmeasured control/);

  const task = { id: taskInArm("luna"), type: "implement", risk: "low" };
  const decide = (over: Partial<Parameters<typeof decideLunaBuildCanary>[0]>) =>
    decideLunaBuildCanary({ task, routeClass: "src", mountProvider: undefined, config: {}, stateDir: "/unused",
      readRows: () => ({ rows: [] }), ...over });
  assert.equal(decide({})?.arm, "luna");
  assert.equal(decide({ config: { workerProviders: { lunaBuildCanary: { enabled: false } } } as Config })?.arm, "held");
  assert.equal(decide({ config: { workerProviders: { lunaBuildCanary: { sharePercent: 150 } } } as Config })?.arm, "held");
  assert.equal(decide({ readRows: () => ({ rows: [], unavailableReason: "ledger source unreadable or incomplete" }) })?.reason,
    "canary evidence unavailable: ledger source unreadable or incomplete");
  const failing = Array.from({ length: 5 }, (_, i) => run(`F${i}`, "luna", false, false)).flat();
  assert.equal(decide({ readRows: () => ({ rows: failing }) })?.arm, "held");
  assert.equal(decide({ task: { ...task, id: taskInArm("control") }, readRows: () => ({ rows: failing }) })?.arm, "control");

  const held = await dispatch(taskInArm("luna"), { canary: { enabled: false } });
  assert.equal(held.spawns[1]!.economyFirst, undefined, "a held arm spawns on the mount route");
  assert.deepEqual(canaryRows(held.rows).map((row) => row.arm), ["held"]);

  const stamp = new Date(NOW - 3_600_000).toISOString();
  const ledger = writeLedger([{ ts: stamp, run_id: "R1", step: "implement.luna_canary", arm: "luna" },
    { ts: new Date(NOW - 30 * 86_400_000).toISOString(), run_id: "R0", step: "verdict", pr_url: "https://x/0" },
    { ts: stamp, run_id: "R1", step: "worker.assignment" }]);
  try {
    assert.deepEqual(readLunaBuildCanaryRows(ledger.dir, 7 * 86_400_000, NOW).rows.map((row) => row.run_id), ["R1"],
      "the window keeps its own steps and drops older rows");
    writeFileSync(ledger.path, "{not json\n");
    assert.equal(readLunaBuildCanaryRows(ledger.dir, 7 * 86_400_000, NOW).unavailableReason, undefined,
      "a line outside the canary steps is never parsed");
    writeFileSync(ledger.path, '{"step":"verdict",\n');
    assert.equal(readLunaBuildCanaryRows(ledger.dir, 7 * 86_400_000, NOW).unavailableReason, "a ledger row is not valid JSON");
    rmSync(ledger.path);
    assert.equal(readLunaBuildCanaryRows(ledger.dir, 7 * 86_400_000, NOW).unavailableReason, "ledger source unreadable or incomplete");
  } finally {
    rmSync(ledger.dir, { recursive: true, force: true });
  }
});

test("W1-T14549 criterion 6: review, the cash-simple trial and the fix lane's economy start are unchanged", async t => {
  const { spawns } = await dispatch(taskInArm("luna"));
  assert.ok(spawns.length >= 2);
  for (const args of spawns.filter((_, index) => index !== 1)) {
    assert.equal(args.economyFirst, undefined, "no spawn but the first implement attempt asks the economy tier");
  }
  const docs = await dispatch(taskInArm("luna"), { files: "docs/guide.md" });
  assert.ok(docs.spawns.every((args) => args.economyFirst === undefined), "a docs build keeps its own route");

  const config = checkout(t);
  const fix = codex.selectCodexModel(CANDIDATES, { rateLimits: { primary: { usedPercent: 25 } } }, config, "sonnet", "medium",
    capabilities, { codexCapability: "economy" });
  assert.deepEqual(fix.modelDecision?.capabilityOverride, { from: "balanced", reason: "fix-economy-first" },
    "a reasonless economy read is still labelled as the fix lane's");
});
