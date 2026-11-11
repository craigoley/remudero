import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
// The daemon and the live analytics cache import each other; the cache loads first (see the W1-T11769 tests).
import "#src/lib/live-analytics-snapshot-cache.js";
import { compositeCatalogRevisionKey, runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import { OpsCatalogAuthMissingError, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import type { Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim, type GhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

// W1-T11770 criterion 2: with --shadow-ops-catalog the daemon command feeds the ops catalog to the W1-T11769 shadow
// seam off the tick loop. Each case runs the real `daemonCommand` composition on a self-target git fixture, then the
// real `runDaemon` loop over the two seams that composition wired, so the primary commit is the fixture's own main.

type CommandDeps = NonNullable<Parameters<typeof daemonCommand>[1]>;
type Row = Record<string, unknown>;
const SLUG = "fixture-private/ops";
const SHADOW_SEAMS = ["secondaryCatalogShadowSource", "primaryPlanCommit"];
const PUBLIC_IDS = ["PUB-A", "PUB-B", "PUB-C", "PUB-D"];
const PLAN_YAML = PUBLIC_IDS.map((id) =>
  `- id: ${id}\n  title: public ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n`).join("");
const opsTask = (id: string) => `- id: ${id}\n  title: PRIVATE_TITLE_SENTINEL\n  repo: remudero\n  type: implement\n` +
  "  verify: auto\n  files: [private/PRIVATE_PATH_SENTINEL]\n  rationale: PRIVATE_BODY_SENTINEL\n  priority: 0\n  depends_on: []\n";
const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
const digestOf = (publicCommit: string, opsCommit: string) =>
  createHash("sha256").update(compositeCatalogRevisionKey(publicCommit, opsCommit)).digest("hex");

/** The GitHub REST answers for one ops commit, keyed by request path; `withPlan: false` has no plan directory. */
function opsCatalog(text: string, opts: { withPlan?: boolean } = {}): { commit: string; routes: Map<string, unknown> } {
  const commit = sha1(`commit ${text} ${opts.withPlan !== false}`);
  const tree = sha1(`${commit} root`);
  const planTree = sha1(`${commit} plan`);
  const blob = sha1(`blob ${Buffer.byteLength(text)}\0${text}`);
  const prefix = `repos/${SLUG}`;
  const entry = (path: string, sha: string, type: "tree" | "blob") => ({ path, sha, type, mode: type === "tree" ? "040000" : "100644" });
  const routes = new Map<string, unknown>([
    [prefix, { id: 42, full_name: SLUG, default_branch: "main" }],
    [`${prefix}/git/ref/heads/main`, { object: { type: "commit", sha: commit } }],
    [`${prefix}/git/commits/${commit}`, { sha: commit, tree: { sha: tree } }],
    [`${prefix}/git/trees/${tree}`, { sha: tree, truncated: false,
      tree: opts.withPlan === false ? [entry("README.md", sha1("readme"), "blob")] : [entry("plan", planTree, "tree")] }],
    [`${prefix}/git/trees/${planTree}`, { sha: planTree, truncated: false, tree: [entry("tasks.yaml", blob, "blob")] }],
    [`${prefix}/git/blobs/${blob}`, { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") }],
  ]);
  return { commit, routes };
}

/** A recording GET-only fake GitHub over a catalog the case may replace between ticks. */
function recordingApi(initial: ReturnType<typeof opsCatalog>) {
  let current = initial;
  const calls: string[] = [];
  const api: OpsCatalogApi = async (path) => {
    calls.push(path);
    if (!current.routes.has(path)) throw new Error(`fixture: no route for ${path}`);
    return current.routes.get(path);
  };
  return { api, calls, set: (next: ReturnType<typeof opsCatalog>) => { current = next; } };
}

interface Drive { ran: string[]; claims: string[]; shadow: Row[]; other: string; elapsedMs: number }

/** The real `runDaemon` loop over the two seams the command wired, with fake workers and fixed host readings. */
async function driveLoop(plan: Plan, wired: DaemonDeps, afterRun?: (count: number) => void): Promise<Drive> {
  const merged = new Set<string>();
  const ran: string[] = [];
  const claims: string[] = [];
  const shadow: Row[] = [];
  const other: Array<[string, Row]> = [];
  const started = performance.now();
  await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id), targetRepo: "remudero",
    runOne: async (id) => {
      claims.push(id);
      ran.push(id);
      // Let an in-flight refresh settle before the catalog changes, so the change lands between two reads.
      await delay(10);
      afterRun?.(ran.length);
      await delay(10);
      merged.add(id);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    sleep: async () => {},
    log: (step, extra = {}) => {
      if (step === "dispatch.secondary_catalog_shadow") shadow.push(extra);
      else other.push([step, extra]);
    },
    memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {}, heapUsed: () => 1 }),
    heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
    now: () => new Date(Date.UTC(2026, 0, 1)),
    bootCheckoutBlocked: "",
    ...Object.fromEntries(SHADOW_SEAMS.filter((seam) => seam in wired)
      .map((seam) => [seam, (wired as unknown as Record<string, unknown>)[seam]])),
  }, { max: PUBLIC_IDS.length });
  return { ran, claims, shadow, other: JSON.stringify(other), elapsedMs: performance.now() - started };
}

interface Outcome extends Drive { code: number; deps: DaemonDeps; publicCommit: string; ghCalls: string[]; files: string[]; texts: string }

/** Every file under `dir`, relative, with its text joined, for the effect and redaction sweeps. */
function filesUnder(dir: string): { files: string[]; texts: string } {
  const files: string[] = [];
  const texts: string[] = [];
  const walk = (at: string, rel: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, relPath);
      else {
        files.push(relPath);
        texts.push(readFileSync(path, "latin1"));
      }
    }
  };
  walk(dir, "");
  return { files: files.sort(), texts: texts.join("\n") };
}

/**
 * One `daemonCommand` run on a self-target fixture: a git checkout whose origin/main holds the public plan, a
 * disposable root, and a `gh` that refuses every call. `opsCatalogApi` undefined leaves the production transport.
 */
async function run(args: string[], opts: { opsCatalogApi?: OpsCatalogApi; shim?: GhShim; beforeLoop?: () => Promise<void>;
  afterLoop?: () => Promise<void>; afterRun?: (count: number) => void } = {}): Promise<Outcome> {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ops-shadow-on-`));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
  const repo = gitRepo({ kind: "ops-shadow-on-repo" });
  const origin = gitRepo({ bare: true, kind: "ops-shadow-on-origin" });
  mkdirSync(join(repo.dir, "plan"));
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), PLAN_YAML);
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "-qm", "fixture plan");
  repo.addRemote("origin", origin.dir);
  repo.git("push", "-qu", "origin", "main");
  const publicCommit = repo.git("rev-parse", "HEAD");
  const shim = opts.shim ?? ghShim([{ when: "", exit: 1, stderr: "fixture: GitHub is unavailable" }], { kind: "ops-shadow-on-gh" });
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  let captured: DaemonDeps | undefined;
  let drive: Drive | undefined;
  const deps: CommandDeps = {
    config: { root, claudeBin: "/bin/true" }, repoRoot: repo.dir,
    ...(opts.opsCatalogApi ? { opsCatalogApi: opts.opsCatalogApi } : {}),
    githubFactory: () => ({}) as never,
    startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
    checkPause: () => undefined, checkStop: () => undefined, readRunChildMode: () => "off",
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
    runDaemon: async (plan, wired) => {
      captured = wired;
      await delay(10);
      await opts.beforeLoop?.();
      drive = await driveLoop(plan, wired, opts.afterRun);
      await opts.afterLoop?.();
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  };
  try {
    const code = await daemonCommand(["--allow-self-target", "--max", "0", ...args], deps);
    assert.ok(captured && drive, "positive control: the command reached its runDaemon call");
    return { code, deps: captured, publicCommit, ghCalls: shim.calls(), ...filesUnder(root), ...drive };
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (!opts.shim) rmSync(shim.dir, { recursive: true, force: true });
    repo.cleanup();
    origin.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

const FLAG = ["--shadow-ops-catalog", SLUG];

test("W1-T11770 criterion 2: an ops commit that advances mid-run is observed on a later tick without a restart", async () => {
  const first = opsCatalog(opsTask("OPS-T1"));
  const second = opsCatalog(opsTask("OPS-T1") + opsTask("OPS-T2"));
  const fake = recordingApi(first);
  const on = await run(FLAG, { opsCatalogApi: fake.api, afterRun: (count) => { if (count === 1) fake.set(second); } });
  assert.equal(on.code, 0);
  assert.equal(on.deps.primaryPlanCommit?.(), on.publicCommit, "the primary commit is the plan revision's origin/main commit");
  assert.ok(on.shadow.every((row) => row.outcome === "compared"));
  assert.deepEqual([...new Set(on.shadow.map((row) => row.revision_key_digest))],
    [digestOf(on.publicCommit, first.commit), digestOf(on.publicCommit, second.commit)],
    "each ops commit is keyed with the public commit, and the second is seen without a restart");
  assert.ok(fake.calls.every((path) => path.startsWith(`repos/${SLUG}`)), "only the named repository is read");
  const off = await run([]);
  assert.deepEqual(on.ran, off.ran, "dispatch is the same as without the flag");
  assert.deepEqual(on.ran, PUBLIC_IDS);
});

test("W1-T11770 criterion 2: source absent, unreadable and auth missing are each a shadow row while dispatch continues", async () => {
  const cases: Array<[string, OpsCatalogApi]> = [
    ["source_absent", recordingApi(opsCatalog(opsTask("OPS-T1"), { withPlan: false })).api],
    ["unreadable", async () => { throw new Error("fixture: connection reset"); }],
    ["auth_missing", async () => { throw new OpsCatalogAuthMissingError(); }],
  ];
  for (const [outcome, api] of cases) {
    const on = await run(FLAG, { opsCatalogApi: api });
    assert.equal(on.code, 0);
    assert.ok(on.shadow.length > 0, `${outcome} is observed`);
    assert.deepEqual([...new Set(on.shadow.map((row) => row.outcome))], [outcome], `${outcome} is the row's outcome`);
    assert.ok(on.shadow.every((row) => row.combined_candidate_count === null && row.revision_key_digest === null));
    assert.deepEqual(on.ran, PUBLIC_IDS, `${outcome}: every public task still dispatches`);
  }
});

test("W1-T11770 criterion 2: a hung ops refresh never delays a tick", { timeout: 120_000 }, async () => {
  let reads = 0;
  const hung: OpsCatalogApi = () => { reads++; return new Promise<never>(() => {}); };
  const off = await run([]);
  const on = await run(FLAG, { opsCatalogApi: hung });
  assert.deepEqual(on.ran, PUBLIC_IDS, "every tick dispatched while the refresh hung");
  assert.equal(on.shadow.length, 0, "no completed refresh means no row, never a guess");
  assert.equal(reads, 1, "one refresh is in flight at a time; ticks do not stack reads behind it");
  // Each fake run takes about 20 ms, so a loop that waited on the hung read would never finish at all.
  assert.ok(on.elapsedMs < off.elapsedMs + 2_000, `the loop took ${on.elapsedMs} ms against ${off.elapsedMs} ms without the flag`);
});

test("W1-T11770 criterion 2: the flag changes no dispatch, claim, worker, review, config, registry or image effect", async () => {
  const fake = recordingApi(opsCatalog(opsTask("OPS-T1")));
  const off = await run([]);
  const on = await run(FLAG, { opsCatalogApi: fake.api });
  assert.ok(on.shadow.length > 0, "positive control: the flag produced a shadow row");
  assert.deepEqual(on.ran, off.ran, "dispatch set");
  assert.deepEqual(on.claims, off.claims, "claims");
  assert.equal(on.other, off.other, "every non-shadow loop row (worker, review, admission) is the same");
  assert.deepEqual(Object.keys(on.deps).filter((key) => !SHADOW_SEAMS.includes(key)).sort(), Object.keys(off.deps).sort(),
    "every other runDaemon dep, including review routing and worker spawn, is wired the same");
  assert.deepEqual(on.files, off.files, "the same state, config and registry files are written");
  assert.deepEqual(on.ghCalls, off.ghCalls, "the same gh calls, so no image, deploy or registry call is added");
  assert.ok(on.ran.every((id) => id.startsWith("PUB-")), "no ops task is dispatched");
  const leaks = [SLUG, "OPS-T1", "PRIVATE_TITLE_SENTINEL", "PRIVATE_PATH_SENTINEL", "PRIVATE_BODY_SENTINEL"];
  for (const leak of leaks) {
    assert.equal(on.texts.includes(leak), false, `${leak} is never written under the state root`);
    assert.equal(JSON.stringify(process.env).includes(leak), false, `${leak} never reaches the env a worker inherits`);
    assert.equal(on.ghCalls.join("\n").includes(leak), false, `${leak} never reaches a gh argv`);
    assert.equal(JSON.stringify(on.shadow).includes(leak), false, `${leak} never reaches a shadow row`);
  }
});

test("W1-T11770 criterion 2: with nothing injected the default gh transport reads the catalog", { timeout: 120_000 }, async () => {
  const fixture = opsCatalog(opsTask("OPS-T1"));
  // Most specific paths first: the shim answers the first route whose text the argv contains.
  const routes: GhShimRoute[] = [...fixture.routes].sort(([a], [b]) => b.length - a.length)
    .map(([path, body]) => ({ when: `api ${path}`, stdout: JSON.stringify(body) }));
  const shim = ghShim([...routes, { when: "", exit: 1, stderr: "fixture: GitHub is unavailable" }], { kind: "ops-shadow-on-gh" });
  const opsCalls = () => shim.calls().filter((call) => call.includes(`repos/${SLUG}`));
  try {
    const on = await run(FLAG, {
      shim,
      beforeLoop: async () => {
        // The boot refresh is paced through the real transport; wait for its last read, then refuse later reads.
        for (let waited = 0; opsCalls().length < fixture.routes.size + 1 && waited < 60_000; waited += 100) await delay(100);
        await delay(200);
        shim.addRoute({ when: "", exit: 1, stderr: "fixture: GitHub is unavailable" });
      },
      afterLoop: async () => {
        // The read the first tick started ends on the refusing route. Wait for it while the shim is still on PATH.
        const open = () => shim.events().filter((e) => e.phase === "start").length > shim.events().filter((e) => e.phase === "end").length;
        for (let waited = 0; (opsCalls().length < fixture.routes.size + 2 || open()) && waited < 30_000; waited += 100) await delay(100);
      },
    });
    assert.equal(on.code, 0);
    assert.ok(opsCalls().length >= fixture.routes.size + 1, "the real transport made the paced GET reads");
    assert.ok(opsCalls().every((call) => call.startsWith("api repos/")), "every ops read is a plain GET through gh api");
    assert.equal(on.shadow[0]?.outcome, "compared");
    assert.equal(on.shadow[0]?.revision_key_digest, digestOf(on.publicCommit, fixture.commit));
    assert.deepEqual(on.ran, PUBLIC_IDS);
    assert.ok(opsCalls().length >= fixture.routes.size + 2, "the tick started the next read behind its own, off the loop");
  } finally {
    rmSync(shim.dir, { recursive: true, force: true });
  }
});
