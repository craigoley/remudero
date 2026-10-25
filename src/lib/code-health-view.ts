import { fixedClock } from "./clock.js";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { projectCodeHealth } from "./code-health-projection.js";
import type { CodeHealthAssessment } from "./code-health-contract.js";
import { buildCodeHealthOpportunities, type CodeHealthImprovementOpportunity } from "./codeql-quality-intake.js";
import { codeHealthRepositoryStateDir, readCodeHealthArtifactJson, readCodeHealthCollectionFailure, readCodeHealthSnapshot, type CodeHealthCollectionFailureRead } from "./code-health-store.js";
import type { RepositoryEvidenceInventory } from "./daily-progress-contract.js";
import { readModelSidecarDir } from "./read-model-db.js";
import type { ReadModelView } from "./read-model-worker.js";
import { judgeSource } from "./view-freshness.js";
import { viewKey, type ViewBodySource, type ViewRequestFailure, type ViewSource } from "./views.js";

export const CODE_HEALTH_VIEW_NAME = "code-health";
export const CODE_HEALTH_SCOPE_KEY = "__code_health_scope";
/** PRIMARY CONTROL: collection follows the existing daily quality/coverage cadence, never page demand. */
export const CODE_HEALTH_INTERVAL_MS = 86_400_000;
/** BACKSTOP: transport pages bound bytes and findings, not the counted evidence population. */
export const CODE_HEALTH_PAGE_BYTES = 1024 * 1024;
const PAGE_FINDINGS = 100;
const SCOPE_BUDGET_MS = 180_000;
class CodeHealthNotReady extends RmdError {
  constructor(message: string) { super("read-model", GENERIC_EXIT_CODE, message); }
}
interface Page { s: string; o: number; k: string }
interface Request { repository: string; snapshot?: string; page?: Page }
const qualifiedRepo = (value: string): boolean => /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(value) && ![".", ".."].includes(value.split("/")[1]!);
function request(params: URLSearchParams): Request {
  for (const name of params.keys()) if (!["repository", "snapshot", "page"].includes(name) || params.getAll(name).length !== 1) throw new RangeError("Unknown or repeated Code health parameter.");
  const repository = (params.get("repository") ?? "all").toLowerCase(), snapshot = params.get("snapshot") ?? undefined;
  if (repository !== "all" && !qualifiedRepo(repository)) throw new RangeError("Unknown repository.");
  if (snapshot !== undefined && !/^[a-f0-9]{64}$/.test(snapshot)) throw new RangeError("Invalid Code health snapshot.");
  const raw = params.get("page"); let page: Page | undefined;
  if (raw !== null) {
    if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new RangeError("Invalid Code health page.");
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Page;
    if (!parsed || Object.keys(parsed).sort().join(",") !== "k,o,s" || !/^[a-f0-9]{64}$/.test(parsed.s) || !/^[a-f0-9]{64}$/.test(parsed.k) || !Number.isSafeInteger(parsed.o) || parsed.o <= 0 || parsed.o > 1000 || !snapshot || parsed.s !== snapshot)
      throw new RangeError("Code health page needs its original snapshot.");
    page = parsed;
  }
  if (repository === "all" && (snapshot || page)) throw new RangeError("Select a repository to read a saved snapshot or page.");
  return { repository, snapshot, page };
}
function pageScope(repository: string, snapshot: string): string { return createHash("sha256").update(`${repository}\0${snapshot}`).digest("hex"); }

/** Server-owned roster; absent configuration never becomes an empty measured portfolio. */
export function readCodeHealthInventory(stateDir: string): RepositoryEvidenceInventory {
  const raw = readCodeHealthArtifactJson(join(stateDir, "read-model", "repositories-sources.json"), 2 * 1024 * 1024) as { improvementEvidence?: RepositoryEvidenceInventory };
  const value = raw?.improvementEvidence;
  if (!value || value.version !== "repository-evidence-inventory-v1" || !Array.isArray(value.repositories) || value.repositories.length > 256 || !Array.isArray(value.unresolvedInstances) || value.unresolvedInstances.length > 256 ||
      !value.unresolvedInstances.every(id => typeof id === "string" && id.length > 0 && id.length <= 128) ||
      !value.repositories.every(repo => typeof repo.repository === "string" && qualifiedRepo(repo.repository) && Array.isArray(repo.instanceIds) && repo.instanceIds.length > 0 && repo.instanceIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 128) && Array.isArray(repo.expectedQualitySources) && ["quality", "coverage"].every(kind => repo.expectedQualitySources.includes(kind))) ||
      new Set(value.repositories.map(repo => repo.repository)).size !== value.repositories.length || !value.repositories.length)
    throw new CodeHealthNotReady("Code health is waiting for the configured repository list.");
  return value;
}
type UrgentCount = { value: number | null; precision: "exact" | "at_least" | "unavailable"; scope: string };
interface RepositorySummary {
  repository: string; snapshotId: string | null; state: CodeHealthAssessment["state"] | "unauthorized" | "rate_limited";
  summary: CodeHealthAssessment["summary"] | null; urgentFindings: UrgentCount;
  measuredAt: string | null; analyzedSha: string | null; currentSha: string | null;
  freshness: "fresh" | "stale" | "unavailable"; lastAttemptAt: string | null; nextCheckDueAt: string | null;
  collection: CodeHealthCollectionFailureRead; reason: string | null;
}
export interface CodeHealthViewData {
  version: "code-health-view-v1"; repository: string; expectedRepositories: string[]; unresolvedInstances: string[];
  repositories: RepositorySummary[]; snapshotId: string | null; assessment: CodeHealthAssessment | null;
  findingCount: number | null; urgentFindings: UrgentCount; opportunities: CodeHealthImprovementOpportunity[];
  relatedWorkState: "not_collected"; planningAvailable: boolean; freshness: "fresh" | "stale" | "unavailable";
  page: { nextCursor: string | null };
}
const unknownUrgent = (): UrgentCount => ({ value: null, precision: "unavailable", scope: "Findings in the measured quality scope; this is not a complete security assessment." });
function repositoryReport(stateDir: string, repository: string, now: number, snapshotId?: string): { summary: RepositorySummary; assessment: CodeHealthAssessment | null; opportunities: CodeHealthImprovementOpportunity[]; sources: ViewSource[] } {
  const repoState = codeHealthRepositoryStateDir(stateDir, repository), read = readCodeHealthSnapshot(repoState, repository, snapshotId);
  const collection = readCodeHealthCollectionFailure(repoState, repository);
  const access = collection.state === "failed" ? collection.failureKind : undefined;
  if (snapshotId && read.state !== "observed") throw new CodeHealthNotReady("The selected repository snapshot is unavailable.");
  if (read.state !== "observed") return { summary: { repository, snapshotId: null, state: access === "unauthorized" || access === "rate_limited" ? access : read.state,
    summary: null, urgentFindings: unknownUrgent(), measuredAt: null, analyzedSha: null, currentSha: null, freshness: "unavailable", lastAttemptAt: collection.state === "failed" ? collection.startedAt : null,
    nextCheckDueAt: null, collection, reason: read.reason }, assessment: null, opportunities: [], sources: [{ name: `repositories:code-health:${repository}`, kind: "repositories", asOf: null, state: "unavailable", reason: read.reason, budgetMs: CODE_HEALTH_INTERVAL_MS }] };
  const assessment = projectCodeHealth(read.snapshot.input);
  const sources = assessment.sources.filter(source => source.required).map((source): ViewSource => judgeSource({ name: `repositories:code-health:${repository}:${source.id}`, kind: "repositories", asOf: source.observedAt,
    state: source.state === "complete" ? "fresh" : source.state === "stale" ? "stale" : "unavailable", budgetMs: CODE_HEALTH_INTERVAL_MS,
    ...(source.reason ? { reason: source.reason } : {}) }, now));
  if (collection.state !== "none") sources.push({ name: `repositories:code-health-refresh:${repository}`, kind: "repositories", asOf: collection.state === "failed" ? collection.finishedAt : null, state: "unavailable", reason: collection.reason });
  const freshness = sources.some(source => source.state === "unavailable") ? "unavailable" : sources.some(source => source.state === "stale") ? "stale" : "fresh";
  const qualityComplete = assessment.sources.some(source => source.kind === "quality" && source.required && source.state === "complete" && source.analyzedSha === assessment.currentSha);
  const urgent = assessment.findings.filter(finding => finding.severity === "high" || finding.severity === "critical").length;
  const urgentFindings: UrgentCount = { value: qualityComplete || urgent > 0 ? urgent : null, precision: qualityComplete ? "exact" : urgent > 0 ? "at_least" : "unavailable", scope: unknownUrgent().scope };
  const lastAttemptAt = collection.state === "failed" ? collection.startedAt : read.latestAttemptAt;
  return { assessment, opportunities: buildCodeHealthOpportunities(read.snapshot.input), sources, summary: { repository, snapshotId: read.snapshot.snapshotId, state: access === "unauthorized" || access === "rate_limited" ? access : assessment.state,
    summary: assessment.summary, urgentFindings, measuredAt: assessment.observedAt, analyzedSha: assessment.analyzedSha, currentSha: assessment.currentSha, freshness,
    lastAttemptAt, nextCheckDueAt: lastAttemptAt ? fixedClock(Date.parse(lastAttemptAt) + CODE_HEALTH_INTERVAL_MS).iso() : null, collection, reason: collection.state === "none" ? null : collection.reason } };
}

/** Worker-only cached reads. No network, scanner, model, ranking or filing runs here. */
export function readCodeHealthReport(opts: { stateDir: string; params: URLSearchParams; now: number }): { data: CodeHealthViewData; sources: ViewSource[] } {
  const input = request(opts.params), inventory = readCodeHealthInventory(opts.stateDir), expected = inventory.repositories.map(repo => repo.repository).sort();
  if (input.repository !== "all" && !expected.includes(input.repository)) throw new RangeError("Unknown repository.");
  if (input.page && input.page.k !== pageScope(input.repository, input.snapshot!)) throw new RangeError("Code health page belongs to another repository scope.");
  const selected = input.repository === "all" ? expected : [input.repository];
  const reports = selected.map(repo => repositoryReport(opts.stateDir, repo, opts.now, input.snapshot));
  const report = input.repository === "all" ? null : reports[0]!;
  const data: CodeHealthViewData = { version: "code-health-view-v1", repository: input.repository, expectedRepositories: expected, unresolvedInstances: inventory.unresolvedInstances,
    repositories: reports.map(value => value.summary), snapshotId: report?.summary.snapshotId ?? null, assessment: report?.assessment ? { ...report.assessment, findings: [] } : null,
    findingCount: report?.assessment?.findings.length ?? null, urgentFindings: report?.summary.urgentFindings ?? unknownUrgent(), opportunities: [], relatedWorkState: "not_collected",
    planningAvailable: false, freshness: report?.summary.freshness ?? (reports.every(value => value.summary.freshness === "fresh") && !inventory.unresolvedInstances.length ? "fresh" : "unavailable"), page: { nextCursor: null } };
  if (report?.assessment && data.assessment) {
    const offset = input.page?.o ?? 0, findings = report.assessment.findings;
    if (offset >= findings.length && offset !== 0) throw new RangeError("Code health page is outside its saved evidence.");
    data.planningAvailable = report.summary.freshness === "fresh" && report.summary.collection.state === "none" && report.opportunities.some(opportunity => opportunity.mayPlan);
    if (Buffer.byteLength(JSON.stringify(data)) + 1024 > CODE_HEALTH_PAGE_BYTES) throw new CodeHealthNotReady("Code health source details exceed the response bound.");
    for (const finding of findings.slice(offset, offset + PAGE_FINDINGS)) {
      const next = [...data.assessment.findings, finding], fingerprints = new Set(next.map(value => value.fingerprint));
      const opportunities = report.opportunities.filter(opportunity => opportunity.evidence.some(value => fingerprints.has(value.fingerprint))).map(opportunity => ({ ...opportunity,
        mayPlan: data.planningAvailable && opportunity.mayPlan, evidence: opportunity.evidence.filter(value => fingerprints.has(value.fingerprint)) }));
      if (Buffer.byteLength(JSON.stringify({ ...data, assessment: { ...data.assessment, findings: next }, opportunities })) + 1024 > CODE_HEALTH_PAGE_BYTES) break;
      data.assessment.findings = next; data.opportunities = opportunities;
    }
    if (offset + data.assessment.findings.length < findings.length) {
      if (!data.assessment.findings.length) throw new CodeHealthNotReady("One Code health finding exceeds the response bound.");
      data.page.nextCursor = Buffer.from(JSON.stringify({ s: data.snapshotId, o: offset + data.assessment.findings.length, k: pageScope(input.repository, data.snapshotId!) })).toString("base64url");
    }
  }
  if (Buffer.byteLength(JSON.stringify(data)) > CODE_HEALTH_PAGE_BYTES) throw new CodeHealthNotReady("Code health exceeds the response bound; select a repository.");
  return { data, sources: [{ name: "repositories:code-health-scope", kind: "repositories", asOf: fixedClock(opts.now).iso(), state: "fresh", budgetMs: SCOPE_BUDGET_MS }, ...reports.flatMap(value => value.sources)] };
}

/** Memory-only scope and page checks run before a held ETag may answer. */
export function validateCodeHealthRequest(params: URLSearchParams, source?: ViewBodySource, now?: number): ViewRequestFailure | undefined {
  try {
    const input = request(params); if (!source) return undefined;
    const held = source.body(CODE_HEALTH_VIEW_NAME, CODE_HEALTH_SCOPE_KEY), roster = held?.body.data as CodeHealthViewData | undefined;
    if (!roster || roster.version !== "code-health-view-v1" || roster.repository !== "all" || !Array.isArray(roster.expectedRepositories) ||
        now !== undefined && !held!.body.sources.some(value => value.name === "repositories:code-health-scope" && value.asOf !== null && now - Date.parse(value.asOf) <= SCOPE_BUDGET_MS)) {
      source.want?.(CODE_HEALTH_VIEW_NAME, ""); return { error: "view_not_ready", status: 503, detail: "Code health is waiting for the configured repository list." };
    }
    if (input.repository !== "all" && !roster.expectedRepositories.includes(input.repository)) throw new RangeError("Unknown repository.");
    if (input.page && input.page.k !== pageScope(input.repository, input.snapshot!)) throw new RangeError("Code health page belongs to another repository scope.");
    const key = viewKey(params), entry = source.body(CODE_HEALTH_VIEW_NAME, key)?.body.data as CodeHealthViewData | undefined;
    if (!entry || entry.repository !== input.repository || input.snapshot && entry.snapshotId !== input.snapshot || JSON.stringify(entry.expectedRepositories) !== JSON.stringify(roster.expectedRepositories)) {
      source.want?.(CODE_HEALTH_VIEW_NAME, key); return { error: "view_not_ready", status: 503, detail: "Code health is preparing the selected saved results." };
    }
    return undefined;
  } catch (error) { return error instanceof RangeError || error instanceof SyntaxError ? { error: "invalid_request", status: 400, detail: error instanceof RangeError ? error.message : "Invalid Code health page." } : { error: "view_not_ready", status: 503, detail: "Code health scope is unavailable." }; }
}
export function createCodeHealthView(opts: { stateDir?: string; keys?: () => string[] } = {}): ReadModelView {
  return { name: CODE_HEALTH_VIEW_NAME, version: 1, demand: true, materialize(ctx) {
    const stateDir = opts.stateDir ?? (ctx.sourceStore ? dirname(readModelSidecarDir(dirname(ctx.sourceStore.path))) : undefined);
    if (!stateDir) throw new CodeHealthNotReady("Code health durable state is unavailable.");
    return [...new Set(["", ...opts.keys?.() ?? []])].flatMap(key => {
      try { const built = readCodeHealthReport({ stateDir, params: new URLSearchParams(key), now: ctx.now }); return [{ key, ...built }, ...(key === "" ? [{ key: CODE_HEALTH_SCOPE_KEY, ...built }] : [])]; }
      catch (error) { if (error instanceof CodeHealthNotReady || error instanceof RangeError || error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    });
  } };
}
