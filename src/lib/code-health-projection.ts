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
  fixedAt?: string;
  fixedSha?: string;
}

export interface CodeHealthCoverageMeasurement {
  branches: { covered: number; total: number };
  lines: { covered: number; total: number };
}

function coverageMeasurementShape(value: unknown): value is CodeHealthCoverageMeasurement {
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!object(value) || Object.keys(value).sort().join(",") !== "branches,lines") return false;
  return [value.branches, value.lines].every(part => object(part) && Object.keys(part).sort().join(",") === "covered,total" &&
    Number.isSafeInteger(part.covered) && Number.isSafeInteger(part.total) && Number(part.covered) >= 0 && Number(part.total) >= Number(part.covered));
}

/** An existing collector's immutable result; reading it again is not a new scan. */
export interface CodeHealthScan {
  kind: "quality" | "coverage";
  repository: string;
  scanId: string;
  componentIds?: string[];
  failureKind?: import("./ops.js").CodeScanningReadFailureKind;
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
  measurement?: CodeHealthCoverageMeasurement;
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
  analyzedSha: string;
  observedAt: string;
  nextDueAt: string | null;
  registry: CodeHealthCheckRegistry;
  scans: CodeHealthScan[];
  baseline: null | { analyzedSha: string; policyVersion: string; scans: CodeHealthScan[] };
  /** Known source facts retained independently of the last complete comparison baseline. */
  retainedEvidence?: Array<{ policyVersion: string; scan: CodeHealthScan }>;
}

/** Allowlisted producer metadata. Legacy artifacts without this envelope are unassessed. */
export interface CodeHealthSourceProvenance {
  version: "code-health-source-v1";
  kind: "quality" | "coverage";
  repository: string;
  analyzedSha: string;
  ref: "refs/heads/main";
  runId: string;
  observedAt: string;
  scanId: string;
  state: "complete" | "partial";
  reasons: string[];
  toolVersion: string | null;
  rulesVersion: string | null;
  configHash: string;
  exclusions: string[];
  scope: { kind: "explicit-analysis-targets" | "instrumented-source-files"; fileCount: number; hash: string | null };
  completion?: { kind: "original-invocations" | "workflow-analysis-step"; state: "success"; at: string } | null;
  runAttempt?: string;
  language?: string;
  sarifId?: string;
  ruleCount?: number;
  measurement?: CodeHealthCoverageMeasurement;
  check?: { id: string; met: boolean; reason: string };
}

export function validateCodeHealthProvenance(value: unknown, expected: { repository: string; analyzedSha: string; runId: string; kind: CodeHealthScan["kind"] }): CodeHealthSourceProvenance {
  const fail = (): never => { throw new Error("Code health source provenance is invalid or belongs to another measurement."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const p = value as CodeHealthSourceProvenance, digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const only = (value: object, keys: string): boolean => Object.keys(value).every(key => keys.split(" ").includes(key));
  const common = "version kind repository analyzedSha ref runId observedAt scanId state reasons toolVersion rulesVersion configHash exclusions scope";
  if (!only(p, `${common} ${p.kind === "quality" ? "runAttempt language sarifId ruleCount completion" : "check measurement"}`) ||
      p.version !== "code-health-source-v1" || p.kind !== expected.kind || !repositoryShape.test(p.repository) ||
      p.repository !== expected.repository.toLowerCase() || !shaShape.test(p.analyzedSha) || p.analyzedSha !== expected.analyzedSha.toLowerCase() ||
      p.ref !== "refs/heads/main" || !/^[1-9][0-9]{0,19}$/.test(p.runId) || p.runId !== expected.runId || !time(p.observedAt) || !text(p.scanId) ||
      !["complete", "partial"].includes(p.state) || !Array.isArray(p.reasons) || p.reasons.length > 128 || p.reasons.some(reason => !text(reason, 2048)) ||
      !(p.toolVersion === null || text(p.toolVersion)) || !(p.rulesVersion === null || digest(p.rulesVersion)) || !digest(p.configHash) ||
      !Array.isArray(p.exclusions) || p.exclusions.length > 128 || p.exclusions.some(path => !text(path)) ||
      !p.scope || typeof p.scope !== "object" || !only(p.scope, "kind fileCount hash") ||
      p.scope.kind !== (p.kind === "quality" ? "explicit-analysis-targets" : "instrumented-source-files") ||
      !Number.isSafeInteger(p.scope.fileCount) || p.scope.fileCount < 0 || p.scope.fileCount > 100_000 || !(p.scope.hash === null || digest(p.scope.hash))) return fail();
  if (p.kind === "quality") {
    if (p.completion !== null && (!p.completion || typeof p.completion !== "object" || !only(p.completion, "kind state at") ||
        !["original-invocations", "workflow-analysis-step"].includes(p.completion.kind) || p.completion.state !== "success" || !time(p.completion.at) ||
        Date.parse(p.completion.at) > Date.parse(p.observedAt))) return fail();
    if (!p.runAttempt || !/^[1-9][0-9]{0,5}$/.test(p.runAttempt) || !p.language || !/^[a-z][a-z0-9-]{0,63}$/.test(p.language) ||
        !p.sarifId || !/^[a-f0-9-]{36}$/i.test(p.sarifId) || !Number.isSafeInteger(p.ruleCount) || p.ruleCount! < 0 || p.ruleCount! > 2_560_000 ||
        p.scanId !== `codeql:${p.runId}:${p.runAttempt}:${p.language}:${p.sarifId}`) return fail();
  } else if (!coverageMeasurementShape(p.measurement) || !p.check || typeof p.check !== "object" || !only(p.check, "id met reason") || p.check.id !== "coverage-existing-tier" ||
      typeof p.check.met !== "boolean" || !text(p.check.reason, 2048) || p.scanId !== `coverage-nightly:${p.runId}`) return fail();
  if (p.state === "complete" ? p.reasons.length > 0 || !p.toolVersion || !p.rulesVersion || !p.scope.hash || !p.scope.fileCount || p.kind === "quality" && (!p.ruleCount || !p.completion) || p.kind === "coverage" && (!p.measurement!.branches.total || !p.measurement!.lines.total) : !p.reasons.length) return fail();
  return structuredClone(p);
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
  if (!repositoryShape.test(input.repository) || !shaShape.test(input.currentSha) || !shaShape.test(input.analyzedSha) || !time(input.observedAt) ||
      !(input.nextDueAt === null || time(input.nextDueAt)) || !text(input.registry.version)) throw new Error("Code health report identity or clock is invalid.");
  if (input.registry.checks.length > 256 || new Set(input.registry.checks.map(check => check.id)).size !== input.registry.checks.length ||
      input.registry.checks.some(check => !text(check.id) || !CODE_HEALTH_SOURCE_KINDS.includes(check.sourceKind) || !text(check.description, 2048))) throw new Error("Code health check registry is invalid.");
  if (input.retainedEvidence !== undefined && (!Array.isArray(input.retainedEvidence) || input.retainedEvidence.length > 64 ||
      input.retainedEvidence.some(entry => !text(entry.policyVersion) || !entry.scan))) throw new Error("Code health retained evidence is invalid or exceeds its bound.");
  for (const scans of [input.scans, input.baseline?.scans ?? [], ...(input.retainedEvidence ?? []).map(entry => [entry.scan])]) {
    if (scans.length > CODE_HEALTH_SOURCE_KINDS.length || new Set(scans.map(scan => scan.kind)).size !== scans.length) throw new Error("Code health source inventory is duplicated or invalid.");
    for (const scan of scans) {
      if (scan.repository.toLowerCase() !== input.repository.toLowerCase()) throw new Error("Code health repository evidence does not match the requested repository.");
      if (!CODE_HEALTH_SOURCE_KINDS.includes(scan.kind) || !text(scan.scanId) || scan.findings.length > 10_000 ||
          scan.exclusions.length > 128 || scan.exclusions.some(path => !text(path)) || scan.checks.length > 256 ||
          new Set(scan.checks.map(check => check.id)).size !== scan.checks.length ||
          scan.checks.some(check => !text(check.id) || typeof check.met !== "boolean" || !text(check.reason, 2048))) throw new Error("Code health scan shape is invalid.");
      if (scan.componentIds !== undefined && (!Array.isArray(scan.componentIds) || scan.componentIds.length > 32 ||
          scan.state === "complete" && scan.componentIds.length === 0 || scan.componentIds.some(id => !text(id)) ||
          new Set(scan.componentIds).size !== scan.componentIds.length)) throw new Error("Code health source component identities are invalid.");
      if (scan.measurement !== undefined && (scan.kind !== "coverage" || !coverageMeasurementShape(scan.measurement))) throw new Error("Code health coverage measurement is invalid.");
      const identities = new Map<string, CodeHealthScanFinding>();
      for (const finding of scan.findings) {
        const identity = codeHealthFindingFingerprint(input.repository, scan.kind, finding), previous = identities.get(identity);
        if (!text(finding.id) || !text(finding.ruleId) || !["open", "fixed", "dismissed"].includes(finding.status) ||
            !["critical", "high", "medium", "low"].includes(finding.severity) || !text(finding.category, 64) || !text(finding.title, 2048) ||
            !text(finding.path, 4096) || finding.path.startsWith("/") || finding.path.includes("\\") || finding.path.split("/").some(part => !part || part === "..") ||
            ((finding.fixedAt === undefined) !== (finding.fixedSha === undefined)) ||
            finding.fixedAt !== undefined && (finding.status !== "fixed" || !time(finding.fixedAt) || !shaShape.test(finding.fixedSha!) ||
              !time(scan.observedAt) || Date.parse(finding.fixedAt) > Date.parse(scan.observedAt)) ||
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
  if (!shaShape.test(scan.analyzedSha) || scan.analyzedSha.toLowerCase() !== sha.toLowerCase()) return "The scan describes another code version.";
  if (!time(scan.observedAt) || Date.parse(scan.observedAt) > Date.parse(observedAt)) return "The scan time is invalid or later than this report.";
  if (![scan.scopeHash, scan.toolVersion, scan.rulesVersion, scan.configHash].every(value => text(value))) return "The scan has incomplete scope, tool, rules or configuration evidence.";
  return undefined;
}

/** Ordering of source severity labels only; it never weights assessment counts. */
export function codeHealthSeverityAtLeast(left: CodeHealthScanFinding["severity"], right: CodeHealthScanFinding["severity"]): boolean {
  const order: CodeHealthScanFinding["severity"][] = ["critical", "high", "medium", "low"];
  return order.indexOf(left) <= order.indexOf(right);
}

export function codeHealthFindingFixedAfter(finding: CodeHealthScanFinding | undefined, baselineAt: string): boolean {
  return finding?.status === "fixed" && (finding.fixedAt === undefined || Date.parse(finding.fixedAt) > Date.parse(baselineAt));
}

/** A changed aggregate does not make reused language or shard measurements independent. */
export function independentCodeHealthScans(current: CodeHealthScan, prior: CodeHealthScan): boolean {
  if (current.scanId === prior.scanId || Date.parse(current.observedAt) <= Date.parse(prior.observedAt)) return false;
  if (current.componentIds === undefined && prior.componentIds === undefined) return true;
  if (!current.componentIds?.length || !prior.componentIds?.length) return false;
  const previous = new Set(prior.componentIds);
  return current.componentIds.every(id => !previous.has(id));
}

export function compareCodeHealthScanPair(input: CodeHealthProjectionInput, current: CodeHealthScan | undefined, prior: CodeHealthScan | undefined): CodeHealthComparison["state"] {
  const baseline = input.baseline;
  if (!baseline || !shaShape.test(baseline.analyzedSha) || scanProblem(current, input.analyzedSha, input.observedAt) ||
      scanProblem(prior, baseline.analyzedSha, input.observedAt)) return "insufficient_evidence";
  if (baseline.policyVersion !== input.registry.version || !isDeepStrictEqual(
    [current!.scopeHash, current!.toolVersion, current!.rulesVersion, current!.configHash, [...current!.exclusions].sort()],
    [prior!.scopeHash, prior!.toolVersion, prior!.rulesVersion, prior!.configHash, [...prior!.exclusions].sort()])) return "measurement_changed";
  if (!independentCodeHealthScans(current!, prior!)) return "insufficient_evidence";
  return "comparable";
}

export function projectCodeHealth(input: CodeHealthProjectionInput): CodeHealthAssessment {
  validateInput(input);
  const repository = input.repository.toLowerCase();
  const pairs = CODE_HEALTH_SOURCE_KINDS.map(kind => {
    const scan = input.scans.find(source => source.kind === kind), prior = input.baseline?.scans.find(source => source.kind === kind);
    const current = new Map((scan?.findings ?? []).map(finding => [codeHealthFindingFingerprint(repository, kind, finding), finding]));
    const unconfirmedMissing = (prior?.findings ?? []).some(finding => finding.status !== "fixed" &&
      current.get(codeHealthFindingFingerprint(repository, kind, finding))?.status !== "open" &&
      !codeHealthFindingFixedAfter(current.get(codeHealthFindingFingerprint(repository, kind, finding)), prior!.observedAt));
    return { kind, scan, prior, current, unconfirmedMissing, problem: scanProblem(scan, input.analyzedSha, input.observedAt), pair: compareCodeHealthScanPair(input, scan, prior) };
  });
  const history = [...(input.baseline?.scans ?? []).map(scan => ({ policyVersion: input.baseline!.policyVersion, scan })), ...(input.retainedEvidence ?? [])]
    .sort((a, b) => b.scan.observedAt.localeCompare(a.scan.observedAt));
  const unresolvedHistory = history.flatMap(entry => {
    const pair = pairs.find(pair => pair.kind === entry.scan.kind)!;
    const comparable = compareCodeHealthScanPair({ ...input, baseline: { analyzedSha: entry.scan.analyzedSha, policyVersion: entry.policyVersion, scans: [entry.scan] } }, pair.scan, entry.scan) === "comparable";
    return entry.scan.findings.filter(finding => finding.status !== "fixed" &&
      (pair.current.get(codeHealthFindingFingerprint(repository, pair.kind, finding))?.status !== "open" ||
        !codeHealthSeverityAtLeast(pair.current.get(codeHealthFindingFingerprint(repository, pair.kind, finding))!.severity, finding.severity)) &&
      !(comparable && codeHealthFindingFixedAfter(pair.current.get(codeHealthFindingFingerprint(repository, pair.kind, finding)), entry.scan.observedAt)))
      .map(finding => ({ scan: entry.scan, finding }));
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
    const unavailable = pair.problem ?? (!check ? "This declared check was not measured." : check.met && pair.pair !== "comparable" ? "A passing comparison needs an independent scan with the same scope and policy." :
      check.met && (pair.unconfirmedMissing || unresolvedHistory.some(entry => entry.scan.kind === pair.kind)) ? "A previously known finding is missing or dismissed without a verified fix." : undefined);
    return { id: definition.id, category: definition.category, state: unavailable ? "not_measured" : check!.met ? "met" : "not_met",
      sourceIds: [sourceId(repository, definition.sourceKind)], reason: unavailable ?? check!.reason };
  });
  const findings = new Map<string, CodeHealthAssessment["findings"][number]>();
  for (const pair of pairs) for (const finding of pair.scan?.findings ?? []) {
    if (finding.status === "fixed") continue;
    const fingerprint = codeHealthFindingFingerprint(repository, pair.kind, finding);
    findings.set(fingerprint, { fingerprint, sourceId: sourceId(repository, pair.kind), severity: finding.severity, category: finding.category,
      status: pair.pair !== "comparable" ? "unknown" : pair.prior!.findings.some(old => old.status !== "fixed" && codeHealthFindingFingerprint(repository, pair.kind, old) === fingerprint) ? "existing" : "new",
      path: finding.path, title: finding.title, effortMinutes: finding.effortMinutes, estimateKind: finding.effortMinutes === null ? null : "modeled" });
  }
  for (const { scan: historical, finding: prior } of unresolvedHistory) {
    const fingerprint = codeHealthFindingFingerprint(repository, historical.kind, prior);
    const represented = findings.get(fingerprint);
    if (represented && codeHealthSeverityAtLeast(represented.severity, prior.severity)) continue;
    const historicalId = `${sourceId(repository, historical.kind)}:history:${createHash("sha256").update(JSON.stringify([historical.scanId, historical.analyzedSha, historical.observedAt])).digest("hex")}`;
    if (!sources.some(source => source.id === historicalId)) {
      const problem = scanProblem(historical, historical.analyzedSha, input.observedAt);
      sources.push({ id: historicalId, kind: historical.kind, required: false,
        state: problem ? historical.state === "complete" ? "partial" : historical.state : "complete",
        analyzedSha: shaShape.test(historical.analyzedSha) ? historical.analyzedSha : null,
        observedAt: time(historical.observedAt) && Date.parse(historical.observedAt) <= Date.parse(input.observedAt) ? historical.observedAt : null,
        scopeHash: historical.scopeHash, toolVersion: historical.toolVersion, rulesVersion: historical.rulesVersion, configHash: historical.configHash,
        baseline: null, exclusions: historical.exclusions, reason: problem ?? null });
    }
    findings.set(fingerprint, { fingerprint, sourceId: historicalId, severity: prior.severity, category: prior.category, status: "unknown",
      path: prior.path, title: prior.title, effortMinutes: prior.effortMinutes, estimateKind: prior.effortMinutes === null ? null : "modeled" });
  }
  if (findings.size > 1000) throw new Error("Code health findings exceed the public contract bound; prior evidence must remain available.");
  const met = checks.filter(check => check.state === "met").length, assessed = checks.filter(check => check.state !== "not_measured").length;
  const complete = pairs.every(pair => !pair.problem && pair.pair === "comparable") && checks.length > 0 && assessed === checks.length;
  const newerCode = input.currentSha.toLowerCase() !== input.analyzedSha.toLowerCase();
  const result: CodeHealthAssessment = { version: CODE_HEALTH_VERSION, repository, currentSha: input.currentSha.toLowerCase(), analyzedSha: input.analyzedSha.toLowerCase(),
    baselineSha: input.baseline && shaShape.test(input.baseline.analyzedSha) ? input.baseline.analyzedSha.toLowerCase() : null,
    policyVersion: input.registry.version, observedAt: input.observedAt, nextDueAt: input.nextDueAt,
    state: !input.scans.length ? "not_collected" : newerCode || pairs.some(pair => pair.scan?.state === "stale") ? "stale" : complete ? "measured" : "partial", sources, checks,
    findings: [...findings.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    summary: { met, assessed, expected: checks.length, healthy: newerCode ? null : checks.some(check => check.state === "not_met") ? false : complete && met === checks.length && !findings.size ? true : null } };
  const valid = validateCodeHealthAssessment(result);
  if (!valid.ok) throw new Error(`Code health projection refused: ${valid.reason}`);
  return result;
}

export function compareCodeHealthEvidence(input: CodeHealthProjectionInput): CodeHealthComparison {
  validateInput(input);
  const states = CODE_HEALTH_SOURCE_KINDS.map(kind => compareCodeHealthScanPair(input, input.scans.find(scan => scan.kind === kind), input.baseline?.scans.find(scan => scan.kind === kind)));
  const result: CodeHealthComparison = { state: states.includes("measurement_changed") ? "measurement_changed" : states.every(state => state === "comparable") ? "comparable" : "insufficient_evidence",
    newFindings: [], existingFindings: [], fixedFindings: [], unconfirmedMissingFindings: [], reason: "" };
  if (result.state !== "comparable") { result.reason = result.state === "measurement_changed" ? "The measurement scope, tool, rules or check policy changed." : "Independent complete scans for the same measured scope are unavailable."; return result; }
  const current = new Map(input.scans.flatMap(scan => scan.findings.map(finding => [codeHealthFindingFingerprint(input.repository, scan.kind, finding), finding] as const)));
  const previous = new Map(input.baseline!.scans.flatMap(scan => scan.findings.filter(finding => finding.status !== "fixed").map(finding => [codeHealthFindingFingerprint(input.repository, scan.kind, finding), { finding, observedAt: scan.observedAt }] as const)));
  for (const [id, finding] of current) if (finding.status === "open") (previous.has(id) ? result.existingFindings : result.newFindings).push(id);
  for (const [id, prior] of previous) {
    const finding = current.get(id);
    if (codeHealthFindingFixedAfter(finding, prior.observedAt)) result.fixedFindings.push(id);
    else if (finding?.status !== "open") result.unconfirmedMissingFindings.push(id);
  }
  if (result.unconfirmedMissingFindings.length) result.state = "insufficient_evidence";
  result.reason = result.state === "comparable" ? "The same source configuration independently confirms these finding states." : "A missing, dismissed, or already resolved finding does not establish a new fix in this comparison.";
  for (const field of [result.newFindings, result.existingFindings, result.fixedFindings, result.unconfirmedMissingFindings]) field.sort();
  return result;
}
