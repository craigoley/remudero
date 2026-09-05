import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
// Type-only: erased at runtime, so daemon.ts stays a one-way dependency and keeps its
// filesystem-free purity even though this module shells out to git.
import type { DaemonFreshness } from "./daemon.js";
// Why: a deliberate runtime (not type-only) import. treeFfSafe is deployer.ts's own dirty-vs-
// incoming predicate, reused here rather than re-derived, at the accepted cost of widening this
// module's (and so the whole CLI's) startup import graph. Falsifier: a second intersection of
// dirty-vs-incoming logic appearing in this file. docs/forensics/self-sync.md#imports.
import { treeFfSafe } from "./deployer.js";

/**
 * CLI self-freshness at entry (W1-T79) — the "stale-binary" class: keeps the CODE fresh the way
 * W1-T60 already keeps the dispatched PLAN fresh (see {@link syncPlanFromOrigin} in
 * ../run-task.ts). Nothing used to self-sync the CODE, so a stale checkout could run a command
 * it no longer matched (2026-07-16, `rmd correct`).
 *
 * Contract, checked in order before any verb dispatches: up-to-date (HEAD === origin/main) is a
 * no-op; clean+behind with a possible fast-forward merges (`git merge --ff-only origin/main`),
 * prints one line, and re-execs so the freshly pulled code actually runs; dirty or
 * clean-but-diverged never mutates and refuses with the exact remedy (`git pull --ff-only`) so
 * the caller exits non-zero; {@link SELF_SYNC_GUARD_ENV} = `"1"` skips the whole check, not even
 * a fetch, so a re-exec's child can never recurse into a second attempt.
 *
 * Degraded, not refused, on a fetch/rev-parse failure: a network hiccup must never block a
 * best-effort UX check like `rmd --help`, unlike the fail-closed plan-dispatch gate
 * (`syncPlanOrRefuse`/`GitFetchError`) run-task/drain/daemon already enforce.
 *
 * Scope: CLI/daemon STARTUP only. A long-running daemon's in-process staleness is the
 * daemon-freshness sibling's remit; `src/lib/deployer.ts`'s self-deploy/supervisor mechanism is
 * separate again. Forensics for this file: docs/forensics/self-sync.md.
 */

/**
 * Set on a re-exec'd child's environment (and by any test that wants to bypass a check it isn't
 * exercising, e.g. test/wipe-test.test.ts's `callMain()`) to skip this check entirely — the only
 * thing standing between a real re-exec and an infinite loop.
 */
export const SELF_SYNC_GUARD_ENV = "RMD_SELF_SYNC_DONE";

/**
 * Injectable git invoker: `args` without `-C <repoDir>` — the real default (built inside
 * {@link checkCliFreshness}) adds it. Tests pass a closure over a throwaway git fixture, never a
 * hand-rolled double that could drift from real git's behavior.
 */
export type GitRunner = (args: string[]) => string;

export interface SelfSyncDeps {
  /** Defaults to a real `git -C <repoDir> <args>` via `execFileSync`. */
  git?: GitRunner;
  /** Prints the one-line `### rmd self-sync: <old>..<new>` notice. Defaults to `console.log`. */
  say?: (msg: string) => void;
  /** Prints the refusal + remedy. Defaults to `console.error`. */
  warn?: (msg: string) => void;
  /**
   * Re-invokes the CLI so the freshly-pulled code is what actually runs. Defaults to
   * {@link defaultReexec}, a real re-exec of this process's own invocation with the
   * loop-guard env added. Tests inject a spy that just records the call — never forking.
   */
  reexec?: () => void;
  /**
   * W1-T486: one ledger-shaped line per distinct refusal reason per process, no-op by default.
   * Carries `reason` and the two shas already in `warn()`'s message, plus a dirty-path `count`
   * for `reason: "dirty"` — never the paths themselves (can hold customer/credential material).
   * Why not a real ledger here: `loadConfig()` pulls in `resolveClaudeBin()`, which throws where
   * no claude binary exists. docs/forensics/self-sync.md#selfsyncdepslog.
   */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

export type SelfSyncResult =
  | { status: "guarded" }
  | { status: "degraded"; reason: string }
  | { status: "up-to-date" }
  | { status: "synced"; oldSha: string; newSha: string }
  | { status: "refused"; reason: "dirty" | "diverged" | "off-main"; message: string }
  /**
   * W1-T452: `repoDir` is a linked worktree, so self-sync declines to refuse or to mutate.
   *
   * A distinct state rather than `guarded`, deliberately: `guarded` means it skipped everything,
   * not even a fetch, and this returns after the fetch already ran. Why:
   * docs/forensics/self-sync.md#selfsyncresult-the-worktree-state.
   */
  | { status: "worktree"; gitDir: string };

/** Shared remedy fragment: the literal text must land in stderr for both refusal reasons, so
 *  operators get one command that either just works or fails loudly and cleanly. */
const REMEDY_COMMAND = "git pull --ff-only";

/** True in a CI / non-interactive runner. A CI job checks out a specific ref it owns, always
 *  "diverged" from origin/main, so auto-sync (an interactive-operator convenience) must never
 *  read that as a refusal that exits the command non-zero. */
export function isCiEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  const truthy = (v: string | undefined): boolean =>
    v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return truthy(env.CI) || truthy(env.GITHUB_ACTIONS);
}

/**
 * Is THIS process already a self-sync re-exec child? Read from both the injected `env` and the
 * real `process.env`: {@link defaultReexec} sets {@link SELF_SYNC_GUARD_ENV} on the child's real
 * process environment, which it cannot inject into whatever object a later caller passes here —
 * re-entrancy is a property of the process, not of one call's argument. The injected argument
 * still wins when it carries the guard, so a test can still force the branch with a plain object.
 *
 * Trap (CLAUDE.md's Code traps section, #2237): reading only the injected argument once caused
 * an unbounded re-exec chain. docs/forensics/self-sync.md#alreadyselfsynced.
 */
function alreadySelfSynced(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return env[SELF_SYNC_GUARD_ENV] === "1" || process.env[SELF_SYNC_GUARD_ENV] === "1";
}

/**
 * The W1-T79 entry-point freshness check. Compares local HEAD to `origin/main` in `repoDir`
 * and reacts per the contract in the module doc above; read-only except on `"synced"` (a real
 * ff-merge + reexec).
 *
 * @param env   Injectable process environment (production passes `process.env`); the loop guard
 *              also reads the real `process.env` regardless — see {@link alreadySelfSynced}.
 * @param deps  Injectable git/say/warn/reexec/log, all defaulting to real implementations.
 */
export function checkCliFreshness(
  repoDir: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  deps: SelfSyncDeps = {},
): SelfSyncResult {
  if (alreadySelfSynced(env)) {
    // The loop guard: skip everything, not even a fetch — a re-exec's child must never be able
    // to talk itself into a second sync attempt.
    return { status: "guarded" };
  }
  if (isCiEnv(env)) {
    // A CI runner checks out a specific ref, which always reads as "diverged" from origin/main;
    // without this guard every CI invocation would exit 1 on its own normal PR checkout.
    return { status: "guarded" };
  }

  const git: GitRunner =
    deps.git ?? ((args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }));
  const say = deps.say ?? ((msg: string) => console.log(msg));
  const warn = deps.warn ?? ((msg: string) => console.error(msg));
  const reexec = deps.reexec ?? (() => defaultReexec(env));
  const log = deps.log ?? (() => {});

  try {
    // Same call shape as W1-T60's syncPlanFromOrigin: `git fetch --quiet origin` only ever
    // moves remote-tracking refs, never the working tree or local branches.
    git(["fetch", "--quiet", "origin"]);
  } catch (err) {
    return { status: "degraded", reason: `git fetch origin failed in ${repoDir}: ${String(err)}` };
  }

  let headSha: string;
  let originSha: string;
  try {
    headSha = git(["rev-parse", "HEAD"]).trim();
    originSha = git(["rev-parse", "origin/main"]).trim();
  } catch (err) {
    return { status: "degraded", reason: `could not resolve HEAD/origin/main in ${repoDir}: ${String(err)}` };
  }

  if (headSha === originSha) {
    return { status: "up-to-date" };
  }

  // W1-T452: a linked worktree is SUPPOSED to have diverged, so it must clear both the
  // `diverged` and `off-main` refusals below, never just one — a refused worker's mid-task
  // commits previously landed on the daemon's checkout instead (measured, 14 of 15 runs).
  // Detection is git's own worktree definition (`--git-dir` vs `--git-common-dir`, resolved to
  // absolute paths — a raw string compare misclassifies a subdir of the main checkout).
  // Why: docs/forensics/self-sync.md#the-worktree-detection-block.
  let linkedWorktree: string | undefined;
  try {
    const [gitDir, commonDir] = git(["rev-parse", "--git-dir", "--git-common-dir"]).trim().split("\n");
    const resolvedGit = resolve(repoDir, (gitDir ?? "").trim());
    const resolvedCommon = resolve(repoDir, (commonDir ?? "").trim());
    if (resolvedGit !== resolvedCommon) linkedWorktree = resolvedGit;
  } catch {
    // Not resolvable as a worktree question — fall through to the ordinary refusals unchanged.
  }
  if (linkedWorktree !== undefined) {
    return { status: "worktree", gitDir: linkedWorktree };
  }

  // Read raw, not trimmed: porcelain's status column can start with a leading space, and
  // trimming the whole blob before splitting would shift every `slice(3)` path parse by one.
  const porcelainRaw = git(["status", "--porcelain"]);
  if (porcelainRaw.trim().length > 0) {
    // W1-T446: scoped to the incoming diff, not every dirty path — a dirty file the incoming
    // fast-forward would never touch is not a hazard. Same intersect predicate (`treeFfSafe`)
    // the deploy supervisor already uses; the diff is read locally, no second fetch.
    // Why: docs/forensics/self-sync.md#the-dirty-tree-scope-check.
    const dirtyFiles = porcelainRaw
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    const incomingFiles = git(["diff", "--name-only", "HEAD..origin/main"])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const { ok, conflicting } = treeFfSafe({ dirtyFiles, incomingFiles });
    if (!ok) {
      const message =
        `rmd is behind origin/main (${shortSha(headSha)}..${shortSha(originSha)}) and the working ` +
        `tree has uncommitted changes the incoming fast-forward would also write -- refusing to ` +
        `auto-sync (never mutating uncommitted local state). Conflicting path(s): ` +
        `${conflicting.join(", ")}. Commit or stash your changes, then run \`${REMEDY_COMMAND}\` yourself.`;
      warn(message);
      // W1-T486: a COUNT, never the porcelain/conflicting paths themselves -- see the `log`
      // field's doc. The paths ARE named in `message` (stderr, operator-facing, acceptance
      // requires it) -- only the ledger row stays path-free.
      log("self_sync.refused", {
        reason: "dirty",
        old_sha: headSha,
        new_sha: originSha,
        count: conflicting.length,
      });
      return { status: "refused", reason: "dirty", message };
    }
    // Dirty, but nothing overlaps the incoming diff — not the hazard this guard exists to catch;
    // fall through to the remaining checks exactly as a clean tree would.
  }

  // Clean and not equal: is a fast-forward even possible? A non-zero exit from `merge-base
  // --is-ancestor` means local has unpublished commits, or the histories have genuinely
  // diverged — treated the same as "diverged" either way, since the contract is the same:
  // never mutate, never merge or rebase on the operator's behalf.
  let ffPossible = true;
  try {
    git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  } catch {
    ffPossible = false;
  }

  if (!ffPossible) {
    const message =
      `rmd has diverged from origin/main (${shortSha(headSha)} vs ${shortSha(originSha)}) -- not a ` +
      `fast-forward, refusing to auto-sync (never merging or rebasing on your behalf). Run ` +
      `\`${REMEDY_COMMAND}\` yourself -- it will fail cleanly if a fast-forward truly isn't ` +
      `possible, and you can resolve the divergence from there.`;
    warn(message);
    // W1-T486: no path content on this branch -- only the two shas already in `message`.
    log("self_sync.refused", { reason: "diverged", old_sha: headSha, new_sha: originSha });
    return { status: "refused", reason: "diverged", message };
  }

  // W1-T445: the ref this would move must be `main` — the refusals above protect the working
  // tree and history, none protects the ref itself, so a worktree's own branch could otherwise
  // get fast-forwarded from under its task (observed once). A detached HEAD also refuses: this
  // repo cuts one for base-side comparisons, and silently advancing it would turn a base-vs-head
  // diff into head-vs-head. Why: docs/forensics/self-sync.md#the-w1-t445-branch-guard.
  const branch = currentBranch(git);
  if (branch !== "main") {
    const where = branch === undefined ? "a DETACHED HEAD" : `branch \`${branch}\``;
    const message =
      `rmd is behind origin/main (${shortSha(headSha)}..${shortSha(originSha)}) but this checkout is ` +
      `on ${where}, not \`main\` -- refusing to auto-sync (never moving a ref that is not main). ` +
      `Self-sync exists to keep the operator's own \`main\` checkout fresh; fast-forwarding here ` +
      `would move your work's base out from under it. If you don't need this checkout synced, set ` +
      `\`${SELF_SYNC_GUARD_ENV}=1\` to skip this check without moving anything -- the read-only ` +
      `escape. Run \`${REMEDY_COMMAND}\` yourself only if you actually want to fast-forward this ` +
      `checkout to origin/main.`;
    warn(message);
    // W1-T486: no path content on this branch -- only the two shas already in `message`.
    log("self_sync.refused", { reason: "off-main", old_sha: headSha, new_sha: originSha });
    return { status: "refused", reason: "off-main", message };
  }

  // CLEAN + BEHIND + ff-possible + ON MAIN: the one case rmd is allowed to mutate anything. The
  // fetch already ran above, so this merge is local-only -- no second network round trip.
  git(["merge", "--ff-only", "origin/main"]);
  const newSha = git(["rev-parse", "HEAD"]).trim();
  say(`### rmd self-sync: ${shortSha(headSha)}..${shortSha(newSha)}`);
  reexec();
  return { status: "synced", oldSha: headSha, newSha };
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * The branch HEAD points at, or `undefined` for a detached HEAD. `git symbolic-ref --short -q
 * HEAD` answers this without guessing; `rev-parse --abbrev-ref HEAD` was rejected because on a
 * detached HEAD it prints the literal string `HEAD`, a plausible-looking name for a state with
 * no branch at all — `-q` exits 1 there instead and stays off stderr.
 *
 * A git failure and a detached HEAD both return `undefined` here, which is correct only because
 * the caller treats "not provably on main" as refuse — the fail-closed direction. Falsifier: a
 * reader that fails to answer must never license the mutation (W1-T119).
 */
function currentBranch(git: GitRunner): string | undefined {
  try {
    // No empty-string guard: `symbolic-ref -q` always prints a ref name on success, and the
    // detached case is the non-zero exit handled below.
    return git(["symbolic-ref", "--short", "-q", "HEAD"]).trim();
  } catch {
    return undefined;
  }
}

/**
 * Real re-exec: replays this process's own invocation via `process.execArgv` (not
 * `process.argv` — tsx's loader flags live there, and a plain respawn would lose them and fail
 * to parse the `.ts` entry file), loop-guard env added, `stdio: "inherit"` so the child's output
 * and exit code are indistinguishable from a single un-re-exec'd run.
 */
// diff-cov: process-boundary — re-execs process.execArgv and exits with the child's code; a real
// re-exec cannot carry a coverage hit without forking the suite (W1-T221, see docs/review-gate.md).
function defaultReexec(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  // Second, independent stop, at the spawn itself: alreadySelfSynced keeps a re-exec child from
  // deciding to sync, this keeps it from spawning even via some other route.
  if (process.env[SELF_SYNC_GUARD_ENV] === "1") return;
  const result = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...(env as NodeJS.ProcessEnv), [SELF_SYNC_GUARD_ENV]: "1" },
  });
  if (result.error) {
    console.error(`### rmd self-sync: re-exec failed: ${String(result.error)}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

/**
 * A long-running service's freshness ASSESSMENT (`rmd daemon`, `rmd serve`) — W1-T255. Unlike
 * {@link checkCliFreshness}, a service must never exit-1 on tree state and never self-re-exec:
 * DIRT NEVER BLOCKS A SERVICE (the daemon writes its own working tree, so dirt is its normal
 * steady state); being behind origin is the deploy supervisor's remit, not a per-entry re-exec;
 * genuine plan corruption is `loadPlan`'s job downstream, never manufactured here as a refusal.
 *
 * This assesses only — no mutation, no re-exec, no refusal; the caller ledgers
 * `daemon.tree_dirty`/`daemon.stale_code` and proceeds. A fetch/rev-parse failure degrades to
 * "can't tell", same as {@link checkCliFreshness}. Why: docs/forensics/self-sync.md#checkservicefreshness-module-doc.
 */
export type ServiceFreshness =
  | { status: "guarded" }
  | { status: "degraded"; reason: string }
  | { status: "assessed"; dirty: boolean; behind: { oldSha: string; newSha: string } | null };

export function checkServiceFreshness(
  repoDir: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  deps: SelfSyncDeps = {},
): ServiceFreshness {
  if (alreadySelfSynced(env)) return { status: "guarded" };
  if (isCiEnv(env)) return { status: "guarded" };

  const git =
    deps.git ?? ((args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }));
  try {
    git(["fetch", "--quiet", "origin"]);
  } catch (err) {
    return { status: "degraded", reason: `git fetch origin failed in ${repoDir}: ${String(err)}` };
  }
  let headSha: string;
  let originSha: string;
  try {
    headSha = git(["rev-parse", "HEAD"]).trim();
    originSha = git(["rev-parse", "origin/main"]).trim();
  } catch (err) {
    return { status: "degraded", reason: `could not resolve HEAD/origin/main in ${repoDir}: ${String(err)}` };
  }
  // dirty and behind are INDEPENDENT facts (a tree can be both) — the caller ledgers each.
  // `-uno`, tracked modifications only, MATCHES deploy/entrypoint.sh's own dirty check — the
  // script that must succeed after this drives a restart decision. Aligning down (rather than
  // intersecting against the incoming diff, as `checkCliFreshness` above does for a different
  // reason, W1-T446) can only ever PERMIT a restart the entrypoint can complete, never one it
  // would refuse. Why: docs/forensics/self-sync.md#checkservicefreshness-the--uno-alignment.
  const dirty = git(["status", "--porcelain", "-uno"]).trim().length > 0;
  const behind = headSha !== originSha ? { oldSha: headSha, newSha: originSha } : null;
  return { status: "assessed", dirty, behind };
}

/**
 * {@link ServiceFreshness} → {@link DaemonFreshness}: the adapter behind `DaemonDeps.checkFreshness`.
 * Not {@link checkCliFreshness}, which cannot answer this on a container — it refuses a detached
 * HEAD (how the daemon boots) with no sha pair, and it mutates, which a daemon must never do.
 *
 * Every non-`assessed` status maps to `{ stale: false }`: "I could not tell" is never a restart
 * trigger. A dirty tree is also never stale — entrypoint.sh refuses to sync one, so a restarted
 * container would come back on the same sha and loop (the relaunch storm `DaemonStopReason`'s doc
 * forbids). `installNeeded` stays unset: `serviceFreshnessGate` already installs on every boot.
 * Why: docs/forensics/self-sync.md#daemonfreshnessfromservice.
 */
export function daemonFreshnessFromService(svc: ServiceFreshness): DaemonFreshness {
  if (svc.status !== "assessed") return { stale: false };
  if (svc.dirty) return { stale: false };
  if (!svc.behind) return { stale: false };
  return { stale: true, oldSha: svc.behind.oldSha, newSha: svc.behind.newSha };
}
