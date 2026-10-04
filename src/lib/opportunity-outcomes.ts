import { readFileSync } from "node:fs";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import { codeqlSnapshot, reconcileCodeqlQualityProposals, type CodeqlFilingSnapshot } from "./codeql-quality-intake.js";
import { writeAtomic } from "./fs-race-safe.js";
import type { GardenerDeps } from "./gardener.js";
import { ghJson } from "./github-transport.js";
import { loadProposalRegistry } from "./inbox.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { opportunityKey, productionOpportunityIntakePorts, type OpportunityCandidate, type OpportunityIntakePorts, type OpportunityWork } from "./opportunity-intake.js";
import { loadCreditStore } from "./status.js";

export interface OpportunitySource {
  candidate: OpportunityCandidate;
  proposalId: string;
  sourceIds: string[];
  codeql?: CodeqlFilingSnapshot;
  expiresAt?: string;
}
export interface OpportunityWindow {
  value: number;
  denominator: number;
  populationUnit: string;
  unit: string;
  start: string;
  end: string;
}
export interface OpportunityMeasurement {
  repo: string;
  key: string;
  revision: string;
  targetedCost: { before: OpportunityWindow; after: OpportunityWindow };
  failureRework?: { before: OpportunityWindow; after: OpportunityWindow };
  verdict?: "credit" | "debit";
}
export interface OpportunityEvidence {
  task?: { id: string; repo: string; key: string; filedAt?: string };
  pr?: { taskId: string; repo: string; url: string; headSha: string; mergeSha: string; mergedAt: string };
  deployment?: { repo: string; revision: string; at: string; receipt: string };
  measurement?: OpportunityMeasurement;
}
export interface OpportunityOutcome extends OpportunitySource, OpportunityEvidence {
  key: string;
  at: string;
  state: "pending" | "filed" | "merged" | "deployed" | "measured-helped" | "measured-hurt" | "expired" | "unavailable";
  reason: string;
  leadTimeMs: number | null;
  failureRework: OpportunityMeasurement["failureRework"] | null;
}
export interface OpportunityOutcomePorts {
  clock?: Clock;
  readSources: () => OpportunitySource[];
  readEvidence: (source: OpportunitySource) => OpportunityEvidence;
  save: (outcomes: OpportunityOutcome[]) => void;
  dispose?: () => void;
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
  result.pr = pr;
  if (!deployment) return finish("merged", "merged PR awaits deployment receipt; unmeasured");
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
        return { ...source, key: opportunityKey(source.candidate), at: clock.iso(), state: "unavailable" as const,
          reason: `outcome evidence unavailable: ${String(error)}`, leadTimeMs: null, failureRework: null };
      }
    });
    ports.save(outcomes);
    return outcomes;
  } finally { ports.dispose?.(); }
}

function readOutcomes(path: string): OpportunityOutcome[] {
  try {
    const rows: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(rows) || rows.some((row) => !row?.candidate?.repo || !row?.candidate?.key || !Array.isArray(row.sourceIds))) throw new Error(`malformed outcomes: ${path}`);
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

/** Re-read source and runtime receipts on the admitted intake cadence; never change policy. */
export function productionOpportunityOutcomePorts(garden: GardenerDeps, deps: {
  intake?: OpportunityIntakePorts;
  fetch?: (args: string[]) => unknown;
  readRows?: () => Record<string, unknown>[];
} = {}): OpportunityOutcomePorts {
  const intake = deps.intake ?? productionOpportunityIntakePorts(garden);
  const clock = garden.clock ?? systemClock;
  const fetch = deps.fetch ?? ghJson;
  const path = join(garden.stateDir, "opportunity-outcomes.json");
  const registryPath = join(garden.stateDir, "inbox-proposals.json");
  let work: OpportunityWork;
  let rows: Record<string, unknown>[];
  const sources = new Map<string, OpportunitySource>();
  return {
    clock, dispose: intake.dispose,
    readSources: () => {
      work = intake.readWork();
      const previous = readOutcomes(path);
      for (const row of previous) sources.set(row.key, { candidate: row.candidate, proposalId: row.proposalId, sourceIds: row.sourceIds, codeql: row.codeql, expiresAt: row.expiresAt });
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
      return [...sources.values()];
    },
    readEvidence: (source) => {
      const tasks = matchingTasks(work, source);
      if (tasks.length > 1) throw new Error("ambiguous ratified task join");
      const task = tasks[0];
      if (!task) return {};
      const filing = rows.find((r) => r.step === "ratify.approved" && r.task_id === source.proposalId);
      const result: OpportunityEvidence = { task: { id: task.id, repo: intake.repo, key: source.candidate.key, filedAt: typeof filing?.ts === "string" ? filing.ts : undefined } };
      const credit = loadCreditStore(join(garden.stateDir, "merge-credit.json"))[task.id];
      const entry = [credit?.trailer, credit?.["head-branch"]].find((e) => e?.prState === "MERGED" && !credit?.invalidated?.[e.source]);
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
    save: (outcomes) => writeAtomic(path, JSON.stringify(outcomes, null, 2) + "\n"),
  };
}
