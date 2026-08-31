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
const RUN_BRANCH_RE = /^run-(.+)-\d+$/;

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
  kind: "no-trailer" | "wrapped-proof" | "inert-proof";
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

/** A `grep:` proof's pattern wholly enclosed in a matching delimiter pair, and its bare form. */
export function unwrapGrepPattern(proof: string): { wrapped: string; bare: string } | undefined {
  const m = /^\s*grep:\s*(.+?)\s+in\s+(\S+)\s*$/.exec(proof ?? "");
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
