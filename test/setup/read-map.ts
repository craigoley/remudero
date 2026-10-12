/**
 * test/setup/read-map.ts — W1-T6084: EACH TEST FILE RECORDS THE NON-CODE FILES IT READS.
 *
 * Which suites a change to `openapi/`, `deploy/` or a json file reaches was GUESSED from source text
 * (`enumeratesPopulation`, `sourceTextPathsRead` in scripts/diff-class.mjs) or answered with a full run.
 * This hook OBSERVES it: when `RMD_READ_MAP_DIR` is set, every fs read entry point below records the
 * repo-relative NON-CODE path it was handed, per test FILE, and the file's record is written at exit.
 * src/lib/affected-suites.ts merges the records into one read map and selects from it.
 *
 *   - A read of a file records the path (code files — `.ts`, `.mjs`, … — are the import graph's, not
 *     this map's). A directory LISTING records the directory, so a suite that walks a tree is a census
 *     reader of every file in it; `{ recursive: true }` records `dir/**`, because one call walks the
 *     whole subtree.
 *   - It is a NO-OP when `RMD_READ_MAP_DIR` is unset (one property read), in a worker thread, and in a
 *     process whose entry file is not a `test/**.test.ts` suite (a spawned child is credited to nobody).
 *   - A patched function keeps EVERY own property of the original — `name`, `length`, and the
 *     `util.promisify.custom` symbol — so a promisified caller still gets the original's shape.
 *     Dropping that symbol is the falsifier: `promisify(fn)` would fall back to the callback
 *     convention and resolve the wrong shape for a function that defines its own.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

export const READ_RECORD_FORMAT = "rmd-read-record-v1";
export const READ_MAP_DIR_ENV = "RMD_READ_MAP_DIR";
export const READ_MAP_ROOT_ENV = "RMD_READ_MAP_ROOT";

/** One test file's record: the non-code paths it read, and the directories it listed. */
export interface ReadRecord {
  format: typeof READ_RECORD_FORMAT;
  suite: string;
  reads: string[];
  listed: string[];
}

const CODE_FILE = /\.(?:ts|mts|cts|mjs|js|cjs)$/;
const SUITE = /^test\/.*\.test\.ts$/;

/** The repo-relative form of a path an fs call was handed, or undefined when it is not a repo path
 *  worth recording: a file descriptor, a non-file URL, anything outside `root`, node_modules, .git. */
export function repoRelative(raw: unknown, root: string, cwd: string = process.cwd()): string | undefined {
  let abs: string | undefined;
  if (typeof raw === "string") abs = raw;
  else if (Buffer.isBuffer(raw)) abs = raw.toString("utf8");
  else if (raw instanceof URL) abs = raw.protocol === "file:" ? fileURLToPath(raw) : undefined;
  if (abs === undefined || abs === "") return undefined;
  const rel = relative(root, resolve(cwd, abs)).split(sep).join("/");
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return undefined;
  if (/^(?:node_modules|\.git)(?:\/|$)/.test(rel)) return undefined;
  return rel;
}

export interface ReadRecorder {
  read(raw: unknown): void;
  list(raw: unknown, recursive?: boolean): void;
  snapshot(): ReadRecord;
}

/** The accumulator behind the patched functions: sets, so a hot read costs one lookup. */
export function createReadRecorder(root: string, suite: string): ReadRecorder {
  const reads = new Set<string>();
  const listed = new Set<string>();
  return {
    read(raw) {
      const rel = repoRelative(raw, root);
      if (rel !== undefined && !CODE_FILE.test(rel)) reads.add(rel);
    },
    list(raw, recursive = false) {
      const rel = repoRelative(raw, root);
      if (rel !== undefined) listed.add(recursive ? `${rel === "." ? "" : `${rel}/`}**` : rel);
    },
    snapshot: () => ({ format: READ_RECORD_FORMAT, suite, reads: [...reads].sort(), listed: [...listed].sort() }),
  };
}

type AnyFn = (...args: unknown[]) => unknown;

/** `wrapper`, carrying every own property of `original` — string AND symbol keys — so the patched
 *  function is indistinguishable by identity properties (`util.promisify.custom` above all). */
export function preserveProperties<F extends AnyFn>(original: F, wrapper: F): F {
  for (const key of Reflect.ownKeys(original)) {
    Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(original, key)!);
  }
  return wrapper;
}

function recursiveOption(options: unknown): boolean {
  return typeof options === "object" && options !== null && (options as { recursive?: unknown }).recursive === true;
}

/** Entry points that READ a path, and those that LIST a directory, on `fs` and on `fs.promises`. */
const READERS = ["readFileSync", "readFile", "existsSync", "statSync"] as const;
const LISTERS = ["readdirSync", "readdir", "opendir", "opendirSync"] as const;
const PROMISE_READERS = ["readFile", "stat"] as const;
const PROMISE_LISTERS = ["readdir", "opendir"] as const;

type Patchable = Record<string, unknown>;

function patchTable(
  table: Patchable, names: readonly string[], onCall: (args: unknown[]) => void, undo: Array<() => void>,
): void {
  for (const name of names) {
    const original = table[name];
    if (typeof original !== "function") continue;
    const wrapper = preserveProperties(original as AnyFn, ((...args: unknown[]) => {
      onCall(args);
      return Reflect.apply(original, undefined, args);
    }) as AnyFn);
    table[name] = wrapper;
    undo.push(() => {
      table[name] = original;
    });
  }
}

/** Patches `target`'s read and listing entry points to feed `recorder`. Returns the undo. */
export function patchFsForReadMap(recorder: ReadRecorder, target: { promises?: unknown } = fs): () => void {
  const undo: Array<() => void> = [];
  const hooks = (readers: readonly string[], listers: readonly string[], table: Patchable) => {
    patchTable(table, readers, (args) => recorder.read(args[0]), undo);
    patchTable(table, listers, (args) => recorder.list(args[0], recursiveOption(args[1])), undo);
  };
  hooks(READERS, LISTERS, target as Patchable);
  if (typeof target.promises === "object" && target.promises !== null) {
    hooks(PROMISE_READERS, PROMISE_LISTERS, target.promises as Patchable);
  }
  return () => {
    for (const restore of undo.reverse()) restore();
  };
}

/** The suite a process is running: its entry file, when that is a `test/**.test.ts` under `root`. */
export function suiteOfEntry(entry: string | undefined, root: string): string | undefined {
  const rel = entry === undefined ? undefined : repoRelative(entry, root);
  return rel !== undefined && SUITE.test(rel) ? rel : undefined;
}

/** The record file one suite writes inside the records directory. */
export function recordFileName(suite: string): string {
  return `${suite.split("/").join("__")}.json`;
}

export interface ReadMapHandle {
  recorder: ReadRecorder;
  /** Writes the record (merged with one a retry of the same file already wrote) and returns its path. */
  flush(): string;
  restore(): void;
}

// Captured BEFORE any patch: the record write must never be recorded, nor can it recurse.
const writeFileSync = fs.writeFileSync;
const readFileSync = fs.readFileSync;
const mkdirSync = fs.mkdirSync;
const existsSync = fs.existsSync;

/** Installs the hook for `suite`, recording into `dir`. */
export function installReadMap(opts: { dir: string; root: string; suite: string; target?: { promises?: unknown } }): ReadMapHandle {
  const recorder = createReadRecorder(opts.root, opts.suite);
  const restore = patchFsForReadMap(recorder, opts.target);
  if (opts.target === undefined) syncBuiltinESMExports();
  const file = join(opts.dir, recordFileName(opts.suite));
  return {
    recorder,
    restore: () => {
      restore();
      if (opts.target === undefined) syncBuiltinESMExports();
    },
    flush() {
      const own = recorder.snapshot();
      let merged = own;
      if (existsSync(file)) {
        // A retry pass re-runs the same file in a fresh process: keep what the first pass saw too.
        const before = JSON.parse(readFileSync(file, "utf8")) as Partial<ReadRecord>;
        merged = {
          ...own,
          reads: [...new Set([...(before.reads ?? []), ...own.reads])].sort(),
          listed: [...new Set([...(before.listed ?? []), ...own.listed])].sort(),
        };
      }
      mkdirSync(opts.dir, { recursive: true });
      writeFileSync(file, `${JSON.stringify(merged)}\n`);
      return file;
    },
  };
}

/** The preload's entry: a no-op unless `RMD_READ_MAP_DIR` is set, this is the main thread, and the
 *  process's entry file is a test suite. Flushes the record at process exit. */
export function installReadMapFromEnv(env: NodeJS.ProcessEnv = process.env, entry: string | undefined = process.argv[1]): ReadMapHandle | undefined {
  const dir = env[READ_MAP_DIR_ENV];
  if (dir === undefined || dir === "" || !isMainThread) return undefined;
  const root = env[READ_MAP_ROOT_ENV] ?? process.cwd();
  const suite = suiteOfEntry(entry, root);
  if (suite === undefined) return undefined;
  const handle = installReadMap({ dir, root, suite });
  process.on("exit", () => {
    handle.restore();
    handle.flush();
  });
  return handle;
}
