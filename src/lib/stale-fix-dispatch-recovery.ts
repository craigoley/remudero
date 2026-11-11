/**
 * W1-T12113 — the one pure, fail-closed decision over whether a stale fix dispatch may be
 * recovered, and the one receipt schema that records the attempt.
 *
 * `rmd pr-owner` reports OWNED while any fix.dispatch row for the PR exists, so a dispatch whose
 * worker died before writing fix.done holds the PR forever. This module only DECIDES: callers
 * gather the evidence (inflight lock, process and cwd census, claims, preservation) and the
 * W1-T12114 operator verb acts. Every unknown, missing or unexpected value decides `hold` with
 * one named reason; `recover` needs every piece of evidence to agree.
 */
import { createHash } from "node:crypto";
import { RECOVERY_REF_NAMESPACE } from "./recovery-refs.js";

export const STALE_FIX_DISPATCH_RECEIPT_STEP = "pr_owner.recovery_receipt";

export interface StaleFixDispatchIdentity {
  repo: string;
  prNumber: number;
  taskId: string;
  dispatchRunId: string;
  dispatchRoundId: string;
  headSha: string;
  baseSha: string;
  branch: string;
  /** Nonempty for a real recovery; absent in shadow. Absence is a hold, never an implied grant. */
  authorizationId?: string;
}

export interface StaleFixDispatchExpected extends StaleFixDispatchIdentity {
  /** The run id this recovery invocation stamps on the fix branch claim it acquires. */
  recoveryInvocationRunId: string;
  /** The prior dispatch lock's stored claim run_id (production `fixRoundClaimId` shape), set by
   *  W1-T12114 only when it reclaims a pre-existing prior-dispatch lock. */
  priorFixBranchClaimRunId?: string;
}

export interface StaleFixDispatchLatest {
  runId: string;
  roundId?: string;
  ts?: string;
}

export interface StaleFixDispatchProcess {
  state: "dead" | "alive" | "unknown" | "unrecorded" | "foreign_host" | "reused";
  pid?: number;
  host?: string;
  startedAt?: string;
}

export interface StaleFixDispatchReclaimedPrior {
  run_id: string;
  dispatchRunId: string;
  claimMs: number;
  host: string;
  pid: number;
  startedAt: string;
  rawSha256: string;
  compareAndReclaim: "matched" | "mismatch";
}

export interface StaleFixDispatchFacts {
  observed: StaleFixDispatchIdentity;
  latestDispatch?: StaleFixDispatchLatest;
  process: StaleFixDispatchProcess;
  descendants: { state: "none" | "present" | "unknown"; pids?: number[] };
  cwdCensus: { state: "clear" | "occupied" | "unknown" };
  fixBranchClaim: {
    state: "clear" | "held" | "unknown";
    holder?: string;
    holderRunId?: string;
    reclaimedPrior?: StaleFixDispatchReclaimedPrior;
  };
  dispatchClaim: { state: "clear" | "held" | "unknown"; holder?: string };
  preservation:
    | { state: "published"; recoveryRef: string; sha: string }
    | { state: "nothing_to_preserve"; headContained: true }
    | { state: "failed" | "unknown"; reason: string };
  ledgerRead: { ok: boolean; unread?: string[] };
}

export type StaleFixDispatchHoldReason =
  | "ledger_unreadable"
  | "authorization_missing"
  | `identity_mismatch:${"repo" | "pr" | "task" | "run" | "round" | "head" | "base" | "branch" | "authorization"}`
  | "newer_dispatch"
  | "process_alive"
  | "process_unknown"
  | "process_reused"
  | "liveness_unrecorded"
  | "process_foreign_host"
  | "descendants_present"
  | "descendants_unknown"
  | "cwd_occupied"
  | "cwd_unknown"
  | "competing_branch_claim_held"
  | "branch_claim_unknown"
  | "stale_claim_identity_mismatch"
  | "stale_claim_liveness_unknown"
  | "dispatch_claim_held"
  | "dispatch_claim_unknown"
  | "preservation_failed"
  | "preservation_unknown";

export type StaleFixDispatchDecision = { kind: "recover" } | { kind: "hold"; reason: StaleFixDispatchHoldReason };

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CLAIM_RUN_ID = /^.+:fix-claim:(\d+):(\d+)$/;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function identityMismatch(
  expected: StaleFixDispatchExpected,
  observed: StaleFixDispatchIdentity | undefined,
): StaleFixDispatchHoldReason | undefined {
  if (observed === undefined) return "identity_mismatch:repo";
  if (!nonEmpty(expected.repo) || expected.repo !== observed.repo) return "identity_mismatch:repo";
  if (!positiveInt(expected.prNumber) || expected.prNumber !== observed.prNumber) return "identity_mismatch:pr";
  const rest: Array<[keyof StaleFixDispatchIdentity, StaleFixDispatchHoldReason, RegExp?]> = [
    ["taskId", "identity_mismatch:task"],
    ["dispatchRunId", "identity_mismatch:run"],
    ["dispatchRoundId", "identity_mismatch:round"],
    ["headSha", "identity_mismatch:head", FULL_SHA],
    ["baseSha", "identity_mismatch:base", FULL_SHA],
    ["branch", "identity_mismatch:branch"],
    ["authorizationId", "identity_mismatch:authorization"],
  ];
  for (const [field, reason, shape] of rest) {
    const want = expected[field];
    if (!nonEmpty(want) || want !== observed[field]) return reason;
    if (shape !== undefined && !shape.test(want)) return reason;
  }
  return undefined;
}

function livenessHold(process: StaleFixDispatchProcess | undefined): StaleFixDispatchHoldReason | undefined {
  switch (process?.state) {
    case "dead":
      return positiveInt(process.pid) && nonEmpty(process.host) && nonEmpty(process.startedAt) ? undefined : "liveness_unrecorded";
    case "alive":
      return "process_alive";
    case "reused":
      return "process_reused";
    case "foreign_host":
      return "process_foreign_host";
    case "unrecorded":
      return "liveness_unrecorded";
    default:
      return "process_unknown";
  }
}

function reclaimHold(
  expected: StaleFixDispatchExpected,
  prior: StaleFixDispatchReclaimedPrior,
  process: StaleFixDispatchProcess,
): StaleFixDispatchHoldReason | undefined {
  const claimShape = typeof prior.run_id === "string" ? CLAIM_RUN_ID.exec(prior.run_id) : null;
  if (
    !nonEmpty(expected.priorFixBranchClaimRunId) ||
    prior.run_id !== expected.priorFixBranchClaimRunId ||
    prior.dispatchRunId !== expected.dispatchRunId ||
    claimShape === null ||
    claimShape[1] !== String(expected.prNumber) ||
    !positiveInt(prior.claimMs) ||
    claimShape[2] !== String(prior.claimMs) ||
    typeof prior.rawSha256 !== "string" ||
    !SHA256_HEX.test(prior.rawSha256) ||
    prior.compareAndReclaim !== "matched"
  ) {
    return "stale_claim_identity_mismatch";
  }
  // The lock's liveness is known only through the one dead process this decision already proved:
  // a different host, pid or start time is a process nobody probed.
  if (
    !positiveInt(prior.pid) ||
    prior.host !== process.host ||
    prior.pid !== process.pid ||
    prior.startedAt !== process.startedAt
  ) {
    return "stale_claim_liveness_unknown";
  }
  return undefined;
}

function branchClaimHold(
  expected: StaleFixDispatchExpected,
  facts: StaleFixDispatchFacts,
): StaleFixDispatchHoldReason | undefined {
  const claim = facts.fixBranchClaim;
  if (claim?.state !== "clear" && claim?.state !== "held") return "branch_claim_unknown";
  if (claim.reclaimedPrior !== undefined) {
    const reason = reclaimHold(expected, claim.reclaimedPrior, facts.process);
    if (reason !== undefined) return reason;
  }
  if (claim.state === "held") {
    const ours = nonEmpty(expected.recoveryInvocationRunId) && claim.holderRunId === expected.recoveryInvocationRunId;
    if (!ours) return "competing_branch_claim_held";
  }
  return undefined;
}

function preservationHold(preservation: StaleFixDispatchFacts["preservation"] | undefined): StaleFixDispatchHoldReason | undefined {
  if (preservation?.state === "published") {
    return nonEmpty(preservation.recoveryRef) &&
      preservation.recoveryRef.startsWith(`${RECOVERY_REF_NAMESPACE}/`) &&
      typeof preservation.sha === "string" && FULL_SHA.test(preservation.sha)
      ? undefined
      : "preservation_unknown";
  }
  if (preservation?.state === "nothing_to_preserve") return preservation.headContained === true ? undefined : "preservation_unknown";
  if (preservation?.state === "failed") return "preservation_failed";
  return "preservation_unknown";
}

/** Checks in a fixed order and returns at the first failure; only full agreement recovers. */
export function decideStaleFixDispatchRecovery(
  expected: StaleFixDispatchExpected,
  facts: StaleFixDispatchFacts,
): StaleFixDispatchDecision {
  const hold = (reason: StaleFixDispatchHoldReason): StaleFixDispatchDecision => ({ kind: "hold", reason });
  if (facts?.ledgerRead?.ok !== true || (facts.ledgerRead.unread?.length ?? 0) > 0) return hold("ledger_unreadable");
  if (!nonEmpty(expected.authorizationId)) return hold("authorization_missing");
  const mismatch = identityMismatch(expected, facts.observed);
  if (mismatch !== undefined) return hold(mismatch);
  const latest = facts.latestDispatch;
  if (latest === undefined || !nonEmpty(latest.runId)) return hold("ledger_unreadable");
  if (latest.runId !== expected.dispatchRunId) return hold("newer_dispatch");
  if (latest.roundId !== undefined && latest.roundId !== expected.dispatchRoundId) return hold("newer_dispatch");
  const liveness = livenessHold(facts.process);
  if (liveness !== undefined) return hold(liveness);
  if (facts.descendants?.state === "present") return hold("descendants_present");
  if (facts.descendants?.state !== "none") return hold("descendants_unknown");
  if (facts.cwdCensus?.state === "occupied") return hold("cwd_occupied");
  if (facts.cwdCensus?.state !== "clear") return hold("cwd_unknown");
  const claim = branchClaimHold(expected, facts);
  if (claim !== undefined) return hold(claim);
  if (facts.dispatchClaim?.state === "held") return hold("dispatch_claim_held");
  if (facts.dispatchClaim?.state !== "clear") return hold("dispatch_claim_unknown");
  const preservation = preservationHold(facts.preservation);
  if (preservation !== undefined) return hold(preservation);
  return { kind: "recover" };
}

/** sha256 over the prior dispatch's identity and the authorization only — never a timestamp,
 *  outcome or evidence — so a retry and a racing second invocation name one recovery. */
export function staleFixDispatchRecoveryId(expected: StaleFixDispatchIdentity): string {
  const identity = [
    expected.repo, expected.prNumber, expected.taskId, expected.dispatchRunId, expected.dispatchRoundId,
    expected.headSha, expected.baseSha, expected.branch, expected.authorizationId ?? "",
  ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export interface StaleFixDispatchReceipt {
  step: typeof STALE_FIX_DISPATCH_RECEIPT_STEP;
  recovery_id: string;
  repo: string;
  pr_number: number;
  task_id: string;
  prior_run_id: string;
  prior_round_id: string;
  prior_dispatch_ts?: string;
  head_sha: string;
  base_sha: string;
  branch: string;
  authorization_id?: string;
  liveness: {
    process: StaleFixDispatchProcess;
    descendants: StaleFixDispatchFacts["descendants"];
    cwd_census: StaleFixDispatchFacts["cwdCensus"];
    fix_branch_claim: StaleFixDispatchFacts["fixBranchClaim"];
    dispatch_claim: StaleFixDispatchFacts["dispatchClaim"];
  };
  preservation: StaleFixDispatchFacts["preservation"];
  actor: string;
  ts: string;
  reason: string;
  outcome: "released" | "held";
  hold_reason?: StaleFixDispatchHoldReason;
}

/** The canonical receipt. It carries no fix.done, credit, merge or status field: a recovery
 *  releases ownership and credits nothing. */
export function staleFixDispatchRecoveryReceipt(
  expected: StaleFixDispatchExpected,
  facts: StaleFixDispatchFacts,
  meta: { actor: string; nowIso: string; reason: string },
): StaleFixDispatchReceipt {
  const decision = decideStaleFixDispatchRecovery(expected, facts);
  return {
    step: STALE_FIX_DISPATCH_RECEIPT_STEP,
    recovery_id: staleFixDispatchRecoveryId(expected),
    repo: expected.repo,
    pr_number: expected.prNumber,
    task_id: expected.taskId,
    prior_run_id: expected.dispatchRunId,
    prior_round_id: expected.dispatchRoundId,
    ...(facts.latestDispatch?.ts !== undefined ? { prior_dispatch_ts: facts.latestDispatch.ts } : {}),
    head_sha: expected.headSha,
    base_sha: expected.baseSha,
    branch: expected.branch,
    ...(expected.authorizationId !== undefined ? { authorization_id: expected.authorizationId } : {}),
    liveness: {
      process: facts.process,
      descendants: facts.descendants,
      cwd_census: facts.cwdCensus,
      fix_branch_claim: facts.fixBranchClaim,
      dispatch_claim: facts.dispatchClaim,
    },
    preservation: facts.preservation,
    actor: meta.actor,
    ts: meta.nowIso,
    reason: meta.reason,
    outcome: decision.kind === "recover" ? "released" : "held",
    ...(decision.kind === "hold" ? { hold_reason: decision.reason } : {}),
  };
}

export interface StaleFixDispatchShadow {
  outcome: "hold";
  reason: StaleFixDispatchHoldReason;
}

function rowString(row: Record<string, unknown>, key: string): string {
  return typeof row[key] === "string" ? row[key] : "";
}

/** The read-only `rmd pr-owner` shadow's inputs for its latest fix.dispatch row: no operator
 *  authorization and unknown liveness, cwd, claim and preservation evidence. It gathers nothing,
 *  so the decision over these inputs can only hold. */
export function staleFixDispatchShadowInputs(
  prNumber: number,
  ledgerRead: { ok: boolean; unread: string[] },
  latestFix: Record<string, unknown>,
): { expected: StaleFixDispatchExpected; facts: StaleFixDispatchFacts } {
  const observed: StaleFixDispatchIdentity = {
    repo: rowString(latestFix, "repo"),
    prNumber,
    taskId: rowString(latestFix, "task_id"),
    dispatchRunId: rowString(latestFix, "run_id"),
    dispatchRoundId: rowString(latestFix, "round_id"),
    headSha: rowString(latestFix, "head_sha"),
    baseSha: rowString(latestFix, "base_sha"),
    branch: rowString(latestFix, "branch"),
  };
  return {
    expected: { ...observed, recoveryInvocationRunId: "" },
    facts: {
      observed,
      latestDispatch: { runId: observed.dispatchRunId, ...(typeof latestFix.ts === "string" ? { ts: latestFix.ts } : {}) },
      process: { state: "unknown" },
      descendants: { state: "unknown" },
      cwdCensus: { state: "unknown" },
      fixBranchClaim: { state: "unknown" },
      dispatchClaim: { state: "unknown" },
      preservation: { state: "unknown", reason: "shadow: preservation not gathered" },
      ledgerRead: { ok: ledgerRead.ok, unread: [...ledgerRead.unread] },
    },
  };
}

/** Attach the shadow diagnostic to an owner verdict without touching any of its fields. A shadow
 *  can only report HOLD: a `recover` decision (unreachable without authorization) still reads hold. */
export function withStaleFixDispatchShadow<V extends object>(
  verdict: V,
  decision: StaleFixDispatchDecision,
): V & { recoveryShadow: StaleFixDispatchShadow } {
  const reason: StaleFixDispatchHoldReason = decision.kind === "hold" ? decision.reason : "authorization_missing";
  return { ...verdict, recoveryShadow: { outcome: "hold", reason } };
}
