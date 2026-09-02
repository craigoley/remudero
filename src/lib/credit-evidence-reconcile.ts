// src/lib/credit-evidence-reconcile.ts
//
// W1-T2729: THE TWO CREDIT SURFACES READ DIFFERENT EVIDENCE AND NEITHER IS A SUPERSET.
//
//   DISPATCH (lib/status.ts's rungs, what `isMerged` and therefore `isDispatchEligible` see):
//     the `Remudero-Task:` trailer  UNION  a structured `run-<id>-<digits>` merged head branch.
//   LINT (`classifyFailingMergeEvidence`, run-task.ts, what lint-plan's failing-split reports):
//     the same trailer  UNION  the task id named in a NON-FILING commit subject.
//
// Head-branch evidence is invisible to the linter; subject evidence is invisible to the
// dispatcher. So a task can read *implemented* to one surface and *unbuilt* to the other,
// simultaneously and permanently, and nothing reconciles them. MEASURED at the filing: of 584
// tasks with no trailer, 380 were named by a non-filing commit subject.
//
// THIS MODULE REPORTS AND PROPOSES. IT NEVER WRITES CREDIT — see {@link reconcileCreditEvidence}'s
// own doc for why auto-crediting from a commit subject is refused rather than merely deferred.

/** Which credit signals fire for one task. Each field is one INDEPENDENT evidence path. */
export interface CreditEvidenceRow {
  taskId: string;
  /** An anchored `Remudero-Task: <id>` trailer on a merged commit. Both surfaces read this. */
  trailer: boolean;
  /** A merged PR whose head ref was `run-<id>-<digits>`. DISPATCH-ONLY evidence. */
  headBranch: boolean;
  /** The id named in a non-filing commit subject. LINT-ONLY evidence. */
  subject: boolean;
  /** The PR number carried by that subject, when it ends `(#1234)` — the `--pr` for a correction. */
  subjectPr?: number;
}

/** A task the two surfaces disagree about, with the operator command that would settle it. */
export interface CreditDisagreement extends CreditEvidenceRow {
  /** trailer OR headBranch — what the dispatcher credits. */
  dispatchSees: boolean;
  /** trailer OR subject — what lint-plan credits. */
  lintSees: boolean;
  /** Present only when a PR number was recoverable; absent means a human must find it. */
  correctCommand?: string;
}

export interface CreditReconciliation {
  rows: readonly CreditEvidenceRow[];
  /** Tasks whose two surfaces agree, in either direction. Not a problem; counted for the control. */
  agreed: number;
  /** Every task the surfaces disagree about, in input order. */
  disagreements: readonly CreditDisagreement[];
  /**
   * The actionable subset: built-but-invisible-to-dispatch AND carrying a recoverable PR number,
   * so `rmd correct` can name it. A disagreement without a PR stays in {@link disagreements} and
   * out of here rather than being dropped — the operator still needs to see it.
   */
  candidates: readonly CreditDisagreement[];
}

/**
 * A conventional-commit subject ends with the squash-merge's PR reference. ANCHORED at the end
 * deliberately: a subject may mention another `#n` mid-sentence, and crediting a task to the
 * wrong PR is exactly the failure this module exists to prevent.
 */
export const SUBJECT_PR_RE = /\(#(\d+)\)\s*$/;

/** The PR number a merged squash subject ends with, or undefined when it carries none. */
export function subjectPrNumber(subject: string): number | undefined {
  const m = SUBJECT_PR_RE.exec(subject.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Fold each task's signals into the two SURFACE verdicts and report where they part.
 *
 * WHY THIS NEVER WRITES. Subject matching over-credits by construction — that is why
 * `LINT_FILING_SUBJECT_RE` exists at all — and a task credited in error is never built again,
 * which is strictly worse than one credited late. So a disagreement becomes a PROPOSAL carrying
 * the exact `rmd correct` invocation (the sanctioned writer, lib/correct.ts), and a human decides.
 * There is no code path in this module that appends a ledger line.
 */
export function reconcileCreditEvidence(rows: readonly CreditEvidenceRow[]): CreditReconciliation {
  const disagreements: CreditDisagreement[] = [];
  let agreed = 0;
  for (const row of rows) {
    const dispatchSees = row.trailer || row.headBranch;
    const lintSees = row.trailer || row.subject;
    if (dispatchSees === lintSees) {
      agreed++;
      continue;
    }
    // Only a task the DISPATCHER cannot see is correctable: `rmd correct` names a task's true
    // merged PR, which is meaningless for the mirror case (dispatch sees it, lint does not).
    const correctable = lintSees && !dispatchSees && row.subjectPr !== undefined;
    disagreements.push({
      ...row,
      dispatchSees,
      lintSees,
      ...(correctable ? { correctCommand: `rmd correct ${row.taskId} --pr ${row.subjectPr}` } : {}),
    });
  }
  return {
    rows,
    agreed,
    disagreements,
    candidates: disagreements.filter((d) => d.correctCommand !== undefined),
  };
}

/** The seams the gatherer reads through, so every one is faked in tests and none is re-derived. */
export interface CreditEvidenceDeps {
  /** `git log <ref> --format=%B` — the corpus for the anchored trailer scan. */
  trailerLog(): string;
  /** `git log <ref> --format=%h %s` — subjects, for the PR number a correction needs. */
  subjectLog(): string;
  /**
   * run-task.ts's OWN `classifyFailingMergeEvidence`, injected rather than imported so this
   * module stays free of the CLI and the filing-subject rule is REUSED, never re-derived here.
   */
  classify(ids: readonly string[], dump: string): { withImpl: string[]; without: string[] };
  /** `git log <ref> --format=%s%x00%b%x01` — the dump shape `classify` parses. */
  evidenceDump(): string;
  /** True when a MERGED PR's head ref was `run-<taskId>-<digits>`. Absent ⇒ no such evidence. */
  hasMergedRunBranch?(taskId: string): boolean;
}

/** An anchored trailer for one id, the same shape status.ts's rung (c) requires. */
export function trailerCreditedIds(trailerLog: string): Set<string> {
  const ids = new Set<string>();
  for (const m of trailerLog.matchAll(/^Remudero-Task:[ \t]*(\S+)[ \t]*$/gm)) ids.add(m[1]!);
  return ids;
}

/** Assemble one row per open task by asking each evidence path independently. */
export function gatherCreditEvidence(
  openTaskIds: readonly string[],
  deps: CreditEvidenceDeps,
): CreditEvidenceRow[] {
  const trailer = trailerCreditedIds(deps.trailerLog());
  const { withImpl } = deps.classify(openTaskIds, deps.evidenceDump());
  const subjectHit = new Set(withImpl);
  const subjects = deps.subjectLog().split("\n");
  return openTaskIds.map((taskId) => {
    const row: CreditEvidenceRow = {
      taskId,
      trailer: trailer.has(taskId),
      headBranch: deps.hasMergedRunBranch?.(taskId) ?? false,
      subject: subjectHit.has(taskId),
    };
    if (!row.subject) return row;
    // The PR number comes from the SAME subject line that supplied the evidence, never from a
    // second scan that could resolve to a different commit.
    const hit = subjects.find((s) => new RegExp(`[(\\s,:]${escapeId(taskId)}[)\\s,:.]`).test(` ${s} `));
    const pr = hit ? subjectPrNumber(hit) : undefined;
    return pr === undefined ? row : { ...row, subjectPr: pr };
  });
}

function escapeId(id: string): string {
  return id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Plain-text report. One line per disagreement; the counts are the control on an empty result. */
export function renderCreditReconciliation(r: CreditReconciliation): string {
  const out: string[] = [];
  out.push(
    `rmd credit-audit — ${r.rows.length} open task(s): ${r.agreed} agreed, ` +
      `${r.disagreements.length} disagreed, ${r.candidates.length} correctable`,
  );
  if (r.disagreements.length === 0) {
    out.push("  the dispatch and lint credit surfaces agree on every open task.");
    return out.join("\n");
  }
  for (const d of r.disagreements) {
    const seen = [d.trailer ? "trailer" : "", d.headBranch ? "head-branch" : "", d.subject ? "subject" : ""]
      .filter(Boolean)
      .join("+");
    out.push(
      `  ${d.taskId}  dispatch=${d.dispatchSees ? "merged" : "open"} lint=${d.lintSees ? "merged" : "open"}` +
        `  evidence: ${seen || "none"}`,
    );
    if (d.correctCommand) out.push(`      ${d.correctCommand}`);
  }
  out.push("");
  out.push("Nothing above was written. Each line is a PROPOSAL: `rmd correct` is the sanctioned");
  out.push("writer, and a subject can name a task it discusses rather than implements, so a human");
  out.push("confirms before credit moves.");
  return out.join("\n");
}
