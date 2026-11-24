import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { inspect } from "node:util";
import { findTaskInCatalogs, opsPlanForLookup } from "#src/lib/task-lookup.js";
// Load the existing analytics side of the daemon's import cycle first.
import "#src/lib/live-analytics-snapshot-cache.js";
import { runDaemon, compareSecondaryCatalogShadow, type DaemonDeps, type OpsTaskDispatchRead } from "#src/lib/daemon.js";
import { opsCatalogShadowFeed } from "#src/cli/commands/daemon.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import { OpsCatalogAuthMissingError, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import type { Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";
import { runTask } from "#test/helpers/run-task-test.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { projectPlan, type GitHub } from "#src/lib/status.js";
import { loadPlan, mergePlanBlobs } from "#src/lib/plan.js";

type CommandDeps = NonNullable<Parameters<typeof daemonCommand>[1]>;
type Row = { step: string; data: Record<string, unknown> };
const REPOSITORY = "fixture-private/ops";
const PRIVATE = "PRIVATE_TASK_NARRATIVE_SENTINEL";
const publicYaml = ["PUB-A", "PUB-B", "PUB-C"].map((id, i) =>
  `- id: ${id}\n  title: public ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  priority: ${i + 1}\n  depends_on: []\n`).join("");
const opsYaml = "- id: OPS-T1\n  title: allowed private task title\n  repo: remudero\n  type: implement\n" +
  `  verify: auto\n  priority: 0\n  depends_on: []\n  rationale: ${PRIVATE}\n`;
const LIVE_SEAMS = ["secondaryCatalogShadowSource", "primaryPlanCommit", "readOpsTaskDispatch"];
// Flake-screen runs many copies under load; the real CLI child must have time to start
// before this fixture judges whether the public ref was claimed or refused.
const CLAIM_CHILD_TIMEOUT_MS = 120_000;

interface Scenario {
  opsText?: string;
  apiError?: Error;
  reversePublicEdge?: boolean;
  ownerHold?: "pause" | "stop";
  realClaims?: boolean;
  realWorkerDependency?: boolean;
  /** W1-T13749: while the sound task runs, the real runner is asked to run the held one. */
  realHeldRun?: string;
  lookupPrivacy?: boolean;
  selectionRecord?: Record<string, unknown>;
  coreRefusal?: "throw" | "missing-plan" | "unreadable" | "public-revision" | "ops-revision" | "identity";
  throwingHoldLog?: boolean;
  mergedIds?: string[];
  expireAfterWarm?: boolean;
  selectionAtAdmission?: "off" | "changed" | "unreadable";
  refillWhilePublicRuns?: boolean;
  signal?: AbortSignal;
}
interface ClaimObservation { task: string; publicRef: string; unchangedAfterRival: boolean; privateRefs: string }

async function selectedRun(enabled: unknown, scenario: Scenario = {}): Promise<{
  code: number; ran: string[]; reads: string[]; rows: Row[]; claims: ClaimObservation[];
}> {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ops-dispatch-command-`));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/false" }));
  writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify(scenario.selectionRecord ?? { repository: REPOSITORY, kinds: [], dispatch_ops_tasks: enabled }));
  const primary = gitRepo({ kind: "ops-dispatch-public" });
  const origin = gitRepo({ bare: true, kind: "ops-dispatch-public-origin" });
  const secondary = gitRepo({ kind: "ops-dispatch-private" });
  const privateText = scenario.opsText ?? opsYaml;
  const publicText = scenario.refillWhilePublicRuns ? publicYaml.replace(/title: public (PUB-[A-Z])/g, "title: public $1\n  files: [src/$1.ts]") : publicYaml;
  let rival: ReturnType<typeof gitRepo> | undefined;
  primary.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  primary.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  for (const [repo, yaml] of [[primary, publicText], [secondary, privateText]] as const) {
    mkdirSync(join(repo.dir, "plan"));
    writeFileSync(join(repo.dir, "plan", "tasks.yaml"), yaml);
    repo.git("add", "plan/tasks.yaml");
    repo.git("commit", "-qm", "fixture catalog");
  }
  primary.addRemote("origin", origin.dir);
  primary.git("push", "-qu", "origin", "main");
  // Use real Git object IDs: no invented blob identity or cryptographic test exemption.
  const commit = secondary.git("rev-parse", "HEAD");
  const tree = secondary.git("rev-parse", "HEAD^{tree}");
  const planTree = secondary.git("rev-parse", "HEAD:plan");
  const blob = secondary.git("rev-parse", "HEAD:plan/tasks.yaml");
  const prefix = `repos/${REPOSITORY}`;
  const routes = new Map<string, unknown>([
    [prefix, { id: 42, full_name: REPOSITORY, default_branch: "main" }],
    [`${prefix}/git/ref/heads/main`, { object: { type: "commit", sha: commit } }],
    [`${prefix}/git/commits/${commit}`, { sha: commit, tree: { sha: tree } }],
    [`${prefix}/git/trees/${tree}`, { sha: tree, truncated: false, tree: [{ path: "plan", sha: planTree, type: "tree", mode: "040000" }] }],
    [`${prefix}/git/trees/${planTree}`, { sha: planTree, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] }],
    [`${prefix}/git/blobs/${blob}`, { sha: blob, encoding: "base64", size: Buffer.byteLength(privateText), content: Buffer.from(privateText).toString("base64") }],
  ]);
  const reads: string[] = [], rows: Row[] = [], ran: string[] = [];
  const claims: ClaimObservation[] = [];
  const merged = new Set<string>(scenario.mergedIds ?? []);
  let paused = false, stopped = false, holdRefresh = false;
  let opsNow = Date.now();
  let releasePublicResolve!: () => void;
  const releasePublic = { promise: new Promise<void>(resolve => { releasePublicResolve = resolve; }), resolve: () => releasePublicResolve() };
  let publicStartedResolve!: () => void;
  const publicStarted = new Promise<void>(resolve => { publicStartedResolve = resolve; });
  const onAbort = () => { stopped = true; releasePublic.resolve(); publicStartedResolve(); };
  scenario.signal?.addEventListener("abort", onAbort, { once: true });
  const api: OpsCatalogApi = async path => {
    reads.push(path);
    if (holdRefresh) return new Promise<never>(() => {});
    if (scenario.apiError) throw scenario.apiError;
    assert.ok(routes.has(path), `undeclared GET route: ${path}`);
    return routes.get(path);
  };
  const getRoutes = [...routes].map(([path, value]) => ({ when: `api ${path}`, stdout: JSON.stringify(value) }))
    .sort((a, b) => b.when.length - a.when.length);
  const shim = ghShim([...getRoutes, { when: "", exit: 97, stderr: "forbidden external fixture GitHub effect" }], { kind: "ops-dispatch-deny-gh" });
  const priorHome = process.env.HOME, priorPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${shim.dir}:${priorPath ?? ""}`;
  let entered = false;
  const deps: CommandDeps = {
    config: { root, claudeBin: "/bin/false" }, repoRoot: primary.dir, opsCatalogApi: api, now: () => opsNow,
    githubFactory: () => ({}) as never, startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
    checkPause: () => paused ? "fixture owner pause" : undefined,
    checkStop: () => stopped ? "fixture owner stop" : undefined, readRunChildMode: () => "off",
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
    runTask: async (id, target) => {
      assert.equal(target.planPath, join(primary.dir, "plan", "tasks.yaml"), "the command retains the public code/claim root");
      assert.equal(target.config.root, root);
      if (scenario.lookupPrivacy && id === "OPS-T1") {
        const lookup = await findTaskInCatalogs(id, { byId: loadPlan(target.planPath).byId, stateDir: join(root, "state"), api });
        assert.equal(lookup.outcome, "found");
        const beforeHandleReads = reads.length;
        const privatePlan = opsPlanForLookup(lookup);
        assert.equal(privatePlan?.byId.get("OPS-T2")?.rationale, "OTHER_PRIVATE_TASK_SENTINEL", "positive control: the exact pinned dependency graph is present");
        assert.equal(opsPlanForLookup(lookup), privatePlan);
        assert.equal(reads.length, beforeHandleReads, "retrieving the pinned graph performs no second GET");
        assert.doesNotMatch(JSON.stringify(lookup), /OTHER_PRIVATE_TASK_SENTINEL/);
        assert.doesNotMatch(inspect(lookup, { depth: null }), /OTHER_PRIVATE_TASK_SENTINEL/);
        const publicTask = loadPlan(target.planPath).tasks[0]!;
        const publicLookup = await findTaskInCatalogs(publicTask.id, { byId: new Map([[publicTask.id, publicTask]]), stateDir: join(root, "state"), api });
        assert.deepEqual(publicLookup, { outcome: "found", task: publicTask, catalog: "public" });
        assert.equal(opsPlanForLookup(publicLookup), undefined);
        rows.push({ step: "fixture.lookup_privacy", data: { graphPresent: true, serializedOtherTask: false } });
      }
      if (scenario.realClaims && id === "OPS-T1") {
        const env = { PATH: `${shim.dir}:${priorPath ?? ""}`, HOME: home, TMPDIR: tmpdir(), LANG: "C", RMD_SELF_SYNC_DONE: "1",
          GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_ALLOW_PROTOCOL: "file",
          ...(process.env.NODE_OPTIONS === undefined ? {} : { NODE_OPTIONS: process.env.NODE_OPTIONS }),
          ...(process.env.NODE_V8_COVERAGE === undefined ? {} : { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }) };
        const args = ["--import", import.meta.resolve("tsx"), join(REPO_ROOT, "src", "run-task.ts"), "claim", id];
        const ref = `refs/rmd-dispatch/${id}`;
        assert.equal(primary.git("ls-remote", origin.dir, ref), "");
        const first = spawnSync(process.execPath, args, { cwd: dirname(dirname(target.planPath)), env, encoding: "utf8", timeout: CLAIM_CHILD_TIMEOUT_MS });
        const firstDiagnostic = JSON.stringify({ status: first.status, signal: first.signal,
          error: first.error?.message, stdout: first.stdout, stderr: first.stderr });
        rows.push({ step: "fixture.claim_child", data: { stage: "primary", diagnostic: firstDiagnostic } });
        assert.equal(first.error, undefined, firstDiagnostic);
        assert.equal(first.signal, null, firstDiagnostic);
        assert.equal(first.status, 0, firstDiagnostic);
        assert.match(first.stdout, /claimed refs\/rmd-dispatch\/OPS-T1/);
        assert.doesNotMatch(first.stdout, new RegExp(PRIVATE));
        const held = primary.git("ls-remote", origin.dir, ref);
        assert.match(held, /^[a-f0-9]{40}\s+refs\/rmd-dispatch\/OPS-T1$/);
        rival = gitRepo({ cloneFrom: origin.dir, kind: "ops-dispatch-rival" });
        rival.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
        rival.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
        const second = rival;
        const rejected = spawnSync(process.execPath, args, { cwd: second.dir, env, encoding: "utf8", timeout: CLAIM_CHILD_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
        const rejectedDiagnostic = JSON.stringify({ status: rejected.status, signal: rejected.signal,
          error: rejected.error?.message, stdout: rejected.stdout, stderr: rejected.stderr });
        rows.push({ step: "fixture.claim_child", data: { stage: "rival", diagnostic: rejectedDiagnostic } });
        // A startup error or timeout is not evidence that the real claim refused contention.
        assert.equal(rejected.error, undefined, rejectedDiagnostic);
        assert.equal(rejected.signal, null, rejectedDiagnostic);
        assert.equal(rejected.status, 1, rejectedDiagnostic);
        assert.match(rejected.stderr, /already claimed by another lane/, rejectedDiagnostic);
        const after = primary.git("ls-remote", origin.dir, ref);
        assert.equal(after, held, "the second instance cannot take or replace the public claim");
        const privateRefs = secondary.git("for-each-ref", "--format=%(refname)", "refs/rmd-dispatch");
        assert.equal(privateRefs, "");
        claims.push({ task: id, publicRef: held, unchangedAfterRival: after === held, privateRefs });
      }
      if (scenario.refillWhilePublicRuns) {
        ran.push(id);
        if (id === "OPS-T1") await publicStarted;
        if (id === "PUB-A") { publicStartedResolve(); await releasePublic.promise; }
        if (id === "OPS-T2") releasePublic.resolve();
        return { taskId: id, runId: `${id}-fixture`, merged: true, costUsd: 0, verdict: "merged" };
      }
      if (scenario.realWorkerDependency && id === "W1-T900092") {
        const dependency = "W1-T900091";
        const url = "https://github.com/fixture-public/remudero/pull/1";
        const github: GitHub = {
          prByRef: () => null,
          findMergedByTrailer: task => task === dependency ? { number: 1, url, state: "MERGED" } : null,
          headRefName: () => `run-${dependency}-fixture`,
          prBody: () => `Remudero-Task: ${dependency}`,
        };
        const plan = loadPlan(join(secondary.dir, "plan", "tasks.yaml"));
        const control = projectPlan(plan, { ledgerPath: join(root, "state", "ledger.ndjson"), github });
        assert.equal(control.get(dependency)?.merged, true, "positive control: the actual projector credits the private prerequisite when its record is present");
        const code = gitRepo({ cloneFrom: origin.dir, kind: "ops-dispatch-worker-code" });
        const checkout = join(root, "repos", "remudero");
        mkdirSync(dirname(checkout), { recursive: true });
        // Only our disposable fixture checkout is moved, never a shared repository.
        const { renameSync } = await import("node:fs");
        renameSync(code.dir, checkout);
        let reachedWorker = false, failure: unknown;
        try {
          await withLiveWritesAllowed(() => runTask(id, {
            config: { root, installRoot: REPO_ROOT, claudeBin: "/bin/false", workerProviders: { harnessCommitsImplement: true } },
            planPath: target.planPath, skipGitSync: true, github,
            claimReserver: { mintAnchor: () => "fixture", attempt: () => "created", holder: () => undefined, drop: () => true },
            containmentExec: async token => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
            isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
            spawn: async () => { reachedWorker = true; throw new Error("fixture stops before any model execution"); },
          }));
        } catch (error) { failure = error; }
        rows.push({ step: "fixture.real_worker_dependency", data: { reachedWorker, failure: String(failure) } });
      }
      if (scenario.realHeldRun && id !== scenario.realHeldRun) {
        let reachedWorker = false, failure: unknown;
        try {
          await withLiveWritesAllowed(() => runTask(scenario.realHeldRun!, {
            config: { root, installRoot: REPO_ROOT, claudeBin: "/bin/false", workerProviders: { harnessCommitsImplement: true } },
            planPath: target.planPath, skipGitSync: true,
            claimReserver: { mintAnchor: () => "fixture", attempt: () => "created", holder: () => undefined, drop: () => true },
            spawn: async () => { reachedWorker = true; throw new Error("fixture stops before any model execution"); },
          }));
        } catch (error) { failure = error; }
        rows.push({ step: "fixture.real_held_run", data: { reachedWorker, failure: String(failure) } });
      }
      ran.push(id);
      return { taskId: id, runId: `${id}-fixture`, merged: true, costUsd: 0, verdict: "merged" };
    },
    runDaemon: async (plan: Plan, wired: DaemonDeps) => {
      entered = true;
      // The injected GETs settle before the measured loop; there is no external API or model.
      await delay(25);
      let loopPlan = plan;
      let reverseRead: DaemonDeps["readOpsTaskDispatch"];
      if (scenario.reversePublicEdge) {
        // The real revision-store snapshot is immutable. Inject an adversarial public frame
        // only at the core loop boundary; keep the command's actual pinned private observation.
        const observation = wired.readOpsTaskDispatch?.(plan);
        assert.equal(observation?.outcome, "selected", "positive control: the actual private source is ready");
        const tasks = plan.tasks.map(task => task.id === "PUB-A" ? { ...task, depends_on: ["OPS-T1"] } : task);
        loopPlan = { ...plan, tasks, byId: new Map(tasks.map(task => [task.id, task])) };
        reverseRead = () => observation!;
      }
      if (scenario.expireAfterWarm) {
        assert.equal(wired.readOpsTaskDispatch?.(plan).outcome, "selected", "healthy completed source precedes expiry");
        holdRefresh = true;
        // A successor GET never settles. Only the injected caller clock advances; global
        // wall time and the fixture/temp hygiene clocks stay untouched.
        wired.readOpsTaskDispatch?.(plan);
        opsNow += 120_001;
      }
      let selectionReads = 0;
      const admissionRead = scenario.selectionAtAdmission && wired.readOpsTaskDispatch ? (publicPlan: Plan) => {
        if (++selectionReads === 2) {
          const selection = join(root, "state", "plan-destination.json");
          writeFileSync(selection, scenario.selectionAtAdmission === "unreadable" ? "{" : JSON.stringify({
            repository: scenario.selectionAtAdmission === "changed" ? "other-private/ops" : REPOSITORY,
            kinds: [], dispatch_ops_tasks: scenario.selectionAtAdmission !== "off",
          }));
        }
        return wired.readOpsTaskDispatch!(publicPlan);
      } : undefined;
      paused = scenario.ownerHold === "pause";
      stopped = scenario.ownerHold === "stop";
      const refusalControl = scenario.coreRefusal ? wired.readOpsTaskDispatch!(plan) : undefined;
      if (scenario.coreRefusal) {
        assert.equal(refusalControl?.outcome, "selected", "positive control outside the guard: real pinned input is healthy");
        assert.equal(refusalControl?.outcome === "selected" && refusalControl.source.outcome, "ok");
        if (refusalControl?.outcome !== "selected") throw new Error("fixture control is not selected");
        assert.ok(refusalControl.source.plan, "the private graph handle exists before the intended fault");
        assert.match(refusalControl.source.opsCommit ?? "", /^[a-f0-9]{40}$/);
        assert.equal(Object.getOwnPropertyDescriptor(refusalControl.source, "plan")?.enumerable, false,
          "the production source intentionally keeps its private graph off enumerable output");
      }
      const refusalRead = scenario.coreRefusal ? (): OpsTaskDispatchRead => {
        // The healthy control is asserted outside readOpsDispatch's catch; this closure only
        // applies the named boundary fault, so a swallowed fixture assertion cannot pass a case.
        if (refusalControl?.outcome !== "selected") throw new Error("fixture source was not ready");
        const current = refusalControl;
        switch (scenario.coreRefusal) {
          case "throw": throw new Error(PRIVATE);
          case "missing-plan": return { ...current, source: { ...current.source, outcome: "ok", plan: undefined } };
          case "unreadable": return { ...current, source: { outcome: "unreadable" } };
          case "public-revision": return { ...current, publicCommit: "invalid" };
          // Explicitly preserve the non-enumerable handles while faulting only this named binding.
          case "ops-revision": return { ...current, source: { ...current.source, plan: current.source.plan, opsCommit: "invalid" } };
          case "identity": return { ...current, source: { ...current.source, plan: current.source.plan, opsCommit: current.source.opsCommit, identityDigest: "invalid" } };
        }
        throw new Error("fixture refusal case missing");
      } : undefined;
      await runDaemon(loopPlan, {
        refreshMerged: () => id => merged.has(id), targetRepo: "remudero",
        runOne: async id => { const result = await wired.runOne(id); merged.add(id); return result; },
        checkPause: () => paused ? "fixture owner pause" : undefined,
        checkStop: () => stopped ? "fixture owner stop" : undefined,
        sleep: async () => { if (paused) stopped = true; await delay(1); }, log: (step, data = {}) => {
          rows.push({ step, data });
          if (scenario.throwingHoldLog && step === "dispatch.ops_catalog_held") throw new Error(PRIVATE);
          if (scenario.refillWhilePublicRuns && step === "dispatch.lane_refill_held") releasePublic.resolve();
        },
        memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {}, heapUsed: () => 1 }),
        heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
        now: () => new Date(), bootCheckoutBlocked: "",
        ...Object.fromEntries(LIVE_SEAMS.filter(key => key in wired).map(key => [key, (wired as unknown as Record<string, unknown>)[key]])),
        ...(reverseRead ? { readOpsTaskDispatch: reverseRead } : {}),
        ...(admissionRead ? { readOpsTaskDispatch: admissionRead } : {}),
        ...(refusalRead ? { readOpsTaskDispatch: refusalRead } : {}),
      }, { max: scenario.reversePublicEdge ? 2 : 3, ...(scenario.refillWhilePublicRuns ? { laneCount: 2 } : {}) });
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  };
  try {
    const code = await daemonCommand(["--allow-self-target", "--max", "0"], deps);
    assert.equal(entered, true, "the real command reached its daemon-loop composition");
    return { code, ran, reads, rows, claims };
  } finally {
    releasePublic.resolve();
    publicStartedResolve();
    scenario.signal?.removeEventListener("abort", onAbort);
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rival?.cleanup(); primary.cleanup(); origin.cleanup(); secondary.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

test("W1-T12209 criterion 2: the real task runner retains an already-merged ops prerequisite", async () => {
  const yaml = (id: string, depends: string[]) => `- id: ${id}\n  title: fixture private dependency\n  repo: remudero\n  type: implement\n  verify: auto\n  origin: test#W12209-private-prerequisite\n  risk: medium\n  priority: 0\n  depends_on: ${JSON.stringify(depends)}\n  files: [src/fixture.ts]\n  acceptance:\n    - claim: fixture behavior exists\n      proof: "grep: fixtureBehavior in src/fixture.ts"\n`;
  const result = await selectedRun(true, { realWorkerDependency: true, mergedIds: ["W1-T900091"],
    opsText: yaml("W1-T900091", []) + yaml("W1-T900092", ["W1-T900091"]) });
  assert.equal(result.ran[0], "W1-T900092", JSON.stringify(result.rows));
  const probe = result.rows.find(row => row.step === "fixture.real_worker_dependency");
  assert.equal(probe?.data.reachedWorker, true, `the actual runner must admit the ready private dependency: ${JSON.stringify(probe)}`);
});

test("W1-T12209 criterion 4: the pinned private graph stays off serialized lookup results", async () => {
  const other = opsYaml.replace("OPS-T1", "OPS-T2").replace(PRIVATE, "OTHER_PRIVATE_TASK_SENTINEL");
  const result = await selectedRun(true, { lookupPrivacy: true, opsText: opsYaml + other });
  assert.ok(result.rows.some(row => row.step === "fixture.lookup_privacy"));
});

test("W1-T12209 criterion 1: the real daemon command puts a selected ops task in ordinary priority order", async () => {
  const result = await selectedRun(true);
  assert.equal(result.code, 0);
  assert.deepEqual(result.ran, ["OPS-T1", "PUB-A", "PUB-B"]);
  assert.ok(result.reads.length >= 6, "the selected pinned catalog was actually read");
  assert.ok(result.reads.every(path => path.startsWith(`repos/${REPOSITORY}`)));
});

test("W1-T12209 criterion 6: an explicitly false host flag leaves public dispatch and private reads unchanged", async () => {
  const result = await selectedRun(false);
  assert.equal(result.code, 0);
  assert.deepEqual(result.ran, ["PUB-A", "PUB-B", "PUB-C"]);
  assert.deepEqual(result.reads, []);
  assert.equal(result.rows.some(row => row.step === "dispatch.secondary_catalog_shadow"), false);
  assert.doesNotMatch(JSON.stringify(result.rows), new RegExp(PRIVATE));
});


test("W1-T12209 criterion 2: ops waits for public credit and the reversed graph is refused atomically", async () => {
  const waiting = await selectedRun(true, { opsText: opsYaml.replace("depends_on: []", "depends_on: [PUB-A]") });
  assert.deepEqual(waiting.ran, ["PUB-A", "OPS-T1", "PUB-B"]);
  // W1-T13749: the reversed edge holds the public task that names the ops id, never the ops catalog.
  const reversed = await selectedRun(true, { reversePublicEdge: true });
  assert.ok(!reversed.ran.includes("PUB-A"));
  assert.deepEqual(reversed.ran, ["OPS-T1", "PUB-B"]);
  assert.equal(reversed.rows.some(row => row.step === "dispatch.ops_catalog_held"), false);
  assert.deepEqual(reversed.rows.filter(row => row.step === "dispatch.ops_task_held").map(row => row.data),
    [{ task: "PUB-A", outcome: "invalid_cross_catalog_dependency", edge: "PUB-A -> OPS-T1" }]);
});

test("W1-T12209 criterion 1: a completed ops lane refills from the combined priority frontier while public work runs", { timeout: 30_000 }, async t => {
  const first = opsYaml + "  files: [src/ops-one.ts]\n";
  const second = opsYaml.replace("OPS-T1", "OPS-T2").replace("depends_on: []", "depends_on: [OPS-T1]") + "  files: [src/ops-two.ts]\n";
  const result = await selectedRun(true, { refillWhilePublicRuns: true, signal: t.signal, opsText: first + second });
  assert.deepEqual(result.ran, ["OPS-T1", "PUB-A", "OPS-T2"]);
  assert.ok(result.rows.some(row => row.step === "dispatch.lane_refilled" && row.data.next_task === "OPS-T2"));
});

test("W1-T12209 criterion 3: a duplicate refuses the ops snapshot and reports the public id once", async () => {
  // W1-T13749: the duplicate holds both copies of the public id, never the ops task beside it.
  const duplicate = await selectedRun(true, { opsText: opsYaml.replace("OPS-T1", "PUB-A") + opsYaml });
  assert.deepEqual(duplicate.ran, ["OPS-T1", "PUB-B", "PUB-C"]);
  assert.equal(duplicate.rows.some(row => row.step === "dispatch.ops_catalog_held"), false);
  const refusals = duplicate.rows.filter(row => row.step === "dispatch.ops_task_held");
  assert.equal(refusals.length, 1);
  assert.deepEqual(refusals[0]!.data, { task: "PUB-A", outcome: "duplicate_task_id", edge: "PUB-A in both catalogs" });
});

test("W1-T13749 criterion 7: the real runner refuses an ops task the composition holds before any worker starts, while the sound one beside it dispatches", async () => {
  const held = opsYaml.replace("OPS-T1", "OPS-T2").replace("depends_on: []", "depends_on: [W1-T900099]");
  const result = await selectedRun(true, { realHeldRun: "OPS-T2", opsText: opsYaml + held });
  assert.equal(result.ran.includes("OPS-T2"), false, "the daemon never dispatches the held task");
  assert.equal(result.ran[0], "OPS-T1", JSON.stringify(result.ran));
  const probes = result.rows.filter(row => row.step === "fixture.real_held_run");
  assert.ok(probes.length > 0, "positive control: the real runner was asked to run the held task");
  for (const probe of probes) {
    assert.equal(probe.data.reachedWorker, false, JSON.stringify(probe));
    assert.match(String(probe.data.failure), /task catalog unreadable \(ops-held-invalid_cross_catalog_dependency\)/);
  }
});

test("W1-T12209 criterion 4: the actual command worker path reserves the public ref and a rival cannot take it", async () => {
  const result = await selectedRun(true, { realClaims: true });
  assert.deepEqual(result.ran, ["OPS-T1", "PUB-A", "PUB-B"], JSON.stringify(result.rows));
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0]!.task, "OPS-T1");
  assert.equal(result.claims[0]!.unchangedAfterRival, true);
  assert.equal(result.claims[0]!.privateRefs, "");
});

test("W1-T12209 criterion 5: unavailable private evidence preserves public work and reports only an outcome code", async () => {
  for (const [error, outcome] of [[new OpsCatalogAuthMissingError(), "auth_missing"], [new Error(PRIVATE), "unreadable"]] as const) {
    const result = await selectedRun(true, { apiError: error });
    assert.deepEqual(result.ran, ["PUB-A", "PUB-B", "PUB-C"]);
    assert.equal(result.rows.filter(row => row.step === "dispatch.ops_catalog_held" && row.data.outcome === outcome).length, 1);
    assert.doesNotMatch(JSON.stringify(result.rows), new RegExp(PRIVATE));
  }
});

test("W1-T12209 criterion 5: completed private evidence expires while the next real GET is hung", async () => {
  const result = await selectedRun(true, { expireAfterWarm: true });
  // W1-T14564 (operator ruling 2026-11-23): past the bound the completed snapshot is still served, so the ops task
  // dispatches beside public work and no stale hold is written.
  assert.deepEqual(result.ran, ["OPS-T1", "PUB-A", "PUB-B"], JSON.stringify(result.rows));
  assert.equal(result.rows.filter(row => row.step === "dispatch.ops_catalog_held").length, 0);
  assert.doesNotMatch(JSON.stringify(result.rows), new RegExp(PRIVATE));
});

test("W1-T12209 criterion 5: final admission rereads a disabled changed or unreadable host selection", async () => {
  for (const selectionAtAdmission of ["off", "changed", "unreadable"] as const) {
    const result = await selectedRun(true, { selectionAtAdmission });
    assert.deepEqual(result.ran, ["PUB-A", "PUB-B", "PUB-C"]);
    assert.ok(result.rows.some(row => row.step === "dispatch.ops_catalog_held"));
    assert.doesNotMatch(JSON.stringify(result.rows), new RegExp(PRIVATE));
  }
});

test("owner STOP and PAUSE outrank a selected private catalog without starting a worker", async () => {
  for (const ownerHold of ["stop", "pause"] as const) {
    const result = await selectedRun(true, { ownerHold });
    assert.deepEqual(result.ran, []);
    assert.equal(result.claims.length, 0);
    if (ownerHold === "pause") assert.ok(result.rows.some(row => row.step === "daemon.pause"));
  }
});

test("W1-T12209 criterion 5: incomplete identities and throwing readers or diagnostics never authorize ops", async () => {
  for (const coreRefusal of ["throw", "missing-plan", "unreadable", "public-revision", "ops-revision", "identity"] as const) {
    const result = await selectedRun(true, { coreRefusal, throwingHoldLog: coreRefusal === "throw" });
    assert.deepEqual(result.ran, ["PUB-A", "PUB-B", "PUB-C"], coreRefusal);
    const expected = { throw: "selection_unreadable", "missing-plan": "source_identity_unknown", unreadable: "unreadable",
      "public-revision": "primary_revision_unknown", "ops-revision": "source_identity_unknown", identity: "source_identity_unknown" };
    assert.deepEqual(result.rows.filter(row => row.step === "dispatch.ops_catalog_held").map(row => row.data.outcome), [expected[coreRefusal]],
      "the exact fault reason is deduplicated even if its diagnostic throws");
    assert.doesNotMatch(JSON.stringify(result.rows), new RegExp(PRIVATE));
  }
});

test("W1-T12209 criterion 5: invalid named repository refuses before any private GET", async () => {
  const result = await selectedRun(true, { selectionRecord: { repository: "not a repository", kinds: [], dispatch_ops_tasks: true } });
  assert.deepEqual(result.ran, ["PUB-A", "PUB-B", "PUB-C"]);
  assert.deepEqual(result.reads, []);
  assert.ok(result.rows.some(row => row.step === "dispatch.ops_catalog_held" && row.data.outcome === "selection_unreadable"));
});

test("W1-T12209 criterion 5: rejected refresh remains unreadable using the real default clock", async () => {
  const feed = opsCatalogShadowFeed({ refresh: async () => { throw new Error(PRIVATE); } });
  assert.equal(feed.current(), undefined);
  await delay(0);
  assert.deepEqual(feed.forDispatch(), { outcome: "unreadable", refusalStage: "source_refresh" });
  assert.doesNotMatch(JSON.stringify(feed.forDispatch()), new RegExp(PRIVATE));
});

test("W1-T12209 criterion 6: public shadow value context is measured and failed comparison stays unknown", () => {
  const primary = mergePlanBlobs([{ label: "public fixture", text: publicYaml }]);
  const secondary = mergePlanBlobs([{ label: "private fixture", text: opsYaml }]);
  const context = { scoreByClass: new Map<string, number>(), openDependentFanoutByTaskId: new Map<string, number>() };
  const healthy = compareSecondaryCatalogShadow(primary, secondary, undefined, () => false, 1, { dispatchValueContext: context });
  assert.equal(healthy?.outcome, "compared");
  assert.equal(healthy.primary_candidate_count, 1);
  const refused = compareSecondaryCatalogShadow(primary, secondary, undefined, () => { throw new Error(PRIVATE); }, 1, { dispatchValueContext: context });
  assert.deepEqual(refused, { outcome: "comparison_failed", basis: "cached_projection", primary_candidate_count: null,
    combined_candidate_count: null, secondary_candidate_count: null, displaced_primary_count: null });
  assert.doesNotMatch(JSON.stringify(refused), new RegExp(PRIVATE));
});

test("only a literal true host flag may enable private dispatch", async () => {
  for (const flag of [undefined, "true", 1, null, {}, []]) {
    const result = await selectedRun(flag);
    assert.deepEqual(result.ran, ["PUB-A", "PUB-B", "PUB-C"]);
    assert.deepEqual(result.reads, []);
  }
});
