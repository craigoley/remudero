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
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  const tsx = createRequire(import.meta.url).resolve("tsx");
  return { argv: ["--import", tsx, resolve(root, sourceEntry), ...args], kind: "tsx", reason: verdict.reason, ...(lookup ? { store: lookup } : {}) };
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
