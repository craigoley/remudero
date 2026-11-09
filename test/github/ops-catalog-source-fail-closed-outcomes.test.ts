import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { GhReadBroker } from "#src/lib/gh-read-broker.js";
import { ghBrokerDir, ghBrokerRouteFor } from "#src/lib/gh-read-broker-client.js";
import { ghJsonAsync } from "#src/lib/github-transport.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import {
  OPS_CATALOG_MAX_BLOB_BYTES, OPS_CATALOG_MAX_SHARDS, OPS_CATALOG_MAX_TREE_ENTRIES, OPS_CATALOG_OUTCOMES,
  OpsCatalogAuthMissingError, createOpsCatalogShadowSource, defaultOpsCatalogApi, readOpsCatalogSnapshotAsync, type OpsCatalogApi,
} from "#src/lib/ops-catalog-source.js";

const REPO = "acme-private/ops-secret-slug";
const sha1 = (b: Buffer | string): string => createHash("sha1").update(b).digest("hex");
const blobSha = (text: string): string => sha1(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(text)}\0`), Buffer.from(text)]));
const taskYaml = (id: string, title = "PRIVATE_TITLE_SENTINEL"): string =>
  `- id: ${id}\n  title: "${title}"\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [private/PRIVATE_PATH_SENTINEL]\n  rationale: PRIVATE_BODY_SENTINEL\n`;

interface Catalog { monolith?: string; shards?: Record<string, string>; noPlanDir?: boolean }
interface Fx { api: OpsCatalogApi; calls: string[]; commit: string }

/** A recording GET-only fake of the git data API for one repository. */
function fixture(c: Catalog, hooks: { fail?: (path: string) => unknown; moveRefAfterBlobs?: boolean } = {}): Fx {
  const shards = c.shards ?? {};
  const blobs = new Map<string, string>();
  const put = (t: string): string => { const s = blobSha(t); blobs.set(s, t); return s; };
  const monolith = c.monolith === undefined ? undefined : put(c.monolith);
  const shardShas = Object.entries(shards).map(([n, t]) => [n, put(t)] as const);
  const shardTree = sha1("tasks.d");
  const planTree = sha1("plan");
  const rootTree = sha1("root");
  const commit = sha1("commit-1");
  let blobReads = 0;
  const calls: string[] = [];
  const entry = (path: string, type: string, mode: string, s: string) => ({ path, type, mode, sha: s });
  const api: OpsCatalogApi = async (path) => {
    calls.push(path);
    const injected = hooks.fail?.(path);
    if (injected !== undefined) { if (injected instanceof Error) throw injected; return injected; }
    if (path === `repos/${REPO}`) return { id: 42, full_name: REPO, default_branch: "main" };
    if (path === `repos/${REPO}/git/ref/heads/main`) return { object: { type: "commit", sha: hooks.moveRefAfterBlobs && blobReads > 0 ? sha1("commit-2") : commit } };
    if (path === `repos/${REPO}/git/commits/${commit}`) return { sha: commit, tree: { sha: rootTree } };
    if (path === `repos/${REPO}/git/trees/${rootTree}`) {
      return { sha: rootTree, truncated: false, tree: c.noPlanDir ? [] : [entry("plan", "tree", "040000", planTree)] };
    }
    if (path === `repos/${REPO}/git/trees/${planTree}`) {
      return { sha: planTree, truncated: false, tree: [
        ...(monolith ? [entry("tasks.yaml", "blob", "100644", monolith)] : []),
        ...(c.shards ? [entry("tasks.d", "tree", "040000", shardTree)] : []),
      ] };
    }
    if (path === `repos/${REPO}/git/trees/${shardTree}`) {
      return { sha: shardTree, truncated: false, tree: shardShas.map(([n, s]) => entry(n, "blob", "100644", s)) };
    }
    const m = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
    if (m) {
      blobReads++;
      const text = blobs.get(m[1]);
      if (text === undefined) throw new Error(`HTTP 404 ${path} PRIVATE_BODY_SENTINEL`);
      return { sha: m[1], encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
    }
    throw new Error(`unexpected GET ${path}`);
  };
  return { api, calls, commit };
}

const target = { repository: REPO };
const run = (fx: Fx) => readOpsCatalogSnapshotAsync(target, fx.api);
const refused = (outcome: string, snap: { outcome: string; plan?: unknown; binding?: unknown }): void => {
  assert.equal(snap.outcome, outcome);
  assert.equal(snap.plan, undefined, "no plan on a refusal");
  assert.equal(snap.binding, undefined);
};
const planTreeIs = (tree: unknown[]) => (p: string) => p.endsWith(`/git/trees/${sha1("plan")}`) ? { sha: sha1("plan"), truncated: false, tree } : undefined;
const rootTreeIs = (tree: unknown[]) => (p: string) => p.endsWith(`/git/trees/${sha1("root")}`) ? { sha: sha1("root"), truncated: false, tree } : undefined;

test("W1-T11768 criterion 2: missing auth is auth_missing", async () => {
  refused("auth_missing", await run(fixture({ monolith: taskYaml("A") }, { fail: () => new OpsCatalogAuthMissingError() })));
});

test("W1-T11768 criterion 2: 403, 404 and transport failures are all unreadable", async () => {
  for (const message of ["HTTP 403", "HTTP 404 Not Found", "socket hang up", "ECONNRESET"]) {
    refused("unreadable", await run(fixture({ monolith: taskYaml("A") }, { fail: (p) => p === `repos/${REPO}` ? new Error(message) : undefined })));
  }
  const throwsNonError: OpsCatalogApi = async () => { throw "a string"; };
  refused("unreadable", await readOpsCatalogSnapshotAsync(target, throwsNonError));
  refused("unreadable", await readOpsCatalogSnapshotAsync({ repository: "../escape" }, throwsNonError));
});

test("W1-T11768 criterion 2: a readable repo with no plan is source_absent, never an empty catalog", async () => {
  refused("source_absent", await run(fixture({ noPlanDir: true })));
  refused("source_absent", await run(fixture({})));
});

test("W1-T11768 criterion 2: a refresh failing after a success is stale and never the earlier snapshot", async () => {
  let down = false;
  const fx = fixture({ monolith: taskYaml("A") }, { fail: () => down ? new Error("HTTP 502") : undefined });
  const source = createOpsCatalogShadowSource(target, fx.api);
  const first = await source.refresh();
  assert.equal(first.outcome, "ok");
  down = true;
  const second = await source.refresh();
  assert.equal(second.outcome, "stale");
  assert.equal(second.plan, undefined, "the earlier plan is not current");
  assert.equal(second.identityDigest, undefined);
  down = false;
  assert.equal((await source.refresh()).outcome, "ok", "a later success is current again");
  const fresh = createOpsCatalogShadowSource(target, fixture({ noPlanDir: true }).api);
  assert.equal((await fresh.refresh()).outcome, "source_absent", "without an earlier success the code is the cause");
});

test("W1-T11768 criterion 2: a moved ref is ref_moved", async () => {
  refused("ref_moved", await run(fixture({ monolith: taskYaml("A") }, { moveRefAfterBlobs: true })));
});

test("W1-T11768 criterion 2: a malformed plan is malformed", async () => {
  refused("malformed", await run(fixture({ monolith: "not: [a list" })));
  refused("malformed", await run(fixture({ monolith: taskYaml("A"), shards: { "x.yaml": "- id: B\n" } })));
  refused("malformed", await run(fixture({ monolith: "- id: A\n  title: t\n  repo: remudero\n  type: implement\n  depends_on: [GHOST]\n" })));
});

test("W1-T11768 criterion 2: an intra-catalog duplicate id is duplicate_task_id and the whole snapshot is refused", async () => {
  refused("duplicate_task_id", await run(fixture({ monolith: taskYaml("A"), shards: { "x.yaml": taskYaml("A"), "y.yaml": taskYaml("C") } })));
  refused("duplicate_task_id", await run(fixture({ monolith: taskYaml("A") + taskYaml("A") })));
});

test("W1-T11768 criterion 2: structural defects are malformed", async () => {
  const ref = (p: string) => p.includes("/git/ref/heads/");
  const wrongSha = (p: string) => p.endsWith(`/git/trees/${sha1("root")}`) ? { sha: sha1("other"), truncated: false, tree: [] } : undefined;
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: wrongSha })));
  const repoMeta = (meta: unknown) => (p: string) => p === `repos/${REPO}` ? meta : undefined;
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: repoMeta({ id: 0, full_name: REPO, default_branch: "main" }) })));
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: repoMeta({ id: 1, full_name: "other/name", default_branch: "main" }) })));
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: repoMeta([]) })));
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: (p) => ref(p) ? { object: { type: "tag", sha: sha1("t") } } : undefined })));
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: (p) => p.includes("/git/commits/") ? { sha: sha1("different"), tree: { sha: sha1("root") } } : undefined })));
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: rootTreeIs([{ path: 1 }]) })));
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: planTreeIs([{ path: "tasks.yaml", type: "blob", mode: "120000", sha: sha1("x") }]) })));
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: planTreeIs([
    { path: "tasks.yaml", type: "blob", mode: "100644", sha: sha1("x") }, { path: "tasks.yaml", type: "blob", mode: "100644", sha: sha1("y") }]) })));
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: rootTreeIs([{ path: "plan", type: "blob", mode: "100644", sha: sha1("plan") }]) })));
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: planTreeIs([
    { path: "tasks.yaml", type: "blob", mode: "100644", sha: blobSha(taskYaml("A")) }, { path: "tasks.d", type: "blob", mode: "100644", sha: sha1("tasks.d") }]) })));
  refused("malformed", await run(fixture({ monolith: taskYaml("A"), shards: { "x.yaml": taskYaml("B") } }, { fail: (p) => p.endsWith(`/git/trees/${sha1("tasks.d")}`)
    ? { sha: sha1("tasks.d"), truncated: false, tree: [{ path: "x.yaml", type: "tree", mode: "040000", sha: sha1("x") }] } : undefined })));
});

test("W1-T11768 criterion 2: bounds refuse as malformed, never partially", async () => {
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: (p) => p.endsWith(`/git/trees/${sha1("root")}`) ? { sha: sha1("root"), truncated: true, tree: [] } : undefined })));
  const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f${i}`, type: "blob", mode: "100644", sha: sha1(String(i)) }));
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: rootTreeIs(filler(OPS_CATALOG_MAX_TREE_ENTRIES + 1)) })));
  refused("malformed", await run(fixture({ monolith: taskYaml("A") }, { fail: rootTreeIs([{ path: "plan", type: "tree", mode: "040000", sha: sha1("plan") }, ...filler(OPS_CATALOG_MAX_TREE_ENTRIES - 1)]) })));
  const many: Record<string, string> = {};
  for (let i = 0; i <= OPS_CATALOG_MAX_SHARDS; i++) many[`s${i}.yaml`] = taskYaml(`S${i}`);
  refused("malformed", await run(fixture({ monolith: taskYaml("A"), shards: many })));
  refused("malformed", await run(fixture({ monolith: `# ${"x".repeat(OPS_CATALOG_MAX_BLOB_BYTES)}\n${taskYaml("A")}` })));
  const spread: Record<string, string> = {};
  for (let i = 0; i < 40; i++) spread[`s${i}.yaml`] = `# ${"y".repeat(OPS_CATALOG_MAX_BLOB_BYTES - 1000)}\n${taskYaml(`S${i}`)}`;
  refused("malformed", await run(fixture({ monolith: taskYaml("A"), shards: spread })));
});

test("W1-T11768 criterion 2: a blob with a wrong size, bad base64 or non-utf8 bytes is malformed", async () => {
  const mono = taskYaml("A");
  const body = { sha: blobSha(mono), encoding: "base64", size: Buffer.byteLength(mono), content: Buffer.from(mono).toString("base64") };
  const patch = (changes: Record<string, unknown>) => (p: string) => p.endsWith(`/git/blobs/${blobSha(mono)}`) ? { ...body, ...changes } : undefined;
  refused("malformed", await run(fixture({ monolith: mono }, { fail: patch({ size: 1 }) })));
  refused("malformed", await run(fixture({ monolith: mono }, { fail: patch({ content: "!!!not base64!!!" }) })));
  refused("malformed", await run(fixture({ monolith: mono }, { fail: patch({ encoding: "utf-8" }) })));
  refused("malformed", await run(fixture({ monolith: mono }, { fail: patch({ content: "A".repeat(OPS_CATALOG_MAX_BLOB_BYTES * 2) }) })));
  const bad = Buffer.from([0xff, 0xfe, 0xfd]);
  const badSha = sha1(Buffer.concat([Buffer.from("blob 3\0"), bad]));
  refused("malformed", await run(fixture({ monolith: mono }, { fail: (p) => p.endsWith(`/git/trees/${sha1("plan")}`)
    ? { sha: sha1("plan"), truncated: false, tree: [{ path: "tasks.yaml", type: "blob", mode: "100644", sha: badSha }] }
    : p.endsWith(`/git/blobs/${badSha}`) ? { sha: badSha, encoding: "base64", size: 3, content: bad.toString("base64") } : undefined })));
});

test("W1-T11768 criterion 2: the outcome set is closed and stable", () => {
  assert.deepEqual([...OPS_CATALOG_OUTCOMES], ["ok", "auth_missing", "unreadable", "source_absent", "stale", "ref_moved", "malformed", "duplicate_task_id"]);
});

test("W1-T11768 criterion 2: a live broker cannot hide a moved ref or persist private responses", async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "rmd-ops-broker-"));
  const previous = { PATH: process.env.PATH, RMD_GH_CACHE_HOME: process.env.RMD_GH_CACHE_HOME };
  let shim: ReturnType<typeof ghShim> | undefined;
  try {
    process.env.RMD_GH_CACHE_HOME = root;
    const dir = ghBrokerDir()!;
    const fx = fixture({ monolith: taskYaml("OPS-T1"), shards: { "private.yaml": taskYaml("OPS-T2") } });
    const refPath = `repos/${REPO}/git/ref/heads/main`;
    const originalRef = { object: { type: "commit", sha: fx.commit } };
    const movedRef = { object: { type: "commit", sha: sha1("commit-2") } };
    const refFile = join(root, "upstream-ref.json");
    fs.writeFileSync(refFile, JSON.stringify(originalRef));
    await readOpsCatalogSnapshotAsync({ repository: REPO }, fx.api);
    const routes: GhShimRoute[] = [];
    for (const path of new Set(fx.calls)) {
      routes.push(path === refPath ? { when: path, stdoutFile: refFile } : {
        when: path, stdout: JSON.stringify(await fx.api(path)),
        ...(path.includes("/git/blobs/") ? { writes: { path: refFile, content: JSON.stringify(movedRef) } } : {}),
      });
    }
    shim = ghShim(routes.sort((a, b) => b.when.length - a.when.length));
    process.env.PATH = `${shim.dir}:${previous.PATH ?? ""}`;
    let now = 0;
    let upstream = 0;
    const broker = new GhReadBroker(dir, async (args) => {
      if (args[1] === "user") return { stdout: "fixture-user\n", stderr: "", exitCode: 0 };
      upstream++;
      return { stdout: `HTTP/2.0 200 OK\r\nCache-Control: max-age=3600\r\n\r\n${JSON.stringify(originalRef)}`, stderr: "", exitCode: 0 };
    }, clockFromMillisFn(() => now), async (ms) => { now += ms; }, () => 1e12, { sharedPaceRoot: null });
    fs.writeFileSync(join(dir, "heartbeat"), "60\n");
    // Use the real broker/cache through its socket protocol without requiring a Unix listener.
    t.mock.method(net, "connect", () => {
      const socket = new EventEmitter() as EventEmitter & {
        setEncoding(): void; destroy(): void; write(data: string): void;
      };
      socket.setEncoding = () => {};
      socket.destroy = () => {};
      socket.write = (data) => {
        void broker.read(JSON.parse(data)).then(
          (result) => socket.emit("data", `${JSON.stringify({ type: "result", ...result })}\n`),
          (error) => socket.emit("error", error),
        );
      };
      queueMicrotask(() => socket.emit("connect"));
      return socket as never;
    });
    syncBuiltinESMExports();
    assert.equal(ghBrokerRouteFor(), join(dir, "broker.sock"), "positive control: the broker is live");
    assert.deepEqual(await ghJsonAsync(["api", refPath]), originalRef);
    assert.deepEqual(await ghJsonAsync(["api", refPath]), originalRef);
    assert.equal(upstream, 1, "positive control: the second ordinary ref read is cached");
    const cache = () => Object.fromEntries(fs.readdirSync(join(dir, "cache"))
      .map((name) => [name, fs.readFileSync(join(dir, "cache", name), "utf8")]));
    const before = cache();
    assert.ok(Object.keys(before).length > 0, "positive control: the broker persists ordinary responses");
    const api = defaultOpsCatalogApi({ pacer: { wait() {}, recordResult() {}, async waitAsync() {} } });
    refused("ref_moved", await readOpsCatalogSnapshotAsync({ repository: REPO }, api));
    assert.deepEqual(await ghJsonAsync(["api", refPath]), originalRef, "the broker still holds the old ref");
    assert.equal(upstream, 1);
    assert.deepEqual(cache(), before, "catalog responses never enter the persistent broker cache");
    fs.writeFileSync(refFile, JSON.stringify(originalRef));
    for (const path of new Set(fx.calls.filter((path) => path.includes("/git/blobs/")))) {
      shim.addRoute({ when: path, stdout: JSON.stringify(await fx.api(path)) });
    }
    const snap = await readOpsCatalogSnapshotAsync({ repository: REPO }, api);
    assert.equal(snap.outcome, "ok");
    assert.equal(snap.plan?.tasks.length, 2);
    assert.deepEqual(cache(), before, "successful private reads also remain in memory");
    assert.ok(shim.calls().every((call) => !/--cache|--method|-X/.test(call)), "direct children use uncached GETs");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (shim) fs.rmSync(shim.dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
