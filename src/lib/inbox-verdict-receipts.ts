/**
 * An operator's decline outlives the live ledger's carry cap.
 *
 * MEASURED 2026-10-17 on the fleet host. `verify-human:W3-T7` was declined at 2026-10-13T02:56:30Z
 * (`panel.proposal_declined`, origin rmd-cli, "operator-approved inbox clear ... reversible with rmd restore").
 * By 10-14 the row was gone from the live `state/ledger.ndjson`. It survived only in the archive
 * `ledger.2026-10-13T03-41-58-104Z.ndjson.gz`. The live file held exactly 200 `panel.proposal_declined` rows, the
 * rotation's per-step cap (ledger.ts MAX_RETAINED_LINES_PER_STEP), and 193 of them were fleet-lane folds from the
 * previous three days. Every inbox classifier read its verdicts with `ledgerProposalVerdicts` over the live file
 * alone, so the proposal classified `ready` again. The inbox responder asked about it on its thread at
 * 2026-10-14T01:54:18Z, and it came back under "Needs your decision".
 *
 * Registering the step as retained (W1-T2604) was never enough, because retention keeps only the newest N rows of
 * a step. So the slow lane reads the decline and restore receipts from the archive union, which it already does
 * for verify-human releases, and keeps the receipts of every proposal still in the registry in
 * `state/inbox-verdict-receipts.json`. Every classifier, including the decline and restore routes and the
 * `rmd decline` and `rmd restore` commands, reads that file with the live rows. The newest receipt by time wins,
 * so `rmd restore` reverses an archived decline exactly as it reverses a live one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fs-race-safe.js";
import { ledgerProposalVerdicts } from "./inbox.js";

/** The two steps whose latest row per proposal decides "declined": both halves, or the answer inverts. */
export const PROPOSAL_VERDICT_RECEIPT_STEPS: readonly string[] = ["panel.proposal_declined", "panel.proposal_restored"];
const RECEIPT_STEPS: ReadonlySet<string> = new Set(PROPOSAL_VERDICT_RECEIPT_STEPS);

/** One decline or restore row, cut to what the verdict and its dedup read. */
export interface VerdictReceipt {
  step: string;
  task_id: string;
  ts: string;
  run_id?: string;
  reason?: string;
  /** W1-T10077: the verify-human observed-state key a decline was given on; absent on every earlier decline. */
  observed_state?: string;
}

export function inboxVerdictReceiptsPath(stateDir: string): string {
  return join(stateDir, "inbox-verdict-receipts.json");
}

/** A ledger row as a receipt, or undefined when it is not a decline or restore with a proposal id and a time. */
export function verdictReceiptOf(row: Record<string, unknown>): VerdictReceipt | undefined {
  if (typeof row.step !== "string" || !RECEIPT_STEPS.has(row.step)) return undefined;
  if (typeof row.task_id !== "string" || !row.task_id || typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts))) return undefined;
  return {
    step: row.step, task_id: row.task_id, ts: row.ts,
    ...(typeof row.run_id === "string" ? { run_id: row.run_id } : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    ...(typeof row.observed_state === "string" && row.observed_state ? { observed_state: row.observed_state } : {}),
  };
}

const receiptKey = (r: VerdictReceipt): string => JSON.stringify([r.ts, r.task_id, r.step, r.run_id ?? null]);

/**
 * Every receipt from both sources, duplicates dropped, in time order. A row the live file still carries is also in
 * an archive, and the carry cap counts declines and restores separately, so the live file can hold an older restore
 * while it has lost a newer decline. Only time order, never source order, gives the latest receipt.
 */
export function mergeVerdictReceipts(...sources: ReadonlyArray<Iterable<VerdictReceipt>>): VerdictReceipt[] {
  const byKey = new Map<string, VerdictReceipt>();
  for (const source of sources) for (const r of source) byKey.set(receiptKey(r), r);
  return [...byKey.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** {@link ledgerProposalVerdicts} over the live rows and the retained receipts: the live file's ratify rows, and the
 *  decline and restore receipts of both sources in time order. */
export function proposalVerdictsWithReceipts(live: ReadonlyArray<Record<string, unknown>>, retained: readonly VerdictReceipt[]) {
  if (retained.length === 0) return ledgerProposalVerdicts(live as Array<Record<string, unknown>>);
  const liveReceipts: VerdictReceipt[] = [];
  const others: Array<Record<string, unknown>> = [];
  for (const row of live) {
    const receipt = verdictReceiptOf(row);
    if (receipt) liveReceipts.push(receipt);
    else if (!RECEIPT_STEPS.has(row.step as string)) others.push(row);
  }
  return ledgerProposalVerdicts([...others, ...mergeVerdictReceipts(retained, liveReceipts)] as Array<Record<string, unknown>>);
}

/** The stored receipts; none when the file is absent or unreadable, which is the pre-store behaviour. */
export function readVerdictReceipts(stateDir: string): VerdictReceipt[] {
  try {
    const parsed = JSON.parse(readFileSync(inboxVerdictReceiptsPath(stateDir), "utf8")) as unknown;
    const rows = Array.isArray((parsed as { receipts?: unknown })?.receipts) ? (parsed as { receipts: unknown[] }).receipts : [];
    return rows.flatMap((row) => {
      const receipt = row !== null && typeof row === "object" ? verdictReceiptOf(row as Record<string, unknown>) : undefined;
      return receipt ? [receipt] : [];
    });
  } catch {
    // deliberate: no store yet, or a torn one, is "no retained receipts": classification reads the live rows only.
    return [];
  }
}

/**
 * Keep the receipts of the proposals still in the registry, newest last, and write them only when they changed.
 * A proposal that leaves the registry takes its receipts with it, so the store is bounded by the registry.
 * Returns whether the file was written.
 */
export function writeVerdictReceipts(stateDir: string, receipts: readonly VerdictReceipt[], liveIds: Iterable<string>): boolean {
  const ids = new Set(liveIds);
  const kept = mergeVerdictReceipts(receipts.filter((r) => ids.has(r.task_id)));
  const body = JSON.stringify({ version: 1, receipts: kept }) + "\n";
  try {
    if (readFileSync(inboxVerdictReceiptsPath(stateDir), "utf8") === body) return false;
  } catch {
    // deliberate: an absent store is written below.
  }
  writeAtomic(inboxVerdictReceiptsPath(stateDir), body);
  return true;
}

/** "Has an operator declined this, and why?" over the live rows and the stored receipts: the `isDeclined` every
 *  classifier outside the slow lane passes to `classifyProposal`. The store is read once, here. */
export function declinedWithReceipts(live: ReadonlyArray<Record<string, unknown>>, stateDir: string): (proposalId: string) => string | undefined {
  return proposalVerdictsWithReceipts(live, readVerdictReceipts(stateDir)).isDeclined;
}
