import { hostname } from "node:os";
import { classifyPushFailure } from "./task-id-reservation.js";

/**
 * lib/dispatch-claim.ts — the SAME cross-host git-ref-CAS family (W1-T509's `refs/rmd-id/`,
 * W1-T1132's `refs/rmd-triage/`) pointed at a second rung (W1-T1268).
 *
 * THE GAP. `isDispatchEligible` (src/lib/drain.ts) decides in-flight from ten probes; the two
 * concurrency-bearing ones (`isOpenPr`, `hasPushedRunBranch`) both read a PUBLISHED artifact — an
 * open PR or a pushed `run-<id>-<epoch>` branch. Neither exists at the moment a lane, OR AN
 * OPERATOR dispatching beside the fleet, decides to start a task. Two starts inside that window
 * both read nothing published and both spend a run — MEASURED 2026-08-23:
 * `run-W1-T1265-1787503038601` (#2625) and `run-W1-T1265-1787503092377` (#2626) branched
 * 53.776 SECONDS apart, both having correctly found no open PR, no pushed branch, and no
 * inflight lock (the same-host guard, `inflight-lock.ts`, cannot see a foreign host's pid — that
 * is the strictly cross-host, strictly pre-artifact gap this closes).
 *
 * WHAT THIS ADDS, AND WHAT IT DOES NOT. A claim is taken BEFORE any spend — see `run-task.ts`'s
 * dispatch-claim seam — the same position `decideTriageClaim` occupies ahead of the Architect
 * call, and for the identical reason: a probe that reads PUBLISHED work cannot see work (or an
 * operator's own dispatch) that has published nothing yet. It REPLACES none of the ten probes
 * (`isMerged` is terminality; `isOpenPr`/`hasPushedRunBranch` keep their own stale-credit and
 * closed-unmerged duties, unchanged) and it does NOT widen `inflight-lock.ts`, which is
 * same-host by design (`isHolderStale` puts host first, W1-T396) and stays that way — a second
 * host cannot ask whether a pid on the first is alive, which is exactly why that lock could
 * never have been widened into this.
 *
 * MIRRORS `auto-triage.ts`'s triage claim STRUCTURALLY, not by import: same substrate (an orphan
 * `commit-tree` over the empty tree, pushed with a PLAIN refspec so a second writer is
 * structurally a non-fast-forward), same `classifyPushFailure` (imported, not re-derived — two
 * copies of "is this contention or an unreachable remote" is two places for it to drift), same
 * three-outcome attempt / three-arm release shape, and NO TIME-BASED EXPIRY of any kind. A
 * SEPARATE ref namespace (`refs/rmd-dispatch/`, not `refs/rmd-triage/`) because the obvious noun
 * is already taken twice over: "claim" belongs to `plan/claims.yaml`'s falsifiable assertions
 * (a red claim means the plan is lying), and "reconcile" belongs to the escalation-issue
 * lifecycle. The rung-qualified compound — `dispatchClaimRef`, never a bare "claim" — is the
 * repo's own existing disambiguator, the same one `triageClaimRef` already uses.
 */

/** The ref one task's dispatch claim occupies. `refs/rmd-dispatch/` — a namespace `git
 *  clone`/`git fetch` does not replicate by default and `git ls-remote --heads` cannot see, the
 *  same two properties that made `refs/rmd-id/` and `refs/rmd-triage/` safe to introduce. */
export function dispatchClaimRef(taskId: string): string {
  return `refs/rmd-dispatch/${taskId}`;
}

/** One claim attempt's outcome. `taken` is contention; `unreachable` is a failed READ of the
 *  world and must never be read as "free" — see {@link decideDispatchClaim}'s fail-closed arm. */
export type DispatchClaimOutcome = "created" | "taken" | "unreachable";

/** Whether this lane may proceed, and the sentence a human or a ledger row gets either way. */
export interface DispatchClaimDecision {
  readonly proceed: boolean;
  readonly reason: string;
}

/**
 * PURE. Turn one attempt outcome into the proceed/refuse verdict and its wording.
 *
 * AN UNREACHABLE ORIGIN REFUSES, matching `decideTriageClaim`'s own fail-closed choice for the
 * same reason: dispatching optimistically on an unreadable remote is precisely the behaviour
 * that let two hosts each read "no open PR, no pushed branch" and each spend a run. Refusing is
 * loud and costs nothing — this fires before the inflight lock, before the worktree, before any
 * spawn.
 */
export function decideDispatchClaim(outcome: DispatchClaimOutcome, ctx: { taskId: string; holder?: string }): DispatchClaimDecision {
  if (outcome === "created") return { proceed: true, reason: `claimed ${dispatchClaimRef(ctx.taskId)} for this run` };
  if (outcome === "taken") {
    // NAMED, NOT ANONYMOUS: the ref AND the anchor a live holder wrote — the difference between
    // a refusal an operator can act on and a mystery (same argument `decideTriageClaim` makes).
    const held = ctx.holder ? ` (held by ${ctx.holder})` : "";
    return {
      proceed: false,
      reason:
        `${ctx.taskId} is already claimed by another lane — ${dispatchClaimRef(ctx.taskId)}${held}. ` +
        `Refusing before any spend: a second dispatch of one task either duplicates work already in ` +
        `flight or races it to a conflicting PR — the exact cost measured when two lanes both built ` +
        `W1-T1265 branches 53.776 seconds apart, neither able to see the other's unpublished start.`,
    };
  }
  return {
    proceed: false,
    reason:
      `cannot reach origin to claim ${dispatchClaimRef(ctx.taskId)} — refusing rather than dispatching ` +
      `optimistically, which is the behaviour that let two hosts each see nothing published and each spend`,
  };
}

/** Which of the three release arms applies. There is no fourth, and deliberately no timer. */
export type DispatchClaimReleaseArm = "holder" | "evidence" | "operator";

export interface DispatchClaimReleaseDecision {
  readonly arm: DispatchClaimReleaseArm;
  readonly release: boolean;
  readonly reason: string;
}

/**
 * PURE. The three-arm release, in order, with NO TIME-BASED EXPIRY — mirrors
 * `decideTriageClaimRelease` exactly; see that function's own doc for why a timer is refused
 * ("a claim that outlives its lane is a visible ref an operator can drop; a claim that expires
 * under a running lane re-opens the exact race this exists to close").
 *
 *  1. HOLDER — the run that took the claim drops it when done, in a `finally`, success or not.
 *  2. EVIDENCE — `evidenceObserved` is the CALLER's own predicate, exactly what `isMerged`,
 *     `readLiveState`/`isLiveMergeCredited` and `closedUnmergedRunBranches` already read at the
 *     dispatch rung (`isDispatchEligible`, src/lib/drain.ts) — this module supplies no new
 *     probe, it re-uses theirs. A claim whose task is demonstrably done is demonstrably stale,
 *     so any host may drop it; no liveness question is asked because none can be answered.
 *  3. OPERATOR — anything else. Cross-host liveness is NOT decidable (the reason
 *     `isHolderStale` refuses to widen into a cross-host question at all, W1-T396), so the
 *     honest answer is a person, not a guess.
 */
export function decideDispatchClaimRelease(i: { heldByThisRun: boolean; evidenceObserved: boolean; taskId: string }): DispatchClaimReleaseDecision {
  if (i.heldByThisRun) return { arm: "holder", release: true, reason: `this run holds ${dispatchClaimRef(i.taskId)} and is done with it` };
  if (i.evidenceObserved)
    return {
      arm: "evidence",
      release: true,
      reason: `${i.taskId}'s work is already observed landed, so its claim is stale and any host may drop it`,
    };
  return {
    arm: "operator",
    release: false,
    reason:
      `${dispatchClaimRef(i.taskId)} is held by another lane with no landed work observed yet — leaving it. ` +
      `Cross-host liveness is not decidable, so clearing it is an operator call: ` +
      `git push origin :${dispatchClaimRef(i.taskId)}`,
  };
}

/** The one I/O seam. Every method is a git round trip; every DECISION above is pure and tested
 *  without one — the risk-high band this task ships under (a pure decision module plus its one
 *  I/O seam), mirroring `TriageClaimReserver` exactly. */
export interface DispatchClaimReserver {
  /** A payload unique to THIS writer — two writers must never produce the same value, or the
   *  create-if-absent stops discriminating and the claim silently stops claiming. */
  mintAnchor(): string;
  /** Create-if-absent of {@link dispatchClaimRef}. Never throws: an unreachable remote is an
   *  OUTCOME, because a throw at this seam reads identically to contention at the caller. */
  attempt(taskId: string, anchor: string): DispatchClaimOutcome;
  /** The anchor currently at the claim ref, or `undefined` when absent or unreadable. */
  holder(taskId: string): string | undefined;
  /** Delete the claim ref. `expect` makes the delete conditional on the ref still carrying THAT
   *  anchor, so the holder arm can never delete a claim that has since become someone else's. */
  drop(taskId: string, opts?: { expect?: string }): boolean;
}

export interface DispatchClaimGitDeps {
  /** Runs a git argv; returns its exit status, stdout and stderr. Injected by tests. */
  run(args: string[]): { status: number; stdout: string; stderr: string };
  /** Overrides the anchor so a test can make two writers distinguishable. */
  anchor?: () => string;
}

/**
 * The real reserver: an orphan commit over the empty tree, pushed to the task's own ref.
 *
 * `commit-tree` with NO `-p` is what makes this writer's payload unrelated to every other
 * writer's — the same argument `gitTriageClaimReserver` makes, and the reason this mirrors it
 * rather than inventing a second scheme. The message carries pid+host+time so an operator
 * inspecting a stuck claim can see who took it, and it doubles as the uniqueness source: two
 * writers on one host in the same millisecond still differ by pid.
 */
export function gitDispatchClaimReserver(deps: DispatchClaimGitDeps): DispatchClaimReserver {
  return {
    mintAnchor() {
      if (deps.anchor) return deps.anchor();
      const tree = deps.run(["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
      const msg = `rmd-dispatch claim ${process.pid}@${hostname()} ${new Date().toISOString()}`;
      return deps.run(["commit-tree", tree, "-m", msg]).stdout.trim();
    },
    attempt(taskId, anchor) {
      const res = deps.run(["push", "origin", `${anchor}:${dispatchClaimRef(taskId)}`]);
      if (res.status === 0) return "created";
      return classifyPushFailure(res.stderr);
    },
    holder(taskId) {
      const res = deps.run(["ls-remote", "origin", dispatchClaimRef(taskId)]);
      if (res.status !== 0) return undefined;
      const sha = res.stdout.trim().split(/\s+/)[0];
      return sha ? sha : undefined;
    },
    drop(taskId, opts = {}) {
      const ref = dispatchClaimRef(taskId);
      const args = opts.expect
        ? ["push", `--force-with-lease=${ref}:${opts.expect}`, "origin", `:${ref}`]
        : ["push", "origin", `:${ref}`];
      return deps.run(args).status === 0;
    },
  };
}

/** {@link decideDispatchClaimRelease}'s verdict plus whether the ref was actually dropped. */
export interface DispatchClaimReleaseResult extends DispatchClaimReleaseDecision {
  readonly dropped: boolean;
}

/**
 * Apply the three-arm release. `anchor` present ⇒ this run is the holder (arm 1); absent, the
 * decision falls to the evidence arm and then to the operator. The DECISION is
 * {@link decideDispatchClaimRelease}'s alone — this function only performs the I/O it
 * authorises, mirroring `releaseTriageClaim` exactly (which is why the operator arm can be
 * asserted without a git remote existing at all).
 */
export function releaseDispatchClaim(
  taskId: string,
  reserver: DispatchClaimReserver,
  i: { anchor?: string; evidenceObserved?: boolean } = {},
): DispatchClaimReleaseResult {
  const decision = decideDispatchClaimRelease({
    heldByThisRun: i.anchor !== undefined,
    evidenceObserved: i.evidenceObserved === true,
    taskId,
  });
  if (!decision.release) return { ...decision, dropped: false };
  return { ...decision, dropped: reserver.drop(taskId, i.anchor !== undefined ? { expect: i.anchor } : {}) };
}
