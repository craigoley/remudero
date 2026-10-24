import { execFile } from "node:child_process";
import { boundChildByLoopTime } from "./loop-bounded-child.js";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { sameHost } from "./host-identity.js";
import { ledgerLivePath, ledgerRotationEntries, readLedgerUnionRecords, realLedgerFs, rotationStampIso, type LedgerGrepFsDeps } from "./ledger-union.js";
import { DISPATCH_VALUE_WINDOW_MS } from "./dispatch-value.js";
import { classifyPushFailure } from "./task-id-reservation.js";
import { assertClaimRefPushAllowed, assertClaimRefPushAllowedAsync } from "./live-write-guard.js";
import { GIT_FETCH_KILL_GRACE_MS } from "./git-fetch-retry.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import type { Escalation } from "./escalate.js";

/**
 * Cross-host git-ref CAS closing the dispatch-time race, in the same family as `refs/rmd-id/`
 * (W1-T509) and `refs/rmd-triage/` (W1-T1132), now at the dispatch rung (W1-T1268).
 * INVARIANT: `isDispatchEligible`'s (drain.ts) two concurrency probes see only PUBLISHED work — an
 * open PR or a pushed run branch — so two lanes starting in the same window both see nothing
 * published and both spend. This claim is taken before any spend; it replaces none of drain.ts's
 * probes and does not widen same-host `inflight-lock.ts` (W1-T396).
 *
 * FALSIFIER: test/dispatch-claim.test.ts. Why: docs/forensics/dispatch-claim.md#module-header.
 */

/** The ref namespace for one task's dispatch claim — invisible to `git clone`/`fetch` by
 *  default and to `git ls-remote --heads`, like `refs/rmd-id/` and `refs/rmd-triage/`. */
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
 * PURE. Turns one attempt's outcome into the proceed/refuse verdict and its wording.
 *
 * INVARIANT: an unreachable origin refuses — proceeding on an unreadable remote is the exact
 * behavior that let two hosts each see nothing published and each spend (see the module header).
 */
export function decideDispatchClaim(
  outcome: DispatchClaimOutcome,
  ctx: { taskId: string; holder?: string; stderr?: string },
): DispatchClaimDecision {
  if (outcome === "created") return { proceed: true, reason: `claimed ${dispatchClaimRef(ctx.taskId)} for this run` };
  if (outcome === "taken") {
    // Names the ref and the holder's own anchor, not just "taken" — an operator can act on this.
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
  // W1-T2552: git's own stderr, not just "unreachable" — classifyPushFailure collapses auth, DNS,
  // proxy and timeout into one word.
  // Why: docs/forensics/dispatch-claim.md#lastattemptstderr.
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

/** Which of the four release arms applies — see {@link decideDispatchClaimRelease}. Arm 4,
 *  `dead-claimant` (W1-T2784), fires on proof the claimant cannot exist, never on elapsed time. */
export type DispatchClaimReleaseArm = "holder" | "evidence" | "dead-claimant" | "operator";

/** The identity a claim anchor's commit message carries — `<pid>@<host> <iso>`, written by
 *  {@link gitDispatchClaimReserver}'s `mintAnchor`. */
export interface ClaimAnchorIdentity {
  readonly pid: number;
  readonly host: string;
  readonly mintedAtMs: number;
  /** The timestamp verbatim, next to the parsed ms — keeps the release decision clock-free
   *  (W1-T2446) and lets a forensic line quote the anchor exactly.
   *  Why: docs/forensics/dispatch-claim.md#claimanchoridentity. */
  readonly mintedAtIso: string;
}

/**
 * Parses a claim anchor's message into its three fields, `undefined` on anything not matching
 * the exact shape `mintAnchor` writes — fail-closed: no parse means no identity means no release,
 * since the W1-T2784 arm below releases a real lock on a decoded identity.
 */
export function parseClaimAnchorMessage(message: string | undefined): ClaimAnchorIdentity | undefined {
  const m = /^rmd-dispatch claim (\d+)@(\S+) (\S+)$/m.exec((message ?? "").trim());
  if (!m) return undefined;
  const pid = Number(m[1]);
  const mintedAtMs = Date.parse(m[3]!);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(mintedAtMs)) return undefined;
  return { pid, host: m[2]!, mintedAtMs, mintedAtIso: m[3]! };
}

export function claimDropRefusal(ref: string, anchorMessage: string | undefined, localHost: string, verb: "drop" | "renew" = "drop"): string | undefined {
  const identity = parseClaimAnchorMessage(anchorMessage);
  if (identity && sameHost(identity.host, localHost)) return undefined;
  const who = identity ? `${identity.pid}@${identity.host}` : "an unreadable anchor";
  return `${ref} is held by ${who}, not by this host (${localHost}) — refusing to ${verb} another host's claim`;
}

/** BACKSTOP: a day-old cross-host claim needs a human ruling; age never authorizes release. */
export const DISPATCH_CLAIM_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface DispatchClaimObservation {
  readonly taskId: string;
  readonly holder: string;
  readonly identity?: ClaimAnchorIdentity;
  readonly metadataError?: string;
}

export interface DispatchClaimEscalation extends Escalation {
  readonly id: string;
  readonly ref: string;
  readonly holder: string;
  readonly ageMs: number;
}

export function dispatchClaimAgeMs(identity: ClaimAnchorIdentity | undefined, nowMs: number): number | undefined {
  if (!identity || !Number.isFinite(identity.mintedAtMs) || !Number.isFinite(nowMs)) return undefined;
  return Math.max(0, nowMs - identity.mintedAtMs);
}

export function readDispatchClaimAnchor(holder: string, deps: ClaimGitDeps): Pick<DispatchClaimObservation, "identity" | "metadataError"> {
  const fetched = deps.run(["fetch", "--quiet", "--no-write-fetch-head", "origin", holder]);
  if (fetched.status !== 0) return { metadataError: `claim anchor fetch failed: ${fetched.stderr.trim()}` };
  const commit = deps.run(["cat-file", "-p", holder]);
  if (commit.status !== 0) return { metadataError: `claim anchor read failed: ${commit.stderr.trim()}` };
  const blank = commit.stdout.indexOf("\n\n");
  const identity = parseClaimAnchorMessage(blank < 0 ? undefined : commit.stdout.slice(blank + 2));
  return identity ? { identity } : { metadataError: "claim anchor identity is unparseable" };
}

export function staleDispatchClaimEscalations(
  claims: readonly DispatchClaimObservation[],
  nowMs: number,
  localHost: string,
): DispatchClaimEscalation[] {
  const escalations = new Map<string, DispatchClaimEscalation>();
  for (const claim of claims) {
    const ageMs = dispatchClaimAgeMs(claim.identity, nowMs);
    if (ageMs === undefined || ageMs <= DISPATCH_CLAIM_STALE_THRESHOLD_MS || sameHost(claim.identity?.host, localHost)) continue;
    const ref = dispatchClaimRef(claim.taskId);
    const id = `${ref}@${claim.holder}`;
    escalations.set(id, {
      id, ref, holder: claim.holder, ageMs,
      class: "MANUAL",
      taskId: claim.taskId,
      summary: `${claim.taskId}: stale dispatch claim`,
      detail: `${ref} (holder ${claim.holder}, ${claim.identity!.pid}@${claim.identity!.host}) has age ${ageMs}ms. ` +
        "Cross-host liveness is undecidable; age is not evidence that its holder is dead. Dispatch remains refused while this claim stands.",
      options: [{
        label: "inspect and release",
        detail: `Only after confirming the holder is no longer working, an operator may release this exact claim: ` +
          `git push --force-with-lease=${ref}:${claim.holder} origin :${ref}`,
        kind: { type: "operator-only" },
      }],
      recommendation: "inspect and release",
    });
  }
  return [...escalations.values()];
}

/**
 * This process's own PID-namespace identity, for {@link decideDispatchClaimRelease}'s
 * `dead-claimant` arm. Every field comes from the caller's seam, so the decision stays pure.
 *
 * TRAP: `namespaceBootMs` must be the namespace's own init start — not `/proc/uptime` (the HOST's
 * boot) and not `stat -c %y /proc/1` (an access time, not a start time). Read `/proc/stat`'s
 * `btime` plus `/proc/1/stat` field 22 instead — see {@link readNamespaceBootMs}.
 * Why: docs/forensics/dispatch-claim.md#claimantlivenessprobe.
 */
export interface ClaimantLivenessProbe {
  readonly localHost: string;
  readonly namespaceBootMs: number;
  /** Preformatted at the seam — kept clock-free like {@link ClaimAnchorIdentity.mintedAtIso}. */
  readonly namespaceBootIso: string;
  readonly pidPresent: boolean;
}

export interface ClaimMintRow {
  readonly host: string;
  readonly actor: string;
  readonly ts: string;
  readonly source: string;
  readonly runId?: string;
}

export interface ReplacedClaimantProbe {
  readonly localHost: string;
  readonly lockHeldSinceMs: number;
  readonly lockHeldSinceIso: string;
  readonly mintRow?: ClaimMintRow;
}

export interface DispatchClaimReleaseDecision {
  readonly arm: DispatchClaimReleaseArm;
  readonly release: boolean;
  readonly reason: string;
}

/**
 * PURE. The four-arm release, tried in order, no time-based expiry — an expiring claim under a
 * running lane would re-open the race this module closes (mirrors `decideTriageClaimRelease`).
 *
 *  1. HOLDER — the run that took the claim drops it in a `finally`, success or not.
 *  2. EVIDENCE — the caller's own proof the task is already done; any host may drop it.
 *  3. DEAD-CLAIMANT — W1-T2784: THIS host's anchor predates its PID namespace and the pid is absent; W1-T5047: this
 *     instance's daemon or run child minted it on another host and this daemon took state/drain.lock after the mint.
 *  4. OPERATOR — everything else; cross-host liveness is not decidable (W1-T396).
 *
 * FALSIFIER: test/a-claim-minted-before-this-namespace-booted-has-no-claimant.test.ts. Why:
 * docs/forensics/dispatch-claim.md#decidedispatchclaimrelease.
 */
export function decideDispatchClaimRelease(i: {
  heldByThisRun: boolean;
  evidenceObserved: boolean;
  taskId: string;
  /** W1-T2784: the anchor's decoded identity. Absent (unparseable/unreadable) ⇒ arm 3 declines. */
  anchorIdentity?: ClaimAnchorIdentity;
  /** W1-T2784: this namespace's own identity. Absent (unreadable /proc) ⇒ arm 3 declines. */
  liveness?: ClaimantLivenessProbe;
  replaced?: ReplacedClaimantProbe;
}): DispatchClaimReleaseDecision {
  if (i.heldByThisRun) return { arm: "holder", release: true, reason: `this run holds ${dispatchClaimRef(i.taskId)} and is done with it` };
  if (i.evidenceObserved)
    return {
      arm: "evidence",
      release: true,
      reason: `${i.taskId}'s work is already observed landed, so its claim is stale and any host may drop it`,
    };
  // ARM 3 — every clause must hold. Any absent input declines to arm 4 rather than guessing.
  const a = i.anchorIdentity;
  const l = i.liveness;
  if (a && l && sameHost(a.host, l.localHost) && a.mintedAtMs < l.namespaceBootMs && !l.pidPresent) {
    return {
      arm: "dead-claimant",
      release: true,
      // LOUD BY CONSTRUCTION (design note): names the ref, the anchor it decoded, and BOTH
      // signals with their values — a silent automatic release of a lock someone might be
      // holding is worse than the stuck claim it fixes, so the row has to let a reader
      // re-derive the decision without re-running anything.
      reason:
        `${dispatchClaimRef(i.taskId)} is held by ${a.pid}@${a.host}, minted ${a.mintedAtIso} — ` +
        `BEFORE this host's PID namespace started ${l.namespaceBootIso}, and pid ${a.pid} is ` +
        `absent. A process cannot outlive the namespace containing it, so the claimant provably ` +
        `cannot exist; releasing.`,
    };
  }
  const r = i.replaced;
  const m = r?.mintRow;
  if (a && r && m && !sameHost(a.host, r.localHost) && sameHost(m.host, a.host) &&
      (m.actor === "daemon" || m.actor === "run_child") && a.mintedAtMs < r.lockHeldSinceMs) {
    return {
      arm: "dead-claimant",
      release: true,
      reason:
        `${dispatchClaimRef(i.taskId)} is held by ${a.pid}@${a.host}, minted ${a.mintedAtIso}. This instance's ledger ` +
        `records that ${m.actor} minting it (${m.source}, ${m.ts}), and this daemon on ${r.localHost} has held the ` +
        `instance's single-instance lock (state/drain.lock) since ${r.lockHeldSinceIso}. The claimant's container ` +
        `was replaced, so the claimant cannot exist; releasing.`,
    };
  }
  return {
    arm: "operator",
    release: false,
    reason:
      `${dispatchClaimRef(i.taskId)} is held by another lane with no landed work observed yet — leaving it. ` +
      `Cross-host liveness is not decidable, so clearing it is an operator call: ` +
      `git push origin :${dispatchClaimRef(i.taskId)}`,
  };
}

/** The one I/O seam: every method is a git round trip; every decision above is pure (as `TriageClaimReserver`). */
export interface DispatchClaimReserver {
  /** A payload unique to THIS writer — two writers must never produce the same value. */
  mintAnchor(): string;
  /** Create-if-absent of {@link dispatchClaimRef}. Never throws — unreachable is an outcome. */
  attempt(taskId: string, anchor: string): DispatchClaimOutcome;
  /** The anchor currently at the claim ref, or `undefined` when absent or unreadable. */
  holder(taskId: string): string | undefined;
  /** Delete the claim ref, conditional on `expect` matching the ref's current anchor if given. */
  drop(taskId: string, opts?: { expect?: string }): boolean;
  /** W1-T2552: the last {@link attempt}'s git stderr, `undefined` on success or none yet; optional.
   *  Why: docs/forensics/dispatch-claim.md#lastattemptstderr (the missing-credential incident). */
  lastAttemptStderr?(): string | undefined;
  /** W1-T2784: the claim ref's current commit MESSAGE, for {@link parseClaimAnchorMessage} to
   *  decode. `undefined` when absent, unfetched, or unreadable — each declines the
   *  `dead-claimant` arm rather than releasing on a guess. With expect, read ONLY that exact object,
   *  never a later holder. Omitting expect retains the current-holder lookup. Optional and last. */
  anchorMessage?(taskId: string, expect?: string): string | undefined;
  list?(): string[];
  /** W1-T9432: extend the claim at `expect` by one renewal commit; see {@link DispatchClaimRenewal}. */
  renew?(taskId: string, expect: string): DispatchClaimRenewal;
}

export interface ClaimGitDeps {
  /** Runs a git argv; returns its exit status, stdout and stderr. Injected by tests. */
  run(args: string[]): { status: number; stdout: string; stderr: string };
  /** Overrides the anchor so a test can make two writers distinguishable. */
  anchor?: () => string;
}

/** The real reserver: an orphan empty-tree commit pushed to the task's ref (as `gitTriageClaimReserver`);
 *  its pid+host+time message is legible to an operator and is the uniqueness source. */
export function gitDispatchClaimReserver(deps: ClaimGitDeps): DispatchClaimReserver {
  // Closure-scoped to one reserver, cleared on success, so a refusal never echoes an older attempt.
  let lastStderr: string | undefined;
  return {
    lastAttemptStderr() {
      return lastStderr;
    },
    mintAnchor() {
      if (deps.anchor) return deps.anchor();
      const tree = deps.run(["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
      return deps.run(["commit-tree", tree, "-m", claimAnchorMessage()]).stdout.trim();
    },
    attempt(taskId, anchor) {
      assertClaimRefPushAllowed(deps.run, dispatchClaimRef(taskId));
      const res = deps.run(claimPushArgs(taskId, anchor));
      lastStderr = res.status === 0 ? undefined : res.stderr;
      return claimAttemptOutcome(res);
    },
    holder(taskId) {
      return holderFromLsRemote(deps.run(["ls-remote", "origin", dispatchClaimRef(taskId)]));
    },
    drop(taskId, opts = {}) {
      assertClaimRefPushAllowed(deps.run, dispatchClaimRef(taskId));
      return deps.run(claimDropArgs(taskId, opts.expect)).status === 0;
    },
    list() {
      return claimIdsFromLsRemote(deps.run(["ls-remote", "origin", "refs/rmd-dispatch/*"]));
    },
    anchorMessage(taskId, expect) {
      const sha = expect ?? this.holder(taskId);
      if (!sha) return undefined;
      // Fetch acquires the object even when updating a stale local claim ref is rejected.
      deps.run(claimFetchArgs(taskId, expect));
      return messageFromCatFile(deps.run(["cat-file", "-p", sha]));
    },
    renew(taskId, expect) {
      const ref = dispatchClaimRef(taskId);
      const listed = deps.run(["ls-remote", "origin", ref]);
      if (listed.status !== 0) return renewalUnreachable(listed);
      const tip = holderFromLsRemote(listed);
      if (tip !== expect) return renewalLost(tip);
      const fetched = deps.run(renewalFetchArgs(ref));
      if (fetched.status !== 0) return renewalUnreachable(fetched);
      const message = claimRenewalMessage(messageFromCatFile(deps.run(["cat-file", "-p", expect])), claimRenewer());
      if (message === undefined) return { outcome: "unreachable", stderr: `${ref} anchor ${expect} is unreadable` };
      const tree = deps.run(["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
      const minted = deps.run(["commit-tree", tree, "-p", expect, "-m", message]);
      if (minted.status !== 0) return renewalUnreachable(minted);
      assertClaimRefPushAllowed(deps.run, ref);
      return renewalOutcome(deps.run(renewalPushArgs(ref, expect, minted.stdout.trim())), minted.stdout.trim());
    },
  };
}

export type GitAnswer = { status: number; stdout: string; stderr: string };

function claimAnchorMessage(): string {
  return `rmd-dispatch claim ${process.pid}@${hostname()} ${new Date().toISOString()}`;
}

function claimRenewer(): string {
  return `${process.pid}@${hostname()} ${systemClock.iso()}`;
}

/** W1-T9432: the anchor's FIRST line verbatim, so {@link parseClaimAnchorMessage} still decodes the minter,
 *  plus `renewed <pid>@<host> <iso>`. `undefined` when the anchor does not decode — nothing to renew. */
export function claimRenewalMessage(anchorMessage: string | undefined, renewer: string): string | undefined {
  const first = (anchorMessage ?? "").trim().split("\n")[0] ?? "";
  return parseClaimAnchorMessage(first) ? `${first}\nrenewed ${renewer}` : undefined;
}

/** The newest `renewed` line a claim's tip message carries, `undefined` when it was never renewed. */
export function parseClaimRenewal(message: string | undefined): { by: string; renewedAtMs: number; renewedAtIso: string } | undefined {
  let newest: { by: string; renewedAtMs: number; renewedAtIso: string } | undefined;
  for (const m of (message ?? "").matchAll(/^renewed (\d+@\S+) (\S+)$/gm)) {
    const renewedAtMs = Date.parse(m[2]!);
    if (Number.isFinite(renewedAtMs) && (newest === undefined || renewedAtMs > newest.renewedAtMs)) newest = { by: m[1]!, renewedAtMs, renewedAtIso: m[2]! };
  }
  return newest;
}

/** W1-T9432: one renewal's outcome. `lost` means the ref no longer carries the sha this holder last
 *  wrote — reclaimed, dropped or re-minted — and `holder` names what is there now, if anything. */
export type DispatchClaimRenewal =
  | { readonly outcome: "renewed"; readonly sha: string }
  | { readonly outcome: "lost"; readonly holder?: string }
  | { readonly outcome: "unreachable"; readonly stderr: string };

function renewalLost(tip: string | undefined): DispatchClaimRenewal {
  return tip === undefined ? { outcome: "lost" } : { outcome: "lost", holder: tip };
}

function renewalUnreachable(res: GitAnswer): DispatchClaimRenewal {
  return { outcome: "unreachable", stderr: res.stderr.replace(/\s+/g, " ").trim().slice(0, 300) || `git exited ${res.status}` };
}

function renewalFetchArgs(ref: string): string[] {
  return ["fetch", "--quiet", "--no-write-fetch-head", "origin", ref];
}

/** The lease is the whole point: a renewal can never recreate a dropped claim or overwrite a new holder's. */
function renewalPushArgs(ref: string, expect: string, sha: string): string[] {
  return ["push", `--force-with-lease=${ref}:${expect}`, "origin", `${sha}:${ref}`];
}

function renewalOutcome(res: GitAnswer, sha: string): DispatchClaimRenewal {
  if (res.status === 0) return { outcome: "renewed", sha };
  return classifyPushFailure(res.stderr) === "taken" ? { outcome: "lost" } : renewalUnreachable(res);
}

/** W1-T9432: renews the claim at `expect` through either reserver; one without `renew` cannot renew. */
export function renewDispatchClaim(reserver: DispatchClaimReserver, taskId: string, expect: string): DispatchClaimRenewal {
  return reserver.renew ? reserver.renew(taskId, expect) : { outcome: "unreachable", stderr: "this reserver cannot renew a claim" };
}

export async function renewDispatchClaimAsync(reserver: DispatchClaimReserverAsync, taskId: string, expect: string): Promise<DispatchClaimRenewal> {
  return reserver.renew ? await reserver.renew(taskId, expect) : { outcome: "unreachable", stderr: "this reserver cannot renew a claim" };
}

function claimPushArgs(taskId: string, anchor: string): string[] {
  return ["push", "origin", `${anchor}:${dispatchClaimRef(taskId)}`];
}

function claimAttemptOutcome(res: GitAnswer): DispatchClaimOutcome {
  return res.status === 0 ? "created" : classifyPushFailure(res.stderr);
}

function claimDropArgs(taskId: string, expect: string | undefined): string[] {
  const ref = dispatchClaimRef(taskId);
  return expect ? ["push", `--force-with-lease=${ref}:${expect}`, "origin", `:${ref}`] : ["push", "origin", `:${ref}`];
}

function claimFetchArgs(taskId: string, expect?: string): string[] {
  if (expect !== undefined) return ["fetch", "--quiet", "--no-write-fetch-head", "origin", expect];
  return ["fetch", "--quiet", "origin", `${dispatchClaimRef(taskId)}:${dispatchClaimRef(taskId)}`];
}

export function holderFromLsRemote(res: GitAnswer): string | undefined {
  if (res.status !== 0) return undefined;
  const sha = res.stdout.trim().split(/\s+/)[0];
  return sha ? sha : undefined;
}

function claimIdsFromLsRemote(res: GitAnswer): string[] {
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((line) => /\srefs\/rmd-dispatch\/(\S+)$/.exec(line.trim())?.[1])
    .filter((id): id is string => id !== undefined);
}

function messageFromCatFile(res: GitAnswer): string | undefined {
  if (res.status !== 0) return undefined;
  const blank = res.stdout.indexOf("\n\n");
  return blank === -1 ? undefined : res.stdout.slice(blank + 2).trim();
}

export type Awaitable<T> = T | Promise<T>;

/** {@link DispatchClaimReserver}, awaitable (its sync git held the daemon loop up to 106 s); a sync one fits. */
export interface DispatchClaimReserverAsync {
  mintAnchor(): Awaitable<string>;
  attempt(taskId: string, anchor: string): Awaitable<DispatchClaimOutcome>;
  holder(taskId: string): Awaitable<string | undefined>;
  drop(taskId: string, opts?: { expect?: string }): Awaitable<boolean>;
  lastAttemptStderr?(): string | undefined;
  anchorMessage?(taskId: string, expect?: string): Awaitable<string | undefined>;
  list?(): Awaitable<string[]>;
  listHeld?(): Awaitable<DispatchClaimListing>;
  renew?(taskId: string, expect: string): Awaitable<DispatchClaimRenewal>;
}

export interface ListedDispatchClaim {
  readonly taskId: string;
  readonly holder: string;
}

export type DispatchClaimListing = { ok: true; claims: ListedDispatchClaim[] } | { ok: false; stderr: string };

export function claimListingFromLsRemote(res: GitAnswer): DispatchClaimListing {
  if (res.status !== 0) return { ok: false, stderr: res.stderr.trim() || `git ls-remote exited ${res.status}` };
  const claims: ListedDispatchClaim[] = [];
  for (const line of res.stdout.split("\n")) {
    const m = /^([0-9a-f]{7,64})\s+refs\/rmd-dispatch\/(\S+)$/.exec(line.trim());
    if (m) claims.push({ taskId: m[2], holder: m[1] });
  }
  return { ok: true, claims };
}

export interface ClaimGitDepsAsync {
  run(args: string[]): Promise<GitAnswer>;
  anchor?: () => string;
}

export function gitDispatchClaimReserverAsync(deps: ClaimGitDepsAsync): DispatchClaimReserverAsync {
  let lastStderr: string | undefined;
  const holder = async (taskId: string): Promise<string | undefined> =>
    holderFromLsRemote(await deps.run(["ls-remote", "origin", dispatchClaimRef(taskId)]));
  return {
    lastAttemptStderr: () => lastStderr,
    async mintAnchor() {
      if (deps.anchor) return deps.anchor();
      const tree = (await deps.run(["hash-object", "-t", "tree", "/dev/null"])).stdout.trim();
      return (await deps.run(["commit-tree", tree, "-m", claimAnchorMessage()])).stdout.trim();
    },
    async attempt(taskId, anchor) {
      await assertClaimRefPushAllowedAsync(deps.run, dispatchClaimRef(taskId));
      const res = await deps.run(claimPushArgs(taskId, anchor));
      lastStderr = res.status === 0 ? undefined : res.stderr;
      return claimAttemptOutcome(res);
    },
    holder,
    async drop(taskId, opts = {}) {
      await assertClaimRefPushAllowedAsync(deps.run, dispatchClaimRef(taskId));
      return (await deps.run(claimDropArgs(taskId, opts.expect))).status === 0;
    },
    async list() {
      return claimIdsFromLsRemote(await deps.run(["ls-remote", "origin", "refs/rmd-dispatch/*"]));
    },
    async listHeld() {
      return claimListingFromLsRemote(await deps.run(["ls-remote", "origin", "refs/rmd-dispatch/*"]));
    },
    async anchorMessage(taskId, expect) {
      const sha = expect ?? await holder(taskId);
      if (!sha) return undefined;
      await deps.run(claimFetchArgs(taskId, expect));
      return messageFromCatFile(await deps.run(["cat-file", "-p", sha]));
    },
    async renew(taskId, expect) {
      const ref = dispatchClaimRef(taskId);
      const listed = await deps.run(["ls-remote", "origin", ref]);
      if (listed.status !== 0) return renewalUnreachable(listed);
      const tip = holderFromLsRemote(listed);
      if (tip !== expect) return renewalLost(tip);
      const fetched = await deps.run(renewalFetchArgs(ref));
      if (fetched.status !== 0) return renewalUnreachable(fetched);
      const message = claimRenewalMessage(messageFromCatFile(await deps.run(["cat-file", "-p", expect])), claimRenewer());
      if (message === undefined) return { outcome: "unreachable", stderr: `${ref} anchor ${expect} is unreadable` };
      const tree = (await deps.run(["hash-object", "-t", "tree", "/dev/null"])).stdout.trim();
      const minted = await deps.run(["commit-tree", tree, "-p", expect, "-m", message]);
      if (minted.status !== 0) return renewalUnreachable(minted);
      await assertClaimRefPushAllowedAsync(deps.run, ref);
      return renewalOutcome(await deps.run(renewalPushArgs(ref, expect, minted.stdout.trim())), minted.stdout.trim());
    },
  };
}

/** BACKSTOP, above the slowest measured claim spawn (106 s, 2026-10-06); past it the claim is unreachable. */
export const DISPATCH_CLAIM_GIT_TIMEOUT_MS = 300_000;

/** Resolves on every outcome: exit N → N; killed at the bound → 1, stderr NAMING it (so `unreachable`,
 *  never `taken`); signalled or never started → 1, as `gitRunAdapter` maps a null status. */
export function gitClaimRunnerAsync(
  repoDir: string,
  opts: { timeoutMs?: number; graceMs?: number; gitBin?: string } = {},
): ClaimGitDepsAsync["run"] {
  const timeoutMs = opts.timeoutMs ?? DISPATCH_CLAIM_GIT_TIMEOUT_MS;
  return (args) =>
    new Promise((resolve) => {
      const child = execFile(opts.gitBin ?? "git", ["-C", repoDir, ...args], { encoding: "utf8", maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
        bound.cancel();
        if (bound.timedOut) {
          const said = stderr.trim() ? ` git said: ${stderr.trim()}` : "";
          return resolve({ status: 1, stdout, stderr: `git ${args[0]} timed out after ${timeoutMs}ms and was killed.${said}` });
        }
        if (!err) return resolve({ status: 0, stdout, stderr });
        const code = (err as { code?: unknown }).code;
        return resolve({ status: typeof code === "number" ? code : 1, stdout, stderr: stderr || err.message });
      });
      const bound = boundChildByLoopTime(child, timeoutMs, { escalateAfterMs: opts.graceMs ?? GIT_FETCH_KILL_GRACE_MS });
    });
}

/**
 * W1-T2784: epoch ms this PID namespace's init started, or `undefined` on bad input — declines
 * arm 3 rather than guessing. `/proc/stat`'s `btime` plus `/proc/1/stat` field 22 (start ticks)
 * sums to the namespace's own start.
 *
 * TRAP: field 22 counts from the END of the line — `comm` (field 2) is parenthesized and can
 * contain spaces, so splitting on whitespace mis-indexes everything after it; slice after the
 * LAST `)` instead.
 */
export function readNamespaceBootMs(deps: { readFile?: (p: string) => string; clockTicks?: () => number } = {}): number | undefined {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    const btimeLine = /^btime\s+(\d+)/m.exec(read("/proc/stat"));
    if (!btimeLine) return undefined;
    const btimeSec = Number(btimeLine[1]);
    const stat = read("/proc/1/stat");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim();
    // field 3 is the first token after `comm`, so starttime (field 22) is index 19 here.
    const startTicks = Number(afterComm.split(/\s+/)[19]);
    const hz = deps.clockTicks?.() ?? 100; // CLK_TCK is 100 on every Linux this fleet runs.
    if (!Number.isFinite(btimeSec) || !Number.isFinite(startTicks) || !Number.isFinite(hz) || hz <= 0) return undefined;
    return Math.round((btimeSec + startTicks / hz) * 1000);
  } catch {
    // Unreadable /proc (non-Linux, a locked-down sandbox) declines arm 3 rather than guessing.
    return undefined;
  }
}

/** W1-T2784: does `pid` exist here? `true` on doubt — absence is half of arm 3's proof. */
export function pidIsPresent(pid: number, deps: { exists?: (p: string) => boolean } = {}): boolean {
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  try {
    return exists(`/proc/${pid}`);
  } catch {
    // Cannot tell ⇒ report PRESENT (fail-closed, same direction as every other absent input here).
    return true;
  }
}

/** {@link decideDispatchClaimRelease}'s verdict plus whether the ref was actually dropped. */
export interface DispatchClaimReleaseResult extends DispatchClaimReleaseDecision {
  readonly dropped: boolean;
}

/**
 * Applies the four-arm release. An `anchor` means this run is the holder (arm 1); otherwise the
 * decision falls to evidence, then dead-claimant, then operator. {@link decideDispatchClaimRelease}
 * makes the call; this function only performs the I/O it authorizes — mirroring `releaseTriageClaim`.
 */
export function releaseDispatchClaim(
  taskId: string,
  reserver: DispatchClaimReserver,
  i: {
    anchor?: string;
    evidenceObserved?: boolean;
    /** W1-T2784: probe seam for the dead-claimant arm. Optional and last, so every existing
     *  caller and test fake keeps today's three-arm behavior unchanged when it's omitted. */
    livenessProbe?: () => ClaimantLivenessProbe | undefined;
    replacedProbe?: (anchor: ClaimAnchorIdentity) => ReplacedClaimantProbe | undefined;
  } = {},
): DispatchClaimReleaseResult {
  // Only asked off the this-run path — releasing your own claim (arm 1) skips this I/O entirely.
  let anchorIdentity: ClaimAnchorIdentity | undefined;
  let liveness: ClaimantLivenessProbe | undefined;
  let replaced: ReplacedClaimantProbe | undefined;
  let judged: string | undefined;
  if (i.anchor === undefined && i.evidenceObserved !== true && (i.livenessProbe || i.replacedProbe)) {
    judged = reserver.holder(taskId);
    anchorIdentity = judged ? parseClaimAnchorMessage(reserver.anchorMessage?.(taskId, judged)) : undefined;
    // The pid is only meaningful once an anchor parsed — probe after, never before.
    if (anchorIdentity) liveness = i.livenessProbe?.();
    if (anchorIdentity) replaced = i.replacedProbe?.(anchorIdentity);
  }
  const decision = decideDispatchClaimRelease({
    heldByThisRun: i.anchor !== undefined,
    evidenceObserved: i.evidenceObserved === true,
    taskId,
    anchorIdentity,
    liveness,
    replaced,
  });
  if (!decision.release) return { ...decision, dropped: false };
  // Pinned via `--force-with-lease` to the sha just judged, so a claim re-minted since survives.
  if (decision.arm === "dead-claimant") {
    return { ...decision, dropped: judged ? reserver.drop(taskId, { expect: judged }) : false };
  }
  return { ...decision, dropped: reserver.drop(taskId, i.anchor !== undefined ? { expect: i.anchor } : {}) };
}

/** {@link releaseDispatchClaim}, awaited; the liveness probe gets the anchor it parsed, never a re-read. */
export async function releaseDispatchClaimAsync(
  taskId: string,
  reserver: DispatchClaimReserverAsync,
  i: {
    anchor?: string;
    evidenceObserved?: boolean;
    livenessProbe?: (anchor: ClaimAnchorIdentity) => ClaimantLivenessProbe | undefined;
    expect?: string;
  } = {},
): Promise<DispatchClaimReleaseResult> {
  let anchorIdentity: ClaimAnchorIdentity | undefined;
  let liveness: ClaimantLivenessProbe | undefined;
  let judged: string | undefined;
  if (i.anchor === undefined && i.evidenceObserved !== true && i.livenessProbe) {
    judged = await reserver.holder(taskId);
    anchorIdentity = judged ? parseClaimAnchorMessage(await reserver.anchorMessage?.(taskId, judged)) : undefined;
    if (anchorIdentity) liveness = i.livenessProbe(anchorIdentity);
  }
  const decision = decideDispatchClaimRelease({
    heldByThisRun: i.anchor !== undefined,
    evidenceObserved: i.evidenceObserved === true,
    taskId,
    anchorIdentity,
    liveness,
  });
  if (!decision.release) return { ...decision, dropped: false };
  if (decision.arm === "dead-claimant") {
    return { ...decision, dropped: judged ? await reserver.drop(taskId, { expect: judged }) : false };
  }
  const expect = i.anchor ?? i.expect;
  return { ...decision, dropped: await reserver.drop(taskId, expect !== undefined ? { expect } : {}) };
}

const MINT_ROW_ARCHIVE_READS = 3;

function claimLedgerFiles(stateDir: string, anchor: ClaimAnchorIdentity, fs: LedgerGrepFsDeps): Array<{ path: string; gzip: boolean; name: string }> {
  const names = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
  const archives = ledgerRotationEntries(names, stateDir)
    .map((entry) => ({ entry, name: entry.path.slice(stateDir.length + 1) }))
    .filter(({ name }) => (rotationStampIso(name) ?? "") >= anchor.mintedAtIso)
    .slice(0, MINT_ROW_ARCHIVE_READS);
  const files = [...archives.map(({ entry, name }) => ({ path: entry.path, gzip: entry.form === "gzip", name }))];
  if (fs.existsSync(ledgerLivePath(stateDir))) files.push({ path: ledgerLivePath(stateDir), gzip: false, name: LEDGER_FILENAME });
  return files;
}

function claimLedgerText(file: { path: string; gzip: boolean }, fs: LedgerGrepFsDeps): string {
  const raw = fs.readFileSync(file.path);
  return (file.gzip ? fs.gunzipSync(raw) : raw).toString("utf8");
}

export function findClaimMintRow(
  stateDir: string,
  taskId: string,
  anchor: ClaimAnchorIdentity,
  fs: LedgerGrepFsDeps = realLedgerFs,
): ClaimMintRow | undefined {
  const ref = dispatchClaimRef(taskId);
  for (const file of claimLedgerFiles(stateDir, anchor, fs)) {
    const text = claimLedgerText(file, fs);
    for (const line of text.split("\n")) {
      if (!line.includes(ref) || !line.includes("dispatch.claim")) continue;
      const parsed = parseLedgerRow(line);
      if (parsed.kind !== "row") continue;
      const row = parsed.row;
      if (row.step !== "dispatch.claim" || row.ref !== ref || row.outcome !== "created") continue;
      if (typeof row.ts !== "string" || row.ts < anchor.mintedAtIso || !sameHost(row.host, anchor.host)) continue;
      const runId = typeof row.run_id === "string" ? row.run_id : undefined;
      return { host: String(row.host), actor: String(row.actor ?? "unknown"), ts: row.ts, source: file.name, ...(runId ? { runId } : {}) };
    }
  }
  return undefined;
}

export function claimMintedByRerun(
  stateDir: string,
  taskId: string,
  anchor: ClaimAnchorIdentity,
  fs: LedgerGrepFsDeps = realLedgerFs,
): boolean {
  const runId = findClaimMintRow(stateDir, taskId, anchor, fs)?.runId;
  if (runId === undefined) return false;
  for (const file of claimLedgerFiles(stateDir, anchor, fs)) {
    for (const line of claimLedgerText(file, fs).split("\n")) {
      if (!line.includes("dispatch.rerun_override") || !line.includes(runId)) continue;
      const parsed = parseLedgerRow(line);
      if (parsed.kind === "row" && parsed.row.step === "dispatch.rerun_override" && parsed.row.run_id === runId) return true;
    }
  }
  return false;
}

function parseLedgerRow(line: string): { kind: "row"; row: Record<string, unknown> } | { kind: "torn" | "not-an-object" } {
  try {
    const row: unknown = JSON.parse(line);
    return row !== null && typeof row === "object" ? { kind: "row", row: row as Record<string, unknown> } : { kind: "not-an-object" };
  } catch {
    return { kind: "torn" };
  }
}

export function releaseReplacedContainerClaims(
  reserver: DispatchClaimReserver,
  i: {
    localHost: string;
    lockHeldSinceMs: number;
    lockHeldSinceIso: string;
    findMintRow: (taskId: string, anchor: ClaimAnchorIdentity) => ClaimMintRow | undefined;
    isMerged?: (taskId: string) => boolean;
  },
): Array<DispatchClaimReleaseResult & { taskId: string }> {
  return (reserver.list?.() ?? []).map((taskId) => ({
    taskId,
    ...releaseDispatchClaim(taskId, reserver, {
      evidenceObserved: i.isMerged?.(taskId) === true,
      replacedProbe: (anchor) => ({
        localHost: i.localHost,
        lockHeldSinceMs: i.lockHeldSinceMs,
        lockHeldSinceIso: i.lockHeldSinceIso,
        mintRow: i.findMintRow(taskId, anchor),
      }),
    }),
  }));
}

export interface LandedClaimSweepInputs {
  isMerged: (taskId: string) => boolean;
  isIndeterminate: (taskId: string) => boolean;
  prUrlFor?: (taskId: string) => string | undefined;
  isRerunClaim?: (taskId: string, anchor: ClaimAnchorIdentity) => Awaitable<boolean>;
  localHost?: string;
  reportedRerun?: Set<string>;
  log: (step: string, fields: Record<string, unknown>) => void;
}

export async function releaseLandedDispatchClaims(
  reserver: DispatchClaimReserverAsync,
  deps: LandedClaimSweepInputs,
): Promise<Array<DispatchClaimReleaseResult & ListedDispatchClaim>> {
  const listing: DispatchClaimListing = reserver.listHeld
    ? await reserver.listHeld()
    : { ok: false, stderr: "this reserver cannot list claims with their holders" };
  if (!listing.ok) {
    deps.log("dispatch.claim_sweep_failed", { surface: "tick-sweep", error: listing.stderr.slice(0, 300) });
    return [];
  }
  const results: Array<DispatchClaimReleaseResult & ListedDispatchClaim> = [];
  for (const claim of listing.claims) {
    if (!deps.isMerged(claim.taskId) || deps.isIndeterminate(claim.taskId)) continue;
    const ref = dispatchClaimRef(claim.taskId);
    const row = { ref, surface: "tick-sweep", holder: claim.holder, pr_url: deps.prUrlFor?.(claim.taskId) };
    if (deps.isRerunClaim) {
      const anchor = parseClaimAnchorMessage(await reserver.anchorMessage?.(claim.taskId));
      const local = anchor !== undefined && (deps.localHost === undefined || sameHost(anchor.host, deps.localHost));
      if (anchor && local && (await deps.isRerunClaim(claim.taskId, anchor))) {
        const left = {
          ...claim,
          arm: "evidence" as const,
          release: false,
          dropped: false,
          reason: `${ref} was minted by a --rerun lane (dispatch.rerun_override), which dispatches a merged task on purpose — leaving it`,
        };
        const reported = deps.reportedRerun;
        if (reported === undefined || !reported.has(claim.holder)) {
          reported?.add(claim.holder);
          deps.log("dispatch.claim_released", { ...row, arm: left.arm, release: false, dropped: false, reason: left.reason });
        }
        results.push(left);
        continue;
      }
    }
    const released = await releaseDispatchClaimAsync(claim.taskId, reserver, { evidenceObserved: true, expect: claim.holder });
    deps.log("dispatch.claim_released", { ...row, arm: released.arm, release: released.release, dropped: released.dropped, reason: released.reason });
    results.push({ ...claim, ...released });
  }
  return results;
}

// ── A CLAIM HOLDS ONLY WHILE ITS HOLDER RENEWS IT (W1-T9432) ─────────────────────────────────

/** A WRITE cadence for holders, never a decision bound: {@link decideClaimSilence} never reads it. */
export const DISPATCH_CLAIM_RENEW_INTERVAL_MS = 5 * 60_000;

/** The ledger steps the silence judge reads: claim mints and verdicts for W, its own report for once-only. */
export const CLAIM_SILENCE_LEDGER_STEPS: readonly string[] = ["dispatch.claim", "verdict", "dispatch.claim_unrenewed"];

/** W is the p90 of this instance's claim-to-verdict durations; `samples` 0 means there is no W. */
export interface ClaimSilenceWindow {
  readonly windowMs?: number;
  readonly samples: number;
}

/** PURE. Pairs each `dispatch.claim` `created` row with the same run_id's `verdict` row. */
export function claimSilenceWindow(rows: Iterable<Record<string, unknown>>): ClaimSilenceWindow {
  const claimedAt = new Map<string, number>();
  const verdictAt = new Map<string, number>();
  for (const row of rows) {
    const runId = row.run_id;
    const at = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    if (typeof runId !== "string" || !Number.isFinite(at)) continue;
    const into = row.step === "dispatch.claim" && row.outcome === "created" ? claimedAt : row.step === "verdict" ? verdictAt : undefined;
    const earlier = into?.get(runId);
    if (into !== undefined && (earlier === undefined || at < earlier)) into.set(runId, at);
  }
  const durations: number[] = [];
  for (const [runId, start] of claimedAt) {
    const end = verdictAt.get(runId);
    if (end !== undefined && end >= start) durations.push(end - start);
  }
  if (durations.length === 0) return { samples: 0 };
  durations.sort((a, b) => a - b);
  return { windowMs: durations[Math.ceil(0.9 * durations.length) - 1]!, samples: durations.length };
}

export interface ClaimSignOfLife {
  readonly atMs: number;
  readonly atIso: string;
  readonly source: "minted" | "renewed" | "run-branch";
  readonly ref?: string;
}

export interface RunBranchCommit {
  readonly atMs: number;
  readonly atIso: string;
  readonly ref: string;
}

/** PURE. The newest of the mint, the tip's renewal, and the newest commit on a `run-<id>-*` branch. */
export function claimLastSignOfLife(anchor: ClaimAnchorIdentity, message: string | undefined, branch?: RunBranchCommit): ClaimSignOfLife {
  const renewal = parseClaimRenewal(message);
  let newest: ClaimSignOfLife = renewal && renewal.renewedAtMs > anchor.mintedAtMs
    ? { atMs: renewal.renewedAtMs, atIso: renewal.renewedAtIso, source: "renewed" }
    : { atMs: anchor.mintedAtMs, atIso: anchor.mintedAtIso, source: "minted" };
  if (branch && branch.atMs > newest.atMs) newest = { atMs: branch.atMs, atIso: branch.atIso, source: "run-branch", ref: branch.ref };
  return newest;
}

export type RunBranchActivity = { ok: true; newest?: RunBranchCommit } | { ok: false; stderr: string };

/** The newest commit time on any origin `run-<taskId>-<epochMs>` branch. Any failed read is `ok: false`. */
export async function readRunBranchActivity(taskId: string, run: ClaimGitDepsAsync["run"]): Promise<RunBranchActivity> {
  const failed = (res: GitAnswer): RunBranchActivity => ({ ok: false, stderr: res.stderr.replace(/\s+/g, " ").trim().slice(0, 300) || `git exited ${res.status}` });
  const listed = await run(["ls-remote", "origin", `refs/heads/run-${taskId}-*`]);
  if (listed.status !== 0) return failed(listed);
  let newest: RunBranchCommit | undefined;
  for (const line of listed.stdout.split("\n")) {
    const m = /^([0-9a-f]{7,64})\s+(refs\/heads\/run-(\S+)-\d+)$/.exec(line.trim());
    if (!m || m[3] !== taskId) continue;
    const fetched = await run(["fetch", "--quiet", "--no-write-fetch-head", "origin", m[2]!]);
    if (fetched.status !== 0) return failed(fetched);
    const shown = await run(["log", "-1", "--format=%ct", m[1]!]);
    const atMs = Number(shown.stdout.trim()) * 1000;
    if (shown.status !== 0 || !Number.isFinite(atMs) || atMs <= 0) return failed(shown);
    if (newest === undefined || atMs > newest.atMs) newest = { atMs, atIso: fixedClock(atMs).iso(), ref: m[2]! };
  }
  return newest === undefined ? { ok: true } : { ok: true, newest };
}

export type ClaimSilenceVerdict = "alive" | "unrenewed" | "reclaim" | "no-verdict";

export interface ClaimSilenceDecision {
  readonly verdict: ClaimSilenceVerdict;
  readonly reason: string;
  readonly silenceMs?: number;
}

/**
 * PURE. Judges a foreign claim by how long its holder has been silent, measured against W, this
 * fleet's own p90 build time: under W `alive`, from W `unrenewed` (report, keep), from 2W `reclaim`.
 * Every input it cannot read is `no-verdict` — the caller then leaves the claim to the operator arm.
 * FALSIFIER: test/a-dispatch-claim-holds-only-while-its-holder-renews-it.test.ts.
 */
export function decideClaimSilence(i: {
  taskId: string;
  anchor?: ClaimAnchorIdentity;
  lastSignOfLife?: ClaimSignOfLife;
  mintedByThisInstance: boolean;
  window: ClaimSilenceWindow;
  nowMs: number;
}): ClaimSilenceDecision {
  const ref = dispatchClaimRef(i.taskId);
  const w = i.window.windowMs;
  if (w === undefined || i.window.samples === 0 || !(w > 0))
    return { verdict: "no-verdict", reason: `no-duration-evidence: this instance has no measured claim-to-verdict duration, so ${ref}'s silence cannot be judged` };
  if (i.anchor === undefined) return { verdict: "no-verdict", reason: `${ref}'s anchor is unreadable, so its holder's silence cannot be judged` };
  if (i.mintedByThisInstance)
    return { verdict: "no-verdict", reason: `${ref} was minted by a fleet lane of this instance (its dispatch.claim created row), which the dead-claimant arm judges` };
  if (i.lastSignOfLife === undefined) return { verdict: "no-verdict", reason: `${ref}'s run branches are unreadable, so its last sign of life is unknown` };
  const silenceMs = Math.max(0, i.nowMs - i.lastSignOfLife.atMs);
  const judged = Math.max(w, CLAIM_SILENCE_FLOOR_MS);
  const said = `${ref} is held by ${i.anchor.pid}@${i.anchor.host}, minted ${i.anchor.mintedAtIso}; its last sign of life ` +
    `(${i.lastSignOfLife.source}) was ${i.lastSignOfLife.atIso}, ${silenceMs}ms ago, against W=${judged}ms (p90 of ${i.window.samples} measured builds` +
    `${judged > w ? `, ${w}ms raised to two renewal intervals` : ""})`;
  if (silenceMs >= 2 * judged) return { verdict: "reclaim", silenceMs, reason: `${said} — silent for 2W or more; reclaiming` };
  if (silenceMs >= judged) return { verdict: "unrenewed", silenceMs, reason: `${said} — silent for W or more; keeping it` };
  return { verdict: "alive", silenceMs, reason: `${said} — keeping it` };
}

/** A holder renews only every {@link DISPATCH_CLAIM_RENEW_INTERVAL_MS}, so silence shorter than two renewal intervals is no
 *  evidence it stopped: a measured W below this would let 2W reclaim a healthy holder before its first renewal. */
export const CLAIM_SILENCE_FLOOR_MS = 2 * DISPATCH_CLAIM_RENEW_INTERVAL_MS;

export interface ClaimSilenceJudgeInputs {
  run: ClaimGitDepsAsync["run"];
  stateDir: string;
  log: (step: string, fields: Record<string, unknown>) => void;
  say?: (line: string) => void;
  clock?: Clock;
  readRows?: (sinceIso: string) => Promise<Array<Record<string, unknown>>>;
  mintedByThisInstance?: (anchor: ClaimAnchorIdentity) => boolean;
}

export interface ClaimSilenceJudgement extends ClaimSilenceDecision {
  readonly dropped?: boolean;
  /** Set only when this lane reclaimed the claim AND its retried create took it: the anchor it now holds. */
  readonly anchor?: string;
}

/**
 * W1-T9432: runTask's `taken` arm, once arms 1-3 declined. Reports a claim silent for W once per
 * judged sha (`dispatch.claim_unrenewed`); drops one silent for 2W, pinned to that sha
 * (`dispatch.claim_reclaimed`), and retries the create once so the judging lane builds the task.
 */
export async function reclaimSilentDispatchClaim(
  taskId: string,
  reserver: DispatchClaimReserverAsync,
  deps: ClaimSilenceJudgeInputs,
): Promise<ClaimSilenceJudgement> {
  const nowMs = (deps.clock ?? systemClock).now();
  const readRows = deps.readRows ?? ((since: string) => readLedgerUnionRecords(deps.stateDir, { since, step: CLAIM_SILENCE_LEDGER_STEPS }));
  const rows = await readRows(fixedClock(nowMs - DISPATCH_VALUE_WINDOW_MS).iso());
  const window = claimSilenceWindow(rows);
  const judged = window.samples > 0 ? await reserver.holder(taskId) : undefined;
  const message = judged ? await reserver.anchorMessage?.(taskId) : undefined;
  const anchor = parseClaimAnchorMessage(message);
  const mine = anchor !== undefined && (deps.mintedByThisInstance ?? ((a) => findClaimMintRow(deps.stateDir, taskId, a) !== undefined))(anchor);
  const branches = anchor !== undefined && !mine ? await readRunBranchActivity(taskId, deps.run) : undefined;
  const lastSignOfLife = anchor !== undefined && branches?.ok ? claimLastSignOfLife(anchor, message, branches.newest) : undefined;
  const decision = decideClaimSilence({ taskId, anchor, lastSignOfLife, mintedByThisInstance: mine, window, nowMs });
  if (decision.verdict === "no-verdict" || decision.verdict === "alive") return decision;
  const fields = {
    ref: dispatchClaimRef(taskId), sha: judged, holder: `${anchor!.pid}@${anchor!.host}`, minted: anchor!.mintedAtIso,
    last_sign_of_life: lastSignOfLife!.atIso, last_sign_of_life_source: lastSignOfLife!.source,
    ...(lastSignOfLife!.ref ? { last_sign_of_life_ref: lastSignOfLife!.ref } : {}),
    silence_ms: decision.silenceMs, window_ms: window.windowMs, samples: window.samples, reason: decision.reason,
  };
  if (decision.verdict === "unrenewed") {
    if (!rows.some((r) => r.step === "dispatch.claim_unrenewed" && r.sha === judged)) deps.log("dispatch.claim_unrenewed", fields);
    return decision;
  }
  const dropped = await reserver.drop(taskId, { expect: judged! });
  deps.log("dispatch.claim_reclaimed", { ...fields, dropped });
  if (!dropped) return { ...decision, dropped };
  deps.say?.(`RECLAIMED a silent claim — ${decision.reason}`);
  const fresh = await reserver.mintAnchor();
  const retried = await reserver.attempt(taskId, fresh);
  return retried === "created" ? { ...decision, dropped, anchor: fresh } : { ...decision, dropped };
}

/** A run's own claim, renewed on {@link DISPATCH_CLAIM_RENEW_INTERVAL_MS} until `stop()` hands back the sha to release. */
export interface DispatchClaimLease {
  current(): string;
  stop(): Promise<string>;
}

export function holdDispatchClaim(
  taskId: string,
  reserver: DispatchClaimReserverAsync,
  anchor: string,
  opts: { intervalMs?: number; log?: (step: string, fields: Record<string, unknown>) => void } = {},
): DispatchClaimLease {
  let held = anchor;
  if (!reserver.renew) return { current: () => held, stop: async () => held };
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const ref = dispatchClaimRef(taskId);
  const renewOnce = async (): Promise<void> => {
    const renewal = await renewDispatchClaimAsync(reserver, taskId, held);
    if (renewal.outcome === "renewed") {
      held = renewal.sha;
      return;
    }
    opts.log?.("dispatch.claim_renew_failed", { ref, held, ...renewal });
    if (renewal.outcome === "lost") {
      stopped = true;
      clearInterval(timer);
    }
  };
  const timer = setInterval(() => {
    if (stopped || inFlight !== undefined) return;
    inFlight = renewOnce()
      .catch((error: unknown) => opts.log?.("dispatch.claim_renew_failed", { ref, held, outcome: "error", error: String((error as Error)?.message ?? error) }))
      .finally(() => {
        inFlight = undefined;
      });
  }, opts.intervalMs ?? DISPATCH_CLAIM_RENEW_INTERVAL_MS);
  timer.unref?.();
  return {
    current: () => held,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      return held;
    },
  };
}

// ── PR REPAIR CLAIMS (W1-T2677) ─────────────────────────────────────────────────────────────

/** One advisory claim on an open PR repair. Unlike a task-dispatch claim it expires: repairers
 *  already have an exact-head push guard, so this only prevents duplicate diagnosis work. */
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
 * Atomically claims the diagnosis phase for one open PR: create-if-absent, or read the live
 * claim's holder/age, or (if expired) replace it via force-with-lease against the anchor just
 * read, so two reclaimers cannot both believe they won. Unreadable metadata fails closed.
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
  // The holder may have released between the rejected create and this read; refuse this round
  // and let the next caller retry the plain create path — an absent ref can't strand the PR.
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
    // Malformed JSON and an invalid payload share this result; the catch stays explicit.
    void error;
    return undefined;
  }
}

/** Real Git implementation usable from a fleet fixer, Codex session, or operator checkout. */
export function gitRepairClaimReserver(deps: ClaimGitDeps): RepairClaimReserver {
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
      assertClaimRefPushAllowed(deps.run, repairClaimRef(prNumber));
      const res = deps.run(["push", "origin", `${anchor}:${repairClaimRef(prNumber)}`]);
      return res.status === 0 ? "created" : classifyPushFailure(res.stderr);
    },
    read(prNumber) {
      const ref = repairClaimRef(prNumber);
      const listed = deps.run(["ls-remote", "origin", ref]);
      if (listed.status !== 0) return { state: "unreachable", reason: listed.stderr.replace(/\s+/g, " ").trim().slice(0, 300) };
      const anchor = listed.stdout.trim().split(/\s+/)[0];
      if (!anchor) return { state: "absent" };
      // ls-remote naming the anchor doesn't mean this checkout has the object — fetch this ref first.
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
      assertClaimRefPushAllowed(deps.run, ref);
      const res = deps.run(["push", `--force-with-lease=${ref}:${expectedAnchor}`, "origin", `${anchor}:${ref}`]);
      if (res.status === 0) return "replaced";
      return classifyPushFailure(res.stderr) === "taken" ? "lost" : "unreachable";
    },
    drop(prNumber, expectedAnchor) {
      const ref = repairClaimRef(prNumber);
      assertClaimRefPushAllowed(deps.run, ref);
      return deps.run(["push", `--force-with-lease=${ref}:${expectedAnchor}`, "origin", `:${ref}`]).status === 0;
    },
  };
}
