import "#src/lib/live-analytics-snapshot-cache.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
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
    run: (extra: string[], api: OpsCatalogApi | undefined, loop: (plan: Plan, ports: DaemonDeps) => Promise<DaemonSummary>, literal = false) =>
      daemonCommand(["--repo", "remudero", "--allow-self-target", "--max", "0", ...(literal ? ["--plan", join(repo.dir, "plan", "tasks.yaml")] : []), ...extra],
        { ...base, ...(api ? { opsCatalogApi: api } : {}), runDaemon: async (plan, ports) => loop(plan, ports) }),
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

test("W1-T11770 criterion 1: absence constructs no ops input and preserves the public loop bytes and calls", async t => {
  const f = commandFixture(t), fx = catalog(task("OPS-T1", "PRIVATE_TITLE_SENTINEL"));
  await fx.api(`repos/${REPOSITORY}`); assert.equal(fx.calls.length, 1, "positive control: the recorder sees its GET corpus"); fx.calls.length = 0;
  let visited = false;
  assert.equal(await f.run([], fx.api, async (plan, ports) => {
    visited = true;
    assert.equal("secondaryCatalogShadowSource" in ports, false);
    assert.equal("primaryPlanCommit" in ports, false);
    const baseline = await drive(plan), observed = await drive(plan, ports);
    assert.deepEqual(observed, baseline);
    return stopped;
  }), 0);
  assert.equal(visited, true); assert.deepEqual(fx.calls, []);
});
for (const slug of ["", "owner", "https://github.com/owner/repo", "owner/repo/extra", "owner/../repo", "owner/repo..", "/private/path", "owner/repo?token=private"]) {
  test(`W1-T11770 criterion 1: invalid slug ${JSON.stringify(slug)} refuses before boot or ops reads`, async t => {
    const f = commandFixture(t), fx = catalog(task("OPS-T1")); let loops = 0;
    const code = await f.run(["--shadow-ops-catalog", slug], fx.api, async () => { loops++; return stopped; });
    assert.equal(code, 2); assert.equal(f.boots(), 0); assert.equal(loops, 0); assert.deepEqual(fx.calls, []);
  });
}
