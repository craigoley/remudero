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
 *   - Unobserved child-process reads make coverage UNKNOWN, not an empty reusable read set.
 *     Child custom promisifiers are wrapped too while preserving their native output shape.
 */
import fs from "node:fs";
import childProcess from "node:child_process";
import { promisify } from "node:util";
import { devNull } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

export const READ_RECORD_FORMAT = "rmd-read-record-v2";
export const READ_MAP_DIR_ENV = "RMD_READ_MAP_DIR";
export const READ_MAP_ROOT_ENV = "RMD_READ_MAP_ROOT";

/** One test file's record: the non-code paths it read, and the directories it listed. */
export interface ReadRecord {
  format: typeof READ_RECORD_FORMAT;
  suite: string;
  reads: string[];
  listed: string[];
  /** Includes descendants whose file reads this process cannot observe. UNKNOWN is sticky. */
  unknownDescriptors: boolean;
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
  unknown(): void;
  snapshot(): ReadRecord;
}

/** The accumulator behind the patched functions: sets, so a hot read costs one lookup. */
export function createReadRecorder(root: string, suite: string): ReadRecorder {
  const reads = new Set<string>();
  const listed = new Set<string>();
  let unknownDescriptors = false;
  return {
    read(raw) {
      const rel = repoRelative(raw, root);
      if (rel !== undefined && !CODE_FILE.test(rel)) reads.add(rel);
    },
    list(raw, recursive = false) {
      const rel = repoRelative(raw, root);
      if (rel !== undefined) listed.add(recursive ? `${rel === "." ? "" : `${rel}/`}**` : rel);
    },
    unknown: () => { unknownDescriptors = true; },
    snapshot: () => ({ format: READ_RECORD_FORMAT, suite, reads: [...reads].sort(), listed: [...listed].sort(), unknownDescriptors }),
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
const READERS = ["readFileSync", "readFile", "existsSync", "statSync", "stat", "lstatSync", "lstat", "accessSync", "access", "readlinkSync", "readlink", "realpathSync", "realpath", "openAsBlob"] as const;
const LISTERS = ["readdirSync", "readdir", "opendir", "opendirSync"] as const;
const PROMISE_READERS = ["readFile", "stat", "lstat", "access", "readlink", "realpath"] as const;
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
      return Reflect.apply(original, table, args);
    }) as AnyFn);
    table[name] = wrapper;
    undo.push(() => {
      table[name] = original;
    });
  }
}

/** Patches `target`'s read and listing entry points to feed `recorder`. Returns the undo. */
export function patchFsForReadMap(recorder: ReadRecorder, target: { promises?: unknown } = fs, handlePrototype?: object): () => void {
  const undo: Array<() => void> = [];
  const descriptors = new Map<number, { path: unknown; identity: string }>();
  const identity = (fd: number): string => {
    const stat = nativeFstat(fd, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  };
  const observe = (fn: () => void) => { try { fn(); } catch { recorder.unknown(); } };
  const read = (raw: unknown) => observe(() => {
    const fd = typeof raw === "number" ? raw : handlePrototype && raw !== null && typeof raw === "object" &&
      handlePrototype.isPrototypeOf(raw) ? (raw as { fd: number }).fd : undefined;
    if (fd === undefined) { recorder.read(raw); return; }
    const entry = descriptors.get(fd);
    if (!entry || entry.identity !== identity(fd)) { descriptors.delete(fd); recorder.unknown(); return; }
    recorder.read(entry.path);
  });
  const track = (fd: number, path: unknown) => observe(() => {
    if (descriptors.size >= 4096) { descriptors.clear(); recorder.unknown(); }
    descriptors.set(fd, { path, identity: identity(fd) });
  });
  const absolute = (raw: unknown) => typeof raw === "string" ? resolve(raw) : Buffer.isBuffer(raw) ? resolve(raw.toString("utf8")) : raw;
  const wrap = (table: Patchable, name: string, run: (original: AnyFn, receiver: unknown, args: unknown[]) => unknown) => {
    const original = table[name];
    if (typeof original !== "function") return;
    const wrapper = preserveProperties(original as AnyFn, function (this: unknown, ...args: unknown[]) {
      return run(original as AnyFn, this, args);
    });
    table[name] = wrapper;
    undo.push(() => { table[name] = original; });
  };
  const table = target as Patchable;
  wrap(table, "openSync", (original, receiver, args) => {
    const path = absolute(args[0]); read(path);
    const fd = Reflect.apply(original, receiver, args) as number; track(fd, path); return fd;
  });
  wrap(table, "open", (original, receiver, args) => {
    const path = absolute(args[0]); read(path);
    const callback = args.at(-1);
    if (typeof callback !== "function") return Reflect.apply(original, receiver, args);
    args[args.length - 1] = function (this: unknown, ...result: unknown[]) {
      if (result[0] == null && typeof result[1] === "number") track(result[1], path);
      return Reflect.apply(callback, this, result);
    };
    return Reflect.apply(original, receiver, args);
  });
  wrap(table, "closeSync", (original, receiver, args) => {
    const result = Reflect.apply(original, receiver, args); descriptors.delete(args[0] as number); return result;
  });
  wrap(table, "close", (original, receiver, args) => {
    // Forget before an asynchronous close: a failed close becomes conservative UNKNOWN, not a stale fd alias.
    descriptors.delete(args[0] as number); return Reflect.apply(original, receiver, args);
  });
  wrap(table, "createReadStream", (original, receiver, args) => {
    const options = args[1];
    let fd: number | undefined;
    let entry: { path: unknown; identity: string } | undefined;
    observe(() => {
      if (options !== null && typeof options === "object" && "fs" in options) recorder.unknown();
      if (options !== null && typeof options === "object" && "fd" in options) {
        const property = Object.getOwnPropertyDescriptor(options, "fd");
        if (!property || !Object.hasOwn(property, "value")) recorder.unknown();
        else if (property.value != null) {
          read(property.value);
          fd = typeof property.value === "number" ? property.value : property.value.fd;
          entry = descriptors.get(fd!);
        }
        else read(args[0]);
      } else read(args[0]);
    });
    const stream = Reflect.apply(original, receiver, args) as fs.ReadStream;
    stream.once("close", () => { if (fd !== undefined && descriptors.get(fd) === entry) descriptors.delete(fd); });
    return stream;
  });
  patchTable(table, ["read", "readSync", "readv", "readvSync", "fstat", "fstatSync"], args => read(args[0]), undo);
  const hooks = (readers: readonly string[], listers: readonly string[], table: Patchable) => {
    patchTable(table, readers, (args) => read(args[0]), undo);
    patchTable(table, listers, (args) => recorder.list(args[0], recursiveOption(args[1])), undo);
  };
  hooks(READERS, LISTERS, target as Patchable);
  if (typeof target.promises === "object" && target.promises !== null) {
    hooks(PROMISE_READERS, PROMISE_LISTERS, target.promises as Patchable);
    wrap(target.promises as Patchable, "open", (original, receiver, args) => {
      const path = absolute(args[0]); read(path);
      return (Reflect.apply(original, receiver, args) as Promise<{ fd: number; once: (event: string, fn: () => void) => void }>).then(handle => {
        const fd = handle.fd; track(fd, path); const entry = descriptors.get(fd);
        handle.once("close", () => { if (descriptors.get(fd) === entry) descriptors.delete(fd); });
        return handle;
      });
    });
  }
  if (handlePrototype) for (const name of ["read", "readv", "readFile", "stat", "readLines", "createReadStream", "readableWebStream"]) {
    wrap(handlePrototype as Patchable, name, (original, receiver, args) => { read(receiver); return Reflect.apply(original, receiver, args); });
  }
  else if (target === fs) recorder.unknown();
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
const nativeFstat = fs.fstatSync;
const nativeOpen = fs.promises.open;

/** Installs the hook for `suite`, recording into `dir`. */
export async function installReadMap(opts: { dir: string; root: string; suite: string; target?: { promises?: unknown } }): Promise<ReadMapHandle> {
  const recorder = createReadRecorder(opts.root, opts.suite);
  let handlePrototype: object | undefined;
  if (opts.target === undefined || opts.target === fs) {
    const probe = await nativeOpen(devNull, "r");
    try { handlePrototype = Object.getPrototypeOf(probe) as object; } finally { await probe.close(); }
  }
  const restoreFs = patchFsForReadMap(recorder, opts.target, handlePrototype);
  const childUndo: Array<() => void> = [];
  const realFs = opts.target === undefined || opts.target === fs;
  if (realFs) {
    // Observing a launch does not observe its reads. Do not credit an empty parent read set to a
    // descendant, forward preloads/credentials, or infer what an executable is going to read.
    const table = childProcess as unknown as Patchable;
    for (const name of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]) {
      const original = table[name];
      if (typeof original !== "function") { recorder.unknown(); continue; }
      const marked = (fn: AnyFn): AnyFn => function (this: unknown, ...args: unknown[]) {
        recorder.unknown();
        return Reflect.apply(fn, this, args);
      };
      const wrapper = marked(original as AnyFn);
      // Node's custom promisifier closes over the native function, bypassing a plain API wrapper.
      // Preserve its flags and output shape, but wrap its call too; identity cannot stay native.
      for (const key of Reflect.ownKeys(original)) {
        const property = Object.getOwnPropertyDescriptor(original, key)!;
        // Define a native non-configurable custom descriptor only ONCE on the new function.
        if (key === promisify.custom && typeof property.value === "function") property.value =
          preserveProperties(property.value as AnyFn, marked(property.value as AnyFn));
        Object.defineProperty(wrapper, key, property);
      }
      table[name] = wrapper;
      childUndo.push(() => { table[name] = original; });
    }
    syncBuiltinESMExports();
  }
  const file = join(opts.dir, recordFileName(opts.suite));
  return {
    recorder,
    restore: () => {
      for (const restore of childUndo.reverse()) restore();
      restoreFs();
      if (realFs) syncBuiltinESMExports();
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
          unknownDescriptors: own.unknownDescriptors || before.format !== READ_RECORD_FORMAT || before.unknownDescriptors !== false,
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
export async function installReadMapFromEnv(env: NodeJS.ProcessEnv = process.env, entry: string | undefined = process.argv[1]): Promise<ReadMapHandle | undefined> {
  const dir = env[READ_MAP_DIR_ENV];
  if (dir === undefined || dir === "" || !isMainThread) return undefined;
  const root = env[READ_MAP_ROOT_ENV] ?? process.cwd();
  const suite = suiteOfEntry(entry, root);
  if (suite === undefined) return undefined;
  const handle = await installReadMap({ dir, root, suite });
  process.on("exit", () => {
    handle.restore();
    handle.flush();
  });
  return handle;
}
