import "#src/lib/live-analytics-snapshot-cache.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as flush, setTimeout as delay } from "node:timers/promises";
import { ghShim } from "#test/helpers/gh-shim.js";
import { test, type TestContext } from "node:test";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { runDaemon, type DaemonDeps, type DaemonSummary } from "#src/lib/daemon.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import type { GitHub } from "#src/lib/status.js";
import { OpsCatalogAuthMissingError, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import type { Plan } from "#src/lib/plan.js";

type Deps = NonNullable<Parameters<typeof daemonCommand>[1]>;
const stopped: DaemonSummary = { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
const REPOSITORY = "fixture-private/ops";
const task = (id: string, title = id, deps: string[] = []) => `- id: ${id}\n  title: ${title}\n  repo: remudero\n  type: implement\n  priority: 1\n  depends_on: ${JSON.stringify(deps)}\n`;

function commandFixture(t: TestContext) {
  const origin = gitRepo({ bare: true, scope: t, kind: "ops-shadow-origin" });
  const repo = gitRepo({ scope: t, kind: "ops-shadow-public" });
  mkdirSync(join(repo.dir, "plan"));
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), task("PUBLIC-T1") + task("PUBLIC-T2"));
  repo.git("add", "plan/tasks.yaml"); repo.git("commit", "-qm", "fixture public plan");
  repo.addRemote("origin", origin.dir); repo.git("push", "-u", "origin", "main");
  const commit = repo.git("rev-parse", "HEAD");
  const root = ownedFixtureDir(t, "ops-shadow-instance").dir;
  mkdirSync(join(root, "state"));
  const saved = new Map(["REMUDERO_RUN_ID", "RMD_INSTANCE_REGISTRY", "RMD_SELECTED_INSTANCE_REGISTRY"].map(k => [k, process.env[k]]));
  delete process.env.RMD_INSTANCE_REGISTRY; delete process.env.RMD_SELECTED_INSTANCE_REGISTRY;
  process.env.REMUDERO_RUN_ID = "DAEMON-W11770-FIXTURE";
  t.after(() => { for (const [k, value] of saved) { if (value === undefined) delete process.env[k]; else process.env[k] = value; } });
  const calls: unknown[] = [], effects: unknown[] = [];
  let boots = 0;
  const board: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined,
    listOpenHeadBranches: () => { calls.push("public-open-heads"); return []; } };
  const base: Deps = {
    config: { root, claudeBin: "/bin/true" }, repoRoot: repo.dir,
    githubFactory: () => { calls.push("public-gateway"); return board; },
    startGithubAppRefresh: () => ({ armed: false }), startGitCredentialSocket: async () => undefined,
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => { boots++; return { env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }; },
    checkPause: () => undefined, checkStop: () => undefined, readRunChildMode: () => "off",
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
    wireSweepWake: () => ({ sleep: async () => "timeout", acknowledge: () => {}, close: () => {} }),
    startMemoryCensus: () => () => {},
    runTask: async (...args) => { effects.push(["worker-options", args]); throw Error("fixture worker trap"); },
    fixCommand: async args => { effects.push(["fix", args]); return 0; },
    reviewCommand: async (...args) => { effects.push(["review", args]); return 0; },
  };
  return { root, repo, commit, calls, effects, boots: () => boots,
    run: (extra: string[], api: OpsCatalogApi | undefined, loop: (plan: Plan, ports: DaemonDeps) => Promise<DaemonSummary>, literal = false, source?: Deps["opsCatalogSource"]) =>
      daemonCommand(["--repo", "remudero", "--allow-self-target", "--max", "0", ...(literal ? ["--plan", join(repo.dir, "plan", "tasks.yaml")] : []), ...extra],
        { ...base, ...(api ? { opsCatalogApi: api } : {}), ...(source ? { opsCatalogSource: source } : {}), runDaemon: async (plan, ports) => loop(plan, ports) }),
  };
}

function catalog(text: string, absent = false) {
  const hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(text + String(absent)), tree = hash(commit + "root"), plan = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`), calls: string[] = [];
  const api: OpsCatalogApi = async path => {
    calls.push(path); const prefix = `repos/${REPOSITORY}`;
    if (path === prefix) return { id: 42, full_name: REPOSITORY, default_branch: "main" };
    if (path === `${prefix}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${prefix}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${prefix}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: absent ? [] : [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] };
    if (path === `${prefix}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
    assert.equal(path, `${prefix}/git/blobs/${blob}`, "only the recorded GET-only corpus is reachable");
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  };
  return { api, commit, calls };
}

async function drive(plan: Plan, ports: Pick<DaemonDeps, "secondaryCatalogShadowSource" | "primaryPlanCommit"> = {}) {
  const merged = new Set<string>(), workers: string[] = [], rows: Record<string, unknown>[] = [], effects: unknown[] = [];
  let turns = 0;
  const summary = await runDaemon(plan, {
    checkStop: () => ++turns > 8 ? "bounded fixture exhausted" : undefined,
    refreshMerged: () => id => merged.has(id), targetRepo: "remudero",
    runOne: async id => { workers.push(id); merged.add(id); return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" }; },
    sleep: async () => { await flush(); }, now: () => new Date("2026-01-01T00:00:00Z"), bootCheckoutBlocked: "",
    memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), heapUsed: () => 1, setFlags: () => {} }),
    heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
    log: (step, extra = {}) => { if (step === "dispatch.secondary_catalog_shadow") rows.push(extra); else effects.push([step, extra]); },
    ...(ports.secondaryCatalogShadowSource ? { secondaryCatalogShadowSource: ports.secondaryCatalogShadowSource } : {}),
    ...(ports.primaryPlanCommit ? { primaryPlanCommit: ports.primaryPlanCommit } : {}),
  }, { max: 2 });
  assert.deepEqual(workers, ["PUBLIC-T1", "PUBLIC-T2"], JSON.stringify({ summary, effects: effects.slice(-12) }));
  return { workers, merged: summary.merged, rows, effects: JSON.stringify(effects) };
}

for (const outcome of ["source_absent", "unreadable", "auth_missing"] as const) {
  test(`W1-T11770 criterion 2: real command observes ${outcome} while public dispatch remains byte-identical`, async t => {
    const f = commandFixture(t), fx = catalog(task("OPS-T1"), true);
    const api: OpsCatalogApi = outcome === "source_absent" ? fx.api : async () => { if (outcome === "auth_missing") throw new OpsCatalogAuthMissingError(); throw Error("PRIVATE_TITLE_SENTINEL"); };
    let visited = false;
    assert.equal(await f.run(["--shadow-ops-catalog", REPOSITORY], api, async (plan, ports) => {
      visited = true; await flush();
      assert.equal(ports.primaryPlanCommit?.(), f.commit, "the real public plan reader supplies its verified commit");
      assert.equal(ports.secondaryCatalogShadowSource?.()?.outcome, outcome);
      const baseline = await drive(plan), observed = await drive(plan, ports);
      assert.deepEqual(observed.workers, baseline.workers); assert.deepEqual(observed.merged, baseline.merged); assert.equal(observed.effects, baseline.effects);
      assert.ok(observed.rows.some(r => r.outcome === outcome));
      assert.doesNotMatch(JSON.stringify(observed.rows), /PRIVATE_TITLE_SENTINEL|fixture-private/);
      return stopped;
    }), 0); assert.equal(visited, true);
  });
}
test("W1-T11770 criterion 2: a changed ops revision is refreshed off the loop without restarting or leaking to effect ports", async t => {
  const f = commandFixture(t), first = catalog(task("OPS-T1", "PRIVATE_TITLE_SENTINEL_A", ["PUBLIC-T1"])), next = catalog(task("OPS-T1", "PRIVATE_TITLE_SENTINEL_B", ["PUBLIC-T1"]));
  let current = first, visited = false;
  assert.equal(await f.run(["--shadow-ops-catalog", REPOSITORY], path => current.api(path), async (plan, ports) => {
    visited = true; await flush(); const before = ports.secondaryCatalogShadowSource?.();
    assert.equal(before?.outcome, "ok"); assert.equal(before?.opsCommit, first.commit);
    const getCount = first.calls.length; for (let i = 0; i < 5; i++) ports.secondaryCatalogShadowSource?.();
    assert.equal(first.calls.length, getCount, "ticks read only the cached accessor, never the async transport");
    const baseline = await drive(plan), observed = await drive(plan, ports);
    assert.deepEqual(observed.workers, baseline.workers); assert.equal(observed.effects, baseline.effects);
    current = next;
    await ports.sleepUntilSweepWake!(0); await flush();
    const after = ports.secondaryCatalogShadowSource?.(); assert.equal(after?.outcome, "ok"); assert.equal(after?.opsCommit, next.commit);
    const changed = await drive(plan, ports); assert.notEqual(changed.rows[0]?.revision_key_digest, observed.rows[0]?.revision_key_digest);
    await ports.runPrAction!({ action: "review", prNumber: 1 } as Parameters<NonNullable<DaemonDeps["runPrAction"]>>[0]);
    await assert.rejects(ports.runOne("PUBLIC-T1"), /fixture worker trap/);
    assert.doesNotMatch(JSON.stringify(f.effects), /fixture-private|PRIVATE_TITLE_SENTINEL/);
    assert.equal(f.boots(), 1); return stopped;
  }), 0); assert.equal(visited, true);
});
test("W1-T11770 criterion 2: a hung refresh cannot delay the first tick or add overlapping reads", async t => {
  const f = commandFixture(t); let reads = 0, visited = false;
  const api: OpsCatalogApi = () => { reads++; return new Promise(() => {}); };
  let deadline!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(Error("private refresh blocked public command")), 5000); });
  try {
  assert.equal(await Promise.race([f.run(["--shadow-ops-catalog", REPOSITORY], api, async (plan, ports) => {
    visited = true; assert.equal(typeof ports.secondaryCatalogShadowSource, "function");
    const result = await drive(plan, ports); assert.deepEqual(result.workers, ["PUBLIC-T1", "PUBLIC-T2"]);
    assert.notEqual(ports.secondaryCatalogShadowSource?.()?.outcome, "ok");
    const count = reads; await ports.sleepUntilSweepWake!(0); await flush(); assert.equal(reads, count, "only one selected-source refresh may be in flight");
    return stopped;
  }), timeout]), 0); assert.equal(visited, true);
  } finally { clearTimeout(deadline); }
});
test("W1-T11770 criterion 2: a literal public plan keeps its revision UNKNOWN instead of inventing one", async t => {
  const f = commandFixture(t), fx = catalog(task("OPS-T1")); let visited = false;
  assert.equal(await f.run(["--shadow-ops-catalog", REPOSITORY], fx.api, async (plan, ports) => {
    visited = true; await flush(); assert.equal(ports.secondaryCatalogShadowSource?.()?.outcome, "ok"); assert.equal(ports.primaryPlanCommit?.(), undefined);
    const result = await drive(plan, ports); assert.ok(result.rows.some(r => r.outcome === "primary_revision_unknown"));
    return stopped;
  }, true), 0); assert.equal(visited, true);
});

test("W1-T11770 criterion 2: the real default transport shells out read-only and reduces credential failure to a code", async t => {
  const f = commandFixture(t);
  const shim = ghShim([{ when: `repos/${REPOSITORY}`, stderr: "HTTP 401: Bad credentials", exit: 1 }]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
  try {
    assert.equal(await f.run(["--shadow-ops-catalog", REPOSITORY], undefined, async (_plan, ports) => {
      for (let i = 0; i < 100 && ports.secondaryCatalogShadowSource?.() === undefined; i++) await delay(50);
      assert.equal(ports.secondaryCatalogShadowSource?.()?.outcome, "auth_missing");
      return stopped;
    }), 0);
    assert.ok(shim.calls().length > 0, "the actual default child reached the recording executable");
    assert.ok(shim.calls().every(call => call.includes(`api repos/${REPOSITORY}`) && !/POST|PATCH|PUT|DELETE/.test(call)));
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
});
test("W1-T11770 criterion 2: an unexpected refresh rejection is redacted and never rejects the public command", async t => {
  const f = commandFixture(t);
  assert.equal(await f.run(["--shadow-ops-catalog", REPOSITORY], undefined, async (plan, ports) => {
    await flush(); assert.deepEqual(ports.secondaryCatalogShadowSource?.(), { outcome: "unreadable" });
    const result = await drive(plan, ports); assert.ok(result.rows.some(row => row.outcome === "unreadable"));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TITLE_SENTINEL|fixture-private/); return stopped;
  }, false, { refresh: async () => { throw Error("PRIVATE_TITLE_SENTINEL"); } }), 0);
});
test("W1-T11770 criterion 2: shutdown discards a late source result and prevents any later refresh", async t => {
  const f = commandFixture(t); let reads = 0;
  let finish!: (value: { outcome: "unreadable" }) => void;
  let accessor!: NonNullable<DaemonDeps["secondaryCatalogShadowSource"]>;
  let wake!: NonNullable<DaemonDeps["sleepUntilSweepWake"]>;
  assert.equal(await f.run(["--shadow-ops-catalog", REPOSITORY], undefined, async (_plan, ports) => {
    accessor = ports.secondaryCatalogShadowSource!; wake = ports.sleepUntilSweepWake!;
    assert.equal(accessor(), undefined); return stopped;
  }, false, { refresh: () => { reads++; return new Promise(resolve => { finish = resolve; }); } }), 0);
  finish({ outcome: "unreadable" }); await flush();
  assert.equal(accessor(), undefined); await wake(0); await flush(); assert.equal(reads, 1);
});
