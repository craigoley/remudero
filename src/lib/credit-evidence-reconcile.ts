/**
 * Read-only reconciliation between Remudero's two implementation-credit surfaces.
 *
 * Dispatch credits an anchored `Remudero-Task` trailer (PR body or squash-commit body) or an
 * owned `run-<task-id>-<digits>` head branch. `lint-plan` credits a non-filing commit whose body
 * carries the trailer or whose subject names the task. Neither evidence set contains the other.
 * This module reports that split and proposes the existing operator correction command; it has
 * no filesystem, ledger, process, or network dependency and cannot apply a correction itself.
 */

/** Filing subjects cite work; they are not implementation evidence to `lint-plan`. */
export const LINT_FILING_SUBJECT_RE =
  /^(chore\(plan\)|chore\(triage\)|chore\(feedback\)|docs\(plan\)|plan:|docs:|chore:)/i;

/** PRIMARY CONTROL: maximum disagreement rows rendered in the human status view; JSON remains complete. */
export const CREDIT_EVIDENCE_TEXT_ROW_LIMIT = 20;

export interface CreditEvidenceMergedPr {
  number: number;
  url: string;
  headRefName?: string;
  body?: string;
}

export interface CreditSignals {
  dispatchTrailer: boolean;
  dispatchHeadBranch: boolean;
  lintTrailer: boolean;
  lintSubject: boolean;
}

export type CreditEvidenceDisagreement = "dispatch_only" | "lint_only";

export interface CreditEvidenceTaskReport {
  taskId: string;
  signals: CreditSignals;
  dispatchCredited: boolean;
  lintCredited: boolean;
  disagreement: CreditEvidenceDisagreement | null;
}

export interface CreditCorrectionCandidate {
  taskId: string;
  disagreement: CreditEvidenceDisagreement;
  prNumber: number | undefined;
  prUrl: string | undefined;
  command: string | undefined;
  requiresOperatorConfirmation: true;
}

export interface CreditEvidenceReport {
  tasks: CreditEvidenceTaskReport[];
  disagreements: CreditEvidenceTaskReport[];
  candidates: CreditCorrectionCandidate[];
}

interface CommitEvidence {
  subject: string;
  body: string;
  filing: boolean;
  prNumber: number | undefined;
}

interface SignalMatch {
  hit: boolean;
  prNumbers: number[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCommits(gitLogDump: string): CommitEvidence[] {
  return gitLogDump
    .split("\x01")
    .map((entry) => entry.split("\x00"))
    .filter((parts) => Boolean(parts[0]?.trim()))
    .map(([subject = "", body = ""]) => ({
      subject,
      body,
      filing: LINT_FILING_SUBJECT_RE.test(subject.trim()),
      prNumber: prNumberFromSquashSubject(subject),
    }));
}

function prNumberFromSquashSubject(subject: string): number | undefined {
  const raw = subject.match(/\(#(\d+)\)\s*$/)?.[1];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function lintSubjectMatches(subject: string, taskId: string): boolean {
  const escaped = escapeRegExp(taskId.toLowerCase());
  return new RegExp(`[(\\s,:]${escaped}[)\\s,:.]`).test(` ${subject.toLowerCase()} `);
}

function lintTrailerMatches(body: string, taskId: string): boolean {
  const trailer = `remudero-task: ${taskId.toLowerCase()}`;
  const lowered = body.toLowerCase();
  return lowered.includes(`${trailer}\n`) || lowered.trimEnd().endsWith(trailer);
}

function dispatchTrailerMatches(body: string | undefined, taskId: string): boolean {
  if (!body) return false;
  return new RegExp(`^Remudero-Task:\\s*${escapeRegExp(taskId)}\\s*$`, "m").test(body);
}

function dispatchHeadMatches(headRefName: string | undefined, taskId: string): boolean {
  if (!headRefName) return false;
  return new RegExp(`^run-${escapeRegExp(taskId)}-\\d+$`).test(headRefName);
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined))];
}

function commitSignal(
  commits: readonly CommitEvidence[],
  predicate: (commit: CommitEvidence) => boolean,
): SignalMatch {
  const matches = commits.filter(predicate);
  return { hit: matches.length > 0, prNumbers: uniqueNumbers(matches.map((commit) => commit.prNumber)) };
}

function lintSignalsFromCommits(
  taskId: string,
  nonFilingCommits: readonly CommitEvidence[],
): Pick<CreditSignals, "lintTrailer" | "lintSubject"> {
  return {
    lintTrailer: nonFilingCommits.some((commit) => lintTrailerMatches(commit.body, taskId)),
    lintSubject: nonFilingCommits.some((commit) => lintSubjectMatches(commit.subject, taskId)),
  };
}

/** Bulk form used by `lint-plan`, so a whole-history dump is parsed once rather than per task. */
export function lintCreditSignalsForTasks(
  taskIds: readonly string[],
  gitLogDump: string,
): Map<string, Pick<CreditSignals, "lintTrailer" | "lintSubject">> {
  const nonFilingCommits = parseCommits(gitLogDump).filter((commit) => !commit.filing);
  return new Map(taskIds.map((taskId) => [taskId, lintSignalsFromCommits(taskId, nonFilingCommits)]));
}

/** The exact two `lint-plan` signals, shared with its existing failing-split classifier. */
export function lintCreditSignals(taskId: string, gitLogDump: string): Pick<CreditSignals, "lintTrailer" | "lintSubject"> {
  return lintCreditSignalsForTasks([taskId], gitLogDump).get(taskId) ?? { lintTrailer: false, lintSubject: false };
}

/**
 * Compare the two evidence sets for every supplied open task. The output keeps one row per input
 * task, even when no signal fires, so consumers cannot turn an omitted row into an assumed answer.
 */
export function reconcileCreditEvidence(
  taskIds: readonly string[],
  gitLogDump: string,
  mergedPrs: readonly CreditEvidenceMergedPr[],
): CreditEvidenceReport {
  const commits = parseCommits(gitLogDump);
  const nonFiling = commits.filter((commit) => !commit.filing);
  const tasks: CreditEvidenceTaskReport[] = [];
  const candidates: CreditCorrectionCandidate[] = [];

  for (const taskId of taskIds) {
    const dispatchPrTrailerMatches = mergedPrs.filter((pr) => dispatchTrailerMatches(pr.body, taskId));
    // The dispatcher's local commit fallback indexes only squash subjects that identify a PR.
    const dispatchCommitTrailer = commitSignal(
      commits,
      (commit) => commit.prNumber !== undefined && dispatchTrailerMatches(commit.body, taskId),
    );
    const dispatchHeadMatchesForTask = mergedPrs.filter((pr) => dispatchHeadMatches(pr.headRefName, taskId));
    const lintTrailerMatchesForTask = commitSignal(nonFiling, (commit) => lintTrailerMatches(commit.body, taskId));
    const lintSubjectMatchesForTask = commitSignal(nonFiling, (commit) => lintSubjectMatches(commit.subject, taskId));

    const signals: CreditSignals = {
      dispatchTrailer: dispatchPrTrailerMatches.length > 0 || dispatchCommitTrailer.hit,
      dispatchHeadBranch: dispatchHeadMatchesForTask.length > 0,
      lintTrailer: lintTrailerMatchesForTask.hit,
      lintSubject: lintSubjectMatchesForTask.hit,
    };
    const dispatchCredited = signals.dispatchTrailer || signals.dispatchHeadBranch;
    const lintCredited = signals.lintTrailer || signals.lintSubject;
    const disagreement: CreditEvidenceDisagreement | null =
      dispatchCredited === lintCredited ? null : dispatchCredited ? "dispatch_only" : "lint_only";
    const row: CreditEvidenceTaskReport = { taskId, signals, dispatchCredited, lintCredited, disagreement };
    tasks.push(row);

    if (disagreement) {
      const prNumbers = uniqueNumbers([
        ...dispatchPrTrailerMatches.map((pr) => pr.number),
        ...dispatchCommitTrailer.prNumbers,
        ...dispatchHeadMatchesForTask.map((pr) => pr.number),
        ...lintTrailerMatchesForTask.prNumbers,
        ...lintSubjectMatchesForTask.prNumbers,
      ]);
      const prNumber = prNumbers[0];
      const prUrl = mergedPrs.find((pr) => pr.number === prNumber)?.url;
      candidates.push({
        taskId,
        disagreement,
        prNumber,
        prUrl,
        command: prNumber === undefined ? undefined : `rmd correct ${taskId} --pr ${prNumber}`,
        requiresOperatorConfirmation: true,
      });
    }
  }

  return { tasks, disagreements: tasks.filter((row) => row.disagreement !== null), candidates };
}

/** Compact text for `rmd status`; the JSON sibling retains every per-task row. */
export function renderCreditEvidenceReport(report: CreditEvidenceReport, ref: string): string {
  const header = "── CREDIT EVIDENCE ─────────────────────────────────────";
  const lines = [
    header,
    `  ${report.tasks.length} open task(s) checked on ${ref}; ${report.disagreements.length} dispatch/lint disagreement(s)`,
  ];
  if (report.disagreements.length === 0) {
    lines.push("  no correction candidates");
    return lines.join("\n");
  }
  const candidateByTask = new Map(report.candidates.map((candidate) => [candidate.taskId, candidate]));
  for (const row of report.disagreements.slice(0, CREDIT_EVIDENCE_TEXT_ROW_LIMIT)) {
    const fired = Object.entries(row.signals)
      .filter(([, hit]) => hit)
      .map(([name]) => name)
      .join(", ") || "none";
    const candidate = candidateByTask.get(row.taskId);
    const action = candidate?.command ?? "PR number unresolved; inspect before correcting";
    lines.push(`  ! ${row.taskId}: ${row.disagreement}; signals=${fired}; candidate=${action}`);
  }
  const omitted = report.disagreements.length - CREDIT_EVIDENCE_TEXT_ROW_LIMIT;
  if (omitted > 0) lines.push(`  ... ${omitted} more disagreement(s); use --json for the complete report`);
  lines.push("  candidates are proposals only; each requires operator confirmation");
  return lines.join("\n");
}
