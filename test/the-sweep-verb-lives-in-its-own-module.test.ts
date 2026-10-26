import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { configPath } from "#src/lib/config.js";
import { automaticBranchReapStateFileName, readAutomaticBranchReapState } from "#src/lib/branch-reaper.js";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import type { GitHub } from "#src/lib/status.js";
import type { OpenPrView, SweepDeps, BuildSweepEffectsDeps } from "#src/lib/sweep.js";
import type { SweepCommandHost } from "#src/cli/commands/sweep.js";
import { systemClock } from "#src/lib/clock.js";

// Avoid the argv module's checkout discovery: these fixtures do not need a git executable.
const savedArgv = [...process.argv];
process.argv.push("--repo-root", REPO_ROOT);
const { buildSweepEffects, buildSweepHook, sweepCommand } =
  await import("#src/cli/commands/sweep.js");
const { buildSweepLightHook: buildSweepLightHookFromEntrypoint,
  buildSweepEffects: buildSweepEffectsFromEntrypoint } = await import("#src/run-task.js");
process.argv.splice(0, process.argv.length, ...savedArgv);
type LightPassReadPorts = NonNullable<Parameters<typeof buildSweepLightHookFromEntrypoint>[12]>;

// @source-text-subject: this extraction's subject is declaration ownership and import direction.
const runTaskSrc = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
const modulePath = join(REPO_ROOT, "src/cli/commands/sweep.ts");
const sweepSrc = existsSync(modulePath) ? readFileSync(modulePath, "utf8") : "";

function topLevelFunction(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} is declared`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${header} closes`);
  return source.slice(start, end + 2);
}

test("W1-T9338: sweepCommand is defined in its module and src/run-task.ts only delegates to it", () => {
  assert.match(sweepSrc, /^export interface SweepCommandHost \{/m);
  assert.ok(/^interface LightPassReadPorts \{/m.test(runTaskSrc), "the original read-ports type stays in the entrypoint");
  assert.equal(runTaskSrc.match(/^function createLightPassCompareReader\(/gm)?.length, 1);
  assert.equal(/^(?:export )?(?:interface LightPassReadPorts|function createLightPassCompareReader)\b/m.test(sweepSrc), false);
  assert.ok(/createLightPassCompareReader,[\s\S]*?\} = host;/.test(sweepSrc), "the module reads the helper from its host");
  assert.ok(/function sweepCommandHost\([\s\S]*?\n    createLightPassCompareReader,/.test(runTaskSrc), "the entrypoint supplies its helper");
  for (const [name, declaration, minimumLines] of [
    ["sweepCommand", "export async function", 100],
    ["buildSweepEffects", "export function", 300],
    ["buildSweepHook", "export function", 250],
    ["buildSweepLightHook", "export function", 150],
  ] as const) {
    const header = `${declaration} ${name}(`;
    const implementation = topLevelFunction(sweepSrc, header);
    assert.ok(implementation.split("\n").length > minimumLines, `${name} holds its real body`);
    const wrapper = topLevelFunction(runTaskSrc, header).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const bodyStart = wrapper.lastIndexOf(" {\n");
    assert.notEqual(bodyStart, -1, `${name} has a function body`);
    const body = wrapper.slice(bodyStart + 3).trim();
    assert.match(body, new RegExp(`^return ${name}FromModule\\(sweepCommandHost\\([^;]+;\\s*\\}$`));
    assert.equal(body.split("\n").filter((line) => line.trim()).length, 2, `${name} only delegates`);
    assert.match(runTaskSrc, new RegExp(`${name} as ${name}FromModule`));
    assert.equal(runTaskSrc.match(new RegExp(`^${declaration} ${name}\\(`, "gm"))?.length, 1);
  }
});

test("W1-T9338: the sweep module imports nothing from src/run-task.ts", () => {
  const specifiers = [...sweepSrc.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)]
    .map((match) => match[1]!);
  assert.ok(specifiers.length > 10, "the module's imports were read");
  assert.deepEqual(specifiers.filter((specifier) => /(^|\/)run-task(?:\.[jt]s)?$/.test(specifier)), []);
});

function sweepFixture(t: TestContext) {
  const root = mkdtempSync(join(os.tmpdir(), "rmd-sweep-module-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { root, claudeBin: "/bin/true" } as Config;
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const plan: Plan = { tasks: [], byId: new Map() };
  const logs: Array<{ step: string; [key: string]: unknown }> = [];
  const log = (step: string, extra = {}) => { logs.push({ step, ...extra }); };
  const calls: Array<{ name: string; args: any[] }> = [];
  const record = <T = undefined>(name: string, result?: T) => (...args: any[]): T => {
    calls.push({ name, args });
    return result as T;
  };
  const effects = {
    arm: record("arm"), close: record("close"), dispatchFix: record("dispatchFix"),
    escalate: record("escalate"), reviewerCodeStaleThisPass: () => undefined,
    readLedger: () => [], appendLine: (_path: string, row: any) => { logs.push(row); },
    readOpenEscalations: () => [],
  };
  const host = {
    USAGE: "sweep fixture usage", DEFAULT_WORKER_STALL_MS: 9123,
    buildSweepEffects: record("effects", effects),
    buildInboxDraftHook: () => record("draft"),
    createPlanFilingClassificationTelemetry: () => record("classification"),
    buildEscalationTriageRuntime: record("triageRuntime"),
    refreshEscalationTriageEvidence: record("refreshEvidence"),
    sweepPostFixReverification: record("reverify", { results: [], total: 0, redriven: 0 }),
    tickReadReverificationDeps: record("reverificationDeps", {}),
    gitCredentialFixSpawn: record("credentialSpawn", () => assert.fail("no fix spawn expected")),
    updatedForWorkflowFromLedger: record("workflow", () => false),
    buildRereadPrAtAct: record("reread", undefined),
    handedOffHeadRiskJudge: record("judge", undefined), codeScanningJudgeDeps: record("codeScanning", {}),
    sweepEscalationReconcile: record("reconcile", {}), sweepEscalationTriage: record("triage"),
    sweepPrTerminalRung: record("terminal"), runAutomaticBranchReapRung: record("branchReap"),
    runTmpSweepRung: record("tmp"), runWorkerTailSweepRung: record("tails"),
    runInflightLockSweepRung: record("locks"), runWorkerStallDetectorRung: record("stalls"),
    runMountRecommenderRung: record("mounts"),
    fixRungAllowedBesideInFlight: record("fixAllowed", true), inFlightTaskIdsFrom: () => [],
    blockedFixableIsRequeueOnly: () => false, lightPassActionable: () => false,
    reviewOnlyLightPassDeps: () => ({}),
  } as unknown as SweepCommandHost;
  return { root, config, ledgerPath, plan, logs, log, calls, host, effects };
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9338, prUrl: "https://github.com/acme/fixture/pull/9338", headSha: "a".repeat(40),
    headRefName: "run-W1-T9338-1", taskId: "W1-T9338", reviewState: "success",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date().toISOString(), ...over,
  };
}

test("W1-T9338: the extracted effects adapter returns executable library effects", async (t) => {
  const f = sweepFixture(t);
  let freshnessRead: (() => unknown) | undefined;
  const gateCalls: unknown[][] = [];
  const host = {
    ...f.host, freshTreeGit: () => assert.fail("no fresh worktree requested"),
    realDeps: () => ({ reviewWorktree: { addWorktree: () => assert.fail("no review worktree requested") } }),
    buildFreshTreeReviewRunner: () => () => assert.fail("no fresh review requested"),
    buildReviewerCodeFreshnessGate: (read: () => unknown) => {
      freshnessRead = read;
      return { call: (...args: unknown[]) => { gateCalls.push(args); return 17; },
        staleThisPass: () => ({ oldSha: "old", newSha: "new" }) };
    },
    buildBaseReproductionProbe: () => () => ({ reproduced: false }),
    buildImportClosureRead: () => () => [], buildRequiredFixReviewRunner: () => () => 0,
    readyDraftViaGh: () => () => {},
  } as unknown as SweepCommandHost & Required<Pick<SweepCommandHost, "freshTreeGit">>;
  const deps: BuildSweepEffectsDeps = {
    owner: "acme", repo: "fixture", localRepoName: "fixture", config: f.config,
    ledgerPath: f.ledgerPath, runId: "SWEEP-MODULE", plan: f.plan, log: f.log,
  };
  const effects = buildSweepEffects(host, {
    ...deps, reviewerCodeFreshnessImpl: () => ({ status: "unreadable", reason: "fixture" }) as never,
    instanceRegistryTextImpl: () => undefined,
  });
  assert.equal(typeof effects.arm, "function");
  assert.deepEqual(effects.reviewerCodeStaleThisPass(), { oldSha: "old", newSha: "new" });
  assert.deepEqual(freshnessRead!(), { status: "unreadable", reason: "fixture" });
  await effects.postReview!(pr(), { kind: "full-review" });
  assert.equal(gateCalls.length, 1);
  assert.deepEqual(gateCalls[0]!.slice(0, 2), ["9338", ["--repo", "fixture"]]);
});

test("W1-T9338: full hook runs maintenance with the tick snapshot and persists branch cadence", async (t) => {
  const f = sweepFixture(t);
  const stale = { oldSha: "old", newSha: "new" };
  f.effects.reviewerCodeStaleThisPass = () => stale as never;
  const state = { lastRunAtMs: 1234 };
  const host = { ...f.host, runAutomaticBranchReapRung: (...args: any[]) => {
    f.calls.push({ name: "branchReap", args });
    Object.assign(args[6], state);
  } };
  const tick = { openPrViews: [], plan: f.plan, staleGateWorkflowsByPr: new Map(),
    behindMainByPr: new Map(), baseChangedFilesByPr: new Map(), creditCandidates: [] };
  const github = {} as GitHub;
  const hook = buildSweepHook(host, "acme", "fixture", f.config, f.ledgerPath, "HOOK", f.plan,
    f.log, 321, github, undefined, 456, undefined, undefined, undefined, undefined, undefined,
    f.root, undefined, undefined, "/fixture/socket", async () => tick as never);
  const outcome = await hook();
  assert.deepEqual(outcome, { reviewerCodeStale: stale, planOnlyRunBranchReceipts: [], reviewInputViews: [] });
  assert.deepEqual(f.logs.filter((row) => row.step === "sweep.error"), []);
  for (const name of ["reverify", "reconcile", "terminal", "branchReap", "tmp", "tails", "locks", "stalls", "mounts", "draft"]) {
    assert.equal(f.calls.filter((c) => c.name === name).length, 1, `${name} runs once`);
  }
  assert.equal(f.calls.find((c) => c.name === "tmp")!.args[1].maxAgeMs, 321);
  assert.equal(f.calls.find((c) => c.name === "stalls")!.args[5], 456);
  assert.equal(f.calls.find((c) => c.name === "effects")!.args[0].spawnImpl instanceof Function, true);
  const persisted = readAutomaticBranchReapState(join(f.root, "state", automaticBranchReapStateFileName("fixture")));
  assert.deepEqual(persisted, state);
});

test("W1-T9338: full hook reports failures and still runs its draft rung", async (t) => {
  const f = sweepFixture(t);
  const hook = buildSweepHook(f.host, "acme", "fixture", f.config, f.ledgerPath, "HOOK", f.plan,
    f.log, undefined, {} as GitHub, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => ({ openPrError: "snapshot unavailable" }) as never);
  assert.equal(await hook(), undefined);
  assert.equal(f.logs.find((row) => row.step === "sweep.error")?.error, "snapshot unavailable");
  assert.equal(f.calls.filter((c) => c.name === "draft").length, 1);
  assert.equal(f.calls.some((c) => c.name === "effects"), false);
});

test("W1-T9338: the resolved sweep keeps live-state and full-hook compare reads asynchronous", async (t) => {
  const f = sweepFixture(t);
  const shim = ghShim([
    { when: "pulls/9338", stdout: JSON.stringify({ state: "open", head: { sha: pr().headSha } }) },
    { when: "compare/", stdout: JSON.stringify({ ahead_by: 4, files: [{ filename: "src/example.ts" }] }) },
  ]);
  const savedPath = process.env.PATH;
  const savedCache = process.env.XDG_CACHE_HOME;
  process.env.PATH = `${shim.dir}:${savedPath ?? ""}`;
  process.env.XDG_CACHE_HOME = shim.dir;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = savedCache;
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const effects = buildSweepEffectsFromEntrypoint({
    owner: "acme", repo: "fixture", localRepoName: "fixture", config: f.config,
    ledgerPath: f.ledgerPath, runId: "ASYNC", plan: f.plan, log: f.log,
    reviewerCodeFreshnessImpl: () => ({ status: "unreadable", reason: "fixture" }) as never,
    instanceRegistryTextImpl: () => undefined,
  });
  const live = effects.readLiveState!(pr());
  assert.ok(live instanceof Promise, "the entrypoint supplies the async live-state reader");
  assert.deepEqual(await live, { ok: true, state: "OPEN", headSha: pr().headSha });

  const tick = { openPrViews: [pr({ checksState: "pending", reviewState: "none" })],
    plan: f.plan, staleGateWorkflowsByPr: new Map(), creditCandidates: [] };
  // No compare facts in this tick: the full hook must await its production fallback reader.
  t.mock.method(childProcess, "execFileSync", () => assert.fail("the full-hook compare blocked the event loop"));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await buildSweepHook(f.host, "acme", "fixture", f.config, f.ledgerPath, "ASYNC", f.plan,
    f.log, undefined, {} as GitHub, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => tick as never)();
  assert.ok(shim.calls().includes(`api repos/acme/fixture/compare/${pr().headSha}...main`));
  assert.deepEqual(f.logs.filter((row) => row.step === "sweep.error"), []);
  assert.equal(f.calls.filter((call) => call.name === "draft").length, 1);
});

test("W1-T9338: light hook compares ready heads through its default subprocess reader", async (t) => {
  const f = sweepFixture(t);
  const shim = ghShim([{ when: "compare/", stdout: JSON.stringify({ ahead_by: 0, files: [] }) }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => { process.env.PATH = oldPath; });
  const views = [pr()];
  const io: LightPassReadPorts = { openPrViews: async () => views,
    effects: (deps) => {
      assert.deepEqual([deps.owner, deps.repo, deps.config, deps.plan, deps.ledgerPath, deps.runId],
        ["acme", "fixture", f.config, f.plan, f.ledgerPath, "LIGHT"]);
      return { ...f.effects, ledgerPath: f.ledgerPath, runId: "LIGHT", readMainTip: async () => "main-sha" };
    } };
  const hook = buildSweepLightHookFromEntrypoint("acme", "fixture", f.config, f.ledgerPath, "LIGHT", f.plan,
    f.log, undefined, undefined, undefined, undefined, undefined, io);
  await hook();
  await hook();
  assert.deepEqual(shim.calls(), [`api repos/acme/fixture/compare/${views[0].headSha}...main-sha`]);
  const timings = f.logs.filter((row) => row.step === "sweep_light.pre_review_timing");
  assert.equal(timings.length, 2);
  assert.deepEqual(f.logs.filter((row) => row.step === "sweep_light.error"), []);
});

test("W1-T9338: light hook keeps the main-tip failure reason and uses symbolic main", async (t) => {
  const f = sweepFixture(t);
  const reads: string[][] = [];
  let mainReads = 0;
  const io: LightPassReadPorts = { openPrViews: async () => [pr()],
    effects: () => ({ ...f.effects, ledgerPath: f.ledgerPath, runId: "LIGHT",
      readMainTip: async () => { if (mainReads++ === 0) throw new Error("main unavailable"); return "main-sha"; } }),
    readCompare: async (args) => { reads.push(args); return { ahead_by: 0, files: [] }; } };
  await buildSweepLightHookFromEntrypoint("acme", "fixture", f.config, f.ledgerPath, "LIGHT", f.plan,
    f.log, undefined, undefined, undefined, undefined, undefined, io)();
  assert.deepEqual(reads, [["api", `repos/acme/fixture/compare/${pr().headSha}...main`]]);
  assert.equal(f.logs.find((row) => row.step === "sweep_light.main_tip_unreadable")?.error, "Error: main unavailable");
  assert.deepEqual(f.logs.filter((row) => row.step === "sweep_light.error"), []);
});

test("W1-T9338: the entrypoint compare reader retries errors and unreadable facts before caching success", async (t) => {
  const f = sweepFixture(t);
  let reads = 0;
  const io: LightPassReadPorts = { openPrViews: async () => [pr()],
    effects: () => ({ ...f.effects, ledgerPath: f.ledgerPath, runId: "LIGHT",
      readMainTip: async () => "main-sha" }),
    readCompare: async () => {
      reads++;
      if (reads === 1) throw new Error("compare unavailable");
      if (reads === 2) return { ahead_by: "unknown", files: [] };
      return { ahead_by: 0, files: [] };
    } };
  const hook = buildSweepLightHookFromEntrypoint("acme", "fixture", f.config, f.ledgerPath, "LIGHT", f.plan,
    f.log, undefined, undefined, undefined, undefined, undefined, io);
  for (let pass = 0; pass < 4; pass++) await hook();
  assert.equal(reads, 3, "failures are retried; only valid facts can be reused");
  const comparisons = f.logs.filter((row) => row.step === "sweep_light.pre_review_timing")
    .flatMap((row) => row.compare_reads as Array<Record<string, unknown>>);
  assert.deepEqual(comparisons.map((row) => [row.outcome, row.cache_hit]),
    [["error", false], ["unreadable", false], ["read", false], ["read", true]]);
  assert.equal(comparisons[0]!.error, "Error: compare unavailable");
  assert.deepEqual(f.logs.filter((row) => row.step === "sweep_light.error"), []);
});

test("W1-T9338: command rejects invalid arguments before reading configuration", async (t) => {
  const f = sweepFixture(t);
  const errors: string[] = [];
  t.mock.method(console, "error", (s: string) => errors.push(s));
  assert.equal(await sweepCommand({ ...f.host, commandViews: () => assert.fail("invalid args reached enumeration") }, ["--bogus"]), 2);
  assert.match(errors.join("\n"), /sweep fixture usage/);
  assert.deepEqual(f.calls, []);
});

test("W1-T9338: command composes a dry-run summary and contains enumeration failure", async (t) => {
  const f = sweepFixture(t);
  // Native mocks keep the real config reader and owner parser, with no git process or host config.
  t.mock.method(os, "homedir", () => f.root);
  t.mock.method(childProcess, "execFileSync", (file: string, args: string[]) => {
    assert.equal(file, "git");
    if (args.includes("remote.origin.url")) return "https://github.com/acme/fixture.git\n";
    throw new Error("fixture has no git history");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const path = configPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(f.config));
  const output: string[] = [];
  const errors: string[] = [];
  t.mock.method(systemClock, "now", () => 9338000);
  t.mock.method(console, "log", (s: string) => output.push(s));
  t.mock.method(console, "error", (s: string) => errors.push(s));
  const host = { ...f.host, commandViews: () => [],
    runOneShotSweep: async (run: any) => run(undefined),
    renderEscalationReconcileSummary: () => "escalations: fixture summary" };
  assert.equal(await sweepCommand(host, ["--repo", "other", "--dry-run"]), 0);
  assert.match(output.join("\n"), /rmd sweep --dry-run — acme\/other/);
  assert.match(output.join("\n"), /post-fix re-verification: 0 open PR\(s\) checked/);
  assert.match(output.join("\n"), /credit backfill: 0 candidate\(s\) reconciled/);
  assert.match(output.join("\n"), /escalations: fixture summary/);
  assert.match(output.join("\n"), /worktree reap: 0 worktree\(s\) reaped/);
  const effectDeps = f.calls.find((c) => c.name === "effects")!.args[0];
  assert.deepEqual([effectDeps.owner, effectDeps.repo, effectDeps.runId, effectDeps.config],
    ["acme", "other", "SWEEP-9338000", f.config]);
  assert.deepEqual(f.calls.find((c) => c.name === "reverify")!.args.slice(0, 2), ["acme", "other"]);
  assert.equal(f.calls.find((c) => c.name === "reconcile")!.args[6].dryRun, true);
  const triage = f.calls.find((c) => c.name === "triage")!;
  assert.deepEqual([triage.args[0].owner, triage.args[0].repo, triage.args[1], triage.args[3].dryRun],
    ["acme", "other", [], true]);
  assert.equal(f.calls.find((c) => c.name === "branchReap")!.args[7].prune, false);
  assert.equal(await sweepCommand({ ...host, commandViews: () => { throw new Error("enumeration unavailable"); } }, ["--repo", "other"]), 1);
  assert.match(errors.join("\n"), /could not list open PRs for acme\/other: enumeration unavailable/);
});
