import { execFile, execFileSync, spawn as spawnChild } from "node:child_process";
import { closeSync, constants as fsConstants, fstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { boundChildByLoopTime, execFileLoopBounded } from "./loop-bounded-child.js";
import { systemClock } from "./clock.js";
import { performance } from "node:perf_hooks";
import { execFileRouted, spawnRoute } from "./spawn-helper.js";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { RMD_TMP_PREFIX } from "./tmp.js";
import { DANGLING_REF_MAX_BUFFER, retryAfterDanglingRefRepair, retryAfterDanglingRefRepairAsync, type RepairGit } from "./git-fetch-retry.js";

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
 *   4. VETS the pinned gitdir's own config before git runs (W1-T6148): a key the harness never writes
 *      is refused ({@link WorktreeConfigRefusedError}), and `credential.helper` is reset and re-added
 *      from HARNESS state only — system/global helpers, or the daemon's socket helper.
 *
 *   5. NEUTRALISES every attribute-named driver the config defines (W1-T6146): filter clean/smudge/process
 *      and merge drivers, by name, at command-line precedence.
 *
 * WHAT IT DELIBERATELY KEEPS: system and global config (daemon-owned), and the pinned gitdir's config
 * keys that (4) admits, so pushes authenticate exactly as before.
 */

const execFilePromise = promisify(execFile);

/** A host git child bounded by LOOP-AVAILABLE time (W1-T9651 moved it to loop-bounded-child.ts; re-exported so
 *  worktree-git's callers do not change). */
export { execFileLoopBounded } from "./loop-bounded-child.js";

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

/** W1-T6148 — the daemon's own git credential socket, set by `startDaemonGitCredentialSocket` while it
 *  listens. The per-worktree socket helper is re-added from THIS, never read back from the file. */
let harnessCredentialSocket: string | undefined;

export function setHarnessCredentialSocket(socketPath: string | undefined): void {
  harnessCredentialSocket = socketPath;
}

/** The helper `wireCredentialHelperSocket` (worker.ts) writes: the HARNESS's script, the given socket. */
export function socketHelperCommand(socketPath: string): string {
  return `!node "${join(HARNESS_ROOT, "scripts", "git-credential-socket-helper.mjs")}" "${socketPath}"`;
}

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

/** W1-T6148: the record line naming the `remote.origin.url` the worktree was cut with. */
export const REMOTE_RECORD_PREFIX = "remote: ";

function recordLine(worktreePath: string, prefix: string): string | null {
  let text: string;
  try {
    text = readFileSync(worktreeRecordPath(worktreePath), "utf8");
  } catch {
    // No record: a worktree this harness did not cut (or cut before W1-T6106) — pinWorktreeGit's
    // unrecorded arm validates the pointer structurally instead.
    return null;
  }
  const line = text.split("\n").find((l) => l.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim() || null;
}

/** The gitdir `worktreeAdd` recorded for `worktreePath`, or null when it recorded none. */
export function recordedWorktreeGitDir(worktreePath: string): string | null {
  return recordLine(worktreePath, GITDIR_RECORD_PREFIX);
}

/** The origin URL `worktreeAdd` recorded for `worktreePath`, or null when it recorded none. */
export function recordedWorktreeRemote(worktreePath: string): string | null {
  return recordLine(worktreePath, REMOTE_RECORD_PREFIX);
}

/** The `remote.origin.url` a just-cut gitdir resolves to, for the record; undefined when unset. Read
 *  once at cut time, before any worker runs in the tree. */
export function originUrlAtCut(gitDir: string): string | undefined {
  const env = configReadEnv({ worktree: gitDir, gitDir, source: "recorded" });
  delete env.GIT_WORK_TREE;
  try {
    return execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: gitDir, encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    // Unset (exit 1) or no repository there: nothing to record, and the leaf checks the url's shape only.
    return undefined;
  }
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
  // One open, never a check-then-read: the kind and the pointer text come from the SAME descriptor, so
  // the entry cannot be swapped between them. O_NOFOLLOW refuses a symlinked `.git` (ELOOP).
  let fd: number;
  try {
    fd = openSync(dotGit, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A symlink is refused as a foreign entry; anything else unopenable means there is nothing to pin.
    if (code === "ELOOP") return refuse(dotGit, "the .git entry is neither a pointer file nor a directory");
    return refuse("<absent>", "the worktree has no .git entry");
  }
  let kind: "file" | "directory" | "other";
  let text = "";
  try {
    const st = fstatSync(fd);
    kind = st.isFile() ? "file" : st.isDirectory() ? "directory" : "other";
    if (kind === "file") text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  if (kind === "other") return refuse(dotGit, "the .git entry is neither a pointer file nor a directory");
  if (kind === "directory") {
    if (recorded !== null) return refuse(dotGit, "the .git pointer file was replaced by a directory");
    return { worktree, gitDir: dotGit, source: "git-directory" };
  }
  const match = /^gitdir: (.+)\n?$/.exec(text);
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

/** The environment for a pinned call: the caller's variables, then the pin and the config overrides
 *  ({@link HOST_GIT_CONFIG}, then `vetted`), which nothing a caller passes can replace. */
export function hostWorktreeGitEnv(
  pin: PinnedWorktreeGit, extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env,
  vetted: ReadonlyArray<readonly [string, string]> = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!REDIRECTING_ENV.test(k)) env[k] = v;
  Object.assign(env, extra);
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$|^GIT_EXTERNAL_DIFF$/.test(k)) delete env[k];
  env.GIT_DIR = pin.gitDir;
  env.GIT_WORK_TREE = pin.worktree;
  const overrides = [...HOST_GIT_CONFIG, ...vetted];
  env.GIT_CONFIG_COUNT = String(overrides.length);
  overrides.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** The pinned repository's environment with NO command-line config: what its own files say. */
function configReadEnv(pin: PinnedWorktreeGit): NodeJS.ProcessEnv {
  const env = hostWorktreeGitEnv(pin);
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete env[k];
  return env;
}

/** A pinned config file holds a key the harness never writes. Nothing ran. */
export class WorktreeConfigRefusedError extends RmdError {
  constructor(readonly worktree: string, readonly keys: readonly string[]) {
    super("git", GENERIC_EXIT_CODE,
      `worktree-git: refusing a host git call into ${worktree}: its pinned git config holds ` +
        `${keys.join(", ")}, which the harness never writes — nothing was run (W1-T6148)`,
      { worktree, keys });
    this.name = "WorktreeConfigRefusedError";
  }
}

/** W1-T6148 — what the pinned files may hold. config.worktree: the keys the harness writes there, and
 *  the keys a command-line value always overrides ({@link HOST_GIT_CONFIG}, the credential reset). */
const WORKTREE_SCOPE_KEYS = new Set(["credential.helper", "credential.usehttppath", "core.hookspath", "remudero.assignment",
  "core.fsmonitor", "core.sshcommand", "core.pager", "core.askpass", "commit.gpgsign", "tag.gpgsign"]);
/** Repository config sections that run nothing and redirect nothing on a host call. */
const INERT_SECTIONS = new Set(["branch", "user", "gc", "maintenance", "pack", "index", "feature", "fetch",
  "pull", "push", "rerere", "advice", "color", "status", "log", "init", "commit", "tag", "remudero", "safe"]);
const REFUSED_CORE = new Set(["gitproxy", "editor", "alternaterefscommand"]);
const INERT_REMOTE = new Set(["url", "fetch", "tagopt", "prune", "prunetags", "mirror", "skipdefaultupdate", "skipfetchall", "promisor", "partialclonefilter"]);
const INERT_FLAT = new Set(["credential.helper", "credential.usehttppath", "credential.username", "lfs.repositoryformatversion",
  "extensions.worktreeconfig", "extensions.objectformat", "extensions.refstorage"]);

/** Whether a local-scope key is admitted. Anything else — include*, url.*, http.*, credential.<url>.*,
 *  remote.<n>.pushurl/receivepack/uploadpack/vcs/proxy, filter/diff/merge drivers, submodule.*,
 *  extensions.partialclone — is not. */
function admittedLocalKey(key: string): boolean {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  const section = key.slice(0, first);
  const name = key.slice(last + 1);
  const flat = first === last;
  if (INERT_SECTIONS.has(section) || INERT_FLAT.has(key)) return true;
  if (section === "core") return flat && !REFUSED_CORE.has(name);
  if (section === "remote") return !flat && INERT_REMOTE.has(name);
  return (section === "merge" || section === "diff") && flat && key !== "diff.external";
}

interface ConfigEntry { scope: string; key: string; value: string | null }

/** `git config --list --show-scope --null` output: `scope\0key\nvalue\0` per entry. */
function parseConfigListing(out: string): ConfigEntry[] {
  const parts = out.split("\0");
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const kv = parts[i + 1]!;
    const nl = kv.indexOf("\n");
    entries.push({ scope: parts[i]!, key: nl < 0 ? kv : kv.slice(0, nl), value: nl < 0 ? null : kv.slice(nl + 1) });
  }
  return entries;
}

/** The refused key names in `entries` (never their values, which may carry a credential). */
function refusedConfigKeys(entries: readonly ConfigEntry[], recordedRemote: string | null): string[] {
  const refused = new Set<string>();
  const origin: string[] = [];
  const pushurl: string[] = [];
  for (const { scope, key, value } of entries) {
    if (scope === "worktree" && !WORKTREE_SCOPE_KEYS.has(key)) refused.add(key);
    if (scope !== "local") continue;
    if (key === "remote.origin.url") origin.push(value ?? "");
    if (key === "remote.origin.pushurl") pushurl.push(value ?? "");
    else if (!admittedLocalKey(key)) refused.add(key);
  }
  if (origin.length > 1) refused.add(`remote.origin.url (${origin.length} values)`);
  if (recordedRemote !== null && origin.length === 1 && origin[0] !== recordedRemote) {
    refused.add("remote.origin.url (not the remote recorded when the worktree was cut)");
  }
  // The fleet's core checkout carries a pushurl EQUAL to its url (measured 2026-10-07): admitted, since it
  // redirects nothing. One that differs from the origin url (the recorded one when there is a record), or
  // a second one, is refused.
  const expected = recordedRemote ?? (origin.length === 1 ? origin[0] : undefined);
  if (pushurl.length > 1 || (pushurl.length === 1 && pushurl[0] !== expected)) refused.add("remote.origin.pushurl");
  return [...refused].sort();
}

/** The credential config a call carries: reset, then ONLY harness helpers — the daemon's socket helper
 *  when this worktree was wired to it, else the system/global helpers in git's own order. Then the
 *  transport keys a command-line value neutralises. */
function harnessCredentialConfig(entries: readonly ConfigEntry[]): Array<[string, string]> {
  const out: Array<[string, string]> = [["credential.helper", ""]];
  const socket = harnessCredentialSocket;
  const wired = socket !== undefined &&
    entries.some((e) => e.scope === "worktree" && e.key === "credential.helper" && (e.value ?? "").includes(`"${socket}"`));
  if (wired) out.push(["credential.useHttpPath", "true"], ["credential.helper", socketHelperCommand(socket)]);
  else {
    for (const e of entries) {
      if ((e.scope === "system" || e.scope === "global") && /^credential\.(?:.+\.)?helper$/.test(e.key) && e.value !== null) out.push([e.key, e.value]);
    }
  }
  return [...out, ["core.askPass", ""], ["http.extraHeader", ""]];
}

/** W1-T6146 — the attribute-named drivers a config source defines, neutralised at command-line precedence.
 *  A tracked `.gitattributes` (`* filter=x`, `f merge=m`) names a driver and git runs whatever command a config
 *  file gives it, as the daemon: `filter.<d>.clean|smudge|process` on add/status/diff/checkout/rebase, and
 *  `merge.<d>.driver` on a merge or rebase. Config keys cannot be wildcarded, so each driver name the listing
 *  holds (any scope) is overridden: a filter becomes the identity (`cat`, no `process`, not `required`, so the
 *  stored blob is the file's own bytes and the call does not fail), a merge driver becomes `false`, so a path
 *  that needs it conflicts as a NAMED failure rather than merging silently. The pinned local and worktree files
 *  are already refused above; this closes the system/global scope (e.g. `git lfs install`'s filter.lfs.*),
 *  which only the daemon writes. An `include.path` inside system/global is not listed (`--no-includes`) and is
 *  the accepted residual. */
function driverNeutralisation(entries: readonly ConfigEntry[]): Array<[string, string]> {
  const filters = new Set<string>();
  const mergers = new Set<string>();
  for (const { key } of entries) {
    const f = /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(key);
    if (f) filters.add(f[1]!);
    const m = /^merge\.(.+)\.driver$/.exec(key);
    if (m) mergers.add(m[1]!);
  }
  const out: Array<[string, string]> = [];
  for (const d of [...filters].sort()) {
    out.push([`filter.${d}.clean`, "cat"], [`filter.${d}.smudge`, "cat"], [`filter.${d}.process`, ""], [`filter.${d}.required`, "false"]);
  }
  for (const d of [...mergers].sort()) out.push([`merge.${d}.driver`, "false"]);
  return out;
}

const CONFIG_LIST_ARGS = ["config", "--list", "--show-scope", "--null", "--no-includes"];
const CONFIG_READ_TIMEOUT_MS = 30_000;

/** Whether `pin` is the HARNESS's own checkout — the tree this code runs from, which no worker writes
 *  (CI's runner checkout carries `actions/checkout`'s includeIf credentials). Real paths, never names: a
 *  worker, reviewer or PR-head tree, or a worktree of the managed clone, is never this. */
export function isHarnessCheckout(pin: PinnedWorktreeGit, harnessRoot: string = HARNESS_ROOT): boolean {
  const here = real(pin.worktree);
  return here !== undefined && here === real(harnessRoot);
}

function vetted(pin: PinnedWorktreeGit, listing: string, log: WorktreeGitLog, harnessRoot: string = HARNESS_ROOT): Array<[string, string]> {
  const entries = parseConfigListing(listing);
  // The harness checkout skips only the refusal arm; the credential reset and every override still apply.
  const keys = isHarnessCheckout(pin, harnessRoot) ? [] : refusedConfigKeys(entries, recordedWorktreeRemote(pin.worktree));
  if (keys.length > 0) {
    log("worktree_git.config_refused", { worktree: pin.worktree, git_dir: pin.gitDir, keys });
    throw new WorktreeConfigRefusedError(pin.worktree, keys);
  }
  return [...harnessCredentialConfig(entries), ...driverNeutralisation(entries)];
}

/** Vet the pinned repository's own config before a call (W1-T6148); returns the overrides it adds. */
export function vetPinnedConfig(pin: PinnedWorktreeGit, log: WorktreeGitLog = stderrLog, harnessRoot: string = HARNESS_ROOT): Array<[string, string]> {
  const listing = execFileSync("git", CONFIG_LIST_ARGS, {
    cwd: pin.worktree, encoding: "utf8", env: configReadEnv(pin), stdio: ["ignore", "pipe", "pipe"], timeout: CONFIG_READ_TIMEOUT_MS,
  });
  return vetted(pin, listing, log, harnessRoot);
}

async function vetPinnedConfigAsync(pin: PinnedWorktreeGit, log: WorktreeGitLog, timeout = CONFIG_READ_TIMEOUT_MS,
  signal?: AbortSignal): Promise<Array<[string, string]>> {
  const options = { encoding: "utf8" as const, env: configReadEnv(pin), timeout };
  const { stdout } = signal
    ? await stoppableGit(pin, CONFIG_LIST_ARGS, options, "", signal)
    : await execFileRouted("git", CONFIG_LIST_ARGS, { ...options, cwd: pin.worktree });
  return vetted(pin, stdout, log);
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
  /** Kills the call past this many milliseconds, as `execFileSync`'s own `timeout` does. */
  timeout?: number;
  /** The signal `timeout` kills with (node's default is SIGTERM). */
  killSignal?: NodeJS.Signals;
  /** Cancels an in-flight Git child when an owning operation is stopped. */
  signal?: AbortSignal;
  /** The async push must propose exactly the ref update approved by the harness gate. */
  expectedPrePushInput?: string;
  /** `latin1` maps each stdout byte to one char, so `Buffer.from(out, "latin1")` is the bytes exactly: a blob read
   *  must reach its reader as a checkout writes it, and a UTF-8 decode rewrites an invalid sequence. Default utf8. */
  encoding?: "utf8" | "latin1";
  log?: WorktreeGitLog;
  /** The loop-available budget of the async leaf's pinned config read; a test seam, 30 s otherwise. */
  configReadTimeoutMs?: number;
}

function spawnOptions(pin: PinnedWorktreeGit, opts: HostWorktreeGitOptions, overrides: ReadonlyArray<readonly [string, string]>) {
  const stdio = opts.stdio === "ignore" ? "ignore" as const
    : opts.stdio === "inherit-stdout" ? ["pipe", "inherit", "pipe"] as ["pipe", "inherit", "pipe"]
    : ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"];
  return {
    encoding: opts.encoding ?? ("utf8" as const),
    env: hostWorktreeGitEnv(pin, opts.env, process.env, overrides),
    stdio,
    ...(opts.maxBuffer === undefined ? {} : { maxBuffer: opts.maxBuffer }),
    ...(opts.input === undefined ? {} : { input: opts.input }),
    ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
    ...(opts.killSignal === undefined ? {} : { killSignal: opts.killSignal }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
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
  const overrides = vetPinnedConfig(pin, opts.log);
  const gitSync = (a: readonly string[], options: ReturnType<typeof spawnOptions>): string =>
    String(execFileSync("git", argv(pin, a), options) ?? "");
  const runHostWorktreeGit = (): string => gitSync(args, spawnOptions(pin, opts, overrides));
  try {
    return runHostWorktreeGit();
  } catch (error) {
    // W1-T13409: a fetch that names a ref with a missing object repairs it and runs once more; anything else rethrows.
    // W1-T13548: the runner is named so the spawn meter knows it as a leaf, as it knows gitSync.
    const repairHostWorktreeGit: RepairGit = (a, timeout) =>
      gitSync(a, spawnOptions(pin, { timeout, maxBuffer: DANGLING_REF_MAX_BUFFER }, overrides));
    return retryAfterDanglingRefRepair(
      repairHostWorktreeGit,
      args,
      error,
      runHostWorktreeGit,
    );
  }
}

/** W1-T13170 — INVARIANT the-child-outcome-wins: the git child's own failure is the error of the call. `stdinWrite`
 *  settles to the stdin write's error (or undefined) and never rejects. When the child fails (output past maxBuffer,
 *  a nonzero exit, a loop-bounded timeout) its error is thrown unchanged, whatever the write had: node kills an
 *  overflowing child and the unfinished write then fails with EPIPE, which must not hide the overflow. A stdin error
 *  is thrown only when the child exited 0, and EPIPE then is git's choice not to read all of its input: stdout stands. */
export async function childOutcomeWins<T>(command: Promise<T>, stdinWrite: Promise<Error | undefined>): Promise<T> {
  const result = await command;
  const stdinError = await stdinWrite;
  if (stdinError !== undefined && (stdinError as NodeJS.ErrnoException).code !== "EPIPE") throw stdinError;
  return result;
}

/** The git child forked from this process, exactly as before the helper; a helper that was passed over notes why. */
function directGit(pin: PinnedWorktreeGit, args: readonly string[], spawn: Omit<ReturnType<typeof spawnOptions>, "stdio" | "input">,
  input: string | undefined, route: ReturnType<typeof spawnRoute>): Promise<{ stdout: string }> {
  const began = performance.now();
  const command = execFileLoopBounded("git", argv(pin, args), spawn);
  route.helper?.noteDirect("git", performance.now() - began, route.why ?? "helper_passed_over");
  const fed = input === undefined ? Promise.resolve(undefined) : new Promise<Error | undefined>((resolve) => {
    const stdin = command.child.stdin!;
    stdin.once("error", resolve);
    stdin.end(input, (error?: Error | null) => resolve(error ?? undefined));
  });
  return childOutcomeWins(command, fed);
}

const GIT_STOP_GRACE_MS = 2_000;
/** execFile's own default, kept for the stoppable child so a stop changes nothing else about the call. */
const EXEC_FILE_MAX_BUFFER = 1024 * 1024;

function signalGitGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; return false; }
}

/** W1-T12169 — a Git call its owner can stop. execFile's own `signal` rejects with ABORT_ERR the moment the stop
 *  arrives, while the child it launched (and any transport child under it) may still be running. This child leads
 *  its own process group: a stop signals the whole group, a member still there when the grace period ends is
 *  killed, and the call rejects with the stop's reason only once every member is gone. Otherwise it settles as
 *  execFile does: stdout on exit 0, else execFile's `Command failed: <cmd>` shape, or the loop-bounded timeout. */
function stoppableGit(pin: PinnedWorktreeGit, args: readonly string[], spawn: Omit<ReturnType<typeof spawnOptions>, "stdio" | "input" | "signal">,
  input: string | undefined, signal: AbortSignal): Promise<{ stdout: string }> {
  signal.throwIfAborted();
  const gitArgs = argv(pin, args);
  const label = ["git", ...gitArgs].join(" ");
  const maxBuffer = spawn.maxBuffer ?? EXEC_FILE_MAX_BUFFER;
  return new Promise((resolveGit, rejectGit) => {
    const child = spawnChild("git", gitArgs, { env: spawn.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const bound = spawn.timeout !== undefined && spawn.timeout > 0
      ? boundChildByLoopTime(child, spawn.timeout, { killSignal: spawn.killSignal }) : undefined;
    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const length = { stdout: 0, stderr: 0 };
    let failure: unknown;
    let stdinError: NodeJS.ErrnoException | undefined;
    let stopping: number | undefined;
    let force: NodeJS.Timeout | undefined;
    const stop = (reason: unknown) => {
      failure ??= reason;
      if (stopping !== undefined || child.pid === undefined) return;
      const pid = child.pid;
      stopping = systemClock.now() + GIT_STOP_GRACE_MS;
      signalGitGroup(pid, "SIGTERM");
      // A member that ignores SIGTERM can hold the pipes open, so the kill cannot wait for them to close.
      force = setTimeout(() => signalGitGroup(pid, "SIGKILL"), GIT_STOP_GRACE_MS);
    };
    const onAbort = () => stop(signal.reason);
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].on("data", (chunk: Buffer) => {
        length[stream] += chunk.length;
        if (length[stream] <= maxBuffer) out[stream].push(chunk);
        else stop(Object.assign(new RangeError(`${stream} maxBuffer length exceeded`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", cmd: label }));
      });
    }
    let settled = false;
    const settle = (code: number | null, killedBy: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      bound?.cancel();
      signal.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(out.stdout).toString(spawn.encoding), stderr = Buffer.concat(out.stderr).toString(spawn.encoding);
      if (signal.aborted) rejectGit(signal.reason);
      else if (failure !== undefined) rejectGit(Object.assign(failure as object, { stdout, stderr }));
      else if (bound?.timedOut) rejectGit(bound.timeoutError(label, { exitCode: code, signal: killedBy, stdout, stderr }));
      else if (code !== 0) {
        rejectGit(Object.assign(new Error(`Command failed: ${label}\n${stderr}`), { code, killed: killedBy !== null, signal: killedBy, cmd: label, stdout, stderr }));
      } else if (stdinError !== undefined && stdinError.code !== "EPIPE") rejectGit(stdinError);
      else resolveGit({ stdout });
    };
    child.on("error", (error) => {
      failure ??= error;
      if (child.pid === undefined) settle(null, null); // it never started, so there is no group to wait for
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { stdinError ??= error; });
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code, killedBy) => {
      if (stopping === undefined || child.pid === undefined) return settle(code, killedBy);
      const pid = child.pid;
      const reaped = stopping + GIT_STOP_GRACE_MS;
      void (async () => {
        while (signalGitGroup(pid, 0) && systemClock.now() < stopping!) await delay(50);
        signalGitGroup(pid, "SIGKILL");
        // A killed member leaves the group once it is reaped; the wait is bounded for a host whose init never reaps.
        while (signalGitGroup(pid, 0) && systemClock.now() < reaped) await delay(20);
      })().then(() => settle(code, killedBy), (error: unknown) => { failure ??= error; settle(code, killedBy); });
    });
    // execFile leaves stdin open when there is no input; so does this.
    if (input !== undefined) child.stdin.end(input);
  });
}

/** {@link hostWorktreeGit} off the event loop. `inherit-stdout` writes stdout through on completion. */
export async function hostWorktreeGitAsync(worktreePath: string, args: readonly string[], opts: HostWorktreeGitOptions = {}): Promise<string> {
  const pin = pinWorktreeGit(worktreePath, opts.log);
  const overrides = await vetPinnedConfigAsync(pin, opts.log ?? stderrLog, opts.configReadTimeoutMs, opts.signal);
  if (opts.expectedPrePushInput !== undefined) {
    const hooks = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}push-input-`));
    try {
      writeFileSync(join(hooks, "expected"), opts.expectedPrePushInput, { mode: 0o600 });
      writeFileSync(join(hooks, "pre-push"), `#!/bin/sh
/usr/bin/cmp -s "${"$"}{0%/*}/expected" - && exit 0
echo "git-push: the remote update differs from the ref checked by the required pre-push gate" >&2
exit 1
`, { mode: 0o700 });
      return await runPinnedGitAsync(pin, args, opts, [...overrides, ["core.hooksPath", hooks]]);
    } finally {
      rmSync(hooks, { recursive: true, force: true });
    }
  }
  return await runPinnedGitAsync(pin, args, opts, overrides);
}

async function runPinnedGitAsync(pin: PinnedWorktreeGit, args: readonly string[], opts: HostWorktreeGitOptions,
  overrides: ReadonlyArray<readonly [string, string]>): Promise<string> {
  const { stdio: _stdio, input, signal, ...spawn } = spawnOptions(pin, opts, overrides);
  const run = async (): Promise<string> => {
    // W1-T13434: through a healthy helper the git child forks there; a request it took is never sent again.
    const route = spawnRoute(spawn);
    const { stdout } = signal !== undefined ? await stoppableGit(pin, args, spawn, input, signal)
      : route.helper !== undefined && route.why === undefined
      ? await execFileRouted("git", argv(pin, args), { ...spawn, cwd: pin.worktree, ...(input === undefined ? {} : { input }) })
      : await directGit(pin, args, spawn, input, route);
    if (opts.stdio === "inherit-stdout") {
      if (stdout) process.stdout.write(stdout);
      return "";
    }
    return opts.stdio === "ignore" ? "" : stdout;
  };
  try {
    return await run();
  } catch (error) {
    // A stopped call is not repaired and run again.
    if (signal?.aborted) throw error;
    // The same repair as the sync leaf, off the loop; anything else rethrows.
    const { stdio: _repairStdio, ...repair } = spawnOptions(pin, {}, overrides);
    return retryAfterDanglingRefRepairAsync(async (a, timeout) =>
      (await execFileRouted("git", argv(pin, a), { ...repair, cwd: pin.worktree, timeout, maxBuffer: DANGLING_REF_MAX_BUFFER })).stdout, args, error, run);
  }
}

/** One config value from the pinned repository's OWN files (no overrides applied), or undefined
 *  when unset. `git config --get` reads files and runs nothing. */
export function pinnedConfigValue(pin: PinnedWorktreeGit, key: string): string | undefined {
  try {
    return execFileSync("git", ["-C", pin.worktree, "config", "--get", key], { encoding: "utf8", env: configReadEnv(pin), stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    // Exit 1 is git's own "the key is unset"; any other failure is not an answer and propagates.
    if ((error as { status?: unknown }).status === 1) return undefined;
    throw error;
  }
}

/** W1-T7744 — {@link pinnedConfigValue} off the event loop: the same read, the same unset answer. */
export async function pinnedConfigValueAsync(pin: PinnedWorktreeGit, key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFilePromise("git", ["-C", pin.worktree, "config", "--get", key], { encoding: "utf8", env: configReadEnv(pin) });
    return stdout.trim();
  } catch (error) {
    // Exit 1 is git's own "the key is unset" (execFile reports the exit status as `code`); any other failure propagates.
    if ((error as { code?: unknown }).code === 1) return undefined;
    throw error;
  }
}
