import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";

export const OPPORTUNITY_EVIDENCE_FILE = "opportunity-outcomes.json";
/** PRIMARY CONTROL: one saved registry, never an archive scan or network read. */
export const OPPORTUNITY_EVIDENCE_MAX_BYTES = 512 * 1024;
/** BACKSTOP: refuse larger registries rather than certify a truncated population. */
export const OPPORTUNITY_EVIDENCE_MAX_ROWS = 512;
export const OPPORTUNITY_STATES = ["pending", "filed", "merged", "deployed", "measured-helped", "measured-hurt", "expired", "unavailable"] as const;
export type OpportunityState = typeof OPPORTUNITY_STATES[number];
export type OpportunityEvidenceReason = "scope_unavailable" | "not_collected" | "unreadable" | "malformed" | "oversized" | "repository_mismatch" | "clock_skew" | "corpus_changed";
type OpportunityEvidenceIdentity = { version: 1; repository: string | null; readAt: string; coverage: "saved-opportunity-registry"; countSemantics: "reported_states_not_verified_outcomes" };
export interface SavedImprovementEffect {
  version: "improvement-effect-v1";
  verification: "reported-producer-assessment";
  repository: string; opportunityId: string; threadId: string; baselineSnapshotId: string;
  taskIds: string[]; planPrUrl: string | null; expectedEffect: string;
  stage: "conversation_saved" | "plan_pr_opened" | "tasks_filed" | "merged" | "measured";
  verdict: "helped" | "hurt" | "unchanged" | "insufficient_evidence";
  reason: string; evaluatedAt: string; measuredAt: string | null;
  freshness: "fresh" | "stale" | "not_collected";
  observed: { before: number; after: number; denominator: number } | null;
  observationWindow: { before: string; after: string } | null;
  afterSnapshotId: string | null; analyzedSha: string | null; mergePrUrls: string[];
  causalClaim: false;
}
export type GardenerOpportunityEvidence = OpportunityEvidenceIdentity & (
  | { state: "unavailable"; reason: OpportunityEvidenceReason }
  | { state: "reported"; total: number; counts: Record<OpportunityState, number>; oldestReconciledAt: string | null; latestReconciledAt: string | null; improvementEffects: SavedImprovementEffect[] }
);
const isOpportunityRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isOpportunityText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
const isOpportunityStamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isOpportunityRepository = (v: unknown): v is string => typeof v === "string" && v.length <= 257 &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) && !v.split("/").some((part) => part === "." || part === "..");
const opportunityEvidenceIdentity = (repository: string | null, clock: Clock): OpportunityEvidenceIdentity => ({ version: 1, repository, readAt: clock.iso(),
  coverage: "saved-opportunity-registry", countSemantics: "reported_states_not_verified_outcomes" });
export const unavailableOpportunityEvidence = (repository: string | null, clock: Clock, reason: OpportunityEvidenceReason): GardenerOpportunityEvidence =>
  ({ ...opportunityEvidenceIdentity(repository, clock), state: "unavailable", reason });

const effectDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const effectSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
function effectPrUrl(value: unknown, repository: string): value is string {
  const prefix = `https://github.com/${repository}/pull/`;
  return typeof value === "string" && value.startsWith(prefix) && /^[1-9][0-9]*$/.test(value.slice(prefix.length));
}
/** Allowlist a producer's saved assessment. It remains reported evidence; this reader does no
 * source, merge, or measurement verification, and its clock cannot refresh a saved result. */
function savedImprovementEffect(row: Record<string, unknown>, repository: string, clock: Clock): SavedImprovementEffect | null | false {
  if (row.improvement === undefined || row.effect === undefined) return null;
  if (!isOpportunityRecord(row.improvement) || !isOpportunityRecord(row.effect)) return false;
  const source = row.improvement, effect = row.effect, evidence = effect.evidence;
  if (source.repository !== repository.toLowerCase() || !isOpportunityText(source.opportunityId) || !source.opportunityId.startsWith(`${repository.toLowerCase()}/codeql-quality:`) ||
      typeof source.threadId !== "string" || !/^thread:[A-Za-z0-9:._/-]{1,500}$/.test(source.threadId) || !effectDigest(source.snapshotId) ||
      !Array.isArray(source.taskIds) || source.taskIds.length > 64 || source.taskIds.some(id => typeof id !== "string" || !/^[A-Z][A-Z0-9]*-T[0-9]+[A-Za-z]?$/.test(id)) ||
      new Set(source.taskIds).size !== source.taskIds.length || !(source.planPrUrl === null || effectPrUrl(source.planPrUrl, repository.toLowerCase())) ||
      !isOpportunityText(source.expectedEffect) || effect.expectedEffect !== source.expectedEffect || effect.version !== "improvement-effect-v1" || effect.causalClaim !== false ||
      typeof effect.stage !== "string" || !["conversation_saved", "plan_pr_opened", "tasks_filed", "merged", "measured"].includes(effect.stage) ||
      typeof effect.verdict !== "string" || !["helped", "hurt", "unchanged", "insufficient_evidence"].includes(effect.verdict) ||
      !isOpportunityText(effect.reason) || !isOpportunityStamp(effect.evaluatedAt) || Date.parse(effect.evaluatedAt) > clock.now() + 60_000 ||
      !isOpportunityRecord(evidence) || evidence.baselineSnapshotId !== source.snapshotId ||
      !(evidence.afterSnapshotId === null || effectDigest(evidence.afterSnapshotId)) || !(evidence.analyzedSha === null || effectSha(evidence.analyzedSha)) ||
      !Array.isArray(evidence.mergePrUrls) || evidence.mergePrUrls.length > 64 || evidence.mergePrUrls.some(url => !effectPrUrl(url, repository.toLowerCase()))) return false;
  const measured = effect.stage === "measured", observed = effect.observed, window = effect.observationWindow;
  if (measured !== (effect.verdict !== "insufficient_evidence")) return false;
  if (measured) {
    if (source.sourceVerified !== true || !isOpportunityStamp(effect.measuredAt) || Date.parse(effect.measuredAt) > Date.parse(effect.evaluatedAt) || !effectDigest(evidence.afterSnapshotId) || !effectSha(evidence.analyzedSha) ||
        !isOpportunityRecord(observed) || ![observed.before, observed.after, observed.denominator].every(n => Number.isSafeInteger(n) && Number(n) >= 0) ||
        Number(observed.denominator) <= 0 || observed.before !== observed.denominator ||
        effect.verdict !== (Number(observed.after) < Number(observed.before) ? "helped" : Number(observed.after) > Number(observed.before) ? "hurt" : "unchanged") ||
        !isOpportunityRecord(window) || !isOpportunityStamp(window.before) || !isOpportunityStamp(window.after) || Date.parse(window.before) >= Date.parse(window.after) || window.after !== effect.measuredAt) return false;
  } else if (effect.measuredAt !== null || observed !== null || window !== null) return false;
  return { version: "improvement-effect-v1", verification: "reported-producer-assessment", repository: repository.toLowerCase(), opportunityId: source.opportunityId,
    threadId: source.threadId, baselineSnapshotId: source.snapshotId, taskIds: [...source.taskIds] as string[], planPrUrl: source.planPrUrl as string | null,
    expectedEffect: source.expectedEffect, stage: effect.stage as SavedImprovementEffect["stage"], verdict: effect.verdict as SavedImprovementEffect["verdict"], reason: effect.reason,
    evaluatedAt: effect.evaluatedAt, measuredAt: effect.measuredAt as string | null,
    freshness: effect.measuredAt === null ? "not_collected" : clock.now() - Date.parse(effect.measuredAt as string) > 86_400_000 ? "stale" : "fresh",
    observed: observed as SavedImprovementEffect["observed"], observationWindow: window as SavedImprovementEffect["observationWindow"],
    afterSnapshotId: evidence.afterSnapshotId as string | null, analyzedSha: evidence.analyzedSha as string | null, mergePrUrls: [...evidence.mergePrUrls] as string[], causalClaim: false };
}

/** Whitelist only stored classifications. This read does not verify PRs, deployments, or causal
 * measurements and must not turn a producer's classification into a newly verified benefit. */
export function projectGardenerOpportunityEvidence(raw: unknown, repository: string, clock: Clock = systemClock): GardenerOpportunityEvidence {
  if (!isOpportunityRepository(repository)) return unavailableOpportunityEvidence(null, clock, "scope_unavailable");
  if (!Array.isArray(raw)) return unavailableOpportunityEvidence(repository, clock, "malformed");
  if (raw.length > OPPORTUNITY_EVIDENCE_MAX_ROWS) return unavailableOpportunityEvidence(repository, clock, "oversized");
  const counts = Object.fromEntries(OPPORTUNITY_STATES.map((state) => [state, 0])) as Record<OpportunityState, number>;
  const keys = new Set<string>();
  const improvementEffects: SavedImprovementEffect[] = [];
  let oldestReconciledAt: string | null = null, latestReconciledAt: string | null = null;
  for (const row of raw) {
    if (!isOpportunityRecord(row) || !isOpportunityRecord(row.candidate) || !isOpportunityRepository(row.candidate.repo) || !isOpportunityText(row.candidate.key) ||
        !isOpportunityText(row.key) || row.key !== `${row.candidate.repo}/${row.candidate.key}` ||
        !isOpportunityText(row.proposalId) || !Array.isArray(row.sourceIds) || row.sourceIds.length > 64 || row.sourceIds.some((id) => !isOpportunityText(id)) ||
        !isOpportunityStamp(row.at) || !isOpportunityStamp(row.candidate.observedAt) || typeof row.state !== "string" || !OPPORTUNITY_STATES.includes(row.state as OpportunityState)) {
      return unavailableOpportunityEvidence(repository, clock, "malformed");
    }
    if (row.candidate.repo.toLowerCase() !== repository.toLowerCase()) return unavailableOpportunityEvidence(repository, clock, "repository_mismatch");
    const key = `${repository.toLowerCase()}/${row.candidate.key}`;
    if (keys.has(key)) return unavailableOpportunityEvidence(repository, clock, "malformed");
    if (Date.parse(row.at) > clock.now() + 60_000 || Date.parse(row.candidate.observedAt) > Date.parse(row.at) + 60_000) return unavailableOpportunityEvidence(repository, clock, "clock_skew");
    const effect = savedImprovementEffect(row, repository, clock);
    if (effect === false) return unavailableOpportunityEvidence(repository, clock, "malformed");
    if (effect) improvementEffects.push(effect);
    keys.add(key);
    counts[row.state as OpportunityState]++;
    if (oldestReconciledAt === null || Date.parse(row.at) < Date.parse(oldestReconciledAt)) oldestReconciledAt = row.at;
    if (latestReconciledAt === null || Date.parse(row.at) > Date.parse(latestReconciledAt)) latestReconciledAt = row.at;
  }
  // An empty saved array has no producer timestamp. Its read time cannot establish freshness.
  return { ...opportunityEvidenceIdentity(repository, clock), state: "reported", total: raw.length, counts, oldestReconciledAt, latestReconciledAt, improvementEffects };
}

/** A single descriptor, finite bytes, and stable metadata. Missing/corrupt data is never zero. */
export async function readGardenerOpportunityEvidence(stateDir: string, repository?: string, clock: Clock = systemClock, openFile: typeof open = open): Promise<GardenerOpportunityEvidence> {
  if (!isOpportunityRepository(repository)) return unavailableOpportunityEvidence(null, clock, "scope_unavailable");
  try {
    // Refuse FIFOs after opening without waiting indefinitely for an external writer.
    const handle = await openFile(join(stateDir, OPPORTUNITY_EVIDENCE_FILE), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile()) return unavailableOpportunityEvidence(repository, clock, "unreadable");
      if (before.size > OPPORTUNITY_EVIDENCE_MAX_BYTES) return unavailableOpportunityEvidence(repository, clock, "oversized");
      const bytes = Buffer.alloc(OPPORTUNITY_EVIDENCE_MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const chunk = await handle.read(bytes, size, bytes.length - size, size);
        if (chunk.bytesRead === 0) break;
        size += chunk.bytesRead;
      }
      if (size > OPPORTUNITY_EVIDENCE_MAX_BYTES) return unavailableOpportunityEvidence(repository, clock, "oversized");
      const after = await handle.stat();
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        return unavailableOpportunityEvidence(repository, clock, "corpus_changed");
      }
      try { return projectGardenerOpportunityEvidence(JSON.parse(bytes.subarray(0, size).toString("utf8")), repository, clock); }
      catch (error) {
        if (error instanceof SyntaxError) return unavailableOpportunityEvidence(repository, clock, "malformed");
        throw error;
      }
    } finally { await handle.close(); }
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "not_collected" : "unreadable";
    return unavailableOpportunityEvidence(repository, clock, reason);
  }
}


export interface CodeHealthImprovementFollowUp {
  state: "reported" | "partial" | "unavailable" | "not_collected";
  expectedScopes: number; observedScopes: number; totalKnown: number; moreAvailable: boolean;
  items: Array<{ instance: string; assessment: SavedImprovementEffect; currentEvidence: {
    state: "matches_latest_analysis" | "newer_analysis_available" | "collection_failed" | "collection_unavailable" | "analysis_behind_current_revision" | "older_measurement" | "not_measured" | "not_collected";
    reason: string;
  } }>;
  reason: string | null;
}
/** Fold one scoped registry at a time. Saved assessments stay reported, and a later read cannot
 * make an earlier observation current. The bounded list is a preview with an explicit known total. */
export function projectCodeHealthImprovementFollowUp(
  scopes: Iterable<{ instance: string; evidence: GardenerOpportunityEvidence }>, expectedScopes: number,
  current: { snapshotId: string | null; analyzedSha: string | null; currentSha: string | null; collectionFailed: boolean; collectionUnavailable?: boolean },
): CodeHealthImprovementFollowUp {
  // PRIMARY CONTROL: a 128-KiB preview within the existing 1-MiB Code health response.
  const maxBytes = 128 * 1024;
  const items: CodeHealthImprovementFollowUp["items"] = [];
  let observedScopes = 0, visited = 0, missing = 0, invalid = 0, totalKnown = 0, bytes = 0;
  for (const { instance, evidence } of scopes) {
    visited++;
    if (evidence.state !== "reported") { if (evidence.reason === "not_collected") missing++; else invalid++; continue; }
    observedScopes++;
    for (const assessment of evidence.improvementEffects) {
      totalKnown++;
      const status: CodeHealthImprovementFollowUp["items"][number]["currentEvidence"] = current.collectionUnavailable
        ? { state: "collection_unavailable", reason: "The latest code-check status could not be verified. This saved result has not been rechecked." }
        : current.collectionFailed
        ? { state: "collection_failed", reason: "The latest code check could not be completed. This is an earlier reported result." }
        : current.snapshotId === null || current.analyzedSha === null || current.currentSha === null
          ? { state: "not_collected", reason: "The latest code-check evidence is unavailable. This saved result has not been rechecked." }
          : assessment.stage !== "measured" ? { state: "not_measured", reason: "A comparable follow-up measurement is still needed." }
            : current.analyzedSha !== current.currentSha ? { state: "analysis_behind_current_revision", reason: "The latest analysis does not cover the current code revision." }
              : assessment.freshness !== "fresh" ? { state: "older_measurement", reason: "This measurement is older than the daily check window." }
                : assessment.afterSnapshotId !== current.snapshotId || assessment.analyzedSha !== current.analyzedSha
                  ? { state: "newer_analysis_available", reason: "Newer code-check evidence is available. This earlier result needs another follow-up." }
                  : { state: "matches_latest_analysis", reason: "This reported result names the latest saved analysis. It does not establish that the change caused the result." };
      const item = { instance, assessment, currentEvidence: status }, size = Buffer.byteLength(JSON.stringify(item));
      if (items.length < 40 && bytes + size <= maxBytes) { items.push(item); bytes += size; }
    }
  }
  const partial = invalid > 0 || missing > 0 || visited !== expectedScopes;
  return { state: observedScopes === 0 ? invalid ? "unavailable" : "not_collected" : partial ? "partial" : "reported", expectedScopes, observedScopes, totalKnown,
    moreAvailable: totalKnown > items.length, items,
    reason: partial ? "Some configured improvement checks are missing or could not be read. These saved results may be incomplete."
      : totalKnown === 0 ? "No saved improvement checks were available in the retained registries." : totalKnown > items.length ? "Showing a bounded preview of the saved improvement checks." : null };
}
