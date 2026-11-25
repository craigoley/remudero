import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// W1-T14745: a review counts CI's hosted PASS for a proof instead of running it, and still runs some of those proofs so
// the trust stays measured. What that share is derived from is journalled per repository beside the review ledger.
// INVARIANT reuse-never-passes-what-the-host-would-fail: only a hosted PASS is counted, and a proof the host ran at a
// head without passing it stays on the host at that head.

/** The ledger row of an audited proof the host judged differently from CI. */
export const PROOF_REUSE_DISAGREEMENT_STEP = "proof_reuse.disagreement";

/** A hosted PASS counted in place of a host run, and where CI recorded it. */
export interface HostedProofPass { hosted_run_id: number; hosted_job_id: number }

/** One review's measurements, one journal line. `agreed` and `held` are {@link proofReuseKey}s. */
export interface ProofReuseAuditEntry {
  head_sha: string;
  /** Audited proofs the host passed too. */
  agreed: string[];
  /** Audited proofs the host failed: above zero, every earlier agreement is discarded. */
  disagreed: number;
  /** Proofs the host must keep running at this head. */
  held: string[];
  /** Host proof time and the number of proofs it covered: what a skipped proof's saving is estimated from. */
  host_ms: number;
  host_runs: number;
}

export type ProofReuseAudit =
  | { kind: "read"; agreed: number; held: ReadonlySet<string>; hostMs: number; hostRuns: number }
  | { kind: "unreadable"; reason: string };

export function proofReuseAuditPath(stateDir: string, repository: { owner: string; repo: string }): string {
  return join(stateDir, `proof-reuse-audit.${repository.owner}.${repository.repo}.jsonl`);
}

export function proofReuseKey(headSha: string, proof: string): string {
  return createHash("sha256").update(`${headSha}\0${proof}`).digest("hex");
}

/**
 * The probability a hosted PASS is executed on the host anyway: the posterior mean of the disagreement rate after
 * `agreed` agreements and none since the last reset, Beta(1, agreed + 1), over the uniform prior's mean. So it is 1
 * with no history and falls as agreements accumulate, with no chosen rate, floor or credible level.
 */
export function proofReuseAuditShare(agreed: number): number {
  return Number.isFinite(agreed) && agreed > 0 ? 2 / (agreed + 2) : 1;
}

/** A pure function of head, proof and share: a re-review at the same share selects the same proofs. */
export function proofReuseAudited(headSha: string, proof: string, share: number): boolean {
  return share >= 1 || Number.parseInt(proofReuseKey(headSha, proof).slice(0, 8), 16) / 2 ** 32 < share;
}

/** CI's merge-base outcomes that establish discrimination: measured, or a target the base verifiably lacked. */
const DISCRIMINATING_BASE: ReadonlySet<unknown> = new Set(["fail", "no-match", "ABSENT"]);

/** The one hosted outcome a review counts: a pass at the head that discriminates against the merge base. */
export function hostedPassIsReusable(outcome: { head?: unknown; base?: unknown; verdict?: unknown }): boolean {
  return outcome.verdict === "pass" && outcome.head === "pass" && DISCRIMINATING_BASE.has(outcome.base);
}

function isAuditEntry(value: unknown): value is ProofReuseAuditEntry {
  const entry = value as Partial<ProofReuseAuditEntry> | null;
  const keys = (list: unknown) => Array.isArray(list) && list.every(key => typeof key === "string");
  return !!entry && keys(entry.agreed) && keys(entry.held) && [entry.disagreed, entry.host_ms, entry.host_runs].every(Number.isFinite);
}

/**
 * One repository's audit state: the distinct agreements since the newest disagreement, and every held proof. A missing
 * journal is no history. An unreadable one, or a ledger row saying a disagreement never reached the journal, is
 * `unreadable`, on which a review runs every proof. A torn line may have been a disagreement, so it resets the count.
 */
export function readProofReuseAudit(
  path: string, repository: string, ledgerRows: () => readonly Record<string, unknown>[],
  read: (path: string) => string = file => readFileSync(file, "utf8"),
): ProofReuseAudit {
  try {
    const disagreements = ledgerRows().filter(row => row.step === PROOF_REUSE_DISAGREEMENT_STEP && row.repo === repository);
    const lost = disagreements.find(row => typeof row.audit_error === "string");
    if (lost !== undefined) return { kind: "unreadable", reason: `a disagreement was never journalled: ${String(lost.audit_error)}` };
    let text = "";
    try {
      text = read(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const agreed = new Set<string>();
    const held = new Set(disagreements.map(row => proofReuseKey(String(row.head_sha), String(row.proof))));
    let hostMs = 0, hostRuns = 0;
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        entry = { unparsed: String(error) }; // not an entry, so it resets the count below
      }
      if (!isAuditEntry(entry)) {
        agreed.clear();
        continue;
      }
      if (entry.disagreed > 0) agreed.clear();
      else for (const key of entry.agreed) agreed.add(key);
      for (const key of entry.held) held.add(key);
      hostMs += entry.host_ms;
      hostRuns += entry.host_runs;
    }
    return { kind: "read", agreed: agreed.size, held, hostMs, hostRuns };
  } catch (error) {
    return { kind: "unreadable", reason: String((error as Error)?.message ?? error).slice(0, 200) };
  }
}

/** Append one review's line. Returns why it could not, for the caller to ledger; `undefined` when it was written. */
export function recordProofReuseAudit(path: string, entry: ProofReuseAuditEntry): string | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    return undefined;
  } catch (error) {
    const reason = String((error as Error)?.message ?? error).slice(0, 200);
    return reason;
  }
}

/** Host outcomes that are an answer other than pass. A run that reached none (load, spawn failure) disputes nothing
 *  unless the review failed the criterion on it; either way the proof is held. */
const HOST_REFUSED: ReadonlySet<string> = new Set(["executed_fail", "executed_stale", "stale_self_path", "cannot_evaluate"]);
const HOST_NEVER_RAN: ReadonlySet<string> = new Set(["not_executable", "not_yet_built"]);

export interface ProofReuseDisagreement { proof: string; host: string }

/** What the audit reads of a criterion verdict (review.ts imports this module, so the type is not imported back). */
export interface JudgedProof { proof: string; proof_exec: string; floorMet?: boolean; hosted_reuse?: HostedProofPass }

/** What one judged fold measured: the journal line it adds (none when it measured nothing) and its disagreements. */
export function settleProofReuseAudit(args: {
  headSha: string; audited: ReadonlySet<string>; hostMs: number; criteria: readonly JudgedProof[];
}): { entry: ProofReuseAuditEntry | undefined; disagreements: ProofReuseDisagreement[] } {
  const entry: ProofReuseAuditEntry = { head_sha: args.headSha, agreed: [], disagreed: 0, held: [], host_ms: args.hostMs, host_runs: 0 };
  const disagreements: ProofReuseDisagreement[] = [];
  const seen = new Set<string>();
  for (const criterion of args.criteria) {
    const proof = criterion.proof.trim();
    if (proof === "" || criterion.hosted_reuse !== undefined || seen.has(proof)) continue;
    seen.add(proof);
    const host = criterion.proof_exec;
    const audited = args.audited.has(proof);
    if (!HOST_NEVER_RAN.has(host)) entry.host_runs++;
    if (host === "executed_pass") {
      if (audited) entry.agreed.push(proofReuseKey(args.headSha, proof));
      continue;
    }
    if (audited && (HOST_REFUSED.has(host) || host === "exec_error" && criterion.floorMet === false)) disagreements.push({ proof, host });
    if (audited || !HOST_NEVER_RAN.has(host)) entry.held.push(proofReuseKey(args.headSha, proof));
  }
  entry.disagreed = disagreements.length;
  const measured = entry.agreed.length > 0 || entry.held.length > 0;
  return { entry: measured ? entry : undefined, disagreements };
}
