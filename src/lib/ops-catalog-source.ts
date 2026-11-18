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
  /** W1-T13705: present only when a GET failed. Diagnostic: it never changes `outcome` or `refusalStage`. */
  httpStatusClass?: OpsCatalogHttpStatusClass;
}
/** W1-T13705: why a GET failed, as a closed class. It never carries a URL, a body or token text. */
export type OpsCatalogHttpStatusClass = "4xx" | "5xx" | "auth" | "transport";
export interface OpsCatalogShadowInput {
  outcome: OpsCatalogOutcome;
  refusalStage?: OpsCatalogRefusalStage;
  plan?: Plan;
  opsCommit?: string;
  identityDigest?: string;
  /** W1-T13705: `revalidate` when one ref GET answered from a kept snapshot, `full` when the catalog was read.
   *  Non-enumerable, like the private handles: a diagnostic never changes what an equality or a row sees. */
  readonly kind?: "full" | "revalidate";
  /** W1-T13705: present only when a GET failed; see {@link OpsCatalogHttpStatusClass}. Non-enumerable. */
  readonly httpStatusClass?: OpsCatalogHttpStatusClass;
}

/** W1-T13705: attach the refresh diagnostics without changing the input's own enumerable shape. */
function withDiagnostics(input: OpsCatalogShadowInput, kind: "full" | "revalidate",
  httpStatusClass: OpsCatalogHttpStatusClass | undefined): OpsCatalogShadowInput {
  Object.defineProperty(input, "kind", { value: kind });
  if (httpStatusClass !== undefined) Object.defineProperty(input, "httpStatusClass", { value: httpStatusClass });
  return input;
}

class Refusal extends RmdError {
  readonly outcome: OpsCatalogOutcome;
  readonly httpStatusClass?: OpsCatalogHttpStatusClass;
  constructor(outcome: OpsCatalogOutcome, httpStatusClass?: OpsCatalogHttpStatusClass) {
    super("github", 1, outcome);
    this.outcome = outcome;
    if (httpStatusClass !== undefined) this.httpStatusClass = httpStatusClass;
  }
}

/** W1-T13705: a gh status code as its class; no code at all is a transport failure (DNS, reset, timeout, spawn). */
function statusClassOf(code: string | undefined): OpsCatalogHttpStatusClass {
  if (code === undefined) return "transport";
  return code.startsWith("5") ? "5xx" : "4xx";
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
      throw authMissing ? new OpsCatalogAuthMissingError() : new Refusal("unreadable", statusClassOf(status?.[1] ?? status?.[2]));
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
    if (error instanceof OpsCatalogAuthMissingError) throw new Refusal("auth_missing", "auth");
    // An injected api's own error carries no class; only the default api's classified refusal keeps one.
    throw new Refusal("unreadable", error instanceof Refusal ? error.httpStatusClass : undefined);
  }
}

interface TreeEntry { path: string; type: string; mode: string; sha: string }
interface KeptBlob { text: string; bytes: number }

/**
 * Verified objects at one commit, by sha. Each pass checks its own entry and byte totals, including cache hits.
 */
interface ObjectCache { trees: Map<string, TreeEntry[]>; blobs: Map<string, KeptBlob> }
const emptyCache = (): ObjectCache => ({ trees: new Map(), blobs: new Map() });
interface ShadowTreeCache { current?: { repositoryId: number; trees: ObjectCache["trees"] } }

/**
 * `kept` holds the previous pass's objects and `used` holds this pass's. Only reuse from the previous pass
 * counts toward convergence. `bound` means the commit object matched, so later refusals concern its content.
 */
interface Pass {
  repositoryId: number;
  kept: ObjectCache;
  used: ObjectCache;
  counts: OpsCatalogCounts;
  fetched: number;
  hits: number;
  reusedPreviousPass: boolean;
  bound: boolean;
}

async function readTree(api: OpsCatalogApi, repo: string, treeSha: string, pass: Pass): Promise<TreeEntry[]> {
  const counts = pass.counts;
  let entries = pass.kept.trees.get(treeSha);
  if (entries) {
    pass.hits++;
    pass.reusedPreviousPass = true;
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

// W1-T13673: blob texts already verified against their SHA-1, per api and repository id. Memory only.
const keptBlobs = new WeakMap<OpsCatalogApi, Map<number, Map<string, KeptBlob>>>();
function knownBlobText(api: OpsCatalogApi, repositoryId: number, blobSha: string): KeptBlob | undefined {
  return keptBlobs.get(api)?.get(repositoryId)?.get(blobSha);
}
function blobsByRepository(api: OpsCatalogApi): Map<number, Map<string, KeptBlob>> {
  let byRepo = keptBlobs.get(api);
  if (!byRepo) keptBlobs.set(api, byRepo = new Map());
  return byRepo;
}
function keepBlob(api: OpsCatalogApi, repositoryId: number, blobSha: string, blob: KeptBlob): void {
  const byRepo = blobsByRepository(api);
  let bySha = byRepo.get(repositoryId);
  if (!bySha) byRepo.set(repositoryId, bySha = new Map());
  bySha.set(blobSha, blob);
}

async function readBlob(api: OpsCatalogApi, repo: string, blobSha: string, pass: Pass): Promise<string> {
  const { counts, repositoryId } = pass;
  const known = knownBlobText(api, repositoryId, blobSha);
  const previous = pass.kept.blobs.get(blobSha);
  const kept = known ?? previous;
  if (kept) {
    pass.hits++;
    if (previous) pass.reusedPreviousPass = true;
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
  const verified = { text, bytes: bytes.length };
  keepBlob(api, repositoryId, blobSha, verified);
  pass.used.blobs.set(blobSha, verified);
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
  target: OpsCatalogTarget, api: OpsCatalogApi, counts: OpsCatalogCounts, store: PlanRevisionStore,
  atStage: (stage: OpsCatalogRefusalStage) => void, treeCache?: ShadowTreeCache,
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
  let kept = emptyCache();
  if (treeCache?.current?.repositoryId === repositoryId) kept.trees = treeCache.current.trees;
  // Each pass reads one commit whole. A pass whose closing ref read still names its commit is the answer; a moved ref
  // starts the next pass at the commit it names. If a later pass moves again and shares no object with its
  // predecessor, the read refuses ref_moved.
  for (;;) {
    const pass: Pass = {
      repositoryId, kept, used: emptyCache(), counts, fetched: 0, hits: 0, reusedPreviousPass: false, bound: false,
    };
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
    kept = pass.used;
    if (treeCache) treeCache.current = { repositoryId, trees: kept.trees };
    if (named === commit) return adopt(api, store, pass, branch, commit, found, atStage);
    if (counts.passes > 1 && !pass.reusedPreviousPass) throw new Refusal("ref_moved");
    commit = named;
  }
}

function adopt(
  api: OpsCatalogApi, store: PlanRevisionStore, pass: Pass, branch: string, commit: string,
  { monolith, shardDir, shardEntries, blobs }: PassRead, atStage: (stage: OpsCatalogRefusalStage) => void,
): OpsCatalogSnapshot {
  const { counts, repositoryId } = pass;
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
  // Every sha in the binding was verified in this pass or recovered from verified bytes.
  const boundBlobs = new Map<string, KeptBlob>();
  for (const blobSha of [binding.tasksYamlBlob, ...Object.values(binding.shardBlobs)]) {
    boundBlobs.set(blobSha, pass.used.blobs.get(blobSha)!);
  }
  blobsByRepository(api).set(repositoryId, boundBlobs);
  Object.freeze(counts.fetchedObjects);
  return privateHandles({ outcome: "ok" as const, identityDigest, counts: Object.freeze(counts) }, { plan, binding });
}

// W1-T13673: one default api per process, so every default reader shares one pacer and the kept blobs.
let processDefaultApi: OpsCatalogApi | undefined;
const sharedDefaultOpsCatalogApi = (): OpsCatalogApi => (processDefaultApi ??= defaultOpsCatalogApi());

/**
 * Read the target's catalog at one pinned commit: the newest one whose pass finished with the branch still naming it.
 * Never throws and never returns a partial Plan: every failure is one outcome code plus counts, with the transport
 * error's message dropped.
 */
export async function readOpsCatalogSnapshotAsync(
  target: OpsCatalogTarget,
  api: OpsCatalogApi = sharedDefaultOpsCatalogApi(),
): Promise<OpsCatalogSnapshot> {
  return readSnapshot(target, api, snapshotStore);
}

async function readSnapshot(
  target: OpsCatalogTarget, api: OpsCatalogApi, store: PlanRevisionStore, treeCache?: ShadowTreeCache,
): Promise<OpsCatalogSnapshot> {
  const counts: OpsCatalogCounts = { treeEntries: 0, shards: 0, bytes: 0, passes: 0, fetchedObjects: [], cachedObjects: 0 };
  let refusalStage: OpsCatalogRefusalStage = "repository_identity";
  try { return await read(target, api, counts, store, stage => { refusalStage = stage; }, treeCache); }
  catch (error) {
    // The outcome code is the reason: the error's own message may hold a URL or body, so it is dropped here.
    const httpStatusClass = error instanceof Refusal ? error.httpStatusClass : undefined;
    return { outcome: error instanceof Refusal ? error.outcome : "unreadable", refusalStage, counts,
      ...(httpStatusClass === undefined ? {} : { httpStatusClass }) };
  }
}

/**
 * A stateful source for a per-tick refresh: a refresh that fails after an earlier success reads `stale` and
 * never hands the earlier snapshot back as current. W1-T13052: while the default branch still names the kept
 * commit, one ref GET revalidates the kept snapshot; a failed ref GET reads stale. A moved branch is read again
 * using the source's kept trees and the api's verified blobs, so it fetches only the trees and blobs that changed.
 */
export function createOpsCatalogShadowSource(
  target: OpsCatalogTarget,
  api: OpsCatalogApi = sharedDefaultOpsCatalogApi(),
): { refresh(): Promise<OpsCatalogShadowInput> } {
  let everOk = false;
  let kept: { plan?: Plan; binding: OpsCatalogBinding; identityDigest?: string } | undefined;
  const store = createPlanRevisionStore({ strict: true, retainLatest: true, yamlLogLevel: "error", dependencyMode: "preserve-external" });
  const treeCache: ShadowTreeCache = {};
  const answer = (snap: { plan?: Plan; binding?: OpsCatalogBinding; identityDigest?: string }, kind: "full" | "revalidate"): OpsCatalogShadowInput =>
    privateHandles({ outcome: "ok" as const, identityDigest: snap.identityDigest }, { plan: snap.plan, opsCommit: snap.binding?.commit, kind });
  let revalidateClass: OpsCatalogHttpStatusClass | undefined;
  const revalidate = async (k: NonNullable<typeof kept>): Promise<"same" | "moved" | "failed"> => {
    revalidateClass = undefined;
    try {
      return await readBranchSha(api, `repos/${target.repository}`, k.binding.ref.slice("refs/heads/".length)) === k.binding.commit
        ? "same" : "moved";
    } catch (error) {
      // A failed revalidation is not evidence, and a full read would start with the same failing GitHub.
      if (error instanceof Refusal) revalidateClass = error.httpStatusClass;
      return "failed";
    }
  };
  return {
    async refresh() {
      const check = kept ? await revalidate(kept) : "moved";
      if (check === "same" && kept) return answer(kept, "revalidate");
      kept = undefined;
      if (check === "failed") {
        return withDiagnostics({ outcome: "stale", refusalStage: "branch_ref" }, "revalidate", revalidateClass);
      }
      const snap = await readSnapshot(target, api, store, treeCache);
      if (snap.outcome === "ok" && snap.binding) {
        everOk = true;
        kept = { plan: snap.plan, binding: snap.binding, identityDigest: snap.identityDigest };
        return answer(kept, "full");
      }
      return withDiagnostics({ outcome: everOk ? "stale" : snap.outcome, ...(snap.refusalStage ? { refusalStage: snap.refusalStage } : {}) },
        "full", snap.httpStatusClass);
    },
  };
}
