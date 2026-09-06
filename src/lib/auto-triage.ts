import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { classifyPushFailure } from "./task-id-reservation.js";

/**
 * The daemon's second work-generating rung (recon-DC #2): claims and fires at most one feedback
 * entry per poll, so the backlog does not grow unbounded while the retro rung is the only other
 * thing that creates work.
 *
 * PURE decision half; the daemon's poll loop (daemon.ts) is the effecting half that reads the
 * marker and lock, calls the functions below, and performs the fire. Three independent bounds
 * must all pass: `enabled` (default false), the floor between fires (`minIntervalMinutes`), and
 * a rolling 24h cap (`maxPerDay`). A missing or corrupt marker fails closed (readAutoTriageMarker).
 *
 * The cross-host claim below (triageClaimRef) exists because the task id is minted before the
 * claim is taken, so two lanes can otherwise both start triaging the same entry — mirroring
 * task-id-reservation.ts's reserveTaskIdRemote, except a losing lane must refuse rather than
 * retry, since a second verdict on one entry can never merge.
 *
 * Why: the cost figures and collision incidents — docs/forensics/auto-triage.md#module-header.
 */

/** The lock both the daemon rung and the `rmd triage` CLI path acquire, so a hand-run during a
 *  fire is refused loudly rather than racing it. */
export function triageLockPath(root: string): string {
  return join(root, "state", "triage.lock");
}

// The cross-host triage claim (W1-T1132): triageLockPath above protects one host; this claim
// races a create-if-absent git ref on origin (same substrate as reserveTaskIdRemote in
// task-id-reservation.ts), taken BEFORE the Architect call since an open-PR check alone cannot
// see a triage still in flight.
// Why: the collision incident — docs/forensics/auto-triage.md#the-cross-host-triage-claim.

/** The ref one feedback id's triage claim occupies — under `refs/rmd-triage/`, invisible to a
 *  plain `git clone`/`fetch` and to `git ls-remote --heads`, matching `refs/rmd-id/`'s reasoning. */
export function triageClaimRef(feedbackId: string): string {
  return `refs/rmd-triage/${feedbackId}`;
}

/** One claim attempt's outcome. `taken` is contention; `unreachable` is a failed READ of the
 *  world and must never be read as "free" — see {@link decideTriageClaim}'s fail-closed arm. */
export type TriageClaimOutcome = "created" | "taken" | "unreachable";

/** Whether this lane may proceed, and the sentence a human or a ledger row gets either way. */
export interface TriageClaimDecision {
  readonly proceed: boolean;
  readonly reason: string;
}

/**
 * PURE. Turns one claim attempt's outcome into the proceed/refuse verdict and its wording. An
 * unreachable origin refuses rather than proceeding optimistically — proceeding once produced
 * two unmergeable verdicts for the same entry.
 * Why: docs/forensics/auto-triage.md#decidetriageclaim (#2452/#2462).
 */
export function decideTriageClaim(outcome: TriageClaimOutcome, ctx: { feedbackId: string; holder?: string }): TriageClaimDecision {
  if (outcome === "created") return { proceed: true, reason: `claimed ${triageClaimRef(ctx.feedbackId)} for this run` };
  if (outcome === "taken") {
    // Name the holder, not just "someone else": a ref and an anchor an operator can inspect.
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
 * PURE. Does any merged commit subject name this feedback entry? Matched as a plain substring,
 * never a regex — a feedback id may contain characters a pattern would need to escape.
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
 * PURE. Exactly three release arms, checked in order, with NO time-based expiry: the lane that
 * took the claim releases it on completion (`holder`); any host may release a claim whose entry
 * already has a merged outcome (`evidence`), since the entry is then demonstrably done; anything
 * else needs an operator, because cross-host liveness cannot be decided the way a pid lock decides it.
 * Why: why a timer was rejected — docs/forensics/auto-triage.md#decidetriageclaimrelease.
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

/** The one I/O seam. Every method is a git round trip; every decision above is pure and tested
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
 * The real reserver: an orphan commit over the empty tree pushed to the entry's own ref (no
 * `-p`, mirroring `gitRemoteRefReserver`) so this writer's payload is unrelated to every other's.
 * The commit message carries pid+host+time for an operator inspecting a stuck claim.
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
 * Takes the claim for `feedbackId`, or refuses. On contention this also runs the release's
 * evidence arm, since the losing lane holds fresh proof of whether the entry is already done —
 * a stale claim is dropped for the next lane instead of blocking it either way.
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
 * Applies the three-arm release. An `anchor` means this run is the holder (arm 1); otherwise the
 * decision falls to the evidence arm then the operator. {@link decideTriageClaimRelease} owns
 * the decision; this performs only the I/O it authorises.
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

/** {@link claimTriage} plus the one durable ledger row every caller needs, so every arm stays
 *  reachable from a unit test while the `run-task.ts` lane body only carries the call. */
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
 * {@link releaseTriageClaim} for the HOLDER arm, plus its ledger row. Runs in a `finally`, so a
 * throw here must never replace the lane's real outcome with a release failure — the cost of
 * swallowing is one ref an operator drops by hand.
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
 * Reads the marker. A malformed file resolves `corrupt`, NOT `absent` — the caller must fail
 * closed on it, matching the retro's marker handling, so a truncated write can never read as
 * "never fired" and re-authorise an unbounded run of spends.
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

/** Appends a fire and trims to the rolling window. Best-effort: a write failure is the caller's. */
export function recordAutoTriageFire(path: string, at: Date, windowMs: number): AutoTriageMarker {
  const prior = readAutoTriageMarker(path);
  const kept =
    prior.kind === "ok"
      ? prior.marker.fires.filter((f) => at.getTime() - Date.parse(f) < windowMs && !Number.isNaN(Date.parse(f)))
      : [];
  const marker: AutoTriageMarker = { fires: [...kept, at.toISOString()] };
  // The directory is created, not assumed, or an absent marker reads as "no prior fire" forever
  // and every tick pays for a re-read.
  // Why: the incident this fixed — docs/forensics/auto-triage.md#recordautotriagefire.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker, null, 2));
  return marker;
}

export interface AutoTriagePolicy {
  enabled: boolean;
  /** Floor between two fires — this repo's operator-ruled bound, and the only interval bound
   *  there is. Read directly, not gated behind a curve or any other mechanism. */
  minIntervalMinutes: number;
  /** Hard ceiling on a rolling 24h window — the only spend cap besides the floor above.
   *  Why: how this figure was sized — docs/forensics/auto-triage.md#autotriagepolicy-maxperday. */
  maxPerDay: number;
}

export interface AutoTriageInputs {
  policy: AutoTriagePolicy;
  /**
   * True when the partitioner deferred at least one pairing this tick — capacity and runnable
   * work both existed but were not paired. One of three trigger signals below; none requires the
   * daemon to be idle.
   * Why: why "idle" was replaced — docs/forensics/auto-triage.md#autotriageinputs-deferralpending.
   */
  deferralPending: boolean;
  /**
   * How many tasks this tick actually dispatched, against the lane budget available — the second
   * trigger: `dispatchCount < laneBudget` means the queue could not fill capacity. Numbers, not a
   * precomputed boolean, so this module can name which state applies.
   * Why: the four-state table — docs/forensics/auto-triage.md#autotriageinputs-dispatchcount-and-lanebudget.
   */
  dispatchCount: number;
  laneBudget: number;
  /** True when the shared triage lock is already held by a LIVE process (rung or hand-run). */
  lockHeld: boolean;
  marker: MarkerResolution;
  now: Date;
  /** Feedback ids at `status: new`, oldest first. Empty ⇒ nothing to do. */
  candidates: string[];
  /**
   * Age of the oldest candidate, in ms — kept separate from `candidates.length`: a count says
   * the backlog is growing, an age says the head of the queue is being passed over.
   * Observability only; not itself a trigger. Optional, defaulting to 0.
   */
  oldestCandidateAgeMs?: number;
}

export type AutoTriageDecision =
  | { fire: true; feedbackId: string; reason: string }
  | { fire: false; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decides whether to fire, and on WHAT. PURE. Cheapest and most consequential refusals run
 * first, so a disabled or locked fleet never even reads the candidate list.
 */
export function decideAutoTriage(i: AutoTriageInputs): AutoTriageDecision {
  if (!i.policy.enabled) return { fire: false, reason: "auto-triage disabled (policy.autoTriage.enabled=false)" };
  // Any one of three signals means "the fleet could use more work": a deferred pairing, unfilled
  // capacity, or a non-empty backlog.
  // Why: docs/forensics/auto-triage.md#the-decideautotriage-trigger (W1-T2289).
  const capacityUnfilled = i.dispatchCount < i.laneBudget;
  const backlogPresent = i.candidates.length > 0;
  if (!i.deferralPending && !capacityUnfilled && !backlogPresent) {
    // Name which branch declined: the lane signals are opposite conditions, and the backlog
    // signal is a third, independent way to decline (docs/forensics/auto-triage.md#naming-the-declined-branch).
    return {
      fire: false,
      reason:
        (i.laneBudget <= 0
          ? "no trigger this pass — no pairing deferred, and the governor left no lane capacity to fill"
          : `no trigger this pass — no pairing deferred, and the queue filled all ${i.laneBudget} available lane(s)`) +
        ", and no feedback is waiting at status: new (own-input depth 0)",
    };
  }
  if (i.lockHeld) return { fire: false, reason: "triage lock held — a run is already in flight" };
  if (i.marker.kind === "corrupt") return { fire: false, reason: "auto-triage marker unreadable — failing closed" };

  const fires = i.marker.kind === "ok" ? i.marker.marker.fires : [];
  const parsed = fires.map((f) => Date.parse(f)).filter((n) => !Number.isNaN(n));

  // The floor, read directly (operator ruling) — the only thing now stopping a per-tick fire.
  // Why: why the curve was removed — docs/forensics/auto-triage.md#the-interval-floor.
  const intervalMinutes = i.policy.minIntervalMinutes;

  const lastFire = parsed.length ? Math.max(...parsed) : undefined;
  if (lastFire !== undefined) {
    const sinceMin = (i.now.getTime() - lastFire) / 60_000;
    if (sinceMin < intervalMinutes) {
      // Named, not bare, so this refusal reason is measurable.
      // Why: docs/forensics/auto-triage.md#the-named-refusal-reason.
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

  // Oldest first: stable, and never starves the tail. The fire reason names its trigger
  // explicitly.
  // Why: the wording history — docs/forensics/auto-triage.md#oldest-first (W1-T469, W1-T2289).
  const trigger = i.deferralPending
    ? "a pairing deferred"
    : capacityUnfilled
      ? `capacity went unfilled (${i.dispatchCount}/${i.laneBudget} lanes)`
      : `the backlog's own depth reached ${i.candidates.length} at status: new while neither lane signal tripped ` +
        `(oldest waiting ${((i.oldestCandidateAgeMs ?? 0) / DAY_MS).toFixed(1)}d)`;
  return {
    fire: true,
    feedbackId: i.candidates[0],
    reason: `${trigger}, under both bounds, oldest entry at status: new`,
  };
}

/**
 * The one read of `<root>/plan/feedback/*.yaml` — both {@link newFeedbackIdsOldestFirst} (count)
 * and {@link oldestFeedbackAgeMs} (age) build on this single walk. Reads only each entry's own
 * `status:`, never a classification report.
 * Why: docs/forensics/auto-triage.md#feedbackentriesoldestfirst.
 */
function feedbackEntriesOldestFirst(root: string): Array<{ id: string; ts: string }> {
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
  return out;
}

/** Feedback ids at `status: new`, oldest first — the count half of
 *  {@link feedbackEntriesOldestFirst}'s one read; see {@link oldestFeedbackAgeMs} for the age half. */
export function newFeedbackIdsOldestFirst(root: string): string[] {
  return feedbackEntriesOldestFirst(root).map((e) => e.id);
}

/**
 * Age of the oldest `status: new` feedback entry, in ms — kept separate from
 * {@link newFeedbackIdsOldestFirst}'s count. Zero when the queue is empty, or when the oldest
 * entry's `ts` fails to parse — fail-soft: a bad timestamp never drops the entry.
 */
export function oldestFeedbackAgeMs(root: string, now: Date): number {
  const entries = feedbackEntriesOldestFirst(root);
  if (entries.length === 0) return 0;
  const parsed = Date.parse(entries[0].ts);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, now.getTime() - parsed);
}
