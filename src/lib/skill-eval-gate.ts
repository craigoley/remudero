/**
 * lib/skill-eval-gate.ts — the approval gate on a skill-workshop draft (phase 5 of 5 of the held-out skill eval).
 *
 * `rmd approve` writes a draft under `.claude/skills/`, and from there it reaches every matching worker prompt.
 * Self-generated skills average about zero benefit unless they are tested on tasks they never saw (SkillsBench,
 * SkillLearnBench), so a draft is approvable only once `rmd skill-eval` recorded a PASSING held-out eval for its
 * CURRENT text. The record names the sha256 of the text it measured: the workshop rewrites a staged draft when its
 * procedure grows, and a pass earned by the older text says nothing about the newer one.
 *
 * A refusing verdict is not answered with "run it again": the eligible set grows as work merges, so re-running the
 * same text until some draw passes would launder a refusal. A rewrite by the workshop is a new text and earns a new
 * eval. This gate reads only the LATEST record; refusing a second eval of an already-judged text is the verb's job.
 *
 * The shapes are structural, never imported: inbox.ts calls this, and inbox.ts must not import skill-eval.ts, which
 * the drafter's dependency boundary (`drafter-never-sees-held-out-set`) keeps out of its reach.
 */
import { createHash } from "node:crypto";

/** The fields of inbox.ts's `SkillEvalRecord` this gate reads. */
export interface RecordedSkillEval {
  draftSha256: string;
  verdict: string;
  reason: string;
  detail: string;
}

/** Why `proposalId`'s draft cannot be approved yet, naming what clears it; undefined only when a passing eval was
 *  recorded for exactly `markdown`. */
export function skillEvalApprovalRefusal(proposalId: string, markdown: string, record: RecordedSkillEval | undefined): string | undefined {
  const evaluate = `\`rmd skill-eval ${proposalId} --confirm-spend\``;
  if (record === undefined) {
    return `${proposalId} is a skill draft with no held-out eval recorded; run ${evaluate}, which must record a pass `
      + "for this text, or decline it";
  }
  if (record.draftSha256 !== createHash("sha256").update(markdown).digest("hex")) {
    return `${proposalId}'s recorded held-out eval measured an earlier text of the draft (sha256 `
      + `${record.draftSha256.slice(0, 12)}); the workshop has since rewritten it, so run ${evaluate} for this text or decline it`;
  }
  if (record.verdict !== "pass") {
    return `${proposalId}'s held-out eval refused this text (${record.reason}: ${record.detail}); decline it, or `
      + "evaluate the workshop's next rewrite";
  }
  return undefined;
}
