import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { qualifyReservedSkillEval, type ReservedEvalGrant, type ReservedEvalQualificationInput } from "./skill-eval-reservation.js";

/** Operator-owned schema contract. This consumer cannot mint approvals or create a store.
 * SHIPS-UNWIRED: the canonical, private store/backend and actual consumer require qualification.
 */
export const RESERVED_EVAL_GRANT_TABLE_SQL = `CREATE TABLE reserved_eval_grants (
 id TEXT PRIMARY KEY, grant_json TEXT NOT NULL, approval_ref TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('fresh','consumed','revoked')),
 consumed_at_ms INTEGER, run_id TEXT UNIQUE)`;
export type ReservedEvalConsumption = { dispatchAllowed: false; state: "inert" | "refused" | "unavailable" | "consumed";
 reason: string; grantId?: string; runId?: string; grantSha256?: string; finishByMs?: number;
 errorKind?: "invalid-canonical-json" | "native-error" | "non-error"; errorCode?: string; sqliteCode?: number };

/** Preserve actionable native cause without echoing private grant/SQL/error-message contents. */
function grantFailureDiagnostic(error: unknown): Partial<ReservedEvalConsumption> {
 const native = error && typeof error === "object" ? error as {code?: unknown; errcode?: unknown} : {};
 return { errorKind: error instanceof SyntaxError ? "invalid-canonical-json" : error instanceof Error ? "native-error" : "non-error",
  ...(native.code === "ERR_SQLITE_ERROR" || native.code === "ERR_INVALID_STATE" ? {errorCode: native.code} : {}),
  ...(typeof native.errcode === "number" && Number.isSafeInteger(native.errcode) && native.errcode >= 0 ? {sqliteCode: native.errcode} : {}) };
}

/** Atomically consume the CANONICAL grant, not a caller-supplied fresh assertion.
 * A committed use stays consumed even if launch subsequently fails or the process dies.
 * This does not launch work, take capacity, reset READY, release a lease or authorize a pilot.
 */
export function consumeReservedEvalGrant(opts: { enabled?: boolean; grantId: string; runId: string;
 input: ReservedEvalQualificationInput; db: DatabaseSync }): ReservedEvalConsumption {
 const result = (state: ReservedEvalConsumption["state"], reason: string,
  fields: Partial<ReservedEvalConsumption> = {}): ReservedEvalConsumption => ({ dispatchAllowed: false, state, reason, ...fields });
 if (opts.enabled !== true) return result("inert", "grant-consumption-disabled");
 if (!/^[A-Za-z0-9_.:-]{1,512}$/.test(opts.grantId) || !/^[A-Za-z0-9_.:-]{1,512}$/.test(opts.runId))
  return result("refused", "invalid-grant-or-run-identity");
 let transaction = false;
 let outcome: ReservedEvalConsumption;
 try {
  outcome = (() => {
  opts.db.exec("BEGIN IMMEDIATE");transaction = true;
  const row = opts.db.prepare("SELECT grant_json, approval_ref, state FROM reserved_eval_grants WHERE id = ?").get(opts.grantId);
  if (!row || row.state !== "fresh" || typeof row.approval_ref !== "string" || !row.approval_ref.trim() || row.approval_ref.length > 512 ||
      typeof row.grant_json !== "string" || Buffer.byteLength(row.grant_json) > 8192) {
   return result("refused", "canonical-fresh-approved-grant-unavailable");
  }
  const grant = JSON.parse(row.grant_json) as ReservedEvalGrant;
  if (grant.id !== opts.grantId || grant.state !== "fresh") return result("refused", "canonical-grant-identity-mismatch");
  const decision = qualifyReservedSkillEval({ ...opts.input, grant });
  if (decision.state !== "qualified") return result("refused", decision.reason);
  const changed = opts.db.prepare("UPDATE reserved_eval_grants SET state = 'consumed', consumed_at_ms = ?, run_id = ? WHERE id = ? AND state = 'fresh' AND grant_json = ?")
   .run(opts.input.nowMs, opts.runId, opts.grantId, row.grant_json);
  if (changed.changes !== 1) return result("refused", "canonical-grant-consumption-contested");
  opts.db.exec("COMMIT");transaction = false;
  return result("consumed", "canonical-single-use-grant-committed", { grantId: grant.id, runId: opts.runId,
   grantSha256: createHash("sha256").update(row.grant_json).digest("hex"), finishByMs: grant.finishByMs });
  })();
 } catch (error) {
  outcome = { dispatchAllowed: false, state: "unavailable", reason: "canonical-grant-transaction-unavailable", ...grantFailureDiagnostic(error) };
 }
 if (transaction) {
  try { opts.db.exec("ROLLBACK"); }
  catch (error) { return { dispatchAllowed: false, state: "unavailable", reason: "canonical-grant-rollback-unavailable", ...grantFailureDiagnostic(error) }; }
 }
 return outcome;
}
