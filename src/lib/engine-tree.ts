// src/lib/engine-tree.ts — W1-T9077. Decision record: docs/adr/0007-build-runs-outlive-the-daemon.md (A.1, B.4).
//
// deploy/entrypoint.sh's sync_tree moves the daemon's own checkout on every in-container restart, and a bundle
// resolves its modules, scripts and node_modules relative to the tree it sits in (ADR 0006, decision 2). A run child
// that outlives the daemon therefore runs from an ENGINE TREE: `<state>/engines/<sourceHash>/`, a detached worktree of
// the managed checkout at one revision, with the stored bundle materialized into its dist/ and node_modules linked to
// the install. Nothing moves an engine tree while a run's status names it; it is removed only when none does.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { materializeFromStore, type StoreLog, type StoreLookup } from "./child-entry-store.js";
import { writeAtomic } from "./fs-race-safe.js";
import { classifyRunDir, readSpec, realRunChildProbe, type RunChildProbe } from "./run-child-contract.js";
import { linkWorktreeNodeModules, type NodeModulesLinkOutcome } from "./worker.js";
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
  return r && typeof r.sha === "string" && GIT_SHA.test(r.sha) && typeof r.sourceHash === "string" && SHA256_HEX.test(r.sourceHash) && Number.isFinite(r.builtAt)
    ? { sha: r.sha, sourceHash: r.sourceHash, builtAt: r.builtAt as number }
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

// ── seams ────────────────────────────────────────────────────────────────────────────────────

export type EngineGit = (repoDir: string, args: readonly string[]) => Promise<string>;
/** Through the hardened git leaf: the managed checkout's pointer is vetted and its config pinned. */
export const hardenedEngineGit: EngineGit = (repoDir, args) => hostWorktreeGitAsync(repoDir, args);

export interface EngineBuildOptions {
  /** The managed checkout the engine is a worktree of. */
  repoDir: string;
  /** Where W1-T8776's stored bundles live. */
  storeRoot: string;
  log?: StoreLog;
  clock?: Clock;
  git?: EngineGit;
  linkNodeModules?: (repoDir: string, treeRoot: string) => NodeModulesLinkOutcome;
  materialize?: (treeRoot: string, storeRoot: string) => StoreLookup;
}

export type EngineBuildResult =
  | { kind: "built"; root: string; ms: number }
  | { kind: "present"; root: string }
  | { kind: "failed"; reason: string };

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

/**
 * Build `<state>/engines/<sourceHash>/` for `sha`: a detached worktree cut into a temporary sibling, its node_modules
 * linked to the install, the stored bundle for `sourceHash` materialized and re-judged, then moved into place and
 * recorded. The record is written last, so a half-built engine is never an engine. An engine already published is
 * `present`. Never rejects: every failure is a typed `failed`, ledgered as `engine.build_failed`, and the previous
 * engine stays the newest. A concurrent call for the same engine joins the one in flight.
 */
export function ensureEngineTree(stateRoot: string, sha: string, sourceHash: string, deps: EngineBuildOptions): Promise<EngineBuildResult> {
  const key = `${stateRoot}\0${sourceHash}`;
  const running = inFlight.get(key);
  if (running) return running;
  const log = deps.log ?? (() => {});
  const pass = buildEngine(stateRoot, sha, sourceHash, deps)
    .catch((err: unknown): EngineBuildResult => ({ kind: "failed", reason: reasonOf(err) }))
    .then((result) => {
      if (result.kind === "built") log("engine.built", { sha, source_hash: sourceHash, ms: result.ms });
      if (result.kind === "failed") log("engine.build_failed", { sha, source_hash: sourceHash, reason: result.reason });
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, pass);
  return pass;
}

async function buildEngine(stateRoot: string, sha: string, sourceHash: string, deps: EngineBuildOptions): Promise<EngineBuildResult> {
  if (!GIT_SHA.test(sha)) return { kind: "failed", reason: `sha-invalid: ${JSON.stringify(sha)}` };
  if (!SHA256_HEX.test(sourceHash)) return { kind: "failed", reason: `source-hash-invalid: ${JSON.stringify(sourceHash)}` };
  const clock = deps.clock ?? systemClock;
  const git = deps.git ?? hardenedEngineGit;
  const final = enginePath(stateRoot, sourceHash);
  if (readRecord(final)?.sourceHash === sourceHash) return { kind: "present", root: final };
  const started = clock.now();
  mkdirSync(enginesRoot(stateRoot), { recursive: true });
  const temp = join(enginesRoot(stateRoot), `${BUILD_PREFIX}${sourceHash.slice(0, 12)}-${process.pid}-${started}`);
  try {
    await git(deps.repoDir, ["worktree", "add", "--detach", temp, sha]);
    const linked = (deps.linkNodeModules ?? ((repo, tree) => linkWorktreeNodeModules(repo, tree)))(deps.repoDir, temp);
    if (linked !== "linked") return { kind: "failed", reason: `node-modules-${linked}` };
    const lookup = (deps.materialize ?? materializeFromStore)(temp, deps.storeRoot);
    if (lookup.outcome !== "hit") return { kind: "failed", reason: `store-${lookup.reason}` };
    // The stored key is the tree's own source hash: a checkout that moved between the build and this cut keys elsewhere.
    if (lookup.hash !== sourceHash) return { kind: "failed", reason: `source-moved: tree hashes to ${lookup.hash}` };
    if (existsSync(final)) {
      // Unrecorded (a record would have returned `present`): a leftover of a build that died after its move.
      await removeEngineDir(final, deps.repoDir, git);
    }
    await git(deps.repoDir, ["worktree", "move", temp, final]);
    const record: EngineRecord = { sha, sourceHash, builtAt: clock.now() };
    writeAtomic(join(final, ENGINE_RECORD), `${JSON.stringify(record)}\n`);
    return { kind: "built", root: final, ms: clock.now() - started };
  } catch (err) {
    return { kind: "failed", reason: reasonOf(err) };
  } finally {
    if (existsSync(temp)) await removeEngineDir(temp, deps.repoDir, git);
  }
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
  let chosen: EngineRef | undefined;
  for (const engine of listEngines(stateRoot)) {
    try {
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
  const newest = engines[0]?.sourceHash;
  const removed: string[] = [];
  for (const engine of engines) {
    if (engine.sourceHash === newest || engine.sourceHash === deps.keep) continue;
    if (named.hashes.has(engine.sourceHash) || named.shas.has(engine.sha)) continue;
    await removeEngineDir(engine.root, deps.repoDir, git);
    removed.push(engine.sourceHash);
  }
  const building = new Set([...inFlight.keys()].map((k) => k.split("\0")[1]));
  const present = existsSync(enginesRoot(stateRoot)) ? readdirSync(enginesRoot(stateRoot), { withFileTypes: true }) : [];
  for (const name of present.filter((e) => e.isDirectory()).map((e) => e.name)) {
    const orphan = (name.startsWith(BUILD_PREFIX) && ![...building].some((h) => h && name.startsWith(`${BUILD_PREFIX}${h.slice(0, 12)}-`)))
      || (SHA256_HEX.test(name) && !building.has(name) && readRecord(join(enginesRoot(stateRoot), name)) === undefined);
    if (orphan) await removeEngineDir(join(enginesRoot(stateRoot), name), deps.repoDir, git);
  }
  if (removed.length) log("engine.pruned", { removed });
  return removed;
}
