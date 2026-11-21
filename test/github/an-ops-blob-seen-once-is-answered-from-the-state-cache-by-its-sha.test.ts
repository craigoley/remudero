/**
 * W1-T13970: the ops catalog read every blob through a forced-fresh gh child, and its verified blobs lived in memory
 * only, so every daemon boot (and every serve read with its own api) fetched the whole catalog again: 207-518 s per
 * boot on 2026-11-20, with a dozen gh children at once. A blob is named by its content, so a sha verified once is
 * answered from a file under the state dir, after the same sha check a fetched blob passes. The arm path's
 * merge-queue reading is the same for every PR on one base branch, so it is kept per owner, repository and base.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { deserialize } from "node:v8";
import { MERGE_QUEUE_READ_TTL_MS, baseBranchRequiresMergeQueueAsync, realArmDepsAsync } from "#src/lib/arm-auto-merge.js";
import { fixedClock, systemClock } from "#src/lib/clock.js";
import { ghBrokerDir, ghBrokerRouteFor } from "#src/lib/gh-read-broker-client.js";
import { configureGithubHttpRead } from "#src/lib/github-http-read.js";
import {
  createOpsCatalogShadowSource, defaultOpsCatalogApi, readOpsCatalogSnapshotAsync, type OpsCatalogApi,
} from "#src/lib/ops-catalog-source.js";
import { mergePlanBlobs, type Plan } from "#src/lib/plan.js";
import { createBoardCatalogParentBridge, readBoardCatalogs, type BoardCatalogReply } from "#src/lib/serve-plan-reload.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";

const REPO = "fixture-private/ops-blob-cache";
const REPOSITORY_ID = 4242;
const sha1 = (text: string | Buffer): string => createHash("sha1").update(text).digest("hex");
const blobSha = (bytes: Buffer): string => sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
const taskYaml = (id: string): string =>
  `- id: ${id}\n  title: "${id} title"\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  files: [src/a.ts]\n`;
const target = { repository: REPO };
const pacer = { wait() {}, recordResult() {}, async waitAsync() {} };
const isBlob = (path: string): boolean => /\/git\/blobs\/[a-f0-9]{40}$/.test(path);

interface Catalog { monolith: string; shards: Record<string, string> }

/** One upstream ops repository whose default branch names one commit; `answer` is what GitHub returns for a GET. */
function remote(first: Catalog) {
  const repo = `repos/${REPO}`;
  const trees = new Map<string, unknown>();
  const commits = new Map<string, string>();
  const blobs = new Map<string, Buffer>();
  /** Bytes GitHub answers for a sha in place of its true content (a wrong blob). */
  const wrong = new Map<string, Buffer>();
  let serial = 0;
  const tree = (entries: Array<{ path: string; type: string; mode: string; sha: string }>): string => {
    const s = sha1(`tree ${serial++} ${JSON.stringify(entries)}`);
    trees.set(s, { sha: s, truncated: false, tree: entries });
    return s;
  };
  const put = (text: string): string => { const bytes = Buffer.from(text); const s = blobSha(bytes); blobs.set(s, bytes); return s; };
  let head = "";
  let bound: string[] = [];
  const commitOf = (c: Catalog): string => {
    const shardShas = Object.entries(c.shards).map(([path, text]) => ({ path, type: "blob", mode: "100644", sha: put(text) }));
    const monolith = put(c.monolith);
    const shardTree = tree(shardShas);
    const planTree = tree([
      { path: "tasks.yaml", type: "blob", mode: "100644", sha: monolith },
      { path: "tasks.d", type: "tree", mode: "040000", sha: shardTree },
    ]);
    const root = tree([{ path: "plan", type: "tree", mode: "040000", sha: planTree }]);
    const commit = sha1(`commit ${serial++}`);
    commits.set(commit, root);
    bound = [monolith, ...shardShas.map((e) => e.sha)];
    return commit;
  };
  head = commitOf(first);
  const answer = (path: string): unknown => {
    if (path === repo) return { id: REPOSITORY_ID, full_name: REPO, default_branch: "main" };
    if (path === `${repo}/git/ref/heads/main`) return { object: { type: "commit", sha: head } };
    const commit = /\/git\/commits\/([a-f0-9]{40})$/.exec(path);
    if (commit && commits.has(commit[1])) return { sha: commit[1], tree: { sha: commits.get(commit[1]) } };
    const treeMatch = /\/git\/trees\/([a-f0-9]{40})$/.exec(path);
    if (treeMatch && trees.has(treeMatch[1])) return trees.get(treeMatch[1]);
    const blob = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
    const bytes = blob ? wrong.get(blob[1]) ?? blobs.get(blob[1]) : undefined;
    if (blob && bytes) return { sha: blob[1], encoding: "base64", size: bytes.length, content: bytes.toString("base64") };
    throw new Error(`HTTP 404 unexpected GET ${path}`);
  };
  /** A fresh api: its own function, so the source's in-memory blob map starts empty for it. */
  const instance = () => {
    const calls: string[] = [];
    const api: OpsCatalogApi = async (path) => { calls.push(path); return answer(path); };
    return { api, calls, blobGets: () => calls.filter(isBlob).length };
  };
  /** A fresh default api over a counting executor in place of the gh child. */
  const execInstance = () => {
    const calls: string[] = [];
    const api = defaultOpsCatalogApi({ pacer, exec: (async (_file: string, args: string[]) => {
      calls.push(args[1]);
      return { stdout: JSON.stringify(answer(args[1])), stderr: "" };
    }) as never });
    return { api, calls, blobGets: () => calls.filter(isBlob).length };
  };
  return {
    answer, instance, execInstance, wrong,
    move: (c: Catalog) => { head = commitOf(c); },
    boundShas: () => [...bound].sort(),
    allPaths: (): string[] => [
      repo, `${repo}/git/ref/heads/main`, ...[...commits.keys()].map((s) => `${repo}/git/commits/${s}`),
      ...[...trees.keys()].map((s) => `${repo}/git/trees/${s}`), ...[...blobs.keys()].map((s) => `${repo}/git/blobs/${s}`),
    ],
  };
}

const CATALOG: Catalog = { monolith: taskYaml("OPS-T1"), shards: { "a.yaml": taskYaml("OPS-T2"), "b.yaml": taskYaml("OPS-T3") } };

function tempRoot(t: TestContext): { root: string; state: string } {
  const root = fs.mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13970-`));
  const state = join(root, "state");
  fs.mkdirSync(state);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, state };
}

/** The cache's layout: one file per verified blob sha, under the state dir, per repository id. */
const opsCatalogBlobCacheDir = (state: string, repositoryId: number): string => join(state, "cache", "ops-blobs", String(repositoryId));
const ids = (plan: Plan | undefined): string[] => (plan?.tasks ?? []).map((task) => task.id).sort();
const cachedShas = (state: string): string[] => {
  const dir = opsCatalogBlobCacheDir(state, REPOSITORY_ID);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};

test("W1-T13970 criterion 1: a blob sha read once is answered from the state-dir cache by a second catalog instance with no GitHub request", async (t) => {
  const { state } = tempRoot(t);
  const up = remote(CATALOG);
  const first = up.instance();
  const cold = await readOpsCatalogSnapshotAsync(target, first.api, { stateDir: state });
  assert.equal(cold.outcome, "ok");
  assert.equal(first.blobGets(), 3, "positive control: a cold read fetches every blob");

  const second = up.instance();
  const warm = await readOpsCatalogSnapshotAsync(target, second.api, { stateDir: state });
  assert.equal(warm.outcome, "ok");
  assert.equal(second.blobGets(), 0, "a sha seen before makes no blob GET");
  assert.deepEqual(cachedShas(state), up.boundShas(), "each verified blob is kept as one file named by its sha");
  assert.ok(second.calls.length > 0, "positive control: the second instance did read the repository");
  assert.deepEqual(ids(warm.plan), ids(cold.plan));
  assert.deepEqual(ids(warm.plan), ["OPS-T1", "OPS-T2", "OPS-T3"]);
  assert.equal(warm.identityDigest, cold.identityDigest, "the same binding at the same commit");
  assert.equal(warm.counts.cachedObjects, 3, "the three blobs count as cached objects");

  // The default api over a counting executor in place of the gh child: no blob child is started either.
  const viaExec = up.execInstance();
  assert.equal((await readOpsCatalogSnapshotAsync(target, viaExec.api, { stateDir: state })).outcome, "ok");
  assert.equal(viaExec.blobGets(), 0, "no gh child for a blob the state dir holds");
  assert.ok(viaExec.calls.some((path) => path.endsWith("/git/ref/heads/main")), "positive control: the executor carried the ref read");

  // Two shadow sources (a daemon boot each) over two fresh apis share the cache too.
  const boot = up.instance();
  const refreshed = await createOpsCatalogShadowSource(target, boot.api, { stateDir: state }).refresh();
  assert.equal(refreshed.outcome, "ok");
  assert.equal(boot.blobGets(), 0, "a new boot's first refresh fetches no blob it fetched before");
});

test("W1-T13970 criterion 1: the cache keeps only the blobs the newest read bound", async (t) => {
  const { state } = tempRoot(t);
  const up = remote(CATALOG);
  assert.equal((await readOpsCatalogSnapshotAsync(target, up.instance().api, { stateDir: state })).outcome, "ok");
  const before = cachedShas(state);
  up.move({ ...CATALOG, shards: { ...CATALOG.shards, "b.yaml": taskYaml("OPS-T4") } });
  const moved = up.instance();
  const snap = await readOpsCatalogSnapshotAsync(target, moved.api, { stateDir: state });
  assert.equal(snap.outcome, "ok");
  assert.deepEqual(ids(snap.plan), ["OPS-T1", "OPS-T2", "OPS-T4"]);
  assert.equal(moved.blobGets(), 1, "only the changed shard is fetched");
  assert.deepEqual(cachedShas(state), up.boundShas(), "the replaced shard's file is pruned");
  assert.notDeepEqual(cachedShas(state), before);
});

/** A local stand-in for api.github.com, with the in-process client pointed at it until the test ends. */
async function apiServer(t: TestContext, respond: (path: string) => unknown): Promise<string[]> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace(/^\//, "").replace(/\?.*$/, "");
    seen.push(path);
    try {
      const body = JSON.stringify(respond(path));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    } catch (error) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: String((error as Error).message) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  configureGithubHttpRead({ origin: `http://127.0.0.1:${port}` });
  t.after(async () => {
    configureGithubHttpRead(undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return seen;
}

const ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "PATH", "HOME", "RMD_GH_CACHE_HOME", "GH_CONFIG_DIR", "GH_HOST"] as const;

/** This process's GitHub environment for one test: a fixture token, its own HOME, no broker, a recording gh on PATH. */
function scene(t: TestContext, routes: GhShimRoute[]) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const { root } = tempRoot(t);
  fs.mkdirSync(join(root, "gh-config"));
  const shim = ghShim(routes);
  process.env.GH_TOKEN = "w1-t13970-fixture-token";
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_HOST;
  delete process.env.RMD_GH_CACHE_HOME;
  process.env.HOME = root;
  process.env.GH_CONFIG_DIR = join(root, "gh-config");
  process.env.PATH = `${shim.dir}:${saved.PATH ?? ""}`;
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(shim.dir, { recursive: true, force: true });
  });
  return shim;
}

const shimRoutes = (up: ReturnType<typeof remote>, keep: (path: string) => boolean): GhShimRoute[] =>
  up.allPaths().filter(keep).sort((a, b) => b.length - a.length)
    .map((path) => ({ when: `api ${path}`, stdout: JSON.stringify(up.answer(path)) }));

test("W1-T13970 criterion 2: a blob not in the cache is read through the in-process client while the ref and tree reads stay forced-fresh gh children", async (t) => {
  const up = remote(CATALOG);
  const shim = scene(t, shimRoutes(up, (path) => !isBlob(path)));
  const served = await apiServer(t, (path) => up.answer(path));
  const snap = await readOpsCatalogSnapshotAsync(target, defaultOpsCatalogApi({ pacer }));
  assert.equal(snap.outcome, "ok");
  assert.deepEqual(ids(snap.plan), ["OPS-T1", "OPS-T2", "OPS-T3"]);
  assert.equal(served.filter(isBlob).length, 3, "every blob GET reached the in-process client");
  assert.deepEqual(served.filter((path) => !isBlob(path)), [], "nothing but blobs went in-process");
  const calls = shim.calls();
  assert.equal(calls.filter((call) => call.includes("/git/blobs/")).length, 0, "no gh child for a blob");
  assert.equal(calls.filter((call) => call.includes(`repos/${REPO}/git/ref/heads/main`)).length, 2, "the opening and closing ref reads ran gh");
  assert.equal(calls.filter((call) => call.includes("/git/trees/")).length, 3, "every tree read ran gh");
  assert.ok(calls.every((call) => !/--cache/.test(call)), "the forced-fresh children carry no cache flag");
});

test("W1-T13970 criterion 3: two PRs on one base within the TTL make one rules read, and the TTL is unchanged", async (t) => {
  assert.equal(MERGE_QUEUE_READ_TTL_MS, 10 * 60_000, "the TTL is unchanged");
  let now = 1_000_000;
  t.mock.method(systemClock, "now", () => now);
  const reads: string[] = [];
  const bases: Record<string, string> = { "acme/one/pulls/1": "main", "acme/one/pulls/2": "main", "acme/one/pulls/3": "release", "acme/two/pulls/4": "main" };
  const fetch = async (args: string[]): Promise<unknown> => {
    const path = args[1];
    reads.push(path);
    const pr = /^repos\/(.+\/pulls\/\d+)$/.exec(path);
    if (pr) return { base: { ref: bases[pr[1]] } };
    if (path === "repos/acme/one/rules/branches/main") return [{ type: "merge_queue" }];
    if (/\/rules\/branches\//.test(path)) return [];
    throw new Error(`unexpected ${path}`);
  };
  const rules = () => reads.filter((path) => path.includes("/rules/branches/"));
  const pulls = () => reads.filter((path) => path.includes("/pulls/"));
  const url = (repo: string, n: number) => `https://github.com/acme/${repo}/pull/${n}`;
  assert.equal(await baseBranchRequiresMergeQueueAsync(url("one", 1), fetch), true);
  assert.equal(await baseBranchRequiresMergeQueueAsync(url("one", 2), fetch), true);
  assert.equal(pulls().length, 2, "each PR is still read for its base ref");
  assert.deepEqual(rules(), ["repos/acme/one/rules/branches/main"], "one rules read serves both PRs on main");
  assert.equal(await baseBranchRequiresMergeQueueAsync(url("one", 3), fetch), false);
  assert.equal(await baseBranchRequiresMergeQueueAsync(url("two", 4), fetch), false);
  assert.equal(rules().length, 3, "another base, or another repository's main, is its own reading");
  now += MERGE_QUEUE_READ_TTL_MS - 1;
  assert.equal(await baseBranchRequiresMergeQueueAsync(url("one", 2), fetch), true);
  assert.equal(rules().length, 3, "inside the TTL the reading is reused");
  now += 1;
  assert.equal(await baseBranchRequiresMergeQueueAsync(url("one", 1), fetch), true);
  assert.equal(rules().length, 4, "at the TTL the base is read again");
});

test("W1-T13970 criterion 3: the arm path's cached reading makes one rules read for two PRs on one base", async (t) => {
  const shim = ghShim([
    { when: "rules/branches/main", stdout: JSON.stringify([{ type: "merge_queue" }]) },
    { when: "pulls/13971", stdout: JSON.stringify({ base: { ref: "main" } }) },
    { when: "pulls/13972", stdout: JSON.stringify({ base: { ref: "main" } }) },
  ]);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath ?? ""}`;
  t.after(() => { process.env.PATH = savedPath; fs.rmSync(shim.dir, { recursive: true, force: true }); });
  const deps = realArmDepsAsync((() => { throw new Error("the merge-queue reading reads no config"); }) as never);
  const url = (n: number) => `https://github.com/fixture-owner/w1-t13970/pull/${n}`;
  assert.equal(await deps.mergeQueue!(url(13971)), true);
  assert.equal(await deps.mergeQueue!(url(13972)), true);
  assert.equal(shim.calls().filter((call) => call.includes("/pulls/")).length, 2, "positive control: each PR was read");
  assert.equal(shim.calls().filter((call) => call.includes("rules/branches/main")).length, 1, "one rules read for both PRs");
});

test("W1-T13970 criterion 4: a cached file whose bytes do not hash to its sha is discarded and the blob is fetched", async (t) => {
  const { state } = tempRoot(t);
  const up = remote(CATALOG);
  const cold = await readOpsCatalogSnapshotAsync(target, up.instance().api, { stateDir: state });
  assert.equal(cold.outcome, "ok");
  const victim = up.boundShas()[0];
  const file = join(opsCatalogBlobCacheDir(state, REPOSITORY_ID), victim);
  const truth = fs.readFileSync(file);
  fs.writeFileSync(file, taskYaml("OPS-T666"));
  const next = up.instance();
  const snap = await readOpsCatalogSnapshotAsync(target, next.api, { stateDir: state });
  assert.equal(snap.outcome, "ok");
  assert.ok(!ids(snap.plan).includes("OPS-T666"), "the wrong bytes never answer");
  assert.deepEqual(ids(snap.plan), ids(cold.plan));
  assert.deepEqual(next.calls.filter(isBlob), [`repos/${REPO}/git/blobs/${victim}`], "only the discarded blob is fetched");
  assert.deepEqual(fs.readFileSync(file), truth, "the fetched, verified bytes replace the discarded file");
});

test("W1-T13970 criterion 4: a wrong cached file and a wrong fetched blob are refused as malformed alike, and nothing wrong is kept", async (t) => {
  const { state } = tempRoot(t);
  const up = remote(CATALOG);
  assert.equal((await readOpsCatalogSnapshotAsync(target, up.instance().api, { stateDir: state })).outcome, "ok");
  const victim = up.boundShas()[1];
  const file = join(opsCatalogBlobCacheDir(state, REPOSITORY_ID), victim);
  fs.writeFileSync(file, taskYaml("OPS-T666"));
  up.wrong.set(victim, Buffer.from(taskYaml("OPS-T666")));
  const snap = await readOpsCatalogSnapshotAsync(target, up.instance().api, { stateDir: state });
  assert.equal(snap.outcome, "malformed");
  assert.equal(snap.plan, undefined);
  assert.equal(fs.existsSync(file), false, "the wrong file is removed, and the wrong fetched bytes are not written");
  // Without any cache the same wrong GitHub answer is refused the same way.
  assert.equal((await readOpsCatalogSnapshotAsync(target, up.instance().api)).outcome, "malformed");
});

test("W1-T13970 criterion 4: a ref or tree read is never answered from any cache", async (t) => {
  const { state } = tempRoot(t);
  const up = remote(CATALOG);
  assert.equal((await readOpsCatalogSnapshotAsync(target, up.instance().api, { stateDir: state })).outcome, "ok");
  assert.deepEqual(cachedShas(state), up.boundShas(), "only blob shas are kept on disk");
  const warm = up.instance();
  assert.equal((await readOpsCatalogSnapshotAsync(target, warm.api, { stateDir: state })).outcome, "ok");
  assert.equal(warm.calls.filter((path) => path.endsWith("/git/ref/heads/main")).length, 2, "both ref reads reach GitHub");
  assert.equal(warm.calls.filter((path) => path.includes("/git/trees/")).length, 3, "every tree read reaches GitHub");
  assert.equal(warm.calls.filter((path) => path.includes("/git/commits/")).length, 1, "the commit read reaches GitHub");
  // A moved branch is followed, never answered from the files: the new commit's trees are read.
  up.move({ ...CATALOG, monolith: taskYaml("OPS-T9") });
  const moved = up.instance();
  const snap = await readOpsCatalogSnapshotAsync(target, moved.api, { stateDir: state });
  assert.equal(snap.outcome, "ok");
  assert.ok(ids(snap.plan).includes("OPS-T9"));
  assert.equal(moved.calls.filter((path) => path.includes("/git/trees/")).length, 3);
});

test("W1-T13970 criterion 4: a base branch whose rules are unreadable still answers false, and the failure is not kept", async () => {
  const reads: string[] = [];
  let rulesFail = true;
  const fetch = async (args: string[]): Promise<unknown> => {
    reads.push(args[1]);
    if (args[1].includes("/pulls/")) return { base: { ref: "main" } };
    if (rulesFail) throw new Error("HTTP 502");
    return { message: "not a rules list" };
  };
  const url = (n: number) => `https://github.com/acme/unreadable/pull/${n}`;
  assert.equal(await baseBranchRequiresMergeQueueAsync(url(1), fetch), false, "an unreadable rules read answers false");
  assert.equal(await baseBranchRequiresMergeQueueAsync(url(2), fetch), false);
  assert.equal(reads.filter((path) => path.includes("/rules/")).length, 2, "an unreadable reading is read again, never kept");
  rulesFail = false;
  assert.equal(await baseBranchRequiresMergeQueueAsync(url(3), fetch), false, "a body that is not a rules list answers false");
  assert.equal(await baseBranchRequiresMergeQueueAsync(url(4), fetch), false);
  assert.equal(reads.filter((path) => path.includes("/rules/")).length, 4, "a malformed reading is not kept either");
});

const publicPlan = (): Plan => mergePlanBlobs([{ label: "public.yaml", text: taskYaml("PUBLIC-T1") }]);
const boardIds = (context: Awaited<ReturnType<typeof readBoardCatalogs>>): string[] =>
  (context?.plan?.tasks ?? []).map((task) => task.id).filter((id) => id.startsWith("OPS-")).sort();

test("W1-T13970 criterion 5: serve's board reader and catalog pool answer a blob seen before from the state-dir cache", async (t) => {
  const { state } = tempRoot(t);
  fs.writeFileSync(join(state, "plan-destination.json"), JSON.stringify({ repository: REPO, kinds: [] }));
  fs.writeFileSync(join(state, "ledger.ndjson"), "");
  const up = remote(CATALOG);
  const first = up.execInstance();
  const cold = await readBoardCatalogs(publicPlan, state, first.api, fixedClock(0));
  assert.equal(cold?.outcome, "ok");
  assert.deepEqual(boardIds(cold), ["OPS-T1", "OPS-T2", "OPS-T3"]);
  assert.equal(first.blobGets(), 3, "positive control: serve's cold read fetches every blob");
  const second = up.execInstance();
  const warm = await readBoardCatalogs(publicPlan, state, second.api, fixedClock(0));
  assert.equal(warm?.outcome, "ok");
  assert.deepEqual(boardIds(warm), boardIds(cold));
  assert.equal(second.blobGets(), 0, "a second serve reader fetches no blob the state dir holds");
  assert.ok(second.calls.some((path) => path.endsWith("/git/ref/heads/main")), "positive control: it did read the catalog");

  // The catalog pool reads through serve's own default api, a gh child per GET: a shim stands in for gh.
  const shim = ghShim(shimRoutes(up, () => true));
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath ?? ""}`;
  t.after(() => { process.env.PATH = savedPath; fs.rmSync(shim.dir, { recursive: true, force: true }); });
  let answered: (reply: BoardCatalogReply) => void = () => {};
  const replied = new Promise<BoardCatalogReply>((resolve) => { answered = resolve; });
  // The pool's default api paces its GETs, so the reply takes some seconds; the test timeout bounds the wait.
  const bridge = createBoardCatalogParentBridge([state], (reply) => answered(reply), fixedClock(1_000));
  try {
    bridge.request({ type: "ops_catalog_read", version: 1, root: state });
    const payload = deserialize(Buffer.from((await replied).buffer)) as { plan?: Plan; reason?: string };
    assert.deepEqual(ids(payload.plan), ["OPS-T1", "OPS-T2", "OPS-T3"], `the pool read the catalog (${payload.reason ?? "ok"})`);
    assert.ok(shim.calls().some((call) => call.includes("/git/ref/heads/main")), "positive control: the pool ran gh for the ref");
    assert.equal(shim.calls().filter((call) => call.includes("/git/blobs/")).length, 0, "the pool started no gh child for a cached blob");
  } finally { bridge.close(); }
});

test("W1-T13970: a cache entry that cannot be read, removed or written leaves the read to GitHub, never to wrong bytes", async (t) => {
  const { state } = tempRoot(t);
  const up = remote(CATALOG);
  const dir = opsCatalogBlobCacheDir(state, REPOSITORY_ID);
  const [first, second, third] = up.boundShas();
  // Nothing written yet, every blob from memory: the prune after the ok read finds no directory.
  const warmApi = up.instance();
  assert.equal((await readOpsCatalogSnapshotAsync(target, warmApi.api)).outcome, "ok");
  assert.equal((await readOpsCatalogSnapshotAsync(target, warmApi.api, { stateDir: state })).outcome, "ok");
  assert.equal(fs.existsSync(dir), false, "blobs answered from memory write no file");

  // A rename that fails keeps no file and leaves no temporary one.
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).startsWith(dir)) throw Object.assign(new Error("EROFS"), { code: "EROFS" });
    return rename(from, to);
  });
  const unwritable = up.instance();
  assert.equal((await readOpsCatalogSnapshotAsync(target, unwritable.api, { stateDir: state })).outcome, "ok");
  assert.equal(unwritable.blobGets(), 3);
  assert.deepEqual(fs.readdirSync(dir), [], "no blob and no temporary file is left behind");
  t.mock.restoreAll();

  assert.equal((await readOpsCatalogSnapshotAsync(target, up.instance().api, { stateDir: state })).outcome, "ok");
  assert.deepEqual(cachedShas(state), up.boundShas(), "positive control: the next read keeps every blob");

  // A directory where a blob file should be, a file that cannot be read, and a wrong file that cannot be removed.
  fs.rmSync(join(dir, first));
  fs.mkdirSync(join(dir, first));
  fs.writeFileSync(join(dir, third), taskYaml("OPS-T666"));
  const open = fs.openSync;
  const remove = fs.rmSync;
  t.mock.method(fs, "openSync", (path: fs.PathLike, ...rest: unknown[]) => {
    if (String(path) === join(dir, second)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return (open as (...args: unknown[]) => unknown)(path, ...rest);
  });
  t.mock.method(fs, "rmSync", (path: fs.PathLike, opts?: fs.RmOptions) => {
    if (String(path) === join(dir, third)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    return remove(path, opts);
  });
  const troubled = up.instance();
  const snap = await readOpsCatalogSnapshotAsync(target, troubled.api, { stateDir: state });
  t.mock.restoreAll();
  assert.equal(snap.outcome, "ok");
  assert.deepEqual(ids(snap.plan), ["OPS-T1", "OPS-T2", "OPS-T3"], "the wrong bytes never answer");
  assert.equal(troubled.blobGets(), 3, "each troubled entry is a miss read from GitHub");
  const truth = (blob: string): Buffer => Buffer.from((up.answer(`repos/${REPO}/git/blobs/${blob}`) as { content: string }).content, "base64");
  assert.deepEqual(fs.readFileSync(join(dir, first)), truth(first), "the directory was replaced by the verified blob");
  assert.deepEqual(fs.readFileSync(join(dir, third)), truth(third), "the wrong file was replaced by the verified blob");
});

test("W1-T13970: the shared default api keeps its blobs under the instance's state dir", async (t) => {
  const { root } = tempRoot(t);
  const instance = join(root, "instance");
  fs.mkdirSync(join(instance, "state"), { recursive: true });
  fs.mkdirSync(join(root, "home", ".config", "remudero"), { recursive: true });
  fs.writeFileSync(join(root, "home", ".config", "remudero", "config.json"), JSON.stringify({ root: instance }));
  const up = remote(CATALOG);
  const shim = scene(t, shimRoutes(up, () => true));
  process.env.HOME = join(root, "home");
  delete process.env.GH_TOKEN;
  const snap = await readOpsCatalogSnapshotAsync(target);
  assert.equal(snap.outcome, "ok");
  assert.ok(shim.calls().some((call) => call.includes("/git/blobs/")), "positive control: the cold read fetched the blobs");
  assert.deepEqual(cachedShas(join(instance, "state")), up.boundShas(), "the instance's state dir holds them");

  // An unreadable config is no instance: the read still answers, with its blobs in memory.
  fs.writeFileSync(join(root, "home", ".config", "remudero", "config.json"), "not json");
  assert.equal((await readOpsCatalogSnapshotAsync(target)).outcome, "ok");
});

test("W1-T13970: with a live broker a blob keeps the forced-fresh child, so private bytes never enter its shared cache", async (t) => {
  const up = remote(CATALOG);
  const blobPath = `repos/${REPO}/git/blobs/${up.boundShas()[0]}`;
  const shim = scene(t, shimRoutes(up, () => true));
  const served = await apiServer(t, (path) => up.answer(path));
  const { root } = tempRoot(t);
  process.env.RMD_GH_CACHE_HOME = root;
  delete process.env.GH_TOKEN;
  const dir = ghBrokerDir()!;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, "heartbeat"), "60\n");
  assert.ok(ghBrokerRouteFor(), "positive control: broker routing is active");
  assert.deepEqual(await defaultOpsCatalogApi({ pacer })(blobPath), up.answer(blobPath));
  assert.equal(shim.calls().filter((call) => call.includes("/git/blobs/")).length, 1, "the blob ran its own gh child");
  assert.deepEqual(served, [], "nothing went in-process");
  assert.equal(fs.existsSync(join(dir, "cache")), false, "nothing entered the broker's cache");
});
