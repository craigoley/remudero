import { isDeepStrictEqual } from "node:util";
import { fixedClock } from "./clock.js";
import { CODE_HEALTH_SOURCE_KINDS } from "./code-health-contract.js";
import { projectCodeHealth, independentCodeHealthScans, type CodeHealthProjectionInput, type CodeHealthScan } from "./code-health-projection.js";

export interface CodeHealthCollection {
  repository: string;
  currentSha: string;
  observedAt: string;
  scans: CodeHealthScan[];
  previous: CodeHealthProjectionInput | null;
}

const SOURCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const registry: CodeHealthProjectionInput["registry"] = {
  version: "code-health-existing-policy-v1",
  checks: [
    { id: "quality-maintainability-open", sourceKind: "quality", category: "maintainability", description: "No unresolved findings in the existing CodeQL maintainability subset." },
    { id: "coverage-existing-tier", sourceKind: "coverage", category: "tests", description: "Meets this repository's existing instrumented coverage tier." },
  ],
};

/** Assembly has no network, model, filing, or dispatch effects. */
export function prepareCodeHealthCollection(input: CodeHealthCollection): CodeHealthProjectionInput {
  projectCodeHealth({ repository: input.repository, currentSha: input.currentSha, analyzedSha: input.currentSha,
    observedAt: input.observedAt, nextDueAt: null, registry, scans: input.scans, baseline: null });
  const previous = input.previous;
  if (previous && previous.repository.toLowerCase() !== input.repository.toLowerCase()) throw new Error("The previous code health evidence belongs to another repository.");
  const past = previous ? [...previous.scans, ...(previous.baseline?.scans ?? []), ...(previous.retainedEvidence ?? []).map(entry => entry.scan)] : [];
  const scans = CODE_HEALTH_SOURCE_KINDS.map(kind => {
    const measured = input.scans.filter(scan => scan.kind === kind);
    if (measured.length > 1) throw new Error("The collection contains duplicate required sources.");
    const scan = measured[0];
    if (!scan) return { kind, repository: input.repository.toLowerCase(), scanId: `not-collected:${kind}`, analyzedSha: "", observedAt: "",
      state: "not_collected", scopeHash: null, toolVersion: null, rulesVersion: null, configHash: null, exclusions: [],
      reason: "This required source did not supply a measured result.", checks: [], findings: [] } satisfies CodeHealthScan;
    const original = past.find(prior => prior.kind === kind && prior.scanId === scan.scanId && prior.state === "complete");
    // A workflow rerun or another alert read cannot mint an independent scan or renew its clock.
    if (original && scan.state === "complete") {
      if (isDeepStrictEqual({ ...original, observedAt: "" }, { ...scan, observedAt: "" })) return structuredClone(original);
      return { ...structuredClone(scan), observedAt: original.observedAt, state: "partial",
        reason: "A saved measurement identity returned different source facts. Its results need verification." } satisfies CodeHealthScan;
    }
    return structuredClone(scan);
  });
  const analyzedSha = scans.find(scan => /^[a-f0-9]{40}$/i.test(scan.analyzedSha))?.analyzedSha ?? input.currentSha;
  const priorAssessment = previous ? projectCodeHealth(previous) : null;
  const previousComplete = previous !== null && priorAssessment !== null && CODE_HEALTH_SOURCE_KINDS.every(kind =>
    priorAssessment.sources.some(source => source.required && source.kind === kind && source.state === "complete" && source.analyzedSha === previous.analyzedSha));
  const independentCollection = previousComplete && CODE_HEALTH_SOURCE_KINDS.every(kind => {
    const current = scans.find(scan => scan.kind === kind)!, prior = previous!.scans.find(scan => scan.kind === kind)!;
    return current.state === "complete" && current.analyzedSha === analyzedSha && independentCodeHealthScans(current, prior);
  });
  const baseline = independentCollection ? { analyzedSha: previous!.analyzedSha, policyVersion: previous!.registry.version, scans: structuredClone(previous!.scans) } : previous?.baseline ?? null;
  const retained = previous ? [...(previous.retainedEvidence ?? []), ...previous.scans.filter(scan => scan.findings.some(finding => finding.status !== "fixed"))
    .map(scan => ({ policyVersion: previous.registry.version, scan }))] : [];
  const known = new Map<string, typeof retained[number]>();
  for (const entry of retained) {
    const key = JSON.stringify([entry.policyVersion, entry.scan.kind, entry.scan.scanId, entry.scan.analyzedSha, entry.scan.observedAt]);
    if (!known.has(key)) known.set(key, structuredClone(entry));
  }
  const result: CodeHealthProjectionInput = { repository: input.repository.toLowerCase(), currentSha: input.currentSha.toLowerCase(), analyzedSha: analyzedSha.toLowerCase(),
    observedAt: input.observedAt, nextDueAt: fixedClock(Date.parse(input.observedAt) + SOURCE_INTERVAL_MS).iso(), registry: structuredClone(registry), scans,
    baseline: baseline ? structuredClone(baseline) : null, retainedEvidence: [...known.values()] };
  projectCodeHealth(result); // Refuse overflow or invalid evidence without discarding the prior saved snapshot.
  return result;
}
