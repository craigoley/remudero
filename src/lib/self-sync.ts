import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
// TYPE-ONLY, so this stays a one-way dependency at runtime: the import is erased, daemon.ts
// imports nothing from here, and lib/daemon.ts's "never touches the filesystem" purity is
// untouched by a module that shells out to git.
import type { DaemonFreshness } from "./daemon.js";

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
  | { status: "refused"; reason: "dirty" | "diverged" | "off-main"; message: string }
  /**
   * W1-T452: this repoDir is a LINKED WORKTREE, so self-sync declines to refuse OR to mutate.
   *
   * A DISTINCT STATE RATHER THAN `guarded`, deliberately. `guarded`'s own doc says it skips
   * EVERYTHING, "not even a fetch" — returning it from a point AFTER the fetch has already run
   * would make that doc false, and the loop-guard meaning is worth keeping unambiguous. Only one
   * consumer branches on this type at all (`freshness.status === "refused"` in `run-task.ts`'s
   * gate), so a new arm costs nothing and reads honestly at every call site.
   */
  | { status: "worktree"; gitDir: string };

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

  // W1-T452: A LINKED WORKTREE IS SUPPOSED TO HAVE DIVERGED — THAT IS WHAT A BRANCH IS.
  //
  // A worktree sits on `run-<taskId>-<epochMs>`, so from its FIRST COMMIT it is no longer an
  // ancestor of origin/main and the `diverged` refusal below fires. `main()` turns any `refused`
  // into `process.exit(1)`, so every subsequent verb died IN THE PLACE THE WORKER WAS TOLD TO WORK.
  // MEASURED: fourteen of the last fifteen implement runs relocated to the daemon's live checkout to
  // run `check-proof`, `preflight --ci-parity`, `review` and `gh pr create` — and their commits
  // landed there as collateral, which is the actual damage.
  //
  // IT MUST CLEAR *BOTH* REFUSALS, and that is why this sits above `dirty` rather than beside the
  // divergence test. A worktree trips `diverged` once it has a commit, but a worktree that is merely
  // BEHIND and still fast-forwardable falls through to W1-T445's `off-main` refusal instead — same
  // exit 1, different reason. Clearing only `diverged` would leave the worker refused for the other
  // one and look like the fix had failed. It also skips `dirty`, which a worktree mid-task always is.
  //
  // PLACED AFTER THE FETCH ON PURPOSE: the fetch has already run by here, so a verb that wanted
  // origin refreshed still gets it. Only the REFUSALS and the ff-merge are skipped — and the merge
  // must never run here anyway, which is precisely what W1-T445 established.
  //
  // DETECTION IS GIT'S OWN DEFINITION OF A LINKED WORKTREE: `--git-dir` differs from
  // `--git-common-dir`. MEASURED at ab85e661 on all four shapes — linked worktree
  // (`…/.git/worktrees/<name>` vs `…/.git`) => true; main checkout (`.git` vs `.git`) => false;
  // a SUBDIR of the main checkout => false; a directory with no `.git` => throws.
  //
  // THE PATHS MUST BE RESOLVED BEFORE COMPARING AND THE RAW STRINGS MUST NOT BE. From a subdir git
  // answers `--git-dir` ABSOLUTE and `--git-common-dir` RELATIVE (`/…/.git` vs `../.git`) — string-
  // different, same directory. A raw comparison would classify the operator's own checkout as a
  // worktree and relax the guard exactly where it protects a human, which is strictly worse than the
  // defect it fixes.
  //
  // A THROW IS CAUGHT AND FALLS THROUGH, never propagates: with no `.git` at all this function
  // already returns `degraded` from the fetch above, and that path must keep working — `/app` in the
  // container image has no `.git`, and this must not start throwing where it used to degrade.
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

  // W1-T445: THE REF THIS WOULD MOVE MUST BE `main`, and until this check existed nothing asked.
  // The three refusals above protect the WORKING TREE and the HISTORY; none of them protects the
  // REF. `repoDir` is `resolveRepoRoot(argv, process.cwd())` -- the toplevel of wherever the verb
  // was invoked -- so inside a worktree this function was handed that worktree and would advance
  // ITS branch. Observed: a session cut `run-W1-T445-…` at 14:47, ran one unguarded verb at 14:52,
  // and the reflog recorded `merge origin/main: Fast-forward` on that branch before its first
  // commit. Nothing was lost, but the base it was measuring against moved mid-task.
  //
  // WHY THE BRANCH AND NOT "AM I THE INSTALL": that question cannot be answered from inside this
  // process. `bin/rmd` execs `$DIR/src/run-task.ts` relative to ITSELF, so a worktree's own
  // `./bin/rmd` loads that worktree's `src/` and `import.meta.url` resolves there too -- every
  // checkout believes it is the install. The branch is the property that is actually legible, and
  // it matches the scope the CI guard above already states in prose: an interactive-operator
  // convenience for the operator's own `main` checkout.
  //
  // A DETACHED HEAD REFUSES TOO, DELIBERATELY. It moves no branch ref, so nothing is "lost" -- but
  // this repo cuts `git checkout --detach origin/main` constantly to run a BASE-side full glob, and
  // silently advancing that HEAD would turn a base-vs-head comparison into head-vs-head. That is a
  // wrong ANSWER rather than a lost ref, which is worse.
  //
  // PLACED HERE, AFTER the divergence check, ON PURPOSE: it speaks only in the case that would
  // otherwise have mutated. A branch check earlier would print a refusal on every verb run from a
  // worktree that happens to be behind, which is most of them, and noise on a healthy path is how a
  // real warning stops being read.
  const branch = currentBranch(git);
  if (branch !== "main") {
    const where = branch === undefined ? "a DETACHED HEAD" : `branch \`${branch}\``;
    const message =
      `rmd is behind origin/main (${shortSha(headSha)}..${shortSha(originSha)}) but this checkout is ` +
      `on ${where}, not \`main\` -- refusing to auto-sync (never moving a ref that is not main). ` +
      `Self-sync exists to keep the operator's own \`main\` checkout fresh; fast-forwarding here ` +
      `would move your work's base out from under it. Run \`${REMEDY_COMMAND}\` yourself if that is ` +
      `really what you want.`;
    warn(message);
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
 * The branch HEAD points at, or `undefined` for a detached HEAD.
 *
 * `git symbolic-ref --short -q HEAD` is the read that answers this WITHOUT guessing, and the
 * alternative was rejected on MEASURED behaviour rather than taste: on a detached HEAD
 * `rev-parse --abbrev-ref HEAD` prints the literal string `HEAD` (verified), so it reports a
 * plausible branch NAME for a state that has no branch at all. `symbolic-ref -q` exits 1 there
 * and prints nothing, which is the difference this function is built on; `-q` also keeps the
 * detached case off stderr.
 *
 * W1-T119 SHAPE: a git failure and a detached HEAD both land in the catch and both return
 * `undefined`, which is correct HERE only because the caller treats "not provably on main" as
 * REFUSE — the fail-closed direction. A reader that fails to answer must never license the mutation.
 */
function currentBranch(git: GitRunner): string | undefined {
  try {
    // No empty-string guard: on success `symbolic-ref -q` always prints a ref name, and the
    // detached case is the non-zero exit handled below — so an `|| undefined` here would be a
    // branch no falsifier could ever redden. Verified: exit 0 prints `main`, detached exits 1
    // and prints nothing.
    return git(["symbolic-ref", "--short", "-q", "HEAD"]).trim();
  } catch {
    return undefined;
  }
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
  // `-uno` — TRACKED MODIFICATIONS ONLY, and this MATCHES `deploy/entrypoint.sh` EXACTLY, which is
    // the whole point rather than a tidy-up. This value now drives a RESTART DECISION (#1706 wires it
    // through `daemonFreshnessFromService` to the daemon's freshness guard), and the thing that must
    // succeed after that guard fires is the entrypoint's sync. That script tests
    // `git status --porcelain -uno` and refuses on any TRACKED modification, so a guard counting
    // UNTRACKED files was strictly stricter than the step it gates: one stray untracked path
    // suppressed a restart the entrypoint would have serviced happily. Not hypothetical here — an
    // untracked `.claude/` blocked the operator's self-sync TWICE in one day before it was ignored.
    //
    // ALIGNING DOWN IS SAFE IN THE ONLY DIRECTION THAT MATTERS: it can only ever PERMIT restarts the
    // entrypoint can complete, never permit one it would refuse. The opposite alignment — an
    // INTERSECTING predicate, as `treeFfSafe` uses — would be actively wrong here, and deliberately
    // so: `treeFfSafe` governs the MINI's deploy supervisor, while the script that must succeed after
    // a stale exit on AZURE is `entrypoint.sh`, which refuses on ANY tracked modification, unscoped,
    // and says so in its own refusal text. An intersecting guard would report stale on a tree the
    // entrypoint then refuses to sync — same sha, same staleness, exit again: the relaunch storm
    // `DaemonStopReason`'s doc says must never reach an exit. That divergence is DECLARED, not
    // accidental, so this aligns with the entrypoint and NOT with the deployer.
    //
    // `checkCliFreshness` above KEEPS the unscoped form deliberately. Its dirty check REFUSES rather
    // than assesses, relaxing it is W1-T446's scope, and that task is `verify: human` precisely
    // because loosening a blocking guard is the operator's call. This edit is scoped to the assessing
    // sibling for that reason.
    const dirty = git(["status", "--porcelain", "-uno"]).trim().length > 0;
  const behind = headSha !== originSha ? { oldSha: headSha, newSha: originSha } : null;
  return { status: "assessed", dirty, behind };
}

/**
 * {@link ServiceFreshness} → {@link DaemonFreshness}: the ADAPTER that finally supplies
 * `DaemonDeps.checkFreshness` (daemon.ts). W1-T126 shipped the consumer in 2026; its only
 * writers were ever test fakes, so `deps.checkFreshness?.()` was `undefined` on every
 * production boot and the stale self-restart has NEVER fired — measured on the Azure daemon's
 * own ledger, 0 `daemon_selfrestart_for_freshness` rows in 6,838.
 *
 * WHY THIS PREDICATE AND NOT {@link checkCliFreshness}, which the W1-T126 doc gestured at.
 * checkCliFreshness cannot answer the question AT ALL on a container, for two independent
 * reasons, and the first is fatal rather than merely undesirable:
 *   1. IT REFUSES. `deploy/entrypoint.sh` boots the daemon with `git checkout --detach`, so
 *      the checkout is on a DETACHED HEAD (verified on the live container). W1-T445's branch
 *      guard refuses exactly that — `{ status: "refused", reason: "off-main" }` — a result
 *      with no sha pair and no `stale` field, which does not fit `DaemonFreshness` in any
 *      direction. The mutation objection below is almost secondary to this one.
 *   2. IT MUTATES. It ff-merges and re-execs. A daemon must never re-exec itself (that is the
 *      supervisor's job) and must never move a ref as a side effect of ASKING a question.
 * checkServiceFreshness is the sibling built for exactly this caller: read-only, fetch-then-
 * compare, works detached because it compares SHAs rather than branch names, and degrades to
 * "can't tell" on a network hiccup. Nothing here needs to fetch the code — the entrypoint
 * already clones-or-fast-forwards on every boot, so the daemon's whole job is to DETECT and
 * exit non-zero; `daemonExitCode("stale")` is 1 and docker's `--restart=on-failure` (launchd's
 * `KeepAlive{SuccessfulExit:false}` on the mini) does the rest.
 *
 * EVERY NON-`assessed` STATUS IS `{ stale: false }`, deliberately. `guarded` (a CI job, or
 * `RMD_SELF_SYNC_DONE=1`) and `degraded` (fetch failed) both mean "I could not tell", and the
 * fail-safe direction for a restart trigger is NOT to restart — the W1-T255 doctrine that a
 * service is never blocked, or here bounced, by a network hiccup.
 *
 * AND A DIRTY TREE IS NOT STALE, which is the one clause that is not a straight translation.
 * `behind` alone would be a RESTART LOOP: entrypoint.sh REFUSES to sync a tree with tracked
 * modifications ("REFUSING to sync: the work tree has uncommitted changes"), so the restarted
 * container comes back on the SAME old sha, reads the same staleness, and exits again — the
 * relaunch storm `DaemonStopReason`'s own doc says must never be allowed to reach an exit
 * (the 2026-07-22 `paused` incident, ~10s apart until bootout). Restarting is only correct
 * when a restart can actually CLEAR the condition, and on a dirty tree it provably cannot.
 * The staleness is still recorded: `serviceFreshnessGate` (run-task.ts) ledgers
 * `daemon.stale_code`/`daemon.tree_dirty` from this same predicate at boot.
 *
 * `installNeeded` is deliberately never set, so `DaemonDeps.runInstall` stays unwired. It
 * would be redundant: the restart re-enters `serviceFreshnessGate`, which already calls
 * `ensureInstallFresh(repoDir)` on every `rmd daemon` boot — the install-then-restart ordering
 * W1-T151 asks for, already satisfied one layer up, on the path a restart is guaranteed to take.
 */
export function daemonFreshnessFromService(svc: ServiceFreshness): DaemonFreshness {
  if (svc.status !== "assessed") return { stale: false };
  if (svc.dirty) return { stale: false };
  if (!svc.behind) return { stale: false };
  return { stale: true, oldSha: svc.behind.oldSha, newSha: svc.behind.newSha };
}
