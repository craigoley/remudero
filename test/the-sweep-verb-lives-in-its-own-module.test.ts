import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { stripComments } from "#test/helpers/daemon-loop-walk.js";
import { configPath } from "#src/lib/config.js";
import { automaticBranchReapStateFileName, readAutomaticBranchReapState } from "#src/lib/branch-reaper.js";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import type { GitHub } from "#src/lib/status.js";
import type { OpenPrView, SweepDeps, BuildSweepEffectsDeps } from "#src/lib/sweep.js";
import type { SweepCommandHost, LightPassReadPorts } from "#src/cli/commands/sweep.js";
import { systemClock } from "#src/lib/clock.js";

// Avoid the argv module's checkout discovery: these fixtures do not need a git executable.
const savedArgv = [...process.argv];
process.argv.push("--repo-root", REPO_ROOT);
const { buildSweepEffects, buildSweepHook, buildSweepLightHook, sweepCommand } =
  await import("#src/cli/commands/sweep.js");
process.argv.splice(0, process.argv.length, ...savedArgv);

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

/** Every top-level declaration of a source, by name, as its code-only text. A column-0 import or
 *  `export {` list is a module chunk, not a declaration; overloads share their name's chunk. */
function topLevelDeclarations(source: string): Map<string, string> {
  const decls = new Map<string, string>();
  let current = "<module>";
  for (const line of stripComments(source).split("\n")) {
    const head = /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (head && !/^export\s+type\s*\{/.test(line)) current = head[1]!;
    else if (/^(?:import\b|export\s*(?:type\s*)?[{*])/.test(line)) current = "<module>";
    decls.set(current, `${decls.get(current) ?? ""}${line}\n`);
  }
  decls.delete("<module>");
  return decls;
}

/** For each declaration, the other declarations whose text names it (a member access is not a use). */
function referencedBy(decls: Map<string, string>, source: string): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>([...decls.keys()].map((name) => [name, new Set<string>()]));
  const chunks = new Map(decls);
  chunks.set("<module>", stripComments(source).split("\n")
    .filter((line) => /^(?:import\b|export\s*(?:type\s*)?[{*])/.test(line)).join("\n"));
  for (const [owner, text] of chunks) {
    for (const match of text.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) {
      if (match[0] !== owner) by.get(match[0])?.add(owner);
    }
  }
  return by;
}

/** Sweep-only run-task.ts symbols that an out-of-scope source-text census pins to run-task.ts by name. */
const PINNED_TO_RUN_TASK = new Map([
  ["lightPassActionable", "test/event-review-backlog-drain.test.ts slices run-task.ts up to its declaration"],
  ["removeAbandonedFixWorktreeOwner", "the run-task.ts git-site tables (W1-T6121, W1-T6135) name it"],
  ["publishAbandonedFixOwnerAhead", "the run-task.ts git-site tables (W1-T6121, W1-T6135) name it"],
  ["resetTrackedDirtyFixOwner", "the run-task.ts git-site table (W1-T6121) names it"],
  ["runMountRecommenderRung", "its doc names `.remudero/`, and W1-T3701's house-layout ratchet counts files"],
]);

/** The design's reference census, read from the sources as they stand: a run-task.ts declaration that
 *  only the sweep verb's wrappers and host reach, directly or through other such declarations. */
function sweepOnlyRunTaskSymbols(): { sweepOnly: Set<string>; movable: Set<string> } {
  const decls = topLevelDeclarations(runTaskSrc);
  const by = referencedBy(decls, runTaskSrc);
  const sweepSide = new Set(["sweepCommandHost", "sweepCommand", "buildSweepEffects", "buildSweepHook", "buildSweepLightHook"]);
  const sweepOnly = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, users] of by) {
      if (sweepSide.has(name) || sweepOnly.has(name) || users.size === 0) continue;
      if ([...users].every((user) => sweepSide.has(user) || sweepOnly.has(user))) {
        sweepOnly.add(name);
        grew = true;
      }
    }
  }
  // A sweep-only symbol moves verbatim when nothing it names, and nothing naming it, stays behind.
  const movable = new Set([...sweepOnly].filter((name) => !PINNED_TO_RUN_TASK.has(name)));
  for (let shrank = true; shrank;) {
    shrank = false;
    for (const name of movable) {
      const uses = [...decls.keys()].filter((other) => other !== name && by.get(other)!.has(name));
      const users = [...by.get(name)!];
      if (uses.some((use) => !movable.has(use)) || users.some((user) => !movable.has(user) && !sweepSide.has(user))) {
        movable.delete(name);
        shrank = true;
      }
    }
  }
  return { sweepOnly, movable };
}

test("W1-T9338: sweepCommand is defined in its module and src/run-task.ts only delegates to it", () => {
  assert.match(sweepSrc, /^export interface SweepCommandHost \{/m);
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
  // Design 1: a run-task.ts symbol that only the moved roots reach moves with them. The set is the
  // census above, derived from both sources, so a helper left behind or moved back reddens here.
  const { sweepOnly, movable } = sweepOnlyRunTaskSymbols();
  assert.ok(sweepOnly.has("buildReviewerHealthRoute"), "control: the census sees what the sweep host still carries");
  for (const [name, reason] of PINNED_TO_RUN_TASK) assert.ok(sweepOnly.has(name), `${name} is still sweep-only (${reason})`);
  assert.deepEqual([...movable].sort(), [], "only the sweep verb reaches these, and nothing they need stays in run-task.ts");
  const roots = ["sweepCommand", "buildSweepEffects", "buildSweepHook", "buildSweepLightHook"];
  const moduleDecls = topLevelDeclarations(sweepSrc);
  const helpers = [...moduleDecls.keys()].filter((name) => !roots.includes(name) && name !== "HostFn" && name !== "SweepCommandHost");
  assert.ok(helpers.includes("runOneShotSweep") && helpers.includes("updatedForWorkflowFromLedger"), "control: the module's helpers were read");
  const runTaskDecls = topLevelDeclarations(runTaskSrc);
  assert.deepEqual(helpers.filter((name) => runTaskDecls.has(name)), [], "each moved helper is declared once, in the module");
  const hostMembers = moduleDecls.get("SweepCommandHost")!;
  assert.deepEqual(helpers.filter((name) => new RegExp(`^\\s+(?:readonly\\s+)?${name}\\b`, "m").test(hostMembers)), [],
    "the host never hands the module back a helper it owns");
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
  // The rungs that moved with the hook run for real: the escalation reads answer from the shared
  // gh shim, the PR-terminal rung asks the board gateway about the one PR the ledger names, and the
  // tail rung works under the fixture root.
  const shim = ghShim([{ when: "", stdout: "[]" }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => { process.env.PATH = oldPath; });
  const prUrl = "https://github.com/acme/fixture/pull/77";
  mkdirSync(join(f.root, "state", "runs"), { recursive: true });
  writeFileSync(f.ledgerPath, JSON.stringify({ step: "pr.opened", pr_url: prUrl, ts: new Date().toISOString() }) + "\n");
  const staleTail = join(f.root, "state", "runs", "RUN-OLD.tail");
  writeFileSync(staleTail, "old\n");
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  utimesSync(staleTail, longAgo, longAgo);
  const prRefs: unknown[] = [];
  const github = { prByRef: (ref: unknown) => { prRefs.push(ref); return null; } } as unknown as GitHub;
  const hook = buildSweepHook(host, "acme", "fixture", f.config, f.ledgerPath, "HOOK", f.plan,
    f.log, undefined, github, undefined, 456, undefined, undefined, undefined, undefined, undefined,
    f.root, undefined, undefined, "/fixture/socket", async () => tick as never);
  const outcome = await hook();
  assert.deepEqual(outcome, { reviewerCodeStale: stale, planOnlyRunBranchReceipts: [], reviewInputViews: [] });
  assert.deepEqual(f.logs.filter((row) => row.step === "sweep.error"), []);
  for (const name of ["reverify", "branchReap", "locks", "stalls", "mounts", "draft"]) {
    assert.equal(f.calls.filter((c) => c.name === name).length, 1, `${name} runs once`);
  }
  const steps = f.logs.map((row) => row.step);
  assert.equal(steps.filter((step) => step === "sweep.escalation_reconcile.summary").length, 1, "reconcile runs once");
  assert.deepEqual(prRefs, [prUrl], "the terminal rung reads through the board gateway");
  assert.equal(steps.filter((step) => step === "daemon.tmp_sweep").length, 1, "the temp sweep runs once");
  assert.equal(existsSync(staleTail), false, "the tail rung ages out the stale tail");
  assert.deepEqual(f.logs.find((row) => row.step === "daemon.worker_tail_sweep")?.removed, 1);
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
  const hook = buildSweepLightHook(f.host, "acme", "fixture", f.config, f.ledgerPath, "LIGHT", f.plan,
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
  await buildSweepLightHook(f.host, "acme", "fixture", f.config, f.ledgerPath, "LIGHT", f.plan,
    f.log, undefined, undefined, undefined, undefined, undefined, io)();
  assert.deepEqual(reads, [["api", `repos/acme/fixture/compare/${pr().headSha}...main`]]);
  assert.equal(f.logs.find((row) => row.step === "sweep_light.main_tip_unreadable")?.error, "Error: main unavailable");
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
  // The escalation reconcile moved with the command, so its issue reads run for real against the
  // shared gh shim; every other spawn stays the git stand-in below.
  const shim = ghShim([{ when: "", stdout: "[]" }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => { process.env.PATH = oldPath; });
  const realExecFileSync = childProcess.execFileSync;
  t.mock.method(childProcess, "execFileSync", (file: string, args: string[], opts: object) => {
    if (file === "gh") return realExecFileSync(file, args, opts);
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
  const host = { ...f.host, commandViews: () => [] };
  assert.equal(await sweepCommand(host, ["--repo", "other", "--dry-run"]), 0);
  assert.match(output.join("\n"), /rmd sweep --dry-run — acme\/other/);
  assert.match(output.join("\n"), /post-fix re-verification: 0 open PR\(s\) checked/);
  assert.match(output.join("\n"), /credit backfill: 0 candidate\(s\) reconciled/);
  assert.match(output.join("\n"), /escalation reconcile: 0 open needs-human issue\(s\) checked · 0 closed/);
  assert.match(output.join("\n"), /worktree reap: 0 worktree\(s\) reaped/);
  const effectDeps = f.calls.find((c) => c.name === "effects")!.args[0];
  assert.deepEqual([effectDeps.owner, effectDeps.repo, effectDeps.runId, effectDeps.config],
    ["acme", "other", "SWEEP-9338000", f.config]);
  assert.deepEqual(f.calls.find((c) => c.name === "reverify")!.args.slice(0, 2), ["acme", "other"]);
  assert.ok(shim.calls().some((call) => call.includes("acme/other")), "the reconcile reads the named repo's issues");
  const triage = f.calls.find((c) => c.name === "triage")!;
  assert.deepEqual([triage.args[0].owner, triage.args[0].repo, triage.args[1], triage.args[3].dryRun],
    ["acme", "other", [], true]);
  assert.equal(f.calls.find((c) => c.name === "branchReap")!.args[7].prune, false);
  assert.equal(await sweepCommand({ ...host, commandViews: () => { throw new Error("enumeration unavailable"); } }, ["--repo", "other"]), 1);
  assert.match(errors.join("\n"), /could not list open PRs for acme\/other: enumeration unavailable/);
});
