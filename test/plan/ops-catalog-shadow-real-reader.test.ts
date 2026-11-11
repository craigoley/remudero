import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readOpsCatalogSnapshotAsync, createOpsCatalogShadowSource, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";

const REPO = "fixture-private/ops";
const hash = (s: string) => createHash("sha1").update(s).digest("hex");
const task = (id: string, deps: string[] = []) => `- id: ${id}\n  title: PRIVATE_TITLE_SENTINEL\n  repo: remudero\n  type: implement\n  priority: 0\n  depends_on: ${JSON.stringify(deps)}\n`;
function catalog(text: string, shards: Record<string, string> = {}) {
  const commit = hash(JSON.stringify([text, shards]));
  const tree = hash(commit + "root"), plan = hash(commit + "plan"), shardTree = hash(commit + "shards");
  const blobs = new Map<string, string>();
  const put = (s: string) => { const id = hash(`blob ${Buffer.byteLength(s)}\0${s}`); blobs.set(id, s); return id; };
  const entry = (path: string, sha: string, type = "tree") => ({ path, sha, type, mode: type === "tree" ? "040000" : "100644" });
  const shardEntries = Object.entries(shards).map(([name, s]) => entry(name, put(s), "blob"));
  const rootBlob = put(text), calls: string[] = [];
  const api: OpsCatalogApi = async path => {
    calls.push(path);
    const prefix = `repos/${REPO}`;
    if (path === prefix) return { id: 42, full_name: REPO, default_branch: "main" };
    if (path === `${prefix}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${prefix}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${prefix}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [entry("plan", plan)] };
    if (path === `${prefix}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [entry("tasks.yaml", rootBlob, "blob"), entry("tasks.d", shardTree)] };
    if (path === `${prefix}/git/trees/${shardTree}`) return { sha: shardTree, truncated: false, tree: shardEntries };
    const sha = path.slice(`${prefix}/git/blobs/`.length), s = blobs.get(sha);
    assert.ok(path.startsWith(`${prefix}/git/blobs/`) && s !== undefined, "only recorded GET routes are permitted");
    return { sha, encoding: "base64", size: Buffer.byteLength(s), content: Buffer.from(s).toString("base64") };
  };
  return { api, commit, calls };
}
import "#src/lib/live-analytics-snapshot-cache.js";
import { runDaemon, compareSecondaryCatalogShadow, type DaemonDeps } from "#src/lib/daemon.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import { mergePlanBlobs, type Plan } from "#src/lib/plan.js";
import { runnableCandidates } from "#src/lib/drain.js";

const primary = () => mergePlanBlobs([{ label: "public.yaml", text: task("PUBLIC-T1") + task("PUBLIC-T2") }]);
async function drive(plan: Plan, snapshot?: Awaited<ReturnType<typeof readOpsCatalogSnapshotAsync>>, max = 2) {
  const merged = new Set<string>(), claims: string[] = [], workers: string[] = [], rows: Record<string, unknown>[] = [], other: unknown[] = [];
  const deps: DaemonDeps = {
    refreshMerged: () => id => merged.has(id), targetRepo: "remudero",
    runOne: async id => { claims.push(id); workers.push(id); merged.add(id); return { taskId: id, runId: id, merged: true, costUsd: 0, verdict: "merged" }; },
    sleep: async () => {}, now: () => new Date("2026-01-01T00:00:00Z"), bootCheckoutBlocked: "",
    memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), heapUsed: () => 1, setFlags: () => {} }),
    heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
    log: (step, extra = {}) => { if (step === "dispatch.secondary_catalog_shadow") rows.push(extra); else other.push([step, extra]); },
    ...(snapshot ? { secondaryCatalogShadowSource: () => ({ outcome: snapshot.outcome, plan: snapshot.plan, opsCommit: snapshot.binding?.commit }), primaryPlanCommit: () => "1".repeat(40) } : {}),
  };
  const result = await runDaemon(plan, deps, { max });
  return { claims, workers, merged: result.merged, rows, effects: JSON.stringify(other) };
}

test("W1-T12185 criterion 2: actual reader output resolves against the public merged set without changing dispatch", async () => {
  const fx = catalog(task("OPS-T1", ["PUBLIC-T1"]));
  const snap = await readOpsCatalogSnapshotAsync({ repository: REPO }, fx.api);
  assert.equal(snap.outcome, "ok");
  const p = primary(), pending = new Set<string>();
  const before = compareSecondaryCatalogShadow(p, snap.plan, runnableCandidates(p, id => pending.has(id), 8), id => pending.has(id), 8, {});
  assert.equal(before!.outcome, "compared");
  assert.equal(before!.secondary_candidate_count, 0);
  pending.add("PUBLIC-T1");
  const after = compareSecondaryCatalogShadow(p, snap.plan, runnableCandidates(p, id => pending.has(id), 8), id => pending.has(id), 8, {});
  assert.equal(after!.secondary_candidate_count, 1);
  const baseline = await drive(primary()), observed = await drive(primary(), snap);
  assert.deepEqual(observed.claims, baseline.claims);
  assert.deepEqual(observed.workers, baseline.workers);
  assert.deepEqual(observed.merged, baseline.merged);
  assert.equal(observed.effects, baseline.effects);
  assert.ok(observed.rows.some(r => r.secondary_candidate_count === 1));
  assert.ok(observed.workers.every(id => id.startsWith("PUBLIC-")));
  assert.doesNotMatch(JSON.stringify(observed.rows), /PRIVATE_TITLE_SENTINEL|OPS-T1|fixture-private/);
});
