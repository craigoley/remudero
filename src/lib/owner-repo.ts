/**
 * Reading THIS checkout's owner/repo from its origin, and the typed failure when it cannot.
 *
 * A separate, PURE module on purpose: `src/lib/repo-location.ts` evaluates `process.argv` at import
 * and its exports are pinned to the argv cluster, so a class a caller needs for `instanceof`, and a
 * root-parameterised reader a test can drive, cannot live there without every importer paying that.
 */
import * as childProcess from "node:child_process";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { RmdError } from "./errors.js";

const execFileAsync = promisify(execFile);

export const OWNER_REPO_REMEDY = "run inside a git checkout, or pass --repo <owner>/<repo> where the command accepts it";

export class OwnerRepoUnresolvableError extends RmdError {
  readonly checkoutRoot: string;
  readonly reason: string;

  constructor(checkoutRoot: string, reason: string) {
    super("git", 1, `no origin remote resolvable at ${checkoutRoot} (${reason}) — ${OWNER_REPO_REMEDY}`, { checkoutRoot, reason });
    this.name = "OwnerRepoUnresolvableError";
    this.checkoutRoot = checkoutRoot;
    this.reason = reason;
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]!.trim();
}

/** Why `git config --get remote.origin.url` failed, in one line. Outside a work tree git exits 1
 *  and says NOTHING, exactly like an unset key, so a bare exit 1 is told apart by asking git
 *  whether `root` is a checkout at all. */
function gitFailureReason(e: unknown, root: string): string {
  const err = e as { stderr?: unknown; status?: unknown; message?: unknown };
  const stderr = firstLine(String(err?.stderr ?? ""));
  if (stderr) return stderr;
  if (err?.status !== 1) return firstLine(String(err?.message ?? e));
  try {
    execFileSync("git", ["-C", root, "rev-parse", "--git-dir"], { stdio: "ignore" });
    return "remote.origin.url is not set";
  } catch {
    // git itself says `root` is no work tree at all, so that is the reason, not an unset key.
    return "not inside a git work tree";
  }
}

/** Owner + repo parsed from the origin url of the checkout at `root`. Any failure to read or parse
 *  it throws {@link OwnerRepoUnresolvableError}. */
export function resolveOwnerRepoAt(root: string): { owner: string; repo: string } {
  const key = originConfigKey(root);
  const memo = key === undefined ? undefined : originMemo.get(resolve(root));
  if (memo !== undefined && memo.key === key && memo.reader === childProcess.execFileSync) return { ...memo.ownerRepo };
  let url: string;
  try {
    url = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    throw new OwnerRepoUnresolvableError(root, gitFailureReason(e, root));
  }
  return remember(root, key, ownerRepoFromOriginUrl(root, url));
}

/** {@link resolveOwnerRepoAt} with its one `git config` read awaited: the same parse and the same typed failure. */
export async function resolveOwnerRepoAtAsync(root: string): Promise<{ owner: string; repo: string }> {
  const key = originConfigKey(root);
  const memo = key === undefined ? undefined : originMemo.get(resolve(root));
  if (memo !== undefined && memo.key === key && memo.reader === childProcess.execFileSync) return { ...memo.ownerRepo };
  let url: string;
  try {
    url = (await execFileAsync("git", ["-C", root, "config", "--get", "remote.origin.url"], { encoding: "utf8" })).stdout.trim();
  } catch (e) {
    // An async exec carries git's exit status as `code`; the sync reader's reason reads it as `status`.
    const err = e as { code?: unknown; stderr?: unknown; message?: unknown };
    throw new OwnerRepoUnresolvableError(root, gitFailureReason({ stderr: err.stderr, status: err.code, message: err.message }, root));
  }
  return remember(root, key, ownerRepoFromOriginUrl(root, url));
}

/**
 * W1-T14753 — each checkout's owner/repo, kept while the config files git reads it from are unchanged. A daemon resolves
 * the same root many times a loop, and each `git config` spawn blocks it (9 s under host contention on 11-24).
 */
// Each entry names the `execFileSync` the module exported when it was read (a reference, never a call): one swapped
// in after the read (a test's mock, published by syncBuiltinESMExports) asks git again instead of reusing the value.
const originMemo = new Map<string, { key: string; reader: unknown; ownerRepo: { owner: string; repo: string } }>();

function remember(root: string, key: string | undefined, ownerRepo: { owner: string; repo: string }): { owner: string; repo: string } {
  if (key !== undefined) originMemo.set(resolve(root), { key, reader: childProcess.execFileSync, ownerRepo: { ...ownerRepo } });
  return ownerRepo;
}

/**
 * The identity (inode, size, mtime, ctime) of the files git reads `remote.origin.url` from for the checkout at `root`: its
 * `.git` entry, the repository's `config` (a worktree's through its gitdir's `commondir`) and any `config.worktree`.
 * Undefined, so the caller spawns git as before, when `root` holds no `.git` entry or a file cannot be read.
 */
function originConfigKey(root: string): string | undefined {
  // The environment can point git elsewhere or add config, so the git variables are part of the key.
  const gitEnv = Object.entries(process.env).filter(([name]) => name.startsWith("GIT_")).sort(([a], [b]) => a.localeCompare(b));
  try {
    const dotGit = join(root, ".git");
    // Read the entry once rather than stat-then-read: a `.git` directory answers EISDIR, a worktree's file its pointer.
    let pointerText: string | undefined;
    try {
      pointerText = readFileSync(dotGit, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EISDIR") throw error;
    }
    let gitDir = dotGit;
    if (pointerText !== undefined) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(pointerText);
      if (!pointer) return undefined;
      gitDir = isAbsolute(pointer[1]!.trim()) ? pointer[1]!.trim() : resolve(root, pointer[1]!.trim());
    }
    let commonDir = gitDir;
    try {
      const named = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      commonDir = isAbsolute(named) ? named : resolve(gitDir, named);
    } catch {
      // No commondir file: the gitdir is the repository's own, so its config is the one git reads.
    }
    return JSON.stringify([identity(dotGit), identity(join(commonDir, "config")), identity(join(gitDir, "config.worktree")), gitEnv]);
  } catch {
    // No `.git` at `root` (a subdirectory, or no checkout) or an unreadable pointer: no memo, git is asked as before.
    return undefined;
  }
}

function identity(path: string): string {
  try {
    const s = statSync(path);
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "absent";
    throw error;
  }
}

function ownerRepoFromOriginUrl(root: string, url: string): { owner: string; repo: string } {
  const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) {
    throw new OwnerRepoUnresolvableError(root, `cannot parse owner/repo from origin url "${url.replace(/\/\/[^/@]*@/, "//")}"`);
  }
  return { owner: m[1], repo: m[2] };
}

/** A caller that catches an arbitrary failure from an injected resolver gets the typed error too. */
export function asOwnerRepoUnresolvable(e: unknown, checkoutRoot: string): OwnerRepoUnresolvableError {
  return e instanceof OwnerRepoUnresolvableError ? e : new OwnerRepoUnresolvableError(checkoutRoot, firstLine(String((e as Error)?.message ?? e)));
}
