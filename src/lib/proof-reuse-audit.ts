import { createHash } from "node:crypto";

// W1-T14745: a review that counts CI's proof-discrimination PASS instead of executing the proof still executes a
// share of those proofs, so the trust it extends stays measured. The share is DERIVED from the agreement the ledger
// recorded between CI's outcomes and the host's own runs (the `review.proof_reuse_shadow` rows), never a constant a
// reader must believe: it falls as agreements accumulate and returns to every proof after any disagreement.

/** The floor under the audit share: even a long clean record keeps one reused proof in twenty on the host. */
export const PROOF_REUSE_MIN_AUDIT_SHARE = 0.05;
/** The rule of three: after n agreements and no disagreement the 95% upper bound on the disagreement rate is 3/n. */
export const PROOF_REUSE_CONFIDENCE_FACTOR = 3;

/** The slice of a `review.proof_reuse_shadow` row the audit reads. */
export interface ProofReuseAgreementRow { ts?: unknown; eligible?: unknown; agreed?: unknown; disagreed?: unknown }

/**
 * Consecutive agreements recorded since the NEWEST disagreement (every agreement when none was recorded). A row that
 * was not eligible compared nothing and neither adds nor breaks the run. Rows are read newest first by `ts`; a row
 * with no readable stamp sorts as the oldest, so it can never hide a newer disagreement.
 */
export function agreementStreak(rows: readonly ProofReuseAgreementRow[]): number {
  const stamp = (row: ProofReuseAgreementRow): number => typeof row.ts === "string" && Number.isFinite(Date.parse(row.ts)) ? Date.parse(row.ts) : -Infinity;
  const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  let streak = 0;
  for (const row of [...rows].sort((a, b) => stamp(b) - stamp(a))) {
    if (row.eligible !== true) continue;
    if (count(row.disagreed) > 0) return streak;
    streak += count(row.agreed);
  }
  return streak;
}

/** The fraction of reused proofs the host executes anyway: every proof until three agreements are on record. */
export function proofReuseAuditShare(streak: number): number {
  if (!Number.isFinite(streak) || streak <= 0) return 1;
  return Math.min(1, Math.max(PROOF_REUSE_MIN_AUDIT_SHARE, PROOF_REUSE_CONFIDENCE_FACTOR / streak));
}

/** Is this proof at this head one of the audited share? A pure function of both, so a re-review of the same head
 *  audits the same proofs and a test can name which ones. */
export function proofReuseAudited(headSha: string, proof: string, share: number): boolean {
  if (share >= 1) return true;
  if (!(share > 0)) return false;
  const digest = createHash("sha256").update(`${headSha}\0${proof}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32 < share;
}

/** The outcome strings a CI record names for a proof's merge-base run. Only a base that was measured (`fail`,
 *  `no-match`) or whose target the base verifiably lacked (`ABSENT`) establishes discrimination; `UNKNOWN`,
 *  `UNREADABLE`, `COULD` (could not execute or link) and `pass` do not, and those proofs run on the host. */
const DISCRIMINATING_BASE = new Set(["fail", "no-match", "ABSENT"]);

/** The one shape of CI outcome a review counts without executing: head pass at a base that discriminates. A hosted
 *  FAIL, `executed_stale`, `refused` or unreadable outcome, and any base that proved nothing, is never reusable. */
export function hostedPassIsReusable(outcome: { head?: unknown; base?: unknown; verdict?: unknown }): boolean {
  return outcome.verdict === "pass" && outcome.head === "pass" && typeof outcome.base === "string" && DISCRIMINATING_BASE.has(outcome.base);
}

/** The proofs whose hosted PASS is counted, each by its identity (see {@link hostedProofReuseKey}). */
export interface HostedProofReuse { keys: ReadonlySet<string> }

/** A whitelisted proof's identity for reuse: its executable and exact argv, the same pair the memo keys a run by. */
export function hostedProofReuseKey(proof: { command: string; args: readonly string[] }): string {
  return JSON.stringify([proof.command, [...proof.args]]);
}

/** What counting a hosted PASS answers for one execution the review asks for, or `undefined` when the host runs it:
 *  at the head the PASS itself, at the merge base the miss the record's base outcome established. */
export function hostedReuseOutcome(
  reuse: { keys: ReadonlySet<string>; headCwd: string | undefined; baseCwd: string | undefined } | undefined,
  proof: { command: string; args: readonly string[] }, cwd: string,
): "pass" | "fail" | undefined {
  if (reuse === undefined || !reuse.keys.has(hostedProofReuseKey(proof))) return undefined;
  if (reuse.headCwd !== undefined && cwd === reuse.headCwd) return "pass";
  if (reuse.baseCwd !== undefined && cwd === reuse.baseCwd) return "fail";
  return undefined;
}

/** How many ledger rotations the agreement history reads beyond the live file. */
const AGREEMENT_ROTATIONS = 2;

/** The recorded agreement rows, newest source first, or the reason none could be read. Never throws: a ledger that
 *  cannot be read is an empty record, and an empty record audits every proof. */
export async function readProofReuseAgreement(
  ledgerDir: string, step: string,
  read: (dir: string, opts: { step: string; maxRotations: number; keep: (line: string) => boolean }) => Promise<{ rawLines: string[] }>,
): Promise<{ rows: ProofReuseAgreementRow[]; unreadable?: string }> {
  try {
    const { rawLines } = await read(ledgerDir, { step, maxRotations: AGREEMENT_ROTATIONS, keep: line => line.includes(`"eligible":true`) });
    const rows: ProofReuseAgreementRow[] = [];
    for (const line of rawLines) {
      try {
        const parsed = JSON.parse(line) as ProofReuseAgreementRow & { step?: unknown };
        if (parsed.step === step) rows.push(parsed);
      } catch {
        // deliberate: a torn line is unreadable and counts as no row at all (a lost agreement widens the audit; a
        // lost disagreement is the one case this cannot see, and the next readable one restores the full audit)
      }
    }
    return { rows };
  } catch (error) {
    return { rows: [], unreadable: String((error as Error)?.message ?? error).slice(0, 200) };
  }
}
