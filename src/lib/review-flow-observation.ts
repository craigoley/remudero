import { fixedClock } from "./clock.js";

export const REVIEW_FLOW_STEPS = ["sweep.review_eligible", "sweep.review_admitted", "sweep.post_review.attempt", "review.posted"] as const;
type Stage = "eligible" | "admitted" | "attempted" | "posted";
const stages: Record<string, Stage> = Object.fromEntries(REVIEW_FLOW_STEPS.map((step, i) => [step, ["eligible", "admitted", "attempted", "posted"][i]])) as Record<string, Stage>;
type Row = Record<string, unknown>;
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2048;

/** Observed exact-input delivery, not queue truth. Readable rotations do not certify retention:
 * missing posts remain source gaps, never actionable waiting or a latency SLO over all PRs. */
export function observeReviewFlow(rows: readonly Row[], asOf: string, windowStart: string) {
  const now = Date.parse(asOf), start = Date.parse(windowStart);
  if (!Number.isFinite(now) || !Number.isFinite(start) || start > now || rows.length > 100_000) throw new Error("invalid bounded review observation");
  const diagnostics = { duplicates: 0, missingIdentity: 0, invalidTimestamp: 0, nonterminalPosts: 0, orphanInputs: 0 };
  const groups = new Map<string, { prUrl: string; headSha: string; inputDigest: string; eligible: number[];
    admitted: number[]; attempted: number[]; posted: Array<{ ts: number; state: string; reviewerOutcome: string | null }> }>();
  const seen = new Set<string>();
  for (const row of rows) {
    const stage = stages[String(row.step)];
    if (!stage) continue;
    if (![row.pr_url, row.head_sha, row.review_input_digest].every(identity)) { diagnostics.missingIdentity++; continue; }
    const ts = Date.parse(String(row.ts));
    if (!Number.isFinite(ts) || ts > now) { diagnostics.invalidTimestamp++; continue; }
    if (stage === "posted" && row.state !== "success" && row.state !== "failure") { diagnostics.nonterminalPosts++; continue; }
    const key = JSON.stringify([row.pr_url, row.head_sha, row.review_input_digest]);
    const event = JSON.stringify([key, stage, row.ts, row.run_id, row.state]);
    if (seen.has(event)) { diagnostics.duplicates++; continue; }
    seen.add(event);
    let group = groups.get(key);
    if (!group) {
      group = { prUrl: row.pr_url as string, headSha: row.head_sha as string, inputDigest: row.review_input_digest as string,
        eligible: [], admitted: [], attempted: [], posted: [] };
      groups.set(key, group);
    }
    if (stage === "posted") group.posted.push({ ts, state: row.state as string,
      reviewerOutcome: identity(row.reviewer_outcome) ? row.reviewer_outcome : null });
    else group[stage].push(ts);
  }
  const eventsByPr = new Map<string, Array<{ key: string; ts: number; nextDifferent?: number }>>();
  for (const [key, group] of groups) {
    const events = eventsByPr.get(group.prUrl) ?? [];
    events.push(...group.eligible.map(ts => ({ key, ts })));
    eventsByPr.set(group.prUrl, events);
  }
  for (const events of eventsByPr.values()) {
    events.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
    for (let i = events.length - 1; i >= 0; i--) events[i].nextDifferent = events[i + 1]?.key === events[i].key
      ? events[i + 1].nextDifferent : i + 1;
  }
  const cohorts = [];
  for (const [key, group] of groups) {
    if (!group.eligible.length) { diagnostics.orphanInputs++; continue; }
    const eligible = group.eligible.reduce((a, b) => Math.min(a, b), Infinity);
    if (eligible < start) continue;
    const first = (values: number[], after: number) => values.filter(ts => ts >= after).sort((a, b) => a - b)[0];
    const admitted = first(group.admitted, eligible), attempted = first(group.attempted, admitted ?? eligible);
    const posted = group.posted.filter(row => row.ts >= (attempted ?? admitted ?? eligible)).sort((a, b) => a.ts - b.ts)[0];
    // A different exact input must be observed for supersession; repeated eligibility is not it.
    const events = eventsByPr.get(group.prUrl)!;
    let low = 0, high = events.length;
    while (low < high) { const mid = (low + high) >>> 1; if (events[mid].ts <= eligible) low = mid + 1; else high = mid; }
    if (events[low]?.key === key) low = events[low].nextDifferent!;
    const later = events[low]?.ts;
    const superseded = later !== undefined && (posted === undefined || later < posted.ts);
    cohorts.push({ prUrl: group.prUrl, headSha: group.headSha, inputDigest: group.inputDigest,
      status: superseded ? posted ? "delivered-after-supersession" : "superseded" : posted ? "delivered" : "unresolved-source-gap",
      eligibleAt: fixedClock(eligible).iso(), admittedAt: admitted === undefined ? null : fixedClock(admitted).iso(),
      attemptedAt: attempted === undefined ? null : fixedClock(attempted).iso(), postedAt: posted ? fixedClock(posted.ts).iso() : null,
      deliveryState: posted?.state ?? null, reviewerOutcome: posted?.reviewerOutcome ?? null,
      eligibilityToAdmissionMs: admitted === undefined ? null : admitted - eligible,
      attemptToPostMs: attempted === undefined || posted === undefined ? null : posted.ts - attempted,
      eligibilityToPostMs: posted === undefined ? null : posted.ts - eligible,
      missingStages: [admitted === undefined ? "admitted" : null, attempted === undefined ? "attempted" : null,
        posted === undefined ? "posted" : null].filter(value => value !== null) });
  }
  cohorts.sort((a, b) => a.eligibleAt.localeCompare(b.eligibleAt) || a.prUrl.localeCompare(b.prUrl) || a.inputDigest.localeCompare(b.inputDigest));
  const delivered = cohorts.filter(row => row.status === "delivered");
  const times = delivered.map(row => row.eligibilityToPostMs!).sort((a, b) => a - b);
  const quantile = (q: number) => times.length ? times[Math.ceil(q * times.length) - 1] : null;
  return { version: "review-flow-observation-v1", asOf, windowStart, sourceComplete: false,
    timingBasis: "first-observed-exact-input-eligibility", retention: "uncertified",
    diagnostics, counts: { delivered: delivered.length, superseded: cohorts.filter(row => row.status === "superseded").length,
      deliveredAfterSupersession: cohorts.filter(row => row.status === "delivered-after-supersession").length,
      unresolvedSourceGap: cohorts.filter(row => row.status === "unresolved-source-gap").length },
    completedOnly: { n: times.length, medianMs: quantile(0.5), p95Ms: quantile(0.95) },
    semantic: { succeeded: delivered.filter(row => row.reviewerOutcome === "success").length,
      notAttempted: delivered.filter(row => row.reviewerOutcome === "not_attempted").length,
      failed: delivered.filter(row => row.reviewerOutcome !== null && row.reviewerOutcome !== "success" && row.reviewerOutcome !== "not_attempted").length,
      unknown: delivered.filter(row => row.reviewerOutcome === null).length },
    cohorts: cohorts.slice(-200), omittedCohorts: Math.max(0, cohorts.length - 200) };
}
