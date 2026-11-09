import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
// The daemon and the live analytics cache import each other and the cache reads a daemon constant at load,
// so the cache loads first and the daemon (the module under test) finishes before the cache evaluates.
import "#src/lib/live-analytics-snapshot-cache.js";
import { runDaemon } from "#src/lib/daemon.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { mergePlanBlobs, type Plan } from "#src/lib/plan.js";
import {
  OpsCatalogAuthMissingError, createOpsCatalogShadowSource, defaultOpsCatalogApi, readOpsCatalogSnapshotAsync, type OpsCatalogApi,
} from "#src/lib/ops-catalog-source.js";

const REPO = "acme-private/ops-secret-slug";
const sha1 = (b: Buffer | string): string => createHash("sha1").update(b).digest("hex");
const blobSha = (text: string): string => sha1(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(text)}\0`), Buffer.from(text)]));
const taskYaml = (id: string, title = "PRIVATE_TITLE_SENTINEL"): string =>
  `- id: ${id}\n  title: "${title}"\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [private/PRIVATE_PATH_SENTINEL]\n  rationale: PRIVATE_BODY_SENTINEL\n`;

interface Catalog { monolith?: string; shards?: Record<string, string>; noPlanDir?: boolean }
interface Fx { api: OpsCatalogApi; calls: string[] }

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
  return { api, calls };
}

const target = { repository: REPO };
const SENTINELS = ["PRIVATE_TITLE_SENTINEL", "PRIVATE_PATH_SENTINEL", "PRIVATE_BODY_SENTINEL", REPO, "ops-secret-slug", "ghp_SECRET_TOKEN_SENTINEL", "tasks.d", "plan/tasks"];

function sweep(label: string, value: unknown): void {
  const text = JSON.stringify(value);
  for (const s of SENTINELS) assert.equal(text.includes(s), false, `${label} carries ${s}`);
}

test("W1-T11768 criterion 3: a transport error's message never reaches a result", async () => {
  const leaks = new Error(`GET https://api.github.com/repos/${REPO}/contents/private/PRIVATE_PATH_SENTINEL: HTTP 500 PRIVATE_BODY_SENTINEL Bearer ghp_SECRET_TOKEN_SENTINEL`);
  (leaks as unknown as { stderr: string }).stderr = "PRIVATE_TITLE_SENTINEL";
  const snap = await readOpsCatalogSnapshotAsync(target, async () => { throw leaks; });
  assert.equal(snap.outcome, "unreadable");
  sweep("transport failure", snap);
  sweep("shadow input", await createOpsCatalogShadowSource(target, async () => { throw leaks; }).refresh());
});

test("W1-T11768 criterion 3: every outcome's serialized result is clean of private content", async () => {
  const mono = taskYaml("OPS-T1");
  const cases: Array<[string, OpsCatalogApi]> = [
    ["ok", fixture({ monolith: mono, shards: { "a.yaml": taskYaml("OPS-T2") } }).api],
    ["source_absent", fixture({ noPlanDir: true }).api],
    ["ref_moved", fixture({ monolith: mono }, { moveRefAfterBlobs: true }).api],
    ["malformed", fixture({ monolith: "- id: PRIVATE_TITLE_SENTINEL\n  title: [" }).api],
    ["duplicate", fixture({ monolith: mono + mono }).api],
    ["auth", fixture({ monolith: mono }, { fail: () => new OpsCatalogAuthMissingError() }).api],
    ["404", async (p) => { throw new Error(`HTTP 404 ${p} PRIVATE_BODY_SENTINEL`); }],
  ];
  for (const [label, api] of cases) {
    const snap = await readOpsCatalogSnapshotAsync(target, api);
    sweep(label, { ...snap, plan: undefined });
  }
});

test("W1-T11768 criterion 3: only GET read endpoints are requested and nothing is written", async (t) => {
  const fx = fixture({ monolith: taskYaml("OPS-T1"), shards: { "a.yaml": taskYaml("OPS-T2") } });
  const writes: string[] = [];
  const forbid = (method: string) => () => {
    writes.push(method);
    throw new Error("filesystem mutation forbidden");
  };
  // Observe this process's mutation attempts; other test processes may clean up the shared temp directory.
  for (const method of ["appendFile", "copyFile", "cp", "link", "mkdir", "mkdtemp", "open", "rename",
    "rm", "rmdir", "symlink", "truncate", "unlink", "write", "writeFile", "writev"] as const) {
    t.mock.method(fs, method, forbid(method));
    t.mock.method(fs, `${method}Sync`, forbid(`${method}Sync`));
  }
  for (const method of ["appendFile", "copyFile", "cp", "link", "mkdir", "mkdtemp", "open", "rename",
    "rm", "rmdir", "symlink", "truncate", "unlink", "writeFile"] as const) {
    t.mock.method(fs.promises, method, forbid(`promises.${method}`));
  }
  t.mock.method(fs, "createWriteStream", forbid("createWriteStream"));
  syncBuiltinESMExports();
  try {
    assert.throws(() => fs.writeFileSync("PRIVATE_PATH_SENTINEL", "PRIVATE_BODY_SENTINEL"), /filesystem mutation forbidden/);
    assert.deepEqual(writes, ["writeFileSync"], "positive control observes a write without persisting private bytes");
    writes.length = 0;
    const snap = await readOpsCatalogSnapshotAsync(target, fx.api);
    assert.equal(snap.outcome, "ok", "the read completes while filesystem mutations are forbidden");
    assert.deepEqual(writes, [], "no filesystem mutation is attempted, even if its error would be caught");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.ok(fx.calls.length > 0);
  assert.ok(fx.calls.every((p) => /^repos\/[^/]+\/[^/]+(\/git\/(ref\/heads\/main|commits\/[a-f0-9]{40}|trees\/[a-f0-9]{40}|blobs\/[a-f0-9]{40}))?$/.test(p)), "only read endpoints of the git data API");
  assert.equal(fx.api.length, 1, "the api seam takes a path and no method or body");
});

test("W1-T11768 criterion 3: the default api reads through gh api, paces, and reduces failures to a code", async () => {
  const seen: string[][] = [];
  let waits = 0;
  const pacer = { wait() {}, recordResult() {}, async waitAsync() { waits++; } };
  const ok = defaultOpsCatalogApi({ pacer, exec: (async (_file: string, args: string[]) => { seen.push(args); return { stdout: JSON.stringify({ id: 7 }), stderr: "" }; }) as never });
  assert.deepEqual(await ok("repos/o/r"), { id: 7 });
  assert.equal(waits, 1);
  assert.deepEqual(seen[0].slice(0, 2), ["api", "repos/o/r"]);
  assert.ok(!seen[0].includes("-X") && !seen[0].includes("--method"), "no write verb");
  const unauth = defaultOpsCatalogApi({ pacer, exec: (async () => { throw Object.assign(new Error("To get started with GitHub CLI, please run:  gh auth login"), { stderr: "" }); }) as never });
  await assert.rejects(unauth("repos/o/r"), OpsCatalogAuthMissingError);
  const badCredentials = defaultOpsCatalogApi({ pacer, exec: (async () => { throw Object.assign(new Error("failed"), { stderr: "HTTP 401: Bad credentials ghp_SECRET_TOKEN_SENTINEL" }); }) as never });
  await assert.rejects(badCredentials("repos/o/r"), OpsCatalogAuthMissingError);
  const down = defaultOpsCatalogApi({ pacer, exec: (async () => { throw new Error(`HTTP 404 repos/${REPO} PRIVATE_BODY_SENTINEL`); }) as never });
  const failure = (await down("repos/o/r").catch((e: unknown) => e)) as Error;
  assert.equal(String(failure.message).includes("PRIVATE_BODY_SENTINEL"), false, "the transport message is replaced");
  await assert.rejects(defaultOpsCatalogApi({ pacer, exec: (async () => { throw "plain string"; }) as never })("repos/o/r"));
  const unpaced = defaultOpsCatalogApi({ pacer: { wait() {}, recordResult() {} }, exec: (async () => ({ stdout: "{}", stderr: "" })) as never });
  assert.deepEqual(await unpaced("repos/o/r"), {});
  assert.equal((await readOpsCatalogSnapshotAsync(target, unauth)).outcome, "auth_missing");
});

test("W1-T11768 criterion 3: the real default api shells out to gh and its answer is refused when it is not a repository", async () => {
  const shim = ghShim([{ when: "repos/", stdout: "{\"id\": 5}\n" }]);
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${priorPath}`;
    const snap = await readOpsCatalogSnapshotAsync(target);
    assert.notEqual(snap.outcome, "ok");
    assert.equal(snap.plan, undefined);
    sweep("real default", snap);
  } finally {
    process.env.PATH = priorPath;
  }
});

const planOf = (id: string): Plan => mergePlanBlobs([{ label: "primary.yaml", text: `${taskYaml(id, "primary")}  priority: 9\n` }]);

async function daemonWith(deps: Record<string, unknown>): Promise<Array<{ step: string; extra: Record<string, unknown> }>> {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const merged = new Set<string>();
  await runDaemon(planOf("A"), {
    refreshMerged: () => (id: string) => merged.has(id),
    targetRepo: "remudero",
    runOne: async (id: string) => { merged.add(id); return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }; },
    sleep: async () => {},
    log: (step: string, extra: Record<string, unknown> = {}) => { lines.push({ step, extra }); },
    ...deps,
  } as never, { max: 1 });
  return lines;
}

test("W1-T11768 criterion 4: an injected ops target is read once and an ok plan reaches the shadow comparison only", async () => {
  const fx = fixture({ monolith: `${taskYaml("OPS-T1")}  priority: 0\n` });
  const lines = await daemonWith({ opsCatalogTarget: target, opsCatalogApi: fx.api });
  const shadow = lines.find((l) => l.step === "dispatch.secondary_catalog_shadow");
  assert.equal(shadow?.extra.outcome, "compared");
  assert.equal(shadow?.extra.secondary_candidate_count, 1);
  sweep("daemon shadow row", lines);
  assert.equal(fx.calls.filter((c) => c === `repos/${REPO}`).length, 1, "one snapshot read");
});

test("W1-T11768 criterion 4: a refused ops snapshot is an unavailable shadow, and no target changes nothing", async () => {
  const lines = await daemonWith({ opsCatalogTarget: target, opsCatalogApi: fixture({ noPlanDir: true }).api });
  assert.equal(lines.find((l) => l.step === "dispatch.secondary_catalog_shadow")?.extra.outcome, "unavailable");
  const untouched = await daemonWith({});
  assert.equal(untouched.some((l) => l.step === "dispatch.secondary_catalog_shadow"), false, "absent target: no shadow, no read");
  const explicit = await daemonWith({ secondaryPlanForShadow: planOf("OPS-X"), opsCatalogTarget: target, opsCatalogApi: async () => { throw new Error("must not read"); } });
  assert.ok(explicit.some((l) => l.step === "dispatch.secondary_catalog_shadow"), "an injected snapshot wins and no read happens");
});
