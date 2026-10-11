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
type Identity = { version: 1; repository: string | null; readAt: string; coverage: "saved-opportunity-registry"; countSemantics: "reported_states_not_verified_outcomes" };
export type GardenerOpportunityEvidence = Identity & (
  | { state: "unavailable"; reason: OpportunityEvidenceReason }
  | { state: "reported"; total: number; counts: Record<OpportunityState, number>; oldestReconciledAt: string | null; latestReconciledAt: string | null }
);
const isOpportunityRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isOpportunityText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
const isOpportunityStamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isOpportunityRepository = (v: unknown): v is string => typeof v === "string" && v.length <= 257 &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) && !v.split("/").some((part) => part === "." || part === "..");
const opportunityEvidenceIdentity = (repository: string | null, clock: Clock): Identity => ({ version: 1, repository, readAt: clock.iso(),
  coverage: "saved-opportunity-registry", countSemantics: "reported_states_not_verified_outcomes" });
const unavailableOpportunityEvidence = (repository: string | null, clock: Clock, reason: OpportunityEvidenceReason): GardenerOpportunityEvidence =>
  ({ ...opportunityEvidenceIdentity(repository, clock), state: "unavailable", reason });

/** Whitelist only stored classifications. This read does not verify PRs, deployments, or causal
 * measurements and must not turn a producer's classification into a newly verified benefit. */
export function projectGardenerOpportunityEvidence(raw: unknown, repository: string, clock: Clock = systemClock): GardenerOpportunityEvidence {
  if (!isOpportunityRepository(repository)) return unavailableOpportunityEvidence(null, clock, "scope_unavailable");
  if (!Array.isArray(raw)) return unavailableOpportunityEvidence(repository, clock, "malformed");
  if (raw.length > OPPORTUNITY_EVIDENCE_MAX_ROWS) return unavailableOpportunityEvidence(repository, clock, "oversized");
  const counts = Object.fromEntries(OPPORTUNITY_STATES.map((state) => [state, 0])) as Record<OpportunityState, number>;
  const keys = new Set<string>();
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
    keys.add(key);
    counts[row.state as OpportunityState]++;
    if (oldestReconciledAt === null || Date.parse(row.at) < Date.parse(oldestReconciledAt)) oldestReconciledAt = row.at;
    if (latestReconciledAt === null || Date.parse(row.at) > Date.parse(latestReconciledAt)) latestReconciledAt = row.at;
  }
  // An empty saved array has no producer timestamp. Its read time cannot establish freshness.
  return { ...opportunityEvidenceIdentity(repository, clock), state: "reported", total: raw.length, counts, oldestReconciledAt, latestReconciledAt };
}

/** A single descriptor, finite bytes, and stable metadata. Missing/corrupt data is never zero. */
export async function readGardenerOpportunityEvidence(stateDir: string, repository?: string, clock: Clock = systemClock, openFile: typeof open = open): Promise<GardenerOpportunityEvidence> {
  if (!isOpportunityRepository(repository)) return unavailableOpportunityEvidence(null, clock, "scope_unavailable");
  try {
    const handle = await openFile(join(stateDir, OPPORTUNITY_EVIDENCE_FILE), "r");
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
