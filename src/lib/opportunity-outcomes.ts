import { readFileSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { acquireInflightLock, parseInflightLockInfo } from "./inflight-lock.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, reclaimStaleLock } from "./fs-race-safe.js";
import { readCodeHealthInventory } from "./code-health-store.js";
import { loadPlan } from "./plan.js";
import { appendProducerLedger } from "./ledger.js";
import { OPPORTUNITY_EVIDENCE_MAX_BYTES, projectGardenerOpportunityEvidence } from "./gardener-opportunity-evidence.js";
import { isDeepStrictEqual } from "node:util";
import { compareCodeHealthEvidence, type CodeHealthProjectionInput } from "./code-health-projection.js";
import type { CodeHealthStoredSnapshot } from "./code-health-store.js";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { readImprovementThread, readSavedImprovementSource } from "./improvement-thread.js";
import { codeHealthRepositoryStateDir, readCodeHealthSnapshot, readCodeHealthCollectionFailure, readCodeHealthArtifactJson, improvementOutcomeStateDir } from "./code-health-store.js";
import { codeqlSnapshot, reconcileCodeqlQualityProposals, type CodeqlFilingSnapshot } from "./codeql-quality-intake.js";
import { writeAtomic } from "./fs-race-safe.js";
import type { GardenerDeps } from "./gardener.js";
import type { GardenerOverseerPorts, OpportunityMeasurement, productionGardenerOverseerPorts } from "./gardener-overseer.js";
import { ghJson, ghJsonAsync } from "./github-transport.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { loadProposalRegistry, parseProposalRegistryResult } from "./inbox.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { opportunityKey, openOpportunityIntakePorts, productionOpportunityIntakePorts, type OpportunityCandidate, type OpportunityIntakePorts, type OpportunityWork } from "./opportunity-intake.js";
import { loadCreditStore } from "./status.js";

export type { OpportunityWindow, OpportunityMeasurement } from "./gardener-overseer.js";

/** A saved planning identity, not evidence that a filed change helped. */
export interface ImprovementEffectSource {
  repository: string;
  threadId: string;
  opportunityId: string;
  snapshotId: string;
  ruleId: string;
  expectedEffect: string;
  taskIds: string[];
  planPrUrl: string | null;
  tasksFiled: boolean;
  sourceVerified: boolean;
  filedAt: string | null;
}
export interface ImprovementEffectEvidence {
  before?: CodeHealthStoredSnapshot;
  after?: CodeHealthStoredSnapshot;
  merges?: Array<{ taskId: string; repository: string; url: string; mergeSha: string; headSha: string; mergedAt: string; credit: "trailer" | "head-branch" }>;
  ancestry?: Array<{ base: string; head: string; isAncestor: boolean }>;
  collectionFailure?: boolean;
  unavailableReason?: string;
}
export interface ImprovementEffectAssessment {
  version: "improvement-effect-v1";
  stage: "conversation_saved" | "plan_pr_opened" | "tasks_filed" | "merged" | "measured";
  verdict: "helped" | "hurt" | "unchanged" | "insufficient_evidence";
  reason: string;
  expectedEffect: string;
  evaluatedAt: string;
  measuredAt: string | null;
  observationWindow: { before: string; after: string } | null;
  observed: { before: number; after: number; denominator: number } | null;
  evidence: { baselineSnapshotId: string; afterSnapshotId: string | null; analyzedSha: string | null; mergePrUrls: string[] };
  causalClaim: false;
}

/** Static code quality is measured at an analyzed commit. A runtime deployment is a separate
 * receipt and cannot substitute for a scan, or become a prerequisite for static analysis. */
export function reconcileImprovementEffects(source: ImprovementEffectSource, evidence: ImprovementEffectEvidence, clock: Clock = systemClock): ImprovementEffectAssessment {
  const result: ImprovementEffectAssessment = { version: "improvement-effect-v1", stage: source.planPrUrl ? "plan_pr_opened" : "conversation_saved",
    verdict: "insufficient_evidence", reason: "A plan and independent follow-up have not been confirmed.", expectedEffect: source.expectedEffect,
    evaluatedAt: clock.iso(), measuredAt: null, observationWindow: null, observed: null,
    evidence: { baselineSnapshotId: source.snapshotId, afterSnapshotId: null, analyzedSha: null, mergePrUrls: [] }, causalClaim: false };
  const refuse = (reason: string) => Object.assign(result, { reason });
  try {
    if (source.sourceVerified !== true) return refuse("The source saved with the original filing request cannot be verified.");
    if (!source.tasksFiled || !Array.isArray(source.taskIds) || !source.taskIds.length) return result;
    result.stage = "tasks_filed";
    if (!source.filedAt || !Number.isFinite(Date.parse(source.filedAt)) || Date.parse(source.filedAt) > clock.now()) return refuse("The original plan filing time cannot be verified.");
    if (source.taskIds.length > 64 || new Set(source.taskIds).size !== source.taskIds.length || source.taskIds.some(id => !/^[A-Z][A-Z0-9]*-T[0-9]+[A-Za-z]?$/.test(id))) return refuse("The filed task identities cannot be verified.");
    if (evidence.unavailableReason) return refuse(evidence.unavailableReason);
    const merges = evidence.merges ?? [];
    if (source.taskIds.some(id => merges.filter(pr => pr.taskId === id).length !== 1)) return refuse("Some filed tasks still need a credited merged pull request.");
    const sha = (value: string) => /^[a-f0-9]{40}$/.test(value);
    const repoUrl = `https://github.com/${source.repository}/pull/`;
    const relevant = source.taskIds.map(id => merges.find(pr => pr.taskId === id)!);
    if (relevant.some(pr => pr.repository !== source.repository || !sha(pr.mergeSha) || !sha(pr.headSha) ||
        !["trailer", "head-branch"].includes(pr.credit) || !pr.url.startsWith(repoUrl) || !/^[1-9][0-9]*$/.test(pr.url.slice(repoUrl.length)) ||
        !Number.isFinite(Date.parse(pr.mergedAt)) || Date.parse(pr.mergedAt) < Date.parse(source.filedAt!) || Date.parse(pr.mergedAt) > clock.now())) return refuse("Merged pull-request identity or task credit cannot be verified.");
    result.stage = "merged"; result.evidence.mergePrUrls = [...new Set(relevant.map(pr => pr.url))].sort();
    const before = evidence.before, after = evidence.after;
    if (!before || !after || evidence.collectionFailure) return refuse("The changes are merged. Comparable follow-up evidence is still needed.");
    if (before.snapshotId !== source.snapshotId || before.snapshotId === after.snapshotId || before.input.repository !== source.repository || after.input.repository !== source.repository ||
        before.input.analyzedSha === after.input.analyzedSha || after.input.analyzedSha !== after.input.currentSha) return refuse("The baseline and new analysis must identify this repository and different, current commits.");
    const prior = before.input.scans.find(scan => scan.kind === "quality"), current = after.input.scans.find(scan => scan.kind === "quality");
    if (!prior || !current || prior.componentIds === undefined || prior.componentIds.length === 0 || current.componentIds === undefined || current.componentIds.length === 0 || !isDeepStrictEqual(before.input.registry, after.input.registry)) return refuse("The same declared policy and independent source identities are required.");
    const beforeAt = Date.parse(prior.observedAt), afterAt = Date.parse(current.observedAt);
    if (!Number.isFinite(beforeAt) || !Number.isFinite(afterAt) || beforeAt >= afterAt || afterAt > clock.now() || clock.now() - afterAt > 86_400_000 ||
        Date.parse(after.input.observedAt) > clock.now() || relevant.some(pr => beforeAt > Date.parse(pr.mergedAt) || afterAt < Date.parse(pr.mergedAt))) return refuse("The observations must bracket the merged changes and the new source must be current.");
    const descends = (base: string, head: string) => base === head || (evidence.ancestry ?? []).some(row => row.base === base && row.head === head && row.isAncestor === true);
    if (relevant.some(pr => !descends(before.input.analyzedSha, pr.mergeSha) || !descends(pr.mergeSha, after.input.analyzedSha))) return refuse("The analyzed commit has not been confirmed to include every merged change after the saved baseline.");
    const comparison: CodeHealthProjectionInput = { ...after.input, baseline: { analyzedSha: before.input.analyzedSha, policyVersion: before.input.registry.version, scans: before.input.scans } };
    if (compareCodeHealthEvidence(comparison).state !== "comparable") return refuse("Scope, tool, rules, exclusions, or independently measured finding states are not comparable.");
    const original = prior.findings.filter(row => row.ruleId === source.ruleId && row.category === "maintainability" && row.status === "open");
    if (!original.length) return refuse("The saved baseline does not identify any linked open findings.");
    for (const finding of original) {
      const matches = current.findings.filter(row => row.id === finding.id && row.ruleId === finding.ruleId);
      const now = matches[0];
      if (matches.length !== 1 || !now || now.status !== "open" && (now.status !== "fixed" || !now.fixedAt || !now.fixedSha || relevant.some(pr => !descends(pr.mergeSha, now.fixedSha!)) ||
          !sha(now.fixedSha) || !descends(now.fixedSha, after.input.analyzedSha) || relevant.some(pr => Date.parse(now.fixedAt!) < Date.parse(pr.mergedAt)) ||
          Date.parse(now.fixedAt) > afterAt)) return refuse("Each linked finding needs an explicit open or independently confirmed fixed state. Absence or dismissal does not prove a fix.");
    }
    const remaining = current.findings.filter(row => row.ruleId === source.ruleId && row.category === "maintainability" && row.status === "open").length;
    result.stage = "measured"; result.verdict = remaining < original.length ? "helped" : remaining > original.length ? "hurt" : "unchanged";
    result.observed = { before: original.length, after: remaining, denominator: original.length };
    result.measuredAt = current.observedAt; result.observationWindow = { before: prior.observedAt, after: current.observedAt };
    result.evidence.afterSnapshotId = after.snapshotId; result.evidence.analyzedSha = after.input.analyzedSha;
    result.reason = result.verdict === "helped" ? "The same analysis reports fewer open findings for the targeted rule. This does not establish causation or a delivery-time benefit."
      : result.verdict === "hurt" ? "The same analysis reports more open findings for the targeted rule. Review the new findings before attributing a cause."
      : "The same analysis reports no change in the number of open findings for the targeted rule.";
    return result;
  } catch {
    // deliberate: invalid measurement inputs withhold any benefit verdict; they never become zero findings or a saved-label fallback.
    return refuse("The measurement evidence is invalid or cannot currently be verified.");
  }
}

export interface OpportunitySource {
  candidate: OpportunityCandidate;
  proposalId: string;
  sourceIds: string[];
  codeql?: CodeqlFilingSnapshot;
  expiresAt?: string;
  improvement?: ImprovementEffectSource;
  effectCheckedAt?: string;
}
export interface OpportunityEvidence {
  task?: { id: string; repo: string; key: string; filedAt?: string };
  pr?: { taskId: string; repo: string; url: string; headSha: string; mergeSha: string; mergedAt: string };
  deployment?: { repo: string; revision: string; at: string; receipt: string };
  measurement?: OpportunityMeasurement;
  improvementMeasurement?: ImprovementEffectEvidence;
}
export interface OpportunityOutcome extends OpportunitySource, OpportunityEvidence {
  key: string;
  at: string;
  state: "pending" | "filed" | "merged" | "deployed" | "measured-helped" | "measured-hurt" | "expired" | "unavailable";
  reason: string;
  leadTimeMs: number | null;
  failureRework: OpportunityMeasurement["failureRework"] | null;
  effect?: ImprovementEffectAssessment;
}
export interface OpportunityOutcomePorts {
  clock?: Clock;
  readSources: () => OpportunitySource[];
  readEvidence: (source: OpportunitySource) => OpportunityEvidence;
  readEvidenceAsync?(source: OpportunitySource): Promise<OpportunityEvidence>;
  save: (outcomes: OpportunityOutcome[]) => void;
  dispose?: () => void | Promise<void>;
}

function comparable(pair: OpportunityMeasurement["targetedCost"], deployedAt: number, now: number): boolean {
  const { before, after } = pair;
  const [bs, be, as, ae] = [before.start, before.end, after.start, after.end].map(Date.parse);
  return [before, after].every((w) => Number.isFinite(w.value) && w.value >= 0 && Number.isFinite(w.denominator) && w.denominator > 0 && !!w.unit && !!w.populationUnit) &&
    before.unit === after.unit && before.populationUnit === after.populationUnit && be > bs && ae > as && be - bs === ae - as && be <= deployedAt && as >= deployedAt && ae <= now;
}

function outcomeOf(source: OpportunitySource, evidence: OpportunityEvidence, clock: Clock): OpportunityOutcome {
  const result: OpportunityOutcome = { ...source, key: opportunityKey(source.candidate), at: clock.iso(), state: "unavailable", reason: "", leadTimeMs: null, failureRework: null };
  const finish = (state: OpportunityOutcome["state"], reason: string) => Object.assign(result, { state, reason });
  if (source.improvement) {
    const effect = reconcileImprovementEffects(source.improvement, evidence.improvementMeasurement ?? {}, clock);
    result.effect = effect;
    if (evidence.task) result.task = evidence.task;
    if (evidence.pr) result.pr = evidence.pr;
    if (evidence.improvementMeasurement?.unavailableReason) return finish("unavailable", effect.reason);
    return finish(effect.verdict === "helped" ? "measured-helped" : effect.verdict === "hurt" ? "measured-hurt"
      : effect.stage === "merged" || effect.stage === "measured" ? "merged" : effect.stage === "tasks_filed" || effect.stage === "plan_pr_opened" ? "filed" : "pending", effect.reason);
  }
  const candidate = source.candidate;
  if (!candidate.anchor || !source.sourceIds.length || source.sourceIds.some((id) => !id) || !Number.isFinite(candidate.population.denominator) || !(candidate.population.denominator > 0)) return finish("unavailable", "source or source denominator unavailable");
  const { task, pr, deployment, measurement } = evidence;
  if (source.codeql && (!source.codeql.scannerSha || !source.codeql.alertNumbers.length)) {
    if (task?.repo === candidate.repo && task.key === candidate.key) result.task = task;
    return finish("unavailable", "CodeQL filing scanner SHA or alert numbers unavailable");
  }
  if (!task) return source.expiresAt && Date.parse(source.expiresAt) <= clock.now()
    ? finish("expired", "proposal expired before filing") : finish("pending", "proposal awaits a task");
  if (task.repo !== candidate.repo || task.key !== candidate.key) return finish("unavailable", "task source join unavailable");
  result.task = task;
  if (!pr) return finish("filed", "task awaits a credited merged PR");
  if (pr.repo !== candidate.repo || pr.taskId !== task.id || !pr.headSha || !pr.mergeSha || !Number.isFinite(Date.parse(pr.mergedAt))) return finish("unavailable", "credited PR source or head unavailable");
  if (Date.parse(pr.mergedAt) > clock.now()) return finish("unavailable", "credited merge is later than the observed clock");
  result.pr = pr;
  if (!deployment) return finish("merged", "merged PR awaits deployment receipt; unmeasured");
  // expiring-fixture: exempt -- injected clock checks future receipts; ageing cannot stale a deployment.
  const deployedAt = Date.parse(deployment.at);
  if (deployment.repo !== candidate.repo || ![pr.headSha, pr.mergeSha].includes(deployment.revision) || !deployment.receipt ||
    !Number.isFinite(deployedAt) || deployedAt < Date.parse(pr.mergedAt) || deployedAt > clock.now()) return finish("unavailable", "deployment revision or repository join unavailable");
  result.deployment = deployment;
  const filedAt = Date.parse(task.filedAt ?? "");
  if (Number.isFinite(filedAt) && filedAt <= Date.parse(pr.mergedAt)) result.leadTimeMs = deployedAt - filedAt;
  if (!measurement) return finish("unavailable", "deployed; targeted measurement unavailable");
  if (measurement.repo !== candidate.repo || measurement.key !== candidate.key || measurement.revision !== deployment.revision ||
    measurement.targetedCost.before.unit !== candidate.impact.unit || !comparable(measurement.targetedCost, deployedAt, clock.now())) return finish("unavailable", "targeted measurement source, denominator, unit or equal windows unavailable");
  result.measurement = measurement;
  if (measurement.failureRework && comparable(measurement.failureRework, deployedAt, clock.now())) result.failureRework = measurement.failureRework;
  const { before, after } = measurement.targetedCost;
  const change = after.value / after.denominator - before.value / before.denominator;
  const verdict = measurement.verdict ?? (change < 0 ? "credit" : change > 0 ? "debit" : undefined);
  return finish(verdict === "credit" ? "measured-helped" : verdict === "debit" ? "measured-hurt" : "deployed",
    verdict ? `targeted cost ${verdict}; equal windows in ${before.unit}` : "deployed and measured; no observed change");
}

export function reconcileOpportunityOutcomes(ports: OpportunityOutcomePorts): OpportunityOutcome[] {
  try {
    const clock = ports.clock ?? systemClock;
    const outcomes = ports.readSources().map((source) => {
      try { return outcomeOf(source, ports.readEvidence(source), clock); }
      catch (error) {
        if (source.improvement) {
          const effect = reconcileImprovementEffects(source.improvement, { unavailableReason: "The native follow-up evidence is unavailable. A saved result cannot substitute for a new check." }, clock);
          return { ...source, key: opportunityKey(source.candidate), at: clock.iso(), state: "unavailable" as const, reason: effect.reason, effect, leadTimeMs: null, failureRework: null };
        }
        return { ...source, key: opportunityKey(source.candidate), at: clock.iso(), state: "unavailable" as const,
          reason: `outcome evidence unavailable: ${String(error)}`, leadTimeMs: null, failureRework: null };
      }
    });
    ports.save(outcomes);
    return outcomes;
  } finally { ports.dispose?.(); }
}

/** The daemon awaits workspace cleanup even when source reading or persistence fails. */
export async function reconcileOpportunityOutcomesAsync(ports: OpportunityOutcomePorts): Promise<OpportunityOutcome[]> {
  try {
    if (!ports.readEvidenceAsync) return reconcileOpportunityOutcomes({ ...ports, dispose: undefined });
    const clock = ports.clock ?? systemClock, outcomes: OpportunityOutcome[] = [];
    for (const source of ports.readSources()) {
      try { outcomes.push(outcomeOf(source, await ports.readEvidenceAsync(source), clock)); }
      catch (error) {
        const effect = source.improvement ? reconcileImprovementEffects(source.improvement, {
          unavailableReason: "The native follow-up evidence is unavailable. A saved result cannot substitute for a new check.",
        }, clock) : undefined;
        outcomes.push({ ...source, key: opportunityKey(source.candidate), at: clock.iso(), state: "unavailable",
          reason: effect?.reason ?? `outcome evidence unavailable: ${String(error)}`, ...(effect ? { effect } : {}), leadTimeMs: null, failureRework: null });
      }
    }
    ports.save(outcomes);
    return outcomes;
  } finally {
    await ports.dispose?.();
  }
}

function readOutcomes(path: string, maxBytes?: number): OpportunityOutcome[] {
  try {
    const rows: unknown = maxBytes === undefined ? JSON.parse(readFileSync(path, "utf8")) : readCodeHealthArtifactJson(path, maxBytes);
    const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    if (!Array.isArray(rows) || rows.some((row: unknown) => !isRecord(row) || !isRecord(row.candidate) ||
      typeof row.candidate.repo !== "string" || row.candidate.repo.length === 0 ||
      typeof row.candidate.key !== "string" || row.candidate.key.length === 0 || !Array.isArray(row.sourceIds))) throw new Error(`malformed outcomes: ${path}`);
    return rows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function sourceFromText(text: string, proposalId: string, repo: string): OpportunitySource | undefined {
  const line = text.split("\n").find((row) => row.startsWith("{") && row.includes('"observedAt"'));
  if (!line) return undefined;
  const candidate = JSON.parse(line) as OpportunityCandidate;
  if (candidate.repo !== repo || !candidate.key || !candidate.population || !candidate.impact) throw new Error(`invalid opportunity source: ${proposalId}`);
  return { candidate, proposalId, sourceIds: candidate.anchor ? [candidate.anchor] : [] };
}

function matchingTasks(work: OpportunityWork, source: OpportunitySource) {
  const candidate = source.candidate;
  return work.tasks.filter((t) => (t.repo === candidate.repo || t.repo === candidate.repo.split("/")[1]) &&
    (t.origin === candidate.key || t.origin === opportunityKey(candidate) || t.note?.split("\n").includes(`Opportunity-Key: ${opportunityKey(candidate)}`)));
}

/** Acquire the daemon's asynchronous workspace before using the unchanged outcome evidence fold. */
export async function openOpportunityOutcomePorts(garden: GardenerDeps,
  deps: NonNullable<Parameters<typeof productionOpportunityOutcomePorts>[1]> = {},
): Promise<OpportunityOutcomePorts> {
  const intake = deps.intake ?? await openOpportunityIntakePorts(garden);
  return productionOpportunityOutcomePorts(garden, { ...deps, intake });
}

/** Re-read source and runtime receipts on the admitted intake cadence; never change policy. */
export function productionOpportunityOutcomePorts(garden: GardenerDeps, deps: Partial<
  Pick<GardenerOverseerPorts, "readRows"> & Pick<Parameters<typeof productionGardenerOverseerPorts>[0], "fetch">
> & {
  intake?: OpportunityIntakePorts;
  /** The managed follow-up owns only its central projection; native repository stores are read-only. */
  nativeStateDir?: string;
  evidenceStateDir?: string;
  improvementOnly?: boolean;
  mayPublish?: () => boolean;
  fetchImprovementAsync?: (args: string[]) => Promise<unknown>;
} = {}): OpportunityOutcomePorts {
  const intake = deps.intake ?? productionOpportunityIntakePorts(garden);
  const clock = garden.clock ?? systemClock;
  const fetch = deps.fetch ?? ghJson;
  const path = join(garden.stateDir, "opportunity-outcomes.json");
  const nativeStateDir = deps.nativeStateDir ?? garden.stateDir, evidenceStateDir = deps.evidenceStateDir ?? garden.stateDir;
  const registryPath = join(nativeStateDir, "inbox-proposals.json");
  let work: OpportunityWork;
  let nativeSourceUnavailable = false;
  let rows: Record<string, unknown>[];
  const sources = new Map<string, OpportunitySource>();
  const previousOutcomes = new Map<string, OpportunityOutcome>();
  // PRIMARY CONTROL: bounded new evidence reads on the existing admitted gardener pass.
  // BACKSTOP: a larger task population remains unmeasured rather than being truncated.
  let remainingImprovementReads = 24;
  const improvementApiCache = new Map<string, unknown>();
  const readImprovementApi = (args: string[]): unknown => {
    const key = JSON.stringify(args);
    if (improvementApiCache.has(key)) return improvementApiCache.get(key);
    if (remainingImprovementReads === 0) throw new Error("The bounded improvement evidence pass needs another admitted turn.");
    remainingImprovementReads--;
    const value = fetch(args); improvementApiCache.set(key, value); return value;
  };
  function* improvementEvidence(source: OpportunitySource): Generator<string[], OpportunityEvidence, unknown> {
    const identity = { ...source.improvement!, tasksFiled: source.improvement!.taskIds.length > 0 && source.improvement!.taskIds.every(id => work.tasks.some(task => task.id === id)) };
    source.improvement = identity;
    const stateDir = codeHealthRepositoryStateDir(evidenceStateDir, intake.repo), before = readCodeHealthSnapshot(stateDir, intake.repo, identity.snapshotId), after = readCodeHealthSnapshot(stateDir, intake.repo);
    const measurement: ImprovementEffectEvidence = { before: before.state === "observed" ? before.snapshot : undefined,
      after: after.state === "observed" ? after.snapshot : undefined, collectionFailure: readCodeHealthCollectionFailure(stateDir, intake.repo).state !== "none", merges: [], ancestry: [] };
    if (!identity.sourceVerified || !identity.tasksFiled || !identity.taskIds.length) return { improvementMeasurement: measurement };
    // Explicit bound: do not truncate a task population and report the remainder as measured.
    if (identity.taskIds.length > 64) return { improvementMeasurement: measurement };
    if (remainingImprovementReads === 0) return { improvementMeasurement: { ...measurement, unavailableReason: "Follow-up is waiting for the next admitted evidence pass." } };
    source.effectCheckedAt = clock.iso();
    const credits = loadCreditStore(join(nativeStateDir, "merge-credit.json"));
    for (const id of identity.taskIds) {
      const credit = credits[id];
      const entry = credit && [credit.trailer, credit["head-branch"]].find(row => row?.prState === "MERGED" && credit.invalidated?.[row.source] === undefined);
      if (!entry) continue;
      const pr = (yield ["api", `repos/${intake.repo}/pulls/${entry.prNumber}`]) as { merged: boolean; html_url: string; merged_at: string; merge_commit_sha: string; body: string; head: { sha: string; ref: string }; base: { repo: { full_name: string } } };
      // Reconfirm the exact trailer OR run branch against the current merged API record.
      const trailer = (pr.body ?? "").split(/\r?\n/).includes(`Remudero-Task: ${id}`), branch = new RegExp(`^run-${id}-[0-9]+$`).test(pr.head.ref);
      if (!pr.merged || entry.prUrl !== pr.html_url || pr.base.repo.full_name.toLowerCase() !== intake.repo || !trailer && !branch) continue;
      measurement.merges!.push({ taskId: id, repository: intake.repo, url: pr.html_url, mergeSha: pr.merge_commit_sha, headSha: pr.head.sha, mergedAt: pr.merged_at, credit: trailer ? "trailer" : "head-branch" });
    }
    const pairs = measurement.before && measurement.after ? measurement.merges!.flatMap(pr => [
      { base: measurement.before!.input.analyzedSha, head: pr.mergeSha }, { base: pr.mergeSha, head: measurement.after!.input.analyzedSha },
    ]) : [];
    for (const pair of [...new Map(pairs.map(pair => [`${pair.base}:${pair.head}`, pair])).values()]) {
      if (pair.base === pair.head) continue;
      if (![pair.base, pair.head].every(sha => /^[a-f0-9]{40}$/.test(sha))) continue;
      const compared = (yield ["api", `repos/${intake.repo}/compare/${pair.base}...${pair.head}`]) as { status: string; merge_base_commit: { sha: string } };
      measurement.ancestry!.push({ ...pair, isAncestor: ["ahead", "identical"].includes(compared.status) && compared.merge_base_commit?.sha === pair.base });
    }
    return { improvementMeasurement: measurement,
      ...(identity.taskIds[0] ? { task: { id: identity.taskIds[0], repo: intake.repo, key: source.candidate.key } } : {}),
      ...(measurement.merges?.[0] ? { pr: { ...measurement.merges[0], repo: intake.repo } } : {}) };
  }
  return {
    clock, dispose: intake.dispose,
    readSources: () => {
      const previous = readOutcomes(path, deps.improvementOnly ? OPPORTUNITY_EVIDENCE_MAX_BYTES : undefined);
      if (deps.improvementOnly && projectGardenerOpportunityEvidence(previous, intake.repo, clock).state !== "reported") throw new Error("The saved improvement projection is invalid.");
      if (deps.improvementOnly && previous.some(row => row.improvement === undefined)) throw new Error("The improvement projection contains an unrelated source.");
      for (const row of previous) previousOutcomes.set(row.key, row);
      for (const row of previous) sources.set(row.key, { candidate: row.candidate, proposalId: row.proposalId, sourceIds: row.sourceIds, codeql: row.codeql, expiresAt: row.expiresAt, improvement: row.improvement, effectCheckedAt: row.effectCheckedAt });
      try { work = intake.readWork(); }
      catch (error) {
        // Retain known source identities and observation history, but expose the failed refresh.
        // Missing or corrupt prior evidence cannot become a fabricated empty successful pass.
        if (!deps.improvementOnly || previous.length === 0) throw error;
        nativeSourceUnavailable = true;
        return [...sources.values()];
      }
      if (!deps.improvementOnly) {
      for (const [text, id] of [
        ...work.proposals.map((p) => [p.summary, p.id]),
        ...work.tasks.map((t) => [t.prompt ?? "", t.origin ?? t.id]),
        ...work.feedback.map((f) => [f.raw, f.submission_key ?? f.id]),
      ]) {
        const source = sourceFromText(text!, id!, intake.repo);
        if (source && !sources.has(opportunityKey(source.candidate))) sources.set(opportunityKey(source.candidate), source);
      }
      for (const proposal of work.proposals) {
        if (!proposal.id.startsWith("codeql-quality:")) continue;
        const snapshot = codeqlSnapshot(proposal);
        const ruleId = snapshot?.ruleId ?? proposal.id.slice("codeql-quality:".length);
        const ids = snapshot?.alertNumbers ?? [...proposal.summary.matchAll(/#([0-9]+)/g)].map((m) => m[1]!);
        const key = `${intake.repo}/${proposal.id}`;
        const prior = sources.get(key);
        if (prior?.codeql && matchingTasks(work, prior).length) continue;
        sources.set(key, { proposalId: proposal.id, sourceIds: ids, codeql: snapshot ?? { proposalId: proposal.id, ruleId, alertNumbers: ids }, candidate: {
          source: "codeql-quality", repo: intake.repo, key: proposal.id, observedAt: clock.iso(), anchor: `https://github.com/${intake.repo}/security/code-scanning`,
          availability: "available", freshness: "fresh", population: { affected: ids.length, denominator: ids.length, unit: "filed alerts" },
          impact: { value: ids.length, unit: "open quality alerts" }, remedy: proposal.summary, authority: "machine", related: {},
        } });
      }
      }
      for (const proposal of work.proposals) {
        const saved = proposal.improvement;
        if (saved === undefined || saved.conversationReady !== true || saved.repository !== intake.repo || !saved.opportunityId.startsWith(`${intake.repo}/codeql-quality:`)) continue;
        const key = `${intake.repo}/${proposal.id}`, prior = sources.get(key);
        // Once filed, keep its original source. A later chat goal cannot move the baseline.
        if (prior?.improvement?.planPrUrl && prior.improvement.sourceVerified) continue;
        const view = readImprovementThread(saved.requestId, { stateDir: evidenceStateDir, actorId: "owned-opportunity-gardener", clock });
        const receipt = view.state === "saved" && view.filing.state === "plan_pr_opened" ? view.filing.receipt : undefined;
        const original = readSavedImprovementSource(view.state === "saved" && view.filing.sourceRequestId ? view.filing.sourceRequestId : saved.requestId,
          { stateDir: evidenceStateDir, actorId: "owned-opportunity-gardener", clock });
        const sourceVerified = original.state === "observed" && original.proposalId === proposal.id && original.threadId === saved.threadId && original.repository === intake.repo && original.opportunityId === saved.opportunityId;
        const taskIds = receipt?.taskIdsState === "observed" ? receipt.taskIds : [];
        const ruleId = saved.opportunityId.slice(`${intake.repo}/codeql-quality:`.length);
        const improvement: ImprovementEffectSource = { repository: intake.repo, threadId: saved.threadId, opportunityId: saved.opportunityId,
          snapshotId: sourceVerified ? original.snapshotId : saved.snapshotId, sourceVerified, ruleId, expectedEffect: "Confirm the linked findings are fixed with the same analysis.", taskIds,
          planPrUrl: receipt?.prUrl ?? null, filedAt: receipt?.recordedAt ?? null, tasksFiled: taskIds.length > 0 && taskIds.every(id => work.tasks.some(task => task.id === id)) };
        sources.set(key, { proposalId: proposal.id, sourceIds: [improvement.snapshotId], improvement, candidate: {
          source: "codeql-quality", repo: intake.repo, key: proposal.id, observedAt: clock.iso(), anchor: `https://github.com/${intake.repo}/security/code-scanning`,
          availability: "available", freshness: "fresh", population: { affected: 1, denominator: 1, unit: "saved improvement conversations" },
          impact: { value: 1, unit: "targeted rule findings" }, remedy: improvement.expectedEffect, authority: "operator", related: {},
        } });
      }
      const pins = [...sources.values()].filter((s) => s.codeql && matchingTasks(work, s).length).map((s) => s.codeql!);
      let scannerSha: string | undefined;
      if ([...sources.values()].some((s) => s.codeql)) {
        const analyses = fetch(["api", `repos/${intake.repo}/code-scanning/analyses?per_page=100`]) as Array<{ tool: { name: string }; commit_sha: string; ref: string }>;
        scannerSha = analyses.find((a) => a.tool.name.toLowerCase() === "codeql" && a.ref === "refs/heads/main")?.commit_sha;
        for (const s of sources.values()) {
          if (s.codeql && !pins.includes(s.codeql)) s.codeql = { ...s.codeql, scannerSha };
        }
      }
      if (pins.length) {
        const read = intake.readCodeql();
        if (!read.ok) throw new Error(`CodeQL drift unavailable: ${read.error}`);
        reconcileCodeqlQualityProposals(registryPath, read.alerts, work.feedback, { ratified: pins, scannerSha });
        for (const proposal of loadProposalRegistry(registryPath)) {
          const snapshot = codeqlSnapshot(proposal);
          if (snapshot && proposal.id.includes(":delta:") && !sources.has(`${intake.repo}/${proposal.id}`)) {
            const parent = [...sources.values()].find((s) => s.codeql?.ruleId === snapshot.ruleId);
            if (!parent) throw new Error(`delta source unavailable: ${proposal.id}`);
            sources.set(`${intake.repo}/${proposal.id}`, { ...parent, proposalId: proposal.id, sourceIds: snapshot.alertNumbers, codeql: snapshot, candidate: { ...parent.candidate, key: proposal.id, observedAt: clock.iso(), remedy: proposal.summary, population: { ...parent.candidate.population, affected: snapshot.alertNumbers.length }, impact: { ...parent.candidate.impact, value: snapshot.alertNumbers.length } } });
          }
        }
      }
      rows = deps.readRows ? deps.readRows() : readLedgerUnionRecordsSync(garden.stateDir, { pattern: /"step":"(gardener_overseer\.effect_verdict|ratify\.approved)"/ }).rows;
      return [...sources.values()].sort((a, b) => (a.effectCheckedAt ?? "").localeCompare(b.effectCheckedAt ?? ""));
    },
    readEvidenceAsync: deps.fetchImprovementAsync ? async source => {
      if (!source.improvement) throw new Error("This asynchronous follow-up accepts saved improvements only.");
      if (nativeSourceUnavailable) return { improvementMeasurement: { unavailableReason: "The saved planning chat and plan could not be checked. Earlier results remain in history." } };
      const evidence = improvementEvidence(source);
      let next = evidence.next();
      while (!next.done) {
        const args = next.value, key = JSON.stringify(args);
        if (!improvementApiCache.has(key)) {
          if (remainingImprovementReads === 0) throw new Error("The bounded improvement evidence pass needs another admitted turn.");
          remainingImprovementReads--;
          improvementApiCache.set(key, await deps.fetchImprovementAsync!(args));
        }
        next = evidence.next(improvementApiCache.get(key));
      }
      return next.value;
    } : undefined,
    readEvidence: (source) => {
      if (nativeSourceUnavailable) return { improvementMeasurement: { unavailableReason: "The saved planning chat and plan could not be checked. Earlier results remain in history." } };
      if (source.improvement) {
        const evidence = improvementEvidence(source);
        let next = evidence.next();
        while (!next.done) next = evidence.next(readImprovementApi(next.value));
        return next.value;
      }
      const tasks = matchingTasks(work, source);
      if (tasks.length > 1) throw new Error("ambiguous ratified task join");
      const task = tasks[0];
      if (!task) return {};
      const filing = rows.find((r) => r.step === "ratify.approved" && r.task_id === source.proposalId);
      const result: OpportunityEvidence = { task: { id: task.id, repo: intake.repo, key: source.candidate.key, filedAt: typeof filing?.ts === "string" ? filing.ts : undefined } };
      const credit = loadCreditStore(join(nativeStateDir, "merge-credit.json"))[task.id];
      if (credit === undefined) return result;
      const entry = [credit.trailer, credit["head-branch"]].find((e) => e?.prState === "MERGED" && credit.invalidated?.[e.source] === undefined);
      if (!entry) return result;
      const pr = fetch(["api", `repos/${intake.repo}/pulls/${entry.prNumber}`]) as { merged: boolean; html_url: string; merged_at: string; merge_commit_sha: string; head: { sha: string }; base: { repo: { full_name: string } } };
      if (!pr.merged) throw new Error("credited PR is not merged");
      if (entry.prUrl !== pr.html_url) throw new Error("credited PR repository or URL changed");
      result.pr = { taskId: task.id, repo: pr.base.repo.full_name, url: pr.html_url, headSha: pr.head.sha, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged_at };
      const pages = fetch(["api", `repos/${intake.repo}/deployments?sha=${pr.merge_commit_sha}&per_page=100`, "--paginate", "--slurp"]) as Array<Array<{ id: number; sha: string }>>;
      for (const deployment of pages.flat()) {
        const statuses = fetch(["api", `repos/${intake.repo}/deployments/${deployment.id}/statuses?per_page=100`]) as Array<{ state: string; created_at: string }>;
        const status = statuses[0];
        if (status?.state !== "success") continue;
        result.deployment = { repo: intake.repo, revision: deployment.sha, at: status.created_at, receipt: `https://github.com/${intake.repo}/deployments/${deployment.id}` };
        break;
      }
      const effect = rows.findLast((r) => r.step === "gardener_overseer.effect_verdict" && r.pr_url === pr.html_url && r.opportunity_measurement);
      if (effect) result.measurement = { ...effect.opportunity_measurement as OpportunityMeasurement, verdict: effect.verdict as "credit" | "debit" };
      return result;
    },
    save: (outcomes) => {
      const body = JSON.stringify(outcomes, null, 2) + "\n";
      if (deps.improvementOnly && (outcomes.length > 512 || Buffer.byteLength(body) > OPPORTUNITY_EVIDENCE_MAX_BYTES)) throw new Error("The improvement projection exceeds its publication bound.");
      if (deps.mayPublish?.() === false) throw new Error("Improvement publication ownership changed.");
      for (const outcome of outcomes) {
        if (!outcome.effect || !outcome.improvement) continue;
        const meaning = (effect: ImprovementEffectAssessment | undefined) => effect === undefined ? null : [effect.stage, effect.verdict, effect.reason, effect.measuredAt, effect.observed, effect.evidence];
        if (!isDeepStrictEqual(meaning(outcome.effect), meaning(previousOutcomes.get(outcome.key)?.effect))) {
          // The native ledger retains observation history independently of this latest-state cache.
          // This records observed evidence, not successful cache publication or causation.
          garden.log?.("opportunity_outcome.effect_observed", { opportunity_key: outcome.key, proposal_id: outcome.proposalId, repository: outcome.candidate.repo, improvement_source: outcome.improvement, thread_id: outcome.improvement.threadId,
            source_snapshot_id: outcome.improvement.snapshotId, effect: outcome.effect, publication: "not_confirmed" });
        }
      }
      if (!writeAtomic(path, body, { beforeRename: deps.mayPublish })) throw new Error("Improvement publication ownership changed.");
    },
  };
}


export { improvementOutcomeStateDir } from "./code-health-store.js";

/** Called by an already-admitted registered gardener. Reads configured repositories only;
 * it neither opens workspaces nor changes another instance's native registry or jobs. */
export async function reconcileManagedImprovementEffects(input: {
  stateDir: string; repoRoot: string; repository: string; clock?: Clock; log: GardenerDeps["log"];
  fetch?: (args: string[]) => unknown | Promise<unknown>;
}): Promise<{ state: "reported" | "partial" | "not_collected"; expectedScopes: number | null; publishedScopes: number }> {
  const clock = input.clock ?? systemClock;
  let inventory: ReturnType<typeof readCodeHealthInventory>, publisher: { instances?: Array<{ instanceId: string; options?: { controlRoot?: string; planPath?: string } }> };
  try {
    inventory = readCodeHealthInventory(input.stateDir);
    publisher = readCodeHealthArtifactJson(join(input.stateDir, "read-model", "repositories-sources.json"), 2 * 1024 * 1024) as typeof publisher;
    if (!Array.isArray(publisher.instances) || publisher.instances.length > 256) throw new Error("The configured scope publisher is unavailable.");
  } catch (error) {
    input.log("improvement_effects.scope_unavailable", { reason: "configured repository scope could not be verified", error: String(error) });
    return { state: "not_collected", expectedScopes: null, publishedScopes: 0 };
  }
  const scopes = inventory.repositories.flatMap(member => member.instanceIds.map(instance => ({ repository: member.repository, instance,
    stateDir: improvementOutcomeStateDir(input.stateDir, member.repository, instance) })));
  const lastPass = (stateDir: string): number => {
    try { return lstatSync(join(stateDir, "opportunity-outcomes.json")).mtimeMs; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  };
  scopes.sort((a, b) => lastPass(a.stateDir) - lastPass(b.stateDir) || a.instance.localeCompare(b.instance));
  // PRIMARY CONTROLS: four repository/instance projections and 24 new GitHub reads per pass.
  // Deferred scopes retain their own old clocks and sort ahead of recently published ones.
  let reads = 24, publishedScopes = 0;
  const cache = new Map<string, unknown>(), fetch = input.fetch ?? ghJsonAsync;
  const boundedFetch = async (args: string[]): Promise<unknown> => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    if (reads === 0) throw new Error("Follow-up is waiting for the next admitted evidence pass.");
    reads--; const value = await fetch(args); cache.set(key, value); return value;
  };
  for (const scope of scopes.slice(0, 4)) {
    let lock: ReturnType<typeof acquireInflightLock> | undefined, owns: (() => boolean) | undefined;
    try {
      const matches = publisher.instances!.filter(row => row.instanceId === scope.instance), options = matches[0]?.options;
      if (matches.length !== 1 || !options || typeof options.controlRoot !== "string" || !isAbsolute(options.controlRoot) || typeof options.planPath !== "string" || !isAbsolute(options.planPath)) throw new Error("The native repository paths could not be verified.");
      const locks = join(scope.stateDir, "effect-locks"), path = join(locks, "publication.lock");
      const acquire = () => acquireInflightLock(locks, "publication", { run_id: `improvement-effect:${randomUUID()}`, reclaim: false });
      try { lock = acquire(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const reclaimed = reclaimStaleLock(path, { parseHolder: raw => ({ info: parseInflightLockInfo(raw) }),
          isStale: held => held.info !== null && Number.isSafeInteger(held.info.pid) && held.info.pid > 0 && typeof held.info.host === "string" &&
            Number.isFinite(Date.parse(held.info.startedAt)) && isHolderStale(held.info, { isPidAlive: defaultIsPidAlive }) });
        if (!["missing", "reclaimed"].includes(reclaimed.outcome)) continue;
        lock = acquire();
      }
      const identity = lstatSync(lock.path), owner = lock;
      owns = () => {
        try {
          const stat = lstatSync(owner.path), record = readCodeHealthArtifactJson(owner.path, 4096) as { run_id?: string };
          return stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino && record.run_id === owner.info.run_id;
        } catch {
          // deliberate: a missing, unreadable, or replaced lock never grants publication or cleanup ownership.
          return false;
        }
      };
      const nativeStateDir = join(options.controlRoot, "state");
      const forbidden = (): never => { throw new Error("Improvement follow-up is read-only and cannot draft, file, or open a workspace."); };
      const intake: OpportunityIntakePorts = { repo: scope.repository, clock, standingDebtAnchor: "", readStandingDebt: forbidden,
        readCodeql: forbidden, readFriction: forbidden, riskJudge: async () => forbidden(), fileCandidate: async () => forbidden(), stageProposal: forbidden,
        readWork: () => {
          const raw = readCodeHealthArtifactJson(join(nativeStateDir, "inbox-proposals.json"), 2 * 1024 * 1024), parsed = parseProposalRegistryResult(JSON.stringify(raw));
          if (parsed.kind !== "ok" || parsed.proposals.some(p => !p || typeof p.id !== "string" || typeof p.summary !== "string" || !Array.isArray(p.evidenceAnchors))) throw new Error("The native planning registry is unavailable or invalid.");
          const improvements = parsed.proposals.filter(p => p.improvement !== undefined);
          // The pass follows saved improvements; unrelated native producers do not consume its cap.
          // The entire source still passes the unchanged 2 MiB read bound and row validation above.
          if (improvements.length > 512) throw new Error("The saved improvements exceed this evidence pass's bounded population.");
          return { proposals: improvements, tasks: loadPlan(options.planPath!).tasks, prs: [], mergedKeys: [], feedback: [] };
        } };
      const log: GardenerDeps["log"] = (step, fields) => {
        if (step === "opportunity_outcome.effect_observed") {
          if (!owns?.()) throw new Error("Improvement observation ownership changed.");
          const observed = { ...fields, ts: clock.iso() };
          appendProducerLedger(join(scope.stateDir, LEDGER_FILENAME), "DAEMON", { ...observed, run_id: owner.info.run_id, step });
          input.log(step, observed);
        } else input.log(step, fields);
      };
      const ports = productionOpportunityOutcomePorts({ stateDir: scope.stateDir, repoRoot: input.repoRoot, clock, log, openWorkspace: forbidden },
        { intake, fetchImprovementAsync: boundedFetch, readRows: () => [], nativeStateDir, evidenceStateDir: input.stateDir, improvementOnly: true, mayPublish: owns });
      const outcomes = await reconcileOpportunityOutcomesAsync(ports);
      if (!outcomes.some(row => row.state === "unavailable")) publishedScopes++;
    } catch (error) {
      input.log("improvement_effects.repository_unavailable", { repository: scope.repository, instance: scope.instance, reason: "native follow-up could not be completed", error: String(error) });
    } finally { if (lock && owns?.()) lock.release(); }
  }
  return { state: publishedScopes === scopes.length && inventory.unresolvedInstances.length === 0 ? "reported" : "partial", expectedScopes: scopes.length, publishedScopes };
}
