import { CODE_HEALTH_POLICY_VERSION } from "./code-health-collector.js";
import { fixedClock } from "./clock.js";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { projectCodeHealth, type CodeHealthProjectionInput } from "./code-health-projection.js";
import type { CodeHealthAssessment } from "./code-health-contract.js";
import { buildCodeHealthOpportunities, qualifiedCodeHealthPlanningSource, type CodeHealthImprovementOpportunity } from "./codeql-quality-intake.js";
import { CODE_HEALTH_INTERVAL_MS, readCodeHealthInventory, readCodeHealthRelatedWork, isCodeHealthRepository as qualifiedRepo, codeHealthRepositoryStateDir, improvementOutcomeStateDir, readCodeHealthArtifactJson, readCodeHealthCollectionFailure, readCodeHealthSnapshot, type CodeHealthCollectionFailureRead } from "./code-health-store.js";
import type { RepositoryEvidenceInventory } from "./daily-progress-contract.js";
import { readModelSidecarDir, type ReadModelDb } from "./read-model-db.js";
import { OPPORTUNITY_EVIDENCE_FILE, OPPORTUNITY_EVIDENCE_MAX_BYTES, projectGardenerOpportunityEvidence, projectCodeHealthImprovementFollowUp, unavailableOpportunityEvidence, type CodeHealthImprovementFollowUp, type GardenerOpportunityEvidence } from "./gardener-opportunity-evidence.js";
import { judgeSource } from "./view-freshness.js";
import { viewKey, type ViewBodySource, type ViewRequestFailure, type ViewSource } from "./views.js";

export const CODE_HEALTH_VIEW_NAME = "code-health";
export const CODE_HEALTH_SCOPE_KEY = "__code_health_scope";
/** PRIMARY CONTROL: collection follows the existing daily quality/coverage cadence, never page demand. */
export { CODE_HEALTH_INTERVAL_MS, readCodeHealthInventory, readCodeHealthRelatedWork } from "./code-health-store.js";
/** BACKSTOP: transport pages bound bytes and findings, not the counted evidence population. */
export const CODE_HEALTH_PAGE_BYTES = 1024 * 1024;
const PAGE_FINDINGS = 100;
const SCOPE_BUDGET_MS = 180_000;
class CodeHealthNotReady extends RmdError {
  constructor(message: string) { super("read-model", GENERIC_EXIT_CODE, message); }
}
interface Page { s: string; o: number; k: string }
interface Request { repository: string; snapshot?: string; page?: Page }
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

type UrgentCount = { value: number | null; precision: "exact" | "at_least" | "unavailable"; scope: string };
interface RepositorySummary {
  repository: string; snapshotId: string | null; state: CodeHealthAssessment["state"] | "unauthorized" | "rate_limited";
  summary: CodeHealthAssessment["summary"] | null; urgentFindings: UrgentCount;
  measuredAt: string | null; analyzedSha: string | null; currentSha: string | null;
  freshness: "fresh" | "stale" | "unavailable"; lastAttemptAt: string | null; nextCheckDueAt: string | null;
  collection: CodeHealthCollectionFailureRead; reason: string | null;
  sourceClocks: Array<{ kind: string; state: string; measuredAt: string | null; analyzedSha: string | null }>;
}
export interface CodeHealthViewData {
  version: "code-health-view-v1"; repository: string; expectedRepositories: string[]; unresolvedInstances: string[];
  repositories: RepositorySummary[]; snapshotId: string | null; isCurrentSnapshot: boolean | null; assessment: CodeHealthAssessment | null;
  improvementFollowUp: CodeHealthImprovementFollowUp | null;
  findingCount: number | null; urgentFindings: UrgentCount; opportunities: CodeHealthImprovementOpportunity[];
  relatedWorkState: "reported" | "partial" | "stale" | "unavailable" | "not_collected"; relatedWorkAsOf: string | null; relatedWorkReason: string | null; planningAvailable: boolean; freshness: "fresh" | "stale" | "unavailable";
  page: { nextCursor: string | null };
}
const unknownUrgent = (): UrgentCount => ({ value: null, precision: "unavailable", scope: "Known urgent findings, including earlier findings whose current status is unknown. This is not a complete security assessment." });
function repositoryReport(stateDir: string, repository: string, now: number, snapshotId?: string, summaryOnly = false): { summary: RepositorySummary; input: CodeHealthProjectionInput | null; isCurrentSnapshot: boolean; assessment: CodeHealthAssessment | null; opportunities: CodeHealthImprovementOpportunity[]; sources: ViewSource[] } {
  const repoState = codeHealthRepositoryStateDir(stateDir, repository), latest = readCodeHealthSnapshot(repoState, repository);
  const read = snapshotId ? readCodeHealthSnapshot(repoState, repository, snapshotId) : latest;
  const sourceFailure = latest.state === "observed" ? latest.snapshot.input.scans.find(scan => scan.failureKind) : undefined;
  const collection = readCodeHealthCollectionFailure(repoState, repository);
  const access = collection.state === "failed" ? collection.failureKind : sourceFailure?.failureKind;
  if (snapshotId && read.state !== "observed") throw new CodeHealthNotReady("The selected repository snapshot is unavailable.");
  if (read.state !== "observed") return { summary: { repository, snapshotId: null, state: access === "unauthorized" || access === "rate_limited" ? access : read.state,
    summary: null, sourceClocks: [], urgentFindings: unknownUrgent(), measuredAt: null, analyzedSha: null, currentSha: null, freshness: "unavailable", lastAttemptAt: collection.state === "failed" ? collection.startedAt : null,
    nextCheckDueAt: null, collection, reason: read.reason }, input: null, isCurrentSnapshot: false, assessment: null, opportunities: [], sources: [{ name: `repositories:code-health:${repository}`, kind: "repositories", asOf: null, state: "unavailable", reason: read.reason, budgetMs: CODE_HEALTH_INTERVAL_MS }] };
  const assessment = projectCodeHealth(read.snapshot.input);
  const sources = assessment.sources.filter(source => source.required).map((source): ViewSource => judgeSource({ name: `repositories:code-health:${repository}:${source.id}`, kind: "repositories", asOf: source.observedAt,
    state: source.state === "complete" ? "fresh" : source.state === "stale" ? "stale" : "unavailable", budgetMs: CODE_HEALTH_INTERVAL_MS,
    ...(source.reason ? { reason: source.reason } : {}) }, now));
  if (collection.state !== "none") sources.push({ name: `repositories:code-health-refresh:${repository}`, kind: "repositories", asOf: collection.state === "failed" ? collection.finishedAt : null, state: "unavailable", reason: collection.reason });
  if (collection.state === "none" && sourceFailure) sources.push({ name: `repositories:code-health-read:${repository}`, kind: "repositories", asOf: latest.state === "observed" ? latest.latestAttemptAt : null, state: "unavailable", reason: sourceFailure.reason ?? "Some code-check results could not be read." });
  const freshness = sources.some(source => source.state === "unavailable") ? "unavailable" : sources.some(source => source.state === "stale") ? "stale" : "fresh";
  const qualityComplete = assessment.sources.some(source => source.kind === "quality" && source.required && source.state === "complete" && source.analyzedSha === assessment.currentSha);
  const urgentEvidence = assessment.findings.filter(finding => finding.severity === "high" || finding.severity === "critical");
  const currentQualitySources = new Set(assessment.sources.filter(source => source.required && source.kind === "quality" && source.analyzedSha === assessment.currentSha).map(source => source.id));
  const exactUrgent = qualityComplete && urgentEvidence.every(finding => currentQualitySources.has(finding.sourceId));
  const urgent = urgentEvidence.length;
  const urgentFindings: UrgentCount = { value: exactUrgent || urgent > 0 ? urgent : null, precision: exactUrgent ? "exact" : urgent > 0 ? "at_least" : "unavailable", scope: unknownUrgent().scope };
  const lastAttemptAt = collection.state === "failed" ? collection.startedAt : latest.state === "observed" ? latest.latestAttemptAt : null;
  return { input: summaryOnly ? null : read.snapshot.input, isCurrentSnapshot: latest.state === "observed" && latest.snapshot.snapshotId === read.snapshot.snapshotId, assessment: summaryOnly ? null : assessment, opportunities: summaryOnly ? [] : buildCodeHealthOpportunities(read.snapshot.input), sources, summary: { repository, snapshotId: read.snapshot.snapshotId, state: access === "unauthorized" || access === "rate_limited" ? access : assessment.state,
    summary: assessment.summary, sourceClocks: assessment.sources.filter(source => source.required).map(source => ({ kind: source.kind, state: source.state, measuredAt: source.observedAt, analyzedSha: source.analyzedSha })), urgentFindings, measuredAt: assessment.observedAt, analyzedSha: assessment.analyzedSha, currentSha: assessment.currentSha, freshness,
    lastAttemptAt, nextCheckDueAt: lastAttemptAt ? fixedClock(Date.parse(lastAttemptAt) + CODE_HEALTH_INTERVAL_MS).iso() : null, collection, reason: collection.state === "none" ? sourceFailure?.reason ?? null : collection.reason } };
}

/** Worker-only cached reads. No network, scanner, model, ranking or filing runs here. */
export function readCodeHealthReport(opts: { stateDir: string; params: URLSearchParams; now: number }): { data: CodeHealthViewData; sources: ViewSource[] } {
  const input = request(opts.params), inventory = readCodeHealthInventory(opts.stateDir), expected = inventory.repositories.map(repo => repo.repository).sort();
  if (input.repository !== "all" && !expected.includes(input.repository)) throw new RangeError("Unknown repository.");
  if (input.page && input.page.k !== pageScope(input.repository, input.snapshot!)) throw new RangeError("Code health page belongs to another repository scope.");
  const selected = input.repository === "all" ? expected : [input.repository];
  const reports = selected.map(repo => repositoryReport(opts.stateDir, repo, opts.now, input.snapshot, input.repository === "all"));
  const report = input.repository === "all" ? null : reports[0]!;
  const data: CodeHealthViewData = { version: "code-health-view-v1", repository: input.repository, expectedRepositories: expected, unresolvedInstances: inventory.unresolvedInstances,
    repositories: reports.map(value => value.summary), snapshotId: report?.summary.snapshotId ?? null, isCurrentSnapshot: report?.isCurrentSnapshot ?? null, assessment: report?.assessment ? { ...report.assessment, findings: [] } : null,
    findingCount: report?.assessment?.findings.length ?? null, urgentFindings: report?.summary.urgentFindings ?? unknownUrgent(), opportunities: [], relatedWorkState: "not_collected", relatedWorkAsOf: null, relatedWorkReason: "Saved related work has not been collected for this view.",
    improvementFollowUp: input.repository === "all" ? null : readCodeHealthImprovementFollowUp(opts.stateDir, inventory, input.repository, opts.now),
    planningAvailable: false, freshness: report?.summary.freshness ?? (reports.every(value => value.summary.freshness === "fresh") && !inventory.unresolvedInstances.length ? "fresh" : "unavailable"), page: { nextCursor: null } };
  if (report?.assessment && data.assessment) {
    const related = readCodeHealthRelatedWork(opts.stateDir, inventory, input.repository, opts.now);
    data.relatedWorkState = related.state; data.relatedWorkAsOf = related.asOf; data.relatedWorkReason = related.reason;
    // These are saved work links, not newly verified delivery or benefit receipts.
    report.opportunities = buildCodeHealthOpportunities(report.input!, related.work);
    const offset = input.page?.o ?? 0, findings = report.assessment.findings;
    if (offset >= findings.length && offset !== 0) throw new RangeError("Code health page is outside its saved evidence.");
    const quality = qualifiedCodeHealthPlanningSource(report.input!, opts.now, CODE_HEALTH_POLICY_VERSION);
    data.planningAvailable = report.isCurrentSnapshot && report.summary.collection.state === "none" && quality !== null && report.opportunities.some(opportunity => opportunity.mayPlan);
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
  const evidence = reports.flatMap(value => value.sources);
  const state = evidence.some(source => source.state === "unavailable") || inventory.unresolvedInstances.length ? "unavailable" : evidence.some(source => source.state === "stale") ? "stale" : "fresh";
  if (input.repository === "all") data.freshness = state;
  const clocks = evidence.flatMap(source => source.asOf ? [source.asOf] : []).sort();
  const sources: ViewSource[] = input.repository === "all" ? [{ name: "repositories:code-health-portfolio", kind: "repositories", asOf: clocks[0] ?? null, state, budgetMs: CODE_HEALTH_INTERVAL_MS,
    ...(state === "fresh" ? {} : { reason: "Some configured code-check sources are missing, older, or could not be refreshed. Each repository shows its own status and measurement times." }) }] : evidence;
  return { data, sources: [{ name: "repositories:code-health-scope", kind: "repositories", asOf: fixedClock(opts.now).iso(), state: "fresh", budgetMs: SCOPE_BUDGET_MS }, ...sources] };
}

/** Memory-only scope and page checks run before a held ETag may answer. */
export function validateCodeHealthRequest(params: URLSearchParams, source?: ViewBodySource, now?: number): ViewRequestFailure | undefined {
  try {
    const input = request(params); if (!source) return undefined;
    const held = source.body(CODE_HEALTH_VIEW_NAME, CODE_HEALTH_SCOPE_KEY), roster = held?.body.data as CodeHealthViewData | undefined;
    if (!roster || roster.version !== "code-health-view-v1" || roster.repository !== "all" || !Array.isArray(roster.expectedRepositories) ||
        now !== undefined && !source.judge(held!.body.sources, now, held!).some(value => {
          if (value.name !== "repositories:code-health-scope" || value.state !== "fresh" || value.asOf === null) return false;
          const observedAt = Date.parse(value.asOf);
          return Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= SCOPE_BUDGET_MS;
        })) {
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
export function createCodeHealthView(opts: { stateDir?: string; keys?: () => string[] } = {}): {
  name: string; version: number; demand: true;
  materialize(ctx: { now: number; sourceStore?: ReadModelDb; instances: ReadonlyArray<unknown> }): Array<{ key: string; data: CodeHealthViewData; sources: ViewSource[] }>;
} {
  return { name: CODE_HEALTH_VIEW_NAME, version: 1, demand: true, materialize(ctx) {
    const stateDir = opts.stateDir ?? (ctx.sourceStore ? dirname(readModelSidecarDir(dirname(ctx.sourceStore.path))) : undefined);
    if (!stateDir) throw new CodeHealthNotReady("Code health durable state is unavailable.");
    return [...new Set(["", ...opts.keys?.() ?? []])].flatMap(key => {
      try { const built = readCodeHealthReport({ stateDir, params: new URLSearchParams(key), now: ctx.now }); return [{ key, ...built }, ...(key === "" ? [{ key: CODE_HEALTH_SCOPE_KEY, ...built }] : [])]; }
      catch (error) { if (error instanceof CodeHealthNotReady || error instanceof RangeError || error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    });
  } };
}

/** Cached evidence only. Scope is the configured roster; page loads never remeasure or file work. */
export function readCodeHealthImprovementFollowUp(stateDir: string, inventory: RepositoryEvidenceInventory, repository: string, now: number): CodeHealthImprovementFollowUp {
  const member = inventory.repositories.find(value => value.repository === repository);
  if (!member) throw new RangeError("Unknown improvement repository.");
  if (member.instanceIds.length > 256) throw new CodeHealthNotReady("The configured improvement sources exceed this read's bound.");
  const clock = fixedClock(now), repoState = codeHealthRepositoryStateDir(stateDir, repository), latest = readCodeHealthSnapshot(repoState, repository);
  const failed = readCodeHealthCollectionFailure(repoState, repository);
  function* scopes(): Generator<{ instance: string; evidence: GardenerOpportunityEvidence }> {
    for (const instance of member!.instanceIds) {
      let evidence: GardenerOpportunityEvidence;
      try { evidence = projectGardenerOpportunityEvidence(readCodeHealthArtifactJson(join(improvementOutcomeStateDir(stateDir, repository, instance), OPPORTUNITY_EVIDENCE_FILE), OPPORTUNITY_EVIDENCE_MAX_BYTES), repository, clock); }
      catch (error) {
        // Preserve absent versus malformed/unreadable source status; neither becomes a measured zero.
        evidence = unavailableOpportunityEvidence(repository, clock, (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_collected" : error instanceof SyntaxError ? "malformed" : "unreadable");
      }
      yield { instance, evidence };
    }
  }
  return projectCodeHealthImprovementFollowUp(scopes(), member.instanceIds.length, {
    snapshotId: latest.state === "observed" ? latest.snapshot.snapshotId : null,
    analyzedSha: latest.state === "observed" ? latest.snapshot.input.analyzedSha : null,
    currentSha: latest.state === "observed" ? latest.snapshot.input.currentSha : null,
    collectionUnavailable: failed.state === "unavailable",
    collectionFailed: failed.state === "failed" || latest.state === "observed" && latest.snapshot.input.scans.some(scan => scan.failureKind !== undefined),
  });
}
