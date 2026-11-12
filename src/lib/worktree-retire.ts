/**
 * src/lib/worktree-retire.ts — a SHADOW worktree janitor: it reports which registered worktrees it
 * would retire, and why, and retires none of them (W1-T11941).
 *
 * THE DEFECT. The 2026-11-10 janitor inventory counted 97 registered worktrees, about 100 GiB, the
 * oldest 39 days old, on a host whose root disk was 86 percent used. Every shipped reclaim rung reaps
 * a whole tree under a MANAGED root (`review-PR*`, ad-hoc lanes) or regenerable output inside a kept
 * tree (disk-artifact-reclaim.ts). None of them reads the roots where the old checkouts actually sit.
 *
 * THE ROOTS COME FROM `git worktree list` IN THE OPERATOR CHECKOUT, never from a list of directories.
 * A hard-coded root list goes stale the day someone cuts a worktree somewhere new; the registration
 * list is the one record that names every tree that shares this repository's objects.
 *
 * A REGISTRATION QUALIFIES ONLY WHEN EVERY GATE ANSWERS, AND AN UNANSWERED GATE IS NEVER A YES:
 *   - it is not the operator checkout itself, not bare, not locked, and its path exists;
 *   - it is not a container `/home/node/` registration (from the host those name another namespace);
 *   - its newest activity is at least {@link DEFAULT_RETIRE_MIN_AGE_MS} old;
 *   - a `run-<id>-*` branch has no `refs/rmd-dispatch/<id>` claim on origin;
 *   - no open PR's head is its branch, or any `run-<id>-*` head of its task;
 *   - `git status --porcelain` is empty;
 *   - its HEAD holds no commit absent from origin, OR its task is credited by a `Remudero-Task: <id>`
 *     trailer on origin/main that landed after its HEAD commit. The trailer is the credit because a
 *     squash merge leaves the branch reading "not merged" to `git branch -r --merged` forever.
 *
 * SHADOW ONLY. This module has no removal port: it runs no `git worktree remove`, no branch delete
 * and no prune, and a registration whose path is missing is only reported. The first live pass needs
 * the operator's exact-path approval and a follow-up task.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { ghJsonAsync } from "./github-transport.js";
import { hostWorktreeGitAsync, pinWorktreeGit } from "./worktree-git.js";

export const WORKTREE_RETIRE_WOULD_RETIRE_STEP = "worktree_retire.would_retire";
export const WORKTREE_RETIRE_KEPT_STEP = "worktree_retire.kept";
export const WORKTREE_RETIRE_PASS_STEP = "worktree_retire.pass";

/** A tree touched inside this window may be someone's live work. */
export const DEFAULT_RETIRE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** The tick calls in every time; a full pass reads every registration, so it runs at most this often. */
export const DEFAULT_RETIRE_REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How far back origin/main is read for `Remudero-Task` credit. An older credit reads as none: kept. */
export const DEFAULT_RETIRE_CREDIT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/** The container's home. From the host a registration under it names a tree in another namespace. */
export const CONTAINER_HOME_PREFIX = "/home/node/";

const GIT_TIMEOUT_MS = 60_000;
const GIT_LOG_MAX_BUFFER = 256 * 1024 * 1024;

export type WorktreeKeepReason =
  | "main-worktree"
  | "bare"
  | "container-registration"
  /** Reported only: the registration is left in place, never pruned. */
  | "path-missing"
  | "locked"
  | "too-young"
  | "dispatch-claimed"
  | "claims-unreadable"
  | "open-pr"
  | "pr-state-unreadable"
  | "dirty"
  | "unpushed-commits"
  /** A per-tree read (age, status, unpushed count, head time) could not be answered. */
  | "unreadable";

export type WorktreeRetireReason = "fully-pushed" | "credited-by-trailer";

export interface WorktreeRegistration {
  path: string;
  head?: string;
  /** Short branch name (`refs/heads/` stripped); undefined for a detached HEAD. */
  branch?: string;
  bare: boolean;
  locked: boolean;
}

export interface TaskCredit {
  sha: string;
  committedAtMs: number;
}

export interface WorktreeRetireOutcome {
  path: string;
  branch?: string;
  taskId?: string;
  verdict: "would-retire" | "kept";
  reason: WorktreeRetireReason | WorktreeKeepReason;
  detail: Record<string, unknown>;
}

export interface WorktreeRetireSummary {
  registered: number;
  wouldRetire: WorktreeRetireOutcome[];
  kept: WorktreeRetireOutcome[];
  /** Set when `git worktree list` itself could not be read: nothing was classified. */
  listUnreadable?: string;
}

/** Every read the janitor makes. There is deliberately no removal port. `undefined` = unreadable. */
export interface WorktreeRetirePorts {
  listWorktrees: () => Promise<string>;
  pathExists: (path: string) => boolean;
  lastActivityMs: (path: string) => number | undefined;
  countDirtyFiles: (path: string) => Promise<number | undefined>;
  unpushedCommits: (path: string) => Promise<number | undefined>;
  headCommittedAtMs: (path: string) => Promise<number | undefined>;
  /** Task ids holding a `refs/rmd-dispatch/<id>` ref on origin. */
  dispatchClaims: () => Promise<ReadonlySet<string> | undefined>;
  /** Head branch names of every open PR. */
  openPrHeads: () => Promise<ReadonlySet<string> | undefined>;
  /** Task id -> the newest origin/main commit carrying its `Remudero-Task` trailer. */
  credits: () => Promise<ReadonlyMap<string, TaskCredit> | undefined>;
}

export interface WorktreeRetireOptions extends Partial<WorktreeRetirePorts> {
  /** The checkout whose `git worktree list` names the roots. */
  operatorCheckout: string;
  clock?: Clock;
  minAgeMs?: number;
  intervalMs?: number;
  creditWindowMs?: number;
  /** `owner/repo` for the open-PR read; derived from the checkout's origin url when omitted. */
  repoSlug?: string;
  /** Defaults to {@link CONTAINER_HOME_PREFIX}; a fixture whose TMPDIR sits under it names another. */
  containerHomePrefix?: string;
}

type Log = (step: string, extra?: Record<string, unknown>) => void;

/** `git worktree list --porcelain` into registrations, in git's order (the main worktree first). */
export function parseWorktreeList(porcelain: string): WorktreeRegistration[] {
  const out: WorktreeRegistration[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l !== "");
    const first = lines[0];
    if (first === undefined || !first.startsWith("worktree ")) continue;
    const reg: WorktreeRegistration = { path: first.slice("worktree ".length), bare: false, locked: false };
    for (const line of lines.slice(1)) {
      if (line.startsWith("HEAD ")) reg.head = line.slice(5);
      else if (line.startsWith("branch ")) reg.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "bare") reg.bare = true;
      else if (line === "locked" || line.startsWith("locked ")) reg.locked = true;
    }
    out.push(reg);
  }
  return out;
}

/** The task id a `run-<id>-<epochMs>` branch was cut for; undefined for any other shape. */
export function taskIdOfRunBranch(branch: string | undefined): string | undefined {
  const m = branch === undefined ? null : /^run-(.+)-(\d{10,})$/.exec(branch);
  if (!m || m[1] === "unfiled") return undefined;
  return m[1];
}

/** Every `Remudero-Task: <id>` line in `git log --format=%H%x1f%ct%x1f%B%x1e` output; newest credit wins. */
export function parseTaskCredits(log: string): Map<string, TaskCredit> {
  const credits = new Map<string, TaskCredit>();
  for (const record of log.split("\x1e")) {
    const [sha, ct, body] = record.replace(/^\n+/, "").split("\x1f");
    const committedAtMs = Number(ct) * 1000;
    if (!sha || body === undefined || !Number.isFinite(committedAtMs)) continue;
    for (const m of body.matchAll(/^Remudero-Task: (\S+)\s*$/gm)) {
      const prior = credits.get(m[1]!);
      if (!prior || prior.committedAtMs < committedAtMs) credits.set(m[1]!, { sha, committedAtMs });
    }
  }
  return credits;
}

/** `owner/repo` from a GitHub remote url (https or scp form); undefined for anything else. */
export function repoSlugOfRemoteUrl(url: string): string | undefined {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

interface ClassifyContext {
  nowMs: number;
  minAgeMs: number;
  operatorCheckout: string;
  containerHomePrefix: string;
  claims: ReadonlySet<string> | undefined;
  openHeads: ReadonlySet<string> | undefined;
  credits: ReadonlyMap<string, TaskCredit> | undefined;
}

async function classifyOne(
  reg: WorktreeRegistration, index: number, ports: WorktreeRetirePorts, ctx: ClassifyContext,
): Promise<WorktreeRetireOutcome> {
  const taskId = taskIdOfRunBranch(reg.branch);
  const base = { path: reg.path, ...(reg.branch ? { branch: reg.branch } : {}), ...(taskId ? { taskId } : {}) };
  const keep = (reason: WorktreeKeepReason, detail: Record<string, unknown> = {}): WorktreeRetireOutcome =>
    ({ ...base, verdict: "kept", reason, detail });

  if (index === 0 || reg.path === ctx.operatorCheckout) return keep("main-worktree");
  if (reg.bare) return keep("bare");
  if (reg.path.startsWith(ctx.containerHomePrefix)) return keep("container-registration");
  if (!ports.pathExists(reg.path)) return keep("path-missing", { pruned: false });
  if (reg.locked) return keep("locked");

  const activity = ports.lastActivityMs(reg.path);
  if (activity === undefined) return keep("unreadable", { what: "age" });
  const ageMs = ctx.nowMs - activity;
  if (ageMs < ctx.minAgeMs) return keep("too-young", { age_ms: ageMs });

  if (taskId !== undefined) {
    if (ctx.claims === undefined) return keep("claims-unreadable");
    if (ctx.claims.has(taskId)) return keep("dispatch-claimed", { ref: `refs/rmd-dispatch/${taskId}` });
  }
  if (ctx.openHeads === undefined) return keep("pr-state-unreadable");
  const openHead = [...ctx.openHeads].find((h) => h === reg.branch || (taskId !== undefined && h.startsWith(`run-${taskId}-`)));
  if (openHead !== undefined) return keep("open-pr", { head: openHead });

  const dirty = await ports.countDirtyFiles(reg.path);
  if (dirty === undefined) return keep("unreadable", { what: "git-status" });
  if (dirty > 0) return keep("dirty", { dirty_files: dirty });

  const unpushed = await ports.unpushedCommits(reg.path);
  if (unpushed === undefined) return keep("unreadable", { what: "unpushed-commits" });
  if (unpushed === 0) return { ...base, verdict: "would-retire", reason: "fully-pushed", detail: { age_ms: ageMs } };

  const credit = taskId === undefined ? undefined : ctx.credits?.get(taskId);
  if (credit !== undefined) {
    const headAt = await ports.headCommittedAtMs(reg.path);
    if (headAt === undefined) return keep("unreadable", { what: "head-commit-time" });
    // A commit made after the crediting merge is work the merge did not carry.
    if (headAt <= credit.committedAtMs) {
      return { ...base, verdict: "would-retire", reason: "credited-by-trailer", detail: { age_ms: ageMs, credit_sha: credit.sha, unpushed_commits: unpushed } };
    }
  }
  return keep("unpushed-commits", { unpushed_commits: unpushed, ...(credit ? { credit_sha: credit.sha, committed_after_credit: true } : {}) });
}

/** Classify every registration. Pure over its ports, so a recorded inventory replays through it. */
export async function classifyRegisteredWorktrees(
  registrations: readonly WorktreeRegistration[],
  ports: WorktreeRetirePorts,
  opts: { nowMs: number; minAgeMs?: number; operatorCheckout: string; containerHomePrefix?: string },
): Promise<WorktreeRetireSummary> {
  const [claims, openHeads, credits] = await Promise.all([
    ports.dispatchClaims(), ports.openPrHeads(), ports.credits(),
  ]);
  const ctx: ClassifyContext = {
    nowMs: opts.nowMs, minAgeMs: opts.minAgeMs ?? DEFAULT_RETIRE_MIN_AGE_MS, operatorCheckout: opts.operatorCheckout,
    containerHomePrefix: opts.containerHomePrefix ?? CONTAINER_HOME_PREFIX, claims, openHeads, credits,
  };
  const summary: WorktreeRetireSummary = { registered: registrations.length, wouldRetire: [], kept: [] };
  // Sequential on purpose: one git child at a time, never a burst of ~100 on the daemon's host.
  for (const [index, reg] of registrations.entries()) {
    const outcome = await classifyOne(reg, index, ports, ctx);
    (outcome.verdict === "would-retire" ? summary.wouldRetire : summary.kept).push(outcome);
  }
  return summary;
}

function gitLog(log: Log) {
  return (step: string, extra: Record<string, unknown>) => log(step, extra);
}

function newestMtimeMs(paths: readonly string[]): number | undefined {
  let newest: number | undefined;
  for (const p of paths) {
    try {
      const m = statSync(p).mtimeMs;
      if (newest === undefined || m > newest) newest = m;
    } catch {
      // An absent HEAD log or index is normal for a fresh tree; the directory itself is required below.
      continue;
    }
  }
  return newest;
}

/** The newest of the tree's own mtime and its gitdir's HEAD, index and HEAD log. */
export function defaultLastActivityMs(path: string, log: Log = () => {}): number | undefined {
  if (newestMtimeMs([path]) === undefined) return undefined;
  let gitDir: string;
  try {
    gitDir = pinWorktreeGit(path, gitLog(log)).gitDir;
  } catch (e) {
    log("worktree_retire.age_unreadable", { path, error: String((e as Error)?.message ?? e) });
    return undefined;
  }
  return newestMtimeMs([path, join(gitDir, "HEAD"), join(gitDir, "index"), join(gitDir, "logs", "HEAD")]);
}

async function treeGit(path: string, args: string[], log: Log, what: string, maxBuffer?: number): Promise<string | undefined> {
  try {
    return await hostWorktreeGitAsync(path, args, {
      // Status must not refresh the index: that would reset the tree's age on every pass.
      env: { GIT_OPTIONAL_LOCKS: "0" }, timeout: GIT_TIMEOUT_MS, log: gitLog(log), ...(maxBuffer ? { maxBuffer } : {}),
    });
  } catch (e) {
    log("worktree_retire.read_failed", { path, what, error: String((e as Error)?.message ?? e) });
    return undefined;
  }
}

/** Head branch names of every open PR on `repoSlug`; undefined when the read fails or is malformed. */
export async function defaultOpenPrHeads(
  repoSlug: string | undefined, log: Log = () => {}, read: (args: string[]) => Promise<unknown> = (args) => ghJsonAsync(args),
): Promise<ReadonlySet<string> | undefined> {
  if (repoSlug === undefined) {
    log("worktree_retire.read_failed", { what: "open-prs", error: "no GitHub repo slug for the operator checkout" });
    return undefined;
  }
  let rows: unknown;
  try {
    rows = await read(["pr", "list", "--repo", repoSlug, "--state", "open", "--limit", "1000", "--json", "headRefName"]);
  } catch (e) {
    log("worktree_retire.read_failed", { what: "open-prs", error: String((e as Error)?.message ?? e) });
    return undefined;
  }
  if (!Array.isArray(rows) || rows.some((r) => typeof (r as { headRefName?: unknown })?.headRefName !== "string")) {
    log("worktree_retire.read_failed", { what: "open-prs", error: "gh pr list returned an unexpected shape" });
    return undefined;
  }
  return new Set(rows.map((r) => (r as { headRefName: string }).headRefName));
}

/** The real ports for `opts.operatorCheckout`; each one an explicit override replaces. */
export function defaultWorktreeRetirePorts(opts: WorktreeRetireOptions, log: Log): WorktreeRetirePorts {
  const checkout = opts.operatorCheckout;
  const clock = opts.clock ?? systemClock;
  const toInt = (out: string | undefined): number | undefined => {
    const n = out === undefined ? NaN : Number(out.trim());
    return Number.isInteger(n) ? n : undefined;
  };
  return {
    listWorktrees: async () => {
      const out = await treeGit(checkout, ["worktree", "list", "--porcelain"], log, "worktree-list");
      if (out === undefined) throw new Error(`git worktree list unreadable in ${checkout}`);
      return out;
    },
    pathExists: (path) => existsSync(path),
    lastActivityMs: (path) => defaultLastActivityMs(path, log),
    countDirtyFiles: async (path) => {
      const out = await treeGit(path, ["status", "--porcelain"], log, "git-status");
      return out === undefined ? undefined : out.split("\n").filter((l) => l.trim() !== "").length;
    },
    unpushedCommits: async (path) => toInt(await treeGit(path, ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"], log, "unpushed-commits")),
    headCommittedAtMs: async (path) => {
      const s = toInt(await treeGit(path, ["log", "-1", "--format=%ct", "HEAD"], log, "head-commit-time"));
      return s === undefined ? undefined : s * 1000;
    },
    dispatchClaims: async () => {
      const out = await treeGit(checkout, ["ls-remote", "origin", "refs/rmd-dispatch/*"], log, "dispatch-claims");
      if (out === undefined) return undefined;
      const ids = new Set<string>();
      for (const m of out.matchAll(/\trefs\/rmd-dispatch\/(\S+)$/gm)) ids.add(m[1]!);
      return ids;
    },
    openPrHeads: async () => {
      const slug = opts.repoSlug ?? repoSlugOfRemoteUrl((await treeGit(checkout, ["remote", "get-url", "origin"], log, "origin-url")) ?? "");
      return defaultOpenPrHeads(slug, log);
    },
    credits: async () => {
      const since = new Date(clock.now() - (opts.creditWindowMs ?? DEFAULT_RETIRE_CREDIT_WINDOW_MS)).toISOString();
      const out = await treeGit(checkout, ["log", "origin/main", `--since=${since}`, "--format=%H%x1f%ct%x1f%B%x1e"], log, "credits", GIT_LOG_MAX_BUFFER);
      return out === undefined ? undefined : parseTaskCredits(out);
    },
  };
}

function row(o: WorktreeRetireOutcome): Record<string, unknown> {
  return {
    path: o.path, ...(o.branch ? { branch: o.branch } : {}), ...(o.taskId ? { task_id: o.taskId } : {}),
    reason: o.reason, mode: "shadow", ...o.detail,
  };
}

const lastPassAt = new WeakMap<WorktreeRetireOptions, number>();
const inFlight = new WeakSet<WorktreeRetireOptions>();

/**
 * One shadow pass: list the operator checkout's registrations, classify each, and write one
 * `worktree_retire.would_retire` row per qualifying tree and one `worktree_retire.kept` row per refusal,
 * each naming its reason. Called on every daemon tick; it returns undefined without reading anything
 * while a pass for the same options is in flight or the last one is younger than `intervalMs`.
 */
export async function reportRetirableWorktrees(opts: WorktreeRetireOptions, log: Log): Promise<WorktreeRetireSummary | undefined> {
  const clock = opts.clock ?? systemClock;
  const nowMs = clock.now();
  const last = lastPassAt.get(opts);
  if (inFlight.has(opts) || (last !== undefined && nowMs - last < (opts.intervalMs ?? DEFAULT_RETIRE_REPORT_INTERVAL_MS))) return undefined;
  inFlight.add(opts);
  lastPassAt.set(opts, nowMs);
  try {
    const ports: WorktreeRetirePorts = { ...defaultWorktreeRetirePorts(opts, log), ...definedPorts(opts) };
    let porcelain: string;
    try {
      porcelain = await ports.listWorktrees();
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      log(WORKTREE_RETIRE_PASS_STEP, { mode: "shadow", operator_checkout: opts.operatorCheckout, reason: "worktree-list-unreadable", error });
      return { registered: 0, wouldRetire: [], kept: [], listUnreadable: error };
    }
    const summary = await classifyRegisteredWorktrees(parseWorktreeList(porcelain), ports, {
      nowMs, minAgeMs: opts.minAgeMs, operatorCheckout: opts.operatorCheckout, containerHomePrefix: opts.containerHomePrefix,
    });
    for (const o of summary.wouldRetire) log(WORKTREE_RETIRE_WOULD_RETIRE_STEP, row(o));
    for (const o of summary.kept) log(WORKTREE_RETIRE_KEPT_STEP, row(o));
    log(WORKTREE_RETIRE_PASS_STEP, {
      mode: "shadow", operator_checkout: opts.operatorCheckout, registered: summary.registered,
      would_retire: summary.wouldRetire.length, kept: summary.kept.length,
    });
    return summary;
  } finally {
    inFlight.delete(opts);
  }
}

function definedPorts(opts: WorktreeRetireOptions): Partial<WorktreeRetirePorts> {
  const keys: ReadonlyArray<keyof WorktreeRetirePorts> = ["listWorktrees", "pathExists", "lastActivityMs", "countDirtyFiles",
    "unpushedCommits", "headCommittedAtMs", "dispatchClaims", "openPrHeads", "credits"];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (opts[k] !== undefined) out[k] = opts[k];
  return out as Partial<WorktreeRetirePorts>;
}
