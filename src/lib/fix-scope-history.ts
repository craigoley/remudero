import { dirname } from "node:path";
import { stat } from "node:fs/promises";
import { readLedgerUnionRawLinesAsync } from "./ledger-union.js";

/** Scope authority survives rotation; an unread history cannot supply a grant. */
export async function readFixScopeHistory(ledgerPath: string, prNumber: number): Promise<Record<string, unknown>[]> {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error("invalid scope authority PR");
  const key = `PR-${prNumber}`;
  const history = await readLedgerUnionRawLinesAsync(dirname(ledgerPath), {
    refuseIncomplete: true,
    dedupe: true,
    keep: line => line.includes(key) &&
      (line.includes('"fix.scope_amendment"') || line.includes('"panel.question_answered"')),
  });
  if (!history.ok || history.unclassified.length > 0) {
    if (history.filesRead === 0 && history.archiveCount === 0 && !history.liveFileRead &&
        history.unclassified.length === 0 && history.unread.length === 1 && history.unread[0] === dirname(ledgerPath)) {
      try { await stat(dirname(ledgerPath)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; // Absent authority grants no extra paths.
      }
    }
    throw new Error("scope authority history is incomplete");
  }
  return history.rawLines.flatMap(line => {
    const row: unknown = JSON.parse(line);
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("malformed scope authority row");
    const value = row as Record<string, unknown>;
    return value.task_id === key &&
      (value.step === "fix.scope_amendment" || value.step === "panel.question_answered") ? [value] : [];
  });
}
