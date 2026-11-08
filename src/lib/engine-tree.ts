// src/lib/engine-tree.ts — W1-T9077. Decision record: docs/adr/0007-build-runs-outlive-the-daemon.md (A.1, B.4).
//
// deploy/entrypoint.sh's sync_tree moves the daemon's own checkout on every in-container restart, and a bundle
// resolves its modules, scripts and node_modules relative to the tree it sits in (ADR 0006, decision 2). A run child
// that outlives the daemon therefore runs from an ENGINE TREE: `<state>/engines/<sourceHash>/`, a detached worktree of
// the managed checkout at one revision, with the stored bundle materialized into its dist/ and node_modules linked to
// the install. Nothing moves an engine tree while a run's status names it; it is removed only when none does.
// W1-T9738: that link names the RESOLVED install, never a path under a worker's worktree, which the worker can rewrite.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { buildIntoStore, materializeFromStore, type BuildIntoStoreOptions, type StoreBuildResult, type StoreLog, type StoreLookup } from "./child-entry-store.js";
import { writeAtomic } from "./fs-race-safe.js";
import { acquireInflightLock, InflightLockError, type InflightLockHandle } from "./inflight-lock.js";
import { classifyRunDir, readSpec, realRunChildProbe, type RunChildProbe } from "./run-child-contract.js";
import { linkWorktreeNodeModules, resolveNodeModulesSource, type NodeModulesLinkOutcome } from "./worker.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const ENGINES_DIR = "engines";
/** Written LAST, into the finished tree: an engine directory without it is not an engine. */
export const ENGINE_RECORD = "engine.json";
const BUILD_PREFIX = ".build-";

const reasonOf = (err: unknown): string => String((err as Error)?.message ?? err).slice(0, 400);

export interface EngineRecord {
  sha: string;
  sourceHash: string;
  /** Milliseconds since the epoch when the tree was published: what "newest" orders by. */
  builtAt: number;
  /** W1-T9738: the resolved install its node_modules links to. Absent on an engine built before the record named it. */
  nodeModulesTarget?: string;
}
export interface EngineRef extends EngineRecord {
  root: string;
}

/** `<state>/engines`. */
export const enginesRoot = (stateRoot: string): string => join(stateRoot, ENGINES_DIR);

/** `<state>/engines/<sourceHash>/`. A name that could leave `engines/` is refused, never normalized. */
export function enginePath(stateRoot: string, sourceHash: string): string {
  if (!SHA256_HEX.test(sourceHash)) throw new RangeError(`engine-tree: source hash ${JSON.stringify(sourceHash)} is not a sha256`);
  return join(enginesRoot(stateRoot), sourceHash);
}

function readRecord(root: string): EngineRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, ENGINE_RECORD), "utf8"));
  } catch (err) {
    // No record, or a torn one: not an engine. Anything but those two is a real fault the caller must see.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT" || err instanceof SyntaxError) return undefined;
    throw err;
  }
  const r = parsed as Partial<EngineRecord> | null;
  const target = typeof r?.nodeModulesTarget === "string" ? { nodeModulesTarget: r.nodeModulesTarget } : {};
  return r && typeof r.sha === "string" && GIT_SHA.test(r.sha) && typeof r.sourceHash === "string" && SHA256_HEX.test(r.sourceHash) && Number.isFinite(r.builtAt)
    ? { sha: r.sha, sourceHash: r.sourceHash, builtAt: r.builtAt as number, ...target }
    : undefined;
}

/** Every published engine, newest first. A missing `engines/` is none. */
export function listEngines(stateRoot: string): EngineRef[] {
  let names: string[];
  try {
    names = readdirSync(enginesRoot(stateRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const found: EngineRef[] = [];
  for (const name of names) {
    if (!SHA256_HEX.test(name)) continue;
    const root = join(enginesRoot(stateRoot), name);
    const record = readRecord(root);
    if (record && record.sourceHash === name) found.push({ ...record, root });
  }
  return found.sort((a, b) => b.builtAt - a.builtAt || (a.sourceHash < b.sourceHash ? -1 : 1));
}

// ── node_modules trust (W1-T9738) ─────────────────────────────────────────────────────────────

/**
 * The roots a worker's worktree sits under, derived from `<root>/state` as worker.ts derives them from `config.root`:
 * worktreesDir's `<root>/worktrees`, adhocLaneRoot's `<root>/lanes`, and the state directory's own `worktrees/`.
 */
export function workerWritableRoots(stateRoot: string): string[] {
  const state = resolve(stateRoot);
  return [join(dirname(state), "worktrees"), join(dirname(state), "lanes"), join(state, "worktrees")];
}

export type TrustedModules =
  | { ok: true; target: string }
  | { ok: false; reason: "node-modules-missing" | "node-modules-untrusted"; detail: string };

/** The root `path` sits at or under, compared on real paths so a symlinked root cannot hide a worktree. */
function rootHolding(path: string, roots: readonly string[]): string | undefined {
  return roots
    .map((r) => (existsSync(r) ? realpathSync(r) : resolve(r)))
    .find((r) => path === r || path.startsWith(r.endsWith(sep) ? r : `${r}${sep}`));
}

/**
 * The install a node_modules source resolves to, followed through every link to its real path, or why an engine may not
 * link it: nothing to resolve is `node-modules-missing`, and a real path under a worker-writable root is
 * `node-modules-untrusted`. A symlinked worktree node_modules is followed to the install it names now.
 */
export function resolveTrustedModules(source: string | undefined, roots: readonly string[]): TrustedModules {
  if (source === undefined) return { ok: false, reason: "node-modules-missing", detail: "no node_modules source" };
  let target: string;
  try {
    target = realpathSync(source);
  } catch (err) {
    // A dangling link or an absent path resolves to nothing; any other failure is not an answer and propagates.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    return { ok: false, reason: "node-modules-missing", detail: `${source} does not resolve` };
  }
  const held = rootHolding(target, roots);
  if (held) return { ok: false, reason: "node-modules-untrusted", detail: `${source} resolves to ${target}, under worker-writable ${held}` };
  return { ok: true, target };
}

export type EngineModules = { kind: "trusted"; target: string } | { kind: "absent" } | { kind: "dangling" | "untrusted"; detail: string };

/**
 * What a published engine's node_modules resolves to. Trusted only when it is a link that names its resolved install
 * directly (one hop, so no worktree sits between), outside every worker-writable root, and, when the record names a
 * target, that target. `absent` is no entry at all: no worktree is on that path. Dangling and untrusted engines are
 * never current, and the newest of them loses its retention.
 */
export function engineModules(root: string, recorded: string | undefined, roots: readonly string[]): EngineModules {
  const link = join(root, "node_modules");
  const entry = lstatSync(link, { throwIfNoEntry: false });
  if (!entry) return { kind: "absent" };
  if (!entry.isSymbolicLink()) return { kind: "untrusted", detail: `${link} is not a link` };
  const resolved = resolveTrustedModules(link, roots);
  if (!resolved.ok) return { kind: resolved.reason === "node-modules-missing" ? "dangling" : "untrusted", detail: resolved.detail };
  const named = resolve(root, readlinkSync(link));
  if (named !== resolved.target) return { kind: "untrusted", detail: `${link} links through ${named}, not directly to ${resolved.target}` };
  if (recorded !== undefined && recorded !== resolved.target) {
    return { kind: "untrusted", detail: `${link} resolves to ${resolved.target}, not the recorded ${recorded}` };
  }
  return { kind: "trusted", target: resolved.target };
}

const modulesUnsafe = (m: EngineModules): m is { kind: "dangling" | "untrusted"; detail: string } => m.kind === "dangling" || m.kind === "untrusted";

// ── seams ────────────────────────────────────────────────────────────────────────────────────

export type EngineGit = (repoDir: string, args: readonly string[]) => Promise<string>;
/** Through the hardened git leaf: the managed checkout's pointer is vetted and its config pinned. */
export const hardenedEngineGit: EngineGit = (repoDir, args) => hostWorktreeGitAsync(repoDir, args);

export interface EngineBuildOptions {
  /** The managed checkout the engine is a worktree of. */
  repoDir: string;
  /** W1-T9738: the checkout whose install the engine links (resolveNodeModulesSource of it); default `repoDir`. */
  nodeModulesFrom?: string;
  /** Roots no linked install may resolve under; default {@link workerWritableRoots} of the state root. */
  worktreeRoots?: readonly string[];
  resolveModulesSource?: (dir: string) => string | undefined;
  /** Where W1-T8776's stored bundles live. */
  storeRoot: string;
  log?: StoreLog;
  clock?: Clock;
  git?: EngineGit;
  /** Links `<treeRoot>/node_modules` to `target`, the resolved install. */
  linkNodeModules?: (target: string, treeRoot: string) => NodeModulesLinkOutcome;
  /** `expectedHash`, when given, refuses before publishing a tree that hashes elsewhere; default {@link materializeFromStore}. */
  materialize?: (treeRoot: string, storeRoot: string, expectedHash?: string) => StoreLookup;
  /** Whether a run directory's child is live, for the advance's "named by a live run" check; default the real probe. */
  probe?: RunChildProbe;
}

export type EngineBuildResult =
  | { kind: "built"; root: string; ms: number }
  | { kind: "present"; root: string }
  | { kind: "failed"; reason: string };
/** What buildEngine hands ensureEngineTree: a build also names its link target, for the ledger row only. */
type BuildOutcome = Exclude<EngineBuildResult, { kind: "built" }> | { kind: "built"; root: string; ms: number; nodeModulesTarget: string; replacedUnsafeReason?: string };

/** Removes an engine tree and its worktree registration. The default asks git first, then clears what is left. */
async function removeEngineDir(path: string, repoDir: string, git: EngineGit): Promise<void> {
  try {
    await git(repoDir, ["worktree", "remove", "--force", "--force", path]);
  } catch (err) {
    // Not registered (a killed add, or already pruned): the directory is cleared below and the registry pruned after.
    void reasonOf(err);
  }
  rmSync(path, { recursive: true, force: true });
  await git(repoDir, ["worktree", "prune"]).catch((err: unknown) => {
    // A failed prune only leaves a stale registration; the directory is already gone and the next pass prunes again.
    void reasonOf(err);
  });
}

const inFlight = new Map<string, Promise<EngineBuildResult>>();

/** The store materializer with the engine's expected hash, never the tree-hash override, in third place. */
function storeMaterialize(treeRoot: string, storeRoot: string, expectedHash?: string): StoreLookup {
  return materializeFromStore(treeRoot, storeRoot, undefined, undefined, expectedHash);
}

/**
 * Build `<state>/engines/<sourceHash>/` for `sha`: a detached worktree cut into a temporary sibling, its node_modules
 * linked to the install, the stored bundle for `sourceHash` materialized and re-judged, then moved into place and
 * recorded. The record is written last, so a half-built engine is never an engine. An engine already published is
 * `present` while its modules are safe; an unsafe engine is rebuilt unless a live run may name it.
 * Never rejects: every failure is a typed `failed`, ledgered as `engine.build_failed`.
 * A concurrent call for the same engine joins the one in flight.
 */
export function ensureEngineTree(stateRoot: string, sha: string, sourceHash: string, deps: EngineBuildOptions): Promise<EngineBuildResult> {
  const key = `${stateRoot}\0${sourceHash}`;
  const running = inFlight.get(key);
  if (running) return running;
  const log = deps.log ?? (() => {});
  const pass = buildEngine(stateRoot, sha, sourceHash, deps)
    .catch((err: unknown): BuildOutcome => ({ kind: "failed", reason: reasonOf(err) }))
    .then((outcome): EngineBuildResult => {
      if (outcome.kind === "built") {
        const { nodeModulesTarget, replacedUnsafeReason, ...built } = outcome;
        log("engine.built", { sha, source_hash: sourceHash, ms: built.ms, node_modules_target: nodeModulesTarget,
          ...(replacedUnsafeReason ? { replaced_unsafe_reason: replacedUnsafeReason } : {}) });
        return built;
      }
      if (outcome.kind === "failed") log("engine.build_failed", { sha, source_hash: sourceHash, reason: outcome.reason });
      return outcome;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, pass);
  return pass;
}

async function buildEngine(stateRoot: string, sha: string, sourceHash: string, deps: EngineBuildOptions): Promise<BuildOutcome> {
  if (!GIT_SHA.test(sha)) return { kind: "failed", reason: `sha-invalid: ${JSON.stringify(sha)}` };
  if (!SHA256_HEX.test(sourceHash)) return { kind: "failed", reason: `source-hash-invalid: ${JSON.stringify(sourceHash)}` };
  const clock = deps.clock ?? systemClock;
  const git = deps.git ?? hardenedEngineGit;
  const final = enginePath(stateRoot, sourceHash);
  const roots = deps.worktreeRoots ?? workerWritableRoots(stateRoot);
  const present = readRecord(final);
  let replacedUnsafeReason: string | undefined;
  if (present?.sourceHash === sourceHash) {
    const existing = engineModules(final, present.nodeModulesTarget, roots);
    if (!modulesUnsafe(existing)) {
      return present.sha === sha ? { kind: "present", root: final } : advanceEngine(stateRoot, final, present, sha, deps, git, clock);
    }
    const reason = `node-modules-${existing.kind}: ${existing.detail}`;
    let named: ReturnType<typeof namedByLiveRuns>;
    try {
      named = namedByLiveRuns(stateRoot, realRunChildProbe);
    } catch (err) {
      return { kind: "failed", reason: `node-modules-${existing.kind}: held; live runs unreadable: ${reasonOf(err)}` };
    }
    if ("undecidable" in named) return { kind: "failed", reason: `node-modules-${existing.kind}: held; ${named.undecidable}` };
    if (named.hashes.has(sourceHash) || named.shas.has(present.sha)) {
      return { kind: "failed", reason: `node-modules-${existing.kind}: held; named by a live run` };
    }
    await removeEngineDir(final, deps.repoDir, git);
    replacedUnsafeReason = reason;
  }
  // Resolved before anything is cut: an install under a worker's worktree, or none, publishes nothing.
  const modules = resolveTrustedModules(
    (deps.resolveModulesSource ?? resolveNodeModulesSource)(deps.nodeModulesFrom ?? deps.repoDir),
    roots,
  );
  if (!modules.ok) return { kind: "failed", reason: `${modules.reason}: ${modules.detail}` };
  const started = clock.now();
  mkdirSync(enginesRoot(stateRoot), { recursive: true });
  const temp = join(enginesRoot(stateRoot), `${BUILD_PREFIX}${sourceHash.slice(0, 12)}-${process.pid}-${started}`);
  try {
    await git(deps.repoDir, ["worktree", "add", "--detach", temp, sha]);
    const link = deps.linkNodeModules ?? ((target, tree) => linkWorktreeNodeModules(target, tree, { resolveSource: () => target }));
    const linked = link(modules.target, temp);
    if (linked !== "linked") return { kind: "failed", reason: `node-modules-${linked}` };
    const lookup = (deps.materialize ?? storeMaterialize)(temp, deps.storeRoot);
    if (lookup.outcome !== "hit") return { kind: "failed", reason: `store-${lookup.reason}` };
    // The stored key is the tree's own source hash: a checkout that moved between the build and this cut keys elsewhere.
    if (lookup.hash !== sourceHash) return { kind: "failed", reason: `source-moved: tree hashes to ${lookup.hash}` };
    if (existsSync(final)) {
      // Unrecorded: a leftover of a build that died after its move.
      await removeEngineDir(final, deps.repoDir, git);
    }
    await git(deps.repoDir, ["worktree", "move", temp, final]);
    const record: EngineRecord = { sha, sourceHash, builtAt: clock.now(), nodeModulesTarget: modules.target };
    writeAtomic(join(final, ENGINE_RECORD), `${JSON.stringify(record)}\n`);
    return { kind: "built", root: final, ms: clock.now() - started, nodeModulesTarget: modules.target, replacedUnsafeReason };
  } catch (err) {
    return { kind: "failed", reason: reasonOf(err) };
  } finally {
    if (existsSync(temp)) await removeEngineDir(temp, deps.repoDir, git);
  }
}

// ── the pin lock ─────────────────────────────────────────────────────────────────────────────

/**
 * An in-place advance and a run naming the engine must not interleave. A launch resolves its engine, waits for
 * admission, and only then writes the spec that names the engine; an advance's census reads those specs and then
 * checks the tree out to a newer revision. A spec written between the census and the checkout named a revision the
 * tree no longer held (#16735 review, 2026-11-04). `<state>/engines/<sourceHash>.pin.lock` closes that window: the
 * advance holds it from its census through the record write, and a launch takes it only to re-read the record and
 * write its spec, so a spec always names the revision its tree holds. Cross-process (an advance can run in a run
 * child's verb while the daemon launches), so it is the O_EXCL holder file {@link acquireInflightLock} keeps.
 */
function pinLockName(sourceHash: string): string {
  return `${sourceHash}.pin`;
}

function tryAcquirePin(stateRoot: string, sourceHash: string, runId: string): InflightLockHandle | InflightLockError {
  mkdirSync(enginesRoot(stateRoot), { recursive: true });
  try {
    return acquireInflightLock(enginesRoot(stateRoot), pinLockName(sourceHash), { run_id: runId });
  } catch (err) {
    if (err instanceof InflightLockError) return err;
    throw err;
  }
}

/**
 * The longest a launch waits for an advance to release the pin. An advance holds it for one checkout and one store
 * re-judge, each bounded by the git leaf's own loop bound, so this is a backstop, not a policy: past it the launch
 * is unavailable (no child starts), never unpinned.
 */
export const ENGINE_PIN_WAIT_MS = 60_000;

export interface EnginePinOptions {
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: Clock;
}

/**
 * Re-read `sourceHash`'s published record under the pin lock and hand its current revision to `publish` (which
 * writes the run's spec naming it), releasing the lock after. Resolves to the revision published, or to
 * `{ unavailable }` when the engine is gone or the pin stayed busy past {@link ENGINE_PIN_WAIT_MS}.
 */
export async function pinEngineForRun(
  stateRoot: string,
  sourceHash: string,
  runId: string,
  publish: (engine: { sourceHash: string; sha: string }) => void,
  opts: EnginePinOptions = {},
): Promise<{ sourceHash: string; sha: string } | { unavailable: string }> {
  const clock = opts.clock ?? systemClock;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = clock.now() + (opts.waitMs ?? ENGINE_PIN_WAIT_MS);
  for (;;) {
    const held = tryAcquirePin(stateRoot, sourceHash, runId);
    if (!(held instanceof InflightLockError)) {
      try {
        const record = readRecord(enginePath(stateRoot, sourceHash));
        if (!record || record.sourceHash !== sourceHash) return { unavailable: `engine ${sourceHash.slice(0, 12)} is no longer published` };
        const pinned = { sourceHash, sha: record.sha };
        publish(pinned);
        return pinned;
      } finally {
        held.release();
      }
    }
    if (clock.now() >= deadline) return { unavailable: `engine ${sourceHash.slice(0, 12)} pin busy: ${held.message}` };
    await sleep(opts.pollMs ?? 100);
  }
}

/**
 * An engine is keyed by its bundle's source hash, so main advancing only OUTSIDE that closure (workflows, plan, scripts,
 * docs) would leave the tree at the revision it was first cut at: a run child reads those files from its engine tree,
 * and the reviewer then rightly withholds every terminal verdict as stale (#15638, 2026-11-04: 67 commits behind).
 * Advance the published tree to `sha` in place when `sha` descends from the tree's revision, no live run names the
 * engine, and the advanced tree still hashes to the same source. Any other case keeps the tree where it is.
 */
async function advanceEngine(
  stateRoot: string,
  final: string,
  present: EngineRecord,
  sha: string,
  deps: EngineBuildOptions,
  git: EngineGit,
  clock: Clock,
): Promise<BuildOutcome> {
  const log = deps.log ?? (() => {});
  const kept: BuildOutcome = { kind: "present", root: final };
  const row = { source_hash: present.sourceHash, from_sha: present.sha, to_sha: sha };
  let forward: boolean;
  try {
    forward = await isAncestor(git, deps.repoDir, present.sha, sha);
  } catch (err) {
    log("engine.advance_deferred", { ...row, reason: `ancestry unreadable: ${reasonOf(err)}` });
    return kept;
  }
  if (!forward) return kept; // never sideways or back: the tree holds a revision `sha` does not contain
  // Held from the census through the record write: no launch can write a spec naming this engine in between.
  const pin = tryAcquirePin(stateRoot, present.sourceHash, `advance-${process.pid}`);
  if (pin instanceof InflightLockError) {
    log("engine.advance_deferred", { ...row, reason: `a run is pinning the engine: ${pin.message}` });
    return kept;
  }
  try {
    // The record read above predates the pin: another process may have advanced the tree since. Every decision that
    // gates the move (ancestry, the census, the restore target, the record written) is taken again from the record
    // as it stands under the pin, so two overlapping advances can never move the tree back (A→C, then C→B).
    const current = readRecord(final);
    if (current === undefined || current.sourceHash !== present.sourceHash) {
      log("engine.advance_deferred", { ...row, reason: "the engine record changed under the pin" });
      return kept;
    }
    if (current.sha === sha) return kept;
    let stillForward: boolean;
    try {
      stillForward = await isAncestor(git, deps.repoDir, current.sha, sha);
    } catch (err) {
      log("engine.advance_deferred", { ...row, from_sha: current.sha, reason: `ancestry unreadable: ${reasonOf(err)}` });
      return kept;
    }
    if (!stillForward) {
      log("engine.advance_deferred", { ...row, from_sha: current.sha, reason: "superseded" });
      return kept;
    }
    return await advancePinned(stateRoot, final, current, sha, deps, git, clock, { ...row, from_sha: current.sha }, kept);
  } finally {
    pin.release();
  }
}

async function advancePinned(
  stateRoot: string,
  final: string,
  present: EngineRecord,
  sha: string,
  deps: EngineBuildOptions,
  git: EngineGit,
  clock: Clock,
  row: { source_hash: string; from_sha: string; to_sha: string },
  kept: BuildOutcome,
): Promise<BuildOutcome> {
  const log = deps.log ?? (() => {});
  let named: ReturnType<typeof namedByLiveRuns>;
  try {
    named = namedByLiveRuns(stateRoot, deps.probe ?? realRunChildProbe);
  } catch (err) {
    log("engine.advance_deferred", { ...row, reason: `live runs unreadable: ${reasonOf(err)}` });
    return kept;
  }
  if ("undecidable" in named) {
    log("engine.advance_deferred", { ...row, reason: named.undecidable });
    return kept;
  }
  if (named.hashes.has(present.sourceHash) || named.shas.has(present.sha)) {
    log("engine.advance_deferred", { ...row, reason: "named by a live run" });
    return kept;
  }
  const started = clock.now();
  const materialize = deps.materialize ?? storeMaterialize;
  // Every mutation an advance makes, in order: the checkout (HEAD and tracked files), the bundle publish
  // (dist/child-entries and its manifest), the record. Each is either refused before it happens or undone on the way
  // out, so a failed advance leaves the engine at its own revision AND its own bundle, still current (#16735 review).
  let published = false;
  try {
    await git(final, ["checkout", "--detach", "--quiet", sha]);
    // The advance keeps the stored bundle only while the tree's own source still hashes to it. The expected hash is
    // checked BEFORE the publish, so another hash's stored build never replaces this engine's bundle.
    const lookup = materialize(final, deps.storeRoot, present.sourceHash);
    published = lookup.outcome === "hit";
    if (lookup.outcome !== "hit" || lookup.hash !== present.sourceHash) {
      throw new Error(lookup.outcome !== "hit" ? `store-${lookup.reason}` : `source-moved: tree hashes to ${lookup.hash}`);
    }
    const record: EngineRecord = { ...present, sha, builtAt: clock.now() };
    writeAtomic(join(final, ENGINE_RECORD), `${JSON.stringify(record)}\n`);
  } catch (err) {
    try {
      await git(final, ["checkout", "--detach", "--quiet", present.sha]);
      if (published) {
        // A publish happened: put the engine's own stored bundle back, judged against its own source again.
        const restored = materialize(final, deps.storeRoot, present.sourceHash);
        if (restored.outcome !== "hit" || restored.hash !== present.sourceHash) {
          throw new Error(restored.outcome !== "hit" ? `bundle store-${restored.reason}` : `bundle hashes to ${restored.hash}`);
        }
      }
    } catch (restore) {
      log("engine.advance_failed", { ...row, reason: `${reasonOf(err)}; restore failed: ${reasonOf(restore)}` });
      return { kind: "failed", reason: `advance-failed: ${reasonOf(err)}` };
    }
    log("engine.advance_failed", { ...row, reason: reasonOf(err) });
    return kept;
  }
  log("engine.advanced", { ...row, ms: clock.now() - started });
  return kept;
}

// ── currency ─────────────────────────────────────────────────────────────────────────────────

interface BuildScriptView {
  readChildEntryManifest(root: string, outDir?: string): { entries?: { name?: unknown }[] } | null;
  childEntryIsCurrent(root: string, name: string): { current: boolean };
}
/** Every entry the engine's manifest names must be current: the same judgement childEntryArgv applies per entry. */
function bundleIsCurrent(root: string): boolean {
  const script = createRequire(import.meta.url)("../../scripts/build-child-entries.mjs") as BuildScriptView;
  const entries = script.readChildEntryManifest(root)?.entries;
  return Array.isArray(entries) && entries.length > 0 && entries.every((e) => script.childEntryIsCurrent(root, String(e?.name)).current);
}

export interface NewestEngineOptions {
  repoDir: string;
  log?: StoreLog;
  git?: EngineGit;
  /** Seam for the currency judgement; the default is scripts/build-child-entries.mjs's own childEntryIsCurrent per entry. */
  isCurrent?: (root: string) => boolean;
  /** W1-T9738: roots an engine's node_modules may not resolve into; default {@link workerWritableRoots}. */
  worktreeRoots?: readonly string[];
}

async function isAncestor(git: EngineGit, repoDir: string, ancestor: string, tip: string): Promise<boolean> {
  try {
    await git(repoDir, ["merge-base", "--is-ancestor", ancestor, tip]);
    return true;
  } catch (err) {
    // Exit 1 is git's answer "not an ancestor"; any other failure (an unknown object is 128) is not an answer.
    if ((err as { code?: unknown })?.code === 1) return false;
    throw err;
  }
}

/**
 * The newest engine whose bundle is current and whose revision is main's tip or an ancestor of it, or undefined. When
 * that is not the tip it ledgers `engine.lag` {engine_sha, main_sha, commits_behind}: the children spawned on it run
 * behind main by that many commits, visibly. An engine that cannot be judged is skipped with `engine.candidate_skipped`.
 */
export async function newestCurrentEngine(stateRoot: string, mainSha: string, deps: NewestEngineOptions): Promise<EngineRef | undefined> {
  const log = deps.log ?? (() => {});
  const git = deps.git ?? hardenedEngineGit;
  const current = deps.isCurrent ?? bundleIsCurrent;
  const roots = deps.worktreeRoots ?? workerWritableRoots(stateRoot);
  let chosen: EngineRef | undefined;
  for (const engine of listEngines(stateRoot)) {
    try {
      // Judged apart from the bundle seam: no currency answer makes modules a worker can rewrite current.
      const modules = engineModules(engine.root, engine.nodeModulesTarget, roots);
      if (modulesUnsafe(modules)) {
        log("engine.candidate_skipped", { source_hash: engine.sourceHash, sha: engine.sha, reason: `node-modules-${modules.kind}: ${modules.detail}` });
        continue;
      }
      if (!current(engine.root)) continue;
      if (engine.sha !== mainSha && !(await isAncestor(git, deps.repoDir, engine.sha, mainSha))) continue;
      chosen = engine;
      break;
    } catch (err) {
      log("engine.candidate_skipped", { source_hash: engine.sourceHash, sha: engine.sha, reason: reasonOf(err) });
    }
  }
  if (chosen?.sha === mainSha) return chosen;
  let behind: number | null = null;
  if (chosen) {
    try {
      behind = Number((await git(deps.repoDir, ["rev-list", "--count", `${chosen.sha}..${mainSha}`])).trim());
    } catch (err) {
      log("engine.candidate_skipped", { source_hash: chosen.sourceHash, sha: chosen.sha, reason: `commits-behind unreadable: ${reasonOf(err)}` });
    }
  }
  log("engine.lag", { engine_sha: chosen?.sha ?? null, main_sha: mainSha, commits_behind: Number.isFinite(behind) ? behind : null });
  return chosen;
}

// ── retention ────────────────────────────────────────────────────────────────────────────────

export interface PruneEngineOptions {
  repoDir: string;
  log?: StoreLog;
  git?: EngineGit;
  probe?: RunChildProbe;
  /** An engine to keep besides the newest published one (the newest CURRENT engine, when it is an older one). */
  keep?: string;
  /** W1-T9738: roots an engine's node_modules may not resolve into; default {@link workerWritableRoots}. */
  worktreeRoots?: readonly string[];
}

/** Engine hashes and shas that a non-terminal run directory names, or a reason the answer cannot be known. */
function namedByLiveRuns(stateRoot: string, probe: RunChildProbe): { hashes: Set<string>; shas: Set<string> } | { undecidable: string } {
  const hashes = new Set<string>();
  const shas = new Set<string>();
  let dirs;
  try {
    dirs = readdirSync(join(stateRoot, "runs"), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { hashes, shas };
    throw err;
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = join(stateRoot, "runs", entry.name);
    let contents: string[];
    try {
      contents = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw err;
    }
    if (contents.length === 0) continue;
    const classified = classifyRunDir(dir, probe);
    if (classified.kind === "terminal") continue;
    const spec = readSpec(dir);
    if (spec.ok) hashes.add(spec.value.engine.sourceHash);
    if (classified.status) shas.add(classified.status.engineSha);
    if (!spec.ok && !classified.status) return { undecidable: `run ${entry.name} is ${classified.kind} and names no engine (${spec.reason}: ${spec.detail})` };
  }
  return { hashes, shas };
}

/**
 * Remove each engine tree that no non-terminal run directory names and that is neither the newest published nor
 * `keep`. Never by count or age. A run directory that is not terminal and names no engine makes the answer unknowable,
 * so nothing is removed that pass (`engine.prune_deferred`). Leftover `.build-` siblings and unrecorded engine
 * directories that no build in this process is making are cleared too. Returns the engine hashes removed.
 */
export async function pruneEngineTrees(stateRoot: string, deps: PruneEngineOptions): Promise<string[]> {
  const log = deps.log ?? (() => {});
  const git = deps.git ?? hardenedEngineGit;
  const engines = listEngines(stateRoot);
  const named = namedByLiveRuns(stateRoot, deps.probe ?? realRunChildProbe);
  if ("undecidable" in named) {
    log("engine.prune_deferred", { reason: named.undecidable });
    return [];
  }
  // W1-T9738: the newest is kept only while its modules are safe; a dangling or worktree-linked one is pruned and rebuilt.
  const roots = deps.worktreeRoots ?? workerWritableRoots(stateRoot);
  const newest = engines[0] && !modulesUnsafe(engineModules(engines[0].root, engines[0].nodeModulesTarget, roots)) ? engines[0].sourceHash : undefined;
  const removed: string[] = [];
  const deferred: Record<string, string> = {};
  for (const engine of engines) {
    if (engine.sourceHash === newest || engine.sourceHash === deps.keep) continue;
    if (named.hashes.has(engine.sourceHash) || named.shas.has(engine.sha)) continue;
    const pin = tryAcquirePin(stateRoot, engine.sourceHash, `prune-${process.pid}`);
    if (pin instanceof InflightLockError) {
      deferred[engine.sourceHash] = `engine pin held: ${pin.message}`;
      continue;
    }
    try {
      // A run writes the spec while holding this same pin. Re-read the census under it so
      // a spec cannot appear between the initial census and removal.
      const current = namedByLiveRuns(stateRoot, deps.probe ?? realRunChildProbe);
      if ("undecidable" in current) {
        deferred[engine.sourceHash] = current.undecidable;
        continue;
      }
      if (current.hashes.has(engine.sourceHash) || current.shas.has(engine.sha)) continue;
      await removeEngineDir(engine.root, deps.repoDir, git);
      removed.push(engine.sourceHash);
    } finally {
      pin.release();
    }
  }
  const building = new Set([...inFlight.keys()].map((k) => k.split("\0")[1]));
  const present = existsSync(enginesRoot(stateRoot)) ? readdirSync(enginesRoot(stateRoot), { withFileTypes: true }) : [];
  for (const name of present.filter((e) => e.isDirectory()).map((e) => e.name)) {
    const orphan = (name.startsWith(BUILD_PREFIX) && ![...building].some((h) => h && name.startsWith(`${BUILD_PREFIX}${h.slice(0, 12)}-`)))
      || (SHA256_HEX.test(name) && !building.has(name) && readRecord(join(enginesRoot(stateRoot), name)) === undefined);
    if (orphan) await removeEngineDir(join(enginesRoot(stateRoot), name), deps.repoDir, git);
  }
  if (removed.length) log("engine.pruned", { removed, ...(Object.keys(deferred).length ? { deferred } : {}) });
  if (Object.keys(deferred).length) log("engine.prune_deferred", { engines: deferred });
  return removed;
}

// ── after a store fill ───────────────────────────────────────────────────────────────────────

/**
 * W1-T9077: once the store holds the bundle for the managed checkout's revision, cut its engine tree (a detached worktree a
 * run child that outlives the daemon runs from), ledger how far the newest current engine lags main, and remove the engine
 * trees no run names. Off the loop, never rejects: a failure is ledgered and the previous engine stays the newest.
 * W1-T9738 moved it here from run-task.ts. `repoDir` may be a run's worktree; the engine's node_modules comes from the
 * managed checkout it was cut from (its git common dir's parent), never from the worktree, which its worker can rewrite.
 */
export async function buildEngineAfterStore(
  repoDir: string,
  stateRoot: string,
  storeRoot: string,
  stored: StoreBuildResult,
  log: (step: string, extra?: Record<string, unknown>) => void,
  /** Seams for the git, node_modules and store steps; the defaults are the real ones. */
  seams: Partial<Pick<EngineBuildOptions, "git" | "linkNodeModules" | "materialize" | "clock">> & { isCurrent?: (root: string) => boolean } = {},
): Promise<void> {
  if (stored.kind !== "built" && stored.kind !== "present") return;
  try {
    const git = seams.git ?? hardenedEngineGit;
    const sha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();
    const common = (await git(repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const nodeModulesFrom = basename(common) === ".git" ? dirname(common) : repoDir;
    const { isCurrent, ...buildSeams } = seams;
    const built = await ensureEngineTree(stateRoot, sha, stored.hash, { repoDir, nodeModulesFrom, storeRoot, log, ...buildSeams });
    if (built.kind === "failed") return;
    const newest = await newestCurrentEngine(stateRoot, sha, { repoDir, log, git: seams.git, ...(isCurrent ? { isCurrent } : {}) });
    await pruneEngineTrees(stateRoot, { repoDir, log, git: seams.git, ...(newest ? { keep: newest.sourceHash } : {}) });
  } catch (error) {
    log("engine.build_failed", { source_hash: stored.hash, reason: `engine pass threw: ${String((error as Error)?.message ?? error).slice(0, 400)}` });
  }
}

// ── refresh from the running code ──────────────────────────────────────────────────────────

export interface EngineRefreshLag { engineSha: string | null; mainSha: string }
export interface EngineRefreshOptions {
  git?: EngineGit;
  buildIntoStore?: (treeRoot: string, opts: BuildIntoStoreOptions) => Promise<StoreBuildResult>;
  afterStore?: typeof buildEngineAfterStore;
}

const refreshInFlight = new Map<string, Promise<void>>();
const refreshedSha = new Map<string, string>();

/** Whether the store result's engine is published at `sha`: a built, present or advanced engine's record says so. */
function publishedAt(stateRoot: string, stored: StoreBuildResult, sha: string): boolean {
  if (stored.kind !== "built" && stored.kind !== "present") return false;
  if (!SHA256_HEX.test(stored.hash)) return false;
  const record = readRecord(enginePath(stateRoot, stored.hash));
  return record?.sourceHash === stored.hash && record.sha === sha;
}

/**
 * 2026-11-05: engines were cut only after a build run cut its worktree, but every build run first passes a containment
 * probe that runs FROM the newest engine. When that engine's own code failed the probe (a stale codex profile), no build
 * reached its worktree, no engine was cut, and the probe kept running the stale code: a self-sustaining stall, 4+ h,
 * silent but for engine.lag. A spawn that finds the engine behind main asks this to fill the store and cut an engine
 * from the running process's own code tree, which is at least as new as the code that found the lag. Joined while in
 * flight, done once per code revision it PUBLISHED (a pass that cut nothing is retried by the next ask), never rejects;
 * each pass is ledgered.
 */
export function refreshEngineFromCodeTree(
  codeTree: string, stateRoot: string, storeRoot: string, lag: EngineRefreshLag, log: StoreLog, opts: EngineRefreshOptions = {},
): Promise<void> {
  const key = `${resolve(stateRoot)}\0${resolve(codeTree)}`;
  const running = refreshInFlight.get(key);
  if (running) return running;
  const git = opts.git ?? hardenedEngineGit;
  const pass = (async () => {
    const sha = (await git(codeTree, ["rev-parse", "HEAD"])).trim();
    if (sha === lag.engineSha || refreshedSha.get(key) === sha) return;
    log("engine.refresh_requested", { code_sha: sha, engine_sha: lag.engineSha, main_sha: lag.mainSha });
    const stored = await (opts.buildIntoStore ?? buildIntoStore)(codeTree, { storeRoot, log });
    await (opts.afterStore ?? buildEngineAfterStore)(codeTree, stateRoot, storeRoot, stored, log, opts.git ? { git: opts.git } : {});
    // The engine pass never rejects, so only a published record at this revision proves a cut; anything less is retried.
    if (!publishedAt(stateRoot, stored, sha)) {
      log("engine.refresh_unpublished", { code_sha: sha, store_kind: stored.kind });
      return;
    }
    refreshedSha.set(key, sha);
    log("engine.refresh_done", { code_sha: sha, store_kind: stored.kind });
  })()
    .catch((err: unknown) => log("engine.refresh_failed", { reason: reasonOf(err) }))
    .finally(() => refreshInFlight.delete(key));
  refreshInFlight.set(key, pass);
  return pass;
}
