import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";

export interface EvidenceMeasurement {
  lane: string;
  field: "assignment" | "outcome" | "servedModel" | "tokens" | "cost";
  observed: number;
  denominator: number;
  floor: number;
  baseline?: number;
  at: string;
  since: string;
  line: string;
}

export interface EvidenceRevision {
  version: 1;
  mainSha: string;
  expectedRecord: string;
  expectedPlan: Record<string, string>;
  measurement: EvidenceMeasurement;
  closure: { eligible: boolean; reason: string; pr?: string; completePlan?: true;
    tasks?: Array<{ id: string; state: "open" | "closed" | "unknown" }> };
}

export function evidenceRecordId(lane: string, field: EvidenceMeasurement["field"]): string {
  const slug = lane.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "unknown";
  return `evidence-coverage-${slug}-${field === "servedModel" ? "served-model" : field}`;
}

export function measuredLine(raw: string): string | undefined {
  return raw.split("\n").find((line) => /^Coverage: [0-9]+\/[0-9]+ .*\([0-9]+(?:\.[0-9]+)?%\)/.test(line));
}

/** Reconstructible, narrow authority: only the measurement line and a justified reopening change. */
export function buildEvidenceRevision(revision: EvidenceRevision): string {
  const { measurement: m, closure } = revision;
  const entry = parse(revision.expectedRecord);
  const floor = m.field === "assignment" || m.field === "outcome" ? 0.8 : 0.9;
  const ratio = m.observed / m.denominator;
  if (revision.version !== 1 || !/^[a-f0-9]{40}$/.test(revision.mainSha)
    || Object.keys(revision.expectedPlan).length !== 2
    || !Object.entries(revision.expectedPlan).some(([path, sha]) => path.endsWith("tasks.yaml") && /^[a-f0-9]{40}$/.test(sha))
    || !Object.keys(revision.expectedPlan).some((path) => path.endsWith("tasks.d"))
    || Object.keys(revision.expectedPlan).some((path) => path.startsWith("/") || path.split("/").includes(".."))
    || !Object.values(revision.expectedPlan).every((sha) => sha === "absent" || /^[a-f0-9]{40}$/.test(sha))
    || !entry || entry.id !== evidenceRecordId(m.lane, m.field) || typeof entry.raw !== "string"
    || !["new", "grilling", "proposed", "rejected", "accepted", "answered"].includes(entry.status)
    || !["assignment", "outcome", "servedModel", "tokens", "cost"].includes(m.field)
    || !Number.isInteger(m.observed) || !Number.isInteger(m.denominator) || m.denominator < 20
    || m.observed < 0 || m.observed > m.denominator || m.floor !== floor
    || (m.baseline !== undefined && (!Number.isFinite(m.baseline) || m.baseline < floor || m.baseline > 1))
    || !(ratio < floor || (m.baseline !== undefined && m.baseline - ratio > 0.1))
    || !Number.isFinite(Date.parse(m.at)) || Date.parse(m.at) - Date.parse(m.since) !== 7 * 86_400_000
    || !m.line.startsWith(`Coverage: ${m.observed}/${m.denominator} `)
    || !m.line.includes(`(${(ratio * 100).toFixed(1)}%)`) || /[\r\n]/.test(m.line)
    || typeof closure.eligible !== "boolean" || typeof closure.reason !== "string") {
    throw new Error("invalid evidence_coverage_revision");
  }
  const value = (ratio * 100).toFixed(1);
  const closed = ["rejected", "accepted", "answered"].includes(entry.status);
  if (closed && closure.eligible && entry.status !== "rejected" && (closure.completePlan !== true
    || !Array.isArray(closure.tasks) || !closure.tasks.every((task) => /^W\d+-T\d+$/.test(task.id) && task.state === "closed")
    || new Set(closure.tasks.map((task) => task.id)).size !== closure.tasks.length)) {
    throw new Error("invalid evidence_coverage_revision: incomplete task closure facts");
  }
  const reopen = closed && closure.eligible && entry.evidence_coverage_last_reopened !== value;
  const previous = measuredLine(entry.raw);
  let raw = previous === undefined ? `${entry.raw}\n${m.line}` : entry.raw.replace(previous, m.line);
  if (reopen) raw += `\nEvidence coverage reopened ${m.at}: ${value}% (${m.observed}/${m.denominator}); window ${m.since} through ${m.at}; overrides ${entry.status}${closure.pr ? ` closed by ${closure.pr}` : ""}.`;
  return stringify({ ...entry, raw, ...(reopen ? { status: "new", evidence_coverage_last_reopened: value } : {}),
    evidence_coverage_revision: revision });
}

export function evidenceRevisionOf(bytes: string): EvidenceRevision | undefined {
  return parse(bytes)?.evidence_coverage_revision;
}

export function validateEvidenceRevision(upstream: string | undefined, local: string): string | undefined {
  try {
    const revision = evidenceRevisionOf(local);
    if (!revision) return undefined;
    if (upstream === undefined) return "evidence revision refuses record deletion";
    if (upstream !== revision.expectedRecord) return "evidence revision refuses concurrent record edits";
    if (!isDeepStrictEqual(parse(buildEvidenceRevision(revision)), parse(local))) return "evidence revision changes fields outside measured evidence";
    return undefined;
  } catch (error) {
    // An unparseable revision is refused with its parse error, never read as valid or as absent.
    return `invalid evidence revision: ${String(error)}`;
  }
}
