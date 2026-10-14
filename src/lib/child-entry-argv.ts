// src/lib/child-entry-argv.ts — W1-T8775. Decision record: docs/adr/0006-precompiled-daemon-child-entries.md.
//
// One place decides how a daemon child is launched: the precompiled bundle under plain node when
// scripts/build-child-entries.mjs vouches it is current for the tree, tsx on the source entry otherwise.
// Currency is judged by that script's own childEntryIsCurrent (source hash, payload digest, path and
// shape), never by a second implementation here.
//
// W1-T8776: a tree with no current bundle first asks the shared store (src/lib/child-entry-store.ts) for a build at
// its own source hash; a hit is copied into the tree and re-judged by childEntryIsCurrent before it runs.
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { defaultChildEntryStoreRoot, materializeFromStore, type StoreLog, type StoreLookup } from "./child-entry-store.js";

interface ChildEntryCurrency { current: boolean; reason: string; bundle?: string }
type CurrencyCheck = (root: string, name: string) => ChildEntryCurrency;
/** W1-T8777: scripts/build-child-entries.mjs's workerBundle, as a seam. */
export type WorkerBundleCheck = (root: string, module: string, opts: { verifySource: boolean }) => ChildEntryCurrency;

/** W1-T8777: true in an isolate running a bundle (its banner sets the flag), which has no tsx loader. */
export const runsBundled = (): boolean => (globalThis as { __rmd_bundled?: unknown }).__rmd_bundled === true;

/**
 * W1-T8777: where to start the worker a module starts from its own URL (`selfUrl`, its `import.meta.url`).
 * Unbundled, that URL, as before. Bundled, the module's own worker bundle from the same build: the isolate has no
 * tsx loader, so the .ts source cannot load, and a bundled process that has no such bundle throws rather than try.
 * The tree root is everything before `selfUrl`'s `/src/`, where a bundle resolves each module's source.
 */
export function bundledWorkerUrl(selfUrl: string | URL, check?: WorkerBundleCheck): URL {
  const self = new URL(selfUrl);
  if (!runsBundled()) return self;
  const path = fileURLToPath(self);
  const at = path.lastIndexOf(`${sep}src${sep}`);
  if (at < 0) throw new Error(`a bundled process cannot start ${path} as a worker: it is not under a src/ directory (W1-T8777)`);
  const root = path.slice(0, at);
  const module = relative(root, path).split(sep).join("/");
  const verdict = (check ?? loadWorkerBundleCheck())(root, module, { verifySource: false });
  if (!verdict.current || typeof verdict.bundle !== "string") {
    throw new Error(`a bundled process cannot start ${module} as a worker: ${verdict.reason} (W1-T8777)`);
  }
  return pathToFileURL(verdict.bundle);
}

const loadWorkerBundleCheck = (): WorkerBundleCheck =>
  (createRequire(import.meta.url)("../../scripts/build-child-entries.mjs") as { workerBundle: WorkerBundleCheck }).workerBundle;

/** W1-T9370: the off switch for starting a tsx parent's workers from bundles; "0" starts every worker from its .ts source. */
export const BUNDLED_WORKERS_ENV = "RMD_BUNDLED_WORKERS";
export type WorkerEntryLog = (step: string, extra: Record<string, unknown>) => void;
/** W1-T9370: what one module's worker start was decided to be, for the process's life. */
interface WorkerEntryDecision { kind: "bundle" | "tsx"; reason: string; url?: URL }
export interface StartWorkerDeps {
  /** A caller's own worker URL (a test's): started as given, as before W1-T9370. */
  override?: string | URL;
  env?: NodeJS.ProcessEnv;
  /** The store a miss materializes from; `false` never asks it. Default: this instance's. */
  storeRoot?: string | false;
  check?: (root: string, module: string, opts: { treeHash?: string }) => ChildEntryCurrency;
  hash?: (root: string) => string;
  construct?: (url: string | URL, options: WorkerOptions) => Worker;
}

let entryLog: WorkerEntryLog | undefined;
/** Where each module's first worker.entry_resolved row goes; serve sets its ledger log at boot. */
export function setWorkerEntryLog(log: WorkerEntryLog | undefined): void {
  entryLog = log;
}
const decisions = new Map<string, WorkerEntryDecision>();
const treeHashes = new Map<string, string>();
const materialized = new Set<string>();
/**
 * Flags a Worker refused in its execArgv: V8 and process-wide options, such as serve's `--expose-gc`. A worker cannot
 * take them, and needs none: they are in force for the whole process, so a worker started without one still has it.
 */
const refusedWorkerFlags = new Set<string>();
/** A preload in `argv` that only tsx can load (`--import x.ts`), which a bundle-started worker without tsx would die on. */
function typescriptPreload(argv: readonly string[]): string | undefined {
  const isTs = (value: string | undefined): boolean => value !== undefined && /\.[cm]?tsx?$/.test(value);
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at]!;
    if (/^(--import|--loader|--experimental-loader|--require|-r)$/.test(flag) && isTs(argv[at + 1])) return argv[at + 1];
    const joined = /^--(?:import|loader|experimental-loader|require)=(.+)$/.exec(flag)?.[1];
    if (isTs(joined)) return joined;
  }
  return undefined;
}
/** The flags node names in ERR_WORKER_INVALID_EXEC_ARGV, or none when the error is any other. */
function refusedFlagsOf(err: unknown): string[] {
  if ((err as { code?: unknown })?.code !== "ERR_WORKER_INVALID_EXEC_ARGV") return [];
  const named = /invalid execArgv flags: (.+)$/.exec(String((err as Error).message))?.[1];
  return named ? named.split(", ").filter((flag) => flag.startsWith("-")) : [];
}

/** `argv` without tsx's loader flags (`--import tsx`, `--import=…/tsx/…`, `--loader`, `--require`): a bundle needs none. */
export function execArgvWithoutTsx(argv: readonly string[]): string[] {
  const isTsx = (value: string | undefined): boolean => value !== undefined && /(^|[\\/=])tsx($|[\\/])/.test(value);
  const out: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at]!;
    if (/^(--import|--loader|--experimental-loader|--require|-r)$/.test(flag) && isTsx(argv[at + 1])) {
      at++;
      continue;
    }
    if (/^--(import|loader|experimental-loader|require)=/.test(flag) && isTsx(flag)) continue;
    out.push(flag);
  }
  return out;
}

function decide(module: string, root: string, deps: StartWorkerDeps): WorkerEntryDecision {
  const script = (): { workerBundle: NonNullable<StartWorkerDeps["check"]>; sourceHash: (root: string) => string } =>
    createRequire(import.meta.url)("../../scripts/build-child-entries.mjs");
  const check = deps.check ?? ((r, m, o) => script().workerBundle(r, m, o));
  const hashOf = (): string => treeHashes.get(root) ?? (treeHashes.set(root, (deps.hash ?? ((r) => script().sourceHash(r)))(root)), treeHashes.get(root)!);
  let verdict = check(root, module, { treeHash: hashOf() });
  const storeRoot = deps.storeRoot ?? defaultStoreRoot();
  if (!verdict.current && storeRoot !== false && !materialized.has(root)) {
    materialized.add(root);
    const lookup = materializeFromStore(root, storeRoot);
    if (lookup.outcome === "hit") verdict = check(root, module, { treeHash: hashOf() });
    else verdict = { ...verdict, reason: `${verdict.reason}; store ${lookup.reason}` };
  }
  return verdict.current && typeof verdict.bundle === "string"
    ? { kind: "bundle", reason: verdict.reason, url: pathToFileURL(verdict.bundle) }
    : { kind: "tsx", reason: verdict.reason };
}

/**
 * W1-T9370: start the worker a module starts from its own URL (`selfUrl`, its `import.meta.url`). A bundled isolate
 * starts its worker bundle (bundledWorkerUrl). A tsx parent starts the tree's current worker bundle with tsx dropped
 * from the worker's execArgv, decided once per module for the process's life, and the .ts source as before on every
 * doubt: the switch off, no current bundle after one store lookup, a parent that preloads a TypeScript file, a
 * constructor that throws (once it has dropped any
 * flag node names as invalid in a worker, which it retries without), or a bundle-started
 * worker's non-zero exit before its first message, which demotes that module to its source for the rest of the process.
 */
export function startWorker(selfUrl: string | URL, options: WorkerOptions = {}, deps: StartWorkerDeps = {}): Worker {
  const construct = deps.construct ?? ((url: string | URL, opts: WorkerOptions) => new Worker(url, opts));
  if (deps.override) return construct(deps.override, options);
  if (runsBundled()) return construct(bundledWorkerUrl(selfUrl), options);
  const self = new URL(selfUrl);
  const path = fileURLToPath(self);
  const at = path.lastIndexOf(`${sep}src${sep}`);
  if ((deps.env ?? process.env)[BUNDLED_WORKERS_ENV] === "0" || at < 0) return construct(self, options);
  const root = path.slice(0, at);
  const module = relative(root, path).split(sep).join("/");
  let decision = decisions.get(path);
  if (!decision) {
    decision = (() => {
      try {
        return decide(module, root, deps);
      } catch (err) {
        return { kind: "tsx" as const, reason: `decision-failed: ${String((err as Error)?.message ?? err).slice(0, 80)}` };
      }
    })();
    decisions.set(path, decision);
    entryLog?.("worker.entry_resolved", { module, kind: decision.kind, reason: decision.reason });
  }
  // A start node refuses for flags it names is retried once without them; any other refusal demotes the module.
  for (let attempt = 0; decision.kind === "bundle" && decision.url && attempt < 2; attempt++) {
    const execArgv = execArgvWithoutTsx(options.execArgv ?? process.execArgv).filter((flag) => !refusedWorkerFlags.has(flag));
    const preload = typescriptPreload(execArgv);
    if (preload !== undefined) {
      // Never dropped silently: the parent asked every worker to run it, so the worker keeps its source and tsx.
      demote(path, module, `parent-preloads-typescript: ${preload.slice(-80)}`);
      break;
    }
    try {
      const worker = construct(decision.url, { ...options, execArgv });
      // A bundle that cannot load never speaks: a non-zero exit before its first message demotes the module. An exit,
      // not an `error` listener (that would swallow an error the caller never handles); and a lane terminated after
      // it worked (terminate() exits 1) keeps its bundle.
      let spoke = false;
      worker.once("message", () => { spoke = true; });
      worker.once("exit", (code) => { if (code !== 0 && !spoke) demote(path, module, `bundle-worker-exit-before-first-message: ${code}`); });
      return worker;
    } catch (err) {
      const fresh = refusedFlagsOf(err).filter((flag) => execArgv.includes(flag) && !refusedWorkerFlags.has(flag));
      if (attempt === 0 && fresh.length > 0) {
        for (const flag of fresh) refusedWorkerFlags.add(flag);
        continue;
      }
      demote(path, module, `bundle-start-refused: ${String((err as Error)?.message ?? err).slice(0, 80)}`);
      break;
    }
  }
  return construct(self, options);
}

/** Keyed by the module's absolute path: two trees in one process never share a decision. */
function demote(path: string, module: string, reason: string): void {
  if (decisions.get(path)?.kind === "tsx") return;
  decisions.set(path, { kind: "tsx", reason });
  entryLog?.("worker.entry_resolved", { module, kind: "tsx", reason });
}
/**
 * Loaded on demand, not imported: the emitter must still load in a tree that carries src/ but not scripts/
 * (a consumer checkout, test/a-machine-lane-never-opens-a-plan-pr-that-is-already-red.test.ts), where the
 * absent script reads as "no bundle can be vouched for" and the child runs under tsx.
 */
const loadCurrencyCheck = (): CurrencyCheck =>
  (createRequire(import.meta.url)("../../scripts/build-child-entries.mjs") as { childEntryIsCurrent: CurrencyCheck }).childEntryIsCurrent;

export type ChildEntryKind = "bundle" | "tsx";
export interface ChildEntryLaunch {
  /** Arguments for `node`: the bundle path, or `--import <tsx> <source entry>`, then `args`. */
  argv: string[];
  kind: ChildEntryKind;
  /**
   * Why this kind ran: `source-hash-match` for a tree's own bundle, `store-hit` for one copied from the store,
   * otherwise what childEntryIsCurrent gave for the tree.
   */
  reason: string;
  /** W1-T8776: what the store answered, when it was asked (the tree had no current bundle). */
  store?: StoreLookup;
}

/** W1-T8776: where the shared store is and who ledgers its answer. `root: false` never asks it. */
export interface ChildEntryStoreOptions {
  root?: string | false;
  log?: StoreLog;
}

/**
 * The argv that runs child entry `name` for the tree at `root`. A bundle is chosen only when
 * childEntryIsCurrent holds; any other answer, including a thrown one, takes the tsx fallback with the
 * reason, so a corrupt or stale bundle is never executed. tsx is resolved from this package, as
 * checkProofChildArgv does, so a tree without its own node_modules still launches.
 */
export function childEntryArgv(
  root: string,
  name: string,
  sourceEntry: string,
  args: readonly string[],
  /** Seam for the currency judgement; the default loads scripts/build-child-entries.mjs's own childEntryIsCurrent. */
  currencyCheck?: CurrencyCheck,
  /** The shared store; by default this instance's, and never consulted when `currencyCheck` replaces the judgement. */
  store: ChildEntryStoreOptions = {},
  /** W1-T9077: a tree to resolve tsx from (a run child's engine tree); by default this package's own. */
  tsxFrom?: string,
): ChildEntryLaunch {
  const judge = (): ChildEntryCurrency => {
    try {
      return (currencyCheck ?? loadCurrencyCheck())(root, name);
    } catch (err) {
      return { current: false, reason: `currency-check-unavailable: ${String((err as Error)?.message ?? err).slice(0, 80)}` };
    }
  };
  const verdict = judge();
  if (verdict.current && typeof verdict.bundle === "string") {
    return { argv: [verdict.bundle, ...args], kind: "bundle", reason: verdict.reason };
  }
  const storeRoot = store.root ?? (currencyCheck ? false : defaultStoreRoot());
  let lookup: StoreLookup | undefined;
  if (storeRoot !== false && !verdict.reason.startsWith("currency-check-unavailable") && verdict.reason !== "entry-name-invalid") {
    lookup = materializeFromStore(resolve(root), storeRoot);
    // A published copy runs only if the tree's own judgement now holds: any doubt is tsx.
    const after = lookup.outcome === "hit" ? judge() : undefined;
    if (lookup.outcome === "hit" && !(after?.current && typeof after.bundle === "string")) {
      lookup = { outcome: "miss", reason: `materialized-not-current: ${after?.reason}`, hash: lookup.hash };
    }
    store.log?.(lookup.outcome === "hit" ? "child_entry.store_hit" : "child_entry.store_miss", { entry: name, tree_reason: verdict.reason, ...lookup });
    if (lookup.outcome === "hit" && typeof after?.bundle === "string") {
      return { argv: [after.bundle, ...args], kind: "bundle", reason: "store-hit", store: lookup };
    }
  }
  const fromEngine = tsxFrom === undefined ? undefined : resolveTsxFrom(tsxFrom);
  const tsx = fromEngine ?? createRequire(import.meta.url).resolve("tsx");
  const reason = tsxFrom !== undefined && fromEngine === undefined ? `${verdict.reason}; tsx-not-in-engine` : verdict.reason;
  return { argv: ["--import", tsx, resolve(root, sourceEntry), ...args], kind: "tsx", reason, ...(lookup ? { store: lookup } : {}) };
}

/** tsx as the tree at `root` resolves it, or undefined when that tree cannot (no node_modules, or no tsx in it). */
function resolveTsxFrom(root: string): string | undefined {
  try {
    return createRequire(join(resolve(root), "package.json")).resolve("tsx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "MODULE_NOT_FOUND") {
      process.stderr.write(`tsx unresolvable from ${root}: ${String((err as Error)?.message ?? err).slice(0, 120)}\n`);
    }
    return undefined;
  }
}

/** W1-T9077: a launch pinned to an engine tree: where to run it from and which tree that is. */
export interface EngineChildLaunch extends ChildEntryLaunch {
  /** The working directory the child starts in: the engine root, never the daemon's checkout. */
  cwd: string;
  engineRoot: string;
}

/**
 * The argv for a RUN child, which outlives the daemon and so runs from its engine tree (src/lib/engine-tree.ts), not from
 * the daemon's own checkout that sync_tree moves. A current bundle in the engine tree is named by its path inside it;
 * otherwise the child runs the engine's source entry under the tsx the engine tree resolves, and `kind` / `reason` say so.
 */
export function engineChildEntryArgv(
  engineRoot: string,
  name: string,
  sourceEntry: string,
  args: readonly string[],
  currencyCheck?: CurrencyCheck,
  store: ChildEntryStoreOptions = {},
): EngineChildLaunch {
  const root = resolve(engineRoot);
  return { ...childEntryArgv(root, name, sourceEntry, args, currencyCheck, store, root), cwd: root, engineRoot: root };
}

/** W1-T8778: the ledger step both switched spawn sites write, so the bundle share is measurable on the host. */
export const CHILD_ENTRY_SPAWNED_STEP = "child_entry.spawned";

/** The one row shape for {@link CHILD_ENTRY_SPAWNED_STEP}: which entry ran which verb, as which kind, and why. */
export function childEntrySpawnedRow(name: string, verb: string, launch: Pick<ChildEntryLaunch, "kind" | "reason">): Record<string, unknown> {
  return { name, verb, kind: launch.kind, reason: launch.reason };
}

/** This instance's store, or `false` when its config cannot be read: the store is advisory and a miss runs tsx. */
function defaultStoreRoot(): string | false {
  try {
    return defaultChildEntryStoreRoot();
  } catch (err) {
    process.stderr.write(`child-entry store unavailable: ${String((err as Error)?.message ?? err).slice(0, 120)}\n`);
    return false;
  }
}
