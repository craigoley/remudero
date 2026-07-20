import { readLedgerLines } from "./status.js";
import { notify, type NotifyDeps } from "./notify.js";
import { renderAlertsSummary, type AlertsPollSummary } from "./ops.js";
import { renderIssuesSummary, type IssuesPollSummary } from "./issues-intake.js";

/**
 * Daily digest (W1-T8 title; assembled here, delivered here, SCHEDULED by the
 * daemon loop later (W1-T12) — this module owns no clock/cron of its own).
 *
 * MASTER-PLAN §4: "Interrupts collapse to a daily digest; real-time pings only for
 * MANUAL + hard-stop." BLOCKED escalations and ordinary run outcomes (merges,
 * blocked_* verdicts, notional cost) accumulate in the ledger all day and are
 * rolled into ONE message here, instead of paging on every one.
 */

/** One ledger line, loosely typed like {@link readLedgerLines}'s return. */
type LedgerLine = Record<string, unknown>;

/** Ledger lines with `ts >= sinceIso`, in original (chronological) order. */
export function collectSince(lines: LedgerLine[], sinceIso: string): LedgerLine[] {
  return lines.filter((l) => typeof l.ts === "string" && (l.ts as string) >= sinceIso);
}

export interface DigestSummary {
  sinceIso: string;
  merged: string[];
  blocked: Array<{ taskId: string; verdict: string; prUrl?: string }>;
  escalations: Array<{ taskId: string; class: string; issueUrl: string }>;
  costUsd: number;
  /**
   * The LATEST `ops.alerts_polled` snapshot inside the window (W1-T55, lib/ops.ts)
   * — a snapshot of OPEN alert counts+ages, not an additive event count like
   * `merged`/`blocked`, so "latest wins" rather than summing repeated polls.
   * Undefined when `rmd ops` never polled inside this window.
   */
  alerts?: AlertsPollSummary;
  /**
   * The LATEST `issues.polled` snapshot inside the window (W1-T57, lib/issues-intake.ts) — the
   * issues-reviewed count so "issues reviewed regularly" is a ledgered fact, not an intention.
   * Same "latest wins" rule as `alerts`. Undefined when `rmd issues` never polled inside this window.
   */
  issues?: IssuesPollSummary;
}

/** Reduce the day's ledger lines to the counts a digest reports. Pure over its input. */
export function summarize(lines: LedgerLine[], sinceIso: string): DigestSummary {
  const since = collectSince(lines, sinceIso);
  const summary: DigestSummary = { sinceIso, merged: [], blocked: [], escalations: [], costUsd: 0 };
  for (const l of since) {
    if (l.step === "verdict" && typeof l.task_id === "string") {
      if (l.verdict === "merged") {
        summary.merged.push(l.task_id);
      } else if (typeof l.verdict === "string" && l.verdict.startsWith("blocked")) {
        summary.blocked.push({ taskId: l.task_id, verdict: l.verdict, prUrl: typeof l.pr_url === "string" ? l.pr_url : undefined });
      }
      if (typeof l.cost_usd === "number") summary.costUsd += l.cost_usd;
    }
    if (l.step === "escalation.issue_opened" && typeof l.task_id === "string" && typeof l.issue_url === "string") {
      summary.escalations.push({ taskId: l.task_id, class: String(l.class ?? "?"), issueUrl: l.issue_url });
    }
    if (l.step === "ops.alerts_polled" && l.alerts && typeof l.alerts === "object") {
      summary.alerts = l.alerts as AlertsPollSummary;
    }
    if (l.step === "issues.polled" && l.issues && typeof l.issues === "object") {
      summary.issues = l.issues as IssuesPollSummary;
    }
  }
  return summary;
}

/** Render a {@link DigestSummary} as the digest text — what a human reads, once a day. */
export function renderDigest(s: DigestSummary): string {
  const lines = [
    `Remudero daily digest — since ${s.sinceIso}`,
    `merged: ${s.merged.length ? s.merged.join(", ") : "(none)"}`,
    `blocked: ${
      s.blocked.length ? s.blocked.map((b) => `${b.taskId} (${b.verdict}${b.prUrl ? ` — ${b.prUrl}` : ""})`).join(", ") : "(none)"
    }`,
    `escalations: ${
      s.escalations.length ? s.escalations.map((e) => `[${e.class}] ${e.taskId} — ${e.issueUrl}`).join(", ") : "(none)"
    }`,
    `alerts: ${s.alerts ? renderAlertsSummary(s.alerts) : "(no poll this window)"}`,
    `issues reviewed: ${s.issues ? renderIssuesSummary(s.issues) : "(no poll this window)"}`,
    `notional cost: $${s.costUsd.toFixed(2)}`,
  ];
  return lines.join("\n");
}

/** Build the digest text straight from a ledger file, as of `sinceIso`. */
export function buildDigest(ledgerPath: string, sinceIso: string): string {
  return renderDigest(summarize(readLedgerLines(ledgerPath), sinceIso));
}

/** Build the digest from `ledgerPath` and deliver it over the SAME notify channel as real-time pings. */
export function sendDigest(ledgerPath: string, sinceIso: string, deps: NotifyDeps): string {
  const text = buildDigest(ledgerPath, sinceIso);
  notify(text, deps);
  return text;
}
