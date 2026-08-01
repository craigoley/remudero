import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import type { AcceptanceCriterion, Plan, Task } from "./plan.js";
import { isDemonstrationProof, isDialectPrefixed, parseWhitelistedProof } from "./review.js";

/**
 * Deterministic task linter (MASTER-PLAN §5C Layer A). NO LLM — a PURE function
 * over a loaded {@link Task}/{@link Plan}, no I/O, no side effects. Catches the
 * class of malformed task that reached a worker four times (W1-T6, W1-T9, and
 * W1-T12 twice-over) and burned budget before a human noticed: over-scoping
 * (Rule 19), headless-unfitness (Rule 18), vibe proofs, a proof that CANNOT
 * EXECUTE at all (the dead proof floor, moratorium finding 9, W1-T246), a
 * dialect-prefixed proof that promises executability but names no resolvable
 * artifact (the W1-T100 0/3, W1-T101), an ALREADY-MERGED task's criteria being
 * amended with no follow-up filed in the same PR (W1-T180 — MERGED is terminal,
 * so the drain and the retro sweep both skip it and the amendment would
 * otherwise orphan silently), and missing provenance (Rules 16/17).
 *
 * Wired at TWO points, both FAIL-CLOSED — EXCEPT post-merge-amendment, which is
 * CI-only (see below):
 *   (i)  a CI check on any PR that edits plan/tasks.yaml (`rmd lint-plan`, see
 *        run-task.ts's `lintPlanCommand` + .github/workflows/ci.yml's `lint-plan`
 *        job, aggregated into the required `ci-gate` context). Only THIS call
 *        site supplies `opts.postMergeAmendment` (it alone has a `--base` diff
 *        and derived merge state to inject) — the check is a no-op wherever
 *        that context is absent.
 *   (ii) a PRE-DISPATCH guard in `rmd run-task` (and therefore `rmd drain`, which
 *        dispatches every task through the same `runTask` path) — a task that
 *        fails a BLOCKING check is NEVER dispatched: `verdict=blocked_illformed`,
 *        no worker spawned, no inflight lock even taken (see run-task.ts,
 *        `assertLintClean` called immediately after `assertRunnable`). Post-
 *        merge-amendment needs no wiring here: a MERGED task is never dispatched
 *        in the first place (the drain's own `if (isMerged(t.id)) continue`).
 *
 * A BLOCKING violation refuses dispatch. A WARN violation is visibility-only and
 * never blocks — budget-sanity always warns; proof-dialect and proof-resolvability
 * warn instead of blocking ONLY at the pre-dispatch call site (`opts.proofDialect:
 * "warn"` / `opts.proofResolvability: "warn"`, so the legacy backlog authored
 * before either check existed does not brick overnight), and proof-dialect always
 * warns (regardless of that option) for a `unit test:` proof whose body reads as a
 * runtime narrative rather than a literal test-title substring.
 */

export type LintCheck =
  | "sizing"
  | "headless-fitness"
  | "proof-shape"
  | "proof-dialect"
  | "proof-resolvability"
  | "post-merge-amendment"
  | "provenance"
  | "call-site"
  | "budget-sanity";
export type LintSeverity = "block" | "warn";

export interface LintViolation {
  check: LintCheck;
  severity: LintSeverity;
  message: string;
}

export interface LintResult {
  /** true iff no BLOCKING violation — a WARN never flips this false. */
  ok: boolean;
  violations: LintViolation[];
}

// ── SIZING (Rule 19) ─────────────────────────────────────────────────────────
//
// "≥2 DISTINCT SUBSYSTEMS/CONCERNS — inferred from the files: globs PLUS
// criteria naming modules OUTSIDE files:, NOT the raw criterion COUNT." A task
// with many criteria over ONE module (W1-T4's 3-criteria parser shape, W1-T3E's
// 4-criteria reviewer-rubric shape) must NOT flag; a task whose files:/criteria
// span multiple modules, at risk<high, must.

/** Basename-minus-extension of a repo-relative path (`.test` suffix folded away
 *  so `test/review.test.ts` and `src/lib/review.ts` name the SAME module). */
export function moduleIdFromPath(path: string): string | undefined {
  const m = path.match(/([^/\\]+)\.[A-Za-z0-9]+$/);
  if (!m) return undefined;
  return m[1].replace(/\.test$/, "").toLowerCase();
}

/**
 * Known cross-cutting subsystem nouns, checked against acceptance criteria text
 * for a task that names a module OUTSIDE its `files:` list (or carries none at
 * all — W1-T12's original definition had no `files:` field). DATA, like the
 * headless-fitness lexicon below — it grows as the retro/Architect find a new
 * pattern, never by editing the check logic. Deliberately narrow: each entry is
 * a DISTINCTIVE noun for a real remudero subsystem, not a generic English word
 * (a naive "every src/lib basename as a keyword" scan false-positives on
 * ordinary prose — e.g. "plan/tasks.yaml" appears in nearly every task and
 * would spuriously tag the `plan` module; "reviewer"/"review-gate" would tag
 * `review` on W1-T3E's single-concern reviewer-rubric task).
 */
export const SUBSYSTEM_LEXICON: ReadonlyArray<{ tag: string; pattern: RegExp }> = [
  { tag: "daemon", pattern: /\bdaemon\b/i },
  { tag: "launchd", pattern: /\blaunchd\b|\blaunchctl\b/i },
  { tag: "crash-recovery", pattern: /\bchaos-drill\b|\bcrash-recover(?:y|ed)?\b/i },
];

/**
 * Non-code data/config file classes DISCOUNTED from the subsystem COUNT (#153,
 * W1-T92): a code file paired with its OWN data artifact — e.g. `src/lib/retro.ts`
 * + `plan/mast-mapping.yaml`, the policy-as-data house pattern MASTER-PLAN rule 2
 * prescribes — must not count as a SECOND subsystem just because the artifact has
 * a different basename. Each row is a path prefix PLUS an extension, not a branch,
 * so a new discounted class is a table row with ZERO changes to {@link subsystemsOf}.
 * The file still appears in `task.files` and in a violation's file list either way —
 * this table only removes it from the CONCERN tally.
 */
export interface DataArtifactClass {
  tag: string;
  pathPattern: RegExp;
  extPattern: RegExp;
}

export const DATA_ARTIFACT_CLASSES: ReadonlyArray<DataArtifactClass> = [
  { tag: "plan-data", pathPattern: /^plan\//, extPattern: /\.(?:ya?ml|json|md)$/i },
  { tag: "config-data", pathPattern: /^config\//, extPattern: /\.(?:ya?ml|json|md)$/i },
  { tag: "settings-data", pathPattern: /^settings\//, extPattern: /\.(?:ya?ml|json|md)$/i },
];

/** True iff `path` matches BOTH the path prefix and the extension of some row in
 *  `classes` — i.e. it's a discounted data/config artifact, not a code subsystem. */
export function isDataArtifact(
  path: string,
  classes: ReadonlyArray<DataArtifactClass> = DATA_ARTIFACT_CLASSES,
): boolean {
  return classes.some((c) => c.pathPattern.test(path) && c.extPattern.test(path));
}

/** The distinct module/subsystem ids a task's `files:` + acceptance criteria imply.
 *  `dataArtifactClasses` defaults to {@link DATA_ARTIFACT_CLASSES}; the param exists
 *  so the discount table can grow with ZERO changes to this function. */
export function subsystemsOf(
  task: Task,
  dataArtifactClasses: ReadonlyArray<DataArtifactClass> = DATA_ARTIFACT_CLASSES,
): Set<string> {
  const ids = new Set<string>();
  for (const f of task.files ?? []) {
    if (isDataArtifact(f, dataArtifactClasses)) continue; // a data/config artifact, not a concern
    const id = moduleIdFromPath(f);
    if (id) ids.add(id);
  }
  const text = (task.acceptance ?? []).map((c) => `${c.claim ?? ""} ${c.proof ?? ""}`).join("\n");
  for (const entry of SUBSYSTEM_LEXICON) {
    if (entry.pattern.test(text)) ids.add(entry.tag);
  }
  return ids;
}

/** ≥2 subsystems while risk<high ⇒ a sizing violation (raise to high or decompose). */
export function sizingViolation(task: Task): LintViolation | undefined {
  if (task.risk === "high") return undefined; // Rule 19 exemption — high already assumes wide scope
  const subsystems = subsystemsOf(task);
  if (subsystems.size < 2) return undefined;
  return {
    check: "sizing",
    severity: "block",
    message:
      `spans ${subsystems.size} distinct subsystems/concerns (${[...subsystems].sort().join(", ")}) ` +
      `at risk:${task.risk} — Rule 19: raise to risk:high or decompose into one task per concern`,
  };
}

// ── HEADLESS-FITNESS (Rule 18) ───────────────────────────────────────────────
//
// A forbidden live-context lexicon, held as DATA so it grows. Applied to every
// acceptance criterion of an auto-verify task — a headless worker has no TTY and
// no operator, so a criterion needing one can never pass (W1-T9's readline-
// reproduction death spiral; W1-T12's overnight-drain / launchctl-load / live-
// kill criteria).
//
// PRECISION vs RECALL (the #146 sweep, W1-T81): a naive whole-word-anywhere scan
// is wrong in BOTH directions on the SAME rule.
//   - FALSE POSITIVE #1 — negation: 'NO real overnight run' (W1-T12a) and 'NOT a
//     real launchctl load' (W1-T12b) contain a forbidden word but explicitly deny
//     the live action. A hit whose CLAUSE (bounded by . , ; : ( ) or an em-dash)
//     opens with a negation cue (no/not/never/without/non/isn't/doesn't/won't/
//     cannot/can't/nor) BEFORE the match does not flag.
//   - FALSE POSITIVE #2 — self-reference: W1-T20c's own criterion literally names
//     the lexicon ('a criterion containing overnight/launchctl/killed...') to
//     describe the CHECK, not to instruct a live action. Exempted by CONTENT
//     SHAPE, never a task-id allowlist (an id allowlist rots): (a) forbidden
//     terms directly enumerated back-to-back with a bare '/' between them (no
//     surrounding spaces) are a quoted/listed lexicon excerpt, not an
//     instruction; (b) a hit fully inside a quoted span ('...' or "...", the
//     quote not itself a contraction/possessive apostrophe) is a quoted excerpt
//     under discussion, not an instruction.
//   - FALSE POSITIVE #3 — missing ACTOR (the #268 sweep, W1-T118): a lexicon
//     word can name either a genuinely live action (W1-T12d's operator kill -9
//     on a real daemon) or a headless one (a test spawning its own child and
//     reaping it in-process, W1-T117) — SAME WORD, opposite fitness, because the
//     check matched vocabulary, not who/what the action is done TO. The
//     discriminator is SPAWN-OWNERSHIP: a lexicon row may carry an optional
//     `qualifier` pattern (see {@link LexiconEntry}); when the criterion's own
//     text (claim + proof together, unscoped by clause — ownership is usually
//     established earlier in the SAME criterion, often in a different clause,
//     e.g. 'fixture spawns...; ...killed') matches that pattern, the row does
//     NOT fire — the process/resource acted upon is CREATED BY THE TEST OR
//     FIXTURE, not pre-existing on the operator's machine, so the action is
//     headlessly performable. No qualifier, or no match ⇒ the row fires exactly
//     as before (DEFAULT ON FIRING: a false positive costs a reword, a false
//     negative costs a dispatched task that can never pass, the W1-T9 death
//     spiral) — W1-T12d's live-kill criterion names no ownership signal and
//     must keep flagging.
//   - FALSE NEGATIVE — the genuinely headless-unfit proofs the check was BUILT to
//     catch ('paste the red check, then revert' — the W1-T25 no_pr incident,
//     122 turns before verdict=no_pr) are PHRASES, not lexicon words, so the
//     original word-only lexicon never matched them. Phrase-level signals below
//     close this gap.

export interface LexiconEntry {
  tag: string;
  pattern: RegExp;
  /** SPAWN-OWNERSHIP qualifier (W1-T118, the #268 false positive) — OPTIONAL,
   *  scope-as-data, never a reason to delete the row. When present, a hit for
   *  THIS row is exempted (does not flag) if `qualifier` matches anywhere in the
   *  criterion's combined claim+proof text: the criterion's own words establish
   *  that the process/resource acted upon is CREATED BY THE TEST OR FIXTURE
   *  (spawns/seeds/fixture/in-process/test-spawned), not pre-existing on the
   *  operator's machine. Absent, or no match ⇒ the row fires unconditionally,
   *  exactly as before — DEFAULT ON FIRING: an ambiguous criterion (the term
   *  appears with no ownership signal either way) still flags, because a false
   *  positive costs a reword while a false negative costs a dispatched task
   *  that can never pass (the W1-T9 death spiral). See {@link
   *  SPAWN_OWNERSHIP_CUE} for the shared cue pattern most rows will reuse. */
  qualifier?: RegExp;
}

/** Shared SPAWN-OWNERSHIP cue (W1-T118): the criterion's own text names the
 *  test/fixture as the thing that CREATED the process/resource being acted
 *  upon — 'a worker fixture spawns a detached child... the child's process
 *  group killed' (W1-T117) vs 'the LIVE daemon killed mid-task' (W1-T12d,
 *  names no such actor). Any lexicon row may reuse this as its `qualifier`,
 *  or supply its own — the field is per-row DATA, not tied to this constant. */
export const SPAWN_OWNERSHIP_CUE = /\b(?:spawns?|spawned|spawning|seeds?|seeded|seeding|fixture|in-process|test-spawned)\b/i;

export const HEADLESS_FORBIDDEN_LEXICON: ReadonlyArray<LexiconEntry> = [
  { tag: "overnight", pattern: /\bovernight\b/i },
  { tag: "reboot", pattern: /\breboot\b/i },
  { tag: "launchctl", pattern: /\blaunchctl\b/i },
  { tag: "loads-at-boot", pattern: /\bloads?\s+at\s+boot\b/i },
  { tag: "killed", pattern: /\bkilled\b/i, qualifier: SPAWN_OWNERSHIP_CUE },
  { tag: "operator-confirms", pattern: /\boperator\s+confirms?\b/i },
  { tag: "user-selects", pattern: /\buser\s+selects?\b/i },
  { tag: "manual-eyeball", pattern: /\bmanual[- ]eyeball(?:ed|ing)?\b/i },
  // Phrase-level live-demonstration signals (RECALL, the #146 sweep) — an
  // imperative demonstration no headless worker can perform, regardless of
  // whether any single WORD above appears: 'paste the <red|green|score|check>
  // [...], then revert' (W1-T25/26/28 pre-sweep), 'run against <a live/sandbox
  // repo>' (W1-T27 pre-sweep: 'run against remudero-sandbox'), and 'operator
  // observes'. NOT included: a bare 'screenshot' — checked against the LIVE
  // plan (255 tasks) before landing, it false-positived on W1-T153's Lighthouse
  // artifact (an AUTOMATED headless-browser capture attached to the PR, not a
  // live action) and on W1-T184's '(operator screenshot, 2026-07-20)' — a
  // FALSIFIER citing PAST evidence, not an instruction to the worker. The word
  // alone doesn't distinguish "a headless worker can produce this" from "a
  // human must be there" — exactly the false-positive failure mode this task
  // exists to fix, so it stays out until a precise phrase shape is found.
  {
    tag: "paste-then-revert",
    pattern: /\bpaste\s+the\s+(?:\w+\s+){0,2}(?:red|green|score|check)\b[\s\S]{0,40}?\bthen\s+revert\b/i,
  },
  {
    tag: "against-live-repo",
    pattern: /\brun\b[\s\S]{0,15}\bagainst\b[\s\S]{0,30}\b(?:sandbox|repo|repository)\b/i,
  },
  { tag: "operator-observes", pattern: /\boperator\s+observ(?:es?|ing|ed)\b/i },
];

/** Clause-boundary punctuation that scopes how far left a negation cue can reach. */
const CLAUSE_BOUNDARY = /[.,;:()—]/;

/** no/not/never/without/... — a negation cue, scanned within the SAME clause as a hit. */
const NEGATION_CUE = /\b(?:no|not|never|without|non|isn't|doesn't|won't|cannot|can't|nor)\b/i;

/** A quoted span: '...' or "...", excluding a contraction/possessive apostrophe (no
 *  letter immediately outside either delimiter — 'isn't' and 'daemon's' don't count). */
const QUOTE_SPAN = /(?<![\w])['"]([^'"]{2,200}?)['"](?![\w])/g;

interface LexiconHit {
  tag: string;
  start: number;
  end: number;
}

/** Every occurrence of every lexicon entry in `text`, sorted by position. */
function findLexiconHits(text: string, lexicon: ReadonlyArray<LexiconEntry>): LexiconHit[] {
  const hits: LexiconHit[] = [];
  for (const entry of lexicon) {
    const flags = entry.pattern.flags.includes("g") ? entry.pattern.flags : `${entry.pattern.flags}g`;
    const re = new RegExp(entry.pattern.source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      hits.push({ tag: entry.tag, start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) re.lastIndex++; // never loop on a zero-width match
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

/** Indices of `hits` that are part of a bare-'/'-joined enumeration (>=2 terms,
 *  e.g. 'overnight/launchctl/killed') — a quoted/listed lexicon excerpt, not an
 *  instruction (W1-T20c's self-description). */
function enumerationExemptIndices(hits: LexiconHit[], text: string): Set<number> {
  const exempt = new Set<number>();
  for (let i = 1; i < hits.length; i++) {
    if (text.slice(hits[i - 1].end, hits[i].start) === "/") {
      exempt.add(i - 1);
      exempt.add(i);
    }
  }
  return exempt;
}

/** True iff [start, end) falls entirely inside a quoted span of `text`. */
function isQuoted(text: string, start: number, end: number): boolean {
  QUOTE_SPAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUOTE_SPAN.exec(text))) {
    if (start >= m.index && end <= m.index + m[0].length) return true;
  }
  return false;
}

/** True iff a negation cue precedes `start` within the SAME clause. */
function isNegationScoped(text: string, start: number): boolean {
  let clauseStart = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (CLAUSE_BOUNDARY.test(text[i])) {
      clauseStart = i + 1;
      break;
    }
  }
  return NEGATION_CUE.test(text.slice(clauseStart, start));
}

/** True iff `tag`'s row in `lexicon` carries a `qualifier` that matches
 *  somewhere in `text` — the criterion's own words establish spawn-ownership
 *  (W1-T118, the #268 false positive). Unscoped by clause (unlike {@link
 *  isNegationScoped}): ownership is typically established earlier in the SAME
 *  criterion, often in a different clause ('fixture spawns...; ...killed'), so
 *  restricting to the local clause would miss it. No qualifier on the row, or
 *  no match ⇒ false — DEFAULT ON FIRING (W1-T118(ii)): an ambiguous criterion
 *  still flags. */
function isSpawnOwnershipQualified(text: string, tag: string, lexicon: ReadonlyArray<LexiconEntry>): boolean {
  const entry = lexicon.find((e) => e.tag === tag);
  if (!entry?.qualifier) return false;
  const re = new RegExp(entry.qualifier.source, entry.qualifier.flags.replace(/g/g, ""));
  return re.test(text);
}

/** Every criterion of an auto-verify task that hits `lexicon` outside a negation
 *  scope, a quoted span, or a bare-'/' lexicon enumeration. Defaults to
 *  {@link HEADLESS_FORBIDDEN_LEXICON}; the `lexicon` param exists so the DATA
 *  table can grow (a new phrase row) with ZERO changes to this function. */
export function headlessFitnessViolations(
  task: Task,
  lexicon: ReadonlyArray<LexiconEntry> = HEADLESS_FORBIDDEN_LEXICON,
): LintViolation[] {
  if (task.verify !== "auto") return []; // only an auto-verify task is dispatched headless
  const violations: LintViolation[] = [];
  (task.acceptance ?? []).forEach((c, i) => {
    // Joined with an em-dash — a CLAUSE_BOUNDARY char — so a negation cue or a
    // quoted span in one field can never leak into the OTHER field (claim vs
    // proof are logically separate clauses; W1-T81).
    const text = `${c.claim ?? ""} — ${c.proof ?? ""}`;
    const hits = findLexiconHits(text, lexicon);
    if (hits.length === 0) return;
    const enumExempt = enumerationExemptIndices(hits, text);
    const hit = hits.find(
      (h, idx) =>
        !enumExempt.has(idx) &&
        !isQuoted(text, h.start, h.end) &&
        !isNegationScoped(text, h.start) &&
        !isSpawnOwnershipQualified(text, h.tag, lexicon),
    );
    if (hit) {
      violations.push({
        check: "headless-fitness",
        severity: "block",
        message:
          `criterion ${i + 1} ("${(c.claim ?? "").slice(0, 80)}") uses live-context term '${hit.tag}' ` +
          "on an auto-verify task — Rule 18: move to verify:human or redesign for headless verification",
      });
    }
  });
  return violations;
}

// ── PROOF-SHAPE ──────────────────────────────────────────────────────────────
//
// Every criterion needs an OBSERVABLE proof, not a vibe ("works" / "correct" /
// empty). DATA-driven, same pattern as the two lexicons above.

const VIBE_PROOFS = new Set([
  "",
  "works",
  "it works",
  "correct",
  "is correct",
  "looks correct",
  "works correctly",
  "should work",
  "passes",
  "looks good",
  "fine",
  "yes",
  "done",
  "trust me",
]);

function isVibeProof(proof: string): boolean {
  return VIBE_PROOFS.has(proof.trim().toLowerCase().replace(/[.!]+$/, ""));
}

/** Every criterion whose proof is missing or a vibe phrase, not an observable. */
export function proofShapeViolations(task: Task): LintViolation[] {
  const violations: LintViolation[] = [];
  (task.acceptance ?? []).forEach((c, i) => {
    if (isVibeProof(c.proof ?? "")) {
      violations.push({
        check: "proof-shape",
        severity: "block",
        message: `criterion ${i + 1} ("${(c.claim ?? "").slice(0, 60)}") has no observable proof — proof is "${c.proof ?? ""}"`,
      });
    }
  });
  return violations;
}

// ── PROOF-DIALECT (moratorium finding 9 — the dead proof floor) ─────────────
//
// remudero-review resolves a task's acceptance from tasks.yaml and EXECUTES
// each `proof:` — but only review.ts's own house dialect actually runs
// (`parseWhitelistedProof`: `unit test: <path-or-name>` / `grep: <pattern> in
// <path>`, plus two legacy strict shapes). Anything else is free prose: it
// never executes, degrades straight to the 0.6 keyword floor, and a task with
// ZERO executable proofs CAPS on review exactly like W1-T79 (PR #662) did — a
// two-step manual operator rescue (a worker cannot amend its own criteria,
// Standing rule 15). CENSUS at filing time: 45% of all plan proofs (390/861)
// cannot execute; 96 not-done tasks have zero executable proofs. The fix
// belongs at AUTHORING, not a third rescue lever on the review side — this
// check REUSES review.ts's own predicate (never a reimplementation that could
// drift from what the executor actually runs).
//
// W1-T277: a THIRD dialect, `demonstration: <what the operator must do>`,
// is also never executed — but unlike the free prose above, that is not a
// defect: it is an honest, on-the-record declaration that the proof is an
// operator action with no executable form and never will be (a chaos drill,
// a device recording, a live deploy). Legal ONLY on a `verify: human` task
// (where it lints clean); refused outright on `verify: auto` (where the
// identical prefix would be an escape hatch from the rule this check exists
// to enforce). See the dedicated block below, checked BEFORE the general
// dead-proof-floor logic.

/** A near-miss dialect prefix — close enough to the real `unit test:`/`grep:`
 *  labels that it reads as an authoring TYPO rather than deliberate prose
 *  (`unit tests:` plural, `unit test over ...:`, `integration test:`), but
 *  none of these match {@link parseWhitelistedProof}'s exact prefixes, so the
 *  proof still falls through to free prose. Checked at the START of the
 *  trimmed proof only — the dialect label is how a proof STARTS (mirrors
 *  review.ts's own `isDialectPrefixed` doc). */
const NEAR_MISS_PREFIX_RE = /^(?:unit tests\s*:|unit test over\b|integration test\s*:)/i;

/** True iff a `unit test:` dialect BODY reads as a runtime narrative rather
 *  than a literal test-title substring — the W1-T79-criteria-3/4 shape
 *  ("same-sha fixture -> no pull, no re-exec, ..."). `--test-name-pattern`
 *  is a substring match against the actual test's title, so a compound,
 *  multi-clause body predictably matches ZERO tests at review time (degrading
 *  to the keyword floor, W1-T72's `floorDegraded` signal) even though the
 *  proof parses as executable. WARN-only, regardless of `opts.proofDialect`:
 *  some real test titles genuinely are long or contain `;`, so this is a
 *  hint, never a block. */
function looksLikeNonTitleBody(body: string): boolean {
  return body.includes(" -> ") || body.includes("; ") || body.length > 100;
}

/** Every non-`satisfied_by` criterion whose proof does not parse as a
 *  {@link parseWhitelistedProof} shape — a proof that CANNOT execute never
 *  lands (the dead proof floor, moratorium finding 9). BLOCK by default, and
 *  since impl-AK every call site including run-task.ts's pre-dispatch gate
 *  takes that default: `opts.proofDialect: "warn"` remains available (it
 *  demotes every violation here to visibility-only) but no caller passes it.
 *  A criterion whose proof DOES parse but
 *  reads as a non-title `unit test:` body (see {@link looksLikeNonTitleBody})
 *  gets a separate WARN, always, independent of `opts.proofDialect`. */
export function proofDialectViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  const severity: LintSeverity = opts.proofDialect ?? "block";
  const violations: LintViolation[] = [];
  (task.acceptance ?? []).forEach((c, i) => {
    if (c.satisfied_by) return; // Architect-only; never expected to be executable prose
    const proof = c.proof ?? "";
    const trimmed = proof.trim();
    const claimHead = (c.claim ?? "").slice(0, 60);

    // W1-T277: `demonstration: <what the operator must do>` names an operator
    // action with no executable form and never will (a chaos drill, a device
    // recording, a live deploy) — it is a proof the harness DECLINES to check,
    // on the record, not one that failed to parse. Legal ONLY on a
    // verify:human task, where declining to execute it is the entire point
    // (lints clean, no violation at all — never even a warn). On a
    // verify:auto task the identical prefix is an escape hatch from the
    // executable-proof rule this check exists to enforce, so it is BLOCKED
    // unconditionally here — that asymmetry is the dialect's whole safety
    // property (W1-T277 design), so it holds regardless of `opts.proofDialect`
    // (the legacy-backlog warn-only rollout knob applies to proofs that FAIL
    // to parse, never to one that is illegal by construction).
    if (isDemonstrationProof(trimmed)) {
      if (task.verify === "human") return;
      const head = trimmed.slice(0, 80) + (trimmed.length > 80 ? "…" : "");
      violations.push({
        check: "proof-dialect",
        severity: "block",
        message:
          `criterion ${i + 1} ("${claimHead}") proof "${head}" uses \`demonstration:\` on a verify:${task.verify} ` +
          "task — that dialect is legal ONLY on verify:human tasks (it declares an operator action the harness " +
          "will never execute); on a verify:auto task it is an escape hatch from the executable-proof rule and " +
          "is refused",
      });
      return;
    }

    const whitelisted = parseWhitelistedProof(proof);
    if (whitelisted) {
      if (whitelisted.kind === "test" && whitelisted.nameFiltered && looksLikeNonTitleBody(whitelisted.label)) {
        violations.push({
          check: "proof-dialect",
          severity: "warn",
          message:
            `criterion ${i + 1} ("${claimHead}") \`unit test:\` body "${whitelisted.label.slice(0, 80)}" reads as a ` +
            "runtime narrative, not a literal test-title substring — the W1-T79-criteria-3/4 shape (0 tests will " +
            "match at review time, degrading to the keyword floor); name the actual test's title instead",
        });
      }
      return;
    }
    const head = trimmed.slice(0, 80) + (trimmed.length > 80 ? "…" : "");
    let why: string;
    if (isDialectPrefixed(trimmed)) {
      why =
        "dialect-prefixed but refused by parseWhitelistedProof (e.g. a `grep:` proof with no `in <path>` clause, " +
        "or a path attempting traversal/a glob) — not executable as written";
    } else if (NEAR_MISS_PREFIX_RE.test(trimmed)) {
      why = "near-miss dialect prefix — did you mean `unit test:` (or `grep: <pattern> in <path>`)?";
    } else {
      why = "free prose — not executable";
    }
    violations.push({
      check: "proof-dialect",
      severity,
      message:
        `criterion ${i + 1} ("${claimHead}") proof "${head}" cannot execute (${why}) — the dead proof floor ` +
        "(moratorium finding 9): rewrite as `unit test: <path-or-test-title>` or `grep: <pattern> in <path>`",
    });
  });
  return violations;
}

// ── PROOF-RESOLVABILITY (W1-T101 — a dialect prefix is a promise) ───────────
//
// proofDialectViolations (above, W1-T246) already refuses a dialect body that
// does not PARSE at all (a `grep:` proof with no `in <path>` clause, etc.) and
// WARNS when a `unit test:` body reads as a runtime narrative — but never
// BLOCKS the narrative case, because parseTestTarget (review.ts) deliberately
// treats ANY non-path `unit test:` body as a valid name-filtered proof, on the
// theory that the author's own prose might still match a real test's title.
// The W1-T100 ledger is the gap that permissiveness leaves open: proof_exec
// [not_executable x3] on two `unit test:`-prefixed proofs, each PARSING as
// "whitelisted", each resolving to ZERO real tests at review time — a prefix
// that PROMISED executability with a payload that could never resolve.
//
// This rule polices that PROMISE, independent of whether the payload happens
// to parse: a `unit test:`/`grep:` prefix commits the author to naming a
// RESOLVABLE artifact — a path-like token or an explicit `::test-name` token
// for `unit test:`, a pattern plus an `in <path>` clause for `grep:` (DATA,
// {@link PROOF_PAYLOAD_SHAPES} — companion rows to W1-T81's phrase signals and
// W1-T92's path classes; a new resolvable shape is a table row, zero engine
// changes). A proof with NO dialect prefix makes no such promise and is NEVER
// touched by this rule — prose is legitimate and keyword-bound by design; drop
// the prefix is always the other valid remedy.
//
// A `unit test:` body that carries neither anchor is refused ONLY when it also
// reads as a multi-clause SCENARIO NARRATIVE, never on a bare single-arrow
// phrase alone — this repo's OWN test titles idiomatically read `X -> Y` (187
// real `test("... -> ...")` titles in this suite, e.g. `test("decideAlert
// Disposition: critical severity -> escalate")`), so a lone arrow is not a red
// flag. What the W1-T100 corpus actually looks like is SEVERAL independent
// observations chained together (multiple comma-separated clauses, or a
// semicolon stacked on top of an enumerated clause) — a shape no single test
// title plausibly reads as. `grep:` carries no such exception: the dialect's
// own promise ("a pattern AND an `in <path>` clause") is unconditional.

export interface ProofPayloadShape {
  tag: string;
  /** Which dialect prefix this shape resolves. */
  dialect: "unit test" | "grep";
  /** Tested against the BODY — the proof text AFTER the dialect prefix. */
  pattern: RegExp;
}

/** DATA table — a new resolvable payload SHAPE is a row here, zero engine
 *  changes (mirrors {@link SUBSYSTEM_LEXICON} / {@link DATA_ARTIFACT_CLASSES} /
 *  {@link HEADLESS_FORBIDDEN_LEXICON} above). */
export const PROOF_PAYLOAD_SHAPES: ReadonlyArray<ProofPayloadShape> = [
  // unit test: a path-like token (test/*.test.ts) anywhere in the body.
  { tag: "test-path", dialect: "unit test", pattern: /\btest\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/ },
  // unit test: an explicit ::test-name token — a literal '::' followed by a
  // non-empty name, unambiguous even when the token before it isn't a path.
  { tag: "test-name-token", dialect: "unit test", pattern: /::\s*\S/ },
  // grep: a pattern AND a trailing `in <path>` clause — the same shape
  // parseDialectGrep (review.ts) requires to parse at all, re-declared here as
  // DATA so the remedy text below stays uniform across both dialects.
  { tag: "grep-in-path", dialect: "grep", pattern: /\bin\s+\S*[./]\S*\s*$/i },
];

/** How a proof's TEXT starts when it is written in the executable dialect —
 *  matched EXACTLY (unlike {@link NEAR_MISS_PREFIX_RE} above, a near-miss
 *  prefix makes no promise this rule polices; that's its own, separate hint). */
const RESOLVABILITY_DIALECT_RE = /^(unit test|grep):\s*([\s\S]*)$/i;

/** True iff `body` reads as a multi-clause scenario narrative rather than a
 *  single test's title — see the module comment above for why a lone arrow
 *  does not, by itself, qualify. */
function looksLikeScenarioNarrative(body: string): boolean {
  const commas = (body.match(/,/g) ?? []).length;
  return commas >= 2 || (body.includes("; ") && commas >= 1) || body.length > 100;
}

/** Every criterion whose proof STARTS with the executable dialect (`unit
 *  test:` | `grep:`) but whose payload matches NONE of {@link
 *  PROOF_PAYLOAD_SHAPES} for that dialect — a prefix that promises
 *  executability without naming a resolvable artifact (the W1-T100 0/3). A
 *  proof with no dialect prefix is never touched (prose is legitimate by
 *  design). BLOCK by default; `opts.proofResolvability: "warn"` (the
 *  pre-dispatch call site — the legacy backlog authored before this check
 *  existed must not brick overnight) demotes every violation here to
 *  visibility-only, the SAME rollout convention {@link proofDialectViolations}
 *  already uses.
 */
export function proofResolvabilityViolations(
  task: Task,
  opts: LintOpts = {},
  shapes: ReadonlyArray<ProofPayloadShape> = PROOF_PAYLOAD_SHAPES,
): LintViolation[] {
  const severity: LintSeverity = opts.proofResolvability ?? "block";
  const violations: LintViolation[] = [];
  (task.acceptance ?? []).forEach((c, i) => {
    if (c.satisfied_by) return; // Architect-only; never expected to be executable prose
    const proof = c.proof ?? "";
    const trimmed = proof.trim();
    const m = trimmed.match(RESOLVABILITY_DIALECT_RE);
    if (!m) return; // no dialect prefix promised — untouched, prose is legitimate by design
    const dialect = m[1]!.toLowerCase() as "unit test" | "grep";
    const body = m[2]!.trim();
    if (shapes.some((s) => s.dialect === dialect && s.pattern.test(body))) return; // resolvable
    if (dialect === "unit test" && !looksLikeScenarioNarrative(body)) return; // a plausible single test title
    const claimHead = (c.claim ?? "").slice(0, 60);
    const head = trimmed.slice(0, 80) + (trimmed.length > 80 ? "…" : "");
    const remedy =
      dialect === "unit test"
        ? 'name a literal test/*.test.ts path or an explicit ::test-name anchor (e.g. "test/foo.test.ts::exact title")'
        : 'name a pattern with an `in <path>` clause (e.g. "grep: TODO in src/lib/foo.ts")';
    violations.push({
      check: "proof-resolvability",
      severity,
      message:
        `criterion ${i + 1} ("${claimHead}") proof "${head}" is \`${m[1]}:\`-prefixed but names no resolvable ` +
        `artifact — ${remedy}, or drop the \`${m[1]}:\` prefix and write it as prose`,
    });
  });
  return violations;
}

// ── POST-MERGE-AMENDMENT (§5C, W1-T180) ──────────────────────────────────────
//
// An amendment to an ALREADY-MERGED task's acceptance criteria is unreachable by
// every rung today: MERGED is terminal in the status layer (status.ts:696), the
// drain skips a merged id outright (drain.ts:88's `if (isMerged(t.id)) continue`),
// and the retro's plan-health sweep explicitly scopes itself away from a closed
// task (retro.ts:578). So a claim added to a merged task's criteria after the
// fact sits in the plan looking authoritative and is never dispatched, reviewed,
// or proven — the LIVE FIXTURE: PR #374 added two criteria to W1-T155 an hour
// forty-five minutes after PR #365 credited it merged, and every existing gate
// passed it clean. Standing rule 21 (MASTER-PLAN §12) names the house answer in
// prose — amending a merged task does not re-queue it; the amender owns filing
// the follow-up in the SAME PR — this check is what makes that answer CHECKED
// rather than merely conventional.
//
// THE INJECTION PROBLEM: merge state and the base-ref criteria set are I/O, and
// this module is documented as a PURE function over an already-loaded Task/Plan
// (module comment above) — so neither is fetched here. Both arrive through
// {@link LintOpts.postMergeAmendment}, populated by the CALLER (run-task.ts's
// `lintPlanCommand`, which already does the `--base` git-show read) from
// deriveStatus + the base plan snapshot. This check performs no I/O and imports
// neither status.ts nor any gh/exec surface.

/** Trim + collapse-whitespace normalized key for a criterion's (claim, proof)
 *  pair — SET membership, not raw-list/positional equality, so reordering the
 *  `acceptance:` list or a pure formatting reflow never trips this check; only
 *  a criterion whose claim+proof text actually differs from every base-ref
 *  entry counts as added-or-changed. */
function criterionKey(c: AcceptanceCriterion): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  return `${norm(c.claim ?? "")} ${norm(c.proof ?? "")}`;
}

/**
 * Criteria in `currentCriteria` whose (claim+proof) pair does not appear
 * anywhere in `baseCriteria` — covers BOTH an outright ADDITION and a semantic
 * CHANGE to an existing criterion (a changed pair is, by set membership, a new
 * one). `baseCriteria` undefined (the task did not exist at the base ref, or
 * the caller could not resolve a base version) yields no additions — nothing
 * to diff against, so the check is a no-op for that task.
 */
export function criteriaAdded(
  baseCriteria: AcceptanceCriterion[] | undefined,
  currentCriteria: AcceptanceCriterion[],
): AcceptanceCriterion[] {
  if (!baseCriteria) return [];
  const baseKeys = new Set(baseCriteria.map(criterionKey));
  return currentCriteria.filter((c) => !baseKeys.has(criterionKey(c)));
}

/**
 * True iff every criterion in `added` is carried by at least one task in
 * `candidateTasks` — the follow-up escape hatch (W1-T180's design): the same PR
 * that amends a merged task's criteria also introduces a NEW task whose own
 * acceptance criteria include the amended ones, so the criteria have a home
 * that will actually be dispatched. Vacuously true when `added` is empty (there
 * is nothing to carry). The caller supplies `candidateTasks` as the OTHER tasks
 * newly introduced by the same changed set — this function does no scoping of
 * its own.
 */
export function followUpCarriesCriteria(added: AcceptanceCriterion[], candidateTasks: Task[]): boolean {
  if (added.length === 0) return true;
  const addedKeys = new Set(added.map(criterionKey));
  return candidateTasks.some((t) => (t.acceptance ?? []).some((c) => addedKeys.has(criterionKey(c))));
}

/**
 * Context the CALLER resolves via I/O and injects through {@link LintOpts} —
 * see the module comment above this section for why it cannot be fetched here.
 */
export interface PostMergeAmendmentContext {
  /** False iff the derived merge status could not be resolved at all (`gh`
   *  unavailable, no token, `loadConfig`'s CI trap — see run-task.ts's
   *  `lintPlanCommand`). FAIL OPEN: an unreadable status never produces a
   *  violation, deliberately, so a GitHub outage never reds the one lane
   *  (plan-only PRs) that still works during one. */
  statusResolvable: boolean;
  /** This task's derived status is MERGED. Only a merged task can be "amended
   *  post-merge" — an open/queued task's criteria changing is ordinary authoring. */
  merged: boolean;
  /** This task's acceptance criteria as they existed at the PR's base ref.
   *  Undefined when the task is new in this PR or the caller could not resolve
   *  a base version — either way {@link criteriaAdded} is a no-op. */
  baseAcceptance?: AcceptanceCriterion[];
  /** Whether some OTHER task in the SAME changed set already carries the added
   *  criteria (the follow-up escape hatch) — necessarily computed across the
   *  whole changed set by the caller, since a single task's lint has no
   *  visibility into its siblings. */
  followUpFiled: boolean;
}

/** Every acceptance criterion this PR adds or changes on an ALREADY-MERGED
 *  task, absent a follow-up task in the same PR to carry it. No {@link
 *  LintOpts.postMergeAmendment} at all ⇒ this check is skipped entirely (the
 *  pre-dispatch call site never dispatches a merged task in the first place,
 *  so it never supplies this context). */
export function postMergeAmendmentViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  const ctx = opts.postMergeAmendment;
  if (!ctx) return [];
  if (!ctx.statusResolvable) return []; // fail OPEN on an unreadable derived status
  if (!ctx.merged) return []; // only a merged task's criteria can orphan this way
  const added = criteriaAdded(ctx.baseAcceptance, task.acceptance ?? []);
  if (added.length === 0) return []; // no delta vs the base ref — reword/reorder-only, or unchanged
  if (ctx.followUpFiled) return []; // the escape hatch: the same PR files the follow-up
  return added.map((c) => ({
    check: "post-merge-amendment",
    severity: "block",
    message:
      `task ${task.id} is already MERGED, but this PR adds/changes acceptance criterion ` +
      `("${(c.claim ?? "").slice(0, 80)}") with no follow-up task carrying it filed in the same PR — ` +
      "Standing rule 21: MERGED is terminal (an amendment does not re-queue the task), the drain " +
      "skips a merged id outright, and the retro sweep skips a closed one, so this criterion would " +
      "orphan silently; file a follow-up task carrying it in this SAME PR",
  }));
}

// ── PROVENANCE (Rules 16/17) ─────────────────────────────────────────────────
//
// `risk:` is already guaranteed present by plan.ts's loader (it validates
// against TASK_RISKS and defaults an omitted one to DEFAULT_RISK — a load-time
// contract, not a linter concern). The remaining provenance gap the linter
// checks is `origin:`, which the loader does NOT default: every task must name
// where it came from (architect / feedback#… / alert#… / issue#…).

/** Missing `origin:` ⇒ a provenance violation. */
export function provenanceViolation(task: Task): LintViolation | undefined {
  if (!task.origin || !task.origin.trim()) {
    return {
      check: "provenance",
      severity: "block",
      message: "missing origin: — Rules 16/17 require every task to name where it came from",
    };
  }
  return undefined;
}

// ── BUDGET-SANITY (soft) ─────────────────────────────────────────────────────
//
// A WARNING (never blocks) when a task's resolved mount turn-budget sits below
// the observed class mean. The mean is ALWAYS an injected argument, read by the
// caller from MASTER-PLAN's current-cycle Calibration row (retro.ts's
// calibrationTable) or the retro's own aggregate — NEVER a hardcoded literal.

export interface ClassCalibration {
  avgTurns: number;
}

export function budgetSanityWarning(
  mountMaxTurns: number,
  calibration: ClassCalibration | undefined,
): LintViolation | undefined {
  if (!calibration) return undefined;
  if (mountMaxTurns >= calibration.avgTurns) return undefined;
  return {
    check: "budget-sanity",
    severity: "warn",
    message:
      `mount max_turns=${mountMaxTurns} is below the observed class mean ${calibration.avgTurns} turns ` +
      "— consider raising risk or the mount's max_turns",
  };
}

// ── Aggregator ────────────────────────────────────────────────────────────────

/**
 * CALL-SITE (impl-DO) — "the code is REACHED, not merely that it exists".
 *
 * ELEVEN MEASURED INSTANCES IN THREE DAYS of code that merged green and nothing ever calls:
 * `console-freshness.ts` (111 lines, 83 of tests, `serve.ts` never imported it — the defect it
 * fixed is still on screen eight days later), `panel-skills.ts`, `panel-skill-run.ts`,
 * `runbook-coverage.ts`, `log-rotation.ts`, and PR #1066's auto-triage rung, whose producer
 * `daemonCommand` never supplied. Eighteen passing tests, three genuine diff-coverage blocks and a
 * green review, dead on arrival.
 *
 * WHY NO EXISTING GATE CATCHES IT (recon-DL): `lint-plan` never opens src/; `tsc` is satisfied
 * because a TEST is an importer; `coverage-ratchet` is satisfied because a unit test calling the
 * function directly covers 100% of it; `remudero-review` executes those same tests. Every gate asks
 * whether the code WORKS. None asks whether anything CALLS it.
 *
 * THE RULE. A task that will CREATE a src/ module must carry at least one acceptance criterion
 * whose proof demonstrates a CALL SITE in a DIFFERENT file: `grep: <symbol>( in <consumer path>`.
 *
 * ★ CALL vs MENTION, AND THE EXACT LIMIT OF WHAT THIS CHECKS. `grep: resolveFreshness in
 * src/lib/serve.ts` passes on a COMMENT — that is precisely how W1-T267's proof exited 0 against
 * entirely unbuilt work. `grep: resolveFreshness( in src/lib/serve.ts` demands the open paren, so
 * the pattern can only be satisfied by something shaped like an invocation. This check enforces
 * THE SHAPE OF THE PROOF, which is mechanically decidable. It does NOT and cannot verify that the
 * eventual grep hit is executable code rather than a comment containing `foo(` — that would need to
 * run the proof against a tree that does not exist yet. Saying so plainly is the point: this is the
 * honest weaker version, and what it cannot catch is a comment written to look like a call.
 *
 * MULTI-LINE CALLS ARE NOT A PRACTICAL RISK HERE, and that was measured rather than assumed: across
 * all of src/ at b5fd9cc there are 12,639 same-line `identifier(` occurrences and ONE split across a
 * newline (0.008%). A line-oriented grep for `foo(` therefore finds real call sites.
 */
export function callSiteViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  // NO PREDICATE ⇒ NO OPINION. The linter is pure (no fs), so whether a module already exists is
  // the caller's to answer. Absent it this check is silent rather than guessing — a wrong guess
  // here would flag every task that merely EDITS a module.
  if (!opts.moduleExists) return [];
  const severity: LintSeverity = opts.callSite ?? "warn";
  const created = (task.files ?? []).filter(
    (f) => f.startsWith("src/") && f.endsWith(".ts") && !f.includes("*") && !opts.moduleExists!(f),
  );
  if (created.length === 0) return [];

  const proves = (c: AcceptanceCriterion): boolean => {
    const parsed = parseWhitelistedProof(c.proof);
    if (!parsed || parsed.kind !== "grep") return false;
    const m = /^grep:\s*(.+?)\s+in\s+(\S+)\s*$/i.exec(String(c.proof).trim());
    if (!m) return false;
    const [, pattern, path] = m;
    // A CALL, not a mention: the pattern must demand an invocation…
    if (!pattern.includes("(")) return false;
    // …in a file OTHER than the module being created. A module calling itself proves nothing about
    // whether the rest of the program reaches it.
    return !created.includes(path);
  };

  if ((task.acceptance ?? []).some(proves)) return [];
  return [
    {
      check: "call-site",
      severity,
      message:
        `task ${task.id} creates ${created.join(", ")} but no acceptance criterion proves a CALL SITE ` +
        `for it. Add one of the form: grep: <symbol>( in <the file that calls it> — the open paren is ` +
        `required (a bare symbol name passes on a comment), and the path must differ from the new ` +
        `module. Eleven modules have merged green and unreached; this is the check that would have ` +
        `caught six of them.`,
    },
  ];
}

export interface LintOpts {
  /** The task's resolved mount turn-budget — only needed to opt INTO budget-sanity. */
  mountMaxTurns?: number;
  /** The observed class mean, from a real Calibration row — never hardcoded. */
  calibration?: ClassCalibration;
  /** Severity for {@link proofDialectViolations}. Default "block", and since impl-AK EVERY
   *  call site takes it — CI's `lint-plan`, the inbox draft rung, the retro's plan-health
   *  sweep, AND run-task.ts's pre-dispatch `assertLintClean`. The "warn" demotion the
   *  pre-dispatch site used to pass is still honoured here, but nothing passes it: a proof
   *  that cannot execute is refused before a worker spawns. */
  proofDialect?: LintSeverity;
  /** Does this repo-relative path already exist? Supplied by the caller because the linter is pure.
   *  Absent ⇒ {@link callSiteViolations} is silent. */
  moduleExists?: (repoRelPath: string) => boolean;
  /** Severity for {@link callSiteViolations}. Default "warn" — see the report's retrofit count. */
  callSite?: LintSeverity;
  /** Severity for {@link proofResolvabilityViolations}. Default "block" — but `rmd
   *  run-task`'s pre-dispatch call site DELIBERATELY still passes "warn", and that is not an
   *  oversight: a queued task's proof legitimately FORWARD-REFERENCES the test its own PR
   *  will create, and this check cannot tell that apart from a dead reference pre-dispatch.
   *  CI's `lint-plan`, the inbox draft rung, and the retro's plan-health sweep — the birth
   *  gates, where the artifact really ought to exist — all want the default and BLOCK. */
  proofResolvability?: LintSeverity;
  /** Injected merge-state context for {@link postMergeAmendmentViolations} —
   *  see {@link PostMergeAmendmentContext} for why this arrives by injection
   *  rather than a fetch. Absent ⇒ the check is skipped (no merge state to
   *  judge against, e.g. the pre-dispatch call site, which never dispatches an
   *  already-merged task in the first place). */
  postMergeAmendment?: PostMergeAmendmentContext;
}

/** Lint one task. Hard checks (sizing/headless-fitness/proof-shape/proof-dialect/
 *  proof-resolvability/post-merge-amendment/provenance) always run — post-merge-
 *  amendment is a no-op absent `opts.postMergeAmendment` — budget-sanity runs
 *  only when `opts.mountMaxTurns` is supplied. */
export function lintTask(task: Task, opts: LintOpts = {}): LintResult {
  const violations: LintViolation[] = [];
  const sizing = sizingViolation(task);
  if (sizing) violations.push(sizing);
  violations.push(...headlessFitnessViolations(task));
  violations.push(...proofShapeViolations(task));
  violations.push(...proofDialectViolations(task, opts));
  violations.push(...proofResolvabilityViolations(task, opts));
  violations.push(...postMergeAmendmentViolations(task, opts));
  violations.push(...callSiteViolations(task, opts));
  const prov = provenanceViolation(task);
  if (prov) violations.push(prov);
  if (opts.mountMaxTurns !== undefined) {
    const warn = budgetSanityWarning(opts.mountMaxTurns, opts.calibration);
    if (warn) violations.push(warn);
  }
  return { ok: violations.every((v) => v.severity !== "block"), violations };
}

/** Lint every task in a loaded plan. Deterministic order (plan declaration order). */
export function lintPlan(plan: Plan, optsFor: (task: Task) => LintOpts = () => ({})): Map<string, LintResult> {
  const out = new Map<string, LintResult>();
  for (const task of plan.tasks) out.set(task.id, lintTask(task, optsFor(task)));
  return out;
}

/**
 * The task ids that are NEW or CHANGED between two plan snapshots (by deep
 * value, not reference) — a pure diff, no git I/O. This is what scopes the CI
 * check (`rmd lint-plan --base <ref>`) to the PR's OWN edit rather than the
 * whole historical queue: Layer A's CI half is "a CI check on any PR that
 * EDITS plan/tasks.yaml" (MASTER-PLAN §5C), so it lints the edit, not decades
 * of pre-existing debt — re-grading the WHOLE open queue is the retro's
 * separate, periodic plan-health sweep (W1-T20d), not every PR's gate.
 */
export function changedTaskIds(oldTasks: Task[], newTasks: Task[]): Set<string> {
  const oldById = new Map(oldTasks.map((t) => [t.id, t]));
  const changed = new Set<string>();
  for (const t of newTasks) {
    const old = oldById.get(t.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(t)) changed.add(t.id);
  }
  return changed;
}

/** Thrown by {@link assertLintClean} — carries only the BLOCKING violations. */
export class TaskLintError extends Error {
  public readonly taskId: string;
  public readonly violations: LintViolation[];
  constructor(taskId: string, violations: LintViolation[]) {
    super(
      `task ${taskId} failed the pre-dispatch linter (§5C Layer A) — ${violations.length} violation(s):\n` +
        violations.map((v) => `  • [${v.check}] ${v.message}`).join("\n"),
    );
    this.name = "TaskLintError";
    this.taskId = taskId;
    this.violations = violations;
  }
}

/** FAIL-CLOSED pre-dispatch guard: throws {@link TaskLintError} on any blocking violation. */
export function assertLintClean(task: Task, opts: LintOpts = {}): void {
  const { ok, violations } = lintTask(task, opts);
  if (!ok) throw new TaskLintError(task.id, violations.filter((v) => v.severity === "block"));
}

// ── READ-IDENTITY & ROOT-CONTAINMENT (gate integrity, W1-T120) ──────────────
//
// A gate that reads a task/plan must be provably reading the RIGHT ONE — a silent
// wrong-file read is still green and still wrong (the #271 false-green: one
// checkout's `bin/rmd`, invoked with cwd inside a DIFFERENT work tree, linted the
// INSTALL tree's plan and never opened the file under test at all). These two pure
// helpers give `run-task.ts`'s `lint-plan`/`review` commands the vocabulary to (a)
// refuse an out-of-root `--plan` BY NAME instead of letting it fail downstream as a
// confusing base-resolution error, and (b) print the absolute path + content hash
// of the file actually opened, so a wrong-file run is visible in its own output
// instead of merely inferred from cwd. Both are pure string/hash logic over
// ALREADY-READ input — no filesystem I/O, consistent with this module's contract.

/** True iff `candidate` resolves to a path OUTSIDE `root` (`root` itself, and anything
 *  under it, is IN). Both arguments must already be absolute — this does no resolving
 *  or symlink-following of its own. */
export function isPathOutsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === ".." || rel.startsWith(`..${sep}`);
}

/** `<abs path> (sha256:<first 12 hex chars>)` — the read-identity assertion a gate's
 *  summary line carries so the file it actually opened is legible in its OWN output,
 *  rather than merely inferable from cwd/argv. */
export function formatReadIdentity(absPath: string, raw: string): string {
  const hash = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
  return `${absPath} (sha256:${hash})`;
}
