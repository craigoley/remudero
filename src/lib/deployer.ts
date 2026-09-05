/**
 * lib/deployer.ts — the OUT-OF-PROCESS deploy supervisor's decision core.
 *
 * WHY THIS EXISTS. The daemon runs `tsx src/…` loaded once at start and dispatches
 * IN-PROCESS (daemon.ts awaits runTask), so a merged fix on origin/main is INERT
 * until a full restart — and `KeepAlive{SuccessfulExit:false}` makes a clean
 * self-restart impossible. Rather than drag the daemon into self-restart mechanics
 * it handles badly, a SEPARATE launchd job runs this supervisor: it fast-forwards
 * the daemon's own checkout and `launchctl kickstart -k`s the daemon — the exact
 * manual redeploy, automated, with the daemon itself NEVER modified.
 *
 * GOVERNANCE (why the defaults are conservative):
 *  - HUMAN-GATED by default: deploy only when an operator set a marker (`rmd deploy`
 *    → state/DEPLOY_REQUESTED) AND the install is behind origin/main. Craig gates
 *    MERGES today; auto-deploy-on-every-merge would silently collapse that gate, so
 *    it is an explicit opt-in (`auto`) and only ever runs behind the health check.
 *  - IDLE-GATED restart: the restart is the dangerous half (in-process dispatch ⇒ a
 *    mid-task restart SIGKILLs the worker — the #559/#581 orphan class). The pull is
 *    safe anytime; the kickstart runs ONLY at a verified idle gap, re-checked in the
 *    same breath as the kickstart to close the poll race.
 *  - HEALTH-CHECK + ROLLBACK: a bad merge CI didn't catch must degrade to "last-good
 *    daemon running + alert", never a restart-storm. After kickstart the supervisor
 *    confirms a healthy boot; on crash-loop it rolls the checkout back to the prior
 *    HEAD, restores the known-good daemon, and alerts.
 *
 * Every side effect (git, launchctl, process probes, clock, fs) is injected via
 * {@link DeployDeps} so the whole sequence is unit-testable WITHOUT touching the
 * live daemon, and the real kickstart is additionally gated behind `dryRun`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { writeAtomic } from "./fs-race-safe.js";
import { join } from "node:path";
import { stopDetail } from "./fleet-control.js";
import { appendLedger } from "./ledger.js";

// ── Pure decisions ─────────────────────────────────────────────────────────────

export interface TriggerInputs {
  /** state/DEPLOY_REQUESTED present (an operator asked for a deploy). */
  markerPresent: boolean;
  /** Explicit opt-in to deploy on ANY new main without a per-deploy marker. */
  autoMode: boolean;
  /** The install's current HEAD sha. */
  installHead: string;
  /** origin/main's sha after a fetch. */
  originMain: string;
  /** In auto mode only: the last HEAD whose deploy FAILED — never auto-retried (a manual marker
   * always retries; the operator asked explicitly). */
  lastFailedHead?: string;
  /**
   * WHY that head failed, so the skip message states the real cause. Two very different failures
   * write `lastFailedHead`, and until this existed the skip line hardcoded the health-check
   * wording for both — so a deploy stuck on a dirty tree reported "failed health-check + rolled
   * back" when no health-check had run and nothing had been rolled back. That sends the next
   * diagnosis at the wrong subsystem entirely; it cost a live investigation on 2026-08-02, where
   * the true cause sat in `state/DEPLOY_FAILED` the whole time. Undefined for records written
   * before this shipped — rendered as "reason not recorded", never guessed.
   */
  lastFailedKind?: DeployFailureKind;
  /**
   * Is the daemon process actually alive? `undefined` ⇒ not observed, and the trigger then neither
   * restarts on liveness nor claims the daemon is running. Only an explicit `false` can trigger the
   * liveness restart, so a caller that cannot probe degrades to exactly today's behaviour.
   */
  daemonAlive?: boolean;
  /**
   * Is a STOP marker set? `undefined` ⇒ unknown, treated as PRESENT (fail-safe) — see
   * {@link decideDeployTrigger}. A deliberately halted fleet must never be restarted into its own
   * refusal.
   */
  stopPresent?: boolean;
  /**
   * The sha the DAEMON PROCESS IS ACTUALLY EXECUTING, captured at ITS boot from the code it
   * loaded — never re-read from the checkout at comparison time (that always matches, which is
   * the bug this field exists to fix). `undefined` when no daemon has recorded one yet, i.e. the
   * running daemon booted before this shipped; see {@link decideDeployTrigger} for the polarity.
   */
  runningHead?: string;
}

export interface Decision {
  deploy: boolean;
  reason: string;
  /**
   * Set ONLY on the `up-to-date` skip (never re-derived from `reason` — the two up-to-date
   * wordings at `:157-158` differ by exactly this fact, and string-matching English is the shape
   * that breaks the next time the sentence is edited). `true` iff the checkout already matches
   * origin/main AND the running daemon's liveness was OBSERVED alive: a request satisfied by that
   * fleet state is done and safe to consume. Liveness unobserved (`false` or `undefined`) leaves
   * this `undefined` — a dead-or-unknown daemon under, say, a STOP marker must not have an
   * operator's request silently discarded out from under it; see runDeployCycle's skip branch.
   */
  satisfied?: boolean;
}

/**
 * Same commit, tolerating a short-vs-full sha on either side. `git rev-parse HEAD` yields 40
 * hex chars and the ledger records the same, so this is belt-and-braces — but a format mismatch
 * would read as STALE and restart the daemon every 120s under the supervisor, which is the
 * principal risk of this whole change, so the comparison is made explicitly prefix-tolerant
 * rather than left to luck.
 */
export function sameCommit(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 7 && long.startsWith(short);
}

/**
 * Deploy IFF a trigger is present AND the fleet is not already running the checkout's code.
 *
 * THE DEFECT THIS FIXES: this used to compare the CHECKOUT against origin only, so anything that
 * fast-forwarded the checkout first — an operator `git pull`, an agent's pull, or rmd's own
 * self-sync — consumed the trigger and the restart never happened. The daemon then ran stale code
 * against a current checkout indefinitely, silently (observed live 2026-08-01: checkout ff'd to
 * a0d96a9 at 21:44:29, 12 consecutive "no-op: up-to-date" cycles, console still on 3f6a1d1).
 *
 * So there are now TWO independent reasons to act, and either suffices:
 *   BEHIND       — the checkout itself is behind origin/main (needs fast-forward + restart).
 *   RUNNING STALE — the checkout is current but the running daemon is not on it (restart only).
 *
 * UNKNOWN running sha ⇒ treated as STALE (fail-EAGER). A daemon that booted before this shipped
 * records nothing, and fail-safe would mean the fix could never take effect until something else
 * restarted the daemon — which is precisely the gap being closed. Fail-eager costs exactly ONE
 * extra restart, taken at an idle gap the gate already enforces, and it is self-correcting: that
 * restart records a sha, and every later cycle compares cleanly.
 */
export function decideDeployTrigger(i: TriggerInputs): Decision {
  const behind = !sameCommit(i.installHead, i.originMain);
  const runningStale = !sameCommit(i.runningHead, i.installHead);
  const alreadyFailed = i.lastFailedHead !== undefined && i.originMain === i.lastFailedHead;
  const why = behind ? "install behind origin/main" : "daemon running stale code (install is current)";

  // LIVENESS, CHECKED BEFORE THE SHA SHORT-CIRCUIT — because that short-circuit is exactly what
  // hides a corpse. Everything below this point reasons only about SHAS, and a dead daemon's last
  // recorded boot sha still equals the checkout, so the `up-to-date` branch would report
  // "daemon running it" forever over a process that exited. That clause was an ASSUMPTION with
  // nothing behind it (recon-GF).
  //
  // THE PATH THIS CLOSES — the reversible stop. `daemonExitCode` (lib/daemon.ts) maps `stopped`
  // and `max_reached` to 0, and the daemon's KeepAlive is `{SuccessfulExit: false}`, so a clean
  // exit is NOT restarted by launchd. That is correct while a STOP marker is present. But when the
  // operator REMOVES the marker, nothing brings the daemon back: launchd will not (the exit was
  // successful) and the trigger would not (the shas still match). The fleet stays silently dead
  // while this very function reports health every 120 seconds.
  //
  // GATED ON `stopPresent`, and that gate is the whole safety argument. Restarting a daemon whose
  // STOP marker is still down would relaunch it straight back into the same refusal — a relaunch
  // storm, the class this repo has already paid for twice (~86s headroom, ~10s on 2026-07-22).
  // `stopPresent === undefined` means the caller could not read the marker; that is treated as
  // PRESENT (fail-safe), because guessing "no STOP" is what starts the storm.
  const stopUnknownOrSet = i.stopPresent !== false;
  if (i.daemonAlive === false && !stopUnknownOrSet) {
    return { deploy: true, reason: "daemon is not running and no STOP is set — restarting it" };
  }
  if (!behind && !runningStale) {
    // Only claim the daemon is running it when liveness was actually OBSERVED. An unknown answer
    // says so rather than asserting health it never checked.
    return {
      deploy: false,
      reason:
        i.daemonAlive === true
          ? "up-to-date (install HEAD == origin/main, daemon alive and running it)"
          : "up-to-date (install HEAD == origin/main; daemon liveness not observed)",
      // Only `daemonAlive === true` counts as OBSERVED — `false`/`undefined` both mean "not
      // observed" (see the reason wording above) and must not consume a request out from under a
      // fleet that might not even be running.
      satisfied: i.daemonAlive === true ? true : undefined,
    };
  }
  if (i.markerPresent) return { deploy: true, reason: `operator marker present + ${why}` };
  if (i.autoMode && alreadyFailed) {
    return { deploy: false, reason: `auto: origin/main already failed to deploy (${describeFailureKind(i.lastFailedKind)}) — not retried; see state/DEPLOY_FAILED` };
  }
  if (i.autoMode) return { deploy: true, reason: `auto mode + ${why}` };
  return { deploy: false, reason: `${why} but no operator marker (human-gated; run rmd deploy)` };
}

export interface IdleProbe {
  /** Live Claude or Codex workers (build/review/probe). */
  workers: number;
  /** `*.lock` files under state/inflight/. */
  inflightLocks: number;
  /** `<name>.lock` files beside a run worktree (an active build). */
  worktreeLocks: number;
  /**
   * The signals whose READ FAILED, named — never folded into the counts above.
   *
   * THIS REPO'S OWN LAW, stated in `buildShellRoute`: "A read failure degrades to UNKNOWN, never
   * to zero." Every one of the three reads below used to catch into `0`, and all three of those
   * zeros feed {@link daemonIsIdle}, whose TRUE answer is the gate that lets a deploy kickstart
   * the daemon. A probe that cannot see the daemon must not be able to report that the daemon is
   * quiet.
   *
   * OPTIONAL and ABSENT-MEANS-EVERYTHING-WAS-READ, so every existing {@link IdleProbe} literal is
   * unchanged and a genuinely idle fleet still reads idle byte-identically. The spelling follows
   * the house one — `listMergedHeadBranches` returns null for a FAILED read and `[]` for
   * genuinely-none — applied to three signals at once, which is why it names them rather than
   * being a bare boolean: the ledger line should say WHICH read failed.
   */
  unreadable?: readonly string[];
}

/**
 * The idle gap the manual deploy used: no worker mid-flight, no in-flight task. The
 * persistent drain loop staying alive is EXPECTED (the kickstart restarts it) — what
 * we must never interrupt is a WORKER or a claimed task.
 */
export function daemonIsIdle(p: IdleProbe): boolean {
  // UNKNOWN IS NOT IDLE. Deferring costs a bounded delay — {@link DEPLOY_IDLE_DEFER_CEILING_MS}
  // forces the deploy through after 30 minutes and LEDGERS it as forced, so an unreadable signal
  // can never wedge the fleet. Deploying into a live daemon costs a SIGKILLed worker. Those are
  // not symmetric, and the ceiling is what makes the safe direction affordable.
  if (p.unreadable !== undefined && p.unreadable.length > 0) return false;
  return p.workers === 0 && p.inflightLocks === 0 && p.worktreeLocks === 0;
}

/**
 * Does this `pgrep` failure mean "nothing matched" — a TRUE zero — or "the read did not happen"?
 *
 * `pgrep` documents exit 1 as no-processes-matched, and the original catch cited exactly that.
 * What it also swallowed: exit 127 / ENOENT, which is the binary being ABSENT — the state this
 * image shipped in until `ps`/`pgrep` were added — and pgrep's own fatal exits (2 = syntax, 3 =
 * fatal). Those are reads that produced no answer, and calling them zero workers is the defect.
 */
export function pgrepFailureMeansZero(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { status?: unknown }).status === 1;
}

/**
 * Does this `readdirSync` failure mean the directory genuinely holds no locks?
 *
 * ENOENT does: a lock directory that has never been created holds no locks, and reporting zero is
 * correct. EACCES, ENOTDIR, EIO and EMFILE do not — the directory may be full of locks nobody
 * could count.
 */
export function lockReadFailureMeansZero(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";
}

/**
 * W1-T341 — THE CEILING. `daemonIsIdle` conjoins GLOBAL fleet counters, so more concurrent
 * lanes make a common quiet window rarer without bounding how long the deploy path may keep
 * skipping while it waits for one. At N=1 that was tolerable (the daemon is idle roughly 60%
 * of the time — 20 consecutive dispatch gaps of 45-90 minutes against ~25-minute runs), so a
 * quiet window always arrived on its own; parallelism spends exactly that slack, so the same
 * gate that was merely slow at N=1 can defer indefinitely once lanes are dense.
 *
 * 30 MINUTES: comfortably above a typical single-lane run (~25 minutes, the operator's own
 * measurement), so the ceiling essentially never interrupts a lane finishing on its own
 * schedule — while staying a full order of magnitude below the "wait for ALL lanes to go
 * quiet" behaviour this replaces, so a merged fix is bounded to roughly one run's worth of
 * latency instead of an unbounded one. Too short would abort real work mid-run for no gain
 * (the pull is already safe and inert; only the RESTART is dangerous); too long reproduces
 * today's defect exactly.
 *
 * A forced deploy is not free: the kickstart SIGKILLs whatever is still running (the daemon
 * dispatches IN-PROCESS — see this file's banner), and that is only survivable because of a
 * mechanism this task does NOT add: daemon.ts's boot-time crash-recovery pass
 * (`reconstructState`/`reconstructOrphan`, W1-T12c) runs unconditionally on every daemon boot,
 * resumes any orphaned run that already has an open PR, and safely re-dispatches (via
 * `nextRunnable`) anything that does not — so the abandoned run is re-dispatched, never
 * silently lost. Silently losing paid work would be unacceptable; this ceiling is only correct
 * BECAUSE that recovery path already exists and runs on every boot, kickstart included.
 *
 * THE CONDITION AT N>1 IS UNCHANGED — this is a deliberate, minimal-scope choice: `daemonIsIdle`
 * still means "every lane is quiet" (lane-scoped thresholds are W1-T343's concern, out of scope
 * here). The bound alone carries the N>1 case: at any lane count the deploy still fires within
 * `ceilingMs` even if the fleet is never fully quiet, at the cost of a forced restart under
 * those (rare, bounded) circumstances instead of a lane-aware quiet check.
 */
export const DEPLOY_IDLE_DEFER_CEILING_MS = 30 * 60_000;

export interface IdleGateResult {
  /** The raw {@link daemonIsIdle} reading this cycle. */
  idle: boolean;
  /** The deploy should proceed now — either genuinely idle, or the ceiling elapsed. */
  proceed: boolean;
  /** `proceed && !idle`: the ceiling fired over a fleet that is still busy. */
  forced: boolean;
  /** ms since this deferral began; 0 when nothing is tracked yet (a fresh deferral, or a
   *  caller that never wired persistence — see {@link DeployDeps.deferredSince}). */
  waitedMs: number;
}

/**
 * {@link daemonIsIdle} WITH a ceiling (W1-T341's falsifier, both directions):
 *  - a fleet that NEVER goes idle still gets `proceed: true` once `waitedMs >= ceilingMs`
 *    (`forced: true`) — the unbounded-wait defect this replaces.
 *  - a fleet that goes idle BEFORE the ceiling proceeds immediately (`forced: false`) — the
 *    ceiling is a maximum wait, never a delay imposed on every deploy.
 *
 * `deferredSinceMs === undefined` (no deferral tracked yet — including a caller that never
 * wires {@link DeployDeps.deferredSince}/`setDeferredSince`) reads as a FRESH deferral:
 * `waitedMs = 0`, which can never alone reach the ceiling. A caller that does not wire
 * persistence therefore cannot be regressed into a surprise forced deploy — it degrades to
 * exactly today's unbounded wait, never the other direction.
 */
export function evaluateIdleGate(
  p: IdleProbe,
  deferredSinceMs: number | undefined,
  nowMs: number,
  ceilingMs: number = DEPLOY_IDLE_DEFER_CEILING_MS,
): IdleGateResult {
  const idle = daemonIsIdle(p);
  const waitedMs = deferredSinceMs === undefined ? 0 : Math.max(0, nowMs - deferredSinceMs);
  if (idle) return { idle: true, proceed: true, forced: false, waitedMs };
  const forced = waitedMs >= ceilingMs;
  return { idle: false, proceed: forced, forced, waitedMs };
}

/**
 * The two ways a deploy can fail and poison the auto-retry. They are NOT interchangeable: one is a
 * checkout-state problem the operator fixes locally, the other is bad code that was rolled back.
 */
export type DeployFailureKind = "dirty-tree-conflict" | "health-check-rollback";

/** Render a recorded failure kind for the skip line. An unrecorded kind is stated as unknown
 *  rather than assumed — assuming is exactly the defect this replaced. */
export function describeFailureKind(kind: DeployFailureKind | undefined): string {
  if (kind === "dirty-tree-conflict") return "dirty-tree conflict — local files block the fast-forward";
  if (kind === "health-check-rollback") return "failed health-check, rolled back";
  return "reason not recorded";
}

export interface TreeFfInputs {
  /** Paths with uncommitted local modifications (git status --porcelain). */
  dirtyFiles: string[];
  /** Paths the incoming fast-forward would change (git diff HEAD..origin/main). */
  incomingFiles: string[];
  /**
   * True when the local content at `path` is BYTE-IDENTICAL to the blob the fast-forward would
   * write there. Optional: omitted ⇒ nothing is ever discardable, i.e. exactly the pre-existing
   * abort-on-any-overlap behaviour, so a caller that does not supply it cannot regress.
   */
  sameAsIncoming?: (path: string) => boolean;
}

export interface TreeFfResult {
  ok: boolean;
  /** The locally-modified paths the ff would also touch AND whose content differs — a real conflict. */
  conflicting: string[];
  /**
   * Paths that overlap the incoming diff but whose local bytes ALREADY EQUAL what the ff would
   * write. Discarding them is lossless by definition — the fast-forward reproduces them exactly.
   */
  discardable: string[];
}

/**
 * Fast-forward is safe IFF no locally-modified file is ALSO in the incoming diff *with different
 * content*. A benign local mod the ff doesn't touch (e.g. DECISIONS.md) is preserved; a genuinely
 * divergent file would abort git, so we abort + alert first and NEVER force/reset the checkout.
 *
 * THE DEADLOCK THIS FIXES (observed live 2026-08-02, and once before on 2026-07-31). The daemon
 * writes into its OWN checkout — `plan/feedback/*.yaml` alert-intake records are its exhaust. A
 * filing PR then commits that same exhaust to main. Now the fast-forward wants to create paths the
 * daemon has already written locally, git refuses to clobber them, and the deploy aborts — so the
 * daemon's own output blocks it from pulling the commit that CONTAINS that output. Each abort
 * re-arms the never-retry latch, and the install sticks until an operator intervenes by hand. It
 * stuck for five commits and roughly two hours before anyone noticed, because the only symptom is
 * a fleet that quietly stops building.
 *
 * The resolution is not to force: it is to notice that a local file identical to the incoming blob
 * is not a conflict at all. Byte-identity is the whole safety argument — discarding such a file
 * cannot lose information, because the very next operation writes those same bytes back. Anything
 * that differs by even one byte still aborts, untouched.
 */
export function treeFfSafe(i: TreeFfInputs): TreeFfResult {
  const incoming = new Set(i.incomingFiles);
  const conflicting: string[] = [];
  const discardable: string[] = [];
  for (const f of i.dirtyFiles) {
    if (!incoming.has(f)) continue;
    if (i.sameAsIncoming?.(f)) discardable.push(f);
    else conflicting.push(f);
  }
  const ok = conflicting.length === 0;
  return { ok, conflicting, discardable };
}

export interface HealthInputs {
  /** A `daemon.boot` heartbeat was observed AFTER the kickstart instant. */
  bootObserved: boolean;
  /** Distinct non-zero daemon exits seen in the window (KeepAlive restart-storm). */
  crashCount: number;
}

export interface HealthOpts {
  /** Non-zero exits at/above this in the window ⇒ crash-loop. Default 3. */
  crashThreshold?: number;
}

export interface HealthResult {
  healthy: boolean;
  reason: string;
}

/**
 * Count `daemon.boot` ledger lines timestamped strictly after `sinceMs`. Extracted as a
 * standalone, exported, pure-over-the-file function (W1-T244) so a test can assert this
 * reads IDENTICALLY before and after a ledger rotation — the false-negative that rolled
 * back a healthy 7abe870 deploy at 00:19Z (feedback fb-1784769525147-13afc6) was exactly
 * this read silently going to zero because `daemon.boot` wasn't retained across rotation;
 * see `DECISION_RELEVANT_LEDGER_STEPS`'s companion health-window retention in ledger.ts.
 * A raw substring/regex scan, not JSON.parse + `.step ===` — matches this file's own
 * pre-existing read shape, kept unchanged by this extraction. Absent ledger ⇒ 0 boots.
 */
export function countLedgerBootsAfter(ledgerPath: string, sinceMs: number): number {
  let n = 0;
  try {
    for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
      if (!line.includes('"daemon.boot"') && !line.includes('"step":"daemon.boot"')) continue;
      const m = line.match(/"ts":"([^"]+)"/);
      if (m && Date.parse(m[1]) > sinceMs) n++;
    }
  } catch {
    /* no ledger yet — 0 boots observed */
  }
  return n;
}

/**
 * The `head_sha` on the MOST RECENT `daemon.boot` line — the sha the running daemon loaded at its
 * boot. Scans forward and keeps the last hit, because the ledger is append-only so the last boot
 * line is the current process's. `undefined` when no boot line carries one (a daemon that booted
 * before this field shipped), which {@link decideDeployTrigger} treats as stale.
 */
export function readLatestBootSha(ledgerPath: string): string | undefined {
  let sha: string | undefined;
  try {
    for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
      if (!line.includes('"daemon.boot"') && !line.includes('"step":"daemon.boot"')) continue;
      const m = line.match(/"head_sha":"([0-9a-fA-F]{7,40})"/);
      if (m) sha = m[1];
    }
  } catch {
    /* no ledger yet — nothing recorded */
  }
  return sha;
}

/**
 * The newest `daemon.boot` `head_sha` that is NOT `excludeSha` — a sha this daemon is OBSERVED to
 * have booted on, for {@link runDeployCycle}'s rollback target.
 *
 * WHY THIS EXISTS, measured: the rollback used to reset to `deps.installHead()` read at the top of
 * the cycle. That is not a known-good sha, it is just *whatever the checkout currently points at*,
 * and the checkout is mutable shared state with a second writer — `checkCliFreshness`
 * (lib/self-sync.ts) fast-forwards the install to origin/main at the entry of EVERY `rmd`
 * subcommand except daemon/serve/deploy-run, and logs nothing when it does. So a broken head that
 * merged could be pulled into the install by any unrelated `rmd` invocation BEFORE the deploy cycle
 * ran; `fromHead` then already WAS the broken head, and the rollback reset to the thing it was
 * rolling back from. Observed 2026-08-05: seven consecutive `deploy.unhealthy_rollback` rows each
 * recording `rolling_back_to == failed == a8e11cb`, the daemon down 53 minutes, recovered only when
 * an unrelated fix commit merged.
 *
 * A boot line is the strongest evidence available that a sha is runnable: the daemon reached its
 * own logging. A head that cannot boot never writes one, which is exactly why the broken sha is
 * absent from this scan and the last healthy one is not. `excludeSha` guards the one case where the
 * failed sha DID write a boot line before dying (a daemon that starts, logs, then crashes).
 *
 * `undefined` when nothing qualifies — no ledger, no boot line carrying `head_sha` (they predate
 * that field), or every candidate is `excludeSha`. Callers MUST fall back rather than treat
 * `undefined` as "roll back to nothing"; see {@link runDeployCycle}'s rollback branch.
 *
 * ROTATION: `daemon.boot` is retained by `isHealthOrDeployStep`/`HEALTH_STEP_RETENTION_WINDOW_MS`
 * (lib/ledger.ts) for 15 minutes, comfortably longer than a deploy cycle's kickstart-to-health
 * window, but a last-good boot older than that can be archived out of the live file. That degrades
 * to `undefined` and therefore to the previous behaviour — never to a worse target. Deliberately
 * reads the live ledger ONLY, matching `readLatestBootSha`/`countLedgerBootsAfter` above: this runs
 * on a 120-second supervisor cycle and must not walk ~665 rotations.
 */
export function readLastGoodBootSha(ledgerPath: string, excludeSha?: string): string | undefined {
  let sha: string | undefined;
  try {
    for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
      if (!line.includes('"daemon.boot"') && !line.includes('"step":"daemon.boot"')) continue;
      const m = line.match(/"head_sha":"([0-9a-fA-F]{7,40})"/);
      if (m && !(excludeSha && sameCommit(m[1], excludeSha))) sha = m[1];
    }
  } catch {
    /* no ledger yet — nothing recorded */
  }
  return sha;
}

/** Healthy IFF a fresh boot was seen AND the daemon did not restart-storm. */
export function assessBootHealth(i: HealthInputs, opts: HealthOpts = {}): HealthResult {
  const threshold = opts.crashThreshold ?? 3;
  if (i.crashCount >= threshold) return { healthy: false, reason: `crash-loop: ${i.crashCount} non-zero exits in the window` };
  if (!i.bootObserved) return { healthy: false, reason: "no daemon.boot heartbeat within the health window" };
  return { healthy: true, reason: "fresh boot observed, no crash-loop" };
}

function short(sha: string): string {
  return sha.slice(0, 9);
}

/** Console-up poll: how many probes, and the gap between them. ~30s total — long enough for a
 *  normal tsx boot, short enough that a 120s supervisor cycle never overlaps itself. */
const CONSOLE_UP_ATTEMPTS = 15;
const CONSOLE_UP_DELAY_MS = 2000;

// ── The orchestrated cycle (all side effects injected) ─────────────────────────

export interface DeployDeps {
  log: (step: string, data?: Record<string, unknown>) => void;
  now: () => number;
  /** git fetch origin (updates remote-tracking refs; never touches the working tree). */
  fetch: () => void;
  installHead: () => string;
  originMain: () => string;
  markerPresent: () => boolean;
  autoMode: () => boolean;
  lastFailedHead: () => string | undefined;
  /** The recorded reason `lastFailedHead` failed, so the skip line can state it. */
  lastFailedKind?: () => DeployFailureKind | undefined;
  /** Is the daemon process alive? Omitted ⇒ liveness is simply not observed (today's behaviour). */
  daemonAlive?: () => boolean | undefined;
  /** Is a STOP marker set? Omitted ⇒ unknown, which the trigger treats as PRESENT (fail-safe). */
  stopPresent?: () => boolean | undefined;
  /** Local bytes at `path` == the blob `ref` would write there. Optional: absent ⇒ no discards. */
  sameAsIncoming?: (path: string, ref: string) => boolean;
  /** Drop a local file proven byte-identical to the incoming blob (checkout if tracked, else rm). */
  discardLocal?: (path: string) => void;
  /** The sha the running daemon recorded at ITS boot; undefined if none has. */
  runningHead: () => string | undefined;
  dirtyFiles: () => string[];
  incomingFiles: (from: string, to: string) => string[];
  /** git pull --ff-only / merge --ff-only origin/main. Throws on a non-ff. */
  pullFf: () => void;
  /** git reset --hard <ref> — rollback only (recovery). */
  resetHard: (ref: string) => void;
  /**
   * The newest sha the daemon is OBSERVED to have booted on, excluding `excludeSha` — the rollback
   * target. Wired by {@link realDeployDeps} to {@link readLastGoodBootSha} over the live ledger.
   * OPTIONAL: omitted (or returning `undefined`) ⇒ the rollback falls back to the cycle's
   * `installHead()` exactly as it did before this dep existed, so an unwired caller degrades to the
   * previous behaviour rather than to no rollback at all. See {@link readLastGoodBootSha} for why
   * `installHead()` is not a safe anchor.
   */
  lastGoodBootSha?: (excludeSha: string) => string | undefined;
  probeIdle: () => IdleProbe;
  /** launchctl kickstart -k the daemon job. */
  kickstart: () => void;
  /** Poll for boot health for the configured window; returns what was observed. */
  waitBootHealth: (sinceMs: number) => HealthInputs;
  /** Record a failure for the operator (state/DEPLOY_FAILED) + the failed HEAD. */
  alert: (message: string, failedHead: string, kind: DeployFailureKind) => void;
  /** Consume the operator marker after a terminal outcome (success or rollback). */
  clearMarker: () => void;

  // ── DEFERRAL CEILING (W1-T341) ───────────────────────────────────────────────
  // `runDeployCycle` runs as a fresh launchd one-shot every ~120s (see this file's banner) —
  // no in-memory continuity across cycles — so bounding the idle-gate wait needs its OWN
  // persisted "since when has this deploy been deferred" clock. All three are OPTIONAL: a
  // caller that omits them degrades to `waitedMs` always reading 0 (see {@link evaluateIdleGate}),
  // i.e. exactly today's unbounded wait — never the other direction.
  /** When this deploy attempt's deferral began, or `undefined` if none is tracked. */
  deferredSince?: () => number | undefined;
  /** Record the start of a new deferral (only called when none is tracked yet). */
  setDeferredSince?: (ms: number) => void;
  /** Clear the deferral clock once it stops applying (no trigger, a conflict abort, or the
   *  idle gate — genuinely or by ceiling — let the deploy proceed). */
  clearDeferredSince?: () => void;

  // ── CONSOLE RESTART (the gap impl-BW/impl-BX both reported) ────────────────────
  // `rmd serve` loads its code ONCE via tsx, so the running console keeps executing
  // whatever was on disk when it last started. The console was commissioned 2026-07-29
  // and served that code through every merge for two days — including a GraphQL board
  // fetch that had already been fixed on main — until the operator restarted it by hand.
  /** launchctl kickstart -k the CONSOLE job (same mechanism as `kickstart`, serve label). */
  kickstartConsole: () => void;
  /** The console job's current pid, for before/after evidence in the ledger. */
  consolePid: () => number | undefined;
  /** Poll the configured port for a listener; true once the console is serving again.
   *  A socket-listen probe needs NO service token — see impl-BZ on why an authenticated
   *  health check was rejected. Polls internally, mirroring {@link DeployDeps.waitBootHealth}. */
  waitConsoleUp: () => boolean;
  /** Operator-visible alert that does NOT write the failed-HEAD marker.
   *  DELIBERATELY separate from {@link DeployDeps.alert}: that one also writes
   *  DEPLOY_LAST_FAILED, and `decideDeployTrigger` refuses to auto-retry a head recorded
   *  there. A console that fails to come back must never freeze the deploy pipeline for a
   *  sha the DAEMON deployed healthily. */
  alertConsoleOnly: (message: string) => void;
}

export interface DeployOpts {
  /** When true, run the WHOLE sequence but skip the real kickstart (validation). */
  dryRun?: boolean;
  health?: HealthOpts;
  /** Override {@link DEPLOY_IDLE_DEFER_CEILING_MS} (tests only; production always uses the
   *  named default). */
  idleDeferCeilingMs?: number;
}

export interface DeployResult {
  deployed: boolean;
  reason: string;
  fromHead?: string;
  toHead?: string;
  rolledBackTo?: string;
  /** Files pulled but not yet restarted (idle vanished before kickstart) — retry next tick. */
  pulledPendingRestart?: boolean;
  /** The console was kickstarted this cycle (only ever after the daemon verified healthy). */
  consoleRestarted?: boolean;
  /** The console returned to listening within its window. `false` = loud failure, NOT a rollback. */
  consoleHealthy?: boolean;
}

/**
 * Run ONE supervisor cycle. Safe to call on an interval: it no-ops unless a trigger
 * is present AND the install is behind AND the daemon is idle; it restarts only at a
 * verified idle gap; and it self-heals a bad deploy via rollback. Never throws for a
 * routine no-op — only a genuinely broken injected dep would propagate.
 */
/**
 * Restart the console AFTER a deploy has been verified healthy, and ledger the outcome.
 *
 * WHY HERE AND NOWHERE EARLIER — this ordering is the whole safety argument:
 *
 *  1. TRAP 1 (shared node_modules). `rmd daemon` AND `rmd serve` both run
 *     `serviceFreshnessGate` (run-task.ts, the `cmd === "daemon" || cmd === "serve"` branch),
 *     whose last line is `ensureInstallFresh` — a real `npm ci` when the lockfile hash moved.
 *     One node_modules is shared by both, with no lock, and emptying it under a running
 *     service is exactly what crash-looped this host once already. The gate runs at command
 *     dispatch, BEFORE the daemon's own `daemon.boot` heartbeat (daemon.ts). `assessBootHealth`
 *     refuses to call a deploy healthy without observing that heartbeat. So by the time we get
 *     here, the daemon's install has provably finished — the restarts cannot overlap. This is
 *     ordering, not luck, and `deploy-cycle-console.test.ts` asserts the sequence.
 *  2. Never restart the console onto code that is about to be rolled back. The rollback path
 *     resets the tree and re-kickstarts the DAEMON; a console started before the health verdict
 *     would be left running the reverted-away code with nothing to restart it.
 *
 * A CONSOLE FAILURE DOES NOT ROLL BACK MAIN, deliberately. The daemon — the thing that does the
 * work — is healthy on the new code; reverting it because a display surface did not come back
 * would trade a working fleet for a working page. The serve job carries unconditional
 * `KeepAlive` with a 60s ThrottleInterval, so launchd keeps trying on its own. What this owes
 * the operator is not a rollback but NOISE: a loud ledger line and an alert that does NOT poison
 * the failed-HEAD marker (see {@link DeployDeps.alertConsoleOnly}).
 */
export function restartConsole(deps: DeployDeps, toHead: string): { restarted: boolean; healthy: boolean } {
  const oldPid = deps.consolePid();
  deps.kickstartConsole();
  deps.log("deploy.console_kickstart", { to: short(toHead), old_pid: oldPid ?? null });

  if (deps.waitConsoleUp()) {
    const newPid = deps.consolePid();
    deps.log("deploy.console_ok", {
      to: short(toHead),
      old_pid: oldPid ?? null,
      new_pid: newPid ?? null,
      listening: true,
    });
    return { restarted: true, healthy: true };
  }

  const msg =
    `console did not return to listening after the deploy of ${short(toHead)} — the daemon is ` +
    `healthy on this sha and was NOT rolled back. launchd (KeepAlive) keeps retrying; if it stays ` +
    `down, check the serve log and kickstart it by hand.`;
  deps.log("deploy.console_unhealthy", { to: short(toHead), old_pid: oldPid ?? null, listening: false, rolled_back: false });
  deps.alertConsoleOnly(msg);
  return { restarted: true, healthy: false };
}

export function runDeployCycle(deps: DeployDeps, opts: DeployOpts = {}): DeployResult {
  deps.fetch();
  const fromHead = deps.installHead();
  const origin = deps.originMain();
  const ceilingMs = opts.idleDeferCeilingMs ?? DEPLOY_IDLE_DEFER_CEILING_MS;

  const markerWasPresent = deps.markerPresent();
  const decision = decideDeployTrigger({
    markerPresent: markerWasPresent,
    autoMode: deps.autoMode(),
    installHead: fromHead,
    originMain: origin,
    lastFailedHead: deps.lastFailedHead(),
    lastFailedKind: deps.lastFailedKind?.(),
    daemonAlive: deps.daemonAlive?.(),
    stopPresent: deps.stopPresent?.(),
    runningHead: deps.runningHead(),
  });
  if (!decision.deploy) {
    deps.clearDeferredSince?.(); // nothing being deferred — no active deploy attempt
    // W1-T1239: the `up-to-date` skip is the one outcome no later tick will ever revisit — a
    // request it satisfies must be CONSUMED here (via the existing clearMarker(), never a new
    // writer) or it strands as a level trigger that pre-authorises the next deploy (decideDeployTrigger
    // :161, `markerPresent` — above the auto-mode arms). Every OTHER skip (dirty tree, not-idle,
    // dry-run — none of which reach this branch; and the human-gated/already-failed skips below,
    // which never see a marker here because :161 already claimed it) must leave the marker exactly
    // as it found it, which is why this is gated on `decision.satisfied`, DATA from
    // decideDeployTrigger, rather than re-derived by matching `reason` text.
    const request: "consumed" | "retained" | "none" = !markerWasPresent
      ? "none"
      : decision.satisfied
        ? "consumed"
        : "retained";
    if (request === "consumed") deps.clearMarker();
    deps.log("deploy.skip", { reason: decision.reason, install: short(fromHead), origin: short(origin), request });
    return { deployed: false, reason: decision.reason, fromHead };
  }

  // Clean-tree guard — abort (never force) on a conflicting dirty tree.
  const tree = treeFfSafe({
    dirtyFiles: deps.dirtyFiles(),
    incomingFiles: deps.incomingFiles(fromHead, origin),
    sameAsIncoming: deps.sameAsIncoming ? (p) => deps.sameAsIncoming!(p, origin) : undefined,
  });
  if (!tree.ok) {
    deps.clearDeferredSince?.(); // blocked by the tree, not the idle gate — a distinct condition
    const msg = `deploy aborted: locally-modified files conflict with the fast-forward: ${tree.conflicting.join(", ")}`;
    deps.log("deploy.abort_dirty_tree", { conflicting: tree.conflicting });
    deps.alert(msg, origin, "dirty-tree-conflict");
    return { deployed: false, reason: "dirty-tree-conflict", fromHead };
  }
  // Lossless unblock: these overlap the incoming diff but already hold exactly the bytes the ff
  // would write, so dropping them cannot lose anything — and NOT dropping them deadlocks the
  // daemon against its own exhaust (see treeFfSafe). Logged by name: a silent discard would be
  // indistinguishable from the force-reset this deliberately is not.
  if (tree.discardable.length > 0 && deps.discardLocal) {
    for (const f of tree.discardable) deps.discardLocal(f);
    deps.log("deploy.discarded_identical", { paths: tree.discardable, count: tree.discardable.length });
  }

  // Idle gate, WITH A DEFERRAL CEILING (W1-T341) — the pull is safe anytime, but hold if a
  // task is in flight so we don't pull-then-fail-to-restart repeatedly UNLESS the deferral has
  // outlasted `ceilingMs`, in which case we proceed anyway rather than defer indefinitely. See
  // evaluateIdleGate / DEPLOY_IDLE_DEFER_CEILING_MS for the falsifier both directions cover.
  const probe1 = deps.probeIdle();
  const deferredSince1 = deps.deferredSince?.();
  const nowMs1 = deps.now();
  const gate1 = evaluateIdleGate(probe1, deferredSince1, nowMs1, ceilingMs);
  const gate1Fields = {
    waited_ms: gate1.waitedMs,
    ceiling_ms: ceilingMs,
    workers: probe1.workers,
    inflight_locks: probe1.inflightLocks,
    worktree_locks: probe1.worktreeLocks,
    unreadable: probe1.unreadable,
  };
  if (!gate1.proceed) {
    if (deferredSince1 === undefined) deps.setDeferredSince?.(nowMs1); // start the clock, once
    deps.log("deploy.not_idle", { phase: "pre-pull", ...gate1Fields });
    return { deployed: false, reason: "not-idle (task in flight) — retry next interval", fromHead };
  }
  if (gate1.forced) {
    // Not a quiet fleet — the ceiling fired. Honest about what that costs: the kickstart below
    // (once we get there) SIGKILLs any in-flight worker; see DEPLOY_IDLE_DEFER_CEILING_MS's doc
    // for why that is survivable (daemon.ts's boot-time crash-recovery pass, W1-T12c).
    deps.log("deploy.idle_ceiling_forced", { phase: "pre-pull", ...gate1Fields });
  }

  deps.pullFf();
  const toHead = deps.installHead();
  deps.log("deploy.pulled", { from: short(fromHead), to: short(toHead) });

  // RE-CHECK idle in the same breath as the kickstart (poll-race mitigation): a task
  // may have dispatched since the pre-pull check. The pull is already on disk but
  // INERT (daemon still on old code), so aborting here is safe — retry the restart
  // next tick. Same persisted clock: it is one continuous deferral regardless of which
  // check catches it.
  const probe2 = deps.probeIdle();
  const deferredSince2 = deps.deferredSince?.();
  const nowMs2 = deps.now();
  const gate2 = evaluateIdleGate(probe2, deferredSince2, nowMs2, ceilingMs);
  const gate2Fields = {
    waited_ms: gate2.waitedMs,
    ceiling_ms: ceilingMs,
    workers: probe2.workers,
    inflight_locks: probe2.inflightLocks,
    worktree_locks: probe2.worktreeLocks,
    unreadable: probe2.unreadable,
  };
  if (!gate2.proceed) {
    if (deferredSince2 === undefined) deps.setDeferredSince?.(nowMs2); // start the clock, once
    deps.log("deploy.not_idle", {
      phase: "pre-kickstart",
      note: "pulled but NOT restarted — inert until a later idle tick",
      ...gate2Fields,
    });
    return { deployed: false, reason: "not-idle-at-kickstart — pulled, restart deferred", fromHead, toHead, pulledPendingRestart: true };
  }
  if (gate2.forced) {
    deps.log("deploy.idle_ceiling_forced", { phase: "pre-kickstart", ...gate2Fields });
  }
  // W1-T380: A DEFERRAL EPISODE IS ENDED ONLY BY A CYCLE THAT ACTUALLY RESTARTS, so this branch
  // returns with the persisted clock INTACT and the next real cycle inherits the accumulated wait.
  // The clear used to sit ABOVE this check, under the comment "the deferral episode is over either
  // way" — but a dry-run never reaches `deps.kickstart()`, so a dry-run that won the race to the
  // ceiling ended the episode and delivered nothing. Observed 2026-08-05T22:43:42Z: forced at
  // waited_ms 1843684, pulled, logged `deploy.dry_run`, and 16s later `deploy.not_idle waited_ms=0`
  // — the clock reset with the daemon still on its old sha, and a merged PR sat undelivered for
  // over an hour while a second episode climbed from zero. THE CEILING WORKED; this branch threw
  // its result away while consuming the entitlement that would have forced the next one.
  // Same shape as the `!gate2.proceed` return above (`pulledPendingRestart`), and for the same
  // reason: pulled, not restarted, so the episode is still open. The pull itself is deliberately
  // unchanged — "the pull is already safe and inert; only the RESTART is dangerous".
  // `retained_wait_ms` is on the row because `would_kickstart: true` alone reads as success while a
  // delivery was dropped; a reader must be able to see the episode is still open.
  if (opts.dryRun) {
    deps.log("deploy.dry_run", { would_kickstart: true, to: short(toHead), retained_wait_ms: gate2.waitedMs });
    return { deployed: false, reason: "dry-run (pulled; kickstart skipped)", fromHead, toHead };
  }

  // Genuinely idle, or the ceiling carried it — and THIS cycle is restarting, so the episode ends.
  // Kept ABOVE `deps.kickstart()` deliberately: a real cycle must clear unconditionally, or the
  // clock never resets and every later tick forces a SIGKILL restart into `reconstructOrphan`, a
  // path never exercised in production. That overcorrection is what this task's second criterion
  // locks, against the PERSISTED value rather than a spy on the call.
  deps.clearDeferredSince?.();

  const kickstartAt = deps.now();
  deps.kickstart();
  deps.log("deploy.kickstart", { to: short(toHead) });

  const health = assessBootHealth(deps.waitBootHealth(kickstartAt), opts.health);
  if (health.healthy) {
    deps.clearMarker();
    deps.log("deploy.ok", { to: short(toHead), reason: health.reason });
    // The console loads its code once, so a deploy it is not restarted for is inert in it.
    // ONLY here: the daemon is verified healthy (so its install is done — see restartConsole's
    // doc) and there is no longer any path that would roll this sha back.
    const con = restartConsole(deps, toHead);
    return {
      deployed: true,
      reason: "deployed + healthy",
      fromHead,
      toHead,
      consoleRestarted: con.restarted,
      consoleHealthy: con.healthy,
    };
  }

  // ROLLBACK — restore a head the daemon is OBSERVED to have booted on, alert, never leave a
  // crash-looping daemon live.
  //
  // The target is NOT `fromHead`. `fromHead` is `installHead()` read at the top of this cycle, and
  // the install checkout has a second, unlogged writer — `checkCliFreshness` (lib/self-sync.ts)
  // fast-forwards it at the entry of nearly every `rmd` subcommand. When that happens between a bad
  // head merging and this cycle running, `fromHead` IS the bad head and `resetHard(fromHead)`
  // restores the failure. That is not hypothetical: 2026-08-05 logged seven consecutive rollbacks
  // with `rolling_back_to == failed`, and the fleet stayed down 53 minutes because none of them
  // moved the tree. See {@link readLastGoodBootSha}.
  //
  // `fromHead` remains the fallback when no booted sha is known (no ledger, boot lines predating
  // `head_sha`, or rotation aged the last good one out): the previous behaviour, never worse.
  const bootedSha = deps.lastGoodBootSha?.(toHead);
  const rollbackTo = bootedSha ?? fromHead;
  deps.log("deploy.unhealthy_rollback", {
    failed: short(toHead),
    reason: health.reason,
    rolling_back_to: short(rollbackTo),
    // Distinguishes a rollback aimed by observed evidence from one that fell back to the install's
    // own head — the latter is the shape that silently did nothing, so it must be legible in the
    // ledger rather than inferred from two shas happening to match.
    anchor: bootedSha ? "booted" : "install-head",
  });
  deps.resetHard(rollbackTo);
  deps.kickstart();
  deps.alert(`deploy of ${toHead} failed health-check (${health.reason}); rolled back to ${rollbackTo}`, toHead, "health-check-rollback");
  deps.clearMarker();
  return { deployed: false, reason: `health-check-failed-rolled-back: ${health.reason}`, fromHead, toHead, rolledBackTo: rollbackTo };
}

// ── Marker + alert file paths (state/) ──────────────────────────────────────────

/** Operator "please deploy at the next idle gap" request (`rmd deploy` writes it). */
export function deployMarkerPath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_REQUESTED");
}
/** Explicit opt-in to deploy on ANY new main without a per-deploy marker. */
export function deployAutoPath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_AUTO");
}
/** Last HEAD that failed health-check + rolled back (auto mode never retries it). */
export function deployLastFailedPath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_LAST_FAILED");
}
/** Operator-facing failure alert. */
export function deployFailedAlertPath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_FAILED");
}
/** W1-T341: since when THIS deploy attempt has been deferred by the idle gate — the
 *  cross-cycle clock {@link evaluateIdleGate}'s ceiling measures against (each `deploy-run`
 *  cycle is a fresh launchd one-shot, so this cannot live in memory). */
export function deployIdleDeferredSincePath(stateRoot: string): string {
  return join(stateRoot, "state", "DEPLOY_IDLE_DEFERRED_SINCE");
}

/** `rmd deploy` — request a deploy at the next idle gap. */
export function requestDeploy(stateRoot: string, reason: string | undefined): void {
  const p = deployMarkerPath(stateRoot);
  writeAtomic(p, JSON.stringify({ reason, requestedAt: new Date().toISOString() }, null, 2));
}

// ── Real, injected side effects ─────────────────────────────────────────────────

export interface RealDeployOpts {
  /** The daemon's git checkout to fast-forward (its install path / repoRoot). */
  installPath: string;
  /** `<config.root>` (holds state/). */
  stateRoot: string;
  /** launchd job label to kickstart (e.g. com.remudero.daemon). */
  daemonLabel: string;
  /** launchd job label for the console (e.g. com.remudero.serve). */
  serveLabel: string;
  /** TCP port the console listens on — the no-auth health signal. */
  servePort: number;
  /** For `launchctl kickstart -k gui/<uid>/<label>`. */
  uid: number;
  ledgerPath: string;
  /** OPTIONAL since impl-EP — omitted ⇒ {@link buildDeployLogger} against `ledgerPath`, which writes
   *  to BOTH stdout and the ledger. Supplied only by tests that want to observe the calls. */
  log?: (step: string, data?: Record<string, unknown>) => void;
  /** Health window: total ms to watch the daemon after kickstart (default 45s). */
  healthWindowMs?: number;
  /** Poll pace within the window (default 3s). */
  healthPollMs?: number;
  /** Injected blocking sleep (tests fake it; real = a busy-wait-free sleep). */
  sleep?: (ms: number) => void;
  /** Injected subprocess runner (tests fake it; default = execFileSync, utf8, RAW —
   * callers trim, because `git status --porcelain`'s leading status column is
   * significant). Throws on a non-zero exit, exactly like execFileSync — callers catch
   * where a non-zero exit is expected (e.g. `pgrep` with no matches). */
  execFile?: (cmd: string, args: string[]) => string;
}

/**
 * Wire {@link runDeployCycle}'s side effects to the real world (every subprocess via
 * one injectable `execFile`, every file op via node:fs against `stateRoot`, so the
 * whole adapter is unit-testable without a real daemon/git/launchctl). The one
 * non-obvious bit is health: after kickstart we watch the ledger for `daemon.boot`
 * heartbeats newer than the kickstart instant — exactly ONE means a clean boot;
 * SEVERAL in the window means KeepAlive is restart-storming a broken daemon
 * (crashCount = extra boots). Absent-and-none means it never came up.
 */
/**
 * The deploy cycle's logger — stdout AND the ledger (impl-EP).
 *
 * `deployer.ts` already emits `deploy.abort_dirty_tree` with the conflicting paths named, and
 * `ledger.ts`'s HEALTH_RELEVANT_LEDGER_STEP_PREFIXES already retains every `deploy.*` step through
 * rotation. But this logger only ever wrote to `console.log`, so all of it landed in
 * `supervisor.out.log` and NONE of it in the ledger — which is why 107 dirty-tree aborts left ZERO
 * ledger rows across 663 rotations, and much of why the defect survived eleven days and six
 * investigations. `ledgerPath` was already being passed to `realDeployDeps` and simply unused here.
 *
 * NOTHING IS ADDED TO `DECISION_RELEVANT_LEDGER_STEPS`: membership there is for steps a DECISION
 * consults, and `sweep.absent_repush` is the cautionary case — sitting in that set while occurring
 * zero times. `deploy.*` is already covered by `ledger.ts`'s health-window PREFIX rule, which is the
 * correct retention for an observability step.
 *
 * BEST-EFFORT: a deploy must never fail because its own logging could not write.
 *
 * Extracted rather than inlined so it is directly testable — a closure inside `deployRunCommand`
 * cannot be reached without running a real deploy cycle.
 */
export function buildDeployLogger(
  ledgerPath: string,
  deps: { append?: typeof appendLedger; out?: (line: string) => void; now?: () => number } = {},
): (step: string, data?: Record<string, unknown>) => void {
  const append = deps.append ?? appendLedger;
  const out = deps.out ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => Date.now());
  return (step, data) => {
    out(`### [deploy] ${step}${data ? " " + JSON.stringify(data) : ""}`);
    try {
      append(ledgerPath, { run_id: `DEPLOY-${now()}`, task_id: "DEPLOY", step, ...(data ?? {}) });
    } catch {
      // stdout already carries it; a ledger write failure must not abort the deploy cycle.
    }
  };
}

export function realDeployDeps(o: RealDeployOpts): DeployDeps {
  const exec = o.execFile ?? ((cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8" }).toString());
  const git = (args: string[]): string => exec("git", ["-C", o.installPath, ...args]);
  const sleep = o.sleep ?? ((ms: number) => exec("sleep", [String(Math.ceil(ms / 1000))]));
  const windowMs = o.healthWindowMs ?? 45_000;
  const pollMs = o.healthPollMs ?? 3_000;

  const countBootsAfter = (sinceMs: number): number => countLedgerBootsAfter(o.ledgerPath, sinceMs);

  return {
    log: o.log ?? buildDeployLogger(o.ledgerPath),
    now: () => Date.now(),
    fetch: () => {
      git(["fetch", "origin", "--quiet"]);
    },
    installHead: () => git(["rev-parse", "HEAD"]).trim(),
    originMain: () => git(["rev-parse", "origin/main"]).trim(),
    markerPresent: () => existsSync(deployMarkerPath(o.stateRoot)),
    autoMode: () => existsSync(deployAutoPath(o.stateRoot)),
    lastFailedHead: () => {
      try {
        return readFileSync(deployLastFailedPath(o.stateRoot), "utf8").trim() || undefined;
      } catch {
        return undefined;
      }
    },
    lastFailedKind: () => {
      try {
        const k = (JSON.parse(readFileSync(deployFailedAlertPath(o.stateRoot), "utf8")) as { kind?: string }).kind;
        return k === "dirty-tree-conflict" || k === "health-check-rollback" ? k : undefined;
      } catch {
        return undefined; // absent/legacy/corrupt ⇒ "reason not recorded", never a guess
      }
    },
    // Byte-identity via BLOB SHA, compared through the injected `git` helper.
    //
    // Two rejected alternatives, both unsafe here. Comparing decoded strings can false-MATCH on
    // binary content, because invalid UTF-8 collapses to U+FFFD and two different blobs can decode
    // alike — and a false match discards a file that actually differs. `git diff --quiet <ref> --
    // <path>` is worse: it ignores UNTRACKED files entirely, so it reports "no difference" for
    // precisely the alert-intake exhaust this fix exists to handle. Hashing the working file
    // covers tracked and untracked identically, and git's hash is byte-exact.
    //
    // ANY failure (path absent from the ref, unreadable file, git error) answers false, so the
    // conservative abort remains the default and only a positive match can unblock a deploy.
    sameAsIncoming: (path, ref) => {
      try {
        const local = git(["hash-object", "--", path]).trim();
        const incoming = git(["rev-parse", `${ref}:${path}`]).trim();
        return local.length > 0 && local === incoming;
      } catch {
        return false;
      }
    },
    // Tracked ⇒ restore from HEAD (leaves a clean path the ff can advance); untracked ⇒ remove.
    // Never `reset --hard`: this touches ONLY paths already proven byte-identical to the incoming
    // blob, one at a time.
    discardLocal: (path) => {
      const tracked = (() => {
        try {
          git(["ls-files", "--error-unmatch", "--", path]);
          return true;
        } catch {
          return false;
        }
      })();
      if (tracked) git(["checkout", "--", path]);
      else unlinkSync(join(o.installPath, path));
    },
    runningHead: () => readLatestBootSha(o.ledgerPath),
    // Same ledger, same live-file-only read as `runningHead` directly above — the rollback anchor
    // (see runDeployCycle's rollback branch for why it is not `installHead()`).
    lastGoodBootSha: (excludeSha) => readLastGoodBootSha(o.ledgerPath, excludeSha),
    dirtyFiles: () =>
      git(["status", "--porcelain"])
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean),
    incomingFiles: (from, to) =>
      git(["diff", "--name-only", `${from}..${to}`]).split("\n").map((l) => l.trim()).filter(Boolean),
    pullFf: () => {
      git(["merge", "--ff-only", "origin/main"]);
    },
    resetHard: (ref) => {
      git(["reset", "--hard", ref]);
    },
    probeIdle: () => {
      // ALL THREE READS DISCRIMINATE a true zero from a read that did not happen; see
      // {@link IdleProbe.unreadable}. Every one of them used to catch into 0, and 0 on all three
      // is precisely what {@link daemonIsIdle} calls quiet.
      const unreadable: string[] = [];
      let workers = 0;
      try {
        workers = exec("pgrep", ["-f", "claude --output-format|codex exec"]).split("\n").filter(Boolean).length;
      } catch (err) {
        if (!pgrepFailureMeansZero(err)) unreadable.push("workers");
        workers = 0; // pgrep exits 1 when there are no matches
      }
      const countLocks = (dir: string, signal: string): number => {
        try {
          return readdirSync(dir).filter((n) => n.endsWith(".lock")).length;
        } catch (err) {
          if (!lockReadFailureMeansZero(err)) unreadable.push(signal);
          return 0;
        }
      };
      return {
        workers,
        inflightLocks: countLocks(join(o.stateRoot, "state", "inflight"), "inflightLocks"),
        worktreeLocks: countLocks(join(o.stateRoot, "worktrees"), "worktreeLocks"),
        unreadable,
      };
    },
    kickstartConsole: () => {
      // The SAME mechanism as the daemon kickstart below — one way to restart a service,
      // only the label differs. Both labels live in the same gui/<uid> domain.
      exec("launchctl", ["kickstart", "-k", `gui/${o.uid}/${o.serveLabel}`]);
    },
    // Mirrors `consolePid` below — same launchctl query, same domain, only the label differs. A
    // job that is loaded but not running reports no PID, which is precisely the corpse state.
    daemonAlive: () => {
      try {
        const out = exec("launchctl", ["list", o.daemonLabel]);
        const m = out.match(/"PID"\s*=\s*(\d+)/);
        return m ? Number(m[1]) > 0 : false;
      } catch {
        return undefined; // not loaded / query failed — NOT observed, never asserted as dead
      }
    },
    // No try/catch: `stopDetail` is existsSync + a swallowing read, so it cannot throw — a
    // defensive catch here would be unreachable code, which diff-coverage correctly refuses. The
    // trigger still treats `undefined` as PRESENT, which covers any caller that omits this dep.
    stopPresent: () => stopDetail(o.stateRoot) !== undefined,
    consolePid: () => {
      try {
        const out = exec("launchctl", ["list", o.serveLabel]);
        const m = out.match(/"PID"\s*=\s*(\d+)/);
        return m ? Number(m[1]) : undefined;
      } catch {
        return undefined; // not loaded / not running — reported as null in the ledger
      }
    },
    waitConsoleUp: () => {
      // A LISTENING SOCKET, not an authenticated request: the deployer holds no service token
      // and must not learn one. Bounded poll; the serve job's ThrottleInterval is 60s, so a
      // crash-then-relaunch can legitimately take a while — we report, we do not roll back.
      for (let i = 0; i < CONSOLE_UP_ATTEMPTS; i++) {
        try {
          exec("lsof", ["-nP", `-iTCP:${o.servePort}`, "-sTCP:LISTEN"]);
          return true; // exit 0 => something is listening
        } catch {
          /* nothing listening yet */
        }
        sleep(CONSOLE_UP_DELAY_MS);
      }
      return false;
    },
    alertConsoleOnly: (message) => {
      // The operator-visible alert WITHOUT deployLastFailedPath — see the dep's doc for why
      // poisoning the failed-HEAD marker on a console fault would freeze the pipeline.
      writeAtomic(
        deployFailedAlertPath(o.stateRoot),
        JSON.stringify({ message, scope: "console", at: new Date().toISOString() }, null, 2),
      );
    },
    kickstart: () => {
      exec("launchctl", ["kickstart", "-k", `gui/${o.uid}/${o.daemonLabel}`]);
    },
    waitBootHealth: (sinceMs) => {
      let waited = 0;
      let boots = 0;
      while (waited < windowMs) {
        sleep(pollMs);
        waited += pollMs;
        boots = countBootsAfter(sinceMs);
        // Keep watching for the whole window to catch a restart-storm; a single boot
        // that stays is confirmed only once the window has elapsed with boots === 1.
      }
      return { bootObserved: boots >= 1, crashCount: Math.max(0, boots - 1) };
    },
    alert: (message, failedHead, kind) => {
      // `kind` is persisted so the NEXT poll's skip line can state the real cause. Without it the
      // record and the message that cites it can disagree, which is how a dirty-tree stall spent
      // an investigation being read as a health-check failure.
      writeAtomic(
        deployFailedAlertPath(o.stateRoot),
        JSON.stringify({ message, failedHead, kind, at: new Date().toISOString() }, null, 2),
      );
      writeAtomic(deployLastFailedPath(o.stateRoot), failedHead);
    },
    clearMarker: () => {
      try {
        unlinkSync(deployMarkerPath(o.stateRoot));
      } catch {
        /* already gone */
      }
    },
    // W1-T341's ceiling clock, persisted because a fresh process cannot remember it between
    // `deploy-run` cycles (see this file's banner). A missing/unparseable record reads as
    // "no deferral tracked" (undefined), which evaluateIdleGate treats as a fresh deferral —
    // never as an already-elapsed one.
    deferredSince: () => {
      try {
        const raw = readFileSync(deployIdleDeferredSincePath(o.stateRoot), "utf8").trim();
        const ms = Number(raw);
        return Number.isFinite(ms) ? ms : undefined;
      } catch {
        return undefined;
      }
    },
    setDeferredSince: (ms) => {
      writeAtomic(deployIdleDeferredSincePath(o.stateRoot), String(ms));
    },
    clearDeferredSince: () => {
      try {
        unlinkSync(deployIdleDeferredSincePath(o.stateRoot));
      } catch {
        /* already gone */
      }
    },
  };
}
