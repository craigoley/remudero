import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { holderFromLsRemote, type Awaitable, type ClaimGitDeps, type ClaimGitDepsAsync, type GitAnswer } from "./dispatch-claim.js";
import { fixedClock } from "./clock.js";
import { classifyPushFailure } from "./task-id-reservation.js";
import { assertClaimRefPushAllowed, assertClaimRefPushAllowedAsync } from "./live-write-guard.js";
import { hostWorktreeGit } from "./worktree-git.js";

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
  return `${TRIAGE_CLAIM_NAMESPACE}${feedbackId}`;
}

/** The ref namespace every triage claim lives under. */
export const TRIAGE_CLAIM_NAMESPACE = "refs/rmd-triage/";

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
export function decideTriageClaim(
  outcome: TriageClaimOutcome,
  ctx: { feedbackId: string; holder?: string; stderr?: string },
): TriageClaimDecision {
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
      `optimistically, which is the behaviour that spent two Architect calls on verdicts that could not merge` +
      (ctx.stderr?.trim() ? `; git said: ${ctx.stderr.trim()}` : ""),
  };
}

/**
 * PURE. Does any merged commit subject name this feedback entry? Matched as a plain substring,
 * never a regex — a feedback id may contain characters a pattern would need to escape.
 */
export function feedbackOutcomeObserved(subjects: readonly string[], feedbackId: string): boolean {
  return subjects.some((s) => s.includes(feedbackId));
}

/** Which release arm applies. `liveness` (W1-T4769) is the fourth, and still no bare timer: it
 *  fires only on a {@link TriageClaimLiveness} verdict from {@link assessTriageClaimLiveness}. */
export type TriageClaimReleaseArm = "holder" | "evidence" | "liveness" | "operator";

export interface TriageClaimReleaseDecision {
  readonly arm: TriageClaimReleaseArm;
  readonly release: boolean;
  readonly reason: string;
}

/**
 * PURE and clock-free. Arms, checked in order: the lane that took the claim releases it on
 * completion (`holder`); any host may release a claim whose entry already has a merged outcome
 * (`evidence`); a claim whose holder shows NEGATIVE LIVENESS EVIDENCE releases on `liveness` — the
 * verdict is computed by {@link assessTriageClaimLiveness}, which owns the only clock, so this
 * function only reads a verdict it is handed; anything else needs an operator.
 * Why: why a bare timer was rejected and why this arm is not one —
 * docs/forensics/auto-triage.md#decidetriageclaimrelease.
 */
export function decideTriageClaimRelease(i: {
  heldByThisRun: boolean;
  outcomeObserved: boolean;
  feedbackId: string;
  liveness?: TriageClaimLiveness;
}): TriageClaimReleaseDecision {
  if (i.heldByThisRun) return { arm: "holder", release: true, reason: `this run holds ${triageClaimRef(i.feedbackId)} and is done with it` };
  if (i.outcomeObserved)
    return {
      arm: "evidence",
      release: true,
      reason: `feedback#${i.feedbackId} already has a merged triage outcome, so its claim is stale and any host may drop it`,
    };
  if (i.liveness?.releasable === true) return { arm: "liveness", release: true, reason: `${triageClaimRef(i.feedbackId)}: ${i.liveness.reason}` };
  return {
    arm: "operator",
    release: false,
    reason:
      `${triageClaimRef(i.feedbackId)} is held by another lane with no merged outcome yet — leaving it` +
      (i.liveness ? ` (${i.liveness.reason})` : "") +
      `. Cross-host liveness is not decidable from here, so clearing it is an operator call: ` +
      `git push origin :${triageClaimRef(i.feedbackId)}`,
  };
}

/**
 * How long a claim's holder may be silent in the ledger before it counts as dead. Derived from the
 * triage lane's own shape, not a free number: the longest stretch that lane goes without writing a
 * row is the Architect call, which costs minutes (see the module header), and everything around it
 * (`triage.claim`, mint, PR open, CI wait, review) writes rows. Two hours is more than ten such
 * calls back to back, so a healthy triage is never inside it.
 */
export const TRIAGE_CLAIM_LIVENESS_WINDOW_MS = 2 * 60 * 60 * 1000;

/** BACKSTOP: several windows. Past it an UNOBSERVABLE holder (one this ledger has never seen, or
 *  whose anchor does not parse) is released on age alone, and says so. */
export const TRIAGE_CLAIM_AGE_ONLY_CEILING_MS = 6 * TRIAGE_CLAIM_LIVENESS_WINDOW_MS;

/** How far before the claim a row from the holder's host still proves this ledger can see it. */
export const TRIAGE_CLAIM_HOST_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** The holder identity `gitTriageClaimReserver.mintAnchor` writes into the anchor commit message. */
export interface TriageClaimHolder {
  readonly pid: number;
  readonly host: string;
  readonly claimedAt: string;
}

/** PURE. Parses `rmd-triage claim <pid>@<host> <iso>`; `undefined` when it does not match. */
export function parseTriageClaimAnchorMessage(message: string): TriageClaimHolder | undefined {
  const m = /^rmd-triage claim (\d+)@(\S+) (\d{4}-\d{2}-\d{2}T\S+)\s*$/m.exec(message);
  if (!m) return undefined;
  if (Number.isNaN(Date.parse(m[3]))) return undefined;
  return { pid: Number(m[1]), host: m[2], claimedAt: m[3] };
}

/** The slice of a ledger row the assessor reads. */
export interface TriageLivenessRow {
  readonly ts?: unknown;
  readonly host?: unknown;
  readonly actor_pid?: unknown;
}

/** The assessor's named verdict — never a boolean. */
export type TriageClaimLivenessVerdict = "dead" | "alive" | "unobservable";

export interface TriageClaimLiveness {
  readonly verdict: TriageClaimLivenessVerdict;
  /** True when {@link decideTriageClaimRelease} may drop the claim on the liveness arm. */
  readonly releasable: boolean;
  /** `silent` = negative evidence; `age-only` = the second tier, no evidence either way. */
  readonly tier?: "silent" | "age-only";
  readonly reason: string;
  readonly holderHost?: string;
  readonly holderPid?: number;
  readonly claimedAt?: string;
  /** Latest row seen from the holder's host, if any. */
  readonly lastHostRowTs?: string;
}

/**
 * PURE. Judges whether a claim's holder is still alive from the ledger rows it can see. `rows`
 * is `undefined` when the ledger union was unreadable — that is `unobservable`, never `dead`,
 * since compaction prunes the live file and a missing row is not evidence of silence.
 *
 *  - `alive`: the claim is younger than `windowMs`, or the holder's own `host` + `actor_pid`
 *    wrote a row inside the last window. (Not merely "after the claim": the holder's own
 *    `triage.claim` row is written right after the anchor, so that test could never fail.)
 *  - `dead`: older than the window, AND rows from that host are visible (the positive control that
 *    this ledger can see the host at all), AND none from that host + pid inside the window.
 *  - `unobservable`: anchor did not parse, rows unreadable, or the host was never seen. Releasable
 *    only past {@link TRIAGE_CLAIM_AGE_ONLY_CEILING_MS}, as tier `age-only`.
 */
export function assessTriageClaimLiveness(i: {
  holder: TriageClaimHolder | undefined;
  rows: readonly TriageLivenessRow[] | undefined;
  now: Date;
  windowMs?: number;
  ceilingMs?: number;
}): TriageClaimLiveness {
  const windowMs = i.windowMs ?? TRIAGE_CLAIM_LIVENESS_WINDOW_MS;
  const ceilingMs = i.ceilingMs ?? TRIAGE_CLAIM_AGE_ONLY_CEILING_MS;
  const nowMs = i.now.getTime();
  const claimedAt = i.holder?.claimedAt;
  const claimedMs = claimedAt === undefined ? Number.NaN : Date.parse(claimedAt);
  const ageMs = nowMs - claimedMs;
  const base = { holderHost: i.holder?.host, holderPid: i.holder?.pid, claimedAt };
  const mins = (ms: number): number => Math.round(ms / 60_000);
  if (!Number.isNaN(ageMs) && ageMs < windowMs)
    return { ...base, verdict: "alive", releasable: false, reason: `claimed ${mins(ageMs)}m ago, inside the ${mins(windowMs)}m liveness window` };

  const unobservable = (why: string, lastHostRowTs?: string): TriageClaimLiveness => {
    const past = !Number.isNaN(ageMs) && ageMs >= ceilingMs;
    const hours = Math.round(ceilingMs / 3_600_000);
    return {
      ...base,
      lastHostRowTs,
      verdict: "unobservable",
      releasable: past,
      tier: past ? "age-only" : undefined,
      reason: past
        ? `${why}; released on AGE ALONE — no liveness evidence either way, claim older than ${hours}h`
        : `${why}; not released as dead — only an age-only release past ${hours}h applies`,
    };
  };
  if (i.holder === undefined) return unobservable("the claim anchor does not name a holder");
  if (i.rows === undefined) return unobservable("the ledger union was unreadable");

  let hostSeen = false;
  let lastHostTs: string | undefined;
  let lastHostMs = Number.NEGATIVE_INFINITY;
  let lastHolderMs = Number.NEGATIVE_INFINITY;
  for (const row of i.rows) {
    if (row.host !== i.holder.host || typeof row.ts !== "string") continue;
    const t = Date.parse(row.ts);
    if (Number.isNaN(t) || t < claimedMs - TRIAGE_CLAIM_HOST_LOOKBACK_MS) continue;
    hostSeen = true;
    if (t > lastHostMs) {
      lastHostMs = t;
      lastHostTs = row.ts;
    }
    if (row.actor_pid === i.holder.pid && t > lastHolderMs) lastHolderMs = t;
  }
  if (!hostSeen) return unobservable(`this ledger has never seen host ${i.holder.host}`);
  if (nowMs - lastHolderMs < windowMs)
    return {
      ...base,
      lastHostRowTs: lastHostTs,
      verdict: "alive",
      releasable: false,
      reason: `host ${i.holder.host} pid ${i.holder.pid} wrote a ledger row inside the last ${mins(windowMs)}m`,
    };
  return {
    ...base,
    lastHostRowTs: lastHostTs,
    verdict: "dead",
    releasable: true,
    tier: "silent",
    reason: `holder ${i.holder.pid}@${i.holder.host} claimed at ${claimedAt} and wrote no ledger row in the last ${mins(windowMs)}m (host last seen ${lastHostTs})`,
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
  /** W1-T4769: the commit MESSAGE of the anchor at the claim ref (`rmd-triage claim <pid>@<host> <iso>`),
   *  or `undefined` when absent or unfetchable. Optional so existing reservers stay valid. */
  holderMessage?(feedbackId: string): string | undefined;
  /** W1-T4769: every feedback id currently claimed, with its ref sha, from ONE `ls-remote` of
   *  `refs/rmd-triage/*`. `undefined` when the namespace is unreadable — NOT an empty map. */
  claimedIds?(): ReadonlyMap<string, string> | undefined;
  /** The last mint's or attempt's git stderr, `undefined` on success or none yet; optional. */
  lastAttemptStderr?(): string | undefined;
}

/** {@link TriageClaimReserver}, awaitable: its sync git held the daemon loop (~543 s per 17 h,
 *  2026-10-06). Every composite below awaits each value, so a sync reserver still fits. */
export interface TriageClaimReserverAsync {
  mintAnchor(): Awaitable<string>;
  attempt(feedbackId: string, anchor: string): Awaitable<TriageClaimOutcome>;
  holder(feedbackId: string): Awaitable<string | undefined>;
  drop(feedbackId: string, opts?: { expect?: string }): Awaitable<boolean>;
  holderMessage?(feedbackId: string): Awaitable<string | undefined>;
  claimedIds?(): Awaitable<ReadonlyMap<string, string> | undefined>;
  lastAttemptStderr?(): string | undefined;
}

function triageAnchorMessage(): string {
  return `rmd-triage claim ${process.pid}@${hostname()} ${new Date().toISOString()}`;
}

function triagePushArgs(feedbackId: string, anchor: string): string[] {
  return ["push", "origin", `${anchor}:${triageClaimRef(feedbackId)}`];
}

function triageDropArgs(feedbackId: string, expect: string | undefined): string[] {
  const ref = triageClaimRef(feedbackId);
  return expect ? ["push", `--force-with-lease=${ref}:${expect}`, "origin", `:${ref}`] : ["push", "origin", `:${ref}`];
}

function triageAttemptOutcome(res: GitAnswer): TriageClaimOutcome {
  return res.status === 0 ? "created" : classifyPushFailure(res.stderr);
}

function messageFromFetchHeadLog(res: GitAnswer): string | undefined {
  return res.status === 0 ? res.stdout : undefined;
}

function triageIdsFromLsRemote(res: GitAnswer): ReadonlyMap<string, string> | undefined {
  if (res.status !== 0) return undefined;
  const out = new Map<string, string>();
  for (const line of res.stdout.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref?.startsWith(TRIAGE_CLAIM_NAMESPACE)) out.set(ref.slice(TRIAGE_CLAIM_NAMESPACE.length), sha);
  }
  return out;
}

/** The anchor commit, or `""` with the failing step's stderr: an empty anchor pushed as
 *  `:<ref>` would DELETE the ref, so {@link claimTriage} refuses it as `unreachable`. */
function anchorFromCommitTree(res: GitAnswer): { anchor: string; stderr?: string } {
  if (res.status === 0) return { anchor: res.stdout.trim() };
  return { anchor: "", stderr: `minting the claim anchor failed: ${res.stderr.trim()}` };
}

/**
 * The real reserver: an orphan commit over the empty tree pushed to the entry's own ref (no
 * `-p`, mirroring `gitRemoteRefReserver`) so this writer's payload is unrelated to every other's.
 * The commit message carries pid+host+time for an operator inspecting a stuck claim.
 */
export function gitTriageClaimReserver(deps: ClaimGitDeps): TriageClaimReserver {
  let lastStderr: string | undefined;
  return {
    lastAttemptStderr: () => lastStderr,
    mintAnchor() {
      if (deps.anchor) return deps.anchor();
      const tree = deps.run(["hash-object", "-t", "tree", "/dev/null"]);
      const minted = anchorFromCommitTree(tree.status === 0 ? deps.run(["commit-tree", tree.stdout.trim(), "-m", triageAnchorMessage()]) : tree);
      lastStderr = minted.stderr;
      return minted.anchor;
    },
    attempt(feedbackId, anchor) {
      assertClaimRefPushAllowed(deps.run, triageClaimRef(feedbackId));
      const res = deps.run(triagePushArgs(feedbackId, anchor));
      lastStderr = res.status === 0 ? undefined : res.stderr;
      return triageAttemptOutcome(res);
    },
    holder(feedbackId) {
      return holderFromLsRemote(deps.run(["ls-remote", "origin", triageClaimRef(feedbackId)]));
    },
    holderMessage(feedbackId) {
      if (deps.run(["fetch", "origin", triageClaimRef(feedbackId)]).status !== 0) return undefined;
      return messageFromFetchHeadLog(deps.run(["log", "-1", "--format=%B", "FETCH_HEAD"]));
    },
    claimedIds() {
      return triageIdsFromLsRemote(deps.run(["ls-remote", "origin", `${TRIAGE_CLAIM_NAMESPACE}*`]));
    },
    drop(feedbackId, opts = {}) {
      assertClaimRefPushAllowed(deps.run, triageClaimRef(feedbackId));
      return deps.run(triageDropArgs(feedbackId, opts.expect)).status === 0;
    },
  };
}

/** {@link gitTriageClaimReserver}, awaited: the same argv and the same parse of every git answer,
 *  so the two cannot drift; run it through `gitClaimRunnerAsync`, whose timeout reads `unreachable`. */
export function gitTriageClaimReserverAsync(deps: ClaimGitDepsAsync): TriageClaimReserverAsync {
  let lastStderr: string | undefined;
  return {
    lastAttemptStderr: () => lastStderr,
    async mintAnchor() {
      if (deps.anchor) return deps.anchor();
      const tree = await deps.run(["hash-object", "-t", "tree", "/dev/null"]);
      const minted = anchorFromCommitTree(tree.status === 0 ? await deps.run(["commit-tree", tree.stdout.trim(), "-m", triageAnchorMessage()]) : tree);
      lastStderr = minted.stderr;
      return minted.anchor;
    },
    async attempt(feedbackId, anchor) {
      await assertClaimRefPushAllowedAsync(deps.run, triageClaimRef(feedbackId));
      const res = await deps.run(triagePushArgs(feedbackId, anchor));
      lastStderr = res.status === 0 ? undefined : res.stderr;
      return triageAttemptOutcome(res);
    },
    async holder(feedbackId) {
      return holderFromLsRemote(await deps.run(["ls-remote", "origin", triageClaimRef(feedbackId)]));
    },
    async holderMessage(feedbackId) {
      if ((await deps.run(["fetch", "origin", triageClaimRef(feedbackId)])).status !== 0) return undefined;
      return messageFromFetchHeadLog(await deps.run(["log", "-1", "--format=%B", "FETCH_HEAD"]));
    },
    async claimedIds() {
      return triageIdsFromLsRemote(await deps.run(["ls-remote", "origin", `${TRIAGE_CLAIM_NAMESPACE}*`]));
    },
    async drop(feedbackId, opts = {}) {
      await assertClaimRefPushAllowedAsync(deps.run, triageClaimRef(feedbackId));
      return (await deps.run(triageDropArgs(feedbackId, opts.expect))).status === 0;
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
 * a stale claim is dropped for the next lane instead of blocking it either way. An empty anchor
 * (a failed mint) is refused as `unreachable` and never pushed: `:<ref>` would delete the ref.
 */
export async function claimTriage(
  feedbackId: string,
  reserver: TriageClaimReserverAsync,
  opts: { mergedSubjects?: () => readonly string[] } = {},
): Promise<TriageClaimResult> {
  const anchor = await reserver.mintAnchor();
  if (!anchor) return decideTriageClaim("unreachable", { feedbackId, stderr: reserver.lastAttemptStderr?.() ?? "the claim anchor came back empty" });
  const outcome = await reserver.attempt(feedbackId, anchor);
  if (outcome === "created") return { ...decideTriageClaim(outcome, { feedbackId }), anchor };
  const holder = outcome === "taken" ? await reserver.holder(feedbackId) : undefined;
  const decision = decideTriageClaim(outcome, { feedbackId, holder, stderr: reserver.lastAttemptStderr?.() });
  if (outcome !== "taken") return decision;
  const observed = feedbackOutcomeObserved(opts.mergedSubjects?.() ?? [], feedbackId);
  const released = await releaseTriageClaim(feedbackId, reserver, { outcomeObserved: observed });
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
export async function releaseTriageClaim(
  feedbackId: string,
  reserver: TriageClaimReserverAsync,
  i: { anchor?: string; outcomeObserved?: boolean; liveness?: TriageClaimLiveness; heldSha?: string } = {},
): Promise<TriageClaimReleaseResult> {
  const decision = decideTriageClaimRelease({
    heldByThisRun: i.anchor !== undefined,
    outcomeObserved: i.outcomeObserved === true,
    feedbackId,
    liveness: i.liveness,
  });
  if (!decision.release) return { ...decision, dropped: false };
  // The liveness arm deletes conditionally on the sha it judged, so a claim that changed hands
  // between the judgement and the delete is never dropped.
  const expect = i.anchor ?? (decision.arm === "liveness" ? i.heldSha : undefined);
  return { ...decision, dropped: await reserver.drop(feedbackId, expect !== undefined ? { expect } : {}) };
}

/** What {@link sweepTriageClaims} learned. `held` is `undefined` when the claim namespace was
 *  unreadable — a third value the caller must see, never an empty set standing in for it. */
export interface TriageClaimSweep {
  readonly held: readonly string[] | undefined;
  readonly released: readonly string[];
}

/**
 * Reads the claim namespace ONCE, then for each claimed candidate judges the holder's liveness and
 * releases a dead one on the `liveness` arm, ledgering `triage.claim_released` with its evidence.
 * Returns the ids STILL held. `readRows` is called lazily and at most once, and only when some
 * claim is already past the window (a young claim needs no ledger to be `alive`). A reserver
 * without the optional methods yields `held: undefined` — today's behaviour.
 */
export async function sweepTriageClaims(
  candidates: readonly string[],
  reserver: TriageClaimReserverAsync,
  o: {
    now: Date;
    /** Rows stamped at or after `sinceIso`, or `undefined` when the ledger union was unreadable. */
    readRows: (sinceIso: string) => readonly TriageLivenessRow[] | undefined;
    log: (step: string, extra?: Record<string, unknown>) => void;
    mergedSubjects?: () => readonly string[];
  },
): Promise<TriageClaimSweep> {
  const claimed = await reserver.claimedIds?.();
  if (claimed === undefined) return { held: undefined, released: [] };
  const held: string[] = [];
  const released: string[] = [];
  let rows: readonly TriageLivenessRow[] | undefined;
  let rowsRead = false;
  for (const id of candidates) {
    const sha = claimed.get(id);
    if (sha === undefined) continue;
    const holder = parseTriageClaimAnchorMessage((await reserver.holderMessage?.(id)) ?? "");
    let liveness = assessTriageClaimLiveness({ holder, rows: undefined, now: o.now });
    if (liveness.verdict !== "alive" && holder !== undefined) {
      if (!rowsRead) {
        rowsRead = true;
        rows = o.readRows(fixedClock(Date.parse(holder.claimedAt) - TRIAGE_CLAIM_HOST_LOOKBACK_MS).iso());
      }
      liveness = assessTriageClaimLiveness({ holder, rows, now: o.now });
    }
    const result = await releaseTriageClaim(id, reserver, {
      outcomeObserved: feedbackOutcomeObserved(o.mergedSubjects?.() ?? [], id),
      liveness,
      heldSha: sha,
    });
    if (result.release) {
      o.log("triage.claim_released", {
        feedback_id: id,
        ref: triageClaimRef(id),
        arm: result.arm,
        tier: result.arm === "liveness" ? liveness.tier : undefined,
        dropped: result.dropped,
        reason: result.reason,
        verdict: liveness.verdict,
        holder_host: liveness.holderHost,
        holder_pid: liveness.holderPid,
        claimed_at: liveness.claimedAt,
        last_host_row_ts: liveness.lastHostRowTs,
      });
    }
    if (result.release && result.dropped) released.push(id);
    else held.push(id);
  }
  return { held, released };
}

/** {@link claimTriage} plus the one durable ledger row every caller needs, so every arm stays
 *  reachable from a unit test while the `run-task.ts` lane body only carries the call. */
export async function claimTriageWithLogging(
  log: (step: string, extra?: Record<string, unknown>) => void,
  feedbackId: string,
  reserver: TriageClaimReserverAsync,
  opts: { mergedSubjects?: () => readonly string[] } = {},
): Promise<TriageClaimResult> {
  const result = await claimTriage(feedbackId, reserver, opts);
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
export async function releaseTriageClaimWithLogging(
  log: (step: string, extra?: Record<string, unknown>) => void,
  feedbackId: string,
  reserver: TriageClaimReserverAsync,
  anchor: string,
): Promise<TriageClaimReleaseResult> {
  let result: TriageClaimReleaseResult;
  try {
    result = await releaseTriageClaim(feedbackId, reserver, { anchor });
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
  /**
   * W1-T4769: candidates whose triage claim is still held by a live (or unjudgeable) holder, from
   * {@link sweepTriageClaims}. The fire goes to the oldest candidate NOT in this set. `undefined`
   * means the claim namespace was unreadable — today's behaviour: take the oldest and let the
   * lane's own claim decide. Never an empty set standing in for "unknown".
   */
  heldCandidates?: readonly string[];
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
  const heldSet = new Set(i.heldCandidates ?? []);
  const target = i.candidates.find((c) => !heldSet.has(c));
  if (target === undefined) {
    return {
      fire: false,
      reason: `every one of the ${i.candidates.length} candidate(s) at status: new is held by a live triage claim — nothing to fire on`,
    };
  }
  const passedOver = i.candidates.indexOf(target);
  return {
    fire: true,
    feedbackId: target,
    reason:
      passedOver === 0
        ? `${trigger}, under both bounds, oldest entry at status: new`
        : `${trigger}, under both bounds, oldest unclaimed entry at status: new (passed over ${passedOver} held by a live claim)`,
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

/** The feedback entry's `status:` as committed on origin/main — the daemon's own checkout can lag a merged
 *  triage (#10265). `undefined` when the ref, the file or the field cannot be read. */
export function feedbackStatusOnMain(root: string, feedbackId: string): string | undefined {
  let text: string;
  try {
    text = hostWorktreeGit(root, ["show", `origin/main:plan/feedback/${feedbackId}.yaml`], { timeout: 10_000 });
  } catch (error) {
    // A missing ref/file is an unreadable main status. Preserve security refusals from the leaf.
    if (error !== null && typeof error === "object" && "status" in error) return undefined;
    throw error;
  }
  return /^status:\s*(\S+)\s*$/m.exec(text)?.[1];
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
