import { execFileSync } from "node:child_process";
import { appendLedger } from "./ledger.js";

/**
 * Escalations as GitHub issues (W1-T8, MASTER-PLAN §4 "Escalation taxonomy").
 *
 * The loop never waits on a human except for four classes: BLOCKED (post-diagnose,
 * two-strikes exhausted), MANUAL (secrets, repo creation, deploys, eyeball/playtest
 * gates), HARD_STOP (the deterministic hard-stop list — destructive ops, spend
 * beyond cap, force-push, secret handling), and GRILL (an ambiguous feedback item
 * the intake triage cannot decide alone — MASTER-PLAN §7B, W1-T42; reuses this SAME
 * machinery rather than a second one, per the task's own directive). Every one of
 * these opens a `needs-human` labeled issue carrying the OPTIONS available and the
 * machine's RECOMMENDATION, so the issue itself is actionable rather than a bare
 * alert. (DECISION/DIRECTION classes are absorbed elsewhere — auto-choose and
 * idle-groom respectively — and ASYNC-QUESTION deliberately never escalates; see
 * §2/§4. GRILL does not block the loop either — like BLOCKED it collapses to the
 * digest, never a real-time ping — but it IS a needs-human issue, unlike
 * ASYNC-QUESTION, because MASTER-PLAN §7B names this specific case as reusing §4's
 * escalation taxonomy verbatim.)
 */
export type EscalationClass = "BLOCKED" | "MANUAL" | "HARD_STOP" | "GRILL";

/** One choice a human can make to resolve the escalation. */
export interface EscalationOption {
  label: string;
  detail: string;
}

export interface Escalation {
  class: EscalationClass;
  taskId: string;
  runId?: string;
  /** Short human summary; becomes the issue title. */
  summary: string;
  /** Longer context: what happened, why it's stuck, relevant links. */
  detail: string;
  /** The choices a human can make — REQUIRED; an escalation with no options is a bare alert. */
  options: EscalationOption[];
  /** Which option the machine recommends (auto-choose doctrine, §4) — must be one of options[].label. */
  recommendation: string;
}

/** GitHub issue creation, behind an interface so tests never touch the network. */
export interface IssueGateway {
  /** Create a labeled issue; returns its URL. */
  create(title: string, body: string, labels: string[]): string;
}

/** Per-class label, alongside the blanket `needs-human` queue label. */
const CLASS_LABEL: Record<EscalationClass, string> = {
  BLOCKED: "escalation-blocked",
  MANUAL: "escalation-manual",
  HARD_STOP: "escalation-hard-stop",
  GRILL: "escalation-grill",
};

/** The label every escalation issue carries — the queue the control panel reads (§4). */
export const NEEDS_HUMAN_LABEL = "needs-human";

/** Render the issue body: context, the options, and the recommendation called out. */
export function renderIssueBody(e: Escalation): string {
  const lines = [
    `**Class:** ${e.class}`,
    `**Task:** ${e.taskId}`,
    e.runId ? `**Run:** ${e.runId}` : undefined,
    "",
    e.detail,
    "",
    "## Options",
    ...e.options.map((o) => `- **${o.label}** — ${o.detail}`),
    "",
    "## Recommendation",
    e.recommendation,
    "",
    "_Opened automatically by Remudero (MASTER-PLAN §4 escalation taxonomy). Closing this issue does_",
    "_not resolve the underlying block by itself — act on it, then resume via `rmd drain`._",
  ].filter((l): l is string => l !== undefined);
  return lines.join("\n");
}

export interface EscalateDeps {
  issues: IssueGateway;
  ledgerPath: string;
  runId: string;
}

/**
 * Open a labeled GitHub issue for one escalation + log the ledger line. Returns the
 * issue URL. An escalation with zero options is refused — bare alerts with no
 * actionable choice are exactly what this taxonomy exists to avoid (§4).
 */
export function escalate(e: Escalation, deps: EscalateDeps): string {
  if (e.options.length === 0) {
    throw new Error(`escalation for ${e.taskId} has no options — every escalation needs an actionable choice`);
  }
  const title = `[${e.class}] ${e.taskId}: ${e.summary}`;
  const body = renderIssueBody(e);
  const labels = [NEEDS_HUMAN_LABEL, CLASS_LABEL[e.class]];
  const url = deps.issues.create(title, body, labels);
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: e.taskId,
    step: "escalation.issue_opened",
    class: e.class,
    issue_url: url,
    labels,
  });
  return url;
}

/**
 * Real gateway: `gh issue create`, scoped to `owner/repo`. Runs outside the sandbox
 * (gh is documented to fail TLS verification under Seatbelt, §4A) but still inside
 * bypass + the deny-hook floor, carrying only the scoped PAT.
 */
export function ghIssueGateway(owner: string, repo: string): IssueGateway {
  return {
    create(title, body, labels) {
      const args = ["issue", "create", "--repo", `${owner}/${repo}`, "--title", title, "--body", body];
      for (const label of labels) args.push("--label", label);
      return execFileSync("gh", args, { encoding: "utf8" }).trim();
    },
  };
}
