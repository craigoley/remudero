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
 * TWO LANES — #2625 and #2626 — branched 53.776 SECONDS apart, both having correctly found no
 * open PR, no pushed branch, and no inflight lock (the same-host guard, `inflight-lock.ts`,
 * cannot see a foreign host's pid — that is the strictly cross-host, strictly pre-artifact gap
 * this closes).
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
export function decideDispatchClaim(
  outcome: DispatchClaimOutcome,
  ctx: { taskId: string; holder?: string; stderr?: string },
): DispatchClaimDecision {
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
  // W1-T2552: NAME THE CAUSE, NOT JUST THE CATEGORY. `classifyPushFailure` collapses auth, DNS,
  // proxy and timeout into one word, so "cannot reach origin" is the WIDEST true statement rather
  // than a diagnosis — and the git stderr that would have distinguished them was discarded here.
  // A single line of it is the difference between an operator reading the answer and bisecting for
  // it (MEASURED 2026-08-30: the cause was a missing credential helper, and the stderr said so).
  // Collapsed to one line and bounded, because this string lands in a ledger row and a console.
  const detail = (ctx.stderr ?? "").replace(/\s+/g, " ").trim();
  const named = detail ? ` git said: ${detail.slice(0, 300)}` : "";
  return {
    proceed: false,
    reason:
      `cannot reach origin to claim ${dispatchClaimRef(ctx.taskId)} — refusing rather than dispatching ` +
      `optimistically, which is the behaviour that let two hosts each see nothing published and each spend.` +
      named,
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
  /**
   * W1-T2552: git's OWN stderr from the most recent {@link attempt}, or `undefined` when the last
   * attempt succeeded or none has run. OPTIONAL so every existing fake still satisfies this
   * interface unchanged — a reserver that does not implement it simply yields a refusal worded
   * exactly as it is today.
   *
   * WHY THIS EXISTS. {@link classifyPushFailure} collapses every non-contention failure to the
   * single word "unreachable", and the refusal below then said "cannot reach origin" and threw the
   * message away. MEASURED 2026-08-30: the real stderr was `fatal: could not read Username for
   * 'https://github.com': No such device or address` — a MISSING CREDENTIAL HELPER, not an
   * unreachable remote — and recovering that one line took an hour of bisection precisely because
   * the gate had already discarded it. A refusal that names its own cause is the whole fix.
   */
  lastAttemptStderr?(): string | undefined;
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
  // W1-T2552: the last failing attempt's git stderr, held for the refusal to name. Closure-scoped
  // to ONE reserver, cleared on every success, so it can never describe an older attempt than the
  // outcome it is rendered beside.
  let lastStderr: string | undefined;
  return {
    lastAttemptStderr() {
      return lastStderr;
    },
    mintAnchor() {
      if (deps.anchor) return deps.anchor();
      const tree = deps.run(["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
      const msg = `rmd-dispatch claim ${process.pid}@${hostname()} ${new Date().toISOString()}`;
      return deps.run(["commit-tree", tree, "-m", msg]).stdout.trim();
    },
    attempt(taskId, anchor) {
      const res = deps.run(["push", "origin", `${anchor}:${dispatchClaimRef(taskId)}`]);
      if (res.status === 0) {
        lastStderr = undefined;
        return "created";
      }
      lastStderr = res.stderr;
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

// ── PR REPAIR CLAIMS (W1-T2677) ─────────────────────────────────────────────────────────────

/** One advisory claim on an open PR repair. Unlike a task-dispatch claim, this record expires:
 * repairers already have an exact-head push guard, so the claim prevents duplicate diagnosis
 * work but is never authority to block a later branch push. */
export interface RepairClaim {
  readonly anchor: string;
  readonly prNumber: number;
  readonly holder: string;
  readonly claimedAtIso: string;
}

export function repairClaimRef(prNumber: number): string {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new RangeError(`invalid PR number: ${prNumber}`);
  return `refs/rmd-repair/${prNumber}`;
}

export type RepairClaimRead =
  | { readonly state: "present"; readonly claim: RepairClaim }
  | { readonly state: "absent" }
  | { readonly state: "unreachable"; readonly reason?: string };

export interface RepairClaimReserver {
  /** Mint an orphan commit carrying the holder and timestamp; performs no remote write. */
  mintAnchor(input: Omit<RepairClaim, "anchor">): string;
  /** Create the PR's ref if absent. The non-fast-forward rejection is the atomic contention. */
  attempt(prNumber: number, anchor: string): DispatchClaimOutcome;
  /** Read the current remote anchor and its embedded claim metadata. */
  read(prNumber: number): RepairClaimRead;
  /** Replace exactly one expired anchor. A changed lease means another reclaimer won. */
  replace(prNumber: number, anchor: string, expectedAnchor: string): "replaced" | "lost" | "unreachable";
  /** Best-effort holder release, conditional on the ref still carrying this anchor. */
  drop(prNumber: number, expectedAnchor: string): boolean;
}

export interface RepairClaimDecision {
  readonly claimed: boolean;
  readonly outcome: "created" | "taken" | "reclaimed" | "lost" | "unreachable" | "unreadable";
  readonly reason: string;
  readonly anchor?: string;
  readonly holder?: string;
  readonly previousHolder?: string;
  readonly ageMs?: number;
}

/**
 * Atomically claim the diagnosis phase for one open PR.
 *
 * The first push is create-if-absent. A live claim returns its holder and measured age. An
 * expired claim may be replaced only with a force-with-lease against the anchor just read, so
 * two reclaimers cannot both leave believing they won. Unreadable metadata fails closed: age is
 * not guessed and malformed evidence is never laundered into expiry.
 */
export function claimRepair(
  reserver: RepairClaimReserver,
  input: { prNumber: number; holder?: string; nowMs: number; ttlMs: number },
): RepairClaimDecision {
  repairClaimRef(input.prNumber); // validate before minting or touching origin
  if (!Number.isFinite(input.nowMs)) throw new RangeError(`invalid repair-claim clock: ${input.nowMs}`);
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new RangeError(`invalid repair-claim ttl: ${input.ttlMs}`);

  const holder = input.holder ?? `${process.pid}@${hostname()}`;
  const proposed: Omit<RepairClaim, "anchor"> = {
    prNumber: input.prNumber,
    holder,
    claimedAtIso: new Date(input.nowMs).toISOString(),
  };
  const anchor = reserver.mintAnchor(proposed);
  const attempt = reserver.attempt(input.prNumber, anchor);
  if (attempt === "created") {
    return {
      claimed: true,
      outcome: "created",
      anchor,
      holder,
      ageMs: 0,
      reason: `claimed ${repairClaimRef(input.prNumber)} for ${holder}`,
    };
  }
  if (attempt === "unreachable") {
    return {
      claimed: false,
      outcome: "unreachable",
      reason: `cannot reach origin to claim ${repairClaimRef(input.prNumber)}; repair diagnosis withheld`,
    };
  }

  const current = reserver.read(input.prNumber);
  if (current.state === "unreachable") {
    const detail = current.reason ? `: ${current.reason}` : "";
    return {
      claimed: false,
      outcome: "unreachable",
      reason: `cannot read the holder of ${repairClaimRef(input.prNumber)}${detail}; repair diagnosis withheld`,
    };
  }
  // The holder may have released between the rejected create and this read. Refuse this round;
  // the next caller retries the ordinary create path. This preserves one remote mutation per arm
  // and cannot strand the PR because an absent ref has no holder.
  if (current.state === "absent") {
    return {
      claimed: false,
      outcome: "lost",
      reason: `${repairClaimRef(input.prNumber)} changed while it was being inspected; retry from fresh state`,
    };
  }

  const claimedAtMs = Date.parse(current.claim.claimedAtIso);
  if (!Number.isFinite(claimedAtMs)) {
    return {
      claimed: false,
      outcome: "unreadable",
      holder: current.claim.holder,
      reason: `${repairClaimRef(input.prNumber)} carries an invalid timestamp; expiry cannot be established`,
    };
  }
  const ageMs = Math.max(0, input.nowMs - claimedAtMs);
  if (ageMs < input.ttlMs) {
    return {
      claimed: false,
      outcome: "taken",
      holder: current.claim.holder,
      ageMs,
      reason: `${repairClaimRef(input.prNumber)} is held by ${current.claim.holder}, age ${ageMs}ms`,
    };
  }

  const replaced = reserver.replace(input.prNumber, anchor, current.claim.anchor);
  if (replaced === "replaced") {
    return {
      claimed: true,
      outcome: "reclaimed",
      anchor,
      holder,
      previousHolder: current.claim.holder,
      ageMs,
      reason: `reclaimed expired ${repairClaimRef(input.prNumber)} from ${current.claim.holder} at age ${ageMs}ms`,
    };
  }
  return {
    claimed: false,
    outcome: replaced === "lost" ? "lost" : "unreachable",
    holder: current.claim.holder,
    ageMs,
    reason:
      replaced === "lost"
        ? `${repairClaimRef(input.prNumber)} changed before expired-claim takeover; another repairer won`
        : `cannot reach origin to replace expired ${repairClaimRef(input.prNumber)}; repair diagnosis withheld`,
  };
}

const REPAIR_CLAIM_MESSAGE_PREFIX = "rmd-repair claim v1";

function parseRepairClaim(anchor: string, message: string): RepairClaim | undefined {
  const lines = message.trim().split("\n");
  if (lines[0] !== REPAIR_CLAIM_MESSAGE_PREFIX) return undefined;
  try {
    const parsed = JSON.parse(lines.slice(1).join("\n")) as Partial<RepairClaim>;
    if (
      !Number.isSafeInteger(parsed.prNumber) ||
      Number(parsed.prNumber) <= 0 ||
      typeof parsed.holder !== "string" ||
      parsed.holder.length === 0 ||
      typeof parsed.claimedAtIso !== "string"
    ) return undefined;
    return { anchor, prNumber: Number(parsed.prNumber), holder: parsed.holder, claimedAtIso: parsed.claimedAtIso };
  } catch (error) {
    // Malformed JSON and a structurally-invalid payload have the same public result, but keep
    // the caught failure explicit so this parser never becomes a bare catch-erasure site.
    void error;
    return undefined;
  }
}

/** Real Git implementation usable from a fleet fixer, Codex session, or operator checkout. */
export function gitRepairClaimReserver(deps: DispatchClaimGitDeps): RepairClaimReserver {
  const minted = new Map<string, Omit<RepairClaim, "anchor">>();
  return {
    mintAnchor(input) {
      const tree = deps.run(["hash-object", "-t", "tree", "/dev/null"]);
      if (tree.status !== 0 || tree.stdout.trim().length === 0) throw new Error(`cannot mint repair claim tree: ${tree.stderr.trim()}`);
      const message = `${REPAIR_CLAIM_MESSAGE_PREFIX}\n${JSON.stringify(input)}`;
      const commit = deps.run(["commit-tree", tree.stdout.trim(), "-m", message]);
      if (commit.status !== 0 || commit.stdout.trim().length === 0) throw new Error(`cannot mint repair claim anchor: ${commit.stderr.trim()}`);
      const anchor = commit.stdout.trim();
      minted.set(anchor, input);
      return anchor;
    },
    attempt(prNumber, anchor) {
      const res = deps.run(["push", "origin", `${anchor}:${repairClaimRef(prNumber)}`]);
      return res.status === 0 ? "created" : classifyPushFailure(res.stderr);
    },
    read(prNumber) {
      const ref = repairClaimRef(prNumber);
      const listed = deps.run(["ls-remote", "origin", ref]);
      if (listed.status !== 0) return { state: "unreachable", reason: listed.stderr.replace(/\s+/g, " ").trim().slice(0, 300) };
      const anchor = listed.stdout.trim().split(/\s+/)[0];
      if (!anchor) return { state: "absent" };
      // A second checkout does not have the orphan object merely because ls-remote named it.
      // Fetch only this private ref, then inspect the exact advertised anchor.
      const fetched = deps.run(["fetch", "--quiet", "origin", ref]);
      if (fetched.status !== 0) return { state: "unreachable", reason: fetched.stderr.replace(/\s+/g, " ").trim().slice(0, 300) };
      const shown = deps.run(["show", "-s", "--format=%B", anchor]);
      if (shown.status !== 0) return { state: "unreachable", reason: shown.stderr.replace(/\s+/g, " ").trim().slice(0, 300) };
      const claim = parseRepairClaim(anchor, shown.stdout);
      return claim ? { state: "present", claim } : {
        state: "present",
        claim: { anchor, prNumber, holder: "unknown", claimedAtIso: "invalid" },
      };
    },
    replace(prNumber, anchor, expectedAnchor) {
      if (!minted.has(anchor)) throw new Error(`repair claim anchor ${anchor} was not minted by this reserver`);
      const ref = repairClaimRef(prNumber);
      const res = deps.run(["push", `--force-with-lease=${ref}:${expectedAnchor}`, "origin", `${anchor}:${ref}`]);
      if (res.status === 0) return "replaced";
      return classifyPushFailure(res.stderr) === "taken" ? "lost" : "unreachable";
    },
    drop(prNumber, expectedAnchor) {
      const ref = repairClaimRef(prNumber);
      return deps.run(["push", `--force-with-lease=${ref}:${expectedAnchor}`, "origin", `:${ref}`]).status === 0;
    },
  };
}
