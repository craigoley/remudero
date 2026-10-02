import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { stringify } from "yaml";
import { systemClock, type Clock } from "./clock.js";
import { partitionCodeqlQualityAlerts, codeqlQualityProposalId } from "./codeql-quality-intake.js";
import { ciFrictionOrigin, ciFrictionRoundsFromLedger, priceCiFrictionCauses, readCiFrictionLedgerRecords, readGateFireRateReport } from "./ci-friction-gardener.js";
import { feedbackEntryPath, listFeedback, type FeedbackEntry } from "./feedback.js";
import type { GateFireRateReport } from "./gate-fire-rate.js";
import type { GardenerDeps } from "./gardener.js";
import { ghJson } from "./github-transport.js";
import { loadProposalRegistry, updateProposalRegistry, type Proposal } from "./inbox.js";
import { familyTrackRecord, judgeMachineShard } from "./machine-filing-judge.js";
import { recordMeasurementCadenceFire } from "./measurement-cadence.js";
import { loadMounts, mountsPath } from "./mounts.js";
import { readCodeScanningAlerts, type CodeScanningAlertsRead } from "./ops.js";
import { loadPlan, type Task, type Plan } from "./plan.js";
import { loadProposalRecords } from "./plan-proposals.js";
import { policyPath } from "./policy.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { readStandingRetroDebt, mineFollowups, followupProposalId, type LedgerRecord } from "./retro.js";
import { DEFAULT_RISK_POLICY, readRiskPolicy, realRiskJudge, resolveRiskJudgeMount, type RiskJudgeInput, type RiskJudgeVerdict, type RiskPolicy } from "./risk-judge.js";
import { loadCreditStore } from "./status.js";
import { gateFireRatesPath } from "./gate-fire-rate.js";

export interface OpportunityCandidate {
  source: "standing-debt" | "codeql-quality" | "ci-friction" | "followup";
  repo: string;
  key: string;
  observedAt: string;
  anchor: string;
  availability: "available";
  freshness: "fresh";
  population: { affected: number; denominator: number; unit: string };
  impact: { value: number; unit: string };
  remedy: string;
  authority: "machine" | "operator";
  related: { task?: string; pr?: string };
}

export interface OpportunityWork {
  proposals: Proposal[];
  tasks: Task[];
  mergedKeys: string[];
  prs: { body: string }[];
  feedback: FeedbackEntry[];
}

export interface OpportunityIntakePorts {
  repo: string;
  clock: Clock;
  readStandingDebt: () => string;
  readCodeql: () => CodeScanningAlertsRead;
  readFriction: () => { records: LedgerRecord[]; gateFireRates?: GateFireRateReport };
  readWork: () => OpportunityWork;
  riskJudge: (input: RiskJudgeInput) => Promise<RiskJudgeVerdict>;
  riskPolicy?: RiskPolicy;
  fileCandidate: (candidate: OpportunityCandidate) => Promise<string | undefined>;
  stageProposal: (candidate: OpportunityCandidate, reasons: string[]) => void;
  dispose?: () => void;
}

export interface OpportunityIntakeResult {
  status: "promoted" | "empty" | "unavailable" | "held";
  candidate?: OpportunityCandidate;
  destination?: "plan-pr" | "inbox";
  prUrl?: string;
  unavailable: string[];
  deduped: string[];
}

/** Each source keeps its own denominator and units; incomparable prices are never summed. */
export function collectOpportunityCandidates(ports: OpportunityIntakePorts, work?: OpportunityWork): { candidates: OpportunityCandidate[]; unavailable: string[] } {
  const candidates: OpportunityCandidate[] = [];
  const unavailable: string[] = [];
  const observedAt = ports.clock.iso();
  const add = (source: OpportunityCandidate["source"], key: string, anchor: string, affected: number, denominator: number, unit: string, value: number, impactUnit: string, remedy: string, related: OpportunityCandidate["related"] = {}, authority: OpportunityCandidate["authority"] = "machine") => {
    candidates.push({ source, key, repo: ports.repo, observedAt, anchor, availability: "available", freshness: "fresh", population: { affected, denominator, unit }, impact: { value, unit: impactUnit }, remedy, authority, related });
  };
  try {
    const debt = readStandingRetroDebt(ports.readStandingDebt());
    for (const entry of debt.entries) {
      add("standing-debt", `standing-debt:${entry.number}`, `MASTER-PLAN.md#standing-debt-${entry.number}`, 1, debt.openCount, "open debt entries", entry.ageCycles, "cycles of dwell", entry.text);
    }
  } catch (error) {
    unavailable.push(`standing-debt unavailable: ${String(error)}`);
  }
  try {
    const source = ports.readCodeql();
    if (!source.ok) throw new Error(source.error);
    const partition = partitionCodeqlQualityAlerts(source.alerts, work?.feedback ?? [], []);
    const rules = [...new Set(partition.unassigned.map((alert) => alert.ruleId))].sort();
    for (const rule of rules) {
      const alerts = partition.unassigned.filter((alert) => alert.ruleId === rule);
      if (!alerts[0]!.url) throw new Error(`quality rule ${rule} has no source anchor`);
      add("codeql-quality", codeqlQualityProposalId(rule), alerts[0]!.url, alerts.length, partition.scannedTotal, "scanned alerts", alerts.length, "open quality alerts", `Repair CodeQL quality rule ${rule} in one bounded cleanup; verify all ${alerts.length} alert(s) without dismissing them.`);
    }
  } catch (error) {
    unavailable.push(`codeql-quality unavailable: ${String(error)}`);
  }
  try {
    const { records, gateFireRates } = ports.readFriction();
    const rounds = ciFrictionRoundsFromLedger(records);
    const prices = priceCiFrictionCauses(rounds, gateFireRates, ports.clock.now());
    const denominator = prices.reduce((sum, row) => sum + row.rounds, 0);
    for (const price of prices.filter((row) => row.minutes > 0)) {
      add("ci-friction", ciFrictionOrigin(price.cause), `ledger#${ciFrictionOrigin(price.cause)}`, price.rounds, denominator, "priced CI rounds", price.minutes, "PR minutes lost", `Repair the ${price.cause.kind}:${price.cause.name} cause of measured CI friction.`);
    }
    const harvest = mineFollowups(records);
    for (const entry of harvest.candidates) {
      if (entry.runId === "?" || entry.taskId === "?" || entry.entryId.includes(":?:")) {
        unavailable.push(`followup unavailable: ${entry.entryId} has incomplete provenance`);
        continue;
      }
      add("followup", followupProposalId(entry), `ledger#${entry.entryId}`, 1, harvest.candidates.length + harvest.deduped.length, "follow-up entries", 1, "reported follow-up", entry.text, { task: entry.taskId, pr: entry.prUrl }, entry.type === "action" ? "operator" : "machine");
    }
  } catch (error) {
    unavailable.push(`ci-friction/followup unavailable: ${String(error)}`);
  }
  return { candidates, unavailable };
}

export function opportunityKey(candidate: Pick<OpportunityCandidate, "repo" | "key">): string {
  return `${candidate.repo}/${candidate.key}`;
}

function covered(candidate: OpportunityCandidate, work: OpportunityWork): boolean {
  const key = opportunityKey(candidate);
  const marker = `Opportunity-Key: ${key}`;
  const carriesKey = (text: string | undefined): boolean => text?.split("\n").some((line) => line.trim() === marker) ?? false;
  return work.mergedKeys.includes(key) ||
    work.proposals.some((p) => p.id === candidate.key || p.id === key || carriesKey(p.summary)) ||
    work.tasks.some((task) => (task.repo === candidate.repo || task.repo === candidate.repo.split("/")[1]) &&
      (task.origin === candidate.key || task.origin === key || carriesKey(task.note) || carriesKey(task.prompt))) ||
    work.prs.some((pr) => carriesKey(pr.body)) ||
    work.feedback.some((entry) => entry.submission_key === key || carriesKey(entry.raw));
}

/** One routing pass; judgement failure holds evidence rather than manufacturing a human decision. */
export async function runOpportunityIntake(ports: OpportunityIntakePorts): Promise<OpportunityIntakeResult> {
  try {
    let work: OpportunityWork;
    try { work = ports.readWork(); }
    catch (error) { return { status: "unavailable", deduped: [], unavailable: [`dedupe unavailable: ${String(error)}`] }; }
    const { candidates, unavailable } = collectOpportunityCandidates(ports, work);
    const result: OpportunityIntakeResult = { status: "empty", unavailable, deduped: [] };
    const candidate = candidates.find((entry) => {
      if (!covered(entry, work)) return true;
      result.deduped.push(entry.key);
      return false;
    });
    if (!candidate) return { ...result, status: unavailable.length ? "unavailable" : "empty" };
    const task: Task = {
      id: `OPPORTUNITY-${candidate.key}`, title: candidate.remedy, repo: candidate.repo,
      depends_on: [], type: "implement", verify: "human", risk: "low", status: "queued",
      attempts: 0, author_class: "machine", origin: candidate.key,
      prompt: JSON.stringify(candidate),
    };
    const plan: Plan = { tasks: work.tasks, byId: new Map(work.tasks.map((entry) => [entry.id, entry])) };
    const judgement = await judgeMachineShard(task, familyTrackRecord(plan, candidate.source, (id) => {
      const origin = work.tasks.find((entry) => entry.id === id)?.origin;
      return origin !== undefined && work.mergedKeys.includes(`${candidate.repo}/${origin}`);
    }), {
      riskJudge: ports.riskJudge, policy: ports.riskPolicy ?? DEFAULT_RISK_POLICY, clock: ports.clock,
    });
    if (judgement.kind === "unavailable") return { ...result, status: "unavailable", unavailable: [...unavailable, judgement.reason] };
    if (judgement.ruling.action === "escalate" && judgement.ruling.verdict !== "high") return { ...result, status: "held", candidate };
    // Re-read after the paid judgement; another writer may have filed this source in the meantime.
    let currentWork: OpportunityWork;
    try { currentWork = ports.readWork(); }
    catch (error) { return { ...result, status: "unavailable", unavailable: [...unavailable, `dedupe recheck unavailable: ${String(error)}`] }; }
    if (covered(candidate, currentWork)) return { ...result, deduped: [...result.deduped, candidate.key] };
    if (candidate.authority === "operator" || judgement.ruling.action === "escalate") {
      candidate.authority = "operator";
      ports.stageProposal(candidate, judgement.ruling.reasons);
      return { ...result, status: "promoted", candidate, destination: "inbox" };
    }
    const prUrl = await ports.fileCandidate(candidate);
    return { ...result, status: prUrl ? "promoted" : "held", candidate, destination: "plan-pr", prUrl };
  } finally {
    ports.dispose?.();
  }
}

/** Use the daemon's existing checkout/landing ports and feedback-to-plan workflow, with no timer. */
export function productionOpportunityIntakePorts(garden: GardenerDeps, deps: {
  readCodeql?: OpportunityIntakePorts["readCodeql"];
  readFriction?: OpportunityIntakePorts["readFriction"];
  riskJudge?: OpportunityIntakePorts["riskJudge"];
  readPulls?: (repo: string) => unknown;
} = {}): OpportunityIntakePorts {
  const clock = garden.clock ?? systemClock;
  recordMeasurementCadenceFire(join(garden.stateDir, "last-intake-cadence-codeqlQuality.json"), clock.date(), 24 * 60 * 60 * 1000);
  const ws = garden.openWorkspace();
  try {
    const remote = execFileSync("git", ["-C", ws.root, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    const matched = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
    if (!matched) throw new Error("opportunity intake requires a GitHub repository identity");
    const repo = `${matched[1]}/${matched[2]}`;
    const layout = resolveRepoLayout(ws.root);
    let records: LedgerRecord[] | undefined;
    let judge = deps.riskJudge;
    return {
      repo, clock, dispose: () => ws.dispose(),
      readStandingDebt: () => readFileSync(layout.masterPlan, "utf8"),
      readCodeql: deps.readCodeql ?? (() => readCodeScanningAlerts(matched[1]!, matched[2]!)),
      readFriction: deps.readFriction ?? (() => {
        const gateFireRates = readGateFireRateReport(garden.stateDir);
        if (existsSync(gateFireRatesPath(garden.stateDir)) && !gateFireRates) throw new Error("gate fire-rate report unreadable");
        return { records: records ??= readCiFrictionLedgerRecords(garden.stateDir), gateFireRates };
      }),
      readWork: () => {
        const pages = deps.readPulls ? deps.readPulls(repo) : ghJson(["api", `repos/${repo}/pulls?state=open&per_page=100`, "--paginate", "--slurp"]);
        if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error("open PR dedupe corpus unreadable");
        const tasks = loadPlan(layout.planMonolith).tasks;
        const proposals = loadProposalRegistry(join(garden.stateDir, "inbox-proposals.json"));
        for (const record of loadProposalRecords(join(layout.planDir, "proposals.d"))) {
          if (record.status === "open" && record.source) proposals.push({ id: record.source, summary: record.title, evidenceAnchors: [] });
        }
        const credited = loadCreditStore(join(garden.stateDir, "merge-credit.json"));
        const mergedKeys = tasks.filter((task) => credited[task.id] && task.origin).map((task) => `${repo}/${task.origin}`);
        return { tasks, proposals, mergedKeys, prs: pages.flat().map((pr) => ({ body: String(pr.body ?? "") })), feedback: listFeedback(ws.root) };
      },
      riskPolicy: readRiskPolicy(policyPath(ws.root)),
      riskJudge: (input) => {
        if (!judge) {
          const mounts = loadMounts(mountsPath(ws.root));
          judge = realRiskJudge({ mount: mounts.machine_filing_judge ?? resolveRiskJudgeMount(mounts), cwd: ws.root, settingsFile: join(ws.root, "settings", "worker.json"), log: garden.log });
        }
        return judge(input);
      },
      stageProposal: (candidate, reasons) => {
        updateProposalRegistry(join(garden.stateDir, "inbox-proposals.json"), (current) => {
          if (current.some((entry) => entry.id === opportunityKey(candidate))) return null;
          return [...current, { id: opportunityKey(candidate), summary: `${candidate.remedy}\nOpportunity-Key: ${opportunityKey(candidate)}\n${JSON.stringify(candidate)}\n${reasons.join("\n")}`, evidenceAnchors: [] }];
        });
      },
      fileCandidate: async (candidate) => {
        const key = opportunityKey(candidate);
        const id = `fb-opportunity-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
        const entry: FeedbackEntry = {
          id, ts: clock.iso(), raw: `Opportunity-Key: ${key}\n${JSON.stringify(candidate)}\nDraft one bounded task through the normal triage and machine-filing judge, with author_class: machine. Preserve origin: ${candidate.key} and the exact Opportunity-Key line on the task. Establish executable acceptance before filing.`,
          origin: "cli", status: "new", attachments: [], proposal_pr: null, submission_key: key,
        };
        const path = feedbackEntryPath(ws.root, id);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, stringify(entry));
        return ws.land({ paths: [relative(ws.root, path)], title: "chore(plan): route one measured opportunity for governed triage", body: `Route one source-qualified candidate through the existing feedback-to-plan workflow.\n\nOpportunity-Key: ${key}\n\n${JSON.stringify(candidate)}` });
      },
    };
  } catch (error) {
    ws.dispose();
    throw error;
  }
}
