import { execFile, execFileSync, spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns, type ExecFileSyncOptions, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";

/**
 * W1-T6106 — THE ONLY WAY HOST CODE RUNS GIT WITH A WORKER WORKTREE AS ITS REPOSITORY.
 *
 * WHY. `git -C <worktree> …` follows the worktree's own `.git` pointer file and honours that gitdir's
 * config and the worktree's tracked `hooks/`. Both are bytes a worker can write, so a host commit, diff
 * or push ran code the MODEL wrote, as the daemon, with the daemon's credentials, outside the worker
 * sandbox. This leaf closes both routes:
 *
 *  1. THE POINTER IS PINNED. `worktreeAdd` records the exact `.git` file text it saw ({@link recordWorktreePin}, a sibling
 *     file outside the working tree, like the `.base` record). Every call here passes `--git-dir` and
 *     `--work-tree` explicitly — git never re-discovers anything from the worker-writable `.git` file — and a
 *     `.git` file that no longer reads exactly what was recorded REFUSES the call before git runs, naming both
 *     paths ({@link WorktreePointerTamperedError}).
 *  2. CODE-EXECUTING CONFIG IS OVERRIDDEN ON EVERY CALL, `-c` outranking every file layer: `core.fsmonitor`,
 *     `core.hooksPath`, `core.sshCommand`, `core.pager`, `core.editor`, `core.askPass`, the signing switches, and
 *     the credential helper chain, which is rebuilt from the daemon's own global config plus only those
 *     worktree entries that are exactly the harness's socket helper. System config is off and global config
 *     is the daemon's own file; diffs run with `--no-ext-diff --no-textconv`.
 *  3. THE GATES SURVIVE FROM THE HARNESS COPY. A commit or push into a pinned worktree runs the hooks in this
 *     install's own `hooks/` ({@link harnessHooksDir}), never the worktree's tracked copy; the W1-T4614
 *     assignment trailer is added with `--trailer` instead of a hook that lived inside the gitdir.
 *
 * A worktree with NO pin record (a plain fixture repo, an operator lane) is not refused — nothing was recorded to
 * compare against — but still gets every config override, and its hooks are off.
 */
export class WorktreePointerTamperedError extends RmdError {
  constructor(
    readonly worktreePath: string,
    readonly expectedPointer: string,
    readonly observedPointer: string,
  ) {
    super(
      "git",
      GENERIC_EXIT_CODE,
      `refusing host git in ${worktreePath}: its .git pointer now reads ${JSON.stringify(observedPointer)} but ` +
        `worktreeAdd recorded ${JSON.stringify(expectedPointer)} (${worktreePinPath(worktreePath)}) — git was not run`,
      { worktreePath, expectedPointer, observedPointer },
    );
    this.name = "WorktreePointerTamperedError";
  }
}

/** The harness's own hooks dir is absent, so the commit/push gate cannot run — refused rather than skipped. */
export class HarnessHooksMissingError extends RmdError {
  constructor(worktreePath: string, subcommand: string, hooks: string) {
    super("git", GENERIC_EXIT_CODE, `refusing host git ${subcommand} in ${worktreePath}: the harness hooks dir ${hooks} does not exist`, { hooks });
    this.name = "HarnessHooksMissingError";
  }
}

/** Sibling file (outside the working tree) holding the `.git` file text `worktreeAdd` wrote. */
export function worktreePinPath(worktreePath: string): string {
  return `${worktreePath}.gitdir`;
}

/** Record the pointer a freshly added linked worktree carries. No-op when `.git` is not a file (a plain repo). */
export function recordWorktreePin(worktreePath: string): boolean {
  try {
    const text = readFileSync(join(worktreePath, ".git"), "utf8");
    if (!text.startsWith("gitdir:")) return false;
    writeFileSync(worktreePinPath(worktreePath), text);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return false; // not a worktree at all
    console.error(JSON.stringify({ event: "worktree_git.pin_not_recorded", worktree: worktreePath, reason: String((error as Error)?.message ?? error) }));
    return false;
  }
}

/** Drop the pin with its worktree. Never throws. */
export function removeWorktreePin(worktreePath: string): void {
  try {
    unlinkSync(worktreePinPath(worktreePath));
  } catch {
    /* absent — removal owes nothing here */
  }
}

export interface WorktreePin {
  /** The daemon-recorded gitdir, absolute. */
  gitDir: string;
}

/** `null` when no pin was recorded; throws {@link WorktreePointerTamperedError} when the live pointer differs. */
export function readWorktreePin(worktreePath: string, log?: HostGitLog): WorktreePin | null {
  let expected: string;
  try {
    expected = readFileSync(worktreePinPath(worktreePath), "utf8");
  } catch {
    return null; // nothing recorded, nothing to compare against
  }
  let observed = "<unreadable>";
  try {
    observed = readFileSync(join(worktreePath, ".git"), "utf8");
  } catch {
    /* an unreadable pointer is a mismatch */
  }
  if (observed !== expected) {
    const ledger = { worktree: worktreePath, recorded_pointer: expected.trim(), observed_pointer: observed.trim() };
    console.error(JSON.stringify({ event: "worktree_git.pointer_refused", ...ledger }));
    log?.("worktree_git.pointer_refused", ledger);
    throw new WorktreePointerTamperedError(worktreePath, expected.trim(), observed.trim());
  }
  const raw = expected.replace(/^gitdir:/, "").trim();
  return { gitDir: isAbsolute(raw) ? raw : resolve(worktreePath, raw) };
}

export type HostGitLog = (step: string, extra?: Record<string, unknown>) => void;

export interface HostGitOptions {
  /** Ledger sink for a refusal; the refusal is also written to stderr as one JSON line. */
  log?: HostGitLog;
}

/** This install's own `hooks/` — the code the daemon ships, never a worktree's tracked copy. */
export function harnessHooksDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");
}

function harnessScriptsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
}

const NETWORK_SUBCOMMANDS = new Set(["push", "fetch", "pull", "ls-remote", "clone"]);
const HOOKED_SUBCOMMANDS = new Set(["commit", "push"]);
const DIFFING_SUBCOMMANDS = new Set(["diff", "show", "log"]);
const ASSIGNMENT_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The invocation spelled as a logical argv (`-C <worktree> …`) for seams that record it; the DEFAULT executors turn it
 *  into a hardened call. Callers use this instead of spelling `-C` themselves. */
export function worktreeGitInvocation(worktreePath: string, args: string[]): string[] {
  return ["-C", worktreePath, ...args];
}

/** Split a logical invocation back into its worktree and git args; `null` when it is not one. */
export function parseWorktreeGitInvocation(args: readonly string[]): { worktreePath: string; args: string[] } | null {
  if (args[0] !== "-C" || typeof args[1] !== "string") return null;
  return { worktreePath: args[1], args: args.slice(2) };
}

function daemonGlobalConfig(env: NodeJS.ProcessEnv): string {
  const configured = env.GIT_CONFIG_GLOBAL;
  if (configured !== undefined && configured !== "") return configured;
  const home = join(env.HOME ?? homedir(), ".gitconfig");
  return existsSync(home) ? home : "/dev/null";
}

function subcommandOf(args: readonly string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

function readConfigList(configArgs: string[], key: string, env: NodeJS.ProcessEnv): string[] {
  try {
    const out = execFileSync("git", [...configArgs, "config", "--get-all", key], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").slice(0, -1);
  } catch {
    return []; // exit 1: the key is unset
  }
}

/** Only the harness's own socket helper survives from a worktree's config; everything else a worker could have
 *  written there is dropped. A `""` entry (the reset) is kept because it only ever removes helpers. */
function trustedWorktreeHelper(entry: string): boolean {
  if (entry === "") return true;
  const script = join(harnessScriptsDir(), "git-credential-socket-helper.mjs");
  return entry.startsWith(`!node "${script}" "`) && entry.endsWith('"') && !entry.slice(`!node "${script}" "`.length, -1).includes('"');
}

function credentialConfig(gitDir: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const globalFile = daemonGlobalConfig(env);
  const fromGlobal = globalFile === "/dev/null" ? [] : readFileConfigList(globalFile, "credential.helper", env);
  let chain = [...fromGlobal];
  let useHttpPath = false;
  if (gitDir !== undefined) {
    const scope = ["--git-dir", gitDir, "-c", "core.fsmonitor=false"];
    for (const entry of readConfigList([...scope], "credential.helper", env)) {
      // Entries from the daemon's own global config also appear in this merged read; those are already in `chain`.
      if (fromGlobal.includes(entry) && entry !== "") continue;
      if (!trustedWorktreeHelper(entry)) continue;
      if (entry === "") chain = [];
      else chain.push(entry);
    }
    useHttpPath = readConfigList(scope, "credential.useHttpPath", env).at(-1) === "true";
  }
  const out = ["-c", "credential.helper="];
  for (const helper of chain) out.push("-c", `credential.helper=${helper}`);
  if (useHttpPath) out.push("-c", "credential.useHttpPath=true");
  return out;
}

function readFileConfigList(file: string, key: string, env: NodeJS.ProcessEnv): string[] {
  try {
    const out = execFileSync("git", ["config", "--file", file, "--get-all", key], { encoding: "utf8", env: { ...env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").slice(0, -1);
  } catch {
    return [];
  }
}

function assignmentOf(gitDir: string, env: NodeJS.ProcessEnv): string | undefined {
  const id = readConfigList(["--git-dir", gitDir, "-c", "core.fsmonitor=false"], "remudero.assignment", env).at(-1);
  return id !== undefined && ASSIGNMENT_ID_SHAPE.test(id) ? id : undefined;
}

export interface HostGitPlan {
  argv: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * The whole hardened invocation for `git <args>` in `worktreePath`. Throws {@link WorktreePointerTamperedError}
 * BEFORE any git process that would read the worktree's own config is spawned.
 */
export function hostWorktreeGitPlan(worktreePath: string, args: readonly string[], opts: HostGitOptions = {}): HostGitPlan {
  const pin = readWorktreePin(worktreePath, opts.log);
  const sub = subcommandOf(args);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR"]) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = daemonGlobalConfig(process.env);
  env.GIT_PAGER = "cat";
  env.GIT_EDITOR = "true";
  const hooks = pin !== null && sub !== undefined && HOOKED_SUBCOMMANDS.has(sub) ? harnessHooksDir() : "/dev/null";
  if (hooks !== "/dev/null" && !existsSync(hooks)) {
    throw new HarnessHooksMissingError(worktreePath, sub ?? "", hooks);
  }
  const hardening = [
    "--no-pager",
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${hooks}`,
    "-c", "core.sshCommand=ssh",
    "-c", "core.pager=cat",
    "-c", "core.editor=true",
    "-c", "sequence.editor=true",
    "-c", "core.askPass=",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "push.gpgSign=false",
  ];
  const credentials = sub !== undefined && NETWORK_SUBCOMMANDS.has(sub) ? credentialConfig(pin?.gitDir, env) : ["-c", "credential.helper="];
  let rest = [...args];
  if (sub !== undefined && DIFFING_SUBCOMMANDS.has(sub)) {
    const at = rest.indexOf(sub);
    rest = [...rest.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...rest.slice(at + 1)];
  }
  if (pin !== null && sub === "commit") {
    const id = assignmentOf(pin.gitDir, env);
    const carried = rest.some((a, i) => /Remudero-Assignment:/.test(a) && (rest[i - 1] === "-m" || a.startsWith("--message=")));
    if (id !== undefined && !carried) {
      const at = rest.indexOf("commit");
      rest = [...rest.slice(0, at + 1), "--trailer", `Remudero-Assignment: ${id}`, ...rest.slice(at + 1)];
    }
  }
  const pinning = pin !== null ? ["--git-dir", pin.gitDir, "--work-tree", resolve(worktreePath)] : [];
  return { argv: ["-C", worktreePath, ...pinning, ...hardening, ...credentials, ...rest], env };
}

/** `execFileSync("git", …)` for a worker worktree, hardened. Same return and throw shapes as `execFileSync`. */
export function hostWorktreeGit(worktreePath: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding, host?: HostGitOptions): string;
export function hostWorktreeGit(worktreePath: string, args: readonly string[], options?: ExecFileSyncOptions, host?: HostGitOptions): string | Buffer;
export function hostWorktreeGit(worktreePath: string, args: readonly string[], options: ExecFileSyncOptions = {}, host: HostGitOptions = {}): string | Buffer {
  const plan = hostWorktreeGitPlan(worktreePath, args, host);
  return execFileSync("git", plan.argv, { ...options, env: { ...plan.env, ...(options.env ?? {}), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: plan.env.GIT_CONFIG_GLOBAL } });
}

const execFilePromise = promisify(execFile);

/** {@link hostWorktreeGit} off the event loop; resolves like `execFile` promisified (`{ stdout, stderr }`). */
export async function hostWorktreeGitAsync(
  worktreePath: string,
  args: readonly string[],
  options: { encoding?: BufferEncoding; maxBuffer?: number; timeout?: number; env?: NodeJS.ProcessEnv } = {},
  host: HostGitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const plan = hostWorktreeGitPlan(worktreePath, args, host);
  return execFilePromise("git", plan.argv, {
    encoding: "utf8",
    ...options,
    env: { ...plan.env, ...(options.env ?? {}), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: plan.env.GIT_CONFIG_GLOBAL },
  });
}

/** `spawnSync("git", …)` for a worker worktree, hardened — for callers that need the exit status rather than a throw. */
export function hostWorktreeGitSpawn(
  worktreePath: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> & { encoding?: "utf8" } = {},
  host: HostGitOptions = {},
): SpawnSyncReturns<string> {
  const plan = hostWorktreeGitPlan(worktreePath, args, host);
  return spawnSync("git", plan.argv, { encoding: "utf8", ...options, env: { ...plan.env, ...(options.env ?? {}), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: plan.env.GIT_CONFIG_GLOBAL } });
}

/** The DEFAULT executor behind every seam that records a logical `-C <worktree>` invocation: such an invocation never
 *  reaches `git` raw — it runs through {@link hostWorktreeGit}. Anything else is passed to `execFileSync` unchanged. */
export function execGitInvocation(file: string, args: readonly string[], options: ExecFileSyncOptions = {}): string | Buffer {
  const invocation = file === "git" ? parseWorktreeGitInvocation(args) : null;
  if (invocation === null) return execFileSync(file, args, options);
  return hostWorktreeGit(invocation.worktreePath, invocation.args, options);
}

/** {@link execGitInvocation} off the event loop. */
export async function execGitInvocationAsync(file: string, args: readonly string[], options: { encoding?: BufferEncoding } = {}): Promise<{ stdout: string; stderr: string }> {
  const invocation = file === "git" ? parseWorktreeGitInvocation(args) : null;
  if (invocation === null) return execFilePromise(file, args, { encoding: "utf8", ...options });
  return hostWorktreeGitAsync(invocation.worktreePath, invocation.args, options);
}
