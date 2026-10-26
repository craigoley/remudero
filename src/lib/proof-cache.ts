/** Proof-owned Vitest 5 module caches. Every invocation starts empty; shared installs stay untouched. */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";

export const FS_MODULE_CACHE_MIN_MAJOR = 5;
export const PROOF_CACHE_DIR_PREFIX = ".rmd-vitest-cache-";
export const PROOF_CACHE_OWNER_FILE = ".rmd-proof-cache-owner";

export type ProofCacheCapability =
  | { supported: true; version: string; installIdentity: string }
  | { supported: false; required: boolean; reason: string };

/** Match the installed runner to the checkout's exact lockfile pin before applying the documented 5.x flag. */
export function vitestCacheCapability(cwd: string): ProofCacheCapability {
  try {
    const manifest = readFileSync(join(cwd, "node_modules/vitest/package.json"), "utf8");
    const version: unknown = JSON.parse(manifest).version;
    if (typeof version !== "string") return { supported: false, required: true, reason: "installed Vitest metadata carries no version" };
    const match = /^(\d+)\.\d+\.\d+$/.exec(version);
    if (match === null) return { supported: false, required: true, reason: "installed Vitest version is not parseable" };
    const pkg = readFileSync(join(cwd, "package.json"), "utf8");
    const lock = readFileSync(join(cwd, "package-lock.json"), "utf8");
    const pinned: unknown = JSON.parse(lock).packages?.["node_modules/vitest"]?.version;
    if (pinned !== version) return { supported: false, required: true, reason: "installed Vitest does not match the checkout lockfile pin" };
    if (Number(match[1]) < FS_MODULE_CACHE_MIN_MAJOR) return { supported: false, required: false, reason: "pinned Vitest predates the persistent module cache" };
    if (Number(match[1]) !== FS_MODULE_CACHE_MIN_MAJOR) return { supported: false, required: true, reason: "installed Vitest cache capability is outside the reviewed 5.x contract" };
    const cli = readFileSync(join(cwd, "node_modules/vitest/vitest.mjs"));
    const installIdentity = createHash("sha256").update(pkg).update("\0").update(lock).update("\0").update(manifest).update("\0").update(cli).digest("hex");
    return { supported: true, version, installIdentity };
  } catch (error) {
    return { supported: false, required: true, reason: "installed Vitest capability unreadable (" + errorCode(error) + ")" };
  }
}

/** The supported shared layouts link either node_modules or its Vitest package to a borrowed installation. */
export function hasSharedInstall(cwd: string): boolean {
  return ["node_modules", "node_modules/vitest"].some(path => lstatSync(join(cwd, path), { throwIfNoEntry: false })?.isSymbolicLink() === true);
}

export interface ProofCacheRelease { released: boolean; error?: string }
export interface ProofCache {
  kind: "owned";
  readonly path: string;
  readonly args: readonly string[];
  readonly identity: string;
  release(): ProofCacheRelease;
}
export type ProofCachePreparation = ProofCache
  | { kind: "ordinary"; reason: string }
  | { kind: "unavailable"; reason: string; cleanup?: ProofCacheRelease };
export interface ProofCacheInput {
  cwd: string;
  /** Actual scoped proof argv and label; source root, runner bytes and lockfile are bound below. */
  identity: readonly string[];
}

export class ProofCacheUnavailableError extends RmdError {
  constructor(reason: string) { super("usage", GENERIC_EXIT_CODE, "proof cache unavailable: " + reason); }
}

const errorCode = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.message.slice(0, 160) : "unknown error";
};
export function proofCacheIdentity(identity: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
}
const sameDirectory = (a: Stats, b: Stats): boolean => b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;

/** Never merge a failed shared-cache preparation into the ordinary-install path. */
export function createProofCache(input: ProofCacheInput, deps: Partial<Pick<typeof import("node:fs"), "mkdtempSync" | "rmSync" | "writeFileSync">> = {}): ProofCachePreparation {
  let cwd: string;
  let capability: ProofCacheCapability;
  try {
    const modules = lstatSync(join(input.cwd, "node_modules"));
    if (!modules.isDirectory() && !modules.isSymbolicLink()) return { kind: "unavailable", reason: "node_modules is not a directory or shared link" };
    if (!hasSharedInstall(input.cwd)) return { kind: "ordinary", reason: "ordinary install keeps its own cache" };
    cwd = realpathSync(input.cwd);
    capability = vitestCacheCapability(input.cwd);
  } catch (error) {
    return { kind: "unavailable", reason: "shared install cannot be inspected (" + errorCode(error) + ")" };
  }
  if (!capability.supported) return capability.required ? { kind: "unavailable", reason: capability.reason } : { kind: "ordinary", reason: capability.reason };
  const identity = proofCacheIdentity([cwd, capability.version, capability.installIdentity, ...input.identity]);
  const marker = JSON.stringify({ token: randomBytes(12).toString("hex"), identity, version: capability.version });
  const remove = (path: string) => (deps.rmSync ?? rmSync)(path, { recursive: true, force: true });
  let path: string | undefined;
  let owner: Stats | undefined;
  let markerWritten = false;
  const release = (): ProofCacheRelease => {
    if (path === undefined) return { released: true };
    if (owner === undefined) return { released: false, error: "cache scratch ownership was not established" };
    try {
      if (dirname(path) !== cwd || !basename(path).startsWith(PROOF_CACHE_DIR_PREFIX + identity + "-")) throw new Error("cache directory ownership changed");
      // Open directly (no prior stat of the path) and judge everything on that one no-follow handle;
      // a missing entry surfaces as ENOENT from the open itself rather than from a test-then-use gap.
      let markerError: unknown;
      if (markerWritten) {
        try {
          const fd = openSync(join(path, PROOF_CACHE_OWNER_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const info = fstatSync(fd);
            if (!info.isFile() || info.uid !== owner.uid || info.nlink !== 1 || info.size > 1024 || readFileSync(fd, "utf8") !== marker) throw new Error("cache owner marker changed");
          } finally { closeSync(fd); }
        } catch (error) { markerError = error; }
      }
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (current === undefined) return { released: true };
      if (!sameDirectory(owner, current)) throw new Error("cache directory ownership changed");
      if (markerError !== undefined) throw markerError;
      remove(path);
      if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) throw new Error("cache cleanup did not remove its owned directory");
      return { released: true };
    } catch (error) { return { released: false, error: errorCode(error) }; }
  };
  try {
    path = (deps.mkdtempSync ?? mkdtempSync)(join(cwd, PROOF_CACHE_DIR_PREFIX + identity + "-"));
    if (dirname(path) !== cwd || !basename(path).startsWith(PROOF_CACHE_DIR_PREFIX + identity + "-")) throw new Error("cache scratch is outside the owned checkout");
    const created = lstatSync(path);
    if (!created.isDirectory() || created.isSymbolicLink() || (created.mode & 0o077) !== 0 || (process.getuid !== undefined && created.uid !== process.getuid()) || readdirSync(path).length !== 0) throw new Error("cache scratch is not a fresh private directory");
    owner = created;
    (deps.writeFileSync ?? writeFileSync)(join(path, PROOF_CACHE_OWNER_FILE), marker, { mode: 0o600, flag: "wx" });
    markerWritten = true;
  } catch (error) {
    return { kind: "unavailable", reason: "proof cache scratch unavailable (" + errorCode(error) + ")", cleanup: release() };
  }
  return { kind: "owned", path, identity, args: ["--fsModuleCachePath=" + path], release };
}
