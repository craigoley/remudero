export const CI_REFRESH_GUARD_VERSION = "ordinary-refresh-pending-v1";
const STEP = "sweep.update_branch.pending_guard";
const REASONS = new Set(["distance", "distance-unknown", "distance-overlap", "distance-baseline",
  "distance-ceiling", "armed-stalled", "ready-overlap", "ready-baseline"]);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

/** Actual selector deferrals from retained snapshots; no estimate of saved runs, time or cash. */
export function observeCiRefreshDeferrals(rows: readonly Record<string, unknown>[], asOf: string, windowStart: string) {
  const now = Date.parse(asOf), start = Date.parse(windowStart);
  if (!Number.isFinite(now) || !Number.isFinite(start) || start > now || rows.length > 100_000)
    throw new Error("invalid bounded CI refresh observation");
  let invalidRows = 0, duplicateRows = 0, repeatedHeadObservations = 0;
  const seen = new Set<string>(), heads = new Set<string>();
  for (const row of rows) {
    if (row.step !== STEP) continue;
    const time = Date.parse(String(row.ts)), snapshot = Date.parse(String(row.sweep_input_as_of));
    if (!Number.isFinite(time) || !Number.isFinite(snapshot) || snapshot > time || time > now) { invalidRows++; continue; }
    if (time < start) continue;
    const url = typeof row.pr_url === "string" && row.pr_url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/);
    if (!url || typeof row.pr_number !== "number" || !Number.isSafeInteger(row.pr_number) || row.pr_number !== Number(url[3]) || !sha(row.head_sha)
      || row.guard_version !== CI_REFRESH_GUARD_VERSION || row.outcome !== "guarded"
      || row.evidence !== "sweep-input-snapshot" || row.counterfactual_selected_without_pending_guard !== true
      || !REASONS.has(String(row.update_reason)) || typeof row.run_id !== "string" || !row.run_id || row.run_id.length > 2048
      || !(row.selected_refresh_head === null || sha(row.selected_refresh_head) && row.selected_refresh_head !== row.head_sha)) {
      invalidRows++; continue;
    }
    const key = JSON.stringify([row.pr_url, row.head_sha]);
    const identity = JSON.stringify([key, row.ts, row.run_id, row.update_reason, row.selected_refresh_head]);
    if (seen.has(identity)) { duplicateRows++; continue; }
    seen.add(identity);
    if (heads.has(key)) repeatedHeadObservations++;
    heads.add(key);
  }
  return { state: heads.size ? invalidRows ? "observed-partial" : "observed" : "unavailable", windowStart, asOf,
    uniqueDeferredHeads: heads.size || null, duplicateRows, repeatedHeadObservations, invalidRows,
    historyCompleteness: "uncertified", liveCiState: "not-proven-by-input-snapshot",
    savedCiRuns: null, savedCpuSeconds: null, savedCashUsd: null, efficacyClaim: "none" };
}
