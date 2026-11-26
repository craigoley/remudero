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
 * is testable here rather than asserted in prose. The one claim this module writes restates a file
 * the diff adds ({@link planFilingAcceptanceCure}, W1-T13360).
 */

import { isInPlanScope } from "./plan-scope.js";
import { isTaskShardName } from "./task-shard-name.js";

/** The run-branch shape `projectPlan` attributes an open PR by (`status.ts`'s own regex). */
export const RUN_BRANCH_RE = /^run-(.+)-\d+$/;

/** A `Remudero-Task:` trailer line, anchored exactly as the trailer-scan discipline requires. */
const TRAILER_RE = /(?:^|\n)Remudero-Task:[ \t]*(\S+)[ \t]*(?:\r?\n|$)/;

/** One acceptance bullet as this module reads it — claim text and proof text, nothing inferred. */
export interface BodyCriterion {
  claim: string;
  proof: string;
}

/** `check-proof --base` exit codes, kept at the body boundary where its verdict is acted on. */
export function refuseNonDiscriminatingCriteria(
  criteria: readonly BodyCriterion[],
  checkProofAtBase: (proof: string) => number | null,
): void {
  const problems: string[] = [];
  let discriminating = 0;
  criteria.forEach((criterion, index) => {
    const status = checkProofAtBase(criterion.proof);
    if (status === 0) {
      discriminating++;
    } else if (status === 5) {
      problems.push(
        `criterion ${index + 1} (${criterion.proof}) passes at both head and base; ` +
          "keep the test, withdraw the criterion, and name why it was withdrawn in the body",
      );
    } else if (status === 3) {
      problems.push(`criterion ${index + 1} (${criterion.proof}) matches no tests; point it at a test that runs`);
    } else if (status !== 0) {
      problems.push(`criterion ${index + 1} (${criterion.proof}) could not prove this head (check-proof exit ${status})`);
    }
  });
  if (problems.length === 0) return;
  if (discriminating === 0) {
    problems.push("ask for a human ruling: this body has no discriminating criterion");
  }
  throw new Error(`body emission refused:\n${problems.join("\n")}`);
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
  /** The PR's head ref, e.g. `run-W1-T<n>-<epochMs>`. A trailer is derived from it. */
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
 * proof that never had an `in <path>` clause at all, e.g. `grep: unit test: test/...`, the doubled
 * dialect measured on PR 5108).
 */
export const GREP_PROOF_RE = /^\s*grep:\s*(.+?)\s+in\s+(\S+)\s*$/;

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
 * W1-T3389 — THE ASYMMETRY, CLOSED (rationale: this task's own plan shard). `execProof` already
 * argues the fix rung can RUN a proof to settle an ambiguity rather than guess, applied so far only
 * to DIAGNOSING somebody else's body. This applies the same reasoning to the rung's OWN output:
 * given the exact criteria a repair is about to push, does every `grep:` proof among them parse and
 * execute? A proof with no `in <path>` clause at all is caught with NO executor needed — that is a
 * pure parse failure `rmd check-proof` would refuse in one call, not an ambiguity to settle. A proof
 * that parses is then actually RUN when `deps.execProof` is supplied; `undefined` back (the
 * reviewer's own `exec_error` causes: timeout, spawn failure, grep exit 2) is a defect too. ZERO
 * hits is NOT a defect here — it ran cleanly and genuinely failed to prove the claim, a different,
 * pre-existing verdict this gate does not police. A `unit test:` proof has no runner in this module
 * (mirrors `execProof`'s own grep-only scope) and is left UNDIAGNOSED, the same silent default every
 * other arm keeps. `repair` is always `undefined`: this module cannot know what the author MEANT,
 * and inventing one is exactly the claim-authoring {@link refusesToAuthorAClaim} refuses.
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

/** W1-T10339 — one validated proof replacement for a PR whose BODY is its Acceptance (it carries no task trailer). */
export interface BodyProofReplacement { oldProof: string; newProof: string }

/** One acceptance bullet as {@link parseAcceptanceBlock} (review.ts) reads it: `-`, `*`, `1.` or `1)`, then its text. */
export const ACCEPTANCE_BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/;

/** The body lines that may carry a proof: review.ts's `acceptanceProofLines`, the lines parseAcceptanceBlock reads each
 *  proof from. INJECTED: review.ts imports this module, so importing the parser here would close a ring. */
export type ProofLines = (body: string) => readonly number[];

/** Every bullet or `proof:` line, the shape a caller with no parser at hand matches (the W1-T10339 behaviour). */
const bulletOrProofLines: ProofLines = (body) => body.split("\n").flatMap((line, index) =>
  ACCEPTANCE_BULLET_RE.test(line) || /^\s*proof\s*:/i.test(line) ? [index] : []);

/** W1-T14913 — rewrite ONE body proof, found by the value parseAcceptanceBlock reads, on a line `proofLines` names: given
 *  review.ts's `acceptanceProofLines`, only the lines the parser read proofs from, so a fenced example or prose outside
 *  the Acceptance block is never matched or rewritten. On a `proof:` line whose whole value is double-quoted, that value
 *  is the quoted text with `\"` and `\\` unescaped (any other backslash stays), and the replacement is written back
 *  escaped, so it re-reads exactly; any other proof line is matched and written literally, as before. `undefined` unless
 *  exactly one such line carries `oldProof`. */
export function rewriteBodyProof(body: string, oldProof: string, newProof: string,
  proofLines: ProofLines = bulletOrProofLines): string | undefined {
  const lines = body.split("\n");
  const hits = [...new Set(proofLines(body))].flatMap((index) => {
    const line = lines[index] === undefined ? undefined : rewriteProofLine(lines[index]!, oldProof, newProof);
    return line === undefined ? [] : [{ index, line }];
  });
  if (hits.length !== 1) return undefined;
  lines[hits[0]!.index] = hits[0]!.line;
  return lines.join("\n");
}

/**
 * W1-T14913: rewrite the proof on ONE body line the caller already knows is its criterion's — the parser-reported line for
 * a diagnosed criterion index — so two criteria sharing one proof text are each rewritten in turn, where a text match
 * would see two hits and refuse. `undefined` when there is no such line or it does not carry `oldProof`.
 */
export function rewriteBodyProofLine(body: string, lineIndex: number | undefined, oldProof: string,
  newProof: string): string | undefined {
  if (lineIndex === undefined) return undefined;
  const lines = body.split("\n");
  const line = lines[lineIndex] === undefined ? undefined : rewriteProofLine(lines[lineIndex]!, oldProof, newProof);
  if (line === undefined) return undefined;
  lines[lineIndex] = line;
  return lines.join("\n");
}

/** W1-T14913: the parser's proof line for criterion `index` (0-based), injected because this module cannot import review.ts. */
export type ProofLineAt = (body: string, index: number) => number | undefined;

/** One criterion's proof rewrite, addressed by its 0-based index in the parsed Acceptance block. */
export interface CriterionProofEdit { index: number; oldProof: string; newProof: string }

/**
 * W1-T14913: apply each edit on the line the parser read ITS criterion's proof from, in order. Two criteria carrying the same
 * proof text are each rewritten, where a text match would see two lines and refuse. `undefined` when any edit's line is
 * missing or no longer carries its old proof, so a drifted body is never guessed at.
 */
export function rewriteCriterionProofs(body: string, edits: readonly CriterionProofEdit[], proofLineAt: ProofLineAt): string | undefined {
  let repaired = body;
  for (const { index, oldProof, newProof } of edits) {
    const next = rewriteBodyProofLine(repaired, proofLineAt(repaired, index), oldProof, newProof);
    if (next === undefined) return undefined;
    repaired = next;
  }
  return repaired;
}

/** One line's rewrite: a double-quoted `proof:` line matched by its parsed value and rewritten escaped, else a literal
 *  substring replace; `undefined` when the line does not carry `oldProof`. */
function rewriteProofLine(line: string, oldProof: string, newProof: string): string | undefined {
  const escaped = (text: string): string => `"${text.replace(/[\\"]/g, "\\$&")}"`;
  const quoted = line.match(/^(\s*proof\s*:\s*)"([\s\S]*)"(\s*)$/i);
  if (quoted) {
    return quoted[2]!.replace(/\\(["\\])/g, "$1") === oldProof ? `${quoted[1]}${escaped(newProof)}${quoted[3]}` : undefined;
  }
  return line.includes(oldProof) ? line.replace(oldProof, () => newProof) : undefined;
}

/**
 * W1-T10339 — REPLACE THE PROOF TEXT OF THE ACCEPTANCE BULLETS A VALIDATED REPAIR NAMES, AND NOTHING ELSE. Each old proof must
 * sit on exactly ONE bullet or `proof:` continuation line of the body; a body that no longer carries it, or carries it on more
 * than one line, is not guessed at (`undefined`). A claim is never read or written here — {@link refusesToAuthorAClaim}'s line.
 */
export function replaceBodyProofs(body: string, replacements: readonly BodyProofReplacement[],
  proofLines: ProofLines = bulletOrProofLines): string | undefined {
  let repaired = body;
  for (const { oldProof, newProof } of replacements) {
    const next = rewriteBodyProof(repaired, oldProof, newProof, proofLines);
    if (next === undefined) return undefined;
    repaired = next;
  }
  return repaired;
}

/** One path a pull request's diff changes, as {@link planFilingAcceptanceCure} reads it. */
export interface FilingDiffFile {
  path: string;
  /** True only when the diff ADDS the file, so it is absent at the merge base. */
  added: boolean;
  /** The file's text at the head. Read only for an added shard, for its own `id:` line. */
  headText?: string;
}

type UnreadableDiff = { kind: "unreadable"; reason: string };
type AddedTestDiff = { kind: "read"; files: readonly string[] } | UnreadableDiff;
export type PlanFilingDiffAtHead = { kind: "read"; files: FilingDiffFile[]; shardDir: string } | UnreadableDiff;

/** The author-time gate's verdict on a body, in `acceptanceAuthorTimeCheck`'s own shape. INJECTED: the gate lives in
 *  `review.ts`, which `plan-pr-emitter.ts` imports beside this module, so importing it here would close a ring. */
export type BodyGate = (body: string) => { ok: boolean; defect?: string };

/** {@link planFilingAcceptanceCure}'s answer: the derived criteria and the body that carries them. */
export interface PlanFilingAcceptanceCure {
  criteria: BodyCriterion[];
  repairedBody: string;
}

/** A path a `grep:` proof and a `- claim | proof` bullet can both carry: no space, no `|`, no `..` segment.
 *  Exported, like the two below, so a fixture can drive both of its arms by name. */
export const PROOF_SAFE_PATH_RE = /^(?!.*\.\.)[A-Za-z0-9._/-]+$/;
/** One line that is a record's bare `id:`. The grep proof uses the line's own spacing. */
export const SHARD_ID_LINE_RE = /^\s*(?:-\s+)?id:[ \t]+([A-Za-z0-9-]+)\s*$/;
/** The line a session's pull request body ends with; the derived block goes above the last one. */
export const ATTRIBUTION_LINE_RE = /^\s*\u{1F916} Generated with /u;

/**
 * W1-T13360 — THE ACCEPTANCE BLOCK A PLAN FILING NEVER WROTE, DERIVED FROM THE SHARDS IT ADDS.
 *
 * MEASURED 2026-11-17: two plan pull requests sat red for 5.5 and 3.6 hours on `acceptance-author-gate: REFUSED
 * (no-header)` with every other check green. The body repair had a cure for a body with no block only when the
 * diff added a test file, and a plan-only diff never adds one.
 *
 * DERIVED, NEVER INVENTED. The one claim written here, "the <id> shard is filed", restates the diff: the file is
 * ADDED directly under `shardDir` (the repo-relative directory the plan loader reads shards from, which the caller
 * resolves from the repo layout), and the id is read from its own record line and must be the id its file name
 * carries. The proof greps that line, so it hits at the head and misses at the base, where the file does not
 * exist. Nothing else earns a claim: an EDITED shard (an amendment's claim would have to be authored), a diff with
 * a path outside the plan, an added shard whose id cannot be read (the whole filing then gets no cure, never a
 * partial block), and above all a body `gate` does not refuse as `no-header`. A body with an acceptance block or a
 * task trailer comes back `undefined`, so an existing block is never rewritten. `gate` also judges the result: a
 * body it would still refuse is not a cure.
 */
export function planFilingAcceptanceCure(
  body: string,
  diff: readonly FilingDiffFile[],
  shardDir: string,
  gate: BodyGate,
): PlanFilingAcceptanceCure | undefined {
  const text = body ?? "";
  const refusal = gate(text);
  if (refusal.ok || refusal.defect !== "no-header") return undefined;
  if (!diff.every((file) => isInPlanScope(file.path))) return undefined;
  const criteria: BodyCriterion[] = [];
  const shardPrefix = `${shardDir.replace(/\/+$/, "")}/`;
  for (const file of diff) {
    if (!file.added || !file.path.startsWith(shardPrefix)) continue;
    const shardName = file.path.slice(shardPrefix.length);
    if (shardName.includes("/") || !shardName.endsWith(".yaml")) continue; // not a file the plan loader reads as a shard
    if (!PROOF_SAFE_PATH_RE.test(file.path)) return undefined;
    const idLine = file.headText?.split("\n").map((line) => SHARD_ID_LINE_RE.exec(line))
      .find((match) => match !== null && isTaskShardName(shardName, match[1]!));
    if (!idLine) return undefined;
    const [line, id] = idLine;
    const pattern = line.slice(line.indexOf("id:")).trimEnd();
    criteria.push({ claim: `the ${id} shard is filed`, proof: `grep: ${pattern} in ${file.path}` });
  }
  if (criteria.length === 0) return undefined;
  const block = ["## Acceptance", ...criteria.map((c) => `- ${c.claim} | ${c.proof}`)].join("\n");
  const lines = text.replace(/\s+$/, "").split("\n");
  const attribution = lines.findLastIndex((line) => ATTRIBUTION_LINE_RE.test(line));
  const above = (attribution < 0 ? lines : lines.slice(0, attribution)).join("\n").replace(/\s+$/, "");
  const below = attribution < 0 ? "" : lines.slice(attribution).join("\n");
  const repairedBody = `${[above, block, below].filter((part) => part.length > 0).join("\n\n")}\n`;
  return gate(repairedBody).ok ? { criteria, repairedBody } : undefined;
}

export function addedTestCriterion(path: string): BodyCriterion {
  return { claim: `the suite this PR adds passes (an Acceptance block derived from the diff): ${path}`, proof: `unit test: ${path}` };
}

export function missingDiffProofReason(addedTests: AddedTestDiff, filingDiff?: PlanFilingDiffAtHead): string {
  const testReason = addedTests.kind === "read" ? "the diff adds no test file" : addedTests.reason;
  const filingReason = filingDiff?.kind === "unreadable" ? ` and ${filingDiff.reason}` : "";
  return `the body has no judgeable Acceptance block and ${testReason}${filingReason}, ` +
    "so no proof that misses at base is derivable; a generic block would pass at base and fail proof-discrimination";
}

/** Select a no-header cure from the PR's diff evidence. The caller supplies the existing test-block renderer. */
export function repairMissingAcceptance(
  body: string,
  addedTests: AddedTestDiff,
  filingDiff: PlanFilingDiffAtHead | undefined,
  gate: BodyGate,
  renderAddedTestBlock: (body: string, criteria: BodyCriterion[]) => string,
): { kind: "cured"; repairedBody: string } | { kind: "no-cure"; reason: string } | undefined {
  const verdict = gate(body);
  if (verdict.ok || verdict.defect !== "no-header") return undefined;
  if (addedTests.kind === "read" && addedTests.files.length > 0) {
    return { kind: "cured", repairedBody: renderAddedTestBlock(body, addedTests.files.map(addedTestCriterion)) };
  }
  const filing = filingDiff?.kind === "read" ? planFilingAcceptanceCure(body, filingDiff.files, filingDiff.shardDir, gate) : undefined;
  return filing
    ? { kind: "cured", repairedBody: filing.repairedBody }
    : { kind: "no-cure", reason: missingDiffProofReason(addedTests, filingDiff) };
}
