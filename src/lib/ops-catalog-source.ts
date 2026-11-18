import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { inspect, promisify } from "node:util";
import { RmdError } from "./errors.js";
import { ghJsonAsync, createGhCallPacer, type GhCallPacer } from "./github-transport.js";
import { PlanError, type Plan } from "./plan.js";
import { createPlanRevisionStore, type PlanRevisionStore } from "./plan-revision-store.js";

/**
 * W1-T11768: a private ops task catalog read read-only at one pinned commit, or refused with a stable code.
 * The shape of `readSelectedRegistry` (W1-T9493) applied to the plan monolith plus its shard directory: bind the
 * numeric repository id, branch ref, commit, exact-path trees and blob SHAs, verify git's blob SHA-1 over the
 * decoded bytes, re-read the ref afterwards. Private bytes stay in memory: no clone, worktree, mirror or file
 * write, and the injected api is GET-only. Nothing here is a selector; the caller feeds an `ok` Plan to the
 * shadow composer only. A branch that moved during the read is read again at its new commit, reusing every tree and
 * blob already verified: git names each by its content, so a reused object is the same bytes.
 */

export const OPS_CATALOG_OUTCOMES = [
  "ok", "auth_missing", "unreadable", "source_absent", "stale", "ref_moved", "malformed", "duplicate_task_id",
] as const;
export type OpsCatalogOutcome = typeof OPS_CATALOG_OUTCOMES[number];

/** Diagnostic only: a closed label never carries a private path, response or thrown text. */
export const OPS_CATALOG_REFUSAL_STAGES = [
  "repository_identity", "branch_ref", "commit", "root_tree", "plan_tree", "shard_tree",
  "blob_verification", "final_ref", "strict_parse", "source_refresh", "snapshot_age",
] as const;
export type OpsCatalogRefusalStage = typeof OPS_CATALOG_REFUSAL_STAGES[number];

/** Untrusted optional labels cannot change an outcome or become private log text. */
export function opsCatalogRefusalStage(input: unknown): OpsCatalogRefusalStage | undefined {
  try {
    if (input === null || typeof input !== "object") return undefined;
    const value = input as { outcome?: unknown; refusalStage?: unknown };
    if (value.outcome === "ok") return undefined;
    const stage = value.refusalStage;
    return typeof stage === "string" && OPS_CATALOG_REFUSAL_STAGES.includes(stage as OpsCatalogRefusalStage)
      ? stage as OpsCatalogRefusalStage : undefined;
  } catch {
    // An unreadable optional diagnostic is absent; the existing outcome/admission decision remains.
    return undefined;
  }
}

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
export interface OpsCatalogCounts {
  /** The sizes below describe the pass that produced the answer, cached objects included. */
  treeEntries: number;
  shards: number;
  bytes: number;
  /** One on a quiet branch; one more for each move of the branch the read followed. */
  passes: number;
  /** Per pass, the commit, tree and blob objects fetched over the api (the cache's misses). */
  fetchedObjects: number[];
  /** The verified trees and blobs the last pass reused instead of fetching. */
  cachedObjects: number;
}
export interface OpsCatalogSnapshot {
  outcome: OpsCatalogOutcome;
  refusalStage?: OpsCatalogRefusalStage;
  /** Present only when `outcome` is `ok`. */
  plan?: Plan;
  binding?: OpsCatalogBinding;
  /** sha256 of the identity tuple; the only identity an observer sees. */
  identityDigest?: string;
  counts: OpsCatalogCounts;
}
export interface OpsCatalogShadowInput {
  outcome: OpsCatalogOutcome;
  refusalStage?: OpsCatalogRefusalStage;
  plan?: Plan;
  opsCommit?: string;
  identityDigest?: string;
}

class Refusal extends RmdError {
  readonly outcome: OpsCatalogOutcome;
  constructor(outcome: OpsCatalogOutcome) { super("github", 1, outcome); this.outcome = outcome; }
}

const AUTH_DIAGNOSTIC = /^(?:gh: )?(?:To get started with GitHub CLI, please run:|To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable\.)/m;
const HTTP_DIAGNOSTIC = /^(?:HTTP (\d{3})(?:[ \t:]|$)|gh: [^\r\n]*?\(HTTP (\d{3})\))/m;
const execFileAsync = promisify(execFile);
const snapshotStore = createPlanRevisionStore({ strict: true, yamlLogLevel: "error", dependencyMode: "preserve-external" });

/** Private handles remain available to the shadow composer, but ordinary logging cannot traverse them. */
function privateHandles<T extends object>(summary: T, handles: object): T {
  const safe = Object.freeze({ ...summary });
  Object.defineProperties(summary, {
    ...Object.fromEntries(Object.entries(handles).map(([key, value]) => [key, { value }])),
    toJSON: { value: () => safe },
    [inspect.custom]: { value: () => safe },
  });
  return Object.freeze(summary);
}

/** The default GET-only api: `ghJsonAsync` behind the existing pacer. Errors are reduced to a code-bearing class. */
export function defaultOpsCatalogApi(
  opts: { pacer?: GhCallPacer; exec?: Parameters<typeof ghJsonAsync>[1] } = {},
): OpsCatalogApi {
  const pacer = opts.pacer ?? createGhCallPacer();
  // An explicit executor keeps ghJsonAsync off the broker's persistent response cache. The child has
  // no --cache flag; each mutable ref check reaches upstream. Pacing remains local to this source.
  const exec = opts.exec ?? ((...args: Parameters<typeof execFileAsync>) => execFileAsync(...args)) as typeof execFileAsync;
  return async (path) => {
    try {
      if (pacer.waitAsync) await pacer.waitAsync();
      else pacer.wait();
      return await ghJsonAsync(["api", path], exec, undefined, { fresh: true });
    } catch (error) {
      // Match CLI diagnostics, not auth words in echoed request paths or response bodies.
      const stderr = error instanceof Error ? (error as Error & { stderr?: unknown }).stderr : undefined;
      const diagnostic = typeof stderr === "string" && stderr ? stderr : error instanceof Error ? error.message : "";
      const status = HTTP_DIAGNOSTIC.exec(diagnostic);
      const authMissing = status ? (status[1] ?? status[2]) === "401" : AUTH_DIAGNOSTIC.test(diagnostic);
      throw authMissing ? new OpsCatalogAuthMissingError() : new Refusal("unreadable");
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

/**
 * Trees and blobs that passed every per-object check, by sha. Git names each by its content, so a cached object is the
 * object any later commit naming that sha holds. The checks over a whole snapshot (entry and byte totals) are not
 * cached: each pass applies them again to the objects it uses.
 */
interface ObjectCache { trees: Map<string, TreeEntry[]>; blobs: Map<string, { text: string; bytes: number }> }
const emptyCache = (): ObjectCache => ({ trees: new Map(), blobs: new Map() });
/**
 * One pass at one commit: `kept` is what earlier passes verified, `used` what this pass holds when it finishes, and
 * `bound` whether the commit object itself was read and matched, so later refusals are about that commit's content.
 */
interface Pass { kept: ObjectCache; used: ObjectCache; counts: OpsCatalogCounts; fetched: number; hits: number; bound: boolean }

async function readTree(api: OpsCatalogApi, repo: string, treeSha: string, pass: Pass): Promise<TreeEntry[]> {
  const counts = pass.counts;
  let entries = pass.kept.trees.get(treeSha);
  if (entries) {
    pass.hits++;
    counts.treeEntries += entries.length;
    if (counts.treeEntries > OPS_CATALOG_MAX_TREE_ENTRIES) throw new Refusal("malformed");
  } else {
    pass.fetched++;
    const tree = rec(await get(api, `${repo}/git/trees/${treeSha}`));
    if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)
      || tree.tree.length > OPS_CATALOG_MAX_TREE_ENTRIES) throw new Refusal("malformed");
    counts.treeEntries += tree.tree.length;
    if (counts.treeEntries > OPS_CATALOG_MAX_TREE_ENTRIES) throw new Refusal("malformed");
    entries = tree.tree.map((raw) => {
      const e = rec(raw);
      if (typeof e.path !== "string" || typeof e.type !== "string" || typeof e.mode !== "string") throw new Refusal("malformed");
      return { path: e.path, type: e.type, mode: e.mode, sha: sha(e.sha) };
    });
  }
  pass.used.trees.set(treeSha, entries);
  return entries;
}

function one(entries: TreeEntry[], name: string): TreeEntry | undefined {
  const matches = entries.filter((e) => e.path === name);
  if (matches.length > 1) throw new Refusal("malformed");
  return matches[0];
}

const regular = (e: TreeEntry): boolean => e.type === "blob" && (e.mode === "100644" || e.mode === "100755");

async function readBlob(api: OpsCatalogApi, repo: string, blobSha: string, pass: Pass): Promise<string> {
  const counts = pass.counts;
  const kept = pass.kept.blobs.get(blobSha);
  if (kept) {
    pass.hits++;
    counts.bytes += kept.bytes;
    if (counts.bytes > OPS_CATALOG_MAX_TOTAL_BYTES) throw new Refusal("malformed");
    pass.used.blobs.set(blobSha, kept);
    return kept.text;
  }
  pass.fetched++;
  const blob = rec(await get(api, `${repo}/git/blobs/${blobSha}`));
  if (blob.sha !== blobSha || blob.encoding !== "base64" || typeof blob.content !== "string") throw new Refusal("malformed");
  const encoded = blob.content.replace(/[\r\n]/g, "");
  if (encoded.length > Math.ceil(OPS_CATALOG_MAX_BLOB_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Refusal("malformed");
  const bytes = Buffer.from(encoded, "base64");
  counts.bytes += bytes.length;
  if (bytes.length > OPS_CATALOG_MAX_BLOB_BYTES || counts.bytes > OPS_CATALOG_MAX_TOTAL_BYTES
    || blob.size !== bytes.length) throw new Refusal("malformed");
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blobSha) throw new Refusal("malformed");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Refusal("malformed"); }
  pass.used.blobs.set(blobSha, { text, bytes: bytes.length });
  return text;
}

/** The commit a branch names now: one ref GET. `repo` is `repos/<owner>/<name>`. Throws a refusal on any failure. */
export async function readBranchSha(api: OpsCatalogApi, repo: string, branch: string): Promise<string> {
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

interface PassRead {
  monolith: TreeEntry;
  shardDir?: TreeEntry;
  shardEntries: TreeEntry[];
  blobs: Array<{ label: string; text: string }>;
}

/** Every object below `commit`, read and verified through the pass's cache. The ref is not read here. */
async function readPass(
  api: OpsCatalogApi, repo: string, commit: string, pass: Pass, atStage: (stage: OpsCatalogRefusalStage) => void,
): Promise<PassRead> {
  const counts = pass.counts;
  atStage("commit");
  pass.fetched++;
  const commitBody = rec(await get(api, `${repo}/git/commits/${commit}`));
  if (sha(commitBody.sha) !== commit) throw new Refusal("malformed");
  const rootSha = sha(rec(commitBody.tree).sha);
  pass.bound = true;
  atStage("root_tree");
  const root = await readTree(api, repo, rootSha, pass);
  atStage("plan_tree");
  const planDir = one(root, "plan");
  if (!planDir) throw new Refusal("source_absent");
  if (planDir.type !== "tree" || planDir.mode !== "040000") throw new Refusal("malformed");
  const planEntries = await readTree(api, repo, planDir.sha, pass);
  const monolith = one(planEntries, "tasks.yaml");
  if (!monolith) throw new Refusal("source_absent");
  if (!regular(monolith)) throw new Refusal("malformed");
  atStage("shard_tree");
  const shardDir = one(planEntries, "tasks.d");
  if (shardDir && (shardDir.type !== "tree" || shardDir.mode !== "040000")) throw new Refusal("malformed");
  const shardEntries = shardDir ? (await readTree(api, repo, shardDir.sha, pass))
    .filter((e) => e.path.endsWith(".yaml") || e.path.endsWith(".yml"))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) : [];
  if (shardEntries.length > OPS_CATALOG_MAX_SHARDS || !shardEntries.every(regular)) throw new Refusal("malformed");
  counts.shards = shardEntries.length;
  atStage("blob_verification");
  const blobs: Array<{ label: string; text: string }> = [
    { label: "tasks.yaml", text: await readBlob(api, repo, monolith.sha, pass) },
  ];
  for (const e of shardEntries) blobs.push({ label: `tasks.d/${e.path}`, text: await readBlob(api, repo, e.sha, pass) });
  return { monolith, shardDir, shardEntries, blobs };
}

/** A later pass refused for one of these reasons, once bound to its commit, found a defect in that commit's content. */
const CONTENT_REFUSALS: ReadonlySet<OpsCatalogOutcome> = new Set(["malformed", "source_absent"]);

async function read(
  target: OpsCatalogTarget, api: OpsCatalogApi, counts: OpsCatalogCounts, store: PlanRevisionStore, cache: { current: ObjectCache },
  atStage: (stage: OpsCatalogRefusalStage) => void,
): Promise<OpsCatalogSnapshot> {
  atStage("repository_identity");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repository)) throw new Refusal("unreadable");
  const repo = `repos/${target.repository}`;
  const meta = rec(await get(api, repo));
  const repositoryId = meta.id;
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId < 1
    || typeof meta.full_name !== "string" || meta.full_name.toLowerCase() !== target.repository.toLowerCase()
    || typeof meta.default_branch !== "string" || !meta.default_branch) throw new Refusal("malformed");
  const branch = meta.default_branch;
  atStage("branch_ref");
  let commit = await readBranchSha(api, repo, branch);
  // Each pass reads one commit whole. A pass whose closing ref read still names its commit is the answer; a moved ref
  // starts the next pass at the commit it names, which costs only the objects that commit changed. A later pass that
  // reused nothing is not converging, and the read refuses ref_moved as a single pass would.
  for (;;) {
    const pass: Pass = { kept: cache.current, used: emptyCache(), counts, fetched: 0, hits: 0, bound: false };
    counts.passes++;
    counts.treeEntries = 0;
    counts.shards = 0;
    counts.bytes = 0;
    let found: PassRead;
    let named: string;
    try {
      found = await readPass(api, repo, commit, pass, atStage);
      // The ref must still name the commit every read above was bound to.
      atStage("final_ref");
      named = await readBranchSha(api, repo, branch);
    } catch (error) {
      // A later pass exists only because the ref moved. A transport failure, or a commit it could not read, says
      // nothing about the new commit's content, so the read answers the reason it needed the pass; a defect found
      // in the trees and blobs of the commit it did read refuses as it would on a first pass.
      if (counts.passes > 1 && !(pass.bound && error instanceof Refusal && CONTENT_REFUSALS.has(error.outcome))) {
        atStage("final_ref");
        throw new Refusal("ref_moved");
      }
      throw error;
    } finally {
      counts.fetchedObjects.push(pass.fetched);
      counts.cachedObjects = pass.hits;
    }
    // Only the newest completed pass's objects are kept: one snapshot's worth, the set the next move most shares.
    cache.current = pass.used;
    if (named === commit) return adopt(store, counts, repositoryId, branch, commit, found, atStage);
    if (counts.passes > 1 && pass.hits === 0) throw new Refusal("ref_moved");
    commit = named;
  }
}

function adopt(
  store: PlanRevisionStore, counts: OpsCatalogCounts, repositoryId: number, branch: string, commit: string,
  { monolith, shardDir, shardEntries, blobs }: PassRead, atStage: (stage: OpsCatalogRefusalStage) => void,
): OpsCatalogSnapshot {
  const shardTreeSha = shardDir ? shardDir.sha : "";
  const binding: OpsCatalogBinding = Object.freeze({
    repositoryId, ref: `refs/heads/${branch}`, commit, tasksYamlBlob: monolith.sha, shardTreeSha,
    shardBlobs: Object.freeze(Object.fromEntries(shardEntries.map((e) => [e.path, e.sha]))) as Record<string, string>,
  });
  const identityDigest = digestOf(binding);
  atStage("strict_parse");
  let plan: Plan;
  try {
    plan = store.adopt({ key: `${commit}:${identityDigest}`, commit, repoDir: "", relPath: "" }, blobs).plan;
  } catch (error) {
    throw new Refusal(error instanceof PlanError && /^duplicate task id /.test(error.message) ? "duplicate_task_id" : "malformed");
  }
  Object.freeze(counts.fetchedObjects);
  return privateHandles({ outcome: "ok" as const, identityDigest, counts: Object.freeze(counts) }, { plan, binding });
}

/**
 * Read the target's catalog at one pinned commit: the newest one whose pass finished with the branch still naming it.
 * Never throws and never returns a partial Plan: every failure is one outcome code plus counts, with the transport
 * error's message dropped.
 */
export async function readOpsCatalogSnapshotAsync(
  target: OpsCatalogTarget,
  api: OpsCatalogApi = defaultOpsCatalogApi(),
): Promise<OpsCatalogSnapshot> {
  return readSnapshot(target, api, snapshotStore, { current: emptyCache() });
}

async function readSnapshot(
  target: OpsCatalogTarget, api: OpsCatalogApi, store: PlanRevisionStore, cache: { current: ObjectCache },
): Promise<OpsCatalogSnapshot> {
  const counts: OpsCatalogCounts = { treeEntries: 0, shards: 0, bytes: 0, passes: 0, fetchedObjects: [], cachedObjects: 0 };
  let refusalStage: OpsCatalogRefusalStage = "repository_identity";
  try { return await read(target, api, counts, store, cache, stage => { refusalStage = stage; }); }
  catch (error) {
    // The outcome code is the reason: the error's own message may hold a URL or body, so it is dropped here.
    return { outcome: error instanceof Refusal ? error.outcome : "unreadable", refusalStage, counts };
  }
}

/**
 * A stateful source for a per-tick refresh: a refresh that fails after an earlier success reads `stale` and
 * never hands the earlier snapshot back as current. W1-T13052: while the default branch still names the kept
 * commit, one ref GET revalidates the kept snapshot; a failed ref GET reads stale. A moved branch is read again
 * through the source's object cache, kept between refreshes, so it fetches only the trees and blobs that changed.
 */
export function createOpsCatalogShadowSource(
  target: OpsCatalogTarget,
  api: OpsCatalogApi = defaultOpsCatalogApi(),
): { refresh(): Promise<OpsCatalogShadowInput> } {
  let everOk = false;
  let kept: { plan?: Plan; binding: OpsCatalogBinding; identityDigest?: string } | undefined;
  const store = createPlanRevisionStore({ strict: true, retainLatest: true, yamlLogLevel: "error", dependencyMode: "preserve-external" });
  const cache = { current: emptyCache() };
  const answer = (snap: { plan?: Plan; binding?: OpsCatalogBinding; identityDigest?: string }): OpsCatalogShadowInput =>
    privateHandles({ outcome: "ok" as const, identityDigest: snap.identityDigest }, { plan: snap.plan, opsCommit: snap.binding?.commit });
  const revalidate = async (k: NonNullable<typeof kept>): Promise<"same" | "moved" | "failed"> => {
    try {
      return await readBranchSha(api, `repos/${target.repository}`, k.binding.ref.slice("refs/heads/".length)) === k.binding.commit
        ? "same" : "moved";
    } catch (error) {
      // A failed revalidation is not evidence, and a full read would start with the same failing GitHub.
      void error;
      return "failed";
    }
  };
  return {
    async refresh() {
      const check = kept ? await revalidate(kept) : "moved";
      if (check === "same" && kept) return answer(kept);
      kept = undefined;
      if (check === "failed") return { outcome: "stale", refusalStage: "branch_ref" };
      const snap = await readSnapshot(target, api, store, cache);
      if (snap.outcome === "ok" && snap.binding) {
        everOk = true;
        kept = { plan: snap.plan, binding: snap.binding, identityDigest: snap.identityDigest };
        return answer(kept);
      }
      return { outcome: everOk ? "stale" : snap.outcome, ...(snap.refusalStage ? { refusalStage: snap.refusalStage } : {}) };
    },
  };
}
