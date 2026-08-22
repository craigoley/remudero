import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { classifyPushFailure } from "./task-id-reservation.js";

/**
 * lib/auto-triage.ts — the daemon's SECOND work-generating rung (recon-DC #2).
 *
 * THE GAP THIS CLOSES. The daemon has exactly one rung that CREATES work — the retro, wired by
 * W1-T160 at daemon.ts's poll loop. Everything else consumes a queue something else filled. So
 * ~68 feedback entries sit at `status: new` while the daemon idles: `triageCommand`'s only caller
 * is the CLI (run-task.ts), and nothing turns a feedback entry into a task unattended.
 *
 * WHAT IT DOES, AND EMPHATICALLY WHAT IT DOES NOT. At most ONE entry per fire window. recon-DC
 * rejected draining the backlog in as many words — "the whole backlog is ~$64 unsupervised and 68
 * approvals — worse than idle".
 *
 * THE PER-RUN COST IS ~$1.09 MEAN, NOT THE ~$2.00 THIS COMMENT USED TO CARRY. That figure was
 * extrapolated from a SINGLE $2.03 run, and a single observation of a skewed quantity is a
 * worst-case sample, not a mean — it inflated the projected daily spend by ~2x. RE-DERIVED over 70
 * runs: mean $1.09, median $1.03, p90 $1.77, max $2.86, with only 5 of 70 at or above $2.00. The
 * restraint below is still the point; it is simply bounded against a real distribution now.
 * Three independent bounds apply, and ALL must pass:
 *   1. `enabled` — policy data, DEFAULT FALSE. A rung that ships on is a surprise, not a rung.
 *   2. `minIntervalMinutes` — the floor between two fires. This is what makes "one per idle
 *      PERIOD" enforceable rather than aspirational: the daemon polls every 60s and idled ~390
 *      times in ten hours, so a per-POLL rung would have spent ~$780 in one night.
 *   3. `maxPerDay` — a hard ceiling on a rolling 24h window, so a pathological idle/dispatch
 *      flap cannot outrun bound 2.
 *
 * FAIL-SOFT AND FAIL-CLOSED, matching the retro: an unreadable marker REFUSES to fire (never
 * replays a torn state), and every error is the caller's to log — this module throws only on
 * programmer error, never on I/O.
 *
 * ★ THE LOCK IS NOT OPTIONAL, AND IT IS WHY THIS RUNG COULD NOT BE BUILT BEFORE. The task id is
 * minted from a SNAPSHOT before the worker runs (lib/triage.ts). Two triage runs that start before
 * either pushes mint the SAME id, and since PR #1060 each writes its own
 * `plan/tasks.d/<id>-<slug>.yaml` — DIFFERENT filenames, so both merge CLEANLY and `loadPlan`
 * throws duplicate-task-id ON MAIN. Before #1060 that collision was a loud EOF conflict; now it is
 * a poisoned plan. The daemon loop being single-threaded protects daemon-vs-daemon only; NOTHING
 * stopped a hand-run racing it, and this rung makes that far likelier because the operator cannot
 * see that the daemon is about to fire. {@link triageLockPath} is therefore acquired by BOTH the
 * rung and the CLI path, through the same `drain-lock.ts` primitive (atomic `O_EXCL` create, dead
 * pid reclaimed), so `rmd triage` typed by hand during a fire REFUSES loudly.
 */

/** The lock BOTH the daemon rung and the `rmd triage` CLI path acquire. One writer, ever. */
export function triageLockPath(root: string): string {
  return join(root, "state", "triage.lock");
}

// ── THE CROSS-HOST TRIAGE CLAIM (W1-T1132) ───────────────────────────────────────────────────
//
// WHAT THE LOCK ABOVE CANNOT DO, AND WHY THIS IS NOT A SECOND SPELLING OF IT. `triageLockPath` is
// a file under `<root>/state` reclaimed by PID liveness (`drain-lock.ts`), so it protects ONE
// host. W1-T300's in-flight guard IS cross-host — it reads an OPEN triage PR on GitHub, which
// every host shares — and W1-T1019's wiring landed 2026-08-20. The collisions this closes are
// 2026-08-22, TWO DAYS LATER: #2452 and #2462 wrote mirror-image verdicts for entries the other
// had already decided, and neither could merge because resolving them means PICKING A TRIAGE
// VERDICT, which no merge strategy can do.
//
// THE DEFECT IS THE SIGNAL'S TIMING, NOT ITS REACH. A triage PR does not exist until the triage
// FINISHES. The entry is read, grounded, researched and only then written, with an Architect call
// in the middle, so the window between "lane starts" and "lane publishes" is MINUTES. Two lanes
// starting anywhere inside it both ask "is there an open PR for this entry", both are correctly
// told NO, and both spend. A guard that reads PUBLISHED work cannot see work in flight — so this
// claim is taken BEFORE the Architect call, which is the one thing an open-PR read can never be.
// It ADDS to W1-T300's guard; that guard still correctly refuses an entry whose PR is already open.
//
// MIRRORS `reserveTaskIdRemote` (W1-T509) RATHER THAN INVENTING A PRIMITIVE. Same substrate (a
// ref on origin, created only if absent, so the winner is decided by git's own atomic ref update),
// same anchor shape (an orphan commit whose payload is unrelated to every other writer's), and the
// SAME `classifyPushFailure` — imported, not re-derived, because two copies of "is this contention
// or an unreachable remote" is two places for it to drift. A PID is deliberately NOT used: a
// second host cannot ask whether a pid on the first is alive, which is exactly why the file lock
// could never have been widened into this.
//
// THE LOSER REFUSES; IT DOES NOT ADVANCE. `reserveTaskIdRemote` advances on contention because for
// a MINT the next id serves the caller equally well. A triage has no substitute: the second lane's
// output is either a contradicting verdict that cannot merge, or a rediscovery of a verdict already
// reached. Both are waste, so the loser refuses THIS entry and is free to take a different one.

/** The ref one feedback id's triage claim occupies. The id is the whole token, so two entries can
 *  never fold onto one ref. Under `refs/rmd-triage/`, a namespace `git clone`/`git fetch` does not
 *  replicate by default and `git ls-remote --heads` (which `reapBranchesCommand` enumerates) cannot
 *  see — the same two properties that made `refs/rmd-id/` safe to introduce. */
export function triageClaimRef(feedbackId: string): string {
  return `refs/rmd-triage/${feedbackId}`;
}

/** One claim attempt's outcome. `taken` is contention; `unreachable` is a failed READ of the world
 *  and must never be read as "free" — see {@link decideTriageClaim}'s fail-closed arm. */
export type TriageClaimOutcome = "created" | "taken" | "unreachable";

/** Whether this lane may proceed, and the sentence a human or a ledger row gets either way. */
export interface TriageClaimDecision {
  readonly proceed: boolean;
  readonly reason: string;
}

/**
 * PURE. Turn one attempt outcome into the proceed/refuse verdict and its wording.
 *
 * AN UNREACHABLE ORIGIN REFUSES, matching `reserveTaskIdRemote`'s own fail-closed choice for the
 * same reason: proceeding optimistically is precisely today's behaviour, and today's behaviour
 * spent two Architect calls on unmergeable mirror-image verdicts. Refusing is loud and costs
 * nothing — the caller has not yet spent when this fires.
 */
export function decideTriageClaim(outcome: TriageClaimOutcome, ctx: { feedbackId: string; holder?: string }): TriageClaimDecision {
  if (outcome === "created") return { proceed: true, reason: `claimed ${triageClaimRef(ctx.feedbackId)} for this run` };
  if (outcome === "taken") {
    // NAMED, NOT ANONYMOUS: the ref AND the anchor a live holder wrote. "Someone else is doing it"
    // is unactionable; a ref an operator can `git ls-remote` and an anchor they can `git show` is
    // the difference between a refusal and a mystery.
    const held = ctx.holder ? ` (held by ${ctx.holder})` : "";
    return {
      proceed: false,
      reason:
        `feedback#${ctx.feedbackId} is already being triaged by another lane — ${triageClaimRef(ctx.feedbackId)}${held}. ` +
        `Refusing before the Architect call: a second verdict for one entry either contradicts the first ` +
        `(neither can merge) or rediscovers it (the call is spent for nothing).`,
    };
  }
  return {
    proceed: false,
    reason:
      `cannot reach origin to claim ${triageClaimRef(ctx.feedbackId)} — refusing rather than triaging ` +
      `optimistically, which is the behaviour that spent two Architect calls on verdicts that could not merge`,
  };
}

/**
 * PURE. Does any merged commit subject name this feedback entry?
 *
 * THE EVIDENCE THAT ALREADY EXISTS — the same shape W1-T1110 established, and the reason arm two
 * of the release below needs no new record: this repo's triage merges carry the entry in their
 * subject (`chore(triage): feedback#<id> — already decided, no task`, `chore(plan): triage
 * feedback#<id> — add W1-T…`). Matched as a plain substring, never a regex: a feedback id is
 * caller-supplied and carries `-` freely, and a pattern built from one would be a metacharacter
 * bug waiting for the first id that contains one.
 */
export function feedbackOutcomeObserved(subjects: readonly string[], feedbackId: string): boolean {
  return subjects.some((s) => s.includes(feedbackId));
}

/** Which of the three release arms applies. There is no fourth, and deliberately no timer. */
export type TriageClaimReleaseArm = "holder" | "evidence" | "operator";

export interface TriageClaimReleaseDecision {
  readonly arm: TriageClaimReleaseArm;
  readonly release: boolean;
  readonly reason: string;
}

/**
 * PURE. The three-arm release, in order, with NO TIME-BASED EXPIRY.
 *
 *  1. HOLDER — the lane that took the claim drops it on completion, in a `finally`, success or not.
 *  2. EVIDENCE — a claim whose entry has an OBSERVABLE triage outcome is releasable by ANY host.
 *     The entry is demonstrably done, so the claim is demonstrably stale; no liveness question is
 *     asked because none can be answered.
 *  3. OPERATOR — anything else. Cross-host liveness is NOT decidable (that is the whole reason a
 *     pid lock could not be widened), so the honest answer is a person, not a guess.
 *
 * WHY NOT A TIMER, BY NAME. W1-T1067's stranded `drain.lock` is the precedent for what a
 * time-or-restart-shaped release does when the releasing signal never arrives. And the failure
 * runs the other way too: a triage is MINUTES long with an Architect call in the middle, so any
 * expiry short enough to clear a stuck claim promptly is short enough to fire on healthy work —
 * this repo's own recurring "a bound that fires on a HEALTHY condition" defect. A claim that
 * outlives its lane is a visible ref an operator can drop; a claim that expires under a running
 * lane re-opens the exact race this exists to close.
 */
export function decideTriageClaimRelease(i: { heldByThisRun: boolean; outcomeObserved: boolean; feedbackId: string }): TriageClaimReleaseDecision {
  if (i.heldByThisRun) return { arm: "holder", release: true, reason: `this run holds ${triageClaimRef(i.feedbackId)} and is done with it` };
  if (i.outcomeObserved)
    return {
      arm: "evidence",
      release: true,
      reason: `feedback#${i.feedbackId} already has a merged triage outcome, so its claim is stale and any host may drop it`,
    };
  return {
    arm: "operator",
    release: false,
    reason:
      `${triageClaimRef(i.feedbackId)} is held by another lane with no merged outcome yet — leaving it. ` +
      `Cross-host liveness is not decidable, so clearing it is an operator call: ` +
      `git push origin :${triageClaimRef(i.feedbackId)}`,
  };
}

/** The one I/O seam. Every method is a git round trip; every DECISION above is pure and tested
 *  without one. */
export interface TriageClaimReserver {
  /** A payload unique to THIS writer — two writers must never produce the same value, or the
   *  create-if-absent stops discriminating and the claim silently stops claiming. */
  mintAnchor(): string;
  /** Create-if-absent of {@link triageClaimRef}. Never throws: an unreachable remote is an
   *  OUTCOME, because a throw at this seam reads identically to contention at the caller. */
  attempt(feedbackId: string, anchor: string): TriageClaimOutcome;
  /** The anchor currently at the claim ref, or `undefined` when absent or unreadable. */
  holder(feedbackId: string): string | undefined;
  /** Delete the claim ref. `expect` makes the delete conditional on the ref still carrying THAT
   *  anchor, so the holder arm can never delete a claim that has since become someone else's. */
  drop(feedbackId: string, opts?: { expect?: string }): boolean;
}

export interface TriageClaimGitDeps {
  /** Runs a git argv; returns its exit status, stdout and stderr. Injected by tests. */
  run(args: string[]): { status: number; stdout: string; stderr: string };
  /** Overrides the anchor so a test can make two writers distinguishable. */
  anchor?: () => string;
}

/**
 * The real reserver: an orphan commit over the empty tree, pushed to the entry's own ref.
 *
 * `commit-tree` with NO `-p` is what makes this writer's payload unrelated to every other's —
 * the same argument `gitRemoteRefReserver` makes, and the reason this mirrors it rather than
 * inventing a second scheme. The message carries pid+host+time so an operator inspecting a stuck
 * claim can see who took it, and it doubles as the uniqueness source: two writers on one host in
 * the same millisecond still differ by pid.
 */
export function gitTriageClaimReserver(deps: TriageClaimGitDeps): TriageClaimReserver {
  return {
    mintAnchor() {
      if (deps.anchor) return deps.anchor();
      const tree = deps.run(["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
      const msg = `rmd-triage claim ${process.pid}@${hostname()} ${new Date().toISOString()}`;
      return deps.run(["commit-tree", tree, "-m", msg]).stdout.trim();
    },
    attempt(feedbackId, anchor) {
      const res = deps.run(["push", "origin", `${anchor}:${triageClaimRef(feedbackId)}`]);
      if (res.status === 0) return "created";
      return classifyPushFailure(res.stderr);
    },
    holder(feedbackId) {
      const res = deps.run(["ls-remote", "origin", triageClaimRef(feedbackId)]);
      if (res.status !== 0) return undefined;
      const sha = res.stdout.trim().split(/\s+/)[0];
      return sha ? sha : undefined;
    },
    drop(feedbackId, opts = {}) {
      const ref = triageClaimRef(feedbackId);
      const args = opts.expect
        ? ["push", `--force-with-lease=${ref}:${opts.expect}`, "origin", `:${ref}`]
        : ["push", "origin", `:${ref}`];
      return deps.run(args).status === 0;
    },
  };
}

/** What a claim attempt hands back: the verdict, and — only when this lane WON — the anchor the
 *  release arm needs. */
export interface TriageClaimResult extends TriageClaimDecision {
  readonly anchor?: string;
  /** Set when contention was met AND the holder's claim was dropped as stale on the evidence arm. */
  readonly staleReleased?: boolean;
}

/**
 * Take the claim for `feedbackId`, or refuse.
 *
 * ON CONTENTION THIS ALSO RUNS THE RELEASE'S EVIDENCE ARM, which is what makes that arm reachable
 * in production rather than only in a test: the lane that LOSES is exactly the lane holding fresh
 * proof of whether the entry is already done. If a merged subject names the entry, the claim is
 * stale and this drops it so the next lane is not refused by a dead ref. The refusal stands either
 * way — an entry with a merged outcome does not want re-triaging, which is the duplicate this
 * whole task exists to stop.
 */
export function claimTriage(
  feedbackId: string,
  reserver: TriageClaimReserver,
  opts: { mergedSubjects?: () => readonly string[] } = {},
): TriageClaimResult {
  const anchor = reserver.mintAnchor();
  const outcome = reserver.attempt(feedbackId, anchor);
  if (outcome === "created") return { ...decideTriageClaim(outcome, { feedbackId }), anchor };
  const decision = decideTriageClaim(outcome, { feedbackId, holder: outcome === "taken" ? reserver.holder(feedbackId) : undefined });
  if (outcome !== "taken") return decision;
  const observed = feedbackOutcomeObserved(opts.mergedSubjects?.() ?? [], feedbackId);
  const released = releaseTriageClaim(feedbackId, reserver, { outcomeObserved: observed });
  return { ...decision, reason: `${decision.reason} ${released.reason}`, staleReleased: released.dropped };
}

/** {@link decideTriageClaimRelease}'s verdict plus whether the ref was actually dropped. */
export interface TriageClaimReleaseResult extends TriageClaimReleaseDecision {
  readonly dropped: boolean;
}

/**
 * Apply the three-arm release. `anchor` present ⇒ this run is the holder (arm 1); absent, the
 * decision falls to the evidence arm and then to the operator. The DECISION is
 * {@link decideTriageClaimRelease}'s alone — this function only performs the I/O it authorises,
 * which is why the operator arm can be asserted without a git remote existing at all.
 */
export function releaseTriageClaim(
  feedbackId: string,
  reserver: TriageClaimReserver,
  i: { anchor?: string; outcomeObserved?: boolean } = {},
): TriageClaimReleaseResult {
  const decision = decideTriageClaimRelease({
    heldByThisRun: i.anchor !== undefined,
    outcomeObserved: i.outcomeObserved === true,
    feedbackId,
  });
  if (!decision.release) return { ...decision, dropped: false };
  return { ...decision, dropped: reserver.drop(feedbackId, i.anchor !== undefined ? { expect: i.anchor } : {}) };
}

/**
 * {@link claimTriage} plus the ONE durable ledger row every caller needs — the same shape, and for
 * the same measured reason, as `withIdReservationLogging` (W1-T949 design (iv)): the policy lives
 * in one function with every arm reachable from a unit test, and the lane body in `run-task.ts`
 * carries the call and nothing else. A `log(...)` written inline in that lane body can only be
 * executed by driving a whole triage run into contention against a real remote.
 */
export function claimTriageWithLogging(
  log: (step: string, extra?: Record<string, unknown>) => void,
  feedbackId: string,
  reserver: TriageClaimReserver,
  opts: { mergedSubjects?: () => readonly string[] } = {},
): TriageClaimResult {
  const result = claimTriage(feedbackId, reserver, opts);
  log("triage.claim", {
    feedback_id: feedbackId,
    ref: triageClaimRef(feedbackId),
    proceed: result.proceed,
    stale_released: result.staleReleased === true,
    reason: result.reason,
  });
  return result;
}

/**
 * {@link releaseTriageClaim} for the HOLDER arm, plus its ledger row.
 *
 * BEST-EFFORT BY CONSTRUCTION: this runs in a `finally`, so a throw here would replace whatever
 * outcome the lane actually reached — including a legitimate error — with a release failure. The
 * cost of swallowing is one ref an operator drops by hand, and the row says so; the cost of
 * throwing is a lost verdict. `arm` is always `holder` here (the caller supplies an anchor), and
 * it is recorded anyway so a later sweep can count the arms without inferring one from silence.
 */
export function releaseTriageClaimWithLogging(
  log: (step: string, extra?: Record<string, unknown>) => void,
  feedbackId: string,
  reserver: TriageClaimReserver,
  anchor: string,
): TriageClaimReleaseResult {
  let result: TriageClaimReleaseResult;
  try {
    result = releaseTriageClaim(feedbackId, reserver, { anchor });
  } catch (e) {
    result = {
      arm: "holder",
      release: true,
      dropped: false,
      reason: `releasing ${triageClaimRef(feedbackId)} threw: ${String((e as Error)?.message ?? e)}`,
    };
  }
  log("triage.claim_released", {
    feedback_id: feedbackId,
    ref: triageClaimRef(feedbackId),
    arm: result.arm,
    dropped: result.dropped,
    reason: result.reason,
  });
  return result;
}

/** Marker recording the last fire, so the interval and daily cap survive a daemon restart. */
export function autoTriageMarkerPath(root: string): string {
  return join(root, "state", "last-auto-triage.json");
}

export interface AutoTriageMarker {
  /** ISO timestamps of recent fires, newest last. Trimmed to the rolling window by the writer. */
  fires: string[];
}

export type MarkerResolution =
  | { kind: "ok"; marker: AutoTriageMarker }
  | { kind: "absent" }
  | { kind: "corrupt" };

/**
 * Read the marker. A malformed file resolves `corrupt`, NOT `absent` — the caller must FAIL CLOSED
 * on it, exactly as `resolveMarkerForGather` does for the retro. Treating corruption as "never
 * fired" would let a truncated write re-authorise an unbounded run of spends.
 */
export function readAutoTriageMarker(path: string): MarkerResolution {
  if (!existsSync(path)) return { kind: "absent" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return { kind: "corrupt" };
    const fires = (raw as AutoTriageMarker).fires;
    if (!Array.isArray(fires) || fires.some((f) => typeof f !== "string")) return { kind: "corrupt" };
    return { kind: "ok", marker: { fires } };
  } catch {
    return { kind: "corrupt" };
  }
}

/** Append a fire and trim to the rolling window. Best-effort: a write failure is the caller's. */
export function recordAutoTriageFire(path: string, at: Date, windowMs: number): AutoTriageMarker {
  const prior = readAutoTriageMarker(path);
  const kept =
    prior.kind === "ok"
      ? prior.marker.fires.filter((f) => at.getTime() - Date.parse(f) < windowMs && !Number.isNaN(Date.parse(f)))
      : [];
  const marker: AutoTriageMarker = { fires: [...kept, at.toISOString()] };
  writeFileSync(path, JSON.stringify(marker, null, 2));
  return marker;
}

export interface AutoTriagePolicy {
  enabled: boolean;
  /**
   * THE FIXED FLOOR BETWEEN TWO FIRES — the only interval bound there is (W1-T475 ruling).
   *
   * THIS IS LOAD-BEARING ON ITS OWN AND MUST NOT BE FOLDED AWAY. Before this change it reached
   * the decision ONLY through the adaptive curve's `depth <= depthFloor` arm, so deleting that
   * curve would have deleted the floor with it and left a rung that could fire on every idle
   * tick. It is now read directly by `decideAutoTriage`.
   */
  minIntervalMinutes: number;
  /**
   * The hard ceiling on a rolling 24h window. WITH THE CURVE GONE THIS IS THE ONLY SPEND BOUND
   * LEFT, and is load-bearing for the first time: the interval used to stop the rung long before
   * the cap could, so the cap has bound only 12 times ever. At the measured ~$1.07 mean per
   * triage, 24/day is about $26 against a `dailyCostCeilingUsd` of 500.
   */
  maxPerDay: number;
}

export interface AutoTriageInputs {
  policy: AutoTriagePolicy;
  /**
   * W1-T469 — THE PARTITIONER DEFERRED AT LEAST ONE PAIRING THIS TICK, i.e. capacity AND runnable
   * work both existed and `partitionByFileOverlap` refused to pair them. This REPLACES the former
   * `idle` conjunct on the operator's ruling.
   *
   * WHY NOT `idle`. The pre-W1-T469 field was set only inside `daemon.ts`'s idle branch, so its
   * guard was UNREACHABLE from the daemon and a BUSY TICK LOGGED NOTHING AT ALL — measured: 0 of
   * 1,214 `auto_triage.skipped` rows carried its reason, against 666 carrying the daily-cap reason
   * on the same corpus.
   *
   * THIS IS NO LONGER THE ONLY TRIGGER — see {@link AutoTriageInputs.dispatchCount}. W1-T469 shipped
   * it as the sole conjunct and that was CIRCULAR: a deferral requires TWO eligible tasks to collide,
   * so with zero eligible tasks there is nothing to defer, and the rung that CREATES work could only
   * fire when work already existed. MEASURED on a starved daemon: `auto_triage.skipped — "no deferral
   * this pass"` beside `dispatch.starvation.escalated — blocked: 5, unmet_deps: 3`, with ~87 feedback
   * entries unread while the fleet starved for thirteen hours.
   */
  deferralPending: boolean;
  /**
   * How many tasks this tick ACTUALLY dispatched, and the lane budget it had to fill. Together they
   * carry the second trigger: `dispatchCount < laneBudget` means THE QUEUE COULD NOT FILL THE
   * AVAILABLE CAPACITY, which is precisely the state that most needs more tasks.
   *
   * NUMBERS, NOT A PRECOMPUTED BOOLEAN, so this module owns the predicate and can name WHICH state
   * refused it — a caller passing `capacityUnfilled: false` could not tell "the governor left no
   * lanes" apart from "the queue filled every lane", and those are opposite conditions.
   *
   * ★ THIS DOES NOT FIRE ON A FULL FLEET, and that is arithmetic rather than a promise.
   * `laneDispatchBudget` (`src/lib/drain.ts`) returns `Math.min(lanes, headroom)` over two
   * `Math.max(0, …)` terms, so the budget is never negative; when the governor holds every lane it
   * is exactly 0, `runnableCandidates` returns `[]` at `limit <= 0`, and `0 < 0` is FALSE. The four
   * states, enumerated: lanes full ⇒ 0/0, silent. Starved ⇒ 0/N, FIRES. Partial fill ⇒ 1/N, FIRES
   * (the queue ran out below capacity — still "send more work"). Full fill ⇒ N/N, silent.
   */
  dispatchCount: number;
  laneBudget: number;
  /** True when the shared triage lock is already held by a LIVE process (rung or hand-run). */
  lockHeld: boolean;
  marker: MarkerResolution;
  now: Date;
  /** Feedback ids at `status: new`, oldest first. Empty ⇒ nothing to do. */
  candidates: string[];
}

export type AutoTriageDecision =
  | { fire: true; feedbackId: string; reason: string }
  | { fire: false; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decide whether to fire, and on WHAT. Pure — no I/O, no clock, no filesystem — so every bound
 * below is unit-testable without spending anything.
 *
 * ORDER IS DELIBERATE: the cheapest and most consequential refusals come first, so a disabled or
 * locked fleet never even reads a candidate list. `enabled` is checked before everything because
 * an operator who has not opted in must see NO behaviour change whatsoever.
 */
export function decideAutoTriage(i: AutoTriageInputs): AutoTriageDecision {
  if (!i.policy.enabled) return { fire: false, reason: "auto-triage disabled (policy.autoTriage.enabled=false)" };
  // ── THE TRIGGER: EITHER SIGNAL, NOT BOTH (operator ruling, reversing W1-T469) ────────────────
  // Two DIFFERENT shapes of "the fleet could use more work", and the second is the one the starved
  // state produces. Requiring the first ALONE was circular — see `deferralPending`'s own doc.
  const capacityUnfilled = i.dispatchCount < i.laneBudget;
  if (!i.deferralPending && !capacityUnfilled) {
    // THE REFUSAL NAMES WHICH BRANCH DECLINED, because one undifferentiated string would rebuild
    // the exact blindness W1-T469 existed to fix, one layer further in. The two false cases are
    // OPPOSITE conditions and must never read the same in the ledger.
    return {
      fire: false,
      reason:
        i.laneBudget <= 0
          ? "no trigger this pass — no pairing deferred, and the governor left no lane capacity to fill"
          : `no trigger this pass — no pairing deferred, and the queue filled all ${i.laneBudget} available lane(s)`,
    };
  }
  if (i.lockHeld) return { fire: false, reason: "triage lock held — a run is already in flight" };
  if (i.marker.kind === "corrupt") return { fire: false, reason: "auto-triage marker unreadable — failing closed" };

  const fires = i.marker.kind === "ok" ? i.marker.marker.fires : [];
  const parsed = fires.map((f) => Date.parse(f)).filter((n) => !Number.isNaN(n));

  // THE FLOOR, READ DIRECTLY (W1-T475 ruling). The adaptive curve that used to sit here was a
  // SECOND, WEAKER GOVERNOR on the same quantity `maxPerDay` already bounds exactly, and it was
  // keyed to a proxy that is uncorrelated with capacity in BOTH directions: `depth` counted the
  // recoverable backlog of tasks that CANNOT run, so a queue of purely colliding-but-eligible
  // work read 0 and triaged at the FAST end while lanes sat empty, and a dependency-blocked
  // queue read high and throttled to 60m with no capacity problem at all. Deleting it leaves the
  // cap as the single bound and this floor as the only thing stopping a per-tick fire.
  const intervalMinutes = i.policy.minIntervalMinutes;

  const lastFire = parsed.length ? Math.max(...parsed) : undefined;
  if (lastFire !== undefined) {
    const sinceMin = (i.now.getTime() - lastFire) / 60_000;
    if (sinceMin < intervalMinutes) {
      // STILL LOGGED, STILL NAMED. This reason string is how the rung is measured at all; a
      // branch that stopped emitting would leave the next investigation blind (this repo already
      // has one rung whose "daemon is not idle" reason is unreachable and appears 0 times in
      // 1,214 skip rows). One wording now, because there is one interval.
      return {
        fire: false,
        reason: `only ${sinceMin.toFixed(1)}m since the last fire (minInterval ${intervalMinutes}m)`,
      };
    }
  }

  const inWindow = parsed.filter((t) => i.now.getTime() - t < DAY_MS).length;
  if (inWindow >= i.policy.maxPerDay) {
    return { fire: false, reason: `daily cap reached (${inWindow}/${i.policy.maxPerDay} in the last 24h)` };
  }

  if (i.candidates.length === 0) return { fire: false, reason: "no feedback at status: new" };

  // OLDEST FIRST. Two reasons, and the second is the load-bearing one. (a) An entry that has waited
  // longest has, by construction, been declined by every prior fire — newest-first would starve the
  // tail forever, which is exactly the state the backlog is in now. (b) It is STABLE: the same
  // input yields the same pick, so a fire that fails and retries next period does not skip ahead.
  // THE REASON NAMES THE GATE THAT ACTUALLY HELD. It read "idle, under both bounds, …" until
  // W1-T469, which is the wording of a conjunct that no longer exists — a fired row asserting
  // idleness while the rung fires precisely on a BUSY tick would send the next investigation
  // looking for an idle period that never happened.
  // AND THE FIRED ROW NAMES ITS TRIGGER TOO. A fire that said only "under both bounds" would leave
  // the next investigation unable to tell a collision-driven fire from a starvation-driven one —
  // the same question the refusal above answers, asked from the other side.
  const trigger = i.deferralPending
    ? "a pairing deferred"
    : `capacity went unfilled (${i.dispatchCount}/${i.laneBudget} lanes)`;
  return {
    fire: true,
    feedbackId: i.candidates[0],
    reason: `${trigger}, under both bounds, oldest entry at status: new`,
  };
}

/**
 * Feedback ids at `status: new`, OLDEST FIRST, read from `<root>/plan/feedback/*.yaml`.
 *
 * Deliberately reads only the entry's OWN state. recon-CQ/recon-CS classified a large subset
 * (17 ANSWERED, 14 CLEARLY LIVE, 38 UNCERTAIN) but those verdicts live in report files, not in the
 * entries — consuming them would couple this rung to a markdown artifact nobody maintains.
 */
export function newFeedbackIdsOldestFirst(root: string): string[] {
  const dir = join(root, "plan", "feedback");
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; ts: string }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".yaml")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue; // an unreadable entry is skipped, never a reason to refuse the whole sweep
    }
    if (!/^status:\s*new\s*$/m.test(text)) continue;
    const ts = text.match(/^ts:\s*(\S+)\s*$/m)?.[1] ?? "";
    out.push({ id: name.replace(/\.yaml$/, ""), ts });
  }
  // `ts` sorts lexicographically because it is ISO-8601; the id is the tiebreak so the order is
  // total and stable rather than dependent on readdir order.
  out.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  return out.map((e) => e.id);
}
