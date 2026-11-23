import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import "#src/lib/live-analytics-snapshot-cache.js";
import { OPS_DISPATCH_SOURCE_REFRESH_MS } from "#src/cli/commands/daemon.js";
import { runDaemon, type DaemonDeps, type DaemonSummary } from "#src/lib/daemon.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import type { Plan } from "#src/lib/plan.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

const REPOSITORY = "private-fixture/ops-fixture";
const OTHER_REPOSITORY = "private-other/ops-other";
const OPS_TASK = "OPS-T1";
const OPS_PLAN = `- id: ${OPS_TASK}
  title: fixture ops task
  repo: remudero
  type: implement
  verify: auto
  priority: 0
  depends_on: []
`;

function fixture(t: TestContext) {
  const { dir: home } = ownedFixtureDir(t, "live-ops-flag");
  const root = join(home, "Remudero"), state = join(root, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/false" }));
  mkdirSync(join(root, "repos", "ops-fixture", ".git"), { recursive: true });
  const writeFlag = (flag: unknown, repository = REPOSITORY) => {
    writeFileSync(join(state, "plan-destination.json"), JSON.stringify({ repository, kinds: [], dispatch_ops_tasks: flag }));
  };
  const primary = gitRepo({ scope: t });
  const origin = gitRepo({ scope: t, bare: true });
  const ops = gitRepo({ scope: t });
  for (const [repo, yaml] of [[primary, "[]\n"], [ops, OPS_PLAN]] as const) {
    mkdirSync(join(repo.dir, "plan"));
    writeFileSync(join(repo.dir, "plan", "tasks.yaml"), yaml);
    repo.git("add", "plan/tasks.yaml");
    repo.git("commit", "-qm", "fixture plan");
  }
  primary.addRemote("origin", origin.dir);
  primary.git("push", "-q", "origin", "main");
  const commit = ops.git("rev-parse", "HEAD"), tree = ops.git("rev-parse", "HEAD^{tree}");
  const planTree = ops.git("rev-parse", "HEAD:plan"), blob = ops.git("rev-parse", "HEAD:plan/tasks.yaml");
  const prefix = `repos/${REPOSITORY}`;
  const routes = new Map<string, unknown>([
    [prefix, { id: 42, full_name: REPOSITORY, default_branch: "main" }],
    [`${prefix}/git/ref/heads/main`, { object: { type: "commit", sha: commit } }],
    [`${prefix}/git/commits/${commit}`, { sha: commit, tree: { sha: tree } }],
    [`${prefix}/git/trees/${tree}`, { sha: tree, truncated: false, tree: [{ path: "plan", sha: planTree, type: "tree", mode: "040000" }] }],
    [`${prefix}/git/trees/${planTree}`, { sha: planTree, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] }],
    [`${prefix}/git/blobs/${blob}`, { sha: blob, encoding: "base64", size: Buffer.byteLength(OPS_PLAN), content: Buffer.from(OPS_PLAN).toString("base64") }],
  ]);
  const shim = ghShim([{ when: "", exit: 97 }], { kind: "live-ops-flag", parent: home });
  t.mock.property(process, "env", { ...process.env, HOME: home, PATH: `${shim.dir}:${process.env.PATH ?? ""}` });
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = Date.now();
  const advance = async () => {
    now += OPS_DISPATCH_SOURCE_REFRESH_MS;
    t.mock.timers.tick(OPS_DISPATCH_SOURCE_REFRESH_MS);
    await setImmediate();
  };
  const reads: string[] = [];
  const rows = (): Array<{ step: string; [key: string]: unknown }> =>
    readFileSync(join(state, "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const start = async (loop: (plan: Plan, wired: DaemonDeps) => Promise<void>) => {
    let entered = false;
    const code = await daemonCommand(["--allow-self-target", "--max", "0"], {
      config: { root, claudeBin: "/bin/false" }, repoRoot: primary.dir, now: () => now,
      opsCatalogApi: async path => {
        reads.push(path);
        assert.ok(routes.has(path), `undeclared catalog GET: ${path}`);
        return routes.get(path);
      },
      githubFactory: () => ({}) as never, startGithubAppRefresh: () => ({ armed: false }),
      applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
      daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
      checkPause: () => undefined, checkStop: () => undefined, readRunChildMode: () => "off",
      bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
      buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
      runDaemon: async (plan, wired): Promise<DaemonSummary> => {
        entered = true;
        await loop(plan, wired);
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(entered, "the command reached the loop");
  };
  return { advance, now: () => now, reads, rows, start, writeFlag, ghCalls: shim.calls };
}

test("W1-T13462 criterion 1: a daemon that boots with the flag absent dispatches ops work after it is enabled", async t => {
  const f = fixture(t);
  f.writeFlag(undefined);
  let sleeps = 0;
  const ran: string[] = [];
  await f.start(async (plan, wired) => {
    await runDaemon(plan, {
      readOpsTaskDispatch: wired.readOpsTaskDispatch,
      refreshMerged: () => () => false,
      runOne: async id => {
        ran.push(id);
        return { taskId: id, runId: "fixture", merged: true, costUsd: 0, verdict: "merged" };
      },
      checkStop: () => sleeps >= 4 ? "fixture finished" : undefined,
      checkPause: () => undefined,
      sleep: async () => {
        if (++sleeps === 1) {
          assert.deepEqual(f.reads, []);
          f.writeFlag(true);
        }
        await f.advance();
      },
      log: () => {},
      now: () => new Date(f.now()), bootCheckoutBlocked: "",
      memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {}, heapUsed: () => 1 }),
      heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
    }, { max: 1 });
  });
  assert.deepEqual(ran, [OPS_TASK]);
  assert.ok(f.reads.some(path => path.includes("/git/blobs/")), "the enabled cycle starts a real snapshot read");
  assert.deepEqual(f.rows().filter(row => row.step === "daemon.plan_destination").map(row => row.dispatch_ops), ["off"]);
});

test("W1-T13462 criterion 2: the boot and transition rows report dispatch selection without repository names", async t => {
  const f = fixture(t);
  f.writeFlag("on");
  await f.start(async (plan, wired) => {
    for (const flag of [false, false, true, true, "on", "on", false]) {
      f.writeFlag(flag);
      wired.readOpsTaskDispatch?.(plan);
    }
    await setImmediate();
  });
  const boot = f.rows().filter(row => row.step === "daemon.plan_destination");
  assert.deepEqual(boot.map(row => [row.dispatch_ops, row.dispatch_ops_reason]), [["unavailable", "invalid_dispatch_flag"]]);
  const changes = f.rows().filter(row => row.step === "dispatch.ops_selection_changed");
  assert.deepEqual(changes.map(row => [row.from, row.to, row.from_reason, row.to_reason]), [
    ["unavailable", "off", "invalid_dispatch_flag", undefined],
    ["off", "on", undefined, undefined],
    ["on", "unavailable", undefined, "invalid_dispatch_flag"],
    ["unavailable", "off", "invalid_dispatch_flag", undefined],
  ]);
  assert.doesNotMatch(JSON.stringify([...boot, ...changes]), /private-fixture|ops-fixture/);
});

test("W1-T13462 criterion 3: an off flag makes no private reads and stops admission on the next cycle", async t => {
  const f = fixture(t);
  f.writeFlag(true);
  await f.start(async (plan, wired) => {
    await f.advance();
    assert.equal(wired.readOpsTaskDispatch?.(plan).outcome, "selected", "the boot-on feed can dispatch");
    await setImmediate();
    assert.ok(f.reads.length > 0);
    f.writeFlag(false);
    const before = f.reads.length;
    const refreshRows = () => f.rows().filter(row => row.step === "dispatch.ops_catalog_refreshed").length;
    const refreshesBefore = refreshRows();
    assert.deepEqual(wired.readOpsTaskDispatch?.(plan), { outcome: "off" });
    await f.advance();
    await f.advance();
    assert.equal(f.reads.length, before, "the disabled feed makes no further catalog reads");
    assert.equal(refreshRows(), refreshesBefore, "off stops the refresh timer");
    f.writeFlag(true, OTHER_REPOSITORY);
    assert.deepEqual(wired.readOpsTaskDispatch?.(plan), { outcome: "unavailable", reason: "selection_changed" });
    assert.equal(f.reads.length, before, "the daemon stays bound to the original repository");
    f.writeFlag(undefined);
    assert.deepEqual(wired.readOpsTaskDispatch?.(plan), { outcome: "off" });
    f.writeFlag(true);
    assert.deepEqual(wired.readOpsTaskDispatch?.(plan), { outcome: "unavailable", reason: "source_pending" });
    await setImmediate();
    assert.equal(wired.readOpsTaskDispatch?.(plan).outcome, "selected", "a fresh read can restore admission");
    await setImmediate();
  });
  const before = f.reads.length;
  await f.advance();
  assert.equal(f.reads.length, before, "shutdown stops the replacement timer");
  assert.deepEqual(f.rows().filter(row => row.step === "daemon.plan_destination").map(row => row.dispatch_ops), ["on"]);
  assert.ok(f.ghCalls().every(call => !call.includes(REPOSITORY)));
});
