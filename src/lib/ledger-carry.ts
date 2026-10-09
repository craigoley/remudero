/**
 * WHAT A ROTATION CARRIES, DERIVED FROM THE READERS OF THE CARRIED ROWS (E6, 2026-10-02).
 *
 * MEASURED on the fleet host: the carried core rotateLedger wrote back was 3,817,087 bytes, 91% of
 * the 4 MiB ceiling, so each rotation left ~0.38 MB of room and the live file rotated every ~5 min
 * (243 archives on 10-01..10-02). Of that core, 699 KB of `sweep.disposed` belonged to 719 PRs
 * already merged (191 of 761 swept PRs carry a recorded merge fact), 137 KB was 200 `main.health.observed` rows and 93 KB was 200 `dep-review.decided`
 * rows (188 of them re-decisions of two PRs). Every pruned row was archived when it first arrived
 * (delta archiving), so a union reader still sees it; only the live file drops it.
 */

/** The rotation's parsed row, structurally — ledger.ts's own `ParsedLedgerLine` satisfies it. */
export interface CarriedRow {
  json?: Record<string, unknown>;
  step?: string;
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

/** W1-T5318: one row per closed PR, merged or not, written by the sweep from GitHub's own closed state. */
export const PR_TERMINAL_STEP = "pr.terminal";

/**
 * This prune drops a PR's sweep rows only on a RECORDED terminal fact (ledger.ts's boundSweepRows bounds the
 * rest by age, W1-T5517): `verdict.merged` (sweep credit backfill), a run's `verdict` row reading `merged`, or
 * a `pr.terminal` row (merged or closed, W1-T5318). A closed PR whose fact is absent keeps its rows here.
 */
function recordedMergeKey(row: Record<string, unknown>, step: string | undefined): string | undefined {
  if (step === "verdict.merged" || step === PR_TERMINAL_STEP || (step === "verdict" && row.verdict === "merged")) return sweepPrKey(row);
  return undefined;
}

/** A ledger row that records a PR MERGE: `verdict.merged`, a `verdict` row reading `merged`, or a sweep
 *  `pr.terminal` row reading `merged` — most merges are ledgered only as the last. */
export function isMergedLedgerRow(row: Record<string, unknown>): boolean {
  return row.step === "verdict.merged" || (row.step === "verdict" && row.verdict === "merged")
    || (row.step === PR_TERMINAL_STEP && row.state === "merged");
}

/**
 * A merged PR's rows that a live-file reader still asks for. `dueRepairFilings` counts acted
 * repair-surface rows of ANY PR inside its window (stale also dedups a re-close), and
 * `keepReversiblyClosedHeads` reads `keep_head_branch` off acted closes. Every other reader keys on
 * an open PR.
 */
const MERGED_KEPT_DISPOSITIONS: ReadonlySet<unknown> = new Set(["blocked-fixable", "blocked-ambiguous", "stale", "conflicted"]);

function keptAfterMerge(row: Record<string, unknown>): boolean {
  if (row.acted !== true) return false;
  return MERGED_KEPT_DISPOSITIONS.has(row.disposition) || typeof row.keep_head_branch === "string";
}

function sweepPrKey(row: Record<string, unknown>): string | undefined {
  return prUrlKey(row.pr_url);
}

/** `owner/repo#n` for a GitHub PR url, the identity every PR-keyed carry and terminal-row read shares. */
export function prUrlKey(prUrl: unknown): string | undefined {
  const match = typeof prUrl === "string" ? /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(prUrl) : null;
  return match ? `${match[1]}#${match[2]}` : undefined;
}

/**
 * The compact stand-in for a merged PR's plan-only `review.posted` row (E6b, 2026-10-03). Measured on the
 * fleet host's live file: review.posted was 947 KB of the 4.14 MB carried core, 89 of its 200 rows belonged
 * to PRs with a recorded merge, and 71 rows were plan-only reviews averaging 4.9 KB. The one live-file
 * reader that needs a MERGED PR's review is status.ts's plan-only credit refusal, and it reads only
 * `pr_url`, `head_sha` and `plan_only`; every other live reader keys on an open PR, and the history
 * readers (retro, calibration, analytics, field trials) read the archive union.
 */
export const PLAN_ONLY_REVIEW_MARKER_STEP = "review.plan_only_reviewed";

/** Rows the next live file need not carry: merged PRs' sweep and review rows, and superseded latest-only rows. */
export function pruneCarriedRows<T extends CarriedRow>(rows: readonly T[]): T[] {
  const merged = new Set<string>();
  // W1-T5759: a CLOSED terminal row covers only the PR's rows that precede it in file order, because a closed
  // PR can be reopened and the rows the sweep writes while it is open again are live. A merge cannot be undone.
  const closedAt = new Map<string, number>();
  const latestByKey = new Map<string, T>();
  for (const [index, row] of rows.entries()) {
    if (!row.json) continue;
    const mergeKey = recordedMergeKey(row.json, row.step);
    if (mergeKey && row.step === PR_TERMINAL_STEP && row.json.state !== "merged") closedAt.set(mergeKey, index);
    else if (mergeKey) merged.add(mergeKey);
    const keyOf = row.step === undefined ? undefined : LATEST_ROW_LEDGER_STEPS.get(row.step);
    // File order, not ts order: the readers take the LAST row in the file.
    if (keyOf) latestByKey.set(`${row.step}\u0000${keyOf(row.json)}`, row);
  }
  return rows.filter((row, index) => {
    if (!row.json || row.step === undefined) return true;
    const keyOf = LATEST_ROW_LEDGER_STEPS.get(row.step);
    if (keyOf) return latestByKey.get(`${row.step}\u0000${keyOf(row.json)}`) === row;
    if (row.step !== "sweep.disposed" && row.step !== "review.posted") return true;
    const key = sweepPrKey(row.json);
    if (key === undefined || !(merged.has(key) || index < (closedAt.get(key) ?? -1))) return true;
    return row.step === "sweep.disposed" && keptAfterMerge(row.json);
  });
}

/** One marker per (PR, head) whose plan-only review is in `rows` but not `carried`, unless a carried marker has it. */
export function planOnlyReviewMarkers<T extends CarriedRow>(rows: readonly T[], carried: readonly T[]): Array<Record<string, unknown>> {
  const kept = new Set(carried);
  const seen = new Set<string>();
  for (const row of carried) {
    if (row.step === PLAN_ONLY_REVIEW_MARKER_STEP && row.json) seen.add(`${String(row.json.pr_url)}\u0000${String(row.json.head_sha)}`);
  }
  const markers: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const json = row.json;
    if (kept.has(row) || row.step !== "review.posted" || json?.plan_only !== true) continue;
    if (typeof json.pr_url !== "string" || typeof json.head_sha !== "string") continue;
    const key = `${json.pr_url}\u0000${json.head_sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({ pr_url: json.pr_url, head_sha: json.head_sha, plan_only: true, review_task_id: json.task_id, reviewed_at: json.ts });
  }
  return markers;
}
