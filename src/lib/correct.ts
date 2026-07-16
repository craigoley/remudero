import { appendLedger } from "./ledger.js";
import { deriveStatus, type DeriveDeps, type StatusProjection } from "./status.js";
import type { Task } from "./plan.js";

/** The before/after flip `rmd correct` reports, plus whether anything was written. */
export interface CorrectionResult {
  before: StatusProjection;
  after: StatusProjection;
  /** false when the named PR reference could not be resolved — nothing was appended. */
  written: boolean;
  prUrl?: string;
}

/**
 * The SANCTIONED correction writer's core (MASTER-PLAN P9 / W1-T75, the
 * W1-T20c/#134 stranding): `rmd correct <taskId> --pr <n>`'s implementation,
 * factored out of the CLI wrapper so it is unit-testable over injected deps
 * (same shape as {@link deriveStatus}'s `DeriveDeps`), the way fleet-control's
 * `requestStop`/`requestPause` back `rmd stop`/`rmd pause`.
 *
 * Resolves the task's derived status BEFORE the write (so `claimed_pr_url` is
 * whatever deriveStatus currently credits, or null if nothing does — never
 * guessed), resolves `prRef` via the injected gateway, and — only if it
 * resolves — appends ONE `correction.provenance` line in the EXACT shape
 * `deriveStatus`'s `latestActualPrUrl` already parses: `{claimed_pr_url,
 * actual_pr_url, by, reason}` (the #80→#91-era hand-written shape; never a
 * second dialect). `writeLedger` defaults to the real {@link appendLedger}
 * (an `appendFileSync` — append-only, no ledger rewrites); tests inject a
 * spy instead of touching disk twice.
 *
 * When the PR reference does not resolve, `written` is false and NOTHING is
 * appended — the operator sees this and no half-written correction lands.
 */
export function applyCorrection(
  task: Task,
  prRef: string,
  deps: DeriveDeps,
  opts: { reason?: string; by?: string; writeLedger?: typeof appendLedger } = {},
): CorrectionResult {
  const writeLedger = opts.writeLedger ?? appendLedger;
  const before = deriveStatus(task, deps);

  const pr = deps.github.prByRef(prRef);
  if (!pr) {
    return { before, after: before, written: false };
  }

  writeLedger(deps.ledgerPath, {
    run_id: `CORRECT-${Date.now()}`,
    task_id: task.id,
    step: "correction.provenance",
    claimed_pr_url: before.prUrl ?? null,
    actual_pr_url: pr.url,
    by: opts.by ?? "operator",
    reason: opts.reason ?? null,
  });

  const after = deriveStatus(task, deps);
  return { before, after, written: true, prUrl: pr.url };
}
