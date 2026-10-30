// src/lib/child-entry-store.ts — W1-T8776. Decision record: docs/adr/0006-precompiled-daemon-child-entries.md.
//
// A fresh worktree has no dist/, so W1-T7729's precompiled child entries were current only where a build had
// run. sourceHash never includes the absolute path, so every worktree holding one source shares one key: this
// store keeps one build per key at `<config.root>/child-entries/<sourceHash>/`, the daemon fills it once per
// main revision (buildIntoStore, a child process), and childEntryArgv copies a stored build into a tree that has
// no current bundle (materializeFromStore). Every stored and staged payload is judged by
// scripts/build-child-entries.mjs's own childEntryIsCurrent, never by a second guard here.
import { execFileLoopBounded } from "./loop-bounded-child.js";
import {
  constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { systemClock, type Clock } from "./clock.js";

interface Currency { current: boolean; reason: string; bundle?: string }
interface StoredManifest { sourceHash?: unknown; entries?: unknown; workers?: unknown }
interface BuildScript {
  OUT_DIR: string;
  MANIFEST_NAME: string;
  sourceHash(root: string): string;
  readChildEntryManifest(root: string, outDir?: string): unknown;
  childEntryIsCurrent(root: string, name: string, opts?: { outDir?: string; treeHash?: string }): Currency;
  workerBundle(root: string, module: string, opts?: { outDir?: string; treeHash?: string }): Currency;
}
/** Loaded on demand for the reason child-entry-argv.ts gives: a tree may carry src/ but not scripts/. */
const loadBuildScript = (): BuildScript => createRequire(import.meta.url)("../../scripts/build-child-entries.mjs") as BuildScript;

export type StoreLog = (step: string, extra?: Record<string, unknown>) => void;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BUILD_SCRIPT = join("scripts", "build-child-entries.mjs");
/** Reflink when the filesystem can, an ordinary copy when it cannot; never onto an existing file. Never a hardlink. */
export const MATERIALIZE_COPY_MODE = constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL;
/** Retention window: a stored hash no main revision of the last day and no live worktree uses is dropped. */
export const STORE_IDLE_MS = 24 * 60 * 60 * 1000;

const errorText = (err: unknown): string => String((err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? err).slice(0, 120);

/** The store under an instance's state root. */
export const childEntryStoreRoot = (configRoot: string): string => join(configRoot, "child-entries");

/**
 * The store of the instance this process runs as, read without side effects: `root` from
 * ~/.config/remudero/config.json when it is an absolute path, `~/Remudero` otherwise (loadConfig's default).
 */
export function defaultChildEntryStoreRoot(home: string = homedir()): string {
  return childEntryStoreRoot(configuredRoot(home) ?? join(home, "Remudero"));
}

/** The config's absolute `root`, or undefined when there is no config yet. An unparseable config throws to the caller. */
function configuredRoot(home: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(home, ".config", "remudero", "config.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as { root?: unknown } | null;
  return typeof parsed?.root === "string" && isAbsolute(parsed.root) ? parsed.root : undefined;
}

/**
 * Why the build in `dir` cannot be trusted for a tree whose source hash is `treeHash`, or null when every entry
 * its manifest names is current. Each entry goes through childEntryIsCurrent with `outDir` = `dir`: the same
 * manifest, path, size and digest checks W1-T8775 applies to a tree's own bundle.
 */
function storedBuildRefusal(script: BuildScript, dir: string, treeRoot: string, treeHash: string): string | null {
  const manifest = script.readChildEntryManifest(dir, ".") as StoredManifest | null;
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.entries) || manifest.entries.length === 0) return "manifest-invalid";
  if (manifest.sourceHash !== treeHash) return "hash-mismatch";
  for (const entry of manifest.entries as { name?: unknown }[]) {
    const verdict = script.childEntryIsCurrent(treeRoot, String(entry?.name), { outDir: dir, treeHash });
    if (!verdict.current) return verdict.reason;
  }
  // W1-T8777: a build's worker bundles are judged as its entries are, so a materialized copy never lacks one.
  for (const worker of storedWorkers(manifest)) {
    const verdict = script.workerBundle(treeRoot, String(worker?.module), { outDir: dir, treeHash });
    if (!verdict.current) return `worker ${String(worker?.module)}: ${verdict.reason}`;
  }
  return null;
}

const storedWorkers = (manifest: StoredManifest): Array<{ module?: unknown; bundle?: unknown }> =>
  Array.isArray(manifest.workers) ? manifest.workers as Array<{ module?: unknown; bundle?: unknown }> : [];

const bundleNames = (script: BuildScript, dir: string): string[] => {
  const manifest = script.readChildEntryManifest(dir, ".") as StoredManifest;
  return [...(manifest.entries as { bundle: string }[]), ...storedWorkers(manifest)].map((e) => String(e.bundle));
};

function touch(path: string): void {
  const now = systemClock.date();
  utimesSync(path, now, now);
}

/**
 * Rename `from` onto `to`. An occupied `to` is moved aside first. A peer that publishes between the two renames makes
 * the second one throw, which the callers read as a miss (tsx) or a failed build: never a half-published directory.
 */
function publishDir(from: string, to: string, aside: string): void {
  try {
    renameSync(from, to);
    return;
  } catch (err) {
    if (!["ENOTEMPTY", "EEXIST"].includes(String((err as NodeJS.ErrnoException)?.code))) throw err;
  }
  renameSync(to, aside);
  try {
    renameSync(from, to);
  } finally {
    rmSync(aside, { recursive: true, force: true });
  }
}

export type StoreLookup = { outcome: "hit"; hash: string } | { outcome: "miss"; reason: string; hash?: string };

/** Whether the store holds any build at all: an empty or absent store misses without hashing the tree. */
function holdsAnyBuild(storeRoot: string): boolean {
  try {
    return readdirSync(storeRoot).some((name) => SHA256_HEX.test(name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Copy the stored build for `treeRoot`'s source hash into `<treeRoot>/dist/child-entries/`. The files are copied
 * (MATERIALIZE_COPY_MODE) into a private staging directory beside it, the STAGED copy is validated, and only then
 * is it renamed into place, so no reader ever sees a half-copied directory and no write to one tree reaches the
 * store or another tree. A hit means "published"; the caller still re-checks childEntryIsCurrent before running it.
 */
export function materializeFromStore(treeRoot: string, storeRoot: string, treeHash?: string, hashSource?: (root: string) => string): StoreLookup {
  try {
    if (!holdsAnyBuild(storeRoot)) return { outcome: "miss", reason: "store-empty" };
    const script = loadBuildScript();
    const hash = treeHash ?? (hashSource ?? script.sourceHash)(treeRoot);
    const stored = join(storeRoot, hash);
    if (!existsSync(stored)) return { outcome: "miss", reason: "no-stored-build", hash };
    const storedRefusal = storedBuildRefusal(script, stored, treeRoot, hash);
    if (storedRefusal) return { outcome: "miss", reason: `stored-${storedRefusal}`, hash };
    const target = resolve(treeRoot, script.OUT_DIR);
    const parent = resolve(target, "..");
    mkdirSync(parent, { recursive: true });
    const stage = mkdtempSync(join(parent, ".child-entries-stage-"));
    try {
      for (const file of [...bundleNames(script, stored), script.MANIFEST_NAME]) {
        copyFileSync(join(stored, file), join(stage, file), MATERIALIZE_COPY_MODE);
      }
      // bundlemain: each bundle's linked map travels with it (a recipe-5 build writes one), so a main started from a
      // materialized bundle keeps its source maps. A build without maps has none to copy.
      for (const map of bundleNames(script, stored).map((bundle) => `${bundle}.map`).filter((file) => existsSync(join(stored, file)))) {
        copyFileSync(join(stored, map), join(stage, map), MATERIALIZE_COPY_MODE);
      }
      const stagedRefusal = storedBuildRefusal(script, stage, treeRoot, hash);
      if (stagedRefusal) return { outcome: "miss", reason: `staged-${stagedRefusal}`, hash };
      publishDir(stage, target, `${stage}-old`);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    touch(stored);
    return { outcome: "hit", hash };
  } catch (err) {
    return { outcome: "miss", reason: `store-error: ${errorText(err)}` };
  }
}

export type StoreBuildResult =
  | { kind: "built"; hash: string; ms: number; bytes: number }
  | { kind: "present"; hash: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string; hash?: string };

/** Runs `node <script> ...args` in a CHILD process and resolves its stdout; rejects on a non-zero exit. */
export type RunBuildScript = (script: string, args: readonly string[], cwd: string) => Promise<string>;
export const runBuildScriptInChild: RunBuildScript = (script, args, cwd) =>
  execFileLoopBounded(process.execPath, [script, ...args], { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60 * 1000 }).then(
    ({ stdout }) => stdout,
    // The script's own stderr names why it failed; the spawn error's message is only the command line.
    (err: { stderr?: unknown; message: string }) => { throw new Error(String(err.stderr ?? "").trim().slice(-400) || err.message); },
  );

export interface BuildIntoStoreOptions {
  storeRoot: string;
  log?: StoreLog;
  /** Trees whose current bundle retention must keep (the registered worktrees). */
  liveTrees?: () => readonly string[];
  /** Seam for the child process; the default spawns plain node on the tree's own build script. */
  runScript?: RunBuildScript;
  clock?: Clock;
}

const sourceHashFrom = (stdout: string): string | undefined => /^source hash ([0-9a-f]{64})$/m.exec(stdout)?.[1];

function dirBytes(dir: string): number {
  return readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
}

async function buildIntoStoreUnlogged(treeRoot: string, opts: BuildIntoStoreOptions): Promise<StoreBuildResult> {
  const script = join(treeRoot, BUILD_SCRIPT);
  if (!existsSync(script)) return { kind: "skipped", reason: "tree-has-no-build-script" };
  const run = opts.runScript ?? runBuildScriptInChild;
  const clock = opts.clock ?? systemClock;
  const started = clock.now();
  // The tree's OWN script: sourceHash covers it, so only its recipe can produce a bundle the key vouches for.
  const hash = sourceHashFrom(await run(script, ["--root", treeRoot, "--hash"], treeRoot));
  if (!hash) return { kind: "failed", reason: "hash-unreadable" };
  const validator = loadBuildScript();
  const stored = join(opts.storeRoot, hash);
  if (existsSync(stored) && storedBuildRefusal(validator, stored, treeRoot, hash) === null) {
    touch(stored);
    return { kind: "present", hash };
  }
  mkdirSync(opts.storeRoot, { recursive: true });
  const temp = mkdtempSync(join(opts.storeRoot, `.build-${hash.slice(0, 12)}-`));
  try {
    const built = sourceHashFrom(await run(script, ["--root", treeRoot, "--out", temp], treeRoot));
    if (built !== hash) return { kind: "failed", reason: `source-moved-during-build (${built ?? "no hash"})`, hash };
    const refusal = storedBuildRefusal(validator, temp, treeRoot, hash);
    if (refusal) return { kind: "failed", reason: `built-${refusal}`, hash };
    publishStored(validator, temp, stored, treeRoot, hash);
    return { kind: "built", hash, ms: clock.now() - started, bytes: dirBytes(stored) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Publish `temp` as `stored`, never replacing another owner's completed VALID build; an invalid one is replaced. */
function publishStored(script: BuildScript, temp: string, stored: string, treeRoot: string, hash: string): void {
  if (existsSync(stored) && storedBuildRefusal(script, stored, treeRoot, hash) === null) return;
  publishDir(temp, stored, `${temp}-invalid`);
}

/** Retention after a build; a failure to prune is ledgered and changes nothing else. */
function prune(opts: BuildIntoStoreOptions, log: StoreLog): void {
  try {
    const removed = pruneChildEntryStore(opts.storeRoot, { liveTrees: opts.liveTrees?.() ?? [], now: (opts.clock ?? systemClock).now() });
    if (removed.length) log("child_entry.store_pruned", { removed });
  } catch (err) {
    log("child_entry.store_prune_failed", { reason: errorText(err) });
  }
}

const inFlight = new Map<string, Promise<StoreBuildResult>>();

/**
 * Build `treeRoot`'s child entries into the store, keyed by its source hash, off the caller's event loop: both the
 * hash and the build run in a child process, into a temporary directory renamed into place. A hash already stored
 * and valid is a no-op (`present`); a concurrent call for the same tree joins the one in flight. Never rejects:
 * any failure is a typed `failed`, ledgered as `child_entry.store_build_failed`, and children keep running tsx.
 * Retention runs after every build.
 */
export function buildIntoStore(treeRoot: string, opts: BuildIntoStoreOptions): Promise<StoreBuildResult> {
  const key = `${resolve(opts.storeRoot)}\0${resolve(treeRoot)}`;
  const running = inFlight.get(key);
  if (running) return running;
  const log = opts.log ?? (() => {});
  const pass = buildIntoStoreUnlogged(resolve(treeRoot), opts)
    .catch((err: unknown): StoreBuildResult => ({ kind: "failed", reason: String((err as Error)?.message ?? err).slice(0, 400) }))
    .then((result) => {
      if (result.kind === "built") log("child_entry.store_built", { reason: "new-build", hash: result.hash, ms: result.ms, bytes: result.bytes });
      if (result.kind === "present") log("child_entry.store_present", { reason: "source-hash-already-present", hash: result.hash });
      if (result.kind === "skipped") log("child_entry.store_build_skipped", { reason: result.reason });
      if (result.kind === "failed") log("child_entry.store_build_failed", { reason: result.reason, hash: result.hash });
      if (result.kind !== "skipped") prune(opts, log);
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, pass);
  return pass;
}

/**
 * W1-T9601: what one request to fill the store for a tree answered. `requested` started a build, `joined` found one
 * running for the same hash, and `already-tried` found one this process already finished for it.
 */
export type OwnTreeFill = "requested" | "joined" | "already-tried";

export interface OwnTreeFillOptions extends Omit<BuildIntoStoreOptions, "liveTrees"> {
  /** Who asked, ledgered as `source` on child_entry.store_build_requested. */
  source: string;
  /** The build. Default: {@link buildIntoStore}, which never rejects. */
  build?: (treeRoot: string, opts: BuildIntoStoreOptions) => Promise<StoreBuildResult>;
}

/** Per (store, tree, source hash): the build still running, or `settled` once it finished, whatever its outcome. */
const ownTreeFills = new Map<string, Promise<StoreBuildResult> | "settled">();

/**
 * W1-T9601: build `treeRoot` into the store at most once per (store, tree, source hash) in this process, unawaited.
 * `hash` is what the missed lookup computed. A `store-empty` miss computed none, so it keys on the tree alone until
 * the build reports a hash, and that hash is then marked too. A finished build is never retried at its hash, even
 * a failed one: only a miss at a different hash asks again. Retention after it keeps the hash the tree runs (`liveTrees`).
 */
export function fillStoreForOwnTree(treeRoot: string, hash: string | undefined, opts: OwnTreeFillOptions): OwnTreeFill {
  const tree = resolve(treeRoot);
  const base = `${resolve(opts.storeRoot)}\0${tree}\0`;
  const key = base + (hash ?? "");
  const seen = ownTreeFills.get(key);
  if (seen !== undefined) return seen === "settled" ? "already-tried" : "joined";
  opts.log?.("child_entry.store_build_requested", { source: opts.source, tree, hash: hash ?? null });
  const build = opts.build ?? buildIntoStore;
  const buildOpts: BuildIntoStoreOptions = { storeRoot: opts.storeRoot, log: opts.log, runScript: opts.runScript, clock: opts.clock, liveTrees: () => [tree] };
  const pass = build(tree, buildOpts).then((result) => {
    ownTreeFills.set(key, "settled");
    if ("hash" in result && result.hash !== undefined) ownTreeFills.set(base + result.hash, "settled");
    return result;
  });
  ownTreeFills.set(key, pass);
  return "requested";
}

/** The source hash a tree's own published manifest names, if any: what that live tree runs, read without hashing. */
function liveTreeHash(tree: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(tree, "dist", "child-entries", "manifest.json"), "utf8")) as StoredManifest;
    return typeof manifest.sourceHash === "string" ? manifest.sourceHash : undefined;
  } catch (err) {
    // No manifest, or one childEntryIsCurrent would refuse too: that tree runs tsx, so it holds no stored hash in use.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT" || err instanceof SyntaxError) return undefined;
    throw err;
  }
}

/**
 * Drop each stored hash that no main revision of the last day and no live worktree uses: its directory's mtime
 * is refreshed whenever the daemon confirms it for main (`built`/`present`) or a tree materializes it, so a stale
 * mtime means no main revision of the window holds it. Never a fixed count. Abandoned build and staging leftovers
 * older than the window go too. Returns the names removed.
 */
export function pruneChildEntryStore(
  storeRoot: string,
  { liveTrees = [], now = systemClock.now(), idleMs = STORE_IDLE_MS }: { liveTrees?: readonly string[]; now?: number; idleMs?: number } = {},
): string[] {
  const keep = new Set(liveTrees.map(liveTreeHash).filter((h): h is string => h !== undefined));
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(storeRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return removed;
    throw err;
  }
  for (const name of names) {
    const ours = SHA256_HEX.test(name) || name.startsWith(".build-");
    if (!ours || keep.has(name)) continue;
    const path = join(storeRoot, name);
    if (now - statSync(path).mtimeMs <= idleMs) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
