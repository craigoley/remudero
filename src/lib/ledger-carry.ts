/**
 * WHAT A ROTATION CARRIES, DERIVED FROM THE READERS OF THE CARRIED ROWS (E6, 2026-10-02).
 *
 * MEASURED on the fleet host: the carried core rotateLedger wrote back was 3,817,087 bytes, 91% of
 * the 4 MiB ceiling, so each rotation left ~0.38 MB of room and the live file rotated every ~5 min
 * (243 archives on 10-01..10-02). Of that core, 699 KB of `sweep.disposed` belonged to 719 PRs
 * already merged, 137 KB was 200 `main.health.observed` rows and 93 KB was 200 `dep-review.decided`
 * rows (188 of them re-decisions of two PRs). Every pruned row was archived when it first arrived
 * (delta archiving), so a union reader still sees it; only the live file drops it.
 */

/** The rotation's parsed row, structurally — ledger.ts's own `ParsedLedgerLine` satisfies it. */
export interface CarriedRow {
  json?: Record<string, unknown>;
  step?: string;
  tsMs?: number;
}

/**
 * Steps whose every reader takes only the NEWEST row for a key, so older rows for that key are
 * never read from the live file. `main.health.observed`: sweep.ts `mainLatestRunFromLedger` keeps
 * the last row over the whole file. `dep-review.decided`: the sweep's `depReview` seam reads
 * `.at(-1)` for its `dep-review-PR<n>` task.
 */
export const LATEST_ROW_LEDGER_STEPS: ReadonlyMap<string, (row: Record<string, unknown>) => string> = new Map([
  ["main.health.observed", () => ""],
  ["dep-review.decided", (row: Record<string, unknown>) => String(row.task_id)],
]);

/**
 * How far a PR's newest `sweep.disposed` row may trail the newest one in the file before the PR
 * counts as departed (merged or closed). Every sweep pass writes one row per open PR, so an open PR
 * trails by at most one pass; per-PR row spacing measured p90 47 min (B1 notes, 10-02). The anchor
 * is the newest sweep row, never the clock, so a stalled sweep ages nothing out.
 */
export const SWEEP_DEPARTED_PR_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * A departed PR's rows that a live-file reader still asks for. `dueRepairFilings` counts acted
 * repair-surface rows of ANY PR inside its window (stale also dedups a re-close), and
 * `keepReversiblyClosedHeads` reads `keep_head_branch` off acted closes. Every other reader keys on
 * an open PR.
 */
const DEPARTED_KEPT_DISPOSITIONS: ReadonlySet<unknown> = new Set(["blocked-fixable", "blocked-ambiguous", "stale", "conflicted"]);

function keptAfterDeparture(row: Record<string, unknown>): boolean {
  if (row.acted !== true) return false;
  return DEPARTED_KEPT_DISPOSITIONS.has(row.disposition) || typeof row.keep_head_branch === "string";
}

function sweepPrKey(row: Record<string, unknown>): { repo: string; key: string } | undefined {
  if (typeof row.pr_number !== "number") return undefined;
  const repo = typeof row.pr_url === "string" ? (/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(row.pr_url)?.[1] ?? "") : "";
  return { repo, key: `${repo}#${row.pr_number}` };
}

/** Rows the next live file need not carry: departed PRs' sweep rows and superseded latest-only rows. */
export function pruneCarriedRows<T extends CarriedRow>(rows: readonly T[]): T[] {
  const prNewest = new Map<string, number>();
  const repoNewest = new Map<string, number>();
  const latestByKey = new Map<string, T>();
  for (const row of rows) {
    if (!row.json || row.tsMs === undefined) continue;
    const pr = row.step === "sweep.disposed" ? sweepPrKey(row.json) : undefined;
    if (pr) {
      prNewest.set(pr.key, Math.max(prNewest.get(pr.key) ?? row.tsMs, row.tsMs));
      repoNewest.set(pr.repo, Math.max(repoNewest.get(pr.repo) ?? row.tsMs, row.tsMs));
    }
    const keyOf = row.step === undefined ? undefined : LATEST_ROW_LEDGER_STEPS.get(row.step);
    // File order, not ts order: the readers take the LAST row in the file.
    if (keyOf) latestByKey.set(`${row.step}\u0000${keyOf(row.json)}`, row);
  }
  return rows.filter((row) => {
    if (!row.json || row.step === undefined) return true;
    const keyOf = LATEST_ROW_LEDGER_STEPS.get(row.step);
    if (keyOf) return latestByKey.get(`${row.step}\u0000${keyOf(row.json)}`) === row;
    if (row.step !== "sweep.disposed" || row.tsMs === undefined) return true;
    const pr = sweepPrKey(row.json);
    if (!pr) return true;
    const departed = prNewest.get(pr.key)! < repoNewest.get(pr.repo)! - SWEEP_DEPARTED_PR_WINDOW_MS;
    return !departed || keptAfterDeparture(row.json);
  });
}
