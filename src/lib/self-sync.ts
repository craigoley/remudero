import { execFileSync, spawnSync } from "node:child_process";

/**
 * CLI self-freshness at entry (W1-T79) — the "stale-binary" class.
 *
 * LIVE INCIDENT (2026-07-16, operator-reported): `rmd correct` existed on `main` (#138) but
 * the operator's invocation printed the OLD usage and exited — `run-task` had just built the
 * feature from a FRESH origin/main worktree while the CLI the operator was actually running
 * predated its own merge. W1-T60 made rmd self-sync the PLAN (dispatch always reads
 * `origin/main`'s blob, never a local checkout — see {@link syncPlanFromOrigin} in
 * ../run-task.ts). Nothing self-synced the CODE. The operator should never be the freshness
 * mechanism — "rmd should be managing git for me" is the requirement, verbatim. This module is
 * the CODE half of that pair.
 *
 * CONTRACT (mirrors W1-T60's shape, one rung earlier — before ANY command dispatches):
 *   - UP-TO-DATE (local HEAD === origin/main): zero output, zero mutation, zero added latency
 *     beyond the fetch already being performed.
 *   - CLEAN + BEHIND, and a fast-forward is possible: `git merge --ff-only origin/main` (the
 *     fetch already happened, so this is local-only — no second network round trip), print ONE
 *     line (`### rmd self-sync: <old>..<new>`), then invoke the caller's `reexec()` — the
 *     freshly pulled code must be what actually runs; a pulled-but-stale PROCESS is the same
 *     bug wearing a fix, since the already-loaded module graph in this process is unaffected by
 *     a merge that happens after it was imported.
 *   - DIRTY, or CLEAN-but-DIVERGED (not a fast-forward): NEVER mutate the working tree or
 *     local branches. Refuse with the exact remedy (`git pull --ff-only`, run by the operator)
 *     and a non-"proceed" result so the caller exits non-zero — the control surface never falls
 *     through on staleness (the bad-input doctrine this codebase already applies to unknown
 *     commands/args applies equally to a stale binary).
 *   - The LOOP GUARD: {@link SELF_SYNC_GUARD_ENV} set to `"1"` in the environment skips the
 *     WHOLE check (not even a fetch) and returns immediately. A real re-exec sets this on the
 *     child's env before replaying the invocation, so the freshly-execed process cannot
 *     recurse into another sync attempt no matter what it finds (even a second, unrelated
 *     staleness would just run once-stale rather than loop).
 *
 * DEGRADED-ON-FETCH-FAILURE, BY DESIGN (read before "fixing" this to fail closed): this is a
 * best-effort UX freshness check bolted onto EVERY subcommand's entry, not the fail-closed
 * PLAN-dispatch gate `syncPlanOrRefuse`/`GitFetchError` already enforce for run-task/drain/
 * daemon (that gate is unchanged by this module and still refuses a plan dispatch on a hard
 * fetch failure unless `--allow-stale`). Refusing to run `rmd anything` just because the
 * network hiccuped once would make the operator's own machine the single point of failure for
 * commands (e.g. `rmd --help`, `rmd wipe-test`) that have nothing to do with git dispatch — so
 * a fetch or rev-parse failure here degrades to "can't tell, don't block the command" rather
 * than refusing. This is a deliberate, asymmetric choice from the fail-closed PLAN gate; it is
 * recorded here so it reads as a decision, not an oversight.
 *
 * DAEMON NOTE (per the design doc, verbatim): this covers CLI/daemon STARTUP only — the one
 * moment a fresh process decides what code to run. A long-RUNNING daemon process's in-process
 * staleness (code that was fresh at boot but origin/main has since moved on, while the process
 * keeps running against its already-loaded module graph) is the WS-2 self-updater's separate
 * remit (see the daemon-freshness sibling task, which explicitly shares this module's
 * freshness PREDICATE rather than duplicating it, but owns its own restart-under-
 * SuccessfulExit=false semantics and thundering-herd concerns) — out of scope here.
 *
 * NOT TOUCHED: `src/lib/deployer.ts`'s daemon self-deploy/supervisor mechanism is a distinct,
 * already-shipped system; this module does not read, write, or otherwise interact with it.
 */

/**
 * Set on the environment of a re-exec'd child (and by any test/entry point that wants to
 * bypass a freshness check that isn't what it's exercising — see the comment in
 * test/wipe-test.test.ts's `callMain()`) so that invocation skips this check ENTIRELY. This is
 * the only thing standing between a real re-exec and an infinite loop.
 */
export const SELF_SYNC_GUARD_ENV = "RMD_SELF_SYNC_DONE";

/**
 * Injectable git invoker: `args` WITHOUT `-C <repoDir>` — the real default (built inside
 * {@link checkCliFreshness}) adds it. Tests pass a real, repoDir-scoped closure over a
 * throwaway local git fixture (same style as `gitFixture()` in test/run-task.test.ts) so the
 * ACTUAL git plumbing (fetch/rev-parse/status/merge-base/merge) is exercised — never a
 * hand-rolled git double that could silently drift from real git's behavior.
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
}

export type SelfSyncResult =
  | { status: "guarded" }
  | { status: "degraded"; reason: string }
  | { status: "up-to-date" }
  | { status: "synced"; oldSha: string; newSha: string }
  | { status: "refused"; reason: "dirty" | "diverged"; message: string };

/** Shared remedy fragment — acceptance requires the LITERAL `git pull --ff-only` text land in
 *  stderr for both refusal reasons, so operators always get the one command that either just
 *  works (dirty tree cleaned up first) or fails loudly and cleanly (a real divergence). */
const REMEDY_COMMAND = "git pull --ff-only";

/**
 * The W1-T79 entry-point freshness check. Compares local HEAD to `origin/main` in `repoDir`
 * and reacts per the CONTRACT in the module doc above. Never called with side effects unless
 * the result is `"synced"` (a real ff-merge + reexec) — every other path is read-only.
 *
 * @param repoDir  The checkout to check (the running CLI's own repo root in production).
 * @param env      Process environment to read {@link SELF_SYNC_GUARD_ENV} from (injectable —
 *                 production passes `process.env`, tests pass a plain object).
 * @param deps     Injectable git/say/warn/reexec; all default to real implementations.
 */
/** True in a CI / non-interactive runner (GitHub Actions + the common `CI` convention). The
 *  CLI-entry auto-sync is an interactive-operator convenience for the operator's own `main`
 *  checkout; a CI job checks out a specific ref it owns, so the sync must never run there — and
 *  must never read that (always-"diverged") ref as a refusal that exits the command non-zero. */
export function isCiEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  const truthy = (v: string | undefined): boolean =>
    v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return truthy(env.CI) || truthy(env.GITHUB_ACTIONS);
}

export function checkCliFreshness(
  repoDir: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  deps: SelfSyncDeps = {},
): SelfSyncResult {
  if (env[SELF_SYNC_GUARD_ENV] === "1") {
    // The loop guard: skip EVERYTHING, not even a fetch — this is what a real re-exec's
    // child sees, and it must never be able to talk itself into a second sync attempt.
    return { status: "guarded" };
  }
  if (isCiEnv(env)) {
    // CI/non-interactive: the runner checks out a SPECIFIC ref (a PR merge/head SHA), which
    // is ALWAYS "diverged" from origin/main — auto-sync is an interactive-operator convenience
    // for the operator's own `main` checkout, never CI. Without this guard, every `rmd`
    // invocation a CI job makes (lint-plan, claims, …) reads its normal PR checkout as a
    // `refused` divergence and exits 1 — W1-T79 would break its own gate on every PR.
    return { status: "guarded" };
  }

  const git: GitRunner =
    deps.git ?? ((args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }));
  const say = deps.say ?? ((msg: string) => console.log(msg));
  const warn = deps.warn ?? ((msg: string) => console.error(msg));
  const reexec = deps.reexec ?? (() => defaultReexec(env));

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

  const dirty = git(["status", "--porcelain"]).trim().length > 0;
  if (dirty) {
    const message =
      `rmd is behind origin/main (${shortSha(headSha)}..${shortSha(originSha)}) and the working tree ` +
      `has uncommitted changes -- refusing to auto-sync (never mutating uncommitted local state). ` +
      `Commit or stash your changes, then run \`${REMEDY_COMMAND}\` yourself.`;
    warn(message);
    return { status: "refused", reason: "dirty", message };
  }

  // Clean and not equal: is a fast-forward even possible? `merge-base --is-ancestor HEAD
  // origin/main` exits 0 IFF HEAD is an ancestor of origin/main. A non-zero exit (local has
  // its own unpublished commits, or the histories have genuinely diverged/are unrelated)
  // means NO fast-forward is possible -- treated identically to "diverged" either way, since
  // the contract is the same either way: never mutate, never merge/rebase on the operator's
  // behalf.
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
    return { status: "refused", reason: "diverged", message };
  }

  // CLEAN + BEHIND + ff-possible: the one case rmd is allowed to mutate anything. The fetch
  // already ran above, so this merge is local-only -- no second network round trip.
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
 * Real re-exec: replays THIS process's own invocation (`process.execArgv` — tsx's loader
 * flags live there, not in `process.argv`, so a plain `process.argv.slice(1)` respawn would
 * lose the `--import tsx/loader` registration and fail to even parse the `.ts` entry file —
 * with the loop-guard env added, `stdio: "inherit"` so the child's own output/exit code are
 * indistinguishable from a single un-re-exec'd run. This process then exits with exactly the
 * child's exit code, so it never falls through to dispatch itself (the freshly pulled code,
 * not this stale one, must be what actually runs).
 */
// diff-cov: process-boundary — re-execs process.execArgv and exits with the child's code; a real
// re-exec cannot carry a coverage hit without forking the suite (W1-T221, see docs/review-gate.md).
function defaultReexec(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
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
 * A LONG-RUNNING SERVICE's freshness ASSESSMENT (`rmd daemon`, `rmd serve`) — W1-T255.
 *
 * Unlike {@link checkCliFreshness} (the interactive-operator path that ff-syncs+re-execs on
 * clean+behind and REFUSES with exit-1 on dirty/diverged), a long-running service must NEVER
 * exit-1 on tree state and NEVER self-re-exec:
 *   - DIRT NEVER BLOCKS A SERVICE. The daemon writes into its OWN working tree (DECISIONS.md
 *     decision records, feedback captures, `state/` runtime exhaust), so a dirty tree is its
 *     normal steady state — the #707-aftermath incident was checkCliFreshness's dirty-refusal
 *     crash-looping the daemon on every launchd restart. Dirty => report it, run anyway.
 *   - BEHIND ORIGIN is the DEPLOY SUPERVISOR's remit (WS-2, {@link ../lib/deployer}), not a
 *     per-CLI-entry re-exec (which would thundering-herd every service). Behind => report it,
 *     run the stale code, leave catch-up to the supervisor.
 *   - GENUINE CORRUPTION (an unreadable/unparseable plan) is NOT this check's job — it still
 *     fails loudly downstream in loadPlan. Freshness never manufactures a refusal from it.
 *
 * This ASSESSES ONLY (no mutation, no re-exec, no refusal); the caller ledgers
 * `daemon.tree_dirty` / `daemon.stale_code` and proceeds. A fetch/rev-parse failure degrades to
 * "can't tell" — still run (a service is never blocked by a network hiccup).
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
  if (env[SELF_SYNC_GUARD_ENV] === "1") return { status: "guarded" };
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
  const dirty = git(["status", "--porcelain"]).trim().length > 0;
  const behind = headSha !== originSha ? { oldSha: headSha, newSha: originSha } : null;
  return { status: "assessed", dirty, behind };
}
