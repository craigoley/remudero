import { createHash } from "node:crypto";
import { RmdError } from "./errors.js";
import { ghJsonAsync, createGhCallPacer, type GhCallPacer } from "./github-transport.js";
import { mergePlanBlobs, PlanError, type Plan } from "./plan.js";
import { freezeReadGeneration } from "./read-plane.js";

/**
 * W1-T11768: a private ops task catalog read read-only at one pinned commit, or refused with a stable code.
 * The shape of `readSelectedRegistry` (W1-T9493) applied to the plan monolith plus its shard directory: bind the
 * numeric repository id, branch ref, commit, exact-path trees and blob SHAs, verify git's blob SHA-1 over the
 * decoded bytes, re-read the ref afterwards. Private bytes stay in memory: no clone, worktree, mirror or file
 * write, and the injected api is GET-only. Nothing here is a selector; the caller feeds an `ok` Plan to the
 * shadow composer only.
 */

export const OPS_CATALOG_OUTCOMES = [
  "ok", "auth_missing", "unreadable", "source_absent", "stale", "ref_moved", "malformed", "duplicate_task_id",
] as const;
export type OpsCatalogOutcome = typeof OPS_CATALOG_OUTCOMES[number];

// BACKSTOP: each bound below fires only on a catalog far past anything a task plan holds, and refuses it whole.
export const OPS_CATALOG_MAX_TREE_ENTRIES = 10_000;
export const OPS_CATALOG_MAX_SHARDS = 500; // BACKSTOP: refuses a runaway shard directory.
export const OPS_CATALOG_MAX_BLOB_BYTES = 256 * 1024; // BACKSTOP: the W1-T9493 per-blob bound.
export const OPS_CATALOG_MAX_TOTAL_BYTES = 8 * 1024 * 1024; // BACKSTOP: caps one snapshot's memory.

export interface OpsCatalogTarget { repository: string }
/** A GET-only seam: the path is relative to the API root and the result is the parsed JSON body. */
export type OpsCatalogApi = (path: string) => Promise<unknown>;

/** What an api may throw to name an unusable identity; any other thrown value reads as `unreadable`. */
export class OpsCatalogAuthMissingError extends RmdError {
  constructor() { super("github", 1, "ops catalog identity unavailable"); this.name = "OpsCatalogAuthMissingError"; }
}

export interface OpsCatalogBinding {
  repositoryId: number;
  ref: string;
  commit: string;
  tasksYamlBlob: string;
  shardTreeSha: string;
  shardBlobs: Record<string, string>;
}
export interface OpsCatalogCounts { treeEntries: number; shards: number; bytes: number }
export interface OpsCatalogSnapshot {
  outcome: OpsCatalogOutcome;
  /** Present only when `outcome` is `ok`. */
  plan?: Plan;
  binding?: OpsCatalogBinding;
  /** sha256 of the identity tuple; the only identity an observer sees. */
  identityDigest?: string;
  counts: OpsCatalogCounts;
}
export interface OpsCatalogShadowInput {
  outcome: OpsCatalogOutcome;
  plan?: Plan;
  opsCommit?: string;
  identityDigest?: string;
}

class Refusal extends RmdError {
  readonly outcome: OpsCatalogOutcome;
  constructor(outcome: OpsCatalogOutcome) { super("github", 1, outcome); this.outcome = outcome; }
}

const AUTH_TEXT = /auth login|GH_TOKEN|GITHUB_TOKEN|HTTP 401|authentication/i;

/** The default GET-only api: `ghJsonAsync` behind the existing pacer. Errors are reduced to a code-bearing class. */
export function defaultOpsCatalogApi(
  opts: { pacer?: GhCallPacer; exec?: Parameters<typeof ghJsonAsync>[1] } = {},
): OpsCatalogApi {
  const pacer = opts.pacer ?? createGhCallPacer();
  return async (path) => {
    try {
      await pacer.waitAsync?.();
      return await ghJsonAsync(["api", path], opts.exec);
    } catch (error) {
      // gh's message carries URLs and bodies: classify it here and let it go.
      const text = error instanceof Error ? `${error.message}\n${String((error as { stderr?: unknown }).stderr ?? "")}` : "";
      throw AUTH_TEXT.test(text) ? new OpsCatalogAuthMissingError() : new Refusal("unreadable");
    }
  };
}

function rec(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Refusal("malformed");
  return value as Record<string, unknown>;
}
const SHA = /^[a-f0-9]{40}$/;
function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Refusal("malformed");
  return value;
}

async function get(api: OpsCatalogApi, path: string): Promise<unknown> {
  try { return await api(path); }
  catch (error) {
    if (error instanceof OpsCatalogAuthMissingError) throw new Refusal("auth_missing");
    throw new Refusal("unreadable");
  }
}

interface TreeEntry { path: string; type: string; mode: string; sha: string }
async function readTree(api: OpsCatalogApi, repo: string, treeSha: string, counts: OpsCatalogCounts): Promise<TreeEntry[]> {
  const tree = rec(await get(api, `${repo}/git/trees/${treeSha}`));
  if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)
    || tree.tree.length > OPS_CATALOG_MAX_TREE_ENTRIES) throw new Refusal("malformed");
  counts.treeEntries += tree.tree.length;
  if (counts.treeEntries > OPS_CATALOG_MAX_TREE_ENTRIES) throw new Refusal("malformed");
  return tree.tree.map((raw) => {
    const e = rec(raw);
    if (typeof e.path !== "string" || typeof e.type !== "string" || typeof e.mode !== "string") throw new Refusal("malformed");
    return { path: e.path, type: e.type, mode: e.mode, sha: sha(e.sha) };
  });
}

function one(entries: TreeEntry[], name: string): TreeEntry | undefined {
  const matches = entries.filter((e) => e.path === name);
  if (matches.length > 1) throw new Refusal("malformed");
  return matches[0];
}

const regular = (e: TreeEntry): boolean => e.type === "blob" && (e.mode === "100644" || e.mode === "100755");

async function readBlob(api: OpsCatalogApi, repo: string, blobSha: string, counts: OpsCatalogCounts): Promise<string> {
  const blob = rec(await get(api, `${repo}/git/blobs/${blobSha}`));
  if (blob.sha !== blobSha || blob.encoding !== "base64" || typeof blob.content !== "string"
    || blob.content.length > Math.ceil(OPS_CATALOG_MAX_BLOB_BYTES * 4 / 3) + 1024) throw new Refusal("malformed");
  const encoded = blob.content.replace(/[\r\n]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Refusal("malformed");
  const bytes = Buffer.from(encoded, "base64");
  counts.bytes += bytes.length;
  if (bytes.length > OPS_CATALOG_MAX_BLOB_BYTES || counts.bytes > OPS_CATALOG_MAX_TOTAL_BYTES
    || blob.size !== bytes.length) throw new Refusal("malformed");
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blobSha) throw new Refusal("malformed");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Refusal("malformed"); }
}

async function readBranchSha(api: OpsCatalogApi, repo: string, branch: string): Promise<string> {
  const ref = rec(rec(await get(api, `${repo}/git/ref/heads/${encodeURIComponent(branch)}`)).object);
  if (ref.type !== "commit") throw new Refusal("malformed");
  return sha(ref.sha);
}

function digestOf(binding: OpsCatalogBinding): string {
  return createHash("sha256").update(JSON.stringify([
    binding.repositoryId, binding.ref, binding.commit, binding.tasksYamlBlob, binding.shardTreeSha,
    Object.entries(binding.shardBlobs),
  ])).digest("hex");
}

async function read(target: OpsCatalogTarget, api: OpsCatalogApi, counts: OpsCatalogCounts): Promise<OpsCatalogSnapshot> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repository)) throw new Refusal("unreadable");
  const repo = `repos/${target.repository}`;
  const meta = rec(await get(api, repo));
  const repositoryId = meta.id;
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId < 1
    || typeof meta.full_name !== "string" || meta.full_name.toLowerCase() !== target.repository.toLowerCase()
    || typeof meta.default_branch !== "string" || !meta.default_branch) throw new Refusal("malformed");
  const branch = meta.default_branch;
  const commit = await readBranchSha(api, repo, branch);
  const commitBody = rec(await get(api, `${repo}/git/commits/${commit}`));
  if (sha(commitBody.sha) !== commit) throw new Refusal("malformed");
  const root = await readTree(api, repo, sha(rec(commitBody.tree).sha), counts);
  const planDir = one(root, "plan");
  if (!planDir) throw new Refusal("source_absent");
  if (planDir.type !== "tree" || planDir.mode !== "040000") throw new Refusal("malformed");
  const planEntries = await readTree(api, repo, planDir.sha, counts);
  const monolith = one(planEntries, "tasks.yaml");
  if (!monolith) throw new Refusal("source_absent");
  if (!regular(monolith)) throw new Refusal("malformed");
  const shardDir = one(planEntries, "tasks.d");
  if (shardDir && (shardDir.type !== "tree" || shardDir.mode !== "040000")) throw new Refusal("malformed");
  const shardEntries = shardDir ? (await readTree(api, repo, shardDir.sha, counts))
    .filter((e) => e.path.endsWith(".yaml") || e.path.endsWith(".yml"))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) : [];
  if (shardEntries.length > OPS_CATALOG_MAX_SHARDS || !shardEntries.every(regular)) throw new Refusal("malformed");
  counts.shards = shardEntries.length;
  const blobs: Array<{ label: string; text: string }> = [
    { label: "tasks.yaml", text: await readBlob(api, repo, monolith.sha, counts) },
  ];
  for (const e of shardEntries) blobs.push({ label: `tasks.d/${e.path}`, text: await readBlob(api, repo, e.sha, counts) });
  // The ref must still name the commit every read above was bound to.
  if (await readBranchSha(api, repo, branch) !== commit) throw new Refusal("ref_moved");
  const shardTreeSha = shardDir ? shardDir.sha : "";
  let plan: Plan;
  try {
    // The strict merge: no quarantine, so a duplicate or invalid shard refuses the whole snapshot. The Plan is frozen
    // with the freeze the plan revision store uses, and is this snapshot's own, never the primary plan's. This module
    // does not import the store: the store's module reaches the daemon, so importing it here would put this module
    // inside the daemon's import cycle (the affected-reach ratchet's largest-component bound). A later per-tick source
    // (W1-T11769) that wants unchanged blobs reused injects the store at the daemon.
    plan = freezeReadGeneration(mergePlanBlobs(blobs));
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal(error instanceof PlanError && /^duplicate task id /.test(error.message) ? "duplicate_task_id" : "malformed");
  }
  const binding: OpsCatalogBinding = Object.freeze({
    repositoryId, ref: `refs/heads/${branch}`, commit, tasksYamlBlob: monolith.sha, shardTreeSha,
    shardBlobs: Object.freeze(Object.fromEntries(shardEntries.map((e) => [e.path, e.sha]))) as Record<string, string>,
  });
  return { outcome: "ok", plan, binding, identityDigest: digestOf(binding), counts };
}

/**
 * Read the target's catalog once at one pinned commit. Never throws and never returns a partial Plan: every
 * failure is one outcome code plus counts, with the transport error's message dropped.
 */
export async function readOpsCatalogSnapshotAsync(
  target: OpsCatalogTarget,
  api: OpsCatalogApi = defaultOpsCatalogApi(),
): Promise<OpsCatalogSnapshot> {
  const counts: OpsCatalogCounts = { treeEntries: 0, shards: 0, bytes: 0 };
  try { return await read(target, api, counts); }
  catch (error) {
    // The outcome code is the reason: the error's own message may hold a URL or body, so it is dropped here.
    return { outcome: error instanceof Refusal ? error.outcome : "unreadable", counts };
  }
}

/**
 * A stateful source for a per-tick refresh: a refresh that fails after an earlier success reads `stale` and
 * never hands the earlier snapshot back as current.
 */
export function createOpsCatalogShadowSource(
  target: OpsCatalogTarget,
  api: OpsCatalogApi = defaultOpsCatalogApi(),
): { refresh(): Promise<OpsCatalogShadowInput> } {
  let everOk = false;
  return {
    async refresh() {
      const snap = await readOpsCatalogSnapshotAsync(target, api);
      if (snap.outcome === "ok") {
        everOk = true;
        return { outcome: "ok", plan: snap.plan, opsCommit: snap.binding?.commit, identityDigest: snap.identityDigest };
      }
      return { outcome: everOk ? "stale" : snap.outcome };
    },
  };
}
