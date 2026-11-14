import { parse } from "yaml";
import { DAEMON_DRAFT_BATCH_CAP, planRatificationBatch, type DraftRungOutcome,
  type InboxClassification, type Proposal, type RatificationPayload } from "./inbox.js";
import { machineShardRisk } from "./machine-filing.js";
import { TASK_RISKS, type Task, type TaskRisk } from "./plan.js";
import type { FollowupCandidate, FollowupRouteOutcome } from "./retro.js";
import { parseWhitelistedProof } from "./review.js";
import { buildPlanPrCommitMessage } from "./plan-pr-emitter.js";

type Routed = Extract<FollowupRouteOutcome, { routed: true }>;
type Refusal = { entryId: string; reason: string };
type FilingReceipt = { prUrl: string; proposalIds: string[] };
interface SelectionFacts {
  planOnMain: readonly Pick<Task, "id" | "origin" | "risk">[];
  openPrOrigins: ReadonlySet<string>;
  ratifiedIds: ReadonlySet<string>;
  bound?: number;
}

export function selectFileableFollowups(outcomes: readonly FollowupRouteOutcome[], facts: SelectionFacts):
  { selected: Routed[]; refused: Refusal[] } {
  const origins = new Set(facts.planOnMain.map(t => t.origin));
  const seen = new Set<string>();
  const selected: Routed[] = [], refused: Refusal[] = [];
  const requested = facts.bound ?? DAEMON_DRAFT_BATCH_CAP;
  const bound = Number.isFinite(requested)
    ? Math.min(DAEMON_DRAFT_BATCH_CAP, Math.max(0, Math.floor(requested))) : DAEMON_DRAFT_BATCH_CAP;
  for (const outcome of outcomes) {
    const c = outcome.candidate;
    const origin = `followup#${c.entryId}`;
    const reason = !outcome.routed ? outcome.arm : c.type === "action" ? "human-owned-action"
      : facts.ratifiedIds.has(outcome.proposalId) || facts.ratifiedIds.has(c.entryId) ? "already-ratified"
      : origins.has(origin) || facts.openPrOrigins.has(origin) ? "already-filed-origin"
      : seen.has(c.entryId) ? "duplicate-entry" : selected.length >= bound ? "draft-bound" : undefined;
    if (reason) refused.push({ entryId: c.entryId, reason });
    else if (outcome.routed) { selected.push(outcome); seen.add(c.entryId); }
  }
  return { selected, refused };
}

export function followupProvenance(c: FollowupCandidate): string {
  return `Source task: ${c.taskId}; PR: ${c.prUrl}; head: ${c.headSha}; run: ${c.runId}\n${c.text}`;
}

export function followupFilingPresentation(proposalIds: readonly string[], stamps: readonly string[] = []) {
  const subject = `file ${proposalIds.length} follow-up proposals`;
  return { title: `chore(plan): ${subject}`,
    commitMessage: buildPlanPrCommitMessage({ scope: "plan", subject, extraBody: stamps.join("\n") }),
    intro: `Automatic filing of follow-up proposals: ${proposalIds.join(", ")}.\n\n` +
      "The ordinary plan-PR CI and semantic review gates govern this filing.",
  };
}

function draftRefusal(fragment: string, c: FollowupCandidate, sourceRisk: TaskRisk): string | undefined {
  let tasks: unknown;
  try { tasks = parse(fragment); }
  catch (error) {
    const reason = `unparseable-draft: ${String(error)}`;
    return reason;
  }
  if (!Array.isArray(tasks) || tasks.length !== 1 || !tasks[0] || typeof tasks[0] !== "object") return "expected-one-shard";
  const task = tasks[0];
  if (!Array.isArray(task.files) || task.files.length === 0 || task.files.some((p: unknown) => typeof p !== "string" || !p.trim())) return "empty-files";
  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0 || task.acceptance.some((a: { proof?: unknown } | null) =>
    typeof a?.proof !== "string" || !/^(?:unit test: [^\r\n]+|grep: [^\r\n]+ in \S+)$/.test(a.proof) ||
    parseWhitelistedProof(a.proof) === null)) return "unsupported-proof";
  if (TASK_RISKS.indexOf(machineShardRisk(task.files)) > TASK_RISKS.indexOf(sourceRisk)) return "over-risk-band";
  if (task.origin !== `followup#${c.entryId}`) return "wrong-origin";
  if (typeof task.rationale !== "string" || !task.rationale.includes(followupProvenance(c))) return "missing-provenance";
  return undefined;
}

export interface FollowupFilingDeps extends SelectionFacts {
  sourceRisk?: (candidate: FollowupCandidate) => TaskRisk | undefined;
  draft: (proposals: Proposal[]) => Promise<DraftRungOutcome[]>;
  fileBatch: (payloads: RatificationPayload[], onFiled: (receipt: FilingReceipt) => void) => Promise<FilingReceipt | undefined>;
  log: (step: string, extra: Record<string, unknown>) => void;
}

/** Publication owns its preconditions; the caller invokes it only after the registry write commits. */
export async function fileEligibleFollowups(outcomes: readonly FollowupRouteOutcome[], deps: FollowupFilingDeps):
  Promise<{ filed: string[]; refused: Refusal[] }> {
  const selection = selectFileableFollowups(outcomes, deps);
  const refused = [...selection.refused];
  const refuse = (entryId: string, reason: string) => { refused.push({ entryId, reason }); };
  const risks = new Map<string, TaskRisk>();
  const eligible = selection.selected.filter(({ candidate: c }) => {
    const risk = deps.sourceRisk ? deps.sourceRisk(c) : deps.planOnMain.find(t => t.id === c.taskId)?.risk;
    if (risk) risks.set(c.entryId, risk);
    const reason = !c.headSha || !/^[0-9a-f]{40}$/i.test(c.headSha) ? "unreadable-head-sha"
      : !c.prUrl || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*$/.test(c.prUrl) ||
        !c.taskId || c.taskId === "?" || !c.runId || c.runId === "?" ? "missing-source-provenance"
      : !risk ? "unreadable-source-risk" : undefined;
    if (reason) refuse(c.entryId, reason);
    return reason === undefined;
  });
  const proposals = eligible.map(({ candidate: c, proposalId }): Proposal => ({ id: proposalId, evidenceAnchors: [],
    summary: `Follow-up [${c.type}]. Draft exactly one shard with origin followup#${c.entryId}. ` +
      `Its rationale must contain this exact provenance and worker text:\n${followupProvenance(c)}`,
  }));
  const drafts = proposals.length ? await deps.draft(proposals) : [];
  const ready: InboxClassification[] = [];
  for (const { candidate: c, proposalId } of eligible) {
    const d = drafts.find(d => d.proposalId === proposalId);
    const risk = risks.get(c.entryId)!;
    const reason = !d ? "missing-draft" : !d.ok ? `draft-failed: ${d.error}` : draftRefusal(d.candidate.fragmentYaml, c, risk);
    if (reason) refuse(c.entryId, reason);
    else if (d?.ok) ready.push({ proposalId, state: "ready", reasons: [], draft: d.candidate });
  }
  const plan = planRatificationBatch(ready, "");
  for (const skip of plan.skipped) {
    const c = eligible.find(o => o.proposalId === skip.proposalId)!.candidate;
    refuse(c.entryId, skip.reason);
  }
  if (!plan.ok) for (const o of eligible) refuse(o.candidate.entryId, plan.refusal);
  for (const r of refused) deps.log("followup.file_refused", { entry_id: r.entryId, reason: r.reason });
  if (!plan.ok || plan.accepted.length === 0) return { filed: [], refused };
  const filed: string[] = [];
  const recordFiled = (receipt: FilingReceipt) => {
    for (const o of eligible) if (receipt.proposalIds.includes(o.proposalId) && !filed.includes(o.candidate.entryId)) {
      const c = o.candidate;
      filed.push(c.entryId);
      deps.log("followup.filed", { entry_id: c.entryId, task_id: c.taskId, pr_url: c.prUrl,
        head_sha: c.headSha, run_id: c.runId, filing_pr: receipt.prUrl });
    }
  };
  const result = await deps.fileBatch(plan.accepted, recordFiled);
  if (!result) {
    for (const p of plan.accepted) {
      const entryId = eligible.find(o => o.proposalId === p.proposalId)!.candidate.entryId;
      refuse(entryId, "batch-not-filed");
      deps.log("followup.file_refused", { entry_id: entryId, reason: "batch-not-filed" });
    }
    return { filed: [], refused };
  }
  recordFiled(result);
  return { filed, refused };
}
