import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { inspect } from "node:util";
import { getHeapStatistics } from "node:v8";
import { systemClock, type Clock } from "./clock.js";
import { HEAP_LIMIT_EXIT_FRACTION } from "./daemon-memory-policy.js";
import { RmdError } from "./errors.js";
import { ghBrokerRouteFor } from "./gh-read-broker-client.js";
import { ghJsonAsync, createGhCallPacer, githubInstallationBudget, type GhCallPacer } from "./github-transport.js";
import { isTestRunner } from "./live-write-guard.js";
import { PlanError, type Plan } from "./plan.js";
import { execFileRouted } from "./spawn-helper.js";
import { createPlanRevisionStore, type PlanRevisionStore } from "./plan-revision-store.js";

/**
 * W1-T11768: a private ops task catalog read read-only at one pinned commit, or refused with a stable code.
 * The shape of `readSelectedRegistry` (W1-T9493) applied to the plan monolith plus its shard directory: bind the
 * numeric repository id, branch ref, commit, exact-path trees and blob SHAs, verify git's blob SHA-1 over the
 * decoded bytes, re-read the ref afterwards. No clone, worktree or mirror, and the injected api is GET-only. The one
 * file write is W1-T13970's blob cache: verified blob bytes, one owner-only file per sha, under a state dir. Nothing here
 * is a selector; the caller feeds an `ok` Plan to the
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
export const OPS_CATALOG_MAX_BLOB_BYTES = 256 * 1024; // BACKSTOP: the W1-T9493 per-blob bound.

// ── W1-T14368: in place of W1-T11768's fixed shard and byte backstops, the bounds are derived from measured cost ──
//
// OBSERVED 2026-11-22: the ops catalog held 390 shards and 2.2 MB and never shrinks, so the fixed 500-shard backstop
// would have stopped ops dispatch within days. What a bound guards is the snapshot's memory and the GitHub reads a
// refresh spends; each is measured, and both judge every read, whatever its shard count. The catalog's size and growth
// are not bounded: the operator ruled on 2026-11-23 that it may grow by any amount in a day, so no shard count, growth
// rate or alert judges a read.

/**
 * MEASURED 2026-11-22 (W1-T14368 design 0): this module read synthetic catalogs built from the live ops shards
 * (400, 800, 1,600 and 3,200 shards, 2.3 to 18.2 MB). A snapshot retained 3.36 to 3.88 heap bytes per catalog byte
 * after a full collection, and its read peaked at up to 10.38 more. A source keeps its previous snapshot while it
 * reads the next, so one refresh costs both: the measured maxima, summed.
 */
export const OPS_SNAPSHOT_HEAP_BYTES_PER_CATALOG_BYTE = 3.88 + 10.38;

/** A catalog's size: its shards and bytes. */
export interface OpsCatalogGrowth { shards: number; bytes: number }

/** Why a derived bound refused a catalog, with the number it saw and the number it allowed. */
const OPS_CATALOG_BOUND_REASONS = ["heap_bytes", "blob_read_budget"] as const;
export type OpsCatalogBoundReason = typeof OPS_CATALOG_BOUND_REASONS[number];
/** Every reason a derived bound may refuse for: the closed list OPS_CATALOG_BOUND_REASONS. */
export function opsCatalogBoundReasons(): readonly OpsCatalogBoundReason[] { return OPS_CATALOG_BOUND_REASONS; }
export interface OpsCatalogBoundRefusal {
  reason: OpsCatalogBoundReason;
  /** heap_bytes: the catalog bytes read. blob_read_budget: the blob GETs the pass needs. */
  observed: number;
  /** heap_bytes: the byte bound. blob_read_budget: the budget's allowance. */
  allowed: number;
}

/** Readings the derived bounds take. Each defaults to the live one; a test passes its own. */
export interface OpsCatalogBoundsIo {
  /** W1-T14564: the clock that stamps an accepted snapshot and ages a kept one. */
  clock?: Clock;
  /** The heap reading the daemon's heap-limit exit is judged on (W1-T9106). */
  heap?: () => { used_heap_size: number; heap_size_limit: number };
  /** The core GETs the GitHub installation budget allows now; undefined when it holds no reading or has no limit. */
  blobReadAllowance?: () => number | undefined;
}

/**
 * The most catalog bytes a snapshot may hold now: the heap left below the share of V8's limit at which the daemon
 * leaves (HEAP_LIMIT_EXIT_FRACTION), over the measured heap cost of one catalog byte.
 */
export function opsCatalogHeapByteBound(heap: { used_heap_size: number; heap_size_limit: number } = getHeapStatistics()): number {
  const headroom = HEAP_LIMIT_EXIT_FRACTION * heap.heap_size_limit - heap.used_heap_size;
  return Number.isFinite(headroom) && headroom > 0 ? Math.floor(headroom / OPS_SNAPSHOT_HEAP_BYTES_PER_CATALOG_BYTE) : 0;
}

/**
 * W1-T14368: how a catalog of `counts` fares against the heap bound, for a caller that builds a catalog rather than
 * reads one (plan-task-migration's copy). Undefined within the bound.
 */
export function opsCatalogBoundRefusal(counts: OpsCatalogGrowth, io: OpsCatalogBoundsIo = {}): OpsCatalogBoundRefusal | undefined {
  const heapBytes = opsCatalogHeapByteBound((io.heap ?? getHeapStatistics)());
  if (counts.bytes > heapBytes) return { reason: "heap_bytes", observed: counts.bytes, allowed: heapBytes };
  return undefined;
}

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
  /** W1-T14368: present only when a derived bound refused the catalog: which one, what it saw and what it allowed. */
  bound?: OpsCatalogBoundRefusal;
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
  /** W1-T14368: present only when a derived bound refused the read; see {@link OpsCatalogBoundRefusal}. Non-enumerable. */
  readonly bound?: OpsCatalogBoundRefusal;
  /** W1-T14374: the snapshot's shard and byte counts, when a catalog read produced them. Non-enumerable. */
  readonly counts?: OpsCatalogShadowCounts;
  /** W1-T14564: present only when a refresh failed and the kept snapshot answered: why, and the snapshot's age.
   *  Non-enumerable, like the other diagnostics. */
  readonly lastGood?: OpsCatalogLastGoodServed;
  /** W1-T14564: with `lastGood`, the refusal exactly as it would have been answered, so its row reads as before. */
  readonly refused?: OpsCatalogShadowInput;
}
/** W1-T14564: the refusal a kept snapshot answered for, and how old that snapshot is. Closed labels and numbers only. */
export interface OpsCatalogLastGoodServed {
  refusal: OpsCatalogOutcome;
  refusalStage?: OpsCatalogRefusalStage;
  snapshotAgeMs: number;
}
/** W1-T14374: the two counts a refresh row carries. Numbers only. */
export interface OpsCatalogShadowCounts { shards: number; bytes: number }

/**
 * W1-T14564: the same ok snapshot, served past its refresh's age bound: every private handle carried over, with
 * `lastGood` naming why it is served and how old it is. A non-ok input is returned unchanged.
 */
export function servedAsLastGood(input: OpsCatalogShadowInput, lastGood: OpsCatalogLastGoodServed): OpsCatalogShadowInput {
  if (input.outcome !== "ok") return input;
  const handles = { plan: input.plan, opsCommit: input.opsCommit, kind: input.kind, counts: input.counts,
    refused: input.refused, lastGood };
  return privateHandles({ outcome: "ok" as const, identityDigest: input.identityDigest },
    Object.fromEntries(Object.entries(handles).filter(([, value]) => value !== undefined)));
}

/** W1-T13705: attach the refresh diagnostics without changing the input's own enumerable shape. */
function withDiagnostics(input: OpsCatalogShadowInput, kind: "full" | "revalidate",
  httpStatusClass: OpsCatalogHttpStatusClass | undefined, bound?: OpsCatalogBoundRefusal,
  counts?: OpsCatalogShadowCounts): OpsCatalogShadowInput {
  Object.defineProperty(input, "kind", { value: kind });
  if (httpStatusClass !== undefined) Object.defineProperty(input, "httpStatusClass", { value: httpStatusClass });
  if (bound !== undefined) Object.defineProperty(input, "bound", { value: bound });
  if (counts !== undefined) Object.defineProperty(input, "counts", { value: counts });
  return input;
}

class Refusal extends RmdError {
  readonly outcome: OpsCatalogOutcome;
  readonly httpStatusClass?: OpsCatalogHttpStatusClass;
  readonly bound?: OpsCatalogBoundRefusal;
  constructor(outcome: OpsCatalogOutcome, httpStatusClass?: OpsCatalogHttpStatusClass, bound?: OpsCatalogBoundRefusal) {
    super("github", 1, outcome);
    this.outcome = outcome;
    if (httpStatusClass !== undefined) this.httpStatusClass = httpStatusClass;
    if (bound !== undefined) this.bound = Object.freeze({ ...bound });
  }
}

/** W1-T13705: a gh status code as its class; no code at all is a transport failure (DNS, reset, timeout, spawn). */
function statusClassOf(code: string | undefined): OpsCatalogHttpStatusClass {
  if (code === undefined) return "transport";
  return code.startsWith("5") ? "5xx" : "4xx";
}

const AUTH_DIAGNOSTIC = /^(?:gh: )?(?:To get started with GitHub CLI, please run:|To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable\.)/m;
const HTTP_DIAGNOSTIC = /^(?:HTTP (\d{3})(?:[ \t:]|$)|gh: [^\r\n]*?\(HTTP (\d{3})\))/m;
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

/** W1-T13970: a blob GET. A blob is named by its content, so no answer for one can go stale. */
const BLOB_PATH = /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/git\/blobs\/[a-f0-9]{40}$/;

/** The default GET-only api: `ghJsonAsync` behind the existing pacer. Errors are reduced to a code-bearing class. */
export function defaultOpsCatalogApi(
  opts: { pacer?: GhCallPacer; exec?: Parameters<typeof ghJsonAsync>[1] } = {},
): OpsCatalogApi {
  const pacer = opts.pacer ?? createGhCallPacer();
  // An explicit executor keeps ghJsonAsync off the broker's persistent response cache. The child has
  // no --cache flag; each mutable ref check reaches upstream. Pacing remains local to this source.
  // W1-T13664: through the installed spawn helper when there is one, else `execFileLoopBounded` directly.
  const exec = opts.exec ?? ((file: string, args: readonly string[], options: Parameters<typeof execFileRouted>[2]) =>
    execFileRouted(file, args, options)) as NonNullable<typeof opts.exec>;
  return async (path) => {
    try {
      if (pacer.waitAsync) await pacer.waitAsync();
      else pacer.wait();
      // W1-T13970: a blob takes ghJsonAsync's own transport, the in-process client, not a gh child per blob. Ref,
      // commit and tree reads keep the forced-fresh child. With a live broker a blob keeps the child too, so private
      // bytes never enter the broker's shared response cache (W1-T11768). A caller's own executor runs every read.
      if (opts.exec === undefined && BLOB_PATH.test(path) && ghBrokerRouteFor() === undefined) return await ghJsonAsync(["api", path]);
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
/** A non-negative safe integer, the shape of a stored timestamp. */
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
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
  /** W1-T13970: this read's blob file cache, when it has a state dir. */
  blobFiles: BlobFiles | undefined;
  kept: ObjectCache;
  used: ObjectCache;
  counts: OpsCatalogCounts;
  fetched: number;
  hits: number;
  reusedPreviousPass: boolean;
  bound: boolean;
  /** W1-T14368: the readings this read's derived bounds judge on. */
  limits: ReadLimits;
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
// W1-T13691: what the newest ok read of each api bound, so a run child is offered that binding's blobs only.
const newestOkBinding = new WeakMap<OpsCatalogApi, { repositoryId: number; blobShas: string[]; taskIds: ReadonlySet<string> }>();
function keepBlob(api: OpsCatalogApi, repositoryId: number, blobSha: string, blob: KeptBlob): void {
  const byRepo = blobsByRepository(api);
  let bySha = byRepo.get(repositoryId);
  if (!bySha) byRepo.set(repositoryId, bySha = new Map());
  bySha.set(blobSha, blob);
}

/**
 * W1-T13970: verified blob bytes kept across processes, one file per sha under `<stateDir>/cache/ops-blobs/<repository
 * id>/`. A file answers only after the checks a fetched blob passes ({@link verifiedBlob}); one that fails them is
 * removed and the blob is fetched. Only blobs live here: a ref, commit or tree read always reaches GitHub.
 */
interface BlobFiles { dir: string }

export function opsCatalogBlobCacheDir(stateDir: string, repositoryId: number): string {
  return join(stateDir, "cache", "ops-blobs", String(repositoryId));
}

/** The verified blob a file holds, or undefined: no file, an unreadable one, or one failing a check (removed). */
function readBlobFile(files: BlobFiles, blobSha: string): KeptBlob | undefined {
  const path = join(files.dir, blobSha);
  let bytes: Buffer;
  let fd: number | undefined;
  try {
    // One descriptor is both checked and read, so the bytes read are the bytes the checks saw (no check-then-use race).
    try { fd = fs.openSync(path, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const stat = fs.fstatSync(fd);
    // The per-blob bound applies before the read, so an oversized file is never loaded.
    if (!stat.isFile() || stat.size > OPS_CATALOG_MAX_BLOB_BYTES) {
      fs.closeSync(fd);
      fd = undefined;
      return removeBlobFile(path);
    }
    bytes = fs.readFileSync(fd);
  } catch (error) {
    void error; // An unreadable file is a miss: the blob is fetched from GitHub, as with no cache.
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try { return verifiedBlob(blobSha, bytes); }
  catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return removeBlobFile(path); // Bytes that do not hash to the sha never answer; the read fetches the blob.
  }
}

/** Remove one cache entry; answers undefined, the miss its caller returns. */
function removeBlobFile(path: string): undefined {
  try { fs.rmSync(path, { force: true, recursive: true }); }
  catch (error) {
    void error; // A file that cannot be removed is refused again on the next read; the answer still comes from GitHub.
  }
  return undefined;
}

/** Keep verified bytes as `<sha>`, written whole under a private temporary name and renamed, so a reader sees all or none. */
function writeBlobFile(files: BlobFiles, blobSha: string, bytes: Uint8Array): void {
  const temp = join(files.dir, `.${blobSha}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, join(files.dir, blobSha));
  } catch (error) {
    void error; // A cache that cannot be written changes only the next read, which fetches the blob again.
    removeBlobFile(temp);
  }
}

/** After an ok read, keep only the files of the shas its binding names: the point the in-memory blobs are pruned. */
function pruneBlobFiles(files: BlobFiles, keep: ReadonlySet<string>): void {
  let names: string[];
  try { names = fs.readdirSync(files.dir); }
  catch (error) {
    void error; // No directory (nothing was ever written) or an unreadable one: nothing to prune.
    return;
  }
  for (const name of names) if (!keep.has(name)) removeBlobFile(join(files.dir, name));
}

/**
 * The instance state dir as loadConfig resolves it (the config file's `root`, else `~/Remudero`, then `state`), read
 * only. Undefined with no such directory, and, under the test runner, for one outside the temp directory, so a test
 * never reads or writes a real instance's cache.
 */
function instanceStateDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.HOME || homedir();
  try {
    const configFile = join(home, ".config", "remudero", "config.json");
    const parsed = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) as { root?: unknown } | null : null;
    const state = join(typeof parsed?.root === "string" && parsed.root !== "" ? parsed.root : join(home, "Remudero"), "state");
    const stat = fs.statSync(state, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) return undefined;
    if (isTestRunner(env) && !fs.realpathSync(state).startsWith(fs.realpathSync(tmpdir()) + sep)) return undefined;
    return state;
  } catch (error) {
    void error; // An unreadable config is no instance: the read keeps its blobs in memory only, as before.
    return undefined;
  }
}

/** One read's readings: taken once at its start, so every pass judges on the same numbers. */
interface ReadLimits { heapBytes: number; allowance: () => number | undefined }

function readLimits(io: OpsCatalogBoundsIo): ReadLimits {
  return {
    heapBytes: opsCatalogHeapByteBound((io.heap ?? getHeapStatistics)()),
    allowance: io.blobReadAllowance ?? (() => githubInstallationBudget().allowance()),
  };
}

/** The heap bound, on every read: a snapshot of more bytes than the heap left can hold is refused whole. */
function checkBytes(pass: Pass): void {
  const { bytes } = pass.counts, { heapBytes } = pass.limits;
  if (bytes > heapBytes) {
    throw new Refusal("malformed", undefined, { reason: "heap_bytes", observed: bytes, allowed: heapBytes });
  }
}

/**
 * The blob GETs this pass needs, counted before any is spent: a catalog whose uncached blobs exceed what the GitHub
 * budget allows now is refused, rather than spending the budget and failing part way.
 */
function checkBlobReads(api: OpsCatalogApi, pass: Pass, entries: readonly TreeEntry[]): void {
  const allowance = pass.limits.allowance();
  if (allowance === undefined) return;
  const needed = entries.filter((e) => knownBlobText(api, pass.repositoryId, e.sha) === undefined && !pass.kept.blobs.has(e.sha)
    && !(pass.blobFiles && fs.existsSync(join(pass.blobFiles.dir, e.sha)))).length;
  if (needed > allowance) throw new Refusal("unreadable", undefined, { reason: "blob_read_budget", observed: needed, allowed: allowance });
}

async function readBlob(api: OpsCatalogApi, repo: string, blobSha: string, pass: Pass): Promise<string> {
  const { counts, repositoryId } = pass;
  const known = knownBlobText(api, repositoryId, blobSha);
  const previous = pass.kept.blobs.get(blobSha);
  // W1-T13970: memory first, then the state-dir file, then GitHub. A file's blob joins the api's kept blobs.
  const filed = known === undefined && previous === undefined && pass.blobFiles ? readBlobFile(pass.blobFiles, blobSha) : undefined;
  if (filed) keepBlob(api, repositoryId, blobSha, filed);
  const kept = known ?? previous ?? filed;
  if (kept) {
    pass.hits++;
    if (previous) pass.reusedPreviousPass = true;
    counts.bytes += kept.bytes;
    checkBytes(pass);
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
  checkBytes(pass);
  if (blob.size !== bytes.length) throw new Refusal("malformed");
  const verified = verifiedBlob(blobSha, bytes);
  keepBlob(api, repositoryId, blobSha, verified);
  if (pass.blobFiles) writeBlobFile(pass.blobFiles, blobSha, bytes);
  pass.used.blobs.set(blobSha, verified);
  return verified.text;
}

/** The checks every kept blob passes, from GitHub or from a parent: the per-blob bound, git's blob SHA-1, strict UTF-8. */
function verifiedBlob(blobSha: string, bytes: Uint8Array): KeptBlob {
  if (bytes.length > OPS_CATALOG_MAX_BLOB_BYTES) throw new Refusal("malformed");
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blobSha) throw new Refusal("malformed");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Refusal("malformed"); }
  return { text, bytes: bytes.length };
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
  if (!shardEntries.every(regular)) throw new Refusal("malformed");
  counts.shards = shardEntries.length;
  // W1-T14368: a catalog whose blob reads the GitHub budget cannot pay for is refused before a blob is fetched.
  checkBlobReads(api, pass, [monolith, ...shardEntries]);
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
  atStage: (stage: OpsCatalogRefusalStage) => void, treeCache?: ShadowTreeCache, stateDir?: string, io: OpsCatalogBoundsIo = {},
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
  const blobFiles: BlobFiles | undefined = stateDir === undefined ? undefined : { dir: opsCatalogBlobCacheDir(stateDir, repositoryId) };
  let kept = emptyCache();
  if (treeCache?.current?.repositoryId === repositoryId) kept.trees = treeCache.current.trees;
  const limits = readLimits(io);
  // Each pass reads one commit whole. A pass whose closing ref read still names its commit is the answer; a moved ref
  // starts the next pass at the commit it names. If a later pass moves again and shares no object with its
  // predecessor, the read refuses ref_moved.
  for (;;) {
    const pass: Pass = {
      repositoryId, blobFiles, kept, used: emptyCache(), counts, fetched: 0, hits: 0, reusedPreviousPass: false, bound: false, limits,
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
  if (pass.blobFiles) pruneBlobFiles(pass.blobFiles, new Set(boundBlobs.keys()));
  newestOkBinding.set(api, { repositoryId, blobShas: [...boundBlobs.keys()], taskIds: new Set(plan.byId.keys()) });
  Object.freeze(counts.fetchedObjects);
  return privateHandles({ outcome: "ok" as const, identityDigest, counts: Object.freeze(counts) }, { plan, binding });
}

// W1-T13673: one default api per process, so every default reader shares one pacer and the kept blobs.
let processDefaultApi: OpsCatalogApi | undefined;
const sharedDefaultOpsCatalogApi = (): OpsCatalogApi => (processDefaultApi ??= defaultOpsCatalogApi());

/** W1-T14368: an offer names at most one blob per tree entry a read admits, each pair at its longest. */
const OFFER_HEADER_MAX_BYTES = JSON.stringify({ repositoryId: Number.MAX_SAFE_INTEGER, blobs: [] }).length
  + OPS_CATALOG_MAX_TREE_ENTRIES * (JSON.stringify(["f".repeat(40), OPS_CATALOG_MAX_BLOB_BYTES]).length + 1);
/** BACKSTOP: the most blob bytes one offer to a run child carries. A catalog of more is not offered; the child reads it
 *  from GitHub, where the derived bounds judge it (W1-T14368). It sizes an offer and judges no read. */
export const OPS_CATALOG_OFFER_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
/** BACKSTOP: the most a run child reads of an offer: the payload's bytes plus the header line. */
export const OPS_CATALOG_MAX_OFFER_BYTES = OPS_CATALOG_OFFER_MAX_PAYLOAD_BYTES + OFFER_HEADER_MAX_BYTES;
interface OfferedOpsCatalogBlobCounts { offered: number; kept: number; refused: number }

/**
 * W1-T13691: the blobs a run child for `taskId` is offered, when the api's newest ok read holds that task: one JSON
 * line with the repository id and each blob's [sha, byte length], then the blob bytes in that order. Memory only.
 */
export function keptOpsCatalogBlobsForChild(taskId: string, api: OpsCatalogApi | undefined = processDefaultApi): Buffer | undefined {
  const newest = api && newestOkBinding.get(api);
  if (!api || !newest || !newest.taskIds.has(taskId)) return undefined;
  const kept = keptBlobs.get(api)?.get(newest.repositoryId);
  const blobs: Array<[string, Buffer]> = [];
  for (const blobSha of newest.blobShas) {
    const blob = kept?.get(blobSha);
    if (blob) blobs.push([blobSha, Buffer.from(blob.text, "utf8")]);
  }
  if (blobs.length === 0) return undefined;
  const header = JSON.stringify({ repositoryId: newest.repositoryId, blobs: blobs.map(([blobSha, bytes]) => [blobSha, bytes.length]) });
  const payload = Buffer.concat([Buffer.from(`${header}\n`), ...blobs.map(([, bytes]) => bytes)]);
  return payload.length <= OPS_CATALOG_MAX_OFFER_BYTES ? payload : undefined;
}

function offerHeader(line: Uint8Array): { repositoryId: number; blobs: Array<[string, number]> } | undefined {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(line)); }
  catch (error) {
    void error; // A malformed offer is no offer: the child reads every blob from GitHub, as before.
    return undefined;
  }
  const { repositoryId, blobs } = (raw ?? {}) as { repositoryId?: unknown; blobs?: unknown };
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId < 1 || !Array.isArray(blobs)
    || blobs.length > OPS_CATALOG_MAX_TREE_ENTRIES) return undefined;
  const pairs: Array<[string, number]> = [];
  for (const pair of blobs as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !SHA.test(pair[0])
      || !Number.isSafeInteger(pair[1]) || pair[1] < 0) return undefined;
    pairs.push([pair[0], pair[1] as number]);
  }
  return { repositoryId, blobs: pairs };
}

/**
 * W1-T13691: keep each offered blob that passes the checks a GitHub answer passes, in the api's kept blobs. A
 * truncated, oversized or malformed payload keeps nothing. Never throws on a bad payload; returns counts only.
 */
export function acceptOfferedOpsCatalogBlobs(
  payload: Uint8Array | undefined, api: OpsCatalogApi = sharedDefaultOpsCatalogApi(),
): OfferedOpsCatalogBlobCounts {
  if (!payload || payload.length > OPS_CATALOG_MAX_OFFER_BYTES) return { offered: 0, kept: 0, refused: 0 };
  const end = payload.indexOf(0x0a);
  const header = end > 0 && end <= OFFER_HEADER_MAX_BYTES ? offerHeader(payload.subarray(0, end)) : undefined;
  if (!header) return { offered: 0, kept: 0, refused: 0 };
  const offered = header.blobs.length;
  const declared = header.blobs.reduce((sum, [, length]) => sum + length, 0);
  if (declared > OPS_CATALOG_OFFER_MAX_PAYLOAD_BYTES || end + 1 + declared !== payload.length) return { offered, kept: 0, refused: offered };
  let at = end + 1;
  let kept = 0;
  for (const [blobSha, length] of header.blobs) {
    const bytes = payload.subarray(at, at += length);
    let verified: KeptBlob;
    try { verified = verifiedBlob(blobSha, bytes); }
    catch (error) {
      if (error instanceof Refusal) continue; // A blob that fails a check is dropped; the read GETs it from GitHub.
      throw error;
    }
    keepBlob(api, header.repositoryId, blobSha, verified);
    kept++;
  }
  return { offered, kept, refused: offered - kept };
}

/**
 * Read the target's catalog at one pinned commit: the newest one whose pass finished with the branch still naming it.
 * Never throws and never returns a partial Plan: every failure is one outcome code plus counts, with the transport
 * error's message dropped.
 */
export async function readOpsCatalogSnapshotAsync(
  target: OpsCatalogTarget,
  api: OpsCatalogApi = sharedDefaultOpsCatalogApi(),
  opts: OpsCatalogReadOptions = {},
): Promise<OpsCatalogSnapshot> {
  return readSnapshot(target, api, snapshotStore, undefined, blobStateDir(api, opts), opts.bounds);
}

/**
 * W1-T13970: where a read keeps its verified blobs across processes. `stateDir` names it; without one the process's
 * shared default api uses the instance's state dir, and any other api keeps its blobs in memory only.
 */
export interface OpsCatalogReadOptions {
  stateDir?: string;
  /** W1-T14368: the readings the derived bounds take; each defaults to the live one. */
  bounds?: OpsCatalogBoundsIo;
}
function blobStateDir(api: OpsCatalogApi, opts: OpsCatalogReadOptions): string | undefined {
  return opts.stateDir ?? (api === processDefaultApi ? instanceStateDir() : undefined);
}

async function readSnapshot(
  target: OpsCatalogTarget, api: OpsCatalogApi, store: PlanRevisionStore, treeCache?: ShadowTreeCache, stateDir?: string,
  io?: OpsCatalogBoundsIo,
): Promise<OpsCatalogSnapshot> {
  const counts: OpsCatalogCounts = { treeEntries: 0, shards: 0, bytes: 0, passes: 0, fetchedObjects: [], cachedObjects: 0 };
  let refusalStage: OpsCatalogRefusalStage = "repository_identity";
  try {
    const snapshot = await read(target, api, counts, store, stage => { refusalStage = stage; }, treeCache, stateDir, io);
    // W1-T14564: an accepted binding is what a later refused read falls back to. Writing it never throws.
    if (stateDir !== undefined && snapshot.outcome === "ok" && snapshot.binding) {
      writeLastGoodBinding(stateDir, target.repository, snapshot.binding, (io?.clock ?? systemClock).now());
    }
    return snapshot;
  }
  catch (error) {
    // The outcome code is the reason: the error's own message may hold a URL or body, so it is dropped here.
    const httpStatusClass = error instanceof Refusal ? error.httpStatusClass : undefined;
    const bound = error instanceof Refusal ? error.bound : undefined;
    return { outcome: error instanceof Refusal ? error.outcome : "unreadable", refusalStage, counts,
      ...(httpStatusClass === undefined ? {} : { httpStatusClass }), ...(bound === undefined ? {} : { bound }) };
  }
}

/**
 * A stateful source for a per-tick refresh. W1-T14564 (operator ruling 2026-11-23): a refresh that fails answers the
 * last good snapshot (this source's newest accepted one, else the state dir's kept one) as `ok`, carrying `lastGood`
 * with the refusal and the snapshot's age; with no good snapshot it answers the refusal as before. W1-T13052: while the default branch still names the kept
 * commit, one ref GET revalidates the kept snapshot; a failed ref GET reads stale. A moved branch is read again
 * using the source's kept trees and the api's verified blobs, so it fetches only the trees and blobs that changed.
 */
export function createOpsCatalogShadowSource(
  target: OpsCatalogTarget,
  api: OpsCatalogApi = sharedDefaultOpsCatalogApi(),
  opts: OpsCatalogReadOptions = {},
): { refresh(): Promise<OpsCatalogShadowInput> } {
  let everOk = false;
  const clock = opts.bounds?.clock ?? systemClock;
  /** W1-T14564: the newest snapshot this source accepted or confirmed, and when; a failed refresh answers it. */
  let lastOk: { snap: NonNullable<typeof kept>; confirmedAt: number } | undefined;
  let kept: { plan?: Plan; binding: OpsCatalogBinding; identityDigest?: string; counts: OpsCatalogShadowCounts } | undefined;
  const store = createPlanRevisionStore({ strict: true, retainLatest: true, yamlLogLevel: "error", dependencyMode: "preserve-external" });
  const treeCache: ShadowTreeCache = {};
  const answer = (snap: { plan?: Plan; binding?: OpsCatalogBinding; identityDigest?: string; counts: OpsCatalogShadowCounts },
    kind: "full" | "revalidate", diagnostics: Partial<Pick<OpsCatalogShadowInput, "lastGood" | "refused">> = {}): OpsCatalogShadowInput =>
    privateHandles({ outcome: "ok" as const, identityDigest: snap.identityDigest },
      { plan: snap.plan, opsCommit: snap.binding?.commit, kind, counts: snap.counts,
        ...Object.fromEntries(Object.entries(diagnostics).filter(([, value]) => value !== undefined)) });
  const accepted = (snap: NonNullable<typeof kept>, kind: "full" | "revalidate"): OpsCatalogShadowInput => {
    lastOk = { snap, confirmedAt: clock.now() };
    return answer(snap, kind);
  };
  /** The last good snapshot answering `refused`, or the refusal itself when there is none: never an empty catalog. */
  const lastGoodOr = async (refused: OpsCatalogShadowInput, kind: "full" | "revalidate",
    refusal: OpsCatalogOutcome = refused.outcome): Promise<OpsCatalogShadowInput> => {
    if (lastOk === undefined) {
      const onDisk = await readLastGoodOpsCatalogSnapshot(target, api, opts);
      if (onDisk.outcome === "ok" && onDisk.binding) {
        lastOk = { snap: { plan: onDisk.plan, binding: onDisk.binding, identityDigest: onDisk.identityDigest, counts: onDisk.counts }, confirmedAt: onDisk.acceptedAt };
      }
    }
    if (lastOk === undefined) return refused;
    const lastGood: OpsCatalogLastGoodServed = { refusal,
      ...(refused.refusalStage ? { refusalStage: refused.refusalStage } : {}), snapshotAgeMs: Math.max(0, clock.now() - lastOk.confirmedAt) };
    return answer(lastOk.snap, kind, { lastGood, refused });
  };
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
      if (check === "same" && kept) return accepted(kept, "revalidate");
      kept = undefined;
      if (check === "failed") {
        return lastGoodOr(withDiagnostics({ outcome: "stale", refusalStage: "branch_ref" }, "revalidate", revalidateClass), "revalidate");
      }
      const snap = await readSnapshot(target, api, store, treeCache, blobStateDir(api, opts), opts.bounds);
      if (snap.outcome === "ok" && snap.binding) {
        everOk = true;
        kept = { plan: snap.plan, binding: snap.binding, identityDigest: snap.identityDigest, counts: { shards: snap.counts.shards, bytes: snap.counts.bytes } };
        return accepted(kept, "full");
      }
      const refused = withDiagnostics({ outcome: everOk ? "stale" : snap.outcome, ...(snap.refusalStage ? { refusalStage: snap.refusalStage } : {}) },
        "full", snap.httpStatusClass, snap.bound, { shards: snap.counts.shards, bytes: snap.counts.bytes });
      return lastGoodOr(refused, "full", snap.outcome);
    },
  };
}

// ── W1-T14564: the last good snapshot ──
//
// Operator ruling 2026-11-23: an ops catalog read problem never stops core work. Each accepted read keeps its binding
// in one owner-only file beside the blob cache; the blob cache already keeps exactly that binding's verified blobs
// (pruneBlobFiles after each ok read). A refused read rebuilds the accepted plan from the two, verifying every blob
// against its sha again. Any missing or mismatched blob is no snapshot: a refusal is never read as an empty catalog.

/** BACKSTOP: a binding names at most OPS_CATALOG_MAX_TREE_ENTRIES shards, each well under 200 bytes of JSON. */
const LAST_GOOD_FILE_MAX_BYTES = 4 * 1024 * 1024;

export function opsCatalogLastGoodFile(stateDir: string, repository: string): string {
  return join(stateDir, "cache", "ops-catalog-last-good", `${encodeURIComponent(repository.toLowerCase())}.json`);
}

/** The accepted binding and when it was accepted, written whole under a private temporary name and renamed. */
function writeLastGoodBinding(stateDir: string, repository: string, binding: OpsCatalogBinding, acceptedAt: number): void {
  const path = opsCatalogLastGoodFile(stateDir, repository);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(join(stateDir, "cache", "ops-catalog-last-good"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, repository: repository.toLowerCase(), acceptedAt, binding })}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, path);
  } catch (error) {
    void error; // A binding that cannot be kept changes only a later refused read, which then has no snapshot, as before.
    removeBlobFile(temp);
  }
}

/** Why there is no last good snapshot: closed codes, never a path or file text. */
export type OpsCatalogLastGoodMiss = "no_state_dir" | "no_record" | "record_malformed" | "blob_missing" | "parse";
export type OpsCatalogLastGood =
  | { outcome: "ok"; plan?: Plan; binding?: OpsCatalogBinding; identityDigest: string; acceptedAt: number; ageMs: number;
    counts: OpsCatalogShadowCounts }
  | { outcome: "none"; reason: OpsCatalogLastGoodMiss };

/** The kept record, read through one descriptor that does not follow a link (the loadGrowth discipline). */
function readLastGoodRecord(path: string): { record?: { repository: string; acceptedAt: number; binding: OpsCatalogBinding }; miss?: OpsCatalogLastGoodMiss } {
  let fd: number;
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) {
    void error; // An absent or unopenable record is no record.
    return { miss: "no_record" };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > LAST_GOOD_FILE_MAX_BYTES) return { miss: "record_malformed" };
    const raw = rec(JSON.parse(fs.readFileSync(fd, "utf8")));
    const b = rec(raw.binding), blobs = rec(b.shardBlobs);
    if (raw.version !== 1 || typeof raw.repository !== "string" || !count(raw.acceptedAt)) throw new Refusal("malformed");
    if (typeof b.repositoryId !== "number" || !Number.isSafeInteger(b.repositoryId) || b.repositoryId < 1
      || typeof b.ref !== "string" || !b.ref.startsWith("refs/heads/") || typeof b.shardTreeSha !== "string"
      || (b.shardTreeSha !== "" && !SHA.test(b.shardTreeSha))) throw new Refusal("malformed");
    const names = Object.keys(blobs);
    if (names.length > OPS_CATALOG_MAX_TREE_ENTRIES || !names.every((n) => !n.includes("/") && isShardFile(n))) throw new Refusal("malformed");
    const shardBlobs = Object.fromEntries(names.sort().map((n) => [n, sha(blobs[n])]));
    const binding: OpsCatalogBinding = { repositoryId: b.repositoryId, ref: b.ref, commit: sha(b.commit), tasksYamlBlob: sha(b.tasksYamlBlob),
      shardTreeSha: b.shardTreeSha, shardBlobs };
    return { record: { repository: raw.repository, acceptedAt: raw.acceptedAt, binding } };
  } catch (error) {
    void error; // An unreadable descriptor, JSON or field damage: the record names no snapshot, so the read stays refused.
    return { miss: "record_malformed" };
  } finally {
    fs.closeSync(fd);
  }
}

const isShardFile = (path: string): boolean => path.endsWith(".yaml") || path.endsWith(".yml");

/**
 * W1-T14564: the snapshot the newest accepted read of `target` produced, rebuilt from its kept binding and the
 * verified blob cache, with its age. The state dir resolves as a read's does (`opts.stateDir`, else the instance's
 * for the shared default api). It makes no GitHub read and never throws; any gap is `none` with a closed reason.
 */
export async function readLastGoodOpsCatalogSnapshot(
  target: OpsCatalogTarget, api: OpsCatalogApi = sharedDefaultOpsCatalogApi(), opts: OpsCatalogReadOptions = {},
): Promise<OpsCatalogLastGood> {
  const stateDir = blobStateDir(api, opts);
  if (stateDir === undefined) return { outcome: "none", reason: "no_state_dir" };
  const read = readLastGoodRecord(opsCatalogLastGoodFile(stateDir, target.repository));
  const record = read.record;
  if (!record) return { outcome: "none", reason: read.miss ?? "no_record" };
  if (record.repository !== target.repository.toLowerCase()) return { outcome: "none", reason: "record_malformed" };
  const { binding } = record;
  const files: BlobFiles = { dir: opsCatalogBlobCacheDir(stateDir, binding.repositoryId) };
  const blobs: Array<{ label: string; text: string }> = [];
  let bytes = 0;
  for (const [label, blobSha] of [["tasks.yaml", binding.tasksYamlBlob], ...Object.entries(binding.shardBlobs).map(([n, s]) => [`tasks.d/${n}`, s])]) {
    // readBlobFile verifies the bytes against the sha and the per-blob bound; a file failing either is removed.
    const blob = readBlobFile(files, blobSha!);
    if (!blob) return { outcome: "none", reason: "blob_missing" };
    blobs.push({ label: label!, text: blob.text });
    bytes += blob.bytes;
  }
  const identityDigest = digestOf(binding);
  let plan: Plan;
  try { plan = snapshotStore.adopt({ key: `${binding.commit}:${identityDigest}`, commit: binding.commit, repoDir: "", relPath: "" }, blobs).plan; }
  catch (error) {
    void error; // The bytes were accepted once; a parser that now refuses them leaves no snapshot to serve.
    return { outcome: "none", reason: "parse" };
  }
  const ageMs = Math.max(0, (opts.bounds?.clock ?? systemClock).now() - record.acceptedAt);
  const counts = { shards: Object.keys(binding.shardBlobs).length, bytes };
  return privateHandles({ outcome: "ok" as const, identityDigest, acceptedAt: record.acceptedAt, ageMs, counts }, { plan, binding: Object.freeze(binding) });
}
