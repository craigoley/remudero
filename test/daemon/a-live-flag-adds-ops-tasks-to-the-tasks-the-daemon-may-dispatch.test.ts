import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
// Load the existing analytics side of the daemon's import cycle first.
import "#src/lib/live-analytics-snapshot-cache.js";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import type { Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

type CommandDeps = NonNullable<Parameters<typeof daemonCommand>[1]>;
type Row = { step: string; data: Record<string, unknown> };
const REPOSITORY = "fixture-private/ops";
const PRIVATE = "PRIVATE_TASK_NARRATIVE_SENTINEL";
const publicYaml = ["PUB-A", "PUB-B", "PUB-C"].map((id, i) =>
  `- id: ${id}\n  title: public ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  priority: ${i + 1}\n  depends_on: []\n`).join("");
const opsYaml = "- id: OPS-T1\n  title: allowed private task title\n  repo: remudero\n  type: implement\n" +
  `  verify: auto\n  priority: 0\n  depends_on: []\n  rationale: ${PRIVATE}\n`;
const LIVE_SEAMS = ["secondaryCatalogShadowSource", "primaryPlanCommit", "readOpsTaskDispatch"];

async function selectedRun(enabled: boolean): Promise<{ code: number; ran: string[]; reads: string[]; rows: Row[] }> {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ops-dispatch-command-`));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/false" }));
  writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify({ repository: REPOSITORY, kinds: [], dispatch_ops_tasks: enabled }));
  const primary = gitRepo({ kind: "ops-dispatch-public" });
  const origin = gitRepo({ bare: true, kind: "ops-dispatch-public-origin" });
  const secondary = gitRepo({ kind: "ops-dispatch-private" });
  for (const [repo, yaml] of [[primary, publicYaml], [secondary, opsYaml]] as const) {
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
    [`${prefix}/git/blobs/${blob}`, { sha: blob, encoding: "base64", size: Buffer.byteLength(opsYaml), content: Buffer.from(opsYaml).toString("base64") }],
  ]);
  const reads: string[] = [], rows: Row[] = [], ran: string[] = [];
  const api: OpsCatalogApi = async path => {
    reads.push(path);
    assert.ok(routes.has(path), `undeclared GET route: ${path}`);
    return routes.get(path);
  };
  const shim = ghShim([{ when: "", exit: 97, stderr: "forbidden external fixture GitHub effect" }], { kind: "ops-dispatch-deny-gh" });
  const priorHome = process.env.HOME, priorPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${shim.dir}:${priorPath ?? ""}`;
  let entered = false;
  const deps: CommandDeps = {
    config: { root, claudeBin: "/bin/false" }, repoRoot: primary.dir, opsCatalogApi: api,
    githubFactory: () => ({}) as never, startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
    checkPause: () => undefined, checkStop: () => undefined, readRunChildMode: () => "off",
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
    runDaemon: async (plan: Plan, wired: DaemonDeps) => {
      entered = true;
      // The injected GETs settle before the measured loop; there is no external API or model.
      await delay(25);
      const merged = new Set<string>();
      await runDaemon(plan, {
        refreshMerged: () => id => merged.has(id), targetRepo: "remudero",
        runOne: async id => { ran.push(id); merged.add(id); return { taskId: id, runId: `${id}-fixture`, merged: true, costUsd: 0, verdict: "merged" }; },
        sleep: async () => { await delay(1); }, log: (step, data = {}) => { rows.push({ step, data }); },
        memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {}, heapUsed: () => 1 }),
        heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
        now: () => new Date(), bootCheckoutBlocked: "",
        ...Object.fromEntries(LIVE_SEAMS.filter(key => key in wired).map(key => [key, (wired as unknown as Record<string, unknown>)[key]])),
      }, { max: 3 });
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  };
  try {
    const code = await daemonCommand(["--allow-self-target", "--max", "0"], deps);
    assert.equal(entered, true, "the real command reached its daemon-loop composition");
    return { code, ran, reads, rows };
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    rmSync(shim.dir, { recursive: true, force: true });
    primary.cleanup(); origin.cleanup(); secondary.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

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
