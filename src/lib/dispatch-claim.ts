import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { classifyPushFailure } from "./task-id-reservation.js";

/**
 * Cross-host git-ref CAS closing the dispatch-time race, in the same family as `refs/rmd-id/`
 * (W1-T509) and `refs/rmd-triage/` (W1-T1132), now at the dispatch rung (W1-T1268).
 *
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
 *  3. DEAD-CLAIMANT (W1-T2784) — the anchor names THIS host and predates its PID namespace's
 *     init, so the pid can't be a survivor; `pidPresent` must also read absent (guards reuse).
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
  if (a && l && a.host === l.localHost && a.mintedAtMs < l.namespaceBootMs && !l.pidPresent) {
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
  return {
    arm: "operator",
    release: false,
    reason:
      `${dispatchClaimRef(i.taskId)} is held by another lane with no landed work observed yet — leaving it. ` +
      `Cross-host liveness is not decidable, so clearing it is an operator call: ` +
      `git push origin :${dispatchClaimRef(i.taskId)}`,
  };
}

/** The one I/O seam — every method is a git round trip; every decision above is pure and tested
 *  without one, mirroring `TriageClaimReserver`. */
export interface DispatchClaimReserver {
  /** A payload unique to THIS writer — two writers must never produce the same value. */
  mintAnchor(): string;
  /** Create-if-absent of {@link dispatchClaimRef}. Never throws — unreachable is an outcome. */
  attempt(taskId: string, anchor: string): DispatchClaimOutcome;
  /** The anchor currently at the claim ref, or `undefined` when absent or unreadable. */
  holder(taskId: string): string | undefined;
  /** Delete the claim ref, conditional on `expect` matching the ref's current anchor if given. */
  drop(taskId: string, opts?: { expect?: string }): boolean;
  /** W1-T2552: git's own stderr from the most recent {@link attempt}, or `undefined` when it
   *  succeeded or none has run yet. Optional, so every existing fake stays valid.
   *  Why: docs/forensics/dispatch-claim.md#lastattemptstderr (the missing-credential incident). */
  lastAttemptStderr?(): string | undefined;
  /** W1-T2784: the claim ref's current commit MESSAGE, for {@link parseClaimAnchorMessage} to
   *  decode. `undefined` when absent, unfetched, or unreadable — each declines the
   *  `dead-claimant` arm rather than releasing on a guess. Optional and last. */
  anchorMessage?(taskId: string): string | undefined;
}

export interface DispatchClaimGitDeps {
  /** Runs a git argv; returns its exit status, stdout and stderr. Injected by tests. */
  run(args: string[]): { status: number; stdout: string; stderr: string };
  /** Overrides the anchor so a test can make two writers distinguishable. */
  anchor?: () => string;
}

/** The real reserver: an orphan commit over the empty tree, pushed to the task's own ref — the
 *  same scheme `gitTriageClaimReserver` uses, so two writers' payloads stay unrelated. The
 *  message carries pid+host+time, legible to an operator and doubling as the uniqueness source. */
export function gitDispatchClaimReserver(deps: DispatchClaimGitDeps): DispatchClaimReserver {
  // Closure-scoped to one reserver, cleared on success, so a refusal never echoes an older attempt.
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
    anchorMessage(taskId) {
      const sha = this.holder(taskId);
      if (!sha) return undefined;
      // Fetch first: this is a parentless commit on a ref no clone tracks, so a bare cat-file on
      // a fresh checkout would miss it and read as "no identity" on a claim that's genuinely dead.
      deps.run(["fetch", "--quiet", "origin", `${dispatchClaimRef(taskId)}:${dispatchClaimRef(taskId)}`]);
      const res = deps.run(["cat-file", "-p", sha]);
      if (res.status !== 0) return undefined;
      // `cat-file -p` on a commit prints headers, a blank line, then the message.
      const blank = res.stdout.indexOf("\n\n");
      return blank === -1 ? undefined : res.stdout.slice(blank + 2).trim();
    },
  };
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
  } = {},
): DispatchClaimReleaseResult {
  // Only asked off the this-run path — releasing your own claim (arm 1) skips this I/O entirely.
  let anchorIdentity: ClaimAnchorIdentity | undefined;
  let liveness: ClaimantLivenessProbe | undefined;
  if (i.anchor === undefined && i.evidenceObserved !== true && i.livenessProbe) {
    anchorIdentity = parseClaimAnchorMessage(reserver.anchorMessage?.(taskId));
    // The pid is only meaningful once an anchor parsed — probe after, never before.
    if (anchorIdentity) liveness = i.livenessProbe();
  }
  const decision = decideDispatchClaimRelease({
    heldByThisRun: i.anchor !== undefined,
    evidenceObserved: i.evidenceObserved === true,
    taskId,
    anchorIdentity,
    liveness,
  });
  if (!decision.release) return { ...decision, dropped: false };
  // Pinned via `--force-with-lease` to the sha just judged, so a claim re-minted since survives.
  if (decision.arm === "dead-claimant") {
    const judged = reserver.holder(taskId);
    return { ...decision, dropped: judged ? reserver.drop(taskId, { expect: judged }) : false };
  }
  return { ...decision, dropped: reserver.drop(taskId, i.anchor !== undefined ? { expect: i.anchor } : {}) };
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
