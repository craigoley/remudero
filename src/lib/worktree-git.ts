import { execFile, execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";

/**
 * W1-T6106 — THE ONE WAY HOST CODE RUNS GIT WITH A WORKER WORKTREE AS ITS REPOSITORY.
 *
 * A bare `git -C <worktree>` reads two things the worker can write: the worktree's `.git` POINTER
 * FILE (a one-line `gitdir:` that git follows to whatever repository it names, config and all) and,
 * through `core.hooksPath=hooks`, the worktree's TRACKED hooks/ directory. Either route runs code the
 * model wrote as the daemon, with its push credentials, outside the worker sandbox.
 *
 * So every call through here:
 *   1. PINS the repository. `GIT_DIR` is the gitdir `worktreeAdd` RECORDED in the worktree's sibling
 *      base record when it cut the worktree, and `GIT_WORK_TREE` the worktree; git then never reads
 *      the pointer. The pointer is still CHECKED, and a pointer that no longer names the recorded
 *      gitdir is refused before git runs ({@link WorktreePointerRefusedError}).
 *   2. DISABLES code-executing config at command-line precedence (`GIT_CONFIG_COUNT`, the env form of
 *      `-c`, which every nested git a hook spawns inherits too): {@link HOST_GIT_CONFIG}. Hooks run
 *      from the HARNESS's own {@link HOST_HOOKS_DIR} only, never the worktree's.
 *   3. adds `--no-ext-diff --no-textconv` to every diff-producing subcommand.
 *
 * WHAT IT DELIBERATELY KEEPS: system and global config, and the pinned gitdir's own config. Those are
 * daemon-owned files outside the worktree — the global one carries the fleet's credential helper and
 * the pinned `config.worktree` the per-worktree socket helper (W1-T2699) — so pushes authenticate
 * exactly as before. Repo-local config is reachable by a worker only through the pointer, which (1)
 * refuses.
 */

/** The harness's own code root (this module lives in `src/lib/`). */
const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The hooks a host git call may run: the harness's copy, holding only the W1-T4614 assignment
 *  trailer step. Never the worktree's tracked hooks/. */
export const HOST_HOOKS_DIR = join(HARNESS_ROOT, "hooks", "host");

/** The harness's own copy of the repo gates (`hooks/pre-push`), which the push leaf runs itself.
 *  `RMD_HARNESS_HOOKS_DIR` replaces it for a fixture; it is daemon environment, never worker input. */
export function harnessHooksDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RMD_HARNESS_HOOKS_DIR || join(HARNESS_ROOT, "hooks");
}

/** Config that executes a program, set at command-line precedence on every host call. */
export const HOST_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", HOST_HOOKS_DIR],
  ["core.sshCommand", "ssh"],
  ["core.pager", "cat"],
  ["protocol.ext.allow", "never"],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
];

/** Subcommands whose output can run diff.external or a textconv driver. */
const DIFF_SUBCOMMANDS = new Set(["diff", "show", "log"]);

/** Inherited variables that would redirect the repository or the config this leaf pins. */
const REDIRECTING_ENV = /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|EXTERNAL_DIFF)$/;

/** The base record line naming the gitdir `worktreeAdd` cut (`<worktree>.base`, after the base sha). */
export const GITDIR_RECORD_PREFIX = "gitdir: ";

/** The sibling record `worktreeAdd` writes for each worktree it creates — outside the working tree. */
export function worktreeRecordPath(worktreePath: string): string {
  return `${worktreePath}.base`;
}

/** The gitdir `worktreeAdd` recorded for `worktreePath`, or null when it recorded none. */
export function recordedWorktreeGitDir(worktreePath: string): string | null {
  let text: string;
  try {
    text = readFileSync(worktreeRecordPath(worktreePath), "utf8");
  } catch {
    // No record: a worktree this harness did not cut (or cut before W1-T6106) — pinWorktreeGit's
    // unrecorded arm validates the pointer structurally instead.
    return null;
  }
  const line = text.split("\n").find((l) => l.startsWith(GITDIR_RECORD_PREFIX));
  return line === undefined ? null : line.slice(GITDIR_RECORD_PREFIX.length).trim() || null;
}

export interface PinnedWorktreeGit {
  worktree: string;
  gitDir: string;
  /** How the gitdir was established: the worktreeAdd record, a validated unrecorded pointer, or a
   *  plain repository whose `.git` is a directory. */
  source: "recorded" | "unrecorded-pointer" | "git-directory";
}

/** A `.git` entry that no longer resolves to the gitdir the harness cut. Nothing ran. */
export class WorktreePointerRefusedError extends RmdError {
  constructor(readonly worktree: string, readonly recordedGitDir: string | null, readonly observed: string, reason: string) {
    super("git", GENERIC_EXIT_CODE,
      `worktree-git: refusing a host git call into ${worktree}: ${reason} (recorded gitdir ` +
        `${recordedGitDir ?? "<none>"}, .git entry ${observed}) — nothing was run (W1-T6106)`,
      { worktree, recordedGitDir, observed });
    this.name = "WorktreePointerRefusedError";
  }
}

export type WorktreeGitLog = (step: string, extra: Record<string, unknown>) => void;

/** The default refusal row: one JSON line on stderr, the shape `worker.assignment_stamp_failed` uses. */
const stderrLog: WorktreeGitLog = (step, extra) => console.error(JSON.stringify({ event: step, ...extra }));

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    // An absent target cannot be the recorded gitdir; the caller refuses on undefined.
    return undefined;
  }
}

/**
 * Establish the repository a host git call into `worktreePath` must use, never trusting the
 * worktree's own `.git` entry beyond checking it. Throws {@link WorktreePointerRefusedError}
 * (after one `worktree_git.pointer_refused` row) when the entry does not resolve to it.
 */
export function pinWorktreeGit(worktreePath: string, log: WorktreeGitLog = stderrLog): PinnedWorktreeGit {
  const worktree = resolve(worktreePath);
  const recorded = recordedWorktreeGitDir(worktree);
  const dotGit = join(worktree, ".git");
  const refuse = (observed: string, reason: string): never => {
    log("worktree_git.pointer_refused", { worktree, recorded_git_dir: recorded, observed, reason });
    throw new WorktreePointerRefusedError(worktree, recorded, observed, reason);
  };
  let kind: "file" | "directory" | "other";
  try {
    const st = lstatSync(dotGit);
    kind = st.isFile() ? "file" : st.isDirectory() ? "directory" : "other";
  } catch {
    return refuse("<absent>", "the worktree has no .git entry");
  }
  if (kind === "other") return refuse(dotGit, "the .git entry is neither a pointer file nor a directory");
  if (kind === "directory") {
    if (recorded !== null) return refuse(dotGit, "the .git pointer file was replaced by a directory");
    return { worktree, gitDir: dotGit, source: "git-directory" };
  }
  const match = /^gitdir: (.+)\n?$/.exec(readFileSync(dotGit, "utf8"));
  if (!match) return refuse(dotGit, "the .git file is not a single gitdir: line");
  const pointed = resolve(worktree, match[1]!);
  const pointedReal = real(pointed);
  if (recorded !== null) {
    if (pointedReal === undefined || pointedReal !== real(recorded)) {
      return refuse(pointed, "the .git pointer no longer names the gitdir worktreeAdd recorded");
    }
    return { worktree, gitDir: recorded, source: "recorded" };
  }
  // UNRECORDED: no anchor, so require the shape `git worktree add` itself produces — a gitdir OUTSIDE
  // the working tree that names this worktree back. A gitdir planted inside the worktree fails here.
  const worktreeReal = real(worktree) ?? worktree;
  if (pointedReal === undefined || within(worktreeReal, pointedReal)) {
    return refuse(pointed, "an unrecorded .git pointer names a gitdir inside the worktree or none at all");
  }
  let back: string | undefined;
  try {
    back = real(resolve(pointedReal, readFileSync(join(pointedReal, "gitdir"), "utf8").trim()));
  } catch {
    // An unreadable back-pointer is not a match; refused below with the same reason.
    back = undefined;
  }
  if (back !== real(dotGit)) return refuse(pointed, "an unrecorded gitdir does not name this worktree back");
  return { worktree, gitDir: pointedReal, source: "unrecorded-pointer" };
}

/** The environment for a pinned call: the caller's variables, then the pin and the config overrides,
 *  which nothing a caller passes can replace. */
export function hostWorktreeGitEnv(pin: PinnedWorktreeGit, extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!REDIRECTING_ENV.test(k)) env[k] = v;
  Object.assign(env, extra);
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$|^GIT_EXTERNAL_DIFF$/.test(k)) delete env[k];
  env.GIT_DIR = pin.gitDir;
  env.GIT_WORK_TREE = pin.worktree;
  env.GIT_CONFIG_COUNT = String(HOST_GIT_CONFIG.length);
  HOST_GIT_CONFIG.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** `args` with `--no-ext-diff --no-textconv` after a diff-producing subcommand. */
export function hardenedGitArgs(args: readonly string[]): string[] {
  const [sub, ...rest] = args;
  return sub !== undefined && DIFF_SUBCOMMANDS.has(sub) ? [sub, "--no-ext-diff", "--no-textconv", ...rest] : [...args];
}

export interface HostWorktreeGitOptions {
  /** Extra variables (GIT_INDEX_FILE, GIT_OPTIONAL_LOCKS…); the pin and the overrides win over them. */
  env?: NodeJS.ProcessEnv;
  /** `pipe` (default) returns stdout; `inherit-stdout` streams it; `ignore` discards both streams. */
  stdio?: "pipe" | "inherit-stdout" | "ignore";
  maxBuffer?: number;
  input?: string;
  log?: WorktreeGitLog;
}

function spawnOptions(pin: PinnedWorktreeGit, opts: HostWorktreeGitOptions) {
  const stdio = opts.stdio === "ignore" ? "ignore" as const
    : opts.stdio === "inherit-stdout" ? ["pipe", "inherit", "pipe"] as ["pipe", "inherit", "pipe"]
    : ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"];
  return {
    encoding: "utf8" as const,
    env: hostWorktreeGitEnv(pin, opts.env),
    stdio,
    ...(opts.maxBuffer === undefined ? {} : { maxBuffer: opts.maxBuffer }),
    ...(opts.input === undefined ? {} : { input: opts.input }),
  };
}

/** `["-C", <worktree>, …args]` — `-C` only sets the cwd here (the env pins the repository), and keeps
 *  the `Command failed: git -C <wt> push` shape `runErrorCause` classifies on. */
function argv(pin: PinnedWorktreeGit, args: readonly string[]): string[] {
  return ["-C", pin.worktree, ...hardenedGitArgs(args)];
}

/** THE LEAF: run `git <args>` against the pinned worktree; returns stdout (empty unless piped). */
export function hostWorktreeGit(worktreePath: string, args: readonly string[], opts: HostWorktreeGitOptions = {}): string {
  const pin = pinWorktreeGit(worktreePath, opts.log);
  return String(execFileSync("git", argv(pin, args), spawnOptions(pin, opts)) ?? "");
}

const execFilePromise = promisify(execFile);

/** {@link hostWorktreeGit} off the event loop. `inherit-stdout` writes stdout through on completion. */
export async function hostWorktreeGitAsync(worktreePath: string, args: readonly string[], opts: HostWorktreeGitOptions = {}): Promise<string> {
  if (opts.input !== undefined) throw new Error("hostWorktreeGitAsync takes no input; use hostWorktreeGit");
  const pin = pinWorktreeGit(worktreePath, opts.log);
  const { stdio: _stdio, ...spawn } = spawnOptions(pin, opts);
  const { stdout } = await execFilePromise("git", argv(pin, args), spawn);
  if (opts.stdio === "inherit-stdout") {
    if (stdout) process.stdout.write(stdout);
    return "";
  }
  return opts.stdio === "ignore" ? "" : stdout;
}

/** One config value from the pinned repository's OWN files (no overrides applied), or undefined
 *  when unset. `git config --get` reads files and runs nothing. */
export function pinnedConfigValue(pin: PinnedWorktreeGit, key: string): string | undefined {
  const env = hostWorktreeGitEnv(pin);
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete env[k];
  try {
    return execFileSync("git", ["-C", pin.worktree, "config", "--get", key], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    // Exit 1 is git's own "the key is unset"; any other failure is not an answer and propagates.
    if ((error as { status?: unknown }).status === 1) return undefined;
    throw error;
  }
}
