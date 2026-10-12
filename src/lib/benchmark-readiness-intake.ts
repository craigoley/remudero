/**
 * W1-T5432 — calibration gaps become governed tasks, and recording is reported apart from filing.
 *
 * The readiness driver (benchmark-aa-readiness.ts) RECORDS the next calibration gap to a local sidecar. Nothing
 * consumed it. This module is the one typed, validated reader of that sidecar and the adapter that hands its
 * gaps to the EXISTING opportunity intake (opportunity-intake.ts) as source-qualified candidates: no timer, no
 * new permission, no competing triage lane. Intake then routes a candidate through the existing risk judge and
 * feedback-to-plan workflow exactly as it does for the other sources.
 *
 * A sidecar record and a pending feedback PR are RECORDED / PENDING-TRIAGE evidence. "filed" is claimed only by
 * {@link readinessGapOutcome}, and only with a resulting task id and the source receipt that task carries.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { READINESS_FOLLOW_UPS_FILE, type ReadinessGap } from "./benchmark-aa-readiness.js";
import type { Clock } from "./clock.js";
import type { OpportunityCandidate, OpportunityIntakeResult, OpportunityWork } from "./opportunity-intake.js";

export interface ReadinessGapRecord { ts: string; key: string; trialId: string; gap: ReadinessGap; repo: string }

export interface ReadinessGapRead {
  /** Valid records that name the expected repository, first occurrence of each key. */
  records: ReadinessGapRecord[];
  /** Keys that name another repository: never consumed under this instance's identity. */
  foreign: string[];
  /** Lines or files that could not be trusted: unknown evidence is reported, never read as empty. */
  unavailable: string[];
}

/** A parse of one sidecar line; a reason string means the line cannot be trusted. */
function parseRecord(line: string): { base: Omit<ReadinessGapRecord, "repo">; repo: string | null } | string {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch (error) {
    const reason = `unparseable line (${(error as Error).message.slice(0, 60)})`;
    return reason;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "line is not an object";
  const row = value as Record<string, unknown>;
  const gap = row.gap as Record<string, unknown> | null | undefined;
  if (typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts))) return "missing or invalid ts";
  if (typeof row.trialId !== "string" || row.trialId === "") return "missing trialId";
  if (typeof gap !== "object" || gap === null || typeof gap.kind !== "string" || gap.kind === ""
    || typeof gap.machineRepairable !== "boolean" || typeof gap.detail !== "string") return "missing or invalid gap";
  if (row.key !== `${row.trialId}:${gap.kind}`) return "key does not match trialId and gap kind";
  if (row.repo !== undefined && (typeof row.repo !== "string" || row.repo === "")) return "invalid repo";
  const base = { ts: row.ts, key: row.key as string, trialId: row.trialId, gap: { kind: gap.kind, machineRepairable: gap.machineRepairable, detail: gap.detail } };
  return { base, repo: typeof row.repo === "string" ? row.repo : null };
}

/**
 * Read this instance's readiness gap sidecar for `repo`. An absent file is an observed "nothing recorded"; any
 * other read failure, a malformed line, or a record that cannot be attributed to a repository is `unavailable`.
 */
export function readReadinessGapSidecar(stateDir: string, repo: string): ReadinessGapRead {
  const path = join(stateDir, READINESS_FOLLOW_UPS_FILE);
  const out: ReadinessGapRead = { records: [], foreign: [], unavailable: [] };
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    const reason = `benchmark-readiness unavailable: ${READINESS_FOLLOW_UPS_FILE} unreadable (${(error as Error).message.slice(0, 80)})`;
    out.unavailable.push(reason);
    return out;
  }
  const seen = new Set<string>();
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const parsed = parseRecord(line);
    if (typeof parsed === "string") { out.unavailable.push(`benchmark-readiness unavailable: line ${index + 1}: ${parsed}`); return; }
    const { base, repo: recorded } = parsed;
    if (recorded === null) { out.unavailable.push(`benchmark-readiness unavailable: ${base.key} names no repository`); return; }
    if (recorded !== repo) { if (!out.foreign.includes(base.key)) out.foreign.push(base.key); return; }
    if (seen.has(base.key)) return;
    seen.add(base.key);
    out.records.push({ ...base, repo: recorded });
  });
  return out;
}

export interface ReadinessCandidatePorts { repo: string; clock: Clock; readReadinessGaps?: () => ReadinessGapRead }

/**
 * The opportunity collector's readiness source. A port that is absent contributes nothing; a present port that
 * cannot be trusted contributes `unavailable` text, so an unreadable sidecar never looks like "no gap".
 */
export function collectBenchmarkReadinessCandidates(ports: ReadinessCandidatePorts): { candidates: OpportunityCandidate[]; unavailable: string[] } {
  if (!ports.readReadinessGaps) return { candidates: [], unavailable: [] };
  let read: ReadinessGapRead;
  try { read = ports.readReadinessGaps(); }
  catch (error) {
    const reason = `benchmark-readiness unavailable: ${String(error)}`;
    return { candidates: [], unavailable: [reason] };
  }
  const observedAt = ports.clock.iso();
  const candidates = read.records.map((record): OpportunityCandidate => ({
    source: "benchmark-readiness", repo: ports.repo, key: `benchmark-readiness:${record.key}`, observedAt, recordedAt: record.ts,
    anchor: `${READINESS_FOLLOW_UPS_FILE}#${record.key}`, availability: "available", freshness: "fresh",
    population: { affected: 1, denominator: read.records.length, unit: "recorded calibration gaps" },
    impact: { value: 1, unit: "gap withholding the calibration receipt" },
    remedy: `Repair calibration gap ${record.gap.kind} for trial ${record.trialId}: ${record.gap.detail}. Do not activate the paid pilot.`,
    authority: record.gap.machineRepairable ? "machine" : "operator", related: {},
  }));
  return { candidates, unavailable: read.unavailable };
}

export type ReadinessGapState = "recorded" | "pending-triage" | "held" | "rejected" | "unavailable" | "already-covered" | "filed";

export interface ReadinessGapOutcome {
  key: string;
  state: ReadinessGapState;
  reason: string;
  /** Present only with state "filed": the resulting task and the source receipt it carries. */
  taskId?: string;
  receipt?: string;
  prUrl?: string;
}

/**
 * Report where a readiness candidate stands. "filed" needs a task id plus the source receipt (the Opportunity-Key the
 * task's origin or text carries); a feedback entry, an open PR or a sidecar line alone is never reported as filed.
 */
export function readinessGapOutcome(candidate: Pick<OpportunityCandidate, "repo" | "key">, work: OpportunityWork, intake?: OpportunityIntakeResult): ReadinessGapOutcome {
  const key = candidate.key;
  const qualified = `${candidate.repo}/${key}`;
  const marker = `Opportunity-Key: ${qualified}`;
  const carries = (text: string | undefined): boolean => text?.split("\n").some((line) => line.trim() === marker) ?? false;
  const task = work.tasks.find((entry) => (entry.repo === candidate.repo || entry.repo === candidate.repo.split("/")[1])
    && (entry.origin === key || entry.origin === qualified || carries(entry.note) || carries(entry.prompt)));
  if (task) return { key, state: "filed", reason: "a plan task carries the source receipt", taskId: task.id, receipt: marker };
  const entry = work.feedback.find((item) => item.submission_key === qualified || carries(item.raw));
  if (entry?.status === "rejected") return { key, state: "rejected", reason: `triage rejected feedback ${entry.id}` };
  if (entry) return { key, state: "pending-triage", reason: `feedback ${entry.id} is ${entry.status}; no task yet` };
  if (work.proposals.some((proposal) => proposal.id === key || proposal.id === qualified || carries(proposal.summary))) {
    return { key, state: "held", reason: "staged as an operator proposal; no task yet" };
  }
  const pr = work.prs.find((item) => carries(item.body));
  if (pr) return { key, state: "pending-triage", reason: "a plan PR carrying the key is open; no task yet" };
  if (work.mergedKeys.includes(qualified)) return { key, state: "already-covered", reason: "a merged change already carries the key" };
  if (intake?.candidate?.key === key) {
    if (intake.prUrl) return { key, state: "pending-triage", reason: "feedback PR opened; no task yet", prUrl: intake.prUrl };
    if (intake.status === "held") return { key, state: "held", reason: "judgement held the candidate; evidence kept for the next pass" };
    if (intake.destination === "inbox") return { key, state: "held", reason: "staged as an operator proposal; no task yet" };
  }
  if (intake?.status === "unavailable") return { key, state: "unavailable", reason: intake.unavailable.join("; ") || "judgement or dedupe source unavailable" };
  if (intake?.deduped.includes(key)) return { key, state: "already-covered", reason: "existing work already carries the key" };
  return { key, state: "recorded", reason: "recorded in the sidecar; not yet routed to triage" };
}
