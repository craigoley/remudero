/**
 * W1-T2541 — THE DIAGNOSER FOR A PR BLOCKED BY ITS OWN BODY.
 *
 * THE STRUCTURAL GAP. `FIX_MODE_RULES` (run-task.ts) has three modes — merge-conflict, ci-log,
 * review — and every one of them ends in "push a commit". There is NO rung whose remedy is EDIT
 * THE PR BODY, so a PR blocked by its body routes to `blocked-ambiguous` and waits for a human.
 * The sweep's diagnosis is already correct and already rendered; only the hand is missing.
 *
 * MEASURED over one operator session, 2026-08-31, in which SIX pull requests were repaired BY
 * HAND. FIVE of the six were blocked by their BODY, not their code, and every one was diagnosable
 * by a verb this repo already ships:
 *   #3356  six `grep:` proofs wrapped in literal double quotes; every quoted pattern read 0 and
 *          every bare one read 1. Two further criteria used a prefix that is not a dialect.
 *   #3413  the same defect one retro cycle later, in BACKTICKS — the wrapper changed, the defect
 *          did not.
 *   #3363  no `Remudero-Task:` trailer, so `resolvePlanCriteriaAtHead` was never consulted and the
 *          verdict read "no acceptance criteria to judge" while NINE criteria sat in its own shard.
 *   #3400  no trailer either, so `automerge.ledger_refused` withheld the arm on a green PR.
 *   #3403  likewise.
 *
 * WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY IS NOT. It DIAGNOSES and it REFUSES. It has no
 * writer: nothing here edits a body, pushes a commit, or touches GitHub. That half is a separate,
 * separately-reviewed task, so the dangerous capability is judged on its own with the safe half
 * already proven. Its one production consumer today is the escalation text an operator reads.
 *
 * THE LINE, AND IT IS THE WHOLE SAFETY ARGUMENT. Every repair this module will ever propose must
 * be DERIVABLE FROM OBSERVED STATE — a trailer from the run branch's own name, an unwrapped
 * pattern, a file list from the diff. It must NEVER author a claim, weaken one, or choose which
 * criteria a PR is judged against. Standing rule 15's `criterionFieldTampered` refuses a
 * non-plan-only diff that edits `claim:`/`proof:`, and that refusal must keep applying to whatever
 * a later writer does with these findings — {@link refusesToAuthorAClaim} exists so that boundary
 * is testable here rather than asserted in prose.
 */

/** The run-branch shape `projectPlan` attributes an open PR by (`status.ts`'s own regex). */
export const RUN_BRANCH_RE = /^run-(.+)-\d+$/;

/** A `Remudero-Task:` trailer line, anchored exactly as the trailer-scan discipline requires. */
const TRAILER_RE = /(?:^|\n)Remudero-Task:[ \t]*(\S+)[ \t]*(?:\r?\n|$)/;

/** One acceptance bullet as this module reads it — claim text and proof text, nothing inferred. */
export interface BodyCriterion {
  claim: string;
  proof: string;
}

/**
 * One diagnosed defect. `repair` is present ONLY when it is derivable from observed state; a defect
 * that is real but whose fix requires a judgement carries `repair: undefined` and is reported for a
 * human, never silently dropped.
 */
export interface BodyDefect {
  kind: "no-trailer" | "wrapped-proof" | "inert-proof" | "em-dash-separator" | "exec-error";
  /** 1-based criterion index, when the defect belongs to one. */
  criterion?: number;
  /** What an operator (or a later writer) should do — derived, never invented. */
  repair?: string;
  /** Why this is a defect, in the terms the gate that will refuse it uses. */
  why: string;
}

export interface BodyRepairDeps {
  /** The PR's head ref, e.g. `run-W1-T2480-1788150533485`. A trailer is derived from it. */
  headRef?: string;
  /**
   * Runs a `grep:` proof and reports how many lines it matched. INJECTED, so this module stays
   * pure and testable with no filesystem.
   *
   * WHY EXECUTION AND NOT A SHAPE TEST, AND WHY THAT DIFFERS FROM W1-T2544. The author-time gate
   * (`acceptanceAuthorTimeCheck`) is pure and runs as a REQUIRED check, so it can only WARN about a
   * wrapped pattern: a wholly-wrapped pattern CAN be correct, since MASTER-PLAN.md is full of code
   * spans and JSON genuinely contains `"key"`. The fix rung runs in a worktree and can simply RUN
   * the proof, so here the question is settled rather than guessed: wrapped reads 0 AND unwrapped
   * reads more than 0 is a defect; anything else is not. Omit this and wrapped proofs are not
   * diagnosed at all — silence, never a guess.
   */
  execProof?: (proof: string) => { hits: number } | undefined;
}

/** True iff `proof` carries a runnable house dialect. Mirrors the reviewer's own vocabulary. */
function hasRunnableDialect(proof: string): boolean {
  return /^\s*(?:grep:|unit test:)/i.test(proof ?? "");
}

/**
 * W1-T3028 — A CLAIM THAT SWALLOWED ITS OWN PROOF BEHIND AN EM DASH.
 *
 * `parseAcceptanceBlock` splits a bullet on ` | ` only. An em dash is NOT a separator, so
 * `- <claim> — unit test: <title>` parses as ONE claim with NO proof, silently. CLAUDE.md names
 * this as shipped three times (#2534/#2535/#2555) and states the remedy in one line: convert every
 * ` — proof: ` to ` | `.
 *
 * WHY IT MATTERS MORE THAN ONE MORE INERT PROOF. An empty proof makes
 * `bodyNeedsAcceptanceRepair` true, and `ensureJudgeableBody` then DEMOTES the author's header and
 * appends a fallback block. So the author's real criteria — which are sitting right there, fully
 * written, one character from correct — are discarded in favour of whatever fallback the caller
 * carries. CLAUDE.md records this exact shape shipping three times — #2534, #2535, #2555 — each
 * landing on `acceptanceAuthorTimeCheck`'s `empty-proofs` refusal.
 *
 * NOT the #4420 case, which is what sent me looking: its bullets read `**claim** — explanatory
 * prose`, with no dialect after the dash, so nothing was recoverable there and its fallback was the
 * right answer. The two shapes are one character apart in the source and entirely different in what
 * can be done about them, which is why the DIALECT test below decides this and not the dash.
 *
 * DERIVED, NEVER INVENTED, which is what lets this carry a `repair` at all ({@link
 * refusesToAuthorAClaim}): both halves are already the author's own words. This only moves the
 * boundary between them, and only when the right-hand side already opens with a runnable dialect —
 * so an em dash used as ordinary punctuation inside a claim is untouched.
 */
export function emDashSeparatedProof(claim: string): { claim: string; proof: string } | undefined {
  // The LAST em dash whose right side opens with a dialect: a claim may legitimately contain an
  // earlier one, and the proof is always the tail.
  const parts = (claim ?? "").split(/\s+\u2014\s+/);
  for (let i = parts.length - 1; i >= 1; i--) {
    const candidate = parts.slice(i).join(" \u2014 ").trim();
    if (hasRunnableDialect(candidate)) {
      const left = parts.slice(0, i).join(" \u2014 ").trim();
      if (left.length === 0) return undefined; // nothing would remain as a claim
      return { claim: left, proof: candidate };
    }
  }
  return undefined;
}

/**
 * A `grep:` proof's declared pattern and path — shared by {@link unwrapGrepPattern} (which only
 * ever fires for a WRAPPED pattern) and {@link diagnoseUnrunnableProofs} (which must also catch a
 * proof that never had an `in <path>` clause at all).
 */
const GREP_PROOF_RE = /^\s*grep:\s*(.+?)\s+in\s+(\S+)\s*$/;

/** A `grep:` proof's pattern wholly enclosed in a matching delimiter pair, and its bare form. */
export function unwrapGrepPattern(proof: string): { wrapped: string; bare: string } | undefined {
  const m = GREP_PROOF_RE.exec(proof ?? "");
  if (!m) return undefined;
  const pattern = m[1].trim();
  for (const d of ["`", '"', "'"]) {
    if (pattern.length > 2 && pattern.startsWith(d) && pattern.endsWith(d)) {
      const inner = pattern.slice(1, -1);
      if (inner.length > 0 && !inner.includes(d)) {
        return { wrapped: proof, bare: `grep: ${inner} in ${m[2]}` };
      }
    }
  }
  return undefined;
}

/**
 * The task id a head ref names, or undefined. TRAILER-SHAPED CREDIT COMES FROM THE BRANCH because
 * `projectPlan` already attributes an open PR that way (`status.ts`), so deriving it here invents
 * nothing — it restates a fact the fleet already acts on.
 */
export function taskIdFromHeadRef(headRef: string | undefined): string | undefined {
  const m = RUN_BRANCH_RE.exec((headRef ?? "").trim());
  return m ? m[1] : undefined;
}

/**
 * DIAGNOSE a body. Returns every defect found, each with a derived repair where one exists.
 *
 * SILENCE IS THE DEFAULT. A body with no derivable defect yields `[]` — this never speculates, and
 * a later writer acting on `[]` does nothing. That is the correct behaviour for the overwhelming
 * majority of bodies and is asserted as its own test.
 */
export function diagnoseBodyDefects(
  body: string,
  criteria: readonly BodyCriterion[],
  deps: BodyRepairDeps = {},
): BodyDefect[] {
  const out: BodyDefect[] = [];
  const text = body ?? "";

  if (!TRAILER_RE.test(text)) {
    const derived = taskIdFromHeadRef(deps.headRef);
    out.push({
      kind: "no-trailer",
      ...(derived === undefined ? {} : { repair: `Remudero-Task: ${derived}` }),
      why:
        "with no Remudero-Task: trailer, resolvePlanCriteriaAtHead is never consulted, the review " +
        "reads \"no acceptance criteria to judge (fail closed)\", and automerge.ledger_refused " +
        "withholds the arm even on a green PR" +
        (derived === undefined ? " — and the head ref names no task, so the trailer cannot be derived" : ""),
    });
  }

  criteria.forEach((c, i) => {
    const proof = c.proof ?? "";
    // Checked BEFORE the inert-proof arm: an em-dash bullet reaches here with an EMPTY proof, so it
    // would otherwise be reported as merely inert — true, but it names no remedy, and the criterion
    // is then discarded by ensureJudgeableBody rather than repaired.
    const split = proof.trim().length === 0 ? emDashSeparatedProof(c.claim ?? "") : undefined;
    if (split !== undefined) {
      out.push({
        kind: "em-dash-separator",
        criterion: i + 1,
        repair: `- ${split.claim} | ${split.proof}`,
        why:
          "parseAcceptanceBlock splits on ` | ` only, so this bullet's em dash is read as part of " +
          "the CLAIM and the criterion resolves with no proof at all. That empty proof makes the " +
          "body defective, and the repair path then DISCARDS every criterion here in favour of a " +
          "fallback block — losing criteria that are one character from correct",
      });
      return;
    }
    if (!hasRunnableDialect(proof)) {
      out.push({
        kind: "inert-proof",
        criterion: i + 1,
        why:
          "the proof carries no runnable dialect (grep:/unit test:), so it never executes and the " +
          "verdict caps below full proof_exec, which cannot arm auto-merge without an operator override",
      });
      return;
    }
    const unwrapped = unwrapGrepPattern(proof);
    if (unwrapped === undefined || deps.execProof === undefined) return;
    // SETTLED BY EXECUTION, NEVER BY SHAPE — see BodyRepairDeps.execProof. A wrapped pattern that
    // really does match is CORRECT and must not be reported.
    const asWritten = deps.execProof(unwrapped.wrapped);
    if (asWritten === undefined || asWritten.hits > 0) return;
    const asBare = deps.execProof(unwrapped.bare);
    if (asBare === undefined || asBare.hits === 0) return;
    out.push({
      kind: "wrapped-proof",
      criterion: i + 1,
      repair: unwrapped.bare,
      why:
        "the pattern is wrapped in its own delimiters and reads 0 as written, while the bare form " +
        "matches — the executor greps with no -F, so the delimiters are characters that must appear " +
        "in the file",
    });
  });

  return out;
}

/**
 * W1-T3389 — THE ASYMMETRY, CLOSED. `execProof` (above) already argues that the fix rung, running
 * in a worktree, can simply RUN a proof to settle an ambiguity rather than guess — applied so far
 * only to DIAGNOSING somebody else's body. This applies the identical reasoning to the rung's OWN
 * output: given the exact criteria a repair is about to push, does every `grep:` proof among them
 * actually parse and execute?
 *
 * MEASURED on PR 5108: a repaired body carried four `grep:`/`unit test:` criteria and every one
 * graded `exec_error` at review. One read `grep: unit test: test/...` — a SECOND dialect's text
 * wearing the FIRST dialect's prefix, so it never had an `in <path>` clause at all. That shape is
 * caught here with NO executor required, because it is a pure parse failure, not an ambiguity that
 * needs settling — `rmd check-proof` would refuse it in one call, and this settles the same
 * question before push rather than after a wasted review cycle.
 *
 * A proof that DOES parse is then actually RUN when `deps.execProof` is supplied; a run that
 * reports `undefined` (a timeout, a spawn failure, a `grep` exit 2 — the reviewer's OWN `exec_error`
 * causes) is a defect too. A run that executes and reads ZERO hits is NOT a defect here — it ran
 * cleanly and genuinely failed to prove the claim, which is a different, pre-existing verdict
 * (`not_yet_built`/fail) that this gate does not police.
 *
 * A `unit test:` proof has no runner in this module (mirrors {@link BodyRepairDeps.execProof}'s own
 * scope, which documents itself as `grep:`-only) and is left UNDIAGNOSED — silence, the same
 * default every other arm of this module keeps, never a guess dressed up as a verdict.
 *
 * `repair` is always `undefined`: this module cannot know what proof the author MEANT, and
 * inventing one would be exactly the claim-authoring {@link refusesToAuthorAClaim} exists to
 * refuse. A defect here must be reported to a human via {@link renderBodyDefects}, never silently
 * dropped or silently replaced.
 */
export function diagnoseUnrunnableProofs(
  criteria: readonly BodyCriterion[],
  deps: Pick<BodyRepairDeps, "execProof"> = {},
): BodyDefect[] {
  const out: BodyDefect[] = [];
  criteria.forEach((c, i) => {
    const proof = (c.proof ?? "").trim();
    if (!/^grep:/i.test(proof)) return; // no runner here for unit test:/other dialects — silence

    if (GREP_PROOF_RE.exec(proof) === null) {
      out.push({
        kind: "exec-error",
        criterion: i + 1,
        why:
          "the proof declares the grep: dialect but carries no `in <path>` clause, so it can never " +
          "parse or execute — this is the exact shape a proof takes when a second dialect's text " +
          "(e.g. `unit test: test/...`) is wrongly prefixed with `grep:`, and rmd check-proof " +
          "refuses it in one call; a body carrying it must never be pushed unverified",
      });
      return;
    }

    if (deps.execProof === undefined) return; // cannot settle real execution without a runner

    if (deps.execProof(proof) === undefined) {
      out.push({
        kind: "exec-error",
        criterion: i + 1,
        why:
          "the proof parses but raised exec_error when actually run (a timeout, a spawn failure, " +
          "or a grep exit 2) — a proof that cannot execute must never be pushed as though it were a " +
          "working replacement for whatever it is repairing",
      });
    }
  });
  return out;
}

/**
 * W1-T3389 — THE REFUSAL ITSELF. `false` the instant one authored proof cannot be substantiated
 * ({@link diagnoseUnrunnableProofs}); a caller must then refuse to push the repaired body and
 * report the failing proofs to a human via {@link renderBodyDefects}, never emit the defective body
 * as though it were a working replacement for whatever it is repairing.
 */
export function repairedProofsAreSafeToPush(
  criteria: readonly BodyCriterion[],
  deps: Pick<BodyRepairDeps, "execProof"> = {},
): boolean {
  return diagnoseUnrunnableProofs(criteria, deps).length === 0;
}

/**
 * THE RULE-15 BOUNDARY, TESTABLE RATHER THAN ASSERTED. True iff every proposed repair leaves the
 * CLAIM text untouched — a repair may fix a trailer or a proof, never author or alter what a PR
 * asserts. A later writer must consult this before applying anything.
 */
export function refusesToAuthorAClaim(
  defects: readonly BodyDefect[],
  criteria: readonly BodyCriterion[],
): boolean {
  const claims = new Set(criteria.map((c) => (c.claim ?? "").trim()));
  return defects.every((d) => d.repair === undefined || !claims.has(d.repair.trim()));
}

/** One line per defect, for the escalation an operator actually reads. */
export function renderBodyDefects(defects: readonly BodyDefect[]): string {
  if (defects.length === 0) return "";
  return defects
    .map((d) => {
      const where = d.criterion === undefined ? "" : ` (criterion ${d.criterion})`;
      const fix = d.repair === undefined ? "" : ` — repair: ${d.repair}`;
      return `- ${d.kind}${where}: ${d.why}${fix}`;
    })
    .join("\n");
}
