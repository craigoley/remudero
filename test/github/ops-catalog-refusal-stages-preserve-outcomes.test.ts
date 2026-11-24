import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createGhCallPacer } from "#src/lib/github-transport.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { OpsCatalogAuthMissingError, createOpsCatalogShadowSource, defaultOpsCatalogApi, readOpsCatalogSnapshotAsync, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";

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

test("W13319: real catalog refusals retain their exact outcome and name only the failed stage", async () => {
  const mono = taskYaml("A");
  const cases: Array<[Catalog, Parameters<typeof fixture>[1], string, string]> = [
    [{monolith:mono},{fail:p=>p===`repos/${REPO}`?{}:undefined},"malformed","repository_identity"],
    [{monolith:mono},{fail:p=>p.includes("/git/ref/")?{}:undefined},"malformed","branch_ref"],
    [{monolith:mono},{fail:p=>p.includes("/git/commits/")?{}:undefined},"malformed","commit"],
    [{monolith:mono},{fail:rootTreeIs([])},"source_absent","plan_tree"],
    [{monolith:mono},{fail:p=>p.endsWith(`/git/trees/${sha1("root")}`)?{}:undefined},"malformed","root_tree"],
    [{monolith:mono},{fail:p=>p.endsWith(`/git/trees/${sha1("plan")}`)?{}:undefined},"malformed","plan_tree"],
    [{monolith:mono,shards:{"one.yaml":taskYaml("B")}},{fail:p=>p.endsWith(`/git/trees/${sha1("tasks.d")}`)?{}:undefined},"malformed","shard_tree"],
    [{monolith:mono},{fail:p=>p.includes("/git/blobs/")?{}:undefined},"malformed","blob_verification"],
    [{monolith:mono},{moveRefAfterBlobs:true},"ref_moved","final_ref"],
    [{monolith:"- id: A\n  title: ["},{},"malformed","strict_parse"],
    [{monolith:mono+mono},{},"duplicate_task_id","strict_parse"],
    [{monolith:mono},{fail:()=>new OpsCatalogAuthMissingError()},"auth_missing","repository_identity"],
  ];
  for(const [catalog,hooks,outcome,stage] of cases){
    const fx=fixture(catalog,hooks),snap=await run(fx);refused(outcome,snap);
    assert.equal((snap as unknown as {refusalStage?:unknown}).refusalStage,stage);
    assert.ok(fx.calls.every(p=>p.startsWith(`repos/${REPO}`)),"positive control: only declared GET routes executed");
  }
  const healthy=await run(fixture({monolith:mono}));assert.equal(healthy.outcome,"ok");assert.equal((healthy as unknown as {refusalStage?:unknown}).refusalStage,undefined);
  let failed=false;const fx=fixture({monolith:mono},{fail:()=>failed?new Error("private transport error"):undefined}),source=createOpsCatalogShadowSource(target,fx.api);
  assert.equal((await source.refresh()).outcome,"ok");failed=true;const stale=await source.refresh();
  // W1-T14564 (operator ruling 2026-11-23): the kept snapshot answers the failed refresh; the refusal keeps its stage.
  assert.equal(stale.outcome,"ok");assert.ok(stale.plan!==undefined);assert.equal(stale.lastGood?.refusal,"stale");assert.equal(stale.lastGood?.refusalStage,"branch_ref");
  assert.equal(stale.refused?.outcome,"stale");assert.equal((stale.refused as unknown as {refusalStage?:unknown}).refusalStage,"branch_ref");assert.equal(stale.refused?.plan,undefined);
});

test("W13319: cold default transport reports the repository stage without changing auth refusal", async () => {
  await withGhShim([{ when: `repos/${REPO}`, stderr: "gh: Bad credentials (HTTP 401)", exit: 1 }], async shim => {
    const api = defaultOpsCatalogApi({ pacer: createGhCallPacer() });
    const result = await readOpsCatalogSnapshotAsync(target, api);
    refused("auth_missing", result);
    assert.equal((result as unknown as { refusalStage?: unknown }).refusalStage, "repository_identity");
    assert.equal(shim.calls().length, 1, "the real cold child was invoked exactly once");
    assert.ok(shim.calls().every(call => call.startsWith("api repos/")));
  });
});
