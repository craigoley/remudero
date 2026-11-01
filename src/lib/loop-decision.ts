import { rowPrNumber } from "./fix-progress-judge.js";
import { spendRoleOf } from "./spend-rows.js";

type Row = Record<string, unknown>;
type Criterion = { claim: string; met: boolean; proof_exec: string };
export interface LoopDecisionInput {
  taskId?: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  reviewInputDigest?: string;
  reviewState: string;
  checksGreen: boolean;
  mergeClean: boolean;
  changedFiles?: readonly string[];
  pushThroughFollowUp?: boolean;
  ledger: readonly Row[];
}
export interface LoopDecision {
  trigger: "repeated-claim" | "needs-scope-or-design" | "six-fix-rounds" | "repeated-change-approach";
  route: "push-through" | "split" | "close-and-rebuild";
  unmet_classes: string[];
  tokens_spent: number;
}

const object = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
function criteriaOf(value: unknown): Criterion[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(c => {
    const v = object(c);
    return typeof v.claim === "string" && v.claim.trim() !== "" && typeof v.met === "boolean" && typeof v.proof_exec === "string";
  })) return undefined;
  return value as Criterion[];
}

function protectedPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(p => p === "." || p === "..")) return true;
  return /^(?:deploy|\.github|hooks|scripts|\.git|\.ssh|secrets|credentials)(?:\/|$)/i.test(path) ||
    path === "src/run-task.ts" ||
    /(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:pem|key|p12))$/i.test(path) ||
    /(?:^|\/)[^/]*(?:credential|secret|review|merge|risk|gate|ledger|loop-decision|sweep|policy|classify|pr-blocker)[^/]*\.(?:[cm]?[jt]sx?|json|ya?ml)$/i.test(path);
}

/** Shadow only (W1-T11076): replay existing receipts; the caller records the result without acting on it. */
export function decideLoopOutcome(input: LoopDecisionInput): LoopDecision | undefined {
  if (input.reviewState !== "failure") return undefined;
  const rows = input.ledger.filter(row => {
    const url = row.repair_pr_url ?? row.pr_url;
    if (typeof url === "string") return url === input.prUrl;
    const pr = rowPrNumber(row);
    return pr !== undefined ? pr === input.prNumber : input.taskId !== undefined && input.taskId !== "unfiled" && row.task_id === input.taskId;
  });
  if (rows.some(r => r.step === "loop.decision" || r.step === "sweep.disposed" && r.loop_decision !== undefined)) return undefined;
  const done = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.step === "fix.done" && typeof r.round_id === "string" && !done.has(r.round_id)) done.set(r.round_id, i);
  });
  const completed = new Set<string>();
  const approaches = new Map<string, Set<string>>();
  const repairedClaims = new Map<string, number>();
  let failedClaims = new Set<string>();
  let trigger: LoopDecision["trigger"] | undefined;
  let verdict: Row = {};
  let currentCriteria: Criterion[] | undefined;
  let reviewFailing = input.reviewState === "failure";
  let tokens = 0;
  for (const [index, row] of rows.entries()) {
    if (spendRoleOf(row) === "produced") {
      const usage = object(row.tokens);
      tokens += number(usage.input) + number(usage.output) + number(usage.cacheRead ?? row.cache_read_input_tokens) +
        number(usage.cacheCreation ?? row.cache_creation_input_tokens);
    }
    if (row.step === "review.posted") {
      const nextVerdict = object(row.decision_verdict);
      const next = criteriaOf(nextVerdict.criteria);
      reviewFailing = (row.state ?? nextVerdict.state) === "failure";
      failedClaims = new Set((next ?? []).filter(c => !c.met).map(c => c.claim));
      if ((row.state === "failure" || nextVerdict.state === "failure") &&
          [...failedClaims].some(c => repairedClaims.has(c) && repairedClaims.get(c)! < index)) trigger ??= "repeated-claim";
      if (row.head_sha === input.headSha &&
          (input.reviewInputDigest === undefined || row.review_input_digest === input.reviewInputDigest)) {
        verdict = nextVerdict;
        currentCriteria = next;
      }
    } else if (row.step === "fix.dispatch" && row.mode === "reviewer-unmet" && row.kind !== "proof_amendment") {
      // The producer writes dispatch at round end; its paired terminal may precede this row.
      const completedAt = typeof row.round_id === "string" ? done.get(row.round_id) : undefined;
      if (completedAt !== undefined) {
        const claims = Array.isArray(row.unmet_claims) ? row.unmet_claims : [...failedClaims];
        for (const claim of claims) if (typeof claim === "string") repairedClaims.set(claim, Math.max(index, completedAt));
      }
    } else if (row.step === "fix.done") {
      completed.add(typeof row.round_id === "string" ? row.round_id : `legacy:${index}`);
      if (reviewFailing && (row.fix_outcome === "NEEDS_SCOPE" || row.fix_outcome === "NEEDS_DESIGN")) trigger ??= "needs-scope-or-design";
      if (completed.size >= 6) trigger ??= "six-fix-rounds";
    } else if (row.step === "fix.progress_judged" && row.verdict === "change-approach" && typeof row.red_class === "string" && row.red_class !== "") {
      const seen = approaches.get(row.red_class) ?? new Set<string>();
      seen.add(typeof row.input_key === "string" ? row.input_key : `row:${index}`);
      approaches.set(row.red_class, seen);
      if (seen.size >= 2) trigger ??= "repeated-change-approach";
    }
  }
  if (!trigger) return undefined;
  const unmet = (currentCriteria ?? []).filter(c => !c.met);
  const unmetClasses = [...new Set(unmet.map(c => c.proof_exec === "executed_pass" ? "semantic-downgrade" : c.proof_exec || "unobserved-proof"))].sort();
  if (!currentCriteria) unmetClasses.push("unavailable-review");
  const flagsClear = verdict.testTheater === false && verdict.criteriaTampered !== true && verdict.instrumentEntangled !== true &&
    !(Array.isArray(verdict.changesetContradictions) && verdict.changesetContradictions.length > 0) &&
    !(typeof verdict.rewardHackingGap === "number" && verdict.rewardHackingGap > 0);
  const reproduced = rows.some(r => r.step === "review.finding" && r.head_sha === input.headSha &&
    (r.reproduced === true || r.defect_reproduced === true || object(r.anchor).status === "verified"));
  const paths = input.changedFiles;
  const pushThrough = unmet.length > 0 && unmet.length * 2 <= (currentCriteria?.length ?? 0) &&
    unmet.every(c => c.proof_exec === "executed_pass") && input.checksGreen && input.mergeClean && flagsClear && !reproduced &&
    paths !== undefined && paths.length > 0 && paths.every(p => !protectedPath(p)) && input.pushThroughFollowUp !== true;
  const split = new Set(unmet.map(c => c.claim)).size >= 2 && (currentCriteria?.length ?? 0) >= 4 && new Set(paths).size >= 4;
  return { trigger, route: pushThrough ? "push-through" : split ? "split" : "close-and-rebuild",
    unmet_classes: unmetClasses, tokens_spent: tokens };
}
