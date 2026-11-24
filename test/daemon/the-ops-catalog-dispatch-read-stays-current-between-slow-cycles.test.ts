import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mock, test } from "node:test";
// Load the existing analytics side of the daemon's import cycle first.
import "#src/lib/live-analytics-snapshot-cache.js";
import { runDaemon, type DaemonDeps, type OpsTaskDispatchRead } from "#src/lib/daemon.js";
import { OPS_DISPATCH_SOURCE_MAX_AGE_MS, OPS_DISPATCH_SOURCE_REFRESH_MS, opsCatalogShadowFeed } from "#src/cli/commands/daemon.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import { createOpsCatalogShadowSource, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import type { Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY, type GitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

type CommandDeps = NonNullable<Parameters<typeof daemonCommand>[1]>;
type Row = { step: string; data: Record<string, unknown> };
const REPOSITORY = "fixture-private/ops";
const PREFIX = `repos/${REPOSITORY}`;
const REF = `${PREFIX}/git/ref/heads/main`;
const CYCLE_MS = 240_000;
const publicYaml = ["PUB-A", "PUB-B"].map((id, i) =>
  `- id: ${id}\n  title: public ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  priority: ${i + 1}\n  depends_on: []\n`).join("");
const opsYaml = (title: string) => `- id: OPS-T1\n  title: ${title}\n  repo: remudero\n  type: implement\n` +
  "  verify: auto\n  priority: 0\n  depends_on: []\n";

/** A GET-only catalog over a real git repository: every answer carries real git object ids. */
function catalog(ops: GitRepo): { api: OpsCatalogApi; reads: string[]; publish(text: string): string; hold(on: boolean): void; fail(on: boolean): void } {
  const routes = new Map<string, unknown>();
  const reads: string[] = [];
  let hung = false, failing = false;
  const publish = (text: string): string => {
    mkdirSync(join(ops.dir, "plan"), { recursive: true });
    writeFileSync(join(ops.dir, "plan", "tasks.yaml"), text);
    ops.git("add", "plan/tasks.yaml");
    ops.git("commit", "-qm", "fixture catalog");
    const commit = ops.git("rev-parse", "HEAD"), tree = ops.git("rev-parse", "HEAD^{tree}");
    const planTree = ops.git("rev-parse", "HEAD:plan"), blob = ops.git("rev-parse", "HEAD:plan/tasks.yaml");
    routes.set(PREFIX, { id: 42, full_name: REPOSITORY, default_branch: "main" });
    routes.set(REF, { object: { type: "commit", sha: commit } });
    routes.set(`${PREFIX}/git/commits/${commit}`, { sha: commit, tree: { sha: tree } });
    routes.set(`${PREFIX}/git/trees/${tree}`, { sha: tree, truncated: false, tree: [{ path: "plan", sha: planTree, type: "tree", mode: "040000" }] });
    routes.set(`${PREFIX}/git/trees/${planTree}`, { sha: planTree, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] });
    routes.set(`${PREFIX}/git/blobs/${blob}`, { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") });
    return commit;
  };
  const api: OpsCatalogApi = async (path) => {
    reads.push(path);
    if (hung) return new Promise<never>(() => {});
    if (failing) throw new Error("fixture transport failure");
    assert.ok(routes.has(path), `undeclared GET route: ${path}`);
    return routes.get(path);
  };
  return { api, reads, publish, hold: (on) => { hung = on; }, fail: (on) => { failing = on; } };
}

/** Advance the injected clock and the mocked interval together, letting each started refresh settle. */
async function advance(ms: number, clock: { now: number }): Promise<void> {
  for (let left = ms; left > 0; left -= 15_000) {
    const step = Math.min(15_000, left);
    clock.now += step;
    mock.timers.tick(step);
    await delay(2);
  }
}

async function commandRun(): Promise<{ outcomes: string[]; rows: Row[]; ran: string[]; readsAfterExit: number; readsAtExit: number }> {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ops-refresh-command-`));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/false" }));
  writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify({ repository: REPOSITORY, kinds: [], dispatch_ops_tasks: true }));
  const primary = gitRepo({ kind: "ops-refresh-public" });
  const origin = gitRepo({ bare: true, kind: "ops-refresh-public-origin" });
  const ops = gitRepo({ kind: "ops-refresh-private" });
  primary.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  primary.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  mkdirSync(join(primary.dir, "plan"));
  writeFileSync(join(primary.dir, "plan", "tasks.yaml"), publicYaml);
  primary.git("add", "plan/tasks.yaml");
  primary.git("commit", "-qm", "fixture catalog");
  primary.addRemote("origin", origin.dir);
  primary.git("push", "-qu", "origin", "main");
  const source = catalog(ops);
  source.publish(opsYaml("allowed private task"));
  const shim = ghShim([{ when: "", exit: 97, stderr: "forbidden external fixture GitHub effect" }], { kind: "ops-refresh-deny" });
  const priorHome = process.env.HOME, priorPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${shim.dir}:${priorPath ?? ""}`;
  const clock = { now: Date.now() };
  const outcomes: string[] = [], rows: Row[] = [], ran: string[] = [];
  const merged = new Set<string>();
  let stopped = false;
  mock.timers.enable({ apis: ["setInterval"] });
  const deps: CommandDeps = {
    config: { root, claudeBin: "/bin/false" }, repoRoot: primary.dir, opsCatalogApi: source.api, now: () => clock.now,
    githubFactory: () => ({}) as never, startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
    checkPause: () => undefined, checkStop: () => stopped ? "fixture owner stop" : undefined, readRunChildMode: () => "off",
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
    runTask: async (id) => { ran.push(id); return { taskId: id, runId: `${id}-fixture`, merged: true, costUsd: 0, verdict: "merged" }; },
    runDaemon: async (plan: Plan, wired: DaemonDeps) => {
      // The first read starts unawaited at boot; wait for it to complete, then let a whole slow cycle pass.
      for (let i = 0; i < 400 && wired.readOpsTaskDispatch?.(plan).outcome !== "selected"; i++) await delay(5);
      assert.equal(wired.readOpsTaskDispatch?.(plan).outcome, "selected", "positive control: the first read completed");
      await advance(CYCLE_MS, clock);
      await runDaemon(plan, {
        refreshMerged: () => id => merged.has(id), targetRepo: "remudero",
        runOne: async id => { const result = await wired.runOne(id); merged.add(id); return result; },
        checkPause: () => undefined, checkStop: () => stopped ? "fixture owner stop" : undefined,
        sleep: async () => { await advance(CYCLE_MS, clock); },
        log: (step, data = {}) => { rows.push({ step, data }); },
        memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {}, heapUsed: () => 1 }),
        heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
        now: () => new Date(clock.now), bootCheckoutBlocked: "",
        secondaryCatalogShadowSource: wired.secondaryCatalogShadowSource, primaryPlanCommit: wired.primaryPlanCommit,
        readOpsTaskDispatch: (publicPlan: Plan): OpsTaskDispatchRead => {
          const read = wired.readOpsTaskDispatch!(publicPlan);
          outcomes.push(read.outcome);
          return read;
        },
      }, { max: 3 });
      stopped = true;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  };
  try {
    await daemonCommand(["--allow-self-target", "--max", "0"], deps);
    const readsAtExit = source.reads.length;
    await advance(3 * OPS_DISPATCH_SOURCE_REFRESH_MS, clock);
    return { outcomes, rows, ran, readsAtExit, readsAfterExit: source.reads.length };
  } finally {
    mock.timers.reset();
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    rmSync(shim.dir, { recursive: true, force: true });
    primary.cleanup(); origin.cleanup(); ops.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

test("W1-T13052 criterion 1: with cycles 240 s apart every cycle selects and no stale hold is written", async () => {
  const result = await commandRun();
  assert.ok(result.outcomes.length >= 1, JSON.stringify(result.rows.map(row => row.step)));
  assert.deepEqual(result.outcomes.filter(outcome => outcome !== "selected"), [], JSON.stringify(result.outcomes));
  assert.equal(result.ran[0], "OPS-T1", JSON.stringify(result.ran));
  assert.equal(result.rows.filter(row => row.step === "dispatch.ops_catalog_held" && row.data.outcome === "stale").length, 0);
});

test("W1-T13052 criterion 2: the feed refreshes on its own unref'd timer and the daemon command stops it", async () => {
  assert.ok(OPS_DISPATCH_SOURCE_REFRESH_MS * 2 < OPS_DISPATCH_SOURCE_MAX_AGE_MS);
  // Unref'd: the real timer does not hold the process open.
  const before = process.getActiveResourcesInfo().filter(kind => kind === "Timeout").length;
  const live = opsCatalogShadowFeed({ refresh: async () => ({ outcome: "unreadable" }) }, undefined, { refreshEveryMs: OPS_DISPATCH_SOURCE_REFRESH_MS });
  assert.equal(process.getActiveResourcesInfo().filter(kind => kind === "Timeout").length, before);
  live.stop();
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let refreshes = 0;
    const feed = opsCatalogShadowFeed({ refresh: async () => { refreshes += 1; return { outcome: "unreadable" }; } }, undefined,
      { refreshEveryMs: OPS_DISPATCH_SOURCE_REFRESH_MS });
    mock.timers.tick(OPS_DISPATCH_SOURCE_REFRESH_MS - 1);
    assert.equal(refreshes, 0);
    mock.timers.tick(1);
    await delay(1);
    assert.equal(refreshes, 1, "the timer refreshed with no current() call");
    mock.timers.tick(OPS_DISPATCH_SOURCE_REFRESH_MS);
    await delay(1);
    assert.equal(refreshes, 2);
    feed.stop();
    mock.timers.tick(3 * OPS_DISPATCH_SOURCE_REFRESH_MS);
    await delay(1);
    assert.equal(refreshes, 2, "stop() ends the refreshes");
  } finally {
    mock.timers.reset();
  }
  const result = await commandRun();
  assert.ok(result.readsAtExit > 0);
  assert.equal(result.readsAfterExit, result.readsAtExit, "the daemon command's cleanup list stopped the timer");
});

test("W1-T13052 criterion 3: an unmoved branch revalidates with one ref GET and a moved branch rereads it all", async () => {
  const ops = gitRepo({ kind: "ops-refresh-revalidate" });
  try {
    const source = catalog(ops);
    const first = source.publish(opsYaml("first private title"));
    const shadow = createOpsCatalogShadowSource({ repository: REPOSITORY }, source.api);
    const a = await shadow.refresh();
    assert.equal(a.outcome, "ok");
    assert.equal(a.opsCommit, first);
    const fullRead = source.reads.length;
    assert.ok(fullRead > 3, "positive control: the first read reads trees and blobs");
    source.reads.length = 0;
    const b = await shadow.refresh();
    assert.deepEqual(source.reads, [REF]);
    assert.equal(b.outcome, "ok");
    assert.equal(b.opsCommit, first);
    assert.equal(b.plan, a.plan);
    assert.equal(b.identityDigest, a.identityDigest);
    source.reads.length = 0;
    const second = source.publish(opsYaml("second private title"));
    const c = await shadow.refresh();
    assert.equal(c.outcome, "ok");
    assert.equal(c.opsCommit, second);
    assert.equal(c.plan?.byId.get("OPS-T1")?.title, "second private title");
    assert.ok(source.reads.some(path => path.includes("/git/trees/")), "a moved branch rereads the trees");
    assert.ok(source.reads.some(path => path.includes("/git/blobs/")), "a moved branch rereads the blobs");
  } finally {
    ops.cleanup();
  }
});

test("W1-T13052 criterion 4: failed or hung refreshes leave the dispatch read stale after the bound", async () => {
  const ops = gitRepo({ kind: "ops-refresh-expiry" });
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const clock = { now: 1_000_000 };
    // W1-T14564 (operator ruling 2026-11-23): a failed revalidation is answered by the kept snapshot, naming the refusal.
    const failing = catalog(ops);
    failing.publish(opsYaml("private title"));
    const failingSource = createOpsCatalogShadowSource({ repository: REPOSITORY }, failing.api);
    assert.equal((await failingSource.refresh()).outcome, "ok");
    failing.fail(true);
    const served = await failingSource.refresh();
    assert.equal(served.outcome, "ok");
    assert.ok(served.plan !== undefined, "the kept snapshot's plan is served");
    assert.deepEqual([served.lastGood?.refusal, served.lastGood?.refusalStage], ["stale", "branch_ref"]);
    // A hung refresh: the timer never stacks a second read; past the bound the completed evidence is still served.
    const hung = catalog(ops);
    hung.publish(opsYaml("private title again"));
    const feed = opsCatalogShadowFeed(createOpsCatalogShadowSource({ repository: REPOSITORY }, hung.api),
      clockFromMillisFn(() => clock.now), { refreshEveryMs: OPS_DISPATCH_SOURCE_REFRESH_MS });
    try {
      feed.current();
      await delay(5);
      assert.equal(feed.forDispatch()?.outcome, "ok", "positive control: a completed read is current");
      hung.hold(true);
      const atHold = hung.reads.length;
      // The W1-T12209 bound stays 120 s: a refresh timer, not a longer bound, keeps the read current.
      assert.equal(OPS_DISPATCH_SOURCE_MAX_AGE_MS, 120_000);
      await advance(120_000 - 1, clock);
      assert.equal(feed.forDispatch()?.outcome, "ok");
      assert.deepEqual(hung.reads.slice(atHold), [REF], "one hung refresh, never a second in flight");
      await advance(1, clock);
      const expired = feed.forDispatch();
      assert.equal(expired?.outcome, "ok");
      assert.deepEqual(expired?.lastGood, { refusal: "stale", refusalStage: "snapshot_age", snapshotAgeMs: 120_000 });
    } finally {
      feed.stop();
    }
  } finally {
    mock.timers.reset();
    ops.cleanup();
  }
});
