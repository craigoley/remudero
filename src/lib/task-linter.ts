import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import type { AcceptanceCriterion, Plan, Task, TaskStatus } from "./plan.js";
import { isInPlanScope } from "./plan-architect.js";
import {
  isDemonstrationProof,
  isDialectPrefixed,
  parseWhitelistedProof,
  type NameFilterResolution,
  type WhitelistedProof,
} from "./review.js";
import {
  bestNearDuplicate,
  DEFAULT_DUPLICATE_CUTOFF,
  DEFAULT_SHINGLE_K,
  type DuplicateCorpusEntry,
} from "./knowledge-dedup.js";
import { classifyGrepZeroHit } from "./grep-zero-cause.js";

/**
 * Deterministic task linter (MASTER-PLAN §5C Layer A). NO LLM — a PURE function
 * over a loaded {@link Task}/{@link Plan}, no I/O, no side effects. Catches the
 * class of malformed task that reached a worker four times (W1-T6, W1-T9, and
 * W1-T12 twice-over) and burned budget before a human noticed: over-scoping
 * (Rule 19), headless-unfitness (Rule 18), vibe proofs, a proof that CANNOT
 * EXECUTE at all (the dead proof floor, moratorium finding 9, W1-T246), a
 * dialect-prefixed proof that promises executability but names no resolvable
 * artifact (the W1-T100 0/3, W1-T101), a proof that names a path OUTSIDE the
 * task's own declared `files:` (W1-T310 — the scope guard then refuses the
 * branch AFTER the work is done), an ALREADY-MERGED task's criteria being
 * amended with no follow-up filed in the same PR (W1-T180 — MERGED is terminal,
 * so the drain and the retro sweep both skip it and the amendment would
 * otherwise orphan silently), missing provenance (Rules 16/17), and a
 * ruling-shaped task (its `files:` includes DECISIONS.md) filed verify:auto —
 * a worker's proof that a ruling was WRITTEN is not an operator RATIFYING it
 * (W1-T326, #1302/#1303).
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
 * before either check existed does not brick overnight), proof-dialect always
 * warns (regardless of that option) for a `unit test:` proof whose body reads as a
 * runtime narrative rather than a literal test-title substring, and proof-scope
 * (W1-T310) warns by default (`opts.proofScope`, default "warn") EXCEPT one
 * conjunction it auto-escalates to "block" (W1-T2287: mis-declared, absent at head,
 * `verify: auto` — see that check's own module comment for why), and
 * dispatch-priority (W1-T422) always warns, unconditionally, like budget-sanity.
 * advisory-routing (W1-T519) is WARN-only BY CONSTRUCTION — it carries no `opts` severity
 * knob at all, anywhere, the only violation family with that property: a task whose title,
 * rationale or note names a security-shaped weakness (auth, token/credential, secret,
 * sandbox/containment, route-scope enforcement, prompt-injection) draws a warn pointing at
 * SECURITY.md's private advisory path, because filing a task shard IS publishing the finding
 * on this public repo before any fix lands — but the fleet cannot itself act on a finding held
 * in a private advisory (loadPlan only reads plan/tasks.d/ on origin/main), so the routing
 * decision stays the operator's alone and this check can never withhold a task from dispatch.
 */

export type LintCheck =
  | "sizing"
  | "headless-fitness"
  | "proof-shape"
  | "proof-dialect"
  | "proof-resolvability"
  | "proof-grep-safety"
  | "proof-grep-unmatchable"
  | "proof-engine-divergence"
  | "proof-scope"
  | "proof-name-resolution"
  | "post-merge-amendment"
  | "post-merge-field-drift"
  | "post-merge-criterion-removed"
  | "post-merge-proof-changed"
  | "provenance"
  | "call-site"
  | "monolith-filing"
  | "budget-sanity"
  | "ruling-verify"
  | "rule15-filing"
  | "duplicate-title"
  | "duplicate-learning"
  | "dispatch-priority"
  | "declared-scope"
  | "advisory-routing";
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

// ── PROOF-GREP-SAFETY (W1-T287) ──────────────────────────────────────────────
//
// A `grep:` proof's pattern is compiled by `execWhitelistedProof` as
// `grep -arn -- <pattern> <path>` — a BASIC REGULAR EXPRESSION (BRE), not a fixed
// string. Nothing in the dialect docs, the authoring prompts, or CLAUDE.md says
// so, and guidance circulating in this project ("`grep -F` is case-sensitive")
// actively teaches the wrong model. The result is measurable: 1,952 verdicts in
// the unioned ledger carry a FAILED grep proof, including `grep: loadPolicy in
// src/lib/review.ts` failing four separate times on W1-T253.
//
// THE LIVE FIXTURE (PR #1071): a proof reading `grep: For a [call-site]
// violation in <path>` had `[call-site]` read as a CHARACTER CLASS matching one
// character from {c,a,l,-,s,i,t,e}. The pattern meant "For a X violation" and
// could never match the literal text. Its author verified locally with
// `grep -F` — a DIFFERENT MATCHER — and got a false green.
//
// THE SET IS MEASURED, NOT REMEMBERED. Determined by running both grep
// implementations on this host against two discriminators: (1) does `aXb` match
// the text `aQb`, which contains no `X`? (2) does `aXb` FAIL to match the
// literal text `aXb`? Either ⇒ `X` is a metacharacter. Results:
//
//   * . ^ $ [   metacharacters      ] ( ) { } + ? | \   literal-safe
//
// `(` is NOT a BRE metacharacter (it is an ERE one), which matters because
// PR #1071's own call-site proofs use `foo(` — rejecting it would break a rule
// that merged the same day. `]` alone is literal-safe on both implementations,
// so only `[` — which is what OPENS a bracket expression — is refused.
//
// IMPLEMENTATIONS DISAGREE, so the set is the UNION (⇒ the safe intersection of
// accepted patterns). BSD grep 2.6.0-FreeBSD reads a mid-pattern `^` as a
// literal; ugrep 7.5.0 (what `grep` actually resolves to on this host) reads it
// as an anchor everywhere. A pattern whose meaning depends on which binary the
// review host happens to run is not a proof, so anything special to EITHER is
// refused.
//
// SEVERITY IS SPLIT ON THE FAILURE MODE, and the split is what the retrofit
// measurement earned. Across all 313 tasks / 31 parseable `grep:` proofs:
//   - `[ * ^ $` can make a proof NEVER match its intended text — a silent
//     false FAIL, the #1071 class. Retrofit: 0 tasks. ⇒ BLOCK.
//   - `.` merely matches MORE than intended (`a.b` also matches `aQb`) — the
//     proof still finds its literal text, so the failure mode is over-breadth,
//     not a false fail. Retrofit: 4 tasks (W1-T254, W1-T266, W1-T275, W1-T284),
//     every one a dot inside an identifier (`panel-skills.js`,
//     `sweep.post_review.attempt`). ⇒ WARN, so working proofs are not stranded.
// Blocking `.` would have forced four rewrites of proofs that function; warning
// on `[` would have let the #1071 defect through again.
//
// AN ESCAPED METACHARACTER IS LEGITIMATE and is accepted: `\.` matches a literal
// dot and NOT any character (verified on both implementations). But a backslash
// that OPENS a BRE construct — `\(`, `\)`, `\{`, `\}` (grouping and intervals,
// both confirmed working) — is itself a metacharacter and is refused.

/** BRE metacharacters whose presence can make a pattern NEVER match its literal
 *  text — the silent-false-FAIL class. Blocking; measured retrofit 0. */
const BRE_BLOCKING_METACHARS: ReadonlyArray<string> = ["[", "*", "^", "$"];

/** BRE metacharacters that do NOT silently strand a proof under the executor's own
 *  matcher, so they warn rather than block.
 *
 *  `.` only WIDENS a match: the proof still finds its own text (blocking it would
 *  strand the 4 tasks that use it).
 *
 *  `?` is the OPPOSITE shape and is here for a different reason. It is LITERAL in a
 *  BRE and a QUANTIFIER in an ERE, and the executor's argv is `grep -arn --` with no
 *  `-E`, so a bare `?` genuinely works TODAY — blocking it would refuse patterns that
 *  match. What it is not is portable: read by any ERE-defaulting grep the same pattern
 *  finds nothing and reports a clean zero. Measured on `logUnavailable?: Cause`, BRE
 *  matched and ERE missed. See {@link SINGLE_LITERAL_CLASS_CHARS} for why the remedy
 *  is `[?]` and never `\?`. */
const BRE_WARNING_METACHARS: ReadonlyArray<string> = [".", "?"];

/** Characters for which `[X]` — a bracket holding exactly this one character and
 *  nothing else — is the SANCTIONED literal escape, exempt from `[`'s blocking rule.
 *
 *  WHY THE EXEMPTION EXISTS. Without it this linter forbids the only portable remedy
 *  for the very fragility it warns about: `[?]` tripped `[`'s block while the bare `?`
 *  it replaces passed clean, so the rule pushed authors toward the fragile form. The
 *  #1071 precedent (`[call-site]` read as a character class) is a DIFFERENT shape —
 *  several characters forming a real class — and stays blocked, because nothing about
 *  it is unambiguously a literal.
 *
 *  AND `\X` IS NOT AN ALTERNATIVE for the character that motivated this. `\?` is a
 *  quantifier in GNU BRE and a literal in an ERE — exactly inverted from bare `?` — so
 *  the obvious escape moves the failure rather than removing it. Only the bracket form
 *  is literal under both.
 *
 *  MEASURED, not assumed: every member below matched its literal text under BOTH
 *  `grep` and `grep -E` and matched nothing when the character was absent. `^` is
 *  DELIBERATELY EXCLUDED — `[^]` opens a NEGATED class rather than closing a literal
 *  one, and both engines error on it. */
const SINGLE_LITERAL_CLASS_CHARS: ReadonlyArray<string> = ["?", ".", "*", "+", "$", "(", ")", "{", "}", "|", "[", "]"];

/** The remedy sentence for each warning-tier metacharacter — the character's OWN fix,
 *  never a generic one, because `.` and `?` fail in opposite directions and a shared
 *  sentence would have to be vague enough to help with neither. */
const BRE_WARNING_REMEDY: Readonly<Record<string, string>> = {
  ".": "matches ANY character in a BRE — the proof still finds its own text but would also match text you did not intend. Escape it (\\.) to mean a literal dot.",
  "?": "is LITERAL under the executor's own `grep -arn` (a BRE) but a QUANTIFIER under an ERE, so this pattern matches today and silently finds NOTHING under any grep that defaults to ERE — a clean zero, not an error. Write `[?]`, which is literal under both. Do NOT write `\\?`: that INVERTS the failure (a quantifier in GNU BRE, a literal in an ERE) and breaks the engine that works today.",
};

/** Characters that become a BRE construct when a backslash precedes them —
 *  grouping, intervals, and GNU's optional-quantifier. `\.`-style escapes are NOT
 *  here: those are literals.
 *
 *  MEASURED on GNU grep 3.11 against a file holding `ab` and `a?b`, the same
 *  discipline {@link SINGLE_LITERAL_CLASS_CHARS} states for its own membership:
 *  BRE `a\?b` hits BOTH lines (2) — it is a QUANTIFIER, not an escaped literal —
 *  while BRE `a?b`, BRE `a[?]b` and ERE `a[?]b` each hit one. So the escape an
 *  author reaches for to make `?` literal is precisely the form that stops being
 *  literal, and it scored CLEAN here until this entry existed.
 *
 *  `?` IS ENGINE-DEPENDENT IN A WAY THE OTHER FOUR ARE NOT, and that is recorded
 *  rather than smoothed over: `\(`, `\)`, `\{` and `\}` are POSIX BRE constructs
 *  everywhere, whereas `\?` is a GNU extension. Only GNU grep was available to
 *  measure from — ugrep and BSD grep are both absent in the container this was
 *  derived in — so an implementation without the extension would read `\?` as a
 *  literal `?`. Blocking is still the right call in that case: an author who wants
 *  a literal `?` has `[?]`, which measured as literal under BOTH engines above, so
 *  the blocked form is one nobody needs on either.
 *
 *  RETROFIT, measured before this became blocking: ZERO `grep:` proofs across the
 *  whole plan carried `\?`, against a control of seven that carry some other
 *  backslash — so no existing proof newly fails. This entry is preventive. */
const BRE_CONSTRUCT_AFTER_BACKSLASH: ReadonlyArray<string> = ["(", ")", "{", "}", "?"];

/**
 * The unescaped BRE metacharacters in `pattern`, split by severity. Walks the
 * string rather than regex-matching it, because the one thing that must be
 * exactly right here is which characters an escape consumes — and expressing
 * that as a regex over a regex is how this class of bug is born.
 */
export function breMetacharsIn(pattern: string): { blocking: string[]; warning: string[] } {
  const blocking: string[] = [];
  const warning: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        blocking.push("\\"); // a dangling escape is undefined behaviour across implementations
        break;
      }
      if (BRE_CONSTRUCT_AFTER_BACKSLASH.includes(next)) blocking.push("\\" + next);
      i++; // the escape consumes its next char — `\.` is a LITERAL dot, legitimate
      continue;
    }
    // `[X]` — one metacharacter, immediately closed — is the SANCTIONED literal form
    // (see SINGLE_LITERAL_CLASS_CHARS). Consume all three characters so the bracket does
    // not block AND the character inside is not separately scored: `[?]` must be silent,
    // not a warning about the very `?` it exists to escape. Anything else starting with
    // `[` falls through to the blocking arm exactly as before — `[call-site]` included.
    if (ch === "[" && pattern[i + 2] === "]" && SINGLE_LITERAL_CLASS_CHARS.includes(pattern[i + 1] ?? "")) {
      i += 2;
      continue;
    }
    if (BRE_BLOCKING_METACHARS.includes(ch)) blocking.push(ch);
    else if (BRE_WARNING_METACHARS.includes(ch)) warning.push(ch);
  }
  return { blocking: [...new Set(blocking)], warning: [...new Set(warning)] };
}

/** Every criterion whose `grep:` proof carries an unescaped BRE metacharacter. */
export function proofGrepSafetyViolations(task: Task): LintViolation[] {
  const violations: LintViolation[] = [];
  for (const [i, c] of (task.acceptance ?? []).entries()) {
    const proof = typeof c.proof === "string" ? c.proof : "";
    const m = proof.trim().match(/^grep:\s*([\s\S]*)$/i);
    if (!m) continue;
    // Same split parseDialectGrep uses: an " in " followed by a PATH-LIKE trailing token.
    // NO FALLBACK TO THE WHOLE BODY. A path-less `grep:` is REFUSED outright by parseDialectGrep
    // (review.ts), so it never executes and has no pattern to be unsafe — treating its prose as a
    // pattern warned about a dot in text nobody will ever grep. Measured: that fallback produced
    // 2 spurious warnings (W1-T66, W1-T90) on proofs the real parser rejects, both of which
    // proof-dialect already flags for the actual defect. This check polices only proofs that RUN.
    const split = m[1].match(/^([\s\S]*?)\s+in\s+(\S*[./]\S*)\s*$/i);
    if (!split) continue;
    const pattern = split[1].trim();
    if (!pattern) continue;
    const { blocking, warning } = breMetacharsIn(pattern);
    const where = `criterion ${i + 1} ("${(c.claim ?? "").slice(0, 56)}")`;
    if (blocking.length) {
      violations.push({
        check: "proof-grep-safety",
        severity: "block",
        message:
          `${where} \`grep:\` pattern "${pattern.slice(0, 70)}" contains unescaped BRE ` +
          `metacharacter(s) ${blocking.map((x) => `\`${x}\``).join(", ")} — the executor runs ` +
          `\`grep -arn -- <pattern> <path>\`, a BASIC REGULAR EXPRESSION (BRE), so this may never ` +
          `match the literal text you mean (PR #1071: \`[call-site]\` was read as a character class). Escape it (\\${blocking[0]}) ` +
          `or reword the pattern. Verify with \`rmd check-proof\`, never with \`grep -F\` — that is a ` +
          `different matcher and reports a false green.`,
      });
    }
    // ONE VIOLATION PER DISTINCT CHARACTER, never one aggregate line: `.` and `?` fail in
    // OPPOSITE directions (one widens a match that still succeeds, the other succeeds here
    // and misses entirely under another engine), so a shared sentence could only be vague
    // enough to help with neither. A pattern carrying just one of them still yields exactly
    // one violation, which is the shape this check has always had.
    for (const ch of warning) {
      violations.push({
        check: "proof-grep-safety",
        severity: "warn",
        message:
          `${where} \`grep:\` pattern "${pattern.slice(0, 70)}" contains an unescaped \`${ch}\`, which ` +
          `${BRE_WARNING_REMEDY[ch] ?? "is a BRE metacharacter — escape it or reword the pattern."}`,
      });
    }
  }
  return violations;
}

// ── PROOF-GREP-UNMATCHABLE (W1-T1225 — a grep: pattern that can NEVER match) ─
//
// Nothing at filing time ever opens the file a `grep:` proof names, so a pattern that cannot match
// ANY single line of a file already on disk reads identically to a correct forward reference (the
// "not written yet" case CLAUDE.md protects). That indistinguishability is real for a HIT-COUNT
// check (zero is legitimately a forward reference — proof-name-resolution's own rule, below), but
// two subclasses are POSITIVE detections, not zeros: the phrase is present in the file but a line
// break falls inside it (grep is line-based and can never match, no matter how long the filer
// waits), or the phrase is present only under different capitalisation (grep has no case-fold by
// default). A genuine forward reference matches neither probe and stays silent.
//
// CONSUMES {@link classifyGrepZeroHit} (W1-T1224) instead of re-deriving line-seam / case-only
// detection here; that module is the SAME matcher `checkProofCommand` (run-task.ts) uses to
// explain a real zero-hit `grep:` run, so this filing-time check and that runtime diagnostic can
// never disagree about why a pattern misses.
//
// THE LINTER STAYS PURE. Like {@link proofNameResolutionViolations}'s `opts.resolveNameFilteredCandidates`
// and {@link callSiteViolations}'s `opts.moduleExists`, the file's own text arrives via an INJECTED
// reader on {@link LintOpts.readGrepProofFile} — no fs, no exec, in this module. Absent reader ⇒
// silent, exactly like every other injected-predicate check here.
//
// WARN, NEVER BLOCK, WITH NO SEVERITY OVERRIDE — the same posture {@link proofNameResolutionViolations}
// takes for the same reason (zero/mismatch is a heuristic about intent an author may deliberately
// want), plus one more: a warn that names the offending line is actionable; a block would refuse
// authoring a pattern this check cannot fully adjudicate (a pattern carrying a BRE metacharacter the
// display-only line locator below cannot always re-find, for instance).
//
// NOT folded into {@link lintTask}'s own aggregate, unlike every sibling injected-predicate check
// nearby — DELIBERATELY. Design (vi) (W1-T1225) scopes this check to ONE call site, the
// changed-tasks lint pass (`lintPlanCommand`'s `--base` branch, run-task.ts), and never a
// pre-dispatch guard, a whole-plan sweep, or the retro's plan-health pass — reading a `grep:`
// proof's named file is bounded by the diff there (a handful of files) and is NOT bounded anywhere
// `lintTask` is called generically. Gating solely on "reader absent ⇒ silent" would still be
// correct today (no other caller supplies one), but folding the push into `lintTask` would let any
// FUTURE caller light this check up by accident just by wiring the option — the exact "shipped
// dormant, wired later, by someone else" failure this task's own rationale (point 5) names.
// `lintPlanCommand` calls {@link proofGrepUnmatchableViolations} directly instead.

/** The (pattern, path) a {@link WhitelistedProof} of kind "grep" names, restricted to the DIALECT
 *  shape (`grep: pattern in path` — parseDialectGrep, review.ts) that always inserts the `--` argv
 *  separator ahead of `pattern`/`path` (`args: ["-arn", "--", pattern, path]`). Mirrors {@link
 *  proofScopePath}'s own discriminator exactly, for the same reason: the legacy fenced ``
 *  `grep -rn x y` `` shape carries no such separator and its pattern/path split is not reliably
 *  recoverable from `args` alone — silently out of scope here too, rather than guessed at. */
function proofGrepPatternAndPath(w: WhitelistedProof): { pattern: string; path: string } | undefined {
  if (w.kind !== "grep" || w.args[1] !== "--") return undefined;
  return { pattern: w.args[2], path: w.args[3] };
}

/** The 0-based RAW line index of the first line whose text contains `pattern` case-insensitively —
 *  what a "case-only" cause's own message quotes as "the file's own casing". A plain (non-regex)
 *  substring search: the WARN/SILENT decision already came from {@link classifyGrepZeroHit} (which
 *  matches through the same BRE-emulating regex `checkProofCommand` runs); this only locates, for a
 *  human, which physical line to show — and every pattern this repo's `grep:` proofs actually write
 *  is plain prose with no regex metacharacter (measured — see {@link proofGrepSafetyViolations}'s
 *  module comment above), so a literal search finds the identical line a regex search would. Returns
 *  `undefined` on the rare pattern a literal search cannot re-locate; the caller degrades to a
 *  message with no quoted line rather than guessing wrong. */
function firstLineIndexCaseInsensitive(lines: readonly string[], pattern: string): number | undefined {
  const needle = pattern.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) return i;
  }
  return undefined;
}

/** The 0-based RAW line span a "line-seam" cause's phrase straddles — located by walking `fileText`
 *  once and replicating the EXACT collapse `classifyGrepZeroHit`'s own `whitespaceNormalised` helper
 *  performs (a newline plus any run of the following indentation collapses to one space), so a
 *  literal (never regex) search over the resulting text lands on the same seam the classifier's BRE
 *  match already confirmed exists. Not a second implementation of the CAUSE decision — only of
 *  where to point a human at it. Returns `undefined` when a literal search cannot re-find the span
 *  (a pattern carrying a BRE metacharacter) or the match turns out to sit on one physical line
 *  (nothing to report as a seam) — the caller degrades to a message with no quoted lines. */
function wrappedLineSpan(fileText: string, pattern: string): { startLine: number; endLine: number } | undefined {
  let normalized = "";
  const lineOfChar: number[] = [];
  let line = 0;
  let i = 0;
  while (i < fileText.length) {
    const ch = fileText[i];
    if (ch === "\n") {
      normalized += " ";
      lineOfChar.push(line);
      line++;
      i++;
      while (i < fileText.length && (fileText[i] === " " || fileText[i] === "\t")) i++;
      continue;
    }
    normalized += ch;
    lineOfChar.push(line);
    i++;
  }
  const idx = normalized.indexOf(pattern);
  if (idx === -1) return undefined;
  const startLine = lineOfChar[idx];
  const endLine = lineOfChar[Math.min(idx + pattern.length - 1, lineOfChar.length - 1)];
  if (startLine === undefined || endLine === undefined || startLine === endLine) return undefined;
  return { startLine, endLine };
}

/** Every `grep:` proof whose named file ALREADY EXISTS on disk and whose pattern is a POSITIVE
 *  detection of unmatchability (design iii): {@link classifyGrepZeroHit} returns "line-seam" (the
 *  phrase IS in the file but a line break falls inside it) or "case-only" (the phrase is in the
 *  file only under different capitalisation) for it. Silent on every other case: the path is not
 *  on disk yet (`opts.readGrepProofFile` returns undefined — a legitimate forward reference), the
 *  phrase is absent from the file in every probed form ("absent" — also a legitimate forward
 *  reference), or the pattern already matches a real line today ("matched" — a proof that already
 *  matches main is `executed_stale`'s business, W1-T273, not re-judged by this check). WARN-only;
 *  see the module comment above for why there is no severity override. */
export function proofGrepUnmatchableViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  const readGrepProofFile = opts.readGrepProofFile;
  if (!readGrepProofFile) return [];
  const violations: LintViolation[] = [];
  (task.acceptance ?? []).forEach((c, i) => {
    if (c.satisfied_by) return; // Architect-only; no proof text to parse
    const whitelisted = parseWhitelistedProof(c.proof ?? "");
    if (!whitelisted) return; // does not parse — proof-dialect's concern, not this one
    const target = proofGrepPatternAndPath(whitelisted);
    if (!target) return; // not a dialect grep proof (see the helper's own doc comment)
    const fileText = readGrepProofFile(target.path);
    if (fileText === undefined) return; // not on disk yet — a legitimate forward reference
    const cause = classifyGrepZeroHit(target.pattern, fileText);
    if (cause !== "line-seam" && cause !== "case-only") return; // matched / absent: both silent
    const claimHead = (c.claim ?? "").slice(0, 60);
    const where = `criterion ${i + 1} ("${claimHead}")`;
    const patternHead = target.pattern.slice(0, 70);
    if (cause === "line-seam") {
      const lines = fileText.split("\n");
      const span = wrappedLineSpan(fileText, target.pattern);
      const quoted = span
        ? "\n" +
          Array.from({ length: span.endLine - span.startLine + 1 }, (_, k) => `    ${lines[span.startLine + k]}`).join(
            "\n",
          )
        : "";
      violations.push({
        check: "proof-grep-unmatchable",
        severity: "warn",
        message:
          `${where} \`grep:\` pattern "${patternHead}" IS present in ${target.path}, but a line break ` +
          "falls inside it — grep is line-based and this can NEVER match, no matter how long the work " +
          `is waited on.${quoted}\nAnchor the pattern on a phrase that fits entirely on one line.`,
      });
    } else {
      const lines = fileText.split("\n");
      const lineIdx = firstLineIndexCaseInsensitive(lines, target.pattern);
      const quoted = lineIdx !== undefined ? `\n    ${lines[lineIdx]}` : "";
      violations.push({
        check: "proof-grep-unmatchable",
        severity: "warn",
        message:
          `${where} \`grep:\` pattern "${patternHead}" IS present in ${target.path} only under ` +
          "DIFFERENT CAPITALISATION — grep has no case-fold by default and this can NEVER match as " +
          `written.${quoted}\nCopy the file's own capitalisation into the proof verbatim.`,
      });
    }
  });
  return violations;
}

// ── PROOF-ENGINE-DIVERGENCE (W1-T2294 — a `grep:` pattern whose meaning depends on the
//    regex engine, nothing declares which one ran) ───────────────────────────────────
//
// The house `grep:` DIALECT (parseDialectGrep, review.ts) always compiles to `["-arn", "--",
// pattern, path]` — no `-E` anywhere reachable, so BRE and only BRE, author-unselectable. That
// arm can never diverge and is not this check's business (flagging it would fail patterns —
// `mergeConflict?:` among them — that are CORRECT under the engine that always actually runs).
//
// The LEGACY fenced `` `grep ...` `` shape (parseWhitelistedProof's `GREP_FENCE_RE` branch,
// review.ts) tokenises everything after `grep` as the author's own argv verbatim — `-E` is
// reachable there, and nothing inspects it: `proofGrepSafetyViolations` above matches `^grep:`
// before it does anything, so a backticked proof never reaches `breMetacharsIn` at all. That
// arm is flagged here via {@link WhitelistedProof.authorSelectedArgv} (review.ts), which is set
// ONLY by that branch — never re-derived from `args` shape, which is not reliably recoverable
// (a single-flag legacy invocation like `` `grep -arn -- pat path` `` has the identical `args`
// shape as the dialect form's own compiled argv).
//
// BEHAVIOURAL, NOT LEXICAL (design Q2): a pattern that is syntactically valid under BOTH engines
// and MEANS DIFFERENT THINGS — `mergeConflict?: MergeConflictEvidence` is the measured case, 2
// hits under BRE and 0 under ERE against src/lib/sweep.ts — carries nothing in its own text that
// distinguishes it from an ordinary pattern; only running it both ways does. So this check
// compiles the pattern as BOTH a BRE and an ERE and counts matching lines each way; the two
// engines agreeing is the common case and draws no report, and disagreeing is the exact
// condition the task's own title names.
//
// `?` MUST NOT move from `BRE_WARNING_METACHARS` above — see that constant's own comment. Under
// the dialect form's fixed BRE, `?` is literal and the pattern is correct; this check never
// touches the dialect arm at all, so the two checks cannot contradict each other about the same
// proof.
//
// PURE, same discipline as {@link proofGrepUnmatchableViolations} just above: no fs, no exec —
// the target file's text arrives via the SAME injected `opts.readGrepProofFile` reader (one
// contract, two consumers of the same fact "what does this path's text look like today").

/** The 7 characters that are ordinary METACHARACTERS in a POSIX EXTENDED regular expression
 *  (quantifier/grouping/alternation) but LITERAL in a BASIC one unless escaped — the exact set
 *  `grep-zero-cause.ts`'s own `JS_METACHAR_LITERAL_IN_BRE` already tracks for the same reason,
 *  kept in sync only by both being the measured BRE/ERE difference, not by importing one from
 *  the other (this task's declared `files:` does not include grep-zero-cause.ts). `.`, `*`,
 *  `^`, `$`, `[`, `]` are NOT here because they mean the same thing in both engines and cannot
 *  be the source of a BRE/ERE divergence. */
const ERE_ONLY_METACHARS = new Set(["?", "+", "|", "(", ")", "{", "}"]);

/** Characters that OPEN a BRE construct (grouping/interval) when a backslash precedes them —
 *  the same {@link BRE_CONSTRUCT_AFTER_BACKSLASH} set above that `breMetacharsIn`'s
 *  classification already walks. (It read "two-character set" while that set held four;
 *  naming the set rather than counting it keeps the two from drifting again.) */
function breEmulatingSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        out += "\\\\";
        break;
      }
      out += BRE_CONSTRUCT_AFTER_BACKSLASH.includes(next) ? next : "\\" + next;
      i++; // the escape consumes its next char
      continue;
    }
    out += ERE_ONLY_METACHARS.has(ch) ? "\\" + ch : ch;
  }
  return out;
}

/** Longest translated regex source this check ever compiles — same bound `grep-zero-cause.ts`'s
 *  own `sanitizeRegExp` and `ledger-grep.ts`'s `sanitizeRegExp` use, for the identical reason: a
 *  pattern arrives as free-form proof text, not vetted input, and this module compiles it into
 *  an in-process backtracking `RegExp` with no timeout of its own. */
const MAX_ENGINE_PROBE_SOURCE_LENGTH = 200;

/** Compile `source` as a `RegExp`, declining (returning `undefined`) rather than guessing when
 *  it is too long, is ReDoS-shaped (the canonical nested-quantifier `(a+)+`/`(a*)*` trigger), or
 *  is not syntactically valid JS regex at all. */
function boundedRegExp(source: string, flags: string): RegExp | undefined {
  if (source.length > MAX_ENGINE_PROBE_SOURCE_LENGTH) return undefined;
  if (/\([^()]*[+*][^()]*\)[+*]/.test(source)) return undefined;
  try {
    return new RegExp(source, flags);
  } catch {
    return undefined;
  }
}

/** Count of lines in `fileText` the compiled pattern matches — the same unit `grep -n`'s hit
 *  count is (this task's rationale measures BRE/ERE divergence in exactly these terms). */
function lineHitCount(re: RegExp, fileText: string): number {
  let hits = 0;
  for (const line of fileText.split("\n")) if (re.test(line)) hits++;
  return hits;
}

/** The (pattern, path) a LEGACY fenced `grep:` proof's raw argv names — the flag(s) before the
 *  `--` separator (if any) are the author's own and irrelevant to WHAT is being searched; the
 *  first non-flag token is the pattern, the last is the target path. `undefined` when the argv
 *  does not carry at least a pattern and a path (e.g. `` `grep -c foo` `` with no target). */
function legacyGrepPatternAndPath(args: readonly string[]): { pattern: string; path: string } | undefined {
  const sepIdx = args.indexOf("--");
  const rest = sepIdx === -1 ? args.filter((a) => !a.startsWith("-")) : args.slice(sepIdx + 1);
  if (rest.length < 2) return undefined;
  return { pattern: rest[0], path: rest[rest.length - 1] };
}

/** Every LEGACY (author-argv) `grep:` proof whose pattern reads a DIFFERENT hit count under BRE
 *  than under ERE against its own named file — the condition the task title names: "a `grep:`
 *  proof pattern's meaning depends on a regex engine nothing declares". Silent whenever: no
 *  `opts.readGrepProofFile` reader (same "no predicate ⇒ no opinion" contract every injected
 *  check here uses), the proof is the house DIALECT form (never diverges, see the module
 *  comment), the named file is not on disk yet (a legitimate forward reference), either engine
 *  declines to compile the pattern, or both engines agree on the hit count (design: "a pattern
 *  that means the same thing under either engine draws no report"). WARN-only, matching {@link
 *  proofGrepUnmatchableViolations}'s own posture for the same reason: this is a heuristic about
 *  an author's intent (a proof pinned to one engine on purpose is not necessarily wrong) that
 *  names the disagreement for a human to judge, never a block. */
export function proofEngineDivergenceViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  const readGrepProofFile = opts.readGrepProofFile;
  if (!readGrepProofFile) return [];
  const violations: LintViolation[] = [];
  (task.acceptance ?? []).forEach((c, i) => {
    if (c.satisfied_by) return; // Architect-only; no proof text to parse
    const whitelisted = parseWhitelistedProof(c.proof ?? "");
    if (!whitelisted || whitelisted.kind !== "grep" || !whitelisted.authorSelectedArgv) return;
    const target = legacyGrepPatternAndPath(whitelisted.args);
    if (!target || target.path.includes("..")) return;
    const fileText = readGrepProofFile(target.path);
    if (fileText === undefined) return; // not on disk yet — a legitimate forward reference
    const bre = boundedRegExp(breEmulatingSource(target.pattern), "");
    const ere = boundedRegExp(target.pattern, "");
    if (!bre || !ere) return; // declines rather than guesses
    const breHits = lineHitCount(bre, fileText);
    const ereHits = lineHitCount(ere, fileText);
    if (breHits === ereHits) return; // same meaning under either engine — nothing to report
    const claimHead = (c.claim ?? "").slice(0, 60);
    const where = `criterion ${i + 1} ("${claimHead}")`;
    violations.push({
      check: "proof-engine-divergence",
      severity: "warn",
      message:
        `${where} \`grep\` proof pattern "${target.pattern.slice(0, 70)}" against ${target.path} ` +
        `reads ${breHits} hit(s) under a BASIC regular expression (grep's default) and ${ereHits} ` +
        `under an EXTENDED one (\`-E\`) — this proof's fenced \`` + "`grep ...`" + `\` form passes ` +
        "the author's own argv through, so the engine is whichever flags happen to be present " +
        "(unlike the house `grep:` dialect, which is always BRE and cannot diverge), and nothing " +
        "records which one actually ran when this proof was last judged pass. Rewrite it as the " +
        `house dialect (\`grep: ${target.pattern} in ${target.path}\`) — fixed BRE, no engine ` +
        "choice — or reword the pattern so it means the same thing under both.",
    });
  });
  return violations;
}

// ── PROOF-SCOPE (W1-T310 — a proof naming a path the task never declared) ───
//
// scopeGuardOutOfScopeFiles (run-task.ts) compares a branch's diff against the
// task's declared `files:` — EXACT Set membership, `declared.has(f)`, never a
// prefix or glob (read directly off that guard so this check can never
// disagree with it about what "in scope" means, design point 2). A proof
// naming a path outside that same declared set is therefore GUARANTEED to
// trip the guard once the work satisfying it is done — W1-T309's own
// postmortem: `files: [src/lib/status-board.ts]`, two of its three proofs
// named `test/status-blockers-live.test.ts`. ALL TWELVE tasks filed that day
// (W1-T298..W1-T309) carried the flaw and `lint-plan` passed every one of
// them — it validates proof SHAPE (proof-dialect) and RESOLVABILITY
// (proof-resolvability), never whether the artifact a proof names is inside
// the scope the SAME task declares.
//
// (W1-T2287) THE GUARD NO LONGER REFUSES, and the message below used to claim
// it does. W1-T309's own 106-turn / $4.36 postmortem WAS a refusal, at the
// time; the implement path's disposition since changed to push-and-flag:
// `scope_guard.overrun` is logged and the branch pushes anyway — "pushed and
// flagged rather than refused: the branch is the only evidence that separates
// a phantom revert from an under-declared files:, and a refusal reaped it"
// (run-task.ts's own ledger line at the `scopeGuardOutOfScopeFiles` call
// site). The consequence that IS real and IS a verdict, and that the old
// message never named: `judgeCriterion` (review.ts) grades a pure-path
// `unit test:` proof `not_yet_built` only when its path is a member of
// `ProofExecContext.forwardReferenceFiles`, built from (among other sources)
// this task's own declared `files:`. A path OUTSIDE `files:` can never take
// that carve-out, so if it is still absent when the PR is reviewed, the
// criterion grades `executed_fail` instead — overriding keyword coverage and
// failing the PR outright, not a refusal but a wrong verdict.
//
// REUSES parseWhitelistedProof (review.ts) — the SAME parse the reviewer's
// executor runs (design point 1) — so this check can never disagree with
// `rmd check-proof` about what a proof names. A proof that does not parse
// (free prose, a malformed dialect body — proof-dialect's concern) or that
// parses but names no path (a bare, name-filtered `unit test: <title>` —
// design point 4) is SILENT here: there is nothing to compare against
// `files:`.
//
// SEVERITY defaults to WARN, not block, and that is a measured call, not an
// oversight (design point 3: "recommend, with the count of existing tasks
// that would trip it, and let the operator rule"). Against the live plan at
// filing (338 tasks, 2026-08-03): 102 already carry this flaw. `lint-plan`
// runs CHANGED-TASKS-ONLY in CI, so a BLOCKING default would refuse merging
// any UNRELATED future edit to one of those 102 tasks until its `files:` is
// separately repaired. Worse, at the PRE-DISPATCH call site
// (`assertLintClean`) there is no severity override available to THIS task:
// this task's own declared `files:` is `[src/lib/task-linter.ts,
// test/lint-proof-scope.test.ts]` — adding one to run-task.ts's
// `preDispatchLint` object would itself be an out-of-declared-scope edit, the
// exact defect this check exists to catch. A BLOCKING default here would
// therefore immediately brick pre-dispatch (`blocked_illformed`) for those
// same 102 already-queued tasks the moment this merges, with no way for this
// PR to carve out the "legacy backlog must not brick overnight" exemption
// {@link proofResolvabilityViolations} and {@link proofDialectViolations}
// both used during their own rollout. `opts.proofScope` is the override knob
// — an operator can flip any call site (whole-plan, or just pre-dispatch, via
// a follow-up run-task.ts edit) to "block" with zero further engine changes,
// once the backlog is repaired or the risk is judged acceptable.
//
// (W1-T2287) ONE CONJUNCTION AUTO-ESCALATES TO "block" ANYWAY, measured at
// ZERO in the live plan today (see this task's own filing rationale): a
// mis-declared path that is ALSO absent at head AND whose task is
// `verify: auto` — the exact conjunction under which the grade above actually
// goes wrong, rather than merely looking untidy. `opts.moduleExists` (the SAME
// injected disk-existence predicate {@link callSiteViolations} already uses —
// this module stays pure, no fs of its own) answers "absent at head"; absent
// that predicate this check makes no attempt to escalate, exactly like every
// other injected-predicate check here — the plain "warn" default holds. A
// `verify: human` task never escalates regardless: `isDispatchEligible`
// (drain.ts) refuses it before the linter is ever consulted, so it can never
// reach the review that would grade it wrong. A path that EXISTS at head also
// never escalates: `judgeCriterion` never takes the forward-reference branch
// for an existing path, so the proof executes for real and is graded on its
// own merits — mis-declared but harmless, the 325-task `verify: auto`
// population an outright `block` default would otherwise have failed. An
// explicit `opts.proofScope` still wins outright over this computed value, in
// either direction — the operator override this module has always honoured.

/** The repo-relative path a {@link WhitelistedProof} names, or `undefined` when
 *  it names none. Mirrors exactly how {@link parseWhitelistedProof}'s own
 *  parseTestTarget/parseDialectGrep (review.ts) build `label`/`args`: a
 *  test-kind proof's `label` IS the literal path UNLESS `nameFiltered` (a bare
 *  test title, design point 4's silent case); a grep-kind proof's path is the
 *  token after the `--` separator every whitelisted grep shape inserts before
 *  its pattern (`args: ["-arn", "--", pattern, path]`) — a legacy fenced
 *  `` `grep -rn x y` `` proof (no dialect label, no `--` separator) names no
 *  path here either, silent rather than guessed at. */
function proofScopePath(w: WhitelistedProof): string | undefined {
  if (w.kind === "test") return w.nameFiltered ? undefined : w.label;
  return w.args[1] === "--" ? w.args[3] : undefined;
}

/** Every criterion whose proof names a path OUTSIDE the task's declared
 *  `files:` — a mismatch {@link scopeGuardOutOfScopeFiles} (run-task.ts) now
 *  PUSHES AND FLAGS rather than refuses, and that {@link judgeCriterion}
 *  (review.ts) can grade `executed_fail` instead of `not_yet_built` because
 *  the path is not in `files:` (W1-T2287 — see the module comment above).
 *  WARN by default, auto-escalated to "block" only when the path is also
 *  absent at head (per `opts.moduleExists`) and the task is `verify: auto`;
 *  see the module comment above for the measured count driving both. */
export function proofScopeViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  const declared = new Set(task.files ?? []);
  const dispatchable = task.verify === "auto";
  const violations: LintViolation[] = [];
  (task.acceptance ?? []).forEach((c, i) => {
    if (c.satisfied_by) return; // Architect-only; no proof text to parse
    const whitelisted = parseWhitelistedProof(c.proof ?? "");
    if (!whitelisted) return; // does not parse — proof-dialect's concern, not this one
    const path = proofScopePath(whitelisted);
    if (!path) return; // names no path (design point 4) — nothing to compare
    if (declared.has(path)) return; // inside the declared scope — silent
    // NO PREDICATE ⇒ NO ESCALATION (W1-T2287) — the same "no fs of its own" contract
    // {@link callSiteViolations}'s `opts.moduleExists` already keeps: absent the predicate this
    // stays the plain "warn" default rather than guessing at disk state.
    const absentAtHead = opts.moduleExists ? !opts.moduleExists(path) : false;
    const severity: LintSeverity = opts.proofScope ?? (absentAtHead && dispatchable ? "block" : "warn");
    const claimHead = (c.claim ?? "").slice(0, 60);
    violations.push({
      check: "proof-scope",
      severity,
      message:
        `criterion ${i + 1} ("${claimHead}") proof names "${path}", which is OUTSIDE this task's ` +
        `declared files: [${[...declared].join(", ")}]. The scope guard (run-task.ts's ` +
        "scopeGuardOutOfScopeFiles) does NOT refuse this — it pushes the branch and logs " +
        "scope_guard.overrun, flagged rather than blocked. The real consequence is graded, not " +
        `refused: judgeCriterion (review.ts) can only carve this proof out as not_yet_built when ` +
        `"${path}" is a member of this task's declared files: — since it is not, if "${path}" is ` +
        "still absent when this is reviewed, the criterion grades executed_fail instead, which " +
        `overrides keyword coverage and fails the PR. Add "${path}" to files: or rewrite the proof ` +
        "to name a path already in scope.",
    });
  });
  return violations;
}

// ── PROOF-NAME-RESOLUTION (W1-T488 — the literal-substring trap) ────────────
//
// A name-filtered `unit test: <title>` proof (parseTestTarget, review.ts) is NOT a regex against
// real test titles: `escapeRegExp` runs on the body FIRST, so `.` `(` `)` `[` `]` and every other
// regex metacharacter match only THEMSELVES. A title an author wrote with `.` standing in for a
// symbol resolves to ZERO real tests and reads `not_executable` — silently, with no error, and
// the criterion falls back to the keyword floor looking healthy. OBSERVED live (W1-T245/#651): 4
// of 5 proofs executed and the 5th used `.` for the parentheses in the test's own title.
//
// REUSES resolveNameFilteredCandidates (review.ts) — the SAME resolver `execWhitelistedProof`
// itself calls before ever spawning `node --test` — so this check can never disagree with the
// reviewer about what a proof's raw name resolves to (the same rule {@link proofScopeViolations}
// above already applies to proof-scope). NOT a reimplementation of that decision: `resolved` /
// `absent` / `unresolvable` are read verbatim off its return value.
//
// INJECTED, LIKE `opts.moduleExists` — resolveNameFilteredCandidates shells out to `grep` against
// a real checkout, and this module reads no disk (the same "no predicate ⇒ no opinion" contract
// {@link callSiteViolations} already uses). Absent `opts.resolveNameFilteredCandidates` this check
// is silent. NOT wired to any real call site by this task (`run-task.ts`'s pre-dispatch guard and
// `lintPlanCommand` are both outside this task's declared `files:`) — shipped here as a tested,
// directly callable function ready for that follow-up wiring, the same posture W1-T420's
// `learningDuplicateViolation` documents for its own out-of-scope gate.
//
// THE ZERO-MATCH WARN IS NARROWED, and that narrowing is a MEASURED call, not a guess (design
// point 3 required the measurement before shipping). A naive "WARN on every zero-resolution
// name-filtered proof" was run once against the live open queue (338 tasks, 2026-08-14): 251 of
// 319 open name-filtered proofs (78.7%) resolve to zero — almost all of them multi-clause SCENARIO
// NARRATIVES (`looksLikeScenarioNarrative`, defined above) that `proofDialectViolations` already
// warns about via a different signal, not the wildcard-confusion defect this check exists to
// name. Restricting to proofs that ALSO carry a regex metacharacter still left 145/319 (45.5%) —
// most of those narratives again, just ones that happen to contain a `.` or `(`. Restricting
// FURTHER to "contains a metacharacter AND does not read as a scenario narrative" — the same
// narrative guard {@link proofResolvabilityViolations} already exempts a single plausible test
// title from — cut it to 15/319 (4.7%), a high-precision set where the metacharacter is plausibly
// load-bearing punctuation inside an otherwise title-shaped body rather than narrative prose. That
// is the shape this check warns on. The MANY-match warn needed no such narrowing: it fired on
// 4/319 (1.25%) of the same corpus, so it is reported unconditionally.

/** Mirrors the exact character class `escapeRegExp` (review.ts, not exported) makes inert on a
 *  name-filtered proof's raw title — used only to NAME which of them a title contains, for the
 *  warning message. Detection only; the resolution decision itself never touches this and comes
 *  from {@link LintOpts.resolveNameFilteredCandidates} alone. */
const LITERAL_ONLY_METACHARS_RE = /[.*+?^${}()|[\]\\]/g;

/** The distinct regex metacharacters `rawName` contains, in first-seen order — what a
 *  name-filtered `unit test:` title would have meant as a wildcard/anchor/group/class had
 *  escaping not made it literal. Empty for the common case, a title with none of them. */
export function literalOnlyMetacharsIn(rawName: string): string[] {
  return [...new Set(rawName.match(LITERAL_ONLY_METACHARS_RE) ?? [])];
}

/** Every name-filtered `unit test:` proof whose raw title resolves to ZERO tests (narrowed to the
 *  high-precision case above) or into MANY different test files. WARN-only, unconditionally — no
 *  severity override, ever: zero is legitimately a forward reference to an unwritten test
 *  (CLAUDE.md), so this can never BLOCK without refusing correct authoring at scale (design point
 *  3). Silent absent `opts.resolveNameFilteredCandidates` (see the module comment above). */
export function proofNameResolutionViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  // The reviewer's OWN resolver, called directly — never a reimplementation, so lint and review can
  // never disagree about what a proof's raw name resolves to.
  const resolveNameFilteredCandidates = opts.resolveNameFilteredCandidates;
  if (!resolveNameFilteredCandidates) return [];
  const violations: LintViolation[] = [];
  (task.acceptance ?? []).forEach((c, i) => {
    if (c.satisfied_by) return; // Architect-only; no proof text to resolve
    const whitelisted = parseWhitelistedProof(c.proof ?? "");
    if (!whitelisted || whitelisted.kind !== "test" || !whitelisted.nameFiltered) return;
    const rawName = whitelisted.label;
    const resolution = resolveNameFilteredCandidates(rawName);
    const claimHead = (c.claim ?? "").slice(0, 60);
    const head = rawName.slice(0, 70) + (rawName.length > 70 ? "…" : "");
    if (resolution.status === "absent") {
      const metachars = literalOnlyMetacharsIn(rawName);
      if (!metachars.length) return; // not the high-precision case — see module comment
      if (looksLikeScenarioNarrative(rawName)) return; // proof-dialect already warns on this shape
      violations.push({
        check: "proof-name-resolution",
        severity: "warn",
        message:
          `criterion ${i + 1} ("${claimHead}") \`unit test:\` proof "${head}" resolves to ZERO tests today ` +
          `and contains ${metachars.map((m) => `\`${m}\``).join(", ")} — a regex would read ${metachars.length === 1 ? "that" : "those"} ` +
          `as a wildcard/anchor/group, but this dialect ESCAPES the body first and matches it as a LITERAL ` +
          `substring (parseTestTarget, src/lib/review.ts), so it matches only itself. If a real test is titled ` +
          "exactly this, copy its plain prose out of the title verbatim with no metacharacters, or switch to " +
          `the whole-file \`unit test: test/*.test.ts\` path form. If the test does not exist yet, this may be ` +
          "a legitimate forward reference (CLAUDE.md) — this is a WARN, never a BLOCK, for exactly that reason.",
      });
    } else if (resolution.status === "resolved" && resolution.files.length > 1) {
      violations.push({
        check: "proof-name-resolution",
        severity: "warn",
        message:
          `criterion ${i + 1} ("${claimHead}") \`unit test:\` proof "${head}" resolves into ` +
          `${resolution.files.length} DIFFERENT test files (${resolution.files.join(", ")}) — it executes, but ` +
          "the literal substring is not unique to one test, so the run certifies a wider set than the single " +
          "test the author likely meant to name. Narrow the title so it identifies one test uniquely, or " +
          "confirm the breadth is intended.",
      });
    }
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

/** Trim + collapse-whitespace normalized key for a criterion — keyed on the
 *  CLAIM ALONE (W1-T1098; was claim+proof, see W1-T1098's rationale). SET
 *  membership, not raw-list/positional equality, so reordering the
 *  `acceptance:` list or a pure formatting reflow never trips this check; a
 *  criterion whose claim text differs from every base-ref entry's claim
 *  counts as added-or-changed, regardless of what its proof says.
 *
 *  WHY CLAIM-ONLY: rule 21's own violation message names the harm it exists
 *  to prevent — a criterion that "would orphan silently" because MERGED is
 *  terminal and nothing re-queues the task. Rewording a proof orphans
 *  nothing: the CONTRACT the task promised (the claim) is unchanged, only
 *  how it is checked. Keying on claim+proof made a reworded proof on an
 *  already-merged task indistinguishable from a genuinely new criterion —
 *  `lint-plan` refused a proof rewrite with the same message it uses for an
 *  actual amendment, on a task nobody added a promise to.
 *
 *  WHAT THIS ALONE STOPS CATCHING (named, not hidden): a claim KEPT with its
 *  proof swapped for a WEAKER one — the discriminating `grep:` this task's own
 *  criterion once had, replaced by a whole-file `unit test:` that always
 *  passes — is invisible to THIS comparison, which is claim-only by design
 *  (see WHY CLAIM-ONLY above). `proof-dialect` and `proof-resolvability` (this
 *  file) and `executed_stale` (review.ts) each see PART of that gap — an
 *  unexecutable or non-discriminating proof — but none of them compares a NEW
 *  proof against the one it replaced. W1-T2254's {@link criteriaProofChanged},
 *  wired into {@link postMergeAmendmentViolations} as a REPORT (`severity:
 *  "warn"`, never a block — this function's own claim-added comparison stays
 *  exactly as documented above), is that comparison: a same-claim proof
 *  downgrade on an already-merged task is now named in the lint output, even
 *  though it still is not, and is not meant to be, blocked. */
function criterionKey(c: AcceptanceCriterion): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  return norm(c.claim ?? "");
}

/**
 * Criteria in `currentCriteria` whose claim does not appear anywhere in
 * `baseCriteria` — covers BOTH an outright ADDITION and a semantic CHANGE to
 * an existing criterion's claim (a changed claim is, by set membership, a
 * new one). A claim held constant while only its proof is reworded is NOT
 * an addition (see {@link criterionKey}). `baseCriteria` undefined (the task
 * did not exist at the base ref, or the caller could not resolve a base
 * version) yields no additions — nothing to diff against, so the check is a
 * no-op for that task.
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
 * that will actually be dispatched. Matched by {@link criterionKey} — claim
 * only, same as `criteriaAdded` — so the follow-up task's own proof wording
 * need not match verbatim. Vacuously true when `added` is empty (there
 * is nothing to carry). The caller supplies `candidateTasks` as the OTHER tasks
 * newly introduced by the same changed set — this function does no scoping of
 * its own.
 */
export function followUpCarriesCriteria(added: AcceptanceCriterion[], candidateTasks: Task[]): boolean {
  if (added.length === 0) return true;
  // EVERY added criterion, not just one. The code here read `candidateTasks.some(t => t.acceptance
  // .some(...))` until 2026-08-26 -- at least ONE added criterion carried by at least one task --
  // while the doc above has always said "every criterion in `added`". The doc is what W1-T180 was
  // for: its own shard says the follow-up carries "the amended criteria", plural, and the whole
  // purpose is that the criteria have a home that will actually be dispatched. One carried
  // criterion gives the other four no home, so a PR could add five criteria to a MERGED task, carry
  // one, and pass -- the exact orphaning Rule 21 exists to stop, reached through its own escape.
  //
  // NOTHING WRITTEN ANYWHERE CHOSE `some`: the introducing commit (bd59a51d, W1-T180, #928) says
  // nothing about the quantifier, and the shard argues the other way.
  //
  // RETROFIT, MEASURED BEFORE THE CHANGE over all 823 plan commits: 93 criteria amendments, 4 with
  // a new task in the same PR, 34 adding more than one criterion, and exactly 1 that is both --
  // `1dd397fc` (#396) adding two to W1-T136 beside a new W1-T176, which carried NEITHER, so it
  // fails `some` AND `every` and was never permitted by the looseness. The only amendment where
  // this escape has ever actually fired is `13a73d57` (W1-T2327/W1-T2340), which carries its one
  // added criterion and passes under both readings. TIGHTENING REFUSES NOTHING THAT HAS EVER
  // HAPPENED.
  const carried = new Set(candidateTasks.flatMap((t) => (t.acceptance ?? []).map(criterionKey)));
  return added.every((c) => carried.has(criterionKey(c)));
}

/**
 * IDs of `candidateTasks` that carry at least one of `added`'s criteria — a
 * REPORTING helper, not a gate: {@link followUpCarriesCriteria} already decided
 * whether the escape is available (every criterion carried, by SOME task or
 * another); this just names WHICH task(s) so a violation message naming the
 * follow-up alongside the parent (see {@link postMergeAmendmentViolations}) is
 * never forced to say "a follow-up task" with no id attached.
 */
function followUpTaskIdsCarrying(added: AcceptanceCriterion[], candidateTasks: Task[]): string[] {
  const addedKeys = new Set(added.map(criterionKey));
  return candidateTasks.filter((t) => (t.acceptance ?? []).some((c) => addedKeys.has(criterionKey(c)))).map((t) => t.id);
}

/**
 * W1-T2375 (Rule 21's own escape, closed): TRUE iff `task` (the head-ref
 * shard — the SAME object {@link postMergeAmendmentViolations} lints) has
 * itself declared a disposition for the amendment the follow-up escape just
 * let through. Two shapes, per that task's design (Q2), and ONLY these two:
 *
 *  - FULLY SUPERSEDED: `task.status === "blocked"` in THIS PR — the exact
 *    property `isDispatchEligible` (lib/drain.ts) reads, never the
 *    `retirement:` field beside it (W1-T2375 rationale (3): a parent that
 *    carried `retirement:` and nothing else was dispatched anyway, because
 *    `drain.ts` never reads that field).
 *  - PARTLY SUPERSEDED: the parent's own prose (`note` or `rationale`)
 *    changed from `baseTask` to `task` — the filer said SOMETHING about what
 *    remains. This check cannot and does not judge whether the prose is any
 *    good; it only refuses SILENCE (no status move AND no prose change),
 *    exactly as that task's design says: "It does not decide which
 *    disposition is right; it refuses silence."
 *
 * `baseTask` undefined ⇒ nothing to diff the prose against, so this check
 * defers — same "nothing to diff against" contract every other base-ref
 * comparison in this section uses ({@link criteriaAdded}, {@link
 * mergedFieldChangeViolations}) — rather than refusing on a resolution gap
 * that is not the filer's doing.
 */
export function parentDispositionStated(task: Task, baseTask: Task | undefined): boolean {
  if (task.status === "blocked") return true;
  if (!baseTask) return true;
  const norm = (s?: string) => (s ?? "").trim();
  return norm(baseTask.note) !== norm(task.note) || norm(baseTask.rationale) !== norm(task.rationale);
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
  /** The SAME candidate array the caller already built to compute
   *  `followUpFiled` (`followUpCarriesCriteria`'s second argument) — carried
   *  here too, not re-resolved, purely so a W1-T2375 violation naming the
   *  parent's unaddressed dispatchability can also name the follow-up task(s)
   *  that already carry the criteria (see {@link followUpTaskIdsCarrying}).
   *  Undefined/empty ⇒ the message falls back to generic wording; it never
   *  affects whether the check fires. */
  followUpTasks?: Task[];
  /** This task's WHOLE shard as it existed at the PR's base ref — not just its
   *  `acceptance:` (see {@link baseAcceptance}). W1-T2254: the call site
   *  (run-task.ts's `lintPlanCommand`) already resolves this base-ref task to
   *  read `baseAcceptance` off it, so widening the context to carry the whole
   *  object needs no new resolution, git read, or base-ref lookup — see that
   *  check's own module comment for why only `acceptance` was wired at first.
   *  Undefined under the same conditions as {@link baseAcceptance}. */
  baseTask?: Task;
}

/** Fields on a merged task's shard that something ELSE in the system still reads
 *  AFTER the task merges (W1-T2254 rationale §Q1 (ii)) — a post-merge edit here
 *  silently changes live behaviour nobody signed off on: `status` feeds dispatch
 *  eligibility (drain.ts's `t.status === "blocked"` branch), `files` feeds
 *  W1-T171's overlap serialization (`partitionByFileOverlap`), `depends_on` feeds
 *  the DAG, `priority` feeds the dispatch comparator, `risk`/`verify`/`type`/
 *  `principles`/`budget_usd` each steer a lane/gate/spend cap, and `retirement`
 *  feeds the board's bucketing.
 *
 *  DELIBERATELY EXCLUDED, NAMED RATHER THAN LEFT IMPLICIT (§Q1 (iii)): `title`,
 *  `note` and `rationale` are prose an amendment is EXPECTED to touch — reporting
 *  them would fire on every legitimate rationale edit and get muted within a
 *  week. `hand_built` has exactly two mentions in `src/` (both in plan.ts, the
 *  interface declaration and the loader's own copy) and zero consumers — a field
 *  nothing reads cannot be poisoned, and reporting it would be pure noise. `id`,
 *  `repo`, `attempts`, `pr`, `prompt` and `context` are likewise left unreported:
 *  none of them has a documented post-merge consumer the way the ten below do.
 *
 *  The question a field must answer to be listed here is "does anything read
 *  this after the task merges", never "is this field conceptually final" — see
 *  §Q1 (iv). */
const REPORTED_MERGED_FIELDS: readonly (keyof Task)[] = [
  "status",
  "files",
  "depends_on",
  "priority",
  "risk",
  "verify",
  "type",
  "principles",
  "budget_usd",
  "retirement",
];

/** Human-readable rendering of a reported field's value for a violation message
 *  — never used to compare, only to display both sides once a change is already
 *  detected via `JSON.stringify` equality (below). */
function reportedFieldDisplay(v: unknown): string {
  if (v === undefined) return "(absent)";
  if (typeof v === "string") return JSON.stringify(v);
  return JSON.stringify(v);
}

/** Every {@link REPORTED_MERGED_FIELDS} entry whose value differs between
 *  `baseTask` and `task` — REPORT ONLY, `severity: "warn"`, never `"block"`:
 *  W1-T2248 already ruled that a merged `files:` can be provably wrong and must
 *  stay correctable, and this task's own design (§Q2) reconciles with that
 *  ruling by building a DETECTOR, not a lock — a field changing is made a
 *  declared, visible act, never forbidden. `baseTask` undefined (the task is new
 *  in this PR, or the caller could not resolve a base version) ⇒ no violations,
 *  same "nothing to diff against" contract {@link criteriaAdded} uses for
 *  `baseAcceptance`. */
export function mergedFieldChangeViolations(task: Task, baseTask: Task | undefined): LintViolation[] {
  if (!baseTask) return [];
  const violations: LintViolation[] = [];
  for (const field of REPORTED_MERGED_FIELDS) {
    const before = baseTask[field];
    const after = task[field];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    violations.push({
      check: "post-merge-field-drift",
      severity: "warn",
      message:
        `task ${task.id} is already MERGED, but this PR changes \`${String(field)}:\` from ` +
        `${reportedFieldDisplay(before)} to ${reportedFieldDisplay(after)} — reported, not blocked ` +
        "(a merged shard's declared fields can still be corrected, W1-T2248; this makes the " +
        "correction a declared, visible act instead of a silent one).",
    });
  }
  return violations;
}

/** Criteria in `baseCriteria` whose claim does not appear anywhere in
 *  `currentCriteria` — the mirror image of {@link criteriaAdded}: a merged
 *  criterion REMOVED outright rather than reworded or added-to. `criteriaAdded`
 *  alone cannot see this (W1-T2254 rationale §(4)): removing an entry shrinks
 *  the current set, so nothing in it fails to match a base key, and the check
 *  reads as "no delta". Keyed on {@link criterionKey} — claim only, same as
 *  every other comparison in this section. `baseCriteria` undefined ⇒ no
 *  removals (nothing to diff against). */
export function criteriaRemoved(
  baseCriteria: AcceptanceCriterion[] | undefined,
  currentCriteria: AcceptanceCriterion[],
): AcceptanceCriterion[] {
  if (!baseCriteria) return [];
  const currentKeys = new Set(currentCriteria.map(criterionKey));
  return baseCriteria.filter((c) => !currentKeys.has(criterionKey(c)));
}

/** Criteria present in BOTH `baseCriteria` and `currentCriteria` under the same
 *  {@link criterionKey} (claim unchanged) whose `proof` text differs — the exact
 *  gap `criterionKey`'s own doc comment names as unstopped: a claim kept with
 *  its proof swapped for a WEAKER one is invisible to `criteriaAdded`, which
 *  compares claims and never proofs. `baseCriteria` undefined ⇒ nothing to
 *  compare. */
export function criteriaProofChanged(
  baseCriteria: AcceptanceCriterion[] | undefined,
  currentCriteria: AcceptanceCriterion[],
): Array<{ base: AcceptanceCriterion; current: AcceptanceCriterion }> {
  if (!baseCriteria) return [];
  const baseByKey = new Map(baseCriteria.map((c) => [criterionKey(c), c]));
  const normProof = (p?: string) => (p ?? "").trim();
  const changed: Array<{ base: AcceptanceCriterion; current: AcceptanceCriterion }> = [];
  for (const c of currentCriteria) {
    const base = baseByKey.get(criterionKey(c));
    if (!base) continue; // no matching base claim — new/added, criteriaAdded's territory
    if (normProof(base.proof) !== normProof(c.proof)) changed.push({ base, current: c });
  }
  return changed;
}

/** Every acceptance criterion this PR adds or changes on an ALREADY-MERGED
 *  task, absent a follow-up task in the same PR to carry it — OR, W1-T2375,
 *  absent a stated disposition for the PARENT once a follow-up DOES carry it.
 *  No {@link LintOpts.postMergeAmendment} at all ⇒ this check is skipped
 *  entirely (the pre-dispatch call site never dispatches a merged task in the
 *  first place, so it never supplies this context).
 *
 *  W1-T2375: the follow-up escape (below) gives the amended criteria a SECOND
 *  home without ever asking about the FIRST — nothing required the parent's
 *  own dispatchability to be addressed, so a filed follow-up and an untouched
 *  parent both stayed dispatchable and the fleet built both. This is a
 *  CONDITION ON THE SAME ESCAPE, not a second blocking arm: `check:
 *  "post-merge-amendment"` is still the only blocking check this function
 *  emits ({@link parentDispositionStated} decides which of the two blocking
 *  messages below fires, never a third). The escape now requires BOTH that a
 *  follow-up carries the criteria AND that the parent itself has stated a
 *  disposition ({@link parentDispositionStated}) — moved to `status:
 *  "blocked"` (fully superseded) or said in its own prose what remains
 *  (partly superseded). It refuses only SILENCE: it never picks a
 *  disposition, never writes one, and an amendment with no follow-up filed
 *  at all is completely unaffected (the first branch below, byte-identical
 *  to before W1-T2375).
 *
 *  W1-T2254 widens this past the one BLOCKING case (a genuinely new/changed
 *  claim with no follow-up): three REPORT-ONLY, `severity: "warn"` checks run
 *  under the same three early exits (no context / unresolvable status / not
 *  merged) but are NOT gated by `followUpFiled` — that escape hatch is specific
 *  to the criteria-orphaning harm the BLOCK exists to prevent, and a warning
 *  never blocks a merge regardless, so there is nothing for it to escape. See
 *  {@link mergedFieldChangeViolations}, {@link criteriaRemoved} and {@link
 *  criteriaProofChanged} for what each reports and why it stays a report. */
export function postMergeAmendmentViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  const ctx = opts.postMergeAmendment;
  if (!ctx) return [];
  if (!ctx.statusResolvable) return []; // fail OPEN on an unreadable derived status
  if (!ctx.merged) return []; // only a merged task's criteria can orphan this way
  const currentCriteria = task.acceptance ?? [];
  const violations: LintViolation[] = [];
  const added = criteriaAdded(ctx.baseAcceptance, currentCriteria);
  if (added.length > 0 && !ctx.followUpFiled) {
    violations.push(
      ...added.map((c) => ({
        check: "post-merge-amendment" as const,
        severity: "block" as const,
        message:
          `task ${task.id} is already MERGED, but this PR adds/changes acceptance criterion ` +
          `("${(c.claim ?? "").slice(0, 80)}") with no follow-up task carrying it filed in the same PR — ` +
          "Standing rule 21: MERGED is terminal (an amendment does not re-queue the task), the drain " +
          "skips a merged id outright, and the retro sweep skips a closed one, so this criterion would " +
          "orphan silently; file a follow-up task carrying it in this SAME PR",
      })),
    );
  } else if (added.length > 0 && ctx.followUpFiled && !parentDispositionStated(task, ctx.baseTask)) {
    // W1-T2375: the escape's SECOND condition. The follow-up already carries every added
    // criterion (`ctx.followUpFiled`), so the FIRST branch above does not fire — but nothing
    // has yet said whether ${task.id} itself is still meant to be dispatched, so both a filed
    // follow-up AND an untouched parent stay eligible and the fleet can build both.
    const followUpIds = followUpTaskIdsCarrying(added, ctx.followUpTasks ?? []);
    const followUpNames = followUpIds.length > 0 ? followUpIds.join(", ") : "the follow-up task";
    violations.push(
      ...added.map((c) => ({
        check: "post-merge-amendment" as const,
        severity: "block" as const,
        message:
          `task ${task.id} is already MERGED, but this PR adds/changes acceptance criterion ` +
          `("${(c.claim ?? "").slice(0, 80)}") whose follow-up (${followUpNames}) already carries it, ` +
          `while ${task.id} itself is left with no stated disposition — Standing rule 21's follow-up ` +
          "escape hands the criteria a second home but never asks about the first, so both stay " +
          `dispatchable unless ${task.id} says otherwise IN THIS SAME PR: either move ${task.id}'s ` +
          "status: to \"blocked\" (fully superseded by the follow-up) or say in its own note/rationale " +
          "what work remains (partly superseded) — silence is what this refuses, not either answer",
      })),
    );
  }
  // W1-T2254: report-only widening past the single guarded field (`acceptance`'s claims).
  // Never blocks — see this function's own doc comment for why `followUpFiled` does not gate
  // these. Nothing here rewrites a field back to its base value; it only names the drift.
  violations.push(...mergedFieldChangeViolations(task, ctx.baseTask));
  violations.push(
    ...criteriaRemoved(ctx.baseAcceptance, currentCriteria).map((c) => ({
      check: "post-merge-criterion-removed" as const,
      severity: "warn" as const,
      message:
        `task ${task.id} is already MERGED, but this PR removes acceptance criterion ` +
        `("${(c.claim ?? "").slice(0, 80)}") that existed at the base ref — reported rather than ` +
        "passing as no delta, since a removed criterion is invisible to the claim-added check above.",
    })),
  );
  violations.push(
    ...criteriaProofChanged(ctx.baseAcceptance, currentCriteria).map(({ base, current }) => ({
      check: "post-merge-proof-changed" as const,
      severity: "warn" as const,
      message:
        `task ${task.id} is already MERGED, but this PR rewrites the proof of acceptance criterion ` +
        `("${(current.claim ?? "").slice(0, 80)}") from ${JSON.stringify(base.proof ?? "")} to ` +
        `${JSON.stringify(current.proof ?? "")} — the claim is unchanged, so this is invisible to ` +
        "the claim-added check above, but the executable half of the criterion moved and that is " +
        "reported here.",
    })),
  );
  return violations;
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

// ── RULING-VERIFY (W1-T326 — a ruling needs an operator, not a grep) ────────
//
// W1-T326's own shard set verify:auto with the note "the whole deliverable is
// text at known paths, so grep proofs execute against it directly and no
// operator need be present to judge them" — on a task whose SAME note says
// risk:high because "this writes a BINDING RULING on dispatch architecture."
// The proofs verified the ruling was WRITTEN, not that anyone RATIFIED it:
// #1302 merged in ten minutes and the operator overrode it in twenty-three
// more (#1303). isDispatchEligible (drain.ts) already refuses to dispatch any
// task whose `verify !== "auto"` — that enforcement lever is free and
// pre-existing; a ruling-shaped task at verify:human simply PARKS until the
// operator looks, which is the entire point. What was missing is only the
// rule that puts it there.
//
// TRIGGER A ONLY — `files:` contains "DECISIONS.md" (an exact entry, the
// literal repo-relative path this repo's single decision log lives at, per
// {@link isDataArtifact}'s own root-relative convention). A task whose
// declared write surface includes the decision log is ruling-shaped by
// construction, and A ALONE would have caught W1-T326 (its shard's `files:`
// named exactly this path). A mixed diff — other files alongside
// DECISIONS.md — still triggers: that is how the entry rides in unnoticed.
//
// TRIGGER B (a ruling-shaped TITLE, e.g. a bare `\bruling\b` word match) is
// the design's proposed belt for a ruling landing in some OTHER file (a
// MASTER-PLAN "ruling" section, a docs/ decision record) — DELIBERATELY NOT
// SHIPPED. Measured against the very task that files this check: W1-T353's
// own title reads "...deliverable is a RULING... a ruling-shaped task..." —
// describing the INCIDENT and the CHECK, not claiming its own diff (files:
// [src/lib/task-linter.ts, test/task-linter.test.ts], no DECISIONS.md) is a
// ruling — so a bare word match would misfire on the task introducing it, the
// same self-reference failure mode the headless-fitness lexicon special-cases
// for W1-T20c (see {@link HEADLESS_FORBIDDEN_LEXICON}'s FALSE POSITIVE #2
// above). No enumeration/quote-span exemption of that kind applies here (the
// title is one unquoted YAML string), so B cannot be stated precisely without
// either false-positiving on this task or growing bespoke self-reference
// carve-outs the design never asked for. The design's own fallback governs
// exactly this case: "if B proves too fuzzy to state without false positives,
// ship A alone and say so in the report" — done here.

/** The exact repo-relative path this repo's single decision log lives at —
 *  the literal `files:` entry {@link rulingVerifyViolation} looks for. */
const DECISIONS_LOG_PATH = "DECISIONS.md";

/** A task whose `files:` includes the decision log but is not verify:human —
 *  W1-T326's exact shape. TRIGGER A only; see the module comment above for
 *  why the title-word trigger B is deliberately not shipped. */
export function rulingVerifyViolation(task: Task): LintViolation | undefined {
  if (task.verify === "human") return undefined;
  if (!(task.files ?? []).includes(DECISIONS_LOG_PATH)) return undefined;
  return {
    check: "ruling-verify",
    severity: "block",
    message:
      `task ${task.id} declares files: including ${DECISIONS_LOG_PATH} at verify:${task.verify} — ` +
      "a ruling-shaped task must be verify: human — the operator judges rulings; isDispatchEligible " +
      "parks it until then.",
  };
}

// ── DECLARED SCOPE (W1-T504 — an undeclared files: lints clean and then serializes the fleet) ─
//
// 80 of 530 tasks carry an absent or empty `files:`, 13 of them minted unattended by triage.
// The linter never checked this: `overlappingPaths` (dispatch-overlap.ts) is fail-closed on an
// undeclared scope — it reports such a task as overlapping EVERY co-dispatched candidate — and
// `undeclaredScopeLast` (drain.ts, W1-T476) only demotes it to the end of its priority tier.
// Demotion is not containment: a demoted total-blocker that becomes the only eligible candidate
// still serializes everything behind it. This check closes that gap at the choke point that
// already exists — `assertLintClean` inside `runTask` refuses a task before any probe or spawn —
// by making a missing or empty `files:` a BLOCKING violation, the same severity shape
// {@link rulingVerifyViolation} established (a structural trigger, enforced by the linter,
// parked by the dispatcher). No dispatcher-side change is needed or made: a default-block check
// already reaches dispatch through `assertLintClean`, so teaching `isDispatchEligible` the same
// refusal would only duplicate it.
//
// THE PREDICATE IS `undeclaredScopeLast`'s OWN (`t.files === undefined || t.files.length === 0`),
// restated here rather than imported — drain.ts keeps no new dependency on this module, and the
// two can be pinned against each other by test rather than by coupling.
//
// W1-T1030 — DISPATCHER-UNREACHABLE EXEMPTION. The rule above is sound but its rationale is
// entirely about `overlappingPaths` at DISPATCH: `isDispatchEligible` (drain.ts) refuses at
// `t.verify !== "auto"` BEFORE any path is read, so a task that is not `verify: auto` never
// reaches `overlappingPaths` and cannot serialise the lane by an undeclared scope. Gating on
// `verify: human` rather than `type: manual` because `verify` is the exact field
// `isDispatchEligible` checks — `type: manual` is today a strict subset of it (see W1-T1030's
// rationale) but is a proxy that a future `type: manual, verify: auto` record would break. The
// 71 `implement/auto` records with no `files:` are untouched: this exemption checks `verify`,
// not `type`, so they still hit the `block` below exactly as before. The exemption is also
// SELF-LAPSING: it re-reads `task.verify` on every call, so the moment a task's record is
// re-banded to `verify: auto` (the sanctioned `deriveStatus` channel), the very next lint run
// — the changed-tasks CI pass that re-lints any touched record — sees `verify !== "human"` and
// the block re-applies with no separate bookkeeping.

/** A task whose `files:` is absent, or present and empty — W1-T504's exact shape. The predicate
 *  is `undeclaredScopeLast`'s own (drain.ts, W1-T476), restated rather than imported so this
 *  module gains no new dependency. See the module comment above for why this is `block`, not
 *  `warn`, and why no dispatcher-side change accompanies it.
 *
 *  EXEMPT when `verify: human` (W1-T1030): such a task never reaches `isDispatchEligible`'s
 *  path-reading step, so the overlap hazard this check exists to prevent cannot occur for it.
 *  The exemption lapses the instant `verify` reads `auto` again — see the module comment. */
export function declaredScopeViolation(task: Task): LintViolation | undefined {
  if (!(task.files === undefined || task.files.length === 0)) return undefined;
  if (task.verify === "human") return undefined;
  return {
    check: "declared-scope",
    severity: "block",
    message:
      `task ${task.id} declares no files: (absent or empty) — an undeclared scope lints clean ` +
      "today and then overlaps every co-dispatched candidate at the dispatcher (overlappingPaths " +
      "is fail-closed on it), serializing the lane. Declare at least one repo-relative path this " +
      "task touches.",
  };
}

// ── RULE-15 FILING (W1-T384 — a filing shape the review guard can only refuse) ─
//
// THE INCIDENT, TWICE IN THREE DAYS. #1295 (W1-T324's dispatched run) went green on
// 23 checks and was refused by `remudero-review` on Standing rule 15; #1416
// (W1-T369's) was refused the same way with 18 deleted `proof:` lines. Both closed
// unmerged; both were recovered by SPLITTING into a plan-only PR plus a code/test PR
// (#1298+#1299 and #1418+#1420), each recovery merging in about a quarter of an hour.
// The work was correct both times — only the PACKAGING was impossible.
//
// THE MECHANISM. `judgeReview` computes `planOnly = diffFiles.length > 0 &&
// diffFiles.every(isInPlanScope)`, then `criteriaTampered = !planOnly &&
// criterionFieldTampered(evidence.diff)`. Withdrawing or repairing a record
// NECESSARILY removes a `claim:`/`proof:` line, which is exactly what
// `criterionFieldTampered` fires on. So the moment ONE declared path falls outside
// `isInPlanScope`, the carve-out is gone and the PR is refused however good the work
// is. A dispatched worker gets one PR per run and cannot produce the split.
//
// WHY A LITERAL PATH AND NOT "ANY PLAN-SCOPE PATH" — MEASURED, per CLAUDE.md's rule
// that a bound must have observed the population it separates. Re-derived over all
// 425 task records at 1e952fc: FOUR declare `plan/tasks.yaml`. Two are plan-scope-only
// and clean (W1-T202, W1-T370 — W1-T370 also verify:human); two are MIXED at
// verify:auto (W1-T324, W1-T369) — exactly the two that lost dispatches. ZERO false
// positives. Broadening the first clause to "any `isInPlanScope` path" instead fires
// on 18 open records, 17 of them verify:auto, every one legitimate: `plan/policy.yaml`
// beside `src/lib/policy.ts` is an ordinary config-plus-reader pairing (W1-T252,
// W1-T264, W1-T318, W1-T320, W1-T325, W1-T330, W1-T344, W1-T378 among them) and none
// touches an acceptance criterion. `plan/policy.yaml` is in plan scope only because it
// starts with `plan/`. The narrow trigger is the one the evidence supports.
//
// IT GATES STRICTLY EARLIER THAN THE REVIEW GUARD, which is why it needs no reasoning
// about gaming. `criteriaTampered` keeps working byte-identically on everything that
// reaches review; this adds a refusal BEFORE dispatch and changes nothing about what
// the reviewer does. It is purely additive to rule 15's strength — there is no path by
// which it lets through something rule 15 previously caught.
//
// ONE TRIGGER ONLY, following {@link rulingVerifyViolation}'s own lesson: that check
// shipped trigger A alone and dropped a title-word trigger B because B false-positived
// on the very task introducing it. No second trigger is invented here either.
//
// W1-T399 — THE MONOLITH-ONLY TRIGGER WENT BLIND AS THE MONOLITH FROZE. PR #1060 stopped
// routing new filings into `plan/tasks.yaml`; a task now stores its record in its own
// `plan/tasks.d/<id>-<slug>.yaml` shard (of the last twenty merged implementation PRs,
// nineteen worked a shard task). The literal-path trigger above never saw any of them —
// a task declaring its OWN shard alongside an out-of-scope path has the identical
// `criteriaTampered` exposure as W1-T324/W1-T369 did declaring the monolith, but passed
// this check silently. Widened to also match a shard path — NOT to "any plan-scope path"
// (the measured rejection above still holds; `plan/policy.yaml` beside `src/lib/policy.ts`
// remains legitimate and untouched). Re-measured over all 442 task records at 9b6687b with
// the widened trigger: the monolith clause alone still fires once (unchanged); the shard
// clause adds ZERO newly-failing open records — no staging is needed.

/** The exact repo-relative path this repo's task monolith lives at — the literal
 *  `files:` entry {@link rule15FilingViolation} keys on, alongside {@link
 *  TASKS_SHARD_PATH_RE}. Mirrors {@link DECISIONS_LOG_PATH}'s root-relative convention. */
const TASKS_MONOLITH_PATH = "plan/tasks.yaml";

/** A `plan/tasks.d/<id>-<slug>.yaml` shard — the ONLY other place a task record lives
 *  (W1-T399). Matched structurally (a `plan/tasks.d/` prefix, one path segment, a `.yaml`
 *  suffix) rather than a loose glob, mirroring `src/lib/review.ts`'s `isTaskRecordPath`. */
const TASKS_SHARD_PATH_RE = /^plan\/tasks\.d\/[^/]+\.yaml$/;

/** True for the monolith or a shard — the two places {@link rule15FilingViolation} treats
 *  as "declares a task record". */
function isTaskRecordFile(f: string): boolean {
  return f === TASKS_MONOLITH_PATH || TASKS_SHARD_PATH_RE.test(f);
}

/** Retired or landed records, excluded from {@link rule15FilingViolation}.
 *
 *  A withdrawal under the W1-T229 convention PRESERVES the record, `files:` included,
 *  so W1-T324's and W1-T369's mixed `files:` survive retirement forever. Without this
 *  exclusion the operator plan-only PR that withdraws W1-T324 would be blocked by the
 *  very check W1-T324 earned. `isOpenLintTask` is unexported and local to run-task.ts;
 *  W1-T369's own lock (test/plan-proof-debt.test.ts) re-declared the three-value set
 *  locally with a written reason rather than exporting it, and that precedent governs
 *  — a 3-literal Set carries none of the drift risk a re-implemented algorithm would. */
const NON_OPEN_FILING_STATUSES = new Set<TaskStatus>(["blocked", "merged", "done"]);

/** A task that declares a task record (the monolith OR its own shard, W1-T399) alongside a
 *  path outside plan scope, at a `verify` the operator will not be asked to judge —
 *  W1-T324's and W1-T369's exact shape, which `remudero-review` can only ever refuse. See
 *  the module comment above for the measured population and why the trigger keys on a
 *  structural path match rather than "any plan-scope path". */
export function rule15FilingViolation(task: Task): LintViolation | undefined {
  if (NON_OPEN_FILING_STATUSES.has(task.status)) return undefined;
  if (task.verify === "human") return undefined;
  const files = task.files ?? [];
  const recordFile = files.find(isTaskRecordFile);
  if (!recordFile) return undefined;
  const outOfScope = files.filter((f) => !isInPlanScope(f));
  if (outOfScope.length === 0) return undefined;
  return {
    check: "rule15-filing",
    severity: "block",
    message:
      `task ${task.id} declares ${recordFile} alongside ${outOfScope.join(", ")} at ` +
      `verify:${task.verify} — editing a task record removes a claim:/proof: line, and with a path ` +
      "outside plan scope the reviewer's planOnly carve-out is gone, so criteriaTampered refuses the " +
      "PR however good the work is. A dispatched worker gets ONE PR and cannot split it. Remedy: " +
      "file it as two tasks (a plan-only record edit, and the code/test work), or set verify: human " +
      "so the operator makes the edit by hand.",
  };
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

// ── DISPATCH-PRIORITY (W1-T422, soft) ────────────────────────────────────────
//
// A WARNING (never blocks) on the optional `priority:` field (lib/plan.ts) that
// `compareDispatch` (lib/drain.ts) reads as its FIRST sort key. Two ways the field
// rots silently without this: a value far outside the sanctioned band (a typo — a
// risk number or a turn budget pasted into the wrong column), and a value left on a
// task that can no longer dispatch at all (blocked/merged/done — see
// {@link NON_OPEN_FILING_STATUSES}, reused here unchanged: "non-open" means the exact
// same thing for a priority as it does for rule15-filing). Neither case can produce a
// WRONG verdict — a bad priority only degrades ORDERING (design (iii), W1-T422's own
// task record) — so blocking would overreach the failure mode.

/** Sanctioned `priority` band (design (iii), W1-T422) — wide enough to rank the whole
 *  open queue without doubling as an unbounded knob. A value outside it still sorts
 *  exactly where the comparator says it does (dispatchOrder never refuses to read it);
 *  the warning exists because a value this far out is very likely a typo. */
export const DISPATCH_PRIORITY_MIN = 0;
export const DISPATCH_PRIORITY_MAX = 99;

/** ADVISORY (never blocks): this task's `priority` is out of the [0, 99] band, or set
 *  on a task that is no longer OPEN, where it can never again affect dispatch order and
 *  is pure noise. Absent `priority` ⇒ silent — most tasks carry none, by design. */
export function dispatchPriorityViolations(task: Task): LintViolation[] {
  if (task.priority === undefined) return [];
  const violations: LintViolation[] = [];
  if (task.priority < DISPATCH_PRIORITY_MIN || task.priority > DISPATCH_PRIORITY_MAX) {
    violations.push({
      check: "dispatch-priority",
      severity: "warn",
      message:
        `task ${task.id} carries priority ${task.priority}, outside the sanctioned ` +
        `[${DISPATCH_PRIORITY_MIN}, ${DISPATCH_PRIORITY_MAX}] band — dispatchOrder (lib/drain.ts) ` +
        "still honours it exactly as written, but a value this far out is usually a typo.",
    });
  }
  if (NON_OPEN_FILING_STATUSES.has(task.status)) {
    violations.push({
      check: "dispatch-priority",
      severity: "warn",
      message:
        `task ${task.id} carries priority ${task.priority} but is status:${task.status} — a ` +
        "gravestone with a priority is noise: it can never again affect dispatch order.",
    });
  }
  return violations;
}

// ── ADVISORY-ROUTING (W1-T519 — a security-shaped filing is PUBLISHED before it's fixed) ────
//
// SECURITY.md (W1-T23, #320) already routes OUTSIDE reporters to a private GitHub security
// advisory and says plainly "do not open a public issue" — but nothing tells the fleet's OWN
// filers (triage, a recon session, a retro) that the same rule applies to a task shard: filing a
// task IS publishing on this repo, world-readable the moment it merges, and it can name a
// precondition-measured weakness that is not yet fixed. loadPlan reads plan/tasks.d/ on
// origin/main, so the fleet cannot itself act on a finding held in a private advisory — any fix
// there is necessarily HUMAN-BUILT — which is why this check is a WARN, never a gate: it informs
// the operator's routing choice for THIS filing, it never makes that choice (see "WARN-ONLY BY
// CONSTRUCTION" below).
//
// PRECISION OVER RECALL, MEASURED. A naive single-word scan (auth/token/secret/sandbox/scope/
// route/grant) over the live corpus (546 task blocks — every plan/tasks.d/ shard plus the
// monolith, 2026-08-15) hits 345/546 (63%) — wallpaper, not a signal, because this repo
// legitimately uses "scope", "route", "session", "grant" and "tier" in ordinary, non-security
// senses dozens of times a week (a task's declared files: scope, an HTTP route, a review
// session, a duplicate-title grant match, a risk tier). Every entry below instead matches a
// PHRASE naming an actual weakness shape (a bypass, a leak, an unscoped reachable route) and
// never fires on a bare noun. Re-run over the SAME corpus with the phrase table below: 5/546
// (0.9%), every hit inspected and genuine — W1-T10's scoped-PAT injection, W1-T371/W1-T169's
// "token leak"/"leaked" write-token discussions, W1-T493's route-scope-enforcement audit, and
// this task's own rationale (which quotes "auth gap" describing W1-T493/495/500 — a legitimate
// hit, not a false one: this shard's own text genuinely discusses a security-shaped topic).
//
// FIELDS: title + rationale + note — the free-text prose fields a filer actually writes into.
// The task record that requested this check also names `design:`, but that field is DROPPED by
// the plan parser before a {@link Task} object exists (see {@link rawChangedTaskIds}'s own
// comment on the six fields the parser never carries into a parsed Task) — this module is a PURE
// function over an already-loaded Task (module comment, top of file), so there is no `design:`
// text here to match against. Matching only the fields the linter actually receives is the
// honest version of the rule; a follow-up teaching the parser to retain `design:` on Task would
// let this check see it too, with zero changes to the matcher table itself.
//
// WARN-ONLY BY CONSTRUCTION: severity is the literal "warn" below, with NO {@link LintOpts} knob
// anywhere — unlike proofDialect/proofResolvability there is deliberately no way to run this rule
// blocking, in any caller, so it can never stall dispatch, the changed-tasks gate, or a filing.
// The routing decision this warn informs is the operator's; starving the queue over an advisory
// judgment call would be the opposite failure this repo has already paid for once (a ruling
// dispatched instead of parked for a human, W1-T326/#1302 — see {@link rulingVerifyViolation}).

export interface AdvisoryRoutingMatcher {
  /** Surfaced in the warn message — the category text acceptance criterion 1 checks for. */
  category: string;
  /** PRECISION-FIRST: must fire only on phrasing that names an actual weakness shape, never on
   *  a bare noun this repo also uses benignly (scope/route/session/grant/tier). */
  pattern: RegExp;
  /** WHY this phrase is security-shaped — read by a reviewer auditing the table, not consumed by
   *  the matcher itself (T427's per-entry-reason discipline: a reviewer reads reasons, not a
   *  bare list — see {@link ENFORCEMENT_DATA} in review.ts for the same discipline applied
   *  elsewhere). */
  reason: string;
}

/** DATA table — a new phrase is a row here, zero engine changes (mirrors {@link
 *  SUBSYSTEM_LEXICON} / {@link HEADLESS_FORBIDDEN_LEXICON} above). Categories match the design's
 *  own six: authentication/authorization weakness, token or credential leakage, secret handling,
 *  sandbox/containment escape or bypass, scope enforcement on a reachable route,
 *  prompt-injection escalation. See the module comment above for the measured 5/546 vs 345/546
 *  precision comparison this table earns. */
export const ADVISORY_ROUTING_LEXICON: ReadonlyArray<AdvisoryRoutingMatcher> = [
  {
    category: "authentication/authorization weakness",
    pattern: /\b(?:auth(?:entication|orisation|orization)?|privilege)[- ]?(?:bypass|escalation|gap|hole|flaw)\b/i,
    reason:
      "names a bypass/escalation/gap/hole/flaw IN the auth model or a privilege boundary, not an " +
      "ordinary passing mention of 'authentication' or 'authorization'",
  },
  {
    category: "token or credential leakage",
    pattern:
      /\b(?:token|credential|pat|api[- ]key)[- ]?(?:leak(?:age|ed|s)?|exfiltrat\w*|expos(?:ure|ed|es)|injection)\b/i,
    reason:
      "names a token/credential/PAT/API key that leaks, is exfiltrated, exposed, or injected — " +
      "not a routine token refresh or rotation",
  },
  {
    category: "secret handling",
    pattern: /\b(?:hardcoded|plaintext)[- ]secret\b|\bsecret[- ](?:handling|exposure|leak(?:age)?)\b/i,
    reason: "names a secret that is hardcoded, stored in plaintext, mishandled, or exposed",
  },
  {
    category: "sandbox/containment escape or bypass",
    pattern: /\b(?:sandbox|containment|symlink)[- ](?:escape|bypass)\b/i,
    reason:
      "names an escape from or bypass of a sandbox/containment/symlink boundary — deliberately " +
      "NOT a bare 'escape' (a mutation-testing 'escape count', W1-T393, uses the same word for an " +
      "unrelated concept and must not match)",
  },
  {
    category: "scope enforcement on a reachable route",
    pattern:
      /\b(?:unscoped|unauthenticated|unauthorized)[- ](?:route|endpoint)\b|\broute[- ]scope[- ](?:audit|enforcement|gap|bypass)\b|\bscope[- ]enforcement[- ](?:gap|bypass|missing|audit)\b|\broute(?:'s)?\s+scope\s+(?:is\s+)?enforced\b/i,
    reason:
      "names a reachable route/endpoint with missing, bypassable, or newly-audited scope " +
      "enforcement — not an ordinary 'in scope' or 'route' mention",
  },
  {
    category: "prompt-injection escalation",
    pattern: /\bprompt[- ]injection[- ](?:escalation|attack|exploit)\b/i,
    reason: "names prompt injection escalating into a further exploit, not a routine prompting mention",
  },
];

/** `task`'s narrative text (title + rationale + note — see the module comment above for why
 *  `design:` is not among them) matched against {@link ADVISORY_ROUTING_LEXICON}'s phrase
 *  entries. Named and shaped PLURAL, an ARRAY, matching this file's majority violation-family
 *  idiom (`proofShapeViolations`, `headlessFitnessViolations`, `dispatchPriorityViolations`,
 *  `duplicateTitleViolations` — every one returns `LintViolation[]`, spread straight into
 *  `lintTask`'s aggregator) — this is criterion 3's own point, "lands beside the other violation
 *  families ... as one idiom". Length is 0 or 1, NEVER more: only the FIRST matching category,
 *  in table order, is returned — never one per hit or one per field, so a task whose text
 *  matches several entries still draws exactly one warn (the falsifier's "exactly one"
 *  requirement). WARN-only, unconditionally: no `opts` parameter exists to override it (see the
 *  module comment above, "WARN-ONLY BY CONSTRUCTION"). */
export function advisoryRoutingViolations(task: Task): LintViolation[] {
  const text = [task.title, task.rationale, task.note].filter(Boolean).join("\n");
  for (const entry of ADVISORY_ROUTING_LEXICON) {
    if (!entry.pattern.test(text)) continue;
    return [
      {
        check: "advisory-routing",
        severity: "warn",
        message:
          `task ${task.id}'s text names a ${entry.category} (${entry.reason}) — filing a task IS ` +
          "publishing on this public repo, before any fix lands. Consider routing this finding to a " +
          'private security advisory (SECURITY.md, "Report a vulnerability") with public disclosure ' +
          "after the fix ships, instead of — or alongside — a public task shard. This is ADVISORY " +
          "ONLY: the fleet cannot act on a finding held in a private advisory (loadPlan reads " +
          "plan/tasks.d/ on origin/main), so the routing decision, and any resulting fix, remains " +
          "the operator's to make; this check never blocks dispatch or a filing.",
      },
    ];
  }
  return [];
}

// ── DUPLICATE-CLOSURE AT KNOWLEDGE INTAKE (W1-T420) ──────────────────────────
//
// ONE PURE MODULE (src/lib/knowledge-dedup.ts's `bestNearDuplicate`), TWO CONSUMERS HERE, TWO
// SEVERITIES — matched to population size and false-positive cost (the W1-T352-vs-W1-T322
// calibration argument applied at filing time). Both consumers below pass their own corpus in
// (this module reads no disk, same purity contract `moduleExists` already keeps for
// `callSiteViolations`); the CALLER resolves `learnings/*.yaml` and `plan/tasks.yaml` + shards
// and injects the result.
//
// (i) `duplicateTitleViolations` — TASK-TITLE INTAKE, ADVISORY. Wired into `lintTask` via
//     `opts.openTaskTitles`, so it runs on every real lint pass once a caller supplies the
//     corpus. WARN-only, unconditionally (no severity override — the whole point of the
//     advisory posture is that it never blocks): title similarity is legitimately high for
//     sibling tasks in an arc (a W1-T369/T370-shaped pair would rightly score high), and a
//     false BLOCK at filing costs a whole re-file cycle. The warn is the pointer; the author
//     decides. Escalation to blocking is follow-on work gated on a measured false-positive
//     rate (W1-T322's advisory-first posture) — not done here.
//
// (ii) `learningDuplicateViolation` — LEARNINGS INTAKE, BLOCKING. NOT wired into `lintTask`
//      (a `Task` does not carry a learning's `fact`/`id` — there is nothing on `Task` to hang
//      this check off), and this task's own declared `files:` is
//      [src/lib/knowledge-dedup.ts, src/lib/task-linter.ts, test/knowledge-dedup.test.ts] —
//      wiring a live gate over `learnings/*.yaml` diffs would mean editing run-task.ts or a CI
//      workflow file, outside that declared scope. Shipped here as a tested, directly callable
//      function (test/knowledge-dedup.test.ts exercises it directly) ready for that follow-up
//      wiring, exactly as `postMergeAmendmentViolations` above documents its own CI-only call
//      site rather than pretending to own it. Population: single-digit additions per week
//      against ~35 active entries — tiny, and every catch saves permanent double context-tax.
//      ANSWERABLE (the W1-T365 exemption shape): a stated distinction naming the matched id
//      clears it — a refusal that cannot be answered would just relocate the judgment it
//      replaces.
//
// THE CUTOFF (both consumers default to `DEFAULT_DUPLICATE_CUTOFF`) is MEASURED, not asserted
// — see that constant's own doc comment in knowledge-dedup.ts and this PR's body for the full
// pairwise score distribution over the live learnings corpus and open task titles that the
// cutoff sits above.

/**
 * W1-T1076: the shingle width the OPEN-PR SLUG corpus is scored at — 2, deliberately NOT
 * {@link DEFAULT_SHINGLE_K}'s 3, and chosen per call exactly as `bestNearDuplicate`'s own
 * `opts.k` was built to allow.
 *
 * WHY A SEPARATE CONSTANT AND NOT THE MODULE DEFAULT. Re-derived on the real predicate against
 * origin/main over every shard in `plan/tasks.d/`, on the two pairs that were filed minutes apart
 * on 2026-08-20 and that nothing caught:
 *
 *   pair A (W1-T1070/W1-T1071)  slug k=3 = 0.111  MISSED   slug k=2 = 0.200  caught
 *   pair B (W1-T1074/W1-T1075)  slug k=3 = 1.000  caught   slug k=2 = 1.000  caught
 *
 * k=3 misses pair A outright. k=1 catches both and is unusable — the whole-plan false-positive
 * load at cutoff {@link DEFAULT_DUPLICATE_CUTOFF} reads 196 pairs at k=1 against 34 at k=2 and 5
 * at k=3 (re-derived, and every one of those counts moves as shards land — re-run it, never quote
 * it). k=2 is the honest middle and pair A sits EXACTLY on the cutoff there, which is stated
 * rather than smoothed over: this width catches that pair by the smallest possible margin.
 *
 * {@link DEFAULT_SHINGLE_K} itself is NOT changed — it is the measured default for the learnings
 * corpus and the title consumer, and moving it is explicitly not this task's to do.
 */
export const DUPLICATE_SLUG_SHINGLE_K = 2;

/** A plan shard path's `<id>` and filename `<slug>`, as a corpus entry whose `text` is the SLUG.
 *  `undefined` for any path that is not a `plan/tasks.d/<id>-<slug>.yaml` shard — a PR's changed-
 *  file list carries every kind of path, and only shard additions belong in the corpus. PURE. */
export function shardSlugFromPath(path: string): DuplicateCorpusEntry | undefined {
  const m = /(?:^|\/)tasks\.d\/(W1-T\d+[a-z]?)-(.+)\.ya?ml$/.exec(path.trim());
  return m ? { id: m[1], text: m[2] } : undefined;
}

/**
 * The SLUG corpus for {@link duplicateTitleViolations}, built from a set of changed-file paths.
 * Deduped by id, first path per id wins. PURE — the caller does the GitHub read and hands the
 * paths in, the same seam `opts.moduleExists` and `opts.resolveNameFilteredCandidates` already
 * use, so this module still never reaches disk or network.
 *
 * THE TEXT IS THE SLUG ALONE, NEVER SLUG-PLUS-TITLE. Joining the two is measurably WORSE, which
 * is counter-intuitive enough to be worth stating where an implementer will read it: at k=2 the
 * joined text scores 0.049 and 0.121 on the two pairs above, against the slug's own 0.200 and
 * 1.000. The house title style is long and deliberately distinctive prose, so it floods the
 * shingle set and dilutes the signal the short topical slug carries.
 */
export function planShardSlugCorpus(paths: readonly string[]): DuplicateCorpusEntry[] {
  const byId = new Map<string, DuplicateCorpusEntry>();
  for (const path of paths) {
    const entry = shardSlugFromPath(path);
    if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/** The corpus the caller supplies for {@link duplicateTitleViolations} to compare THIS task
 *  against. `undefined`/empty ⇒ the check is silent — same "no predicate, no opinion" contract
 *  {@link callSiteViolations} uses for `opts.moduleExists`.
 *
 *  W1-T1076 CHANGED WHAT `text` HOLDS, and the field name is kept for continuity with W1-T420
 *  rather than because it is still perfectly descriptive: the live caller now supplies each OPEN
 *  PR's added shard FILENAME SLUG (see {@link planShardSlugCorpus}), because the title scores
 *  0.000 and 0.054 at k=3 on the two pairs this check exists to catch — wiring the corpus without
 *  changing what is scored would have caught neither. A caller that still passes titles gets
 *  W1-T420's original behaviour unchanged. */
export type OpenTaskTitleCorpus = readonly DuplicateCorpusEntry[];

/** ADVISORY (never blocks): this task scores >= cutoff against some OTHER entry in the supplied
 *  corpus. Absent `opts.openTaskTitles` ⇒ silent (the caller hasn't supplied a corpus).
 *
 *  W1-T1076: scores `opts.duplicateSlug` — this shard's own filename slug — when the caller
 *  supplies one, at `opts.duplicateShingleK`. Absent either, it falls back BYTE-FOR-BYTE to
 *  W1-T420's title-at-{@link DEFAULT_SHINGLE_K} behaviour, so every caller and fixture that
 *  predates the slug corpus is unaffected. */
export function duplicateTitleViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  const corpus = opts.openTaskTitles;
  if (!corpus || corpus.length === 0) return [];
  const cutoff = opts.duplicateTitleCutoff ?? DEFAULT_DUPLICATE_CUTOFF;
  // THE SLUG WHEN THERE IS ONE, THE TITLE OTHERWISE — never the two joined; see
  // {@link planShardSlugCorpus} for the measurement that rules the join out.
  const scored = opts.duplicateSlug?.trim();
  const candidateText = scored && scored.length > 0 ? scored : task.title;
  const k = opts.duplicateShingleK ?? DEFAULT_SHINGLE_K;
  const match = bestNearDuplicate({ id: task.id, text: candidateText }, corpus, { k });
  if (!match || match.score < cutoff) return [];
  return [
    {
      check: "duplicate-title",
      severity: "warn",
      message:
        `task ${task.id} scores ${match.score.toFixed(2)} (>= cutoff ${cutoff}, k=${k}) against ` +
        `${match.id} — possible duplicate of ${match.id}. This is ADVISORY, never blocking: sibling ` +
        "tasks in the same arc legitimately score high. TWO ANSWERS BOTH CLEAR IT, and both are " +
        `additive: CITE ${match.id} (name it in plan_refs and say what it already covers), or SAY ` +
        `WHY IT DIFFERS in the rationale. Never answer this by deleting a proof, narrowing files:, ` +
        "or removing any other evidence — this check asks for a citation, never for less work.",
    },
  ];
}

/** A stated distinction naming the SAME id `bestNearDuplicate` matched — the W1-T365 exemption
 *  shape: an answerable refusal, cleared by the author explaining the difference rather than
 *  relocating the judgment to a human every time. */
export interface DuplicateLearningDistinction {
  /** Must equal the matched entry's id for the exemption to apply. */
  existingId: string;
  /** Non-empty prose explaining how the new entry differs. */
  statement: string;
}

/** BLOCKING: a NEW active learning entry's `fact` scores >= cutoff against some entry already
 *  in the ACTIVE corpus. Returns `undefined` (clears) when no match reaches cutoff OR when
 *  `distinction` names the matched id with a non-empty statement. Takes its corpus and
 *  candidate by parameter — no disk read, so a caller can supply ANY corpus (a real
 *  `learnings/*.yaml` read, or a test fixture) with identical behavior. */
export function learningDuplicateViolation(
  candidate: DuplicateCorpusEntry,
  activeCorpus: readonly DuplicateCorpusEntry[],
  opts: { cutoff?: number; distinction?: DuplicateLearningDistinction } = {},
): LintViolation | undefined {
  const cutoff = opts.cutoff ?? DEFAULT_DUPLICATE_CUTOFF;
  const match = bestNearDuplicate(candidate, activeCorpus);
  if (!match || match.score < cutoff) return undefined;
  const distinction = opts.distinction;
  if (distinction && distinction.existingId === match.id && distinction.statement.trim()) {
    return undefined; // answerable exemption: the author named the match and stated the difference
  }
  return {
    check: "duplicate-learning",
    severity: "block",
    message:
      `possible duplicate of ${match.id} (score ${match.score.toFixed(2)} >= cutoff ${cutoff}) — ` +
      `state the distinction from ${match.id} in the PR body to clear this, or drop the new entry.`,
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
        `module. WHAT "UNREACHED" MEANS HERE, because the word names three different sets and a ` +
        `count without its definition is unusable: MEASURED across src/ at 167c6844, ZERO modules ` +
        `have no importer at all, THREE have only TEST importers, and 77 of 2081 exported values ` +
        `are referenced nowhere outside their own file (43 of those are SCREAMING_CASE constants). ` +
        `This check targets the second set — a new module reached only by its own tests. Quote a ` +
        `definition with any number you carry from here, and re-measure rather than citing these.`,
    },
  ];
}

/**
 * MONOLITH-FILING (impl-DS) — one storage convention for new tasks.
 *
 * PR #1060 redirected `rmd triage` to propose a new task as its own `plan/tasks.d/<id>-<slug>.yaml`
 * shard rather than appending to the 992 KB `plan/tasks.yaml` monolith. But that is ONLY A PROMPT
 * INSTRUCTION TO AN LLM: `decideTriage` (lib/triage.ts) filters `!f.startsWith("plan/")`, so a shard
 * passes AND so does a monolith append. #1060's own author flagged the gap — the prompt DIRECTS a
 * shard, the validator does not REQUIRE one, and a disobedient worker (or any hand-filing, or the
 * plan/architect lanes) still passes.
 *
 * THIS IS NOT A SIZE EMERGENCY, and the old framing should not be repeated. The 1 MiB buffer cliff
 * is gone (run-task.ts:589/:5298/:5500) and the monolith has essentially stopped growing: +303,798
 * bytes on 07-20, +3,666 on 07-30, ZERO on 07-31. The reason to enforce this is CONSISTENCY — one
 * storage convention the whole toolchain, the id minter and the conflict story can rely on.
 *
 * ID SETS, NEVER DIFF LINES. A reformat, a rename, a moved block or a whitespace change inside the
 * monolith leaves the id set untouched and cannot trip this. Only an id PRESENT in the monolith on
 * this branch and ABSENT from the monolith at the base ref is a violation.
 *
 * IT ALSO CATCHES THE REVERSE MIGRATION, which is more than the minimum asked for and costs nothing
 * extra: the base side is the base's MONOLITH blob specifically (not the merged base plan), so a
 * task moving from a shard INTO the monolith trips too — its id is absent from the base monolith.
 * A task moving the RIGHT way, monolith → shard, never trips: its id simply leaves the monolith.
 *
 * REQUIRES `--base`. "New" has no meaning without one, so {@link LintOpts.newMonolithIds} is
 * undefined in whole-plan mode and this check is silent there — the caller says so out loud rather
 * than letting a check that cannot run look like a check that passed.
 */
export function monolithFilingViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  if (!opts.newMonolithIds?.has(task.id)) return [];
  const severity: LintSeverity = opts.monolithFiling ?? "block";
  return [
    {
      check: "monolith-filing",
      severity,
      message:
        `task ${task.id} is NEW and was filed into plan/tasks.yaml. New tasks belong in their own ` +
        `shard: create plan/tasks.d/${task.id}-<kebab-slug>.yaml holding a single-element YAML list ` +
        `and remove the entry from the monolith. One task per file is the convention every new ` +
        `filing has followed since PR #1060, and it is what keeps two concurrent filings from ` +
        `colliding at end-of-file.`,
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
  /** Ids present in THIS branch's `plan/tasks.yaml` and absent from the base ref's monolith.
   *  Supplied only in `--base` mode; undefined ⇒ {@link monolithFilingViolations} is silent. */
  newMonolithIds?: ReadonlySet<string>;
  /** Severity for {@link monolithFilingViolations}. Default "block" — retrofit cost is zero. */
  monolithFiling?: LintSeverity;
  /** Severity for {@link proofScopeViolations}. Default "warn" — see that check's module
   *  comment for the measured 102/338 retrofit count driving the default, and why THIS
   *  task cannot itself wire a pre-dispatch "block" override (it would be an out-of-scope
   *  edit to run-task.ts, the exact defect this check exists to catch). */
  proofScope?: LintSeverity;
  /** The reviewer's OWN `resolveNameFilteredCandidates` (review.ts), bound to a real checkout,
   *  for {@link proofNameResolutionViolations} (W1-T488) to resolve a name-filtered `unit test:`
   *  proof's raw title against — never a reimplementation, so lint and review can never disagree
   *  about what a proof names. The linter itself is pure (no fs), so this is the caller's to
   *  supply — same "no predicate ⇒ no opinion" contract {@link callSiteViolations}'s
   *  `opts.moduleExists` already uses. Absent ⇒ the check is silent. */
  resolveNameFilteredCandidates?: (rawName: string) => NameFilterResolution;
  /** Other OPEN tasks' (id, title) pairs for {@link duplicateTitleViolations} (W1-T420) to
   *  compare THIS task's title against. Supplied by the caller — never fetched, this module
   *  stays pure. Absent/empty ⇒ the check is silent. */
  openTaskTitles?: OpenTaskTitleCorpus;
  /** Jaccard cutoff for {@link duplicateTitleViolations}. Default {@link
   *  DEFAULT_DUPLICATE_CUTOFF} (measured — see that constant's doc comment in
   *  knowledge-dedup.ts). The check is WARN-only regardless of this value; there is no
   *  severity override, unlike every other opt above — see the module comment ahead of
   *  {@link duplicateTitleViolations} for why. */
  duplicateTitleCutoff?: number;
  /** W1-T1076: THIS task's own shard filename slug, for {@link duplicateTitleViolations} to
   *  score instead of the title. Supplied by the caller (the linter reads no disk and cannot
   *  derive it — `Task` carries no path). Absent/blank ⇒ the title is scored, exactly as before. */
  duplicateSlug?: string;
  /** W1-T1076: shingle width for {@link duplicateTitleViolations}. The live caller passes
   *  {@link DUPLICATE_SLUG_SHINGLE_K}; absent ⇒ {@link DEFAULT_SHINGLE_K}, W1-T420's original. */
  duplicateShingleK?: number;
  /** W1-T1225: a `grep:` proof's named path -> that file's own text, or `undefined` when the path
   *  is not on disk (the linter reads no disk itself) — for {@link proofGrepUnmatchableViolations}
   *  to feed {@link classifyGrepZeroHit}. Same "no predicate ⇒ no opinion" contract {@link
   *  callSiteViolations}'s `opts.moduleExists` already uses. Absent ⇒ the check is silent.
   *  ALSO consumed by {@link proofEngineDivergenceViolations} (W1-T2294) — same fact, same
   *  reader, one contract for two checks that both need "what does this path's text look like
   *  today". */
  readGrepProofFile?: (repoRelPath: string) => string | undefined;
}

/** Lint one task. Hard checks (sizing/headless-fitness/proof-shape/proof-dialect/
 *  proof-resolvability/post-merge-amendment/provenance/ruling-verify) always run —
 *  post-merge-amendment is a no-op absent `opts.postMergeAmendment` — budget-sanity
 *  runs only when `opts.mountMaxTurns` is supplied, duplicate-title (W1-T420) is a
 *  no-op absent `opts.openTaskTitles`, proof-name-resolution (W1-T488) is a no-op
 *  absent `opts.resolveNameFilteredCandidates`, and dispatch-priority (W1-T422) and
 *  advisory-routing (W1-T519) always run — advisory-routing is a no-op (empty array) only
 *  when the task's title/rationale/note match none of {@link ADVISORY_ROUTING_LEXICON}, and
 *  can never block (see {@link advisoryRoutingViolations}'s module comment). */
export function lintTask(task: Task, opts: LintOpts = {}): LintResult {
  const violations: LintViolation[] = [];
  const sizing = sizingViolation(task);
  if (sizing) violations.push(sizing);
  violations.push(...headlessFitnessViolations(task));
  violations.push(...proofShapeViolations(task));
  violations.push(...proofDialectViolations(task, opts));
  violations.push(...proofResolvabilityViolations(task, opts));
  violations.push(...proofGrepSafetyViolations(task));
  violations.push(...proofScopeViolations(task, opts));
  violations.push(...proofNameResolutionViolations(task, opts));
  violations.push(...postMergeAmendmentViolations(task, opts));
  violations.push(...callSiteViolations(task, opts));
  violations.push(...monolithFilingViolations(task, opts));
  violations.push(...duplicateTitleViolations(task, opts));
  const prov = provenanceViolation(task);
  if (prov) violations.push(prov);
  const ruling = rulingVerifyViolation(task);
  if (ruling) violations.push(ruling);
  const rule15 = rule15FilingViolation(task);
  if (rule15) violations.push(rule15);
  const declaredScope = declaredScopeViolation(task);
  if (declaredScope) violations.push(declaredScope);
  violations.push(...dispatchPriorityViolations(task));
  violations.push(...advisoryRoutingViolations(task));
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
/**
 * W1-T428: split a raw plan yaml corpus into per-task RECORD blocks, keyed by id. A block runs
 * from its `- id:` line to the next one (or EOF), trimmed of trailing whitespace so a record
 * moved to a file's tail never differs by its final newline alone. Pure over the supplied text —
 * no disk, no git, the same contract as every other function in this file.
 */
export function splitTaskRecordBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const starts = [...text.matchAll(/^- id:[ \t]*(\S+)/gm)];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].index!;
    const to = i + 1 < starts.length ? starts[i + 1].index! : text.length;
    blocks.set(starts[i][1], text.slice(from, to).trimEnd());
  }
  return blocks;
}

/**
 * W1-T428: ids whose RAW record text differs between two corpora — the companion the parsed
 * {@link changedTaskIds} below cannot replace and must not be replaced by. The parser DROPS six
 * fields the corpus uses (design, plan_refs, queue_note, amendment_note, cycle_residual,
 * fixture_forensics — measured at the filing sha), so a design-only edit is INVISIBLE to the
 * parsed comparison: #1544 measured `0 task(s) checked` on exactly that diff, and the next
 * dispatched worker acted on instructions no gate re-checked. Comparing record BYTES catches
 * every dropped field, present and future, by construction; the parsed side still owns semantic
 * equivalence. The gate consumes the UNION. Ids present on exactly one side are reported too —
 * the same new/changed semantics the parsed comparison uses, and the union dedups.
 */
export function rawChangedTaskIds(oldTexts: readonly string[], newTexts: readonly string[]): Set<string> {
  const merge = (texts: readonly string[]): Map<string, string> => {
    const all = new Map<string, string>();
    for (const t of texts) for (const [id, block] of splitTaskRecordBlocks(t)) all.set(id, block);
    return all;
  };
  const oldBlocks = merge(oldTexts);
  const newBlocks = merge(newTexts);
  const changed = new Set<string>();
  for (const [id, block] of newBlocks) if (oldBlocks.get(id) !== block) changed.add(id);
  for (const id of oldBlocks.keys()) if (!newBlocks.has(id)) changed.add(id);
  return changed;
}

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
