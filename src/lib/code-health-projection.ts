import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fixedClock } from "./clock.js";
import { CODE_HEALTH_SOURCE_KINDS, CODE_HEALTH_VERSION, validateCodeHealthAssessment, type CodeHealthAssessment } from "./code-health-contract.js";

export interface CodeHealthScanFinding {
  id: string;
  ruleId: string;
  status: "open" | "fixed" | "dismissed";
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  path: string;
  title: string;
  effortMinutes: number | null;
}

/** An existing collector's immutable result; reading it again is not a new scan. */
export interface CodeHealthScan {
  kind: "quality" | "coverage";
  repository: string;
  scanId: string;
  analyzedSha: string;
  observedAt: string;
  state: "complete" | "partial" | "stale" | "not_collected" | "unavailable";
  scopeHash: string | null;
  toolVersion: string | null;
  rulesVersion: string | null;
  configHash: string | null;
  exclusions: string[];
  reason: string | null;
  checks: Array<{ id: string; met: boolean; reason: string }>;
  findings: CodeHealthScanFinding[];
}

/** Checks describe source facts or an existing repository policy, never a new weighted grade. */
export interface CodeHealthCheckRegistry {
  version: string;
  checks: Array<{
    id: string;
    sourceKind: CodeHealthScan["kind"];
    category: CodeHealthAssessment["checks"][number]["category"];
    description: string;
  }>;
}

export interface CodeHealthProjectionInput {
  repository: string;
  currentSha: string;
  observedAt: string;
  nextDueAt: string | null;
  registry: CodeHealthCheckRegistry;
  scans: CodeHealthScan[];
  baseline: null | { analyzedSha: string; policyVersion: string; scans: CodeHealthScan[] };
}

export interface CodeHealthComparison {
  state: "comparable" | "measurement_changed" | "insufficient_evidence";
  newFindings: string[];
  existingFindings: string[];
  fixedFindings: string[];
  unconfirmedMissingFindings: string[];
  reason: string;
}

const repositoryShape = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i;
const shaShape = /^[a-f0-9]{40}$/i;
const text = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && fixedClock(Date.parse(value)).iso() === value;
const sourceId = (repository: string, kind: CodeHealthScan["kind"]): string => `${repository.toLowerCase()}:${kind}`;

/** Titles, paths and observed clocks can change without creating another finding. */
export function codeHealthFindingFingerprint(repository: string, kind: CodeHealthScan["kind"], finding: Pick<CodeHealthScanFinding, "id" | "ruleId">): string {
  return `${sourceId(repository, kind)}:${createHash("sha256").update(JSON.stringify([finding.ruleId, finding.id])).digest("hex")}`;
}

function validateInput(input: CodeHealthProjectionInput): void {
  if (!repositoryShape.test(input.repository) || !shaShape.test(input.currentSha) || !time(input.observedAt) ||
      !(input.nextDueAt === null || time(input.nextDueAt)) || !text(input.registry.version)) throw new Error("Code health report identity or clock is invalid.");
  if (input.registry.checks.length > 256 || new Set(input.registry.checks.map(check => check.id)).size !== input.registry.checks.length ||
      input.registry.checks.some(check => !text(check.id) || !CODE_HEALTH_SOURCE_KINDS.includes(check.sourceKind) || !text(check.description, 2048))) throw new Error("Code health check registry is invalid.");
  for (const scans of [input.scans, input.baseline?.scans ?? []]) {
    if (scans.length > CODE_HEALTH_SOURCE_KINDS.length || new Set(scans.map(scan => scan.kind)).size !== scans.length) throw new Error("Code health source inventory is duplicated or invalid.");
    for (const scan of scans) {
      if (scan.repository.toLowerCase() !== input.repository.toLowerCase()) throw new Error("Code health repository evidence does not match the requested repository.");
      if (!CODE_HEALTH_SOURCE_KINDS.includes(scan.kind) || !text(scan.scanId) || scan.findings.length > 10_000 ||
          scan.exclusions.length > 128 || scan.exclusions.some(path => !text(path)) || scan.checks.length > 256 ||
          new Set(scan.checks.map(check => check.id)).size !== scan.checks.length ||
          scan.checks.some(check => !text(check.id) || typeof check.met !== "boolean" || !text(check.reason, 2048))) throw new Error("Code health scan shape is invalid.");
      const identities = new Map<string, CodeHealthScanFinding>();
      for (const finding of scan.findings) {
        const identity = codeHealthFindingFingerprint(input.repository, scan.kind, finding), previous = identities.get(identity);
        if (!text(finding.id) || !text(finding.ruleId) || !["open", "fixed", "dismissed"].includes(finding.status) ||
            !["critical", "high", "medium", "low"].includes(finding.severity) || !text(finding.category, 64) || !text(finding.title, 2048) ||
            !text(finding.path, 4096) || finding.path.startsWith("/") || finding.path.includes("\\") || finding.path.split("/").some(part => !part || part === "..") ||
            !(finding.effortMinutes === null || Number.isFinite(finding.effortMinutes) && finding.effortMinutes >= 0) ||
            previous && !isDeepStrictEqual(previous, finding)) throw new Error("Code health finding identity or evidence is invalid.");
        identities.set(identity, finding);
      }
    }
  }
}

function scanProblem(scan: CodeHealthScan | undefined, sha: string, observedAt: string): string | undefined {
  if (!scan) return "This required source has not been collected.";
  if (scan.state !== "complete") return text(scan.reason, 2048) ? scan.reason! : "The source has not supplied a complete scan.";
  if (!shaShape.test(scan.analyzedSha)) return "The scan describes another code version.";
  if (!time(scan.observedAt) || Date.parse(scan.observedAt) > Date.parse(observedAt)) return "The scan time is invalid or later than this report.";
  if (![scan.scopeHash, scan.toolVersion, scan.rulesVersion, scan.configHash].every(value => text(value))) return "The scan has incomplete scope, tool, rules or configuration evidence.";
  return undefined;
}

function pairState(input: CodeHealthProjectionInput, current: CodeHealthScan | undefined, prior: CodeHealthScan | undefined): CodeHealthComparison["state"] {
  const baseline = input.baseline;
  if (!baseline || !shaShape.test(baseline.analyzedSha) || scanProblem(current, input.currentSha, input.observedAt) ||
      scanProblem(prior, baseline.analyzedSha, input.observedAt)) return "insufficient_evidence";
  if (baseline.policyVersion !== input.registry.version || !isDeepStrictEqual(
    [current!.scopeHash, current!.toolVersion, current!.rulesVersion, current!.configHash, [...current!.exclusions].sort()],
    [prior!.scopeHash, prior!.toolVersion, prior!.rulesVersion, prior!.configHash, [...prior!.exclusions].sort()])) return "measurement_changed";
  if (current!.scanId === prior!.scanId || Date.parse(current!.observedAt) <= Date.parse(prior!.observedAt)) return "insufficient_evidence";
  return "comparable";
}

export function projectCodeHealth(input: CodeHealthProjectionInput): CodeHealthAssessment {
  validateInput(input);
  const repository = input.repository.toLowerCase();
  const pairs = CODE_HEALTH_SOURCE_KINDS.map(kind => {
    const scan = input.scans.find(source => source.kind === kind), prior = input.baseline?.scans.find(source => source.kind === kind);
    return { kind, scan, prior, problem: scanProblem(scan, input.currentSha, input.observedAt), pair: pairState(input, scan, prior) };
  });
  const sources: CodeHealthAssessment["sources"] = pairs.map(({ kind, scan, prior, problem }) => ({
    id: sourceId(repository, kind), kind, required: true,
    state: problem ? !scan ? "not_collected" : scan.state === "complete" ? "partial" : scan.state : "complete",
    analyzedSha: scan && shaShape.test(scan.analyzedSha) ? scan.analyzedSha.toLowerCase() : null,
    observedAt: scan && time(scan.observedAt) && Date.parse(scan.observedAt) <= Date.parse(input.observedAt) ? scan.observedAt : null,
    scopeHash: text(scan?.scopeHash) ? scan!.scopeHash : null, toolVersion: text(scan?.toolVersion) ? scan!.toolVersion : null,
    rulesVersion: text(scan?.rulesVersion) ? scan!.rulesVersion : null, configHash: text(scan?.configHash) ? scan!.configHash : null,
    baseline: prior && input.baseline && !scanProblem(prior, input.baseline.analyzedSha, input.observedAt) ? {
      sha: prior.analyzedSha.toLowerCase(), scopeHash: prior.scopeHash!, toolVersion: prior.toolVersion!, rulesVersion: prior.rulesVersion!, configHash: prior.configHash!,
    } : null, exclusions: scan?.exclusions ?? [], reason: problem ?? null,
  }));
  const checks: CodeHealthAssessment["checks"] = input.registry.checks.map(definition => {
    const pair = pairs.find(source => source.kind === definition.sourceKind)!, check = pair.scan?.checks.find(value => value.id === definition.id);
    const unavailable = pair.problem ?? (!check ? "This declared check was not measured." : check.met && pair.pair !== "comparable" ? "A passing comparison needs an independent scan with the same scope and policy." : undefined);
    return { id: definition.id, category: definition.category, state: unavailable ? "not_measured" : check!.met ? "met" : "not_met",
      sourceIds: [sourceId(repository, definition.sourceKind)], reason: unavailable ?? check!.reason };
  });
  const findings = new Map<string, CodeHealthAssessment["findings"][number]>();
  for (const pair of pairs) for (const finding of pair.scan?.findings ?? []) {
    if (finding.status !== "open") continue;
    const fingerprint = codeHealthFindingFingerprint(repository, pair.kind, finding);
    findings.set(fingerprint, { fingerprint, sourceId: sourceId(repository, pair.kind), severity: finding.severity, category: finding.category,
      status: pair.pair !== "comparable" ? "unknown" : pair.prior!.findings.some(old => old.status === "open" && codeHealthFindingFingerprint(repository, pair.kind, old) === fingerprint) ? "existing" : "new",
      path: finding.path, title: finding.title, effortMinutes: finding.effortMinutes, estimateKind: finding.effortMinutes === null ? null : "modeled" });
  }
  if (findings.size > 1000) throw new Error("Code health findings exceed the public contract bound; prior evidence must remain available.");
  const met = checks.filter(check => check.state === "met").length, assessed = checks.filter(check => check.state !== "not_measured").length;
  const complete = pairs.every(pair => !pair.problem && pair.pair === "comparable") && checks.length > 0 && assessed === checks.length;
  const result: CodeHealthAssessment = { version: CODE_HEALTH_VERSION, repository, currentSha: input.currentSha.toLowerCase(), analyzedSha: input.currentSha.toLowerCase(),
    baselineSha: input.baseline && shaShape.test(input.baseline.analyzedSha) ? input.baseline.analyzedSha.toLowerCase() : null,
    policyVersion: input.registry.version, observedAt: input.observedAt, nextDueAt: input.nextDueAt,
    state: !input.scans.length ? "not_collected" : pairs.some(pair => pair.scan?.state === "stale") ? "stale" : complete ? "measured" : "partial", sources, checks,
    findings: [...findings.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    summary: { met, assessed, expected: checks.length, healthy: checks.some(check => check.state === "not_met") ? false : complete && met === checks.length && !findings.size ? true : null } };
  const valid = validateCodeHealthAssessment(result);
  if (!valid.ok) throw new Error(`Code health projection refused: ${valid.reason}`);
  return result;
}

export function compareCodeHealthEvidence(input: CodeHealthProjectionInput): CodeHealthComparison {
  validateInput(input);
  const states = CODE_HEALTH_SOURCE_KINDS.map(kind => pairState(input, input.scans.find(scan => scan.kind === kind), input.baseline?.scans.find(scan => scan.kind === kind)));
  const result: CodeHealthComparison = { state: states.includes("measurement_changed") ? "measurement_changed" : states.every(state => state === "comparable") ? "comparable" : "insufficient_evidence",
    newFindings: [], existingFindings: [], fixedFindings: [], unconfirmedMissingFindings: [], reason: "" };
  if (result.state !== "comparable") { result.reason = result.state === "measurement_changed" ? "The measurement scope, tool, rules or check policy changed." : "Independent complete scans for the same measured scope are unavailable."; return result; }
  const current = new Map(input.scans.flatMap(scan => scan.findings.map(finding => [codeHealthFindingFingerprint(input.repository, scan.kind, finding), finding] as const)));
  const previous = new Map(input.baseline!.scans.flatMap(scan => scan.findings.filter(finding => finding.status === "open").map(finding => [codeHealthFindingFingerprint(input.repository, scan.kind, finding), finding] as const)));
  for (const [id, finding] of current) if (finding.status === "open") (previous.has(id) ? result.existingFindings : result.newFindings).push(id);
  for (const id of previous.keys()) {
    const finding = current.get(id);
    if (finding?.status === "fixed") result.fixedFindings.push(id);
    else if (finding?.status !== "open") result.unconfirmedMissingFindings.push(id);
  }
  if (result.unconfirmedMissingFindings.length) result.state = "insufficient_evidence";
  result.reason = result.state === "comparable" ? "The same source configuration independently confirms these finding states." : "A missing or dismissed finding does not establish a fix.";
  for (const field of [result.newFindings, result.existingFindings, result.fixedFindings, result.unconfirmedMissingFindings]) field.sort();
  return result;
}
