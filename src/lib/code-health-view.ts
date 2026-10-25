import { parseProposalRegistryResult } from "./inbox.js";
import { inboxThreadId } from "./inbox-thread.js";
import { fixedClock } from "./clock.js";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { GENERIC_EXIT_CODE, RmdError } from "./errors.js";
import { projectCodeHealth, type CodeHealthProjectionInput } from "./code-health-projection.js";
import type { CodeHealthAssessment } from "./code-health-contract.js";
import { buildCodeHealthOpportunities, type CodeHealthImprovementOpportunity, type CodeHealthRelatedWork } from "./codeql-quality-intake.js";
import { codeHealthRepositoryStateDir, improvementOutcomeStateDir, readCodeHealthArtifactJson, readCodeHealthCollectionFailure, readCodeHealthSnapshot, type CodeHealthCollectionFailureRead } from "./code-health-store.js";
import { validateRepositoryEvidenceInventory, type RepositoryEvidenceInventory } from "./daily-progress-contract.js";
import { readModelSidecarDir } from "./read-model-db.js";
import type { ReadModelView } from "./read-model-worker.js";
import { OPPORTUNITY_EVIDENCE_FILE, OPPORTUNITY_EVIDENCE_MAX_BYTES, projectGardenerOpportunityEvidence } from "./gardener-opportunity-evidence.js";
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
function repositoryPullRequestUrl(value: unknown, repository: string): value is string {
  const prefix = `https://github.com/${repository}/pull/`;
  return typeof value === "string" && value.slice(0, prefix.length).toLowerCase() === prefix && /^[1-9][0-9]*$/.test(value.slice(prefix.length));
}
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
  const checked = validateRepositoryEvidenceInventory(raw?.improvementEvidence);
  if (!checked.ok || !checked.value.repositories.length || checked.value.repositories.length > 256 || checked.value.unresolvedInstances.length > 256 ||
      checked.value.repositories.some(repo => !qualifiedRepo(repo.repository))) throw new CodeHealthNotReady("Code health is waiting for the configured repository list.");
  return checked.value;
}
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
    planningAvailable: false, freshness: report?.summary.freshness ?? (reports.every(value => value.summary.freshness === "fresh") && !inventory.unresolvedInstances.length ? "fresh" : "unavailable"), page: { nextCursor: null } };
  if (report?.assessment && data.assessment) {
    const related = readCodeHealthRelatedWork(opts.stateDir, inventory, input.repository, opts.now);
    data.relatedWorkState = related.state; data.relatedWorkAsOf = related.asOf; data.relatedWorkReason = related.reason;
    // These are saved work links, not newly verified delivery or benefit receipts.
    report.opportunities = buildCodeHealthOpportunities(report.input!, related.work);
    const offset = input.page?.o ?? 0, findings = report.assessment.findings;
    if (offset >= findings.length && offset !== 0) throw new RangeError("Code health page is outside its saved evidence.");
    data.planningAvailable = report.isCurrentSnapshot && report.summary.freshness === "fresh" && report.summary.collection.state === "none" && report.opportunities.some(opportunity => opportunity.mayPlan);
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


export function readCodeHealthRelatedWork(stateDir: string, inventory: RepositoryEvidenceInventory, repository: string, now: number): {
  state: CodeHealthViewData["relatedWorkState"]; asOf: string | null; work: CodeHealthRelatedWork[]; reason: string | null;
} {
  const work: CodeHealthRelatedWork[] = [], clocks: string[] = []; let missing = 0, invalid = 0, stale = false;
  const member = inventory.repositories.find(repo => repo.repository === repository)!;
  try {
    const publisher = readCodeHealthArtifactJson(join(stateDir, "read-model", "repositories-sources.json"), 2 * 1024 * 1024) as { instances?: Array<{ instanceId: string; options?: { ledgerPath?: string; controlRoot?: string } }> };
    if (publisher === null || publisher === undefined || !Array.isArray(publisher.instances) || publisher.instances.length > 256) throw new Error("Saved work scope is unavailable.");
    for (const instanceId of member.instanceIds) {
      const instances = publisher.instances.filter(instance => instance?.instanceId === instanceId), path = instances[0]?.options?.ledgerPath;
      if (instances.length !== 1 || typeof path !== "string" || path.length > 4096 || path.includes("\0") || !isAbsolute(path)) { missing++; continue; }
      const options = instances[0]!.options;
      if (typeof options?.controlRoot === "string" && options.controlRoot.length <= 4096 && !options.controlRoot.includes("\0") && isAbsolute(options.controlRoot)) {
        try {
          const raw = readCodeHealthArtifactJson(join(options.controlRoot, "state", "inbox-proposals.json"), 2 * 1024 * 1024), parsed = parseProposalRegistryResult(JSON.stringify(raw));
          if (parsed.kind !== "ok" || parsed.proposals.length > 2048) throw new Error("Saved planning links are unavailable.");
          for (const row of parsed.proposals) {
            const saved = (row as unknown as { improvement?: { version?: string; repository?: string; instance?: string; opportunityId?: string; snapshotId?: string; requestId?: string; goalDigest?: string; conversationReady?: boolean; threadId?: string } }).improvement;
            if (!saved || saved.version !== "improvement-thread-v1" || saved.conversationReady !== true || saved.repository !== repository || saved.instance !== instanceId ||
                typeof saved.opportunityId !== "string" || !saved.opportunityId.startsWith(`${repository}/codeql-quality:`) || saved.opportunityId.length > 1024 ||
                ![saved.snapshotId, saved.requestId, saved.goalDigest].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) continue;
            const proposalId = saved.opportunityId.slice(repository.length + 1), expectedId = `improvement:${createHash("sha256").update(JSON.stringify([repository, instanceId, proposalId])).digest("hex")}`;
            if (row.id === expectedId && saved.threadId === inboxThreadId(expectedId)) work.push({ repository, proposalId, threadId: saved.threadId });
          }
          // Existence is useful for navigation. Neither a read time nor file mtime refreshes the chat's source clock.
        } catch (error) {
          // Missing chats remain uncollected; unreadable or malformed chats make link completeness unavailable.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") missing++; else invalid++;
        }
      }
      const savedPaths = [join(dirname(path), OPPORTUNITY_EVIDENCE_FILE), join(improvementOutcomeStateDir(stateDir, repository, instanceId), OPPORTUNITY_EVIDENCE_FILE)];
      for (const [index, savedPath] of savedPaths.entries()) try {
        const raw = readCodeHealthArtifactJson(savedPath, OPPORTUNITY_EVIDENCE_MAX_BYTES);
        const evidence = projectGardenerOpportunityEvidence(raw, repository, fixedClock(now));
        if (evidence.state !== "reported") { invalid++; continue; }
        if (!evidence.oldestReconciledAt) { if (index === 0) missing++; continue; }
        clocks.push(evidence.oldestReconciledAt);
        stale ||= now - Date.parse(evidence.oldestReconciledAt) > CODE_HEALTH_INTERVAL_MS;
        for (const row of raw as Array<{ proposalId: string; candidate: { repo: string; key: string }; task?: { repo?: string; key?: string; id?: string }; pr?: { repo?: string; taskId?: string; url?: string }; improvement?: { repository?: string; opportunityId?: string; threadId?: string; snapshotId?: string; taskIds?: string[]; sourceVerified?: boolean } }>) {
          const source = row.improvement;
          if (source && source.sourceVerified !== false && source.repository === repository && typeof source.opportunityId === "string" && source.opportunityId.startsWith(`${repository}/codeql-quality:`) && source.opportunityId.length <= 1024 &&
              typeof source.snapshotId === "string" && /^[a-f0-9]{64}$/.test(source.snapshotId) && typeof source.threadId === "string" && /^thread:[A-Za-z0-9:._/-]{1,500}$/.test(source.threadId) &&
              Array.isArray(source.taskIds) && source.taskIds.length <= 64 && source.taskIds.every(id => /^[A-Z][A-Z0-9]*-T[0-9]+[A-Za-z]?$/.test(id))) {
            const proposalId = source.opportunityId.slice(repository.length + 1), tasks = source.taskIds.length ? source.taskIds : [undefined];
            for (const taskId of tasks) work.push({ repository, proposalId, threadId: source.threadId, ...(taskId ? { taskId } : {}),
              ...(row.pr?.repo?.toLowerCase() === repository && row.pr.taskId === taskId && repositoryPullRequestUrl(row.pr.url, repository) ? { prUrl: row.pr.url } : {}) });
            continue;
          }
          if (!row.task || row.task.repo?.toLowerCase() !== repository || row.task.key !== row.candidate.key || typeof row.task.id !== "string") continue;
          work.push({ repository, proposalId: row.proposalId, taskId: row.task.id,
            ...(row.pr?.repo?.toLowerCase() === repository && row.pr.taskId === row.task.id && repositoryPullRequestUrl(row.pr.url, repository) ? { prUrl: row.pr.url } : {}) });
        }
      } catch (error) {
        // Older publishers do not have the derived projection yet. Its absence does not erase native links.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { if (index === 0) missing++; } else invalid++;
      }
    }
  } catch {
    // deliberate: failed scope reads withhold related-work completeness; they never certify no existing work.
    return { state: "unavailable", asOf: null, work: [], reason: "The configured sources for saved work could not be read or verified." };
  }
  return { state: invalid ? clocks.length ? "partial" : "unavailable" : missing ? clocks.length ? "partial" : "not_collected" : stale ? "stale" : "reported", asOf: clocks.sort()[0] ?? null, work: [...new Map(work.map(row => [JSON.stringify(row), row])).values()],
    reason: invalid ? "Some saved work could not be read or verified. These links may be incomplete." : missing ? "Some saved work has not been collected. These links may be incomplete." : stale ? "Saved work links have not been checked within the daily cadence." : null };
}
