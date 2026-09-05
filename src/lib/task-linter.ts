import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import type { AcceptanceCriterion, Plan, Task, TaskStatus } from "./plan.js";
import { RETIREMENT_REASONS } from "./plan.js";
import { isInPlanScope } from "./plan-architect.js";
import {
  isDemonstrationProof,
  grepProofTargetNamesNoFile,
  isDialectPrefixed,
  parseWhitelistedProof,
  type NameFilterResolution,
  type WhitelistedProof,
} from "./review.js";
import {
  COMPANION_PATH_CLASSES,
  GENERATED_LEDGER_CLASSES,
  isCompanionPath,
  type CompanionPathClass,
} from "./companion-paths.js";
// Re-exported so every pre-existing importer of task-linter.ts is byte-identical (W1-T2547).
export { COMPANION_PATH_CLASSES, GENERATED_LEDGER_CLASSES, isCompanionPath, type CompanionPathClass };
import {
  bestNearDuplicate,
  DEFAULT_DUPLICATE_CUTOFF,
  DEFAULT_SHINGLE_K,
  type DuplicateCorpusEntry,
} from "./knowledge-dedup.js";
import { classifyGrepZeroHit } from "./grep-zero-cause.js";

/** Deterministic task linter (MASTER-PLAN §5C Layer A).
 *  A PURE function over a loaded {@link Task}/{@link Plan}: no LLM, no I/O, no side effects. Every
 *  fact a check needs from disk, git or GitHub arrives through {@link LintOpts}. No predicate ⇒ no
 *  opinion: the check that needs it stays silent.
 *  It refuses the malformed shapes that reached a worker and burned budget — over-scoping (Rule 19),
 *  headless-unfitness (Rule 18), vibe proofs, a proof that cannot execute or resolve, a proof naming
 *  a path outside the task's own `files:`, criteria amended on a merged task (Rule 21), missing
 *  provenance (Rules 16/17), a ruling-shaped task filed `verify: auto`.
 *  Wired at two fail-closed points. (i) CI — `rmd lint-plan` on any PR that edits the plan; only
 *  this site holds a `--base` diff, so it alone supplies the diff-scoped contexts. (ii) PRE-DISPATCH
 *  — `assertLintClean` in `rmd run-task`, so a task failing a BLOCKING check is never dispatched.
 *  A BLOCK refuses dispatch; a WARN is visibility-only, and each check states its own severity and
 *  any knob that demotes it. Two are warn-only BY CONSTRUCTION, with no knob anywhere.
 *  Why: docs/forensics/task-linter.md#module-header holds the incidents each check was earned by
 *  (W1-T6/T9/T12, W1-T100/T101, W1-T180, W1-T246, W1-T310, W1-T326, W1-T519). */

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
  | "post-merge-correction-without-prompt"
  | "blocked-task-disposition"
  | "blocked-record-unruled"
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
// Rule 19 counts DISTINCT SUBSYSTEMS/CONCERNS, never the raw criterion count: concerns are inferred
// from the `files:` list plus criteria naming modules outside it. Many criteria over one module
// must not flag; a span across modules at risk<high must. Why: the count-based reading mis-flagged
// W1-T4 and W1-T3E.

/** Basename minus extension of a repo-relative path, with `.test` folded away so
 *  `test/review.test.ts` and `src/lib/review.ts` name the SAME module. */
export function moduleIdFromPath(path: string): string | undefined {
  const m = path.match(/([^/\\]+)\.[A-Za-z0-9]+$/);
  if (!m) return undefined;
  return m[1].replace(/\.test$/, "").toLowerCase();
}

/** Cross-cutting subsystem nouns, matched against acceptance-criteria text when a task names a
 *  module outside its `files:` list, or carries none. DATA, not logic: a new pattern is a row here.
 *  THE TRAP IS OVER-BREADTH — each entry must be a DISTINCTIVE noun for a real subsystem, never a
 *  generic word, since a "every src/lib basename is a keyword" scan tags `plan` on every task.
 *  Why: docs/forensics/task-linter.md#subsystem_lexicon. */
export const SUBSYSTEM_LEXICON: ReadonlyArray<{ tag: string; pattern: RegExp }> = [
  { tag: "daemon", pattern: /\bdaemon\b/i },
  { tag: "launchd", pattern: /\blaunchd\b|\blaunchctl\b/i },
  { tag: "crash-recovery", pattern: /\bchaos-drill\b|\bcrash-recover(?:y|ed)?\b/i },
];

/** Non-code data/config file classes discounted from the subsystem COUNT: a code file paired with
 *  its own data artifact, the policy-as-data pattern of MASTER-PLAN rule 2, must not count as a
 *  second subsystem merely because the artifact has a different basename. Each row is a path prefix
 *  plus an extension, never a branch, so a new class costs one row and no engine change; it removes
 *  the file from the concern tally only. Why: #153, W1-T92. */
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

/** True iff `path` matches BOTH the path prefix and the extension of some row in `classes` — a
 *  discounted data/config artifact rather than a code subsystem. */
export function isDataArtifact(
  path: string,
  classes: ReadonlyArray<DataArtifactClass> = DATA_ARTIFACT_CLASSES,
): boolean {
  return classes.some((c) => c.pathPattern.test(path) && c.extPattern.test(path));
}

/** The distinct subsystems/concerns a task spans. `ownFalsifierSlug` is this task's own shard
 *  filename slug, the fact {@link LintOpts.duplicateSlug} carries: a `test/` path whose {@link
 *  moduleIdFromPath} equals it is the task's own falsifier and is discounted, and any other is
 *  someone else's test and counts as an ordinary concern. INVARIANT: an unknown slug keeps
 *  W1-T2543's behaviour byte for byte, and supplying one can only NARROW the discount.
 *  Why: docs/forensics/task-linter.md#subsystemsof (W1-T2525, W1-T2543). */
export function subsystemsOf(
  task: Task,
  dataArtifactClasses: ReadonlyArray<DataArtifactClass> = DATA_ARTIFACT_CLASSES,
  companionClasses: ReadonlyArray<CompanionPathClass> = COMPANION_PATH_CLASSES,
  ownFalsifierSlug?: string,
): Set<string> {
  const ids = new Set<string>();
  // Companions are collected separately and folded in only if nothing else survives, so the
  // discount cannot empty the tally. Two passes, because whether a companion counts depends on the
  // WHOLE file list, not the companion (W1-T2543).
  const companions = new Set<string>();
  for (const f of task.files ?? []) {
    if (isDataArtifact(f, dataArtifactClasses)) continue; // a data/config artifact, not a concern
    const id = moduleIdFromPath(f);
    if (!id) continue;
    if (isCompanionPath(f, companionClasses)) {
      // A known slug this companion does not match means it is not the task's own falsifier, so
      // count it like an ordinary file and keep the vacuity guard below from sweeping it (W1-T2525).
      if (ownFalsifierSlug !== undefined && id !== ownFalsifierSlug) ids.add(id);
      else companions.add(id);
    } else ids.add(id);
  }
  // A task declaring ONLY companions (a test-only change) still counts them — otherwise it would
  // score zero concerns and pass sizing vacuously, which is a worse answer than the one being fixed.
  if (ids.size === 0) for (const id of companions) ids.add(id);
  const text = (task.acceptance ?? []).map((c) => `${c.claim ?? ""} ${c.proof ?? ""}`).join("\n");
  for (const entry of SUBSYSTEM_LEXICON) {
    if (entry.pattern.test(text)) ids.add(entry.tag);
  }
  return ids;
}

/** The declared companions that, renamed to, would remove the span — in declaration order; a
 *  companion qualifies when `subsystemsOf(task, …, moduleIdFromPath(path))` scores below 2. PURELY
 *  DIAGNOSTIC: it decides what a violation MESSAGE may offer, never {@link sizingViolation}'s
 *  decision, and is empty unless the rename would really resolve the span. TRAP: that discount keys
 *  on string equality between two names a filer picks independently, so a few words' difference
 *  reads as a real span. Why: docs/forensics/task-linter.md#ownfalsifierrenamecandidates. */
export function ownFalsifierRenameCandidates(
  task: Task,
  ownFalsifierSlug: string | undefined,
  dataArtifactClasses: ReadonlyArray<DataArtifactClass> = DATA_ARTIFACT_CLASSES,
  companionClasses: ReadonlyArray<CompanionPathClass> = COMPANION_PATH_CLASSES,
): string[] {
  if (ownFalsifierSlug === undefined) return [];
  const out: string[] = [];
  for (const f of task.files ?? []) {
    if (!isCompanionPath(f, companionClasses)) continue;
    const id = moduleIdFromPath(f);
    if (id === undefined || id === ownFalsifierSlug) continue; // already matching — nothing to rename
    if (subsystemsOf(task, dataArtifactClasses, companionClasses, id).size < 2) out.push(f);
  }
  return out;
}

/** The third exit for a sizing block, appended only when {@link ownFalsifierRenameCandidates} finds
 *  the rename would resolve the span. The sentence states the condition that makes the discount
 *  legitimate and names the misuse outright, because advertised bare a rename exit invites gaming:
 *  any task spanning two genuine concerns could silence Rule 19 by renaming a file. */
export function ownFalsifierRenameExit(candidates: readonly string[]): string {
  if (candidates.length === 0) return "";
  const named = candidates.map((c) => `\`${c}\``).join(", ");
  const id = moduleIdFromPath(candidates[0]);
  return (
    ` — or, ONLY IF ${named} is THIS task's own falsifier (the suite written to prove THESE ` +
    `acceptance criteria, not a suite that already exists for another concern), rename this shard ` +
    `so its filename slug is \`${id}\` and the two match: the span here exists solely because those ` +
    `two names differ, and W1-T2525's own-falsifier discount then applies. If the suite is not this ` +
    `task's own falsifier, the span is REAL and renaming to silence it is gaming Rule 19, not ` +
    `satisfying it — decompose instead`
  );
}

/** ≥2 subsystems while risk<high ⇒ a sizing violation (raise to high or decompose). A risk:high
 *  band conflates two meanings and nothing used to record which: Rule 19's SPAN measure, or genuine
 *  BLAST RADIUS unrelated to span. So a task the diff files or promotes to high must declare
 *  `band_meaning`: `blast-radius` keeps the old exemption byte for byte, and `span` computes the
 *  count and reports it as a warn, never a refusal. INVARIANT — no `opts.riskTransition` ⇒ an
 *  undeclared band stays SILENT, so no caller regresses on the standing backlog; with it, a
 *  newly-high task blocks and an already-high one warns. Why: docs/forensics/task-linter.md#sizingviolation. */
export function sizingViolation(task: Task, opts: LintOpts = {}): LintViolation | undefined {
  // The same slug `duplicateTitleViolations` reads, never re-derived — this module reads no disk.
  // Blank or absent ⇒ undefined, keeping the W1-T2543 discount for callers with no slug (W1-T2525).
  const ownFalsifierSlug = opts.duplicateSlug?.trim().toLowerCase() || undefined;
  if (task.risk !== "high") {
    const subsystems = subsystemsOf(task, undefined, undefined, ownFalsifierSlug);
    if (subsystems.size < 2) return undefined;
    // The third exit rides on THIS message alone (W1-T2814). The `band_meaning: span` warn below
    // has already admitted a wide span, so it offers no exit a reader can take wrongly.
    return {
      check: "sizing",
      severity: "block",
      message:
        `spans ${subsystems.size} distinct subsystems/concerns (${[...subsystems].sort().join(", ")}) ` +
        `at risk:${task.risk} — Rule 19: raise to risk:high or decompose into one task per concern` +
        ownFalsifierRenameExit(ownFalsifierRenameCandidates(task, ownFalsifierSlug)),
    };
  }

  if (task.band_meaning === "blast-radius") return undefined; // exempt, exactly as today

  if (task.band_meaning === "span") {
    const subsystems = subsystemsOf(task, undefined, undefined, ownFalsifierSlug);
    if (subsystems.size < 2) return undefined;
    return {
      check: "sizing",
      severity: "warn",
      message:
        `spans ${subsystems.size} distinct subsystems/concerns (${[...subsystems].sort().join(", ")}) ` +
        `at risk:high, band_meaning:span — reported, not refused (W1-T2503): a wide span is what ` +
        `declaring band_meaning: span already admits`,
    };
  }

  // No band_meaning declared.
  const transition = opts.riskTransition;
  if (!transition) return undefined; // not diff-scoped ⇒ no opinion, exactly as before this task
  const newOrMovedToHigh = transition.baseTask === undefined || transition.baseTask.risk !== "high";
  if (!newOrMovedToHigh) {
    return {
      check: "sizing",
      severity: "warn",
      message:
        `risk:high with no band_meaning declared — part of the standing baseline (W1-T2503): ` +
        `reported, not refused. Declare band_meaning: span (Rule 19 SPAN, ≥2 subsystems/concerns) ` +
        `or band_meaning: blast-radius (dangerous regardless of span) whenever this task is next touched`,
    };
  }
  return {
    check: "sizing",
    severity: "block",
    message:
      `risk:high with no band_meaning declared — W1-T2503: a task this diff files or promotes to ` +
      `high must say which of the two things the band means: band_meaning: span (Rule 19's SPAN ` +
      `measure, ≥2 subsystems/concerns — the count is then REPORTED, never a refusal) or ` +
      `band_meaning: blast-radius (a dangerous change regardless of span: a boot script, an auth ` +
      `path, a merge arm — keeps today's exemption)`,
  };
}

// ── HEADLESS-FITNESS (Rule 18) ───────────────────────────────────────────────
// A forbidden live-context lexicon, held as DATA so it grows. A headless worker has no TTY and no
// operator, so an auto-verify criterion needing one can never pass. A naive whole-word scan is wrong
// in BOTH directions, so three exemptions and one widening carry the precision: NEGATION,
// SELF-REFERENCE (by CONTENT SHAPE, never a task-id allowlist, which rots), SPAWN-OWNERSHIP, and
// PHRASE rows. DEFAULT ON FIRING: an ambiguous criterion still flags, because a false positive costs
// a reword and a false negative a task that can never pass. Why:
// docs/forensics/task-linter.md#headless_forbidden_lexicon.

export interface LexiconEntry {
  tag: string;
  pattern: RegExp;
  /** Optional SPAWN-OWNERSHIP qualifier — scope-as-data, never a reason to delete the row. A hit is
   *  exempted when `qualifier` matches anywhere in the criterion's claim+proof text, i.e. its own
   *  words say the test or fixture created the process acted upon; absent or no match, the row
   *  fires. Why: W1-T118, the #268 false positive. */
  qualifier?: RegExp;
}

/** Shared SPAWN-OWNERSHIP cue: the criterion's own text names the test or fixture as what CREATED
 *  the process being acted upon. 'a worker fixture spawns a detached child … the child's process
 *  group killed' qualifies; 'the LIVE daemon killed mid-task' names no such actor. A row may reuse
 *  this or supply its own — the field is per-row DATA. Why: W1-T118. */
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
  // Phrase-level live-demonstration signals: an imperative no headless worker can perform,
  // regardless of whether any single word above appears. A bare 'screenshot' is DELIBERATELY not a
  // row — measured against the live plan, it false-positived on an automated capture and on a
  // falsifier citing past evidence. Why: the #146 sweep, W1-T25/26/27/28, W1-T153/T184.
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

/** Indices of `hits` that are part of a bare-'/'-joined enumeration of >=2 terms — a listed
 *  lexicon excerpt, not an instruction. Why: W1-T20c's self-description. */
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

/** True iff `tag`'s row carries a `qualifier` matching somewhere in `text` — the criterion's own
 *  words establish spawn-ownership. Unscoped by clause, unlike {@link isNegationScoped}, since
 *  ownership is usually established earlier in the criterion, in a different clause. No qualifier
 *  or no match ⇒ false, so an ambiguous criterion still flags. Why: W1-T118, the #268 positive. */
function isSpawnOwnershipQualified(text: string, tag: string, lexicon: ReadonlyArray<LexiconEntry>): boolean {
  const entry = lexicon.find((e) => e.tag === tag);
  if (!entry?.qualifier) return false;
  const re = new RegExp(entry.qualifier.source, entry.qualifier.flags.replace(/g/g, ""));
  return re.test(text);
}

/** Every criterion of an auto-verify task that hits `lexicon` outside a negation scope, a quoted
 *  span, or a bare-'/' enumeration. The `lexicon` parameter exists so the DATA table can grow with
 *  no change to this function. */
export function headlessFitnessViolations(
  task: Task,
  lexicon: ReadonlyArray<LexiconEntry> = HEADLESS_FORBIDDEN_LEXICON,
): LintViolation[] {
  if (task.verify !== "auto") return []; // only an auto-verify task is dispatched headless
  const violations: LintViolation[] = [];
  (task.acceptance ?? []).forEach((c, i) => {
    // Joined with an em-dash, a CLAUSE_BOUNDARY char, so a negation cue or a quoted span in one
    // field can never leak into the other: claim and proof are separate clauses (W1-T81).
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
// Every criterion needs an OBSERVABLE proof, not a vibe ("works" / "correct" / empty). DATA-driven,
// like the two lexicons above.

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
// The reviewer EXECUTES each `proof:`, but only review.ts's house dialect actually runs. Anything
// else is free prose: it never executes, degrades to the keyword floor, and a task with ZERO
// executable proofs caps on review and needs a manual operator rescue. This check REUSES review.ts's
// own predicate, never a reimplementation that could drift from what the executor runs.
// `demonstration:` is a third, never-executed dialect — an honest declaration, not a defect. It is
// legal ONLY on `verify: human` and refused on `verify: auto`, where the identical prefix would be
// an escape hatch, and is checked BEFORE the dead-proof-floor logic.
// Why: docs/forensics/task-linter.md#proofdialectviolations.

/** A near-miss dialect prefix — close enough to the real `unit test:`/`grep:` labels to read as an
 *  authoring typo rather than deliberate prose. None of these match {@link parseWhitelistedProof},
 *  so the proof still falls through to free prose. Checked at the START of the trimmed proof only,
 *  because a dialect label is how a proof begins (mirrors review.ts's `isDialectPrefixed`). */
const NEAR_MISS_PREFIX_RE = /^(?:unit tests\s*:|unit test over\b|integration test\s*:)/i;

/** True iff a `unit test:` body reads as a runtime narrative rather than a literal test-title
 *  substring. `--test-name-pattern` is a substring match against a real title, so a compound,
 *  multi-clause body matches ZERO tests at review time and degrades to the keyword floor even
 *  though the proof parses. WARN-only regardless of `opts.proofDialect`, since some real titles are
 *  genuinely long. Why: the W1-T79 criteria-3/4 shape, W1-T72. */
function looksLikeNonTitleBody(body: string): boolean {
  return body.includes(" -> ") || body.includes("; ") || body.length > 100;
}

/** Every non-`satisfied_by` criterion whose proof does not parse as a {@link parseWhitelistedProof}
 *  shape — the dead proof floor. BLOCK by default, and since impl-AK every call site takes that
 *  default. A proof that DOES parse but reads as a non-title `unit test:` body (see {@link
 *  looksLikeNonTitleBody}) draws a separate WARN, always, independent of `opts.proofDialect`. */
export function proofDialectViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  const severity: LintSeverity = opts.proofDialect ?? "block";
  const violations: LintViolation[] = [];
  (task.acceptance ?? []).forEach((c, i) => {
    if (c.satisfied_by) return; // Architect-only; never expected to be executable prose
    const proof = c.proof ?? "";
    const trimmed = proof.trim();
    const claimHead = (c.claim ?? "").slice(0, 60);

    // The asymmetry is the dialect's whole safety property, so `opts.proofDialect` cannot demote
    // it: the warn-only rollout knob covers proofs that FAIL to parse, never one illegal by
    // construction (W1-T277; see the section comment above).
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
// A dialect prefix is a PROMISE, and this rule polices it independently of whether the payload
// parses: it commits the author to naming a RESOLVABLE artifact, held as DATA in {@link
// PROOF_PAYLOAD_SHAPES}. A proof with NO dialect prefix makes no such promise and is never touched.
// TRAP proofDialectViolations cannot close: parseTestTarget treats ANY non-path `unit test:` body
// as a valid name-filtered proof, so a prefix can promise executability with a payload resolving to
// zero real tests. Such a body is refused ONLY when it also reads as a multi-clause SCENARIO
// NARRATIVE, never on a lone arrow — this repo's own titles read `X -> Y`. Why:
// docs/forensics/task-linter.md#proofresolvabilityviolations (W1-T100, W1-T101, W1-T246).

export interface ProofPayloadShape {
  tag: string;
  /** Which dialect prefix this shape resolves. */
  dialect: "unit test" | "grep";
  /** Tested against the BODY — the proof text AFTER the dialect prefix. */
  pattern: RegExp;
}

/** DATA table — a new resolvable payload SHAPE is a row here, with no engine change (mirrors
 *  {@link SUBSYSTEM_LEXICON} / {@link DATA_ARTIFACT_CLASSES} / {@link HEADLESS_FORBIDDEN_LEXICON}). */
export const PROOF_PAYLOAD_SHAPES: ReadonlyArray<ProofPayloadShape> = [
  // unit test: a path-like token (test/*.test.ts) anywhere in the body.
  { tag: "test-path", dialect: "unit test", pattern: /\btest\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/ },
  // unit test: an explicit ::test-name token — a literal '::' followed by a
  // non-empty name, unambiguous even when the token before it isn't a path.
  { tag: "test-name-token", dialect: "unit test", pattern: /::\s*\S/ },
  // grep: a pattern AND a trailing `in <path>` clause — the same shape parseDialectGrep requires
  // to parse at all, re-declared as DATA so the remedy text stays uniform across both dialects.
  { tag: "grep-in-path", dialect: "grep", pattern: /\bin\s+\S*[./]\S*\s*$/i },
];

/** How a proof's text starts when written in the executable dialect, matched EXACTLY. A near-miss
 *  prefix ({@link NEAR_MISS_PREFIX_RE}) makes no promise this rule polices and is a separate hint. */
const RESOLVABILITY_DIALECT_RE = /^(unit test|grep):\s*([\s\S]*)$/i;

/** True iff `body` reads as a multi-clause scenario narrative rather than a single test's title.
 *  See the module comment above for why a lone arrow does not, by itself, qualify. */
function looksLikeScenarioNarrative(body: string): boolean {
  const commas = (body.match(/,/g) ?? []).length;
  return commas >= 2 || (body.includes("; ") && commas >= 1) || body.length > 100;
}

/** Every criterion whose proof STARTS with the executable dialect but whose payload matches NONE of
 *  {@link PROOF_PAYLOAD_SHAPES} for it — a prefix promising executability without naming a
 *  resolvable artifact. A proof with no dialect prefix is never touched. BLOCK by default;
 *  `opts.proofResolvability: "warn"` demotes them at the pre-dispatch site, so the legacy backlog
 *  does not brick overnight. */
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
// `execWhitelistedProof` runs `grep -arn -- <pattern> <path>`, so a `grep:` proof's pattern is a
// BASIC REGULAR EXPRESSION, not a fixed string. THE TRAP: an author verifies with `grep -F` — a
// DIFFERENT MATCHER — and gets a false green on a pattern that can never match.
// THE METACHARACTER SET IS MEASURED, NOT REMEMBERED, and is the UNION over both grep
// implementations: a pattern whose meaning depends on which binary the review host runs is not a
// proof. SEVERITY SPLITS ON THE FAILURE MODE: a character that can make a proof NEVER match blocks,
// one that only widens a match that still succeeds warns, so working proofs stand.
// Why: docs/forensics/task-linter.md#proofgrepsafetyviolations (W1-T287, PR #1071, W1-T253).

/** BRE metacharacters whose presence can make a pattern NEVER match its literal
 *  text — the silent-false-FAIL class. Blocking; measured retrofit 0. */
const BRE_BLOCKING_METACHARS: ReadonlyArray<string> = ["[", "*", "^", "$"];

/** BRE metacharacters that do NOT silently strand a proof under the executor's own matcher, so they
 *  warn rather than block — for opposite reasons. `.` only WIDENS a match, so the proof still finds
 *  its own text. `?` is LITERAL in a BRE and a QUANTIFIER in an ERE: the executor passes no `-E`, so
 *  a bare `?` works today but any ERE-defaulting grep reports a clean zero. See {@link
 *  SINGLE_LITERAL_CLASS_CHARS} for why the remedy is `[?]`. */
const BRE_WARNING_METACHARS: ReadonlyArray<string> = [".", "?"];

/** Characters for which `[X]` — a bracket holding exactly this one character — is the SANCTIONED
 *  literal escape, exempt from `[`'s blocking rule; without it the linter would forbid the only
 *  portable remedy for the fragility it warns about. `\X` IS NOT AN ALTERNATIVE, since `\?` is a
 *  quantifier in GNU BRE and a literal in an ERE. MEASURED under both `grep` and `grep -E`. `^` is
 *  DELIBERATELY EXCLUDED, since `[^]` opens a NEGATED class; a multi-character class stays
 *  blocked. Why: PR #1071. */
const SINGLE_LITERAL_CLASS_CHARS: ReadonlyArray<string> = ["?", ".", "*", "+", "$", "(", ")", "{", "}", "|", "[", "]"];

/** The remedy sentence for each warning-tier metacharacter — the character's OWN fix, never a
 *  generic one: `.` and `?` fail in opposite directions, so a shared sentence would help neither. */
const BRE_WARNING_REMEDY: Readonly<Record<string, string>> = {
  ".": "matches ANY character in a BRE — the proof still finds its own text but would also match text you did not intend. Escape it (\\.) to mean a literal dot.",
  "?": "is LITERAL under the executor's own `grep -arn` (a BRE) but a QUANTIFIER under an ERE, so this pattern matches today and silently finds NOTHING under any grep that defaults to ERE — a clean zero, not an error. Write `[?]`, which is literal under both. Do NOT write `\\?`: that INVERTS the failure (a quantifier in GNU BRE, a literal in an ERE) and breaks the engine that works today.",
};

/** Characters that become a BRE construct when a backslash precedes them — grouping, intervals, and
 *  GNU's optional-quantifier; `\.`-style escapes are NOT here, being literals. THE TRAP `?` NAMES:
 *  the escape an author reaches for to make `?` literal is precisely the form that stops being
 *  literal, since `\?` is a quantifier in a GNU BRE. Blocking is still right, because `[?]` is
 *  literal under both engines, and retrofit measured ZERO affected proofs.
 *  Why: docs/forensics/task-linter.md#bre_construct_after_backslash. */
const BRE_CONSTRUCT_AFTER_BACKSLASH: ReadonlyArray<string> = ["(", ")", "{", "}", "?"];

/** The unescaped BRE metacharacters in `pattern`, split by severity. It walks the string rather
 *  than regex-matching it: the one thing that must be exactly right is which characters an escape
 *  consumes, and expressing that as a regex over a regex is how this class of bug is born. */
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
    // `[X]` — one metacharacter, immediately closed — is the sanctioned literal form. Consume all
    // three characters so the bracket does not block AND the character inside is not separately
    // scored: `[?]` must be silent, not a warning about the very `?` it escapes. Anything else
    // starting with `[` falls through to the blocking arm.
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
    // The same split parseDialectGrep uses: an " in " followed by a PATH-LIKE trailing token.
    // NO FALLBACK TO THE WHOLE BODY: a path-less `grep:` is refused outright by parseDialectGrep,
    // so it never executes and has no pattern to be unsafe; this check polices only proofs that
    // RUN. Why: the fallback warned spuriously on W1-T66 and W1-T90.
    const split = m[1].match(/^([\s\S]*?)\s+in\s+(\S*[./]\S*)\s*$/i);
    if (!split) continue;
    const pattern = split[1].trim();
    if (!pattern) continue;
    const where = `criterion ${i + 1} ("${(c.claim ?? "").slice(0, 56)}")`;
    // (R-12) A DIRECTORY-SHAPED target is refused at filing time with the same rule and sentence
    // `parseDialectGrep` applies at parse, so an author sees it when the shard is filed rather than
    // at review time as a proof that silently never executes. The rule stays textual; the
    // executor's `assertGrepTargetIsFile` catches the rest at run time.
    const noFile = grepProofTargetNamesNoFile(split[2]);
    if (noFile !== undefined) {
      violations.push({
        check: "proof-grep-safety",
        severity: "block",
        message:
          `${where} \`grep:\` ${noFile}. The reviewer's parser refuses this proof, so it would never ` +
          `execute and could certify nothing; name a file beneath that path instead (R-12).`,
      });
      continue;
    }
    const { blocking, warning } = breMetacharsIn(pattern);
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
    // ONE VIOLATION PER DISTINCT CHARACTER, never one aggregate line: `.` and `?` fail in opposite
    // directions, so a shared sentence could only be vague enough to help with neither.
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
// Nothing at filing time opens the file a `grep:` proof names, so a pattern that cannot match any
// line of a file already on disk reads identically to a correct forward reference. Two subclasses
// are POSITIVE detections rather than zeros: the phrase is in the file with a line break inside it,
// or only under different capitalisation. A genuine forward reference matches neither probe.
// It CONSUMES {@link classifyGrepZeroHit} rather than re-deriving that detection, and stays PURE
// via the injected {@link LintOpts.readGrepProofFile}. WARN, NEVER BLOCK, with no override.
// DELIBERATELY NOT folded into {@link lintTask}'s aggregate — it is scoped to ONE call site where
// the read is bounded by the diff. Why: docs/forensics/task-linter.md#proofgrepunmatchableviolations.

/** The (pattern, path) a "grep"-kind {@link WhitelistedProof} names, restricted to the DIALECT
 *  shape, which always inserts the `--` argv separator (`args: ["-arn", "--", pattern, path]`).
 *  Mirrors {@link proofScopePath}'s discriminator: the legacy fenced shape carries no separator and
 *  its pattern/path split is not recoverable from `args`, so it is out of scope, never guessed. */
function proofGrepPatternAndPath(w: WhitelistedProof): { pattern: string; path: string } | undefined {
  if (w.kind !== "grep" || w.args[1] !== "--") return undefined;
  return { pattern: w.args[2], path: w.args[3] };
}

/** The 0-based raw line index of the first line containing `pattern` case-insensitively — the line
 *  a "case-only" cause's message quotes. A plain substring search, never a regex: the WARN/SILENT
 *  decision already came from {@link classifyGrepZeroHit}, and this only locates which line to show
 *  a human. Returns `undefined` when a literal search cannot re-locate it, so the caller degrades
 *  to a message with no quoted line rather than guessing wrong. */
function firstLineIndexCaseInsensitive(lines: readonly string[], pattern: string): number | undefined {
  const needle = pattern.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) return i;
  }
  return undefined;
}

/** The 0-based raw line span a "line-seam" phrase straddles. It walks `fileText` once, replicating
 *  the exact collapse `classifyGrepZeroHit`'s `whitespaceNormalised` performs (a newline plus the
 *  following indentation becomes one space), so a literal search lands on the seam the classifier's
 *  BRE match already confirmed. Not a second implementation of the CAUSE decision — only of where
 *  to point a human. Returns `undefined` when the search cannot re-find the span or the match sits
 *  on one physical line; the caller then quotes no lines. */
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

/** Every `grep:` proof whose named file exists and whose pattern is a POSITIVE detection of
 *  unmatchability: {@link classifyGrepZeroHit} returns "line-seam" or "case-only". Silent otherwise
 *  — not on disk yet, absent in every probed form (both legitimate forward references), or already
 *  matching today (`executed_stale`'s business, W1-T273). WARN-only, with no override. */
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
// The house `grep:` DIALECT always compiles to `["-arn", "--", pattern, path]`, so it is BRE and
// only BRE, author-unselectable: that arm cannot diverge and is not this check's business. The
// LEGACY fenced shape passes the author's own argv through, so `-E` is reachable there and nothing
// inspects it — `proofGrepSafetyViolations` matches `^grep:` first, so a backticked proof never
// reaches `breMetacharsIn`. This check finds that arm through {@link
// WhitelistedProof.authorSelectedArgv}, set only by that branch, never re-derived from `args`.
// BEHAVIOURAL, NOT LEXICAL: a pattern valid under both engines that MEANS DIFFERENT THINGS carries
// nothing in its text to distinguish it, so it is compiled both ways and lines counted. `?` MUST
// NOT move from `BRE_WARNING_METACHARS`. Why: W1-T2294 (measured on `mergeConflict?:`).

/** The 7 characters that are METACHARACTERS in a POSIX EXTENDED regular expression but LITERAL in a
 *  BASIC one unless escaped — the set `grep-zero-cause.ts`'s `JS_METACHAR_LITERAL_IN_BRE` tracks,
 *  kept in sync by both being the measured BRE/ERE difference rather than by an import. `.`, `*`,
 *  `^`, `$`, `[`, `]` are absent: they mean the same in both engines and cannot diverge. */
const ERE_ONLY_METACHARS = new Set(["?", "+", "|", "(", ")", "{", "}"]);

/** `pattern` rewritten so a JS `RegExp` reads it the way a BRE does. It reuses {@link
 *  BRE_CONSTRUCT_AFTER_BACKSLASH}, named rather than counted so the two cannot drift again. */
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

/** Longest translated regex source this check compiles — the bound `grep-zero-cause.ts` and
 *  `ledger-grep.ts` use, for the same reason: a pattern arrives as free-form proof text, and this
 *  module compiles it into a backtracking `RegExp` with no timeout. */
const MAX_ENGINE_PROBE_SOURCE_LENGTH = 200;

/** Compile `source` as a `RegExp`, declining rather than guessing when it is too long, is
 *  ReDoS-shaped (the nested-quantifier `(a+)+`/`(a*)*` trigger), or is not valid JS regex. */
function boundedRegExp(source: string, flags: string): RegExp | undefined {
  if (source.length > MAX_ENGINE_PROBE_SOURCE_LENGTH) return undefined;
  if (/\([^()]*[+*][^()]*\)[+*]/.test(source)) return undefined;
  try {
    return new RegExp(source, flags);
  } catch {
    return undefined;
  }
}

/** Count of lines in `fileText` the compiled pattern matches — the same unit `grep -n` reports. */
function lineHitCount(re: RegExp, fileText: string): number {
  let hits = 0;
  for (const line of fileText.split("\n")) if (re.test(line)) hits++;
  return hits;
}

/** The (pattern, path) a LEGACY fenced `grep:` proof's raw argv names. Flags before the `--`
 *  separator are the author's own and irrelevant to WHAT is searched: the first non-flag token is
 *  the pattern, the last the path, and `undefined` when the argv carries no path. */
function legacyGrepPatternAndPath(args: readonly string[]): { pattern: string; path: string } | undefined {
  const sepIdx = args.indexOf("--");
  const rest = sepIdx === -1 ? args.filter((a) => !a.startsWith("-")) : args.slice(sepIdx + 1);
  if (rest.length < 2) return undefined;
  return { pattern: rest[0], path: rest[rest.length - 1] };
}

/** Every LEGACY (author-argv) `grep:` proof whose pattern reads a DIFFERENT hit count under BRE
 *  than under ERE against its named file. Silent whenever: no `opts.readGrepProofFile` reader, the
 *  proof is the house dialect form (which never diverges), the file is not on disk yet, either
 *  engine declines to compile the pattern, or both engines agree. WARN-only, like {@link
 *  proofGrepUnmatchableViolations}: a proof pinned to one engine on purpose is not necessarily
 *  wrong, so this names the disagreement for a human to judge. */
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
// `scopeGuardOutOfScopeFiles` compares a branch's diff against the declared `files:` by EXACT Set
// membership, never a prefix or glob, so a proof naming a path outside that set is guaranteed to
// trip it once the work is done. `lint-plan` used to pass such a task: it validates proof SHAPE and
// RESOLVABILITY, never whether the artifact a proof names is inside the task's own scope.
// THE REAL CONSEQUENCE IS A VERDICT, NOT A REFUSAL: `judgeCriterion` grades a pure-path
// `unit test:` proof `not_yet_built` only when its path is in `forwardReferenceFiles`, built from
// this task's `files:`, so a path outside it grades `executed_fail` when absent at review,
// overriding keyword coverage and failing the PR. It REUSES parseWhitelistedProof, so it cannot
// disagree with `rmd check-proof`. SEVERITY DEFAULTS TO WARN, measured; ONE CONJUNCTION
// AUTO-ESCALATES to block — a mis-declared path ALSO absent at head AND `verify: auto`.
// Why: docs/forensics/task-linter.md#proofscopeviolations (W1-T310, W1-T309, W1-T2287).

/** The repo-relative path a {@link WhitelistedProof} names, or `undefined` when it names none. It
 *  mirrors how parseTestTarget/parseDialectGrep build `label`/`args`: a test-kind proof's `label`
 *  IS the literal path unless `nameFiltered`, and a grep-kind proof's path is the token after the
 *  `--` separator. A legacy fenced proof carries none, so it names no path here. */
function proofScopePath(w: WhitelistedProof): string | undefined {
  if (w.kind === "test") return w.nameFiltered ? undefined : w.label;
  return w.args[1] === "--" ? w.args[3] : undefined;
}

/** Every criterion whose proof names a path OUTSIDE the task's declared `files:`. WARN by default,
 *  auto-escalated to "block" only when the path is also absent at head (per `opts.moduleExists`)
 *  and the task is `verify: auto`. See the section comment above. */
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
    // NO PREDICATE ⇒ NO ESCALATION: absent `opts.moduleExists` this stays the plain warn default
    // rather than guessing at disk state (W1-T2287).
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
// A name-filtered `unit test: <title>` proof is NOT a regex against real test titles.
// parseTestTarget runs `escapeRegExp` on the body FIRST, so every metacharacter matches only ITSELF.
// A title written with `.` standing in for a symbol resolves to ZERO real tests and reads
// `not_executable` — silently, while the criterion falls back to the keyword floor looking healthy.
// It REUSES resolveNameFilteredCandidates, the resolver `execWhitelistedProof` itself calls, so lint
// and review cannot disagree; that resolver greps a real checkout, so it is INJECTED. THE ZERO-MATCH
// WARN IS NARROWED, measured, to "carries a metacharacter AND does not read as a narrative".
// Why: docs/forensics/task-linter.md#proofnameresolutionviolations (W1-T488, W1-T245/#651).

/** Mirrors the character class `escapeRegExp` (review.ts, not exported) makes inert on a
 *  name-filtered proof's raw title. Detection only, used to NAME which characters a title carries
 *  for the warning message; the resolution decision comes from the injected resolver alone. */
const LITERAL_ONLY_METACHARS_RE = /[.*+?^${}()|[\]\\]/g;

/** The distinct regex metacharacters `rawName` contains, in first-seen order — what the title would
 *  have meant as a wildcard, anchor, group or class had escaping not made it literal. */
export function literalOnlyMetacharsIn(rawName: string): string[] {
  return [...new Set(rawName.match(LITERAL_ONLY_METACHARS_RE) ?? [])];
}

/** Every name-filtered `unit test:` proof whose raw title resolves to ZERO tests (narrowed as
 *  above) or into MANY test files. WARN-only with no override ever: zero is legitimately a forward
 *  reference, so blocking would refuse correct authoring at scale. Silent absent the resolver. */
export function proofNameResolutionViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  // The reviewer's own resolver, called directly, so lint and review cannot disagree.
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
// An amendment to an ALREADY-MERGED task's criteria is unreachable by every rung: MERGED is
// terminal in the status layer, the drain skips a merged id outright, and the retro's plan-health
// sweep scopes itself away from a closed task. So a claim added after the fact sits in the plan
// looking authoritative and is never dispatched, reviewed, or proven. Standing rule 21 names the
// house answer in prose; this check makes that answer CHECKED rather than conventional.
// THE INJECTION PROBLEM: merge state and the base-ref criteria set are I/O and this module is pure,
// so both arrive through {@link LintOpts.postMergeAmendment}, and nothing here imports status.ts or
// an exec surface. Why: docs/forensics/task-linter.md#postmergeamendmentviolations.

/** Trim-and-collapse-whitespace key for a criterion, keyed on the CLAIM ALONE. Set membership, not
 *  positional equality, so reordering the `acceptance:` list or a reflow never trips this check.
 *  WHY CLAIM-ONLY: rule 21 exists to stop a criterion orphaning silently, and rewording a proof
 *  orphans nothing — the contract is unchanged, only how it is checked. Keying on claim+proof made
 *  a proof reword indistinguishable from a new criterion.
 *  WHAT THIS ALONE STOPS CATCHING, named rather than hidden: a claim kept with its proof swapped
 *  for a WEAKER one. {@link criteriaProofChanged} is that comparison. Why: W1-T1098, W1-T2254. */
function criterionKey(c: AcceptanceCriterion): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  return norm(c.claim ?? "");
}

/** Criteria in `currentCriteria` whose claim appears nowhere in `baseCriteria` — covering both an
 *  outright ADDITION and a semantic CHANGE, since by set membership a changed claim is a new one. A
 *  claim held constant while only its proof is reworded is NOT an addition (see {@link
 *  criterionKey}). `baseCriteria` undefined ⇒ no additions: nothing to diff against. */
export function criteriaAdded(
  baseCriteria: AcceptanceCriterion[] | undefined,
  currentCriteria: AcceptanceCriterion[],
): AcceptanceCriterion[] {
  if (!baseCriteria) return [];
  const baseKeys = new Set(baseCriteria.map(criterionKey));
  return currentCriteria.filter((c) => !baseKeys.has(criterionKey(c)));
}

/** Which of the follow-ups filed in this PR actually carry an added criterion — keyed on {@link
 *  criterionKey}, the same normalisation {@link followUpCarriesCriteria} decides `followUpFiled`
 *  with, so a message can never name a task the decision did not consider.
 *  MESSAGE PRECISION ONLY, no verdict moves: the refusal fires on `added.length > 0 &&
 *  !escapeAvailable` and neither term reads this. It exists because `ctx.followUpTaskIds` is EVERY
 *  new task in the PR, while `followUpFiled` turns on which of them carry the criteria (W1-T2375). */
function followUpTaskIdsCarrying(added: AcceptanceCriterion[], candidateTasks: Task[]): string[] {
  const addedKeys = new Set(added.map(criterionKey));
  return candidateTasks.filter((t) => (t.acceptance ?? []).some((c) => addedKeys.has(criterionKey(c)))).map((t) => t.id);
}

/** True iff EVERY criterion in `added` is carried by at least one task in `candidateTasks` — Rule
 *  21's follow-up escape hatch, so the amended criteria have a home that will be dispatched.
 *  Matched by {@link criterionKey}, claim only, and vacuously true when `added` is empty. The
 *  caller scopes `candidateTasks`; this function does no scoping of its own. */
export function followUpCarriesCriteria(added: AcceptanceCriterion[], candidateTasks: Task[]): boolean {
  if (added.length === 0) return true;
  // EVERY added criterion, not just one. This read `some`/`some` until 2026-08-26, so a PR could
  // add five criteria to a MERGED task, carry one, and pass -- the exact orphaning Rule 21 exists
  // to stop, reached through its own escape. Retrofit over 823 plan commits: tightening refuses
  // nothing that has ever happened. Why: docs/forensics/task-linter.md#followupcarriescriteria.
  const carried = new Set(candidateTasks.flatMap((t) => (t.acceptance ?? []).map(criterionKey)));
  return added.every((c) => carried.has(criterionKey(c)));
}

/** The phrase a PR uses to state that an amended parent is only PARTLY superseded: the follow-up
 *  carries the amended criteria, but the parent's own criteria still stand, so it stays
 *  dispatchable. Deliberately a MARKER rather than free prose — the check must be unable to guess,
 *  and nobody can satisfy it by accident. Named in the refusal so it is discoverable. */
export const PARENT_SURVIVES_MARKER = "PARENT SURVIVES:";

/** Whether this PR has STATED the amended parent's disposition. Two ways, accepted equally: FULLY
 *  SUPERSEDED, the parent out of dispatch at `status: "blocked"`; or PARTLY SUPERSEDED, the parent
 *  still dispatchable with {@link PARENT_SURVIVES_MARKER} in its prose naming what remains.
 *  KEYED ON DISPATCHABILITY, NOT ON THE FIELD: `isDispatchEligible` reads `t.status === "blocked"`
 *  and drain.ts references `retirement` zero times, so a `retirement:` field alone leaves the parent
 *  selectable — and one instance did exactly that and was dispatched anyway. READS THE HEAD STATE,
 *  NOT THE DELTA, so `baseTask` is unused, kept only so a future arm need not re-thread it.
 *  NEVER WRITES OR INFERS A DISPOSITION — a retirement is an operator act. Why: W1-T2375. */
export function parentDispositionStated(task: Task, _baseTask?: Task): boolean {
  if (task.status === "blocked") return true;
  const prose = `${task.note ?? ""}\n${task.rationale ?? ""}`;
  return prose.includes(PARENT_SURVIVES_MARKER);
}

/** Context for {@link blockedDispositionViolations} — the task's shard at the PR's base ref, the
 *  same value {@link PostMergeAmendmentContext.baseTask} carries, resolved once per task by the
 *  caller. It is a DEDICATED context rather than a field on that interface because this check has
 *  nothing to do with merge status: sharing would let an unrelated concern's presence gate it by
 *  accident. Undefined ⇒ silent. Why: W1-T2487. */
export interface BlockedDispositionContext {
  /** Undefined when the task is new in this PR, or the caller could not resolve a base version —
   *  the "nothing to diff against" contract every base-ref context in this file uses. */
  baseTask?: Task;
}

/** A `status: "blocked"` task must NAME its disposition — one of {@link RETIREMENT_REASONS} — the
 *  moment THIS DIFF is what puts it there. W1-T2474 made the field load-bearing, so an absent field
 *  is no longer untidiness: a consumer reading a field missing on half its population is defaulting.
 *  TRANSITION-SCOPED, NOT A THIRD SWEEP. `opts.blockedDisposition` is populated only in the
 *  changed-tasks (`--base`) pass, so the whole-plan pass returns `[]` for every task; refusing the
 *  standing population at once would redden every PR that touches the plan. Within that pass a
 *  `ctx.baseTask` that was also blocked warns, and anything else blocks. A VALUE OUTSIDE {@link
 *  RETIREMENT_REASONS} IS TREATED AS ABSENT — "present" means present AND legal, so a bogus string
 *  cannot slip past, and nothing here writes or infers one. Why: W1-T2487, W1-T2474. */
export function blockedDispositionViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  if (task.status !== "blocked") return [];
  const ctx = opts.blockedDisposition;
  if (!ctx) return []; // whole-plan pass: no base to compare against, so no opinion at all
  const hasLegalDisposition = task.retirement !== undefined && (RETIREMENT_REASONS as readonly string[]).includes(task.retirement);
  if (hasLegalDisposition) return [];
  const legalValues = RETIREMENT_REASONS.join("|");
  const wasAlreadyBlocked = ctx.baseTask?.status === "blocked";
  if (wasAlreadyBlocked) {
    return [
      {
        check: "blocked-task-disposition",
        severity: "warn",
        message:
          `task ${task.id} is status: blocked with no \`retirement:\` naming its disposition (one of ` +
          `${legalValues}) — reported, not refused: it was already blocked before this PR, and W1-T2487 ` +
          "gates only the transition INTO blocked, never the standing population.",
      },
    ];
  }
  return [
    {
      check: "blocked-task-disposition",
      severity: "block",
      message:
        `task ${task.id} moves to status: blocked in this PR with no \`retirement:\` naming its ` +
        `disposition — refused. Name one of ${legalValues} (a retirement is an operator act; nothing ` +
        "here infers one for you).",
    },
  ];
}

// ── BLOCKED-RECORD DISPOSITION CENSUS (W1-T2634) ────────────────────────────────────────────────
// {@link blockedDispositionViolations} above fires only inside the changed-tasks pass, and only for
// a task the diff touches — deliberately, since refusing the whole standing population at once is
// the wedge W1-T2481 measured, but that leaves the STANDING population invisible to every pass.
// This closes the gap without reopening that one: it runs UNCONDITIONALLY, with no `LintOpts`
// field, and reads the LOADED `Task`'s own `status`/`retirement` rather than raw plan text.
// WARN-ONLY BY CONSTRUCTION, since a blocking arm would reproduce that wedge one field over.
// IT NAMES; IT DOES NOT RULE, inferring nothing from prose.
// Why: docs/forensics/task-linter.md#blockedrecordunruledviolations (W1-T2634, W1-T391).

/** A `status: "blocked"` task carrying no LEGAL `retirement:` value is NAMED, unconditionally, in
 *  every lint pass; length is always 0 or 1. WARN-ONLY BY CONSTRUCTION: no `opts` parameter, so no
 *  caller can run it blocking. The message names both remedies, so the fix is discoverable. */
export function blockedRecordUnruledViolations(task: Task): LintViolation[] {
  if (task.status !== "blocked") return [];
  const hasLegalDisposition = task.retirement !== undefined && (RETIREMENT_REASONS as readonly string[]).includes(task.retirement);
  if (hasLegalDisposition) return [];
  return [
    {
      check: "blocked-record-unruled",
      severity: "warn",
      message:
        `task ${task.id} is status: blocked with no \`retirement:\` naming its disposition — named, ` +
        `never ruled on (W1-T2634 only reports; it does not decide for you). Either record a ` +
        `\`retirement:\` ruling (one of ${RETIREMENT_REASONS.join("|")}), or state in prose why the ` +
        "record is waiting rather than retired.",
    },
  ];
}

/** Context the CALLER resolves via I/O and injects through {@link LintOpts} — see the section
 *  comment above for why it cannot be fetched here. */
export interface PostMergeAmendmentContext {
  /** False iff the derived merge status could not be resolved at all (`gh` unavailable, no token,
   *  `loadConfig`'s CI trap). FAIL OPEN, deliberately: an unreadable status never produces a
   *  violation, so a GitHub outage never reds the one lane — plan-only PRs — that still works. */
  statusResolvable: boolean;
  /** This task's derived status is MERGED. Only a merged task can be amended post-merge; an
   *  open task's criteria changing is ordinary authoring. */
  merged: boolean;
  /** This task's acceptance criteria at the PR's base ref. Undefined when the task is new here or
   *  the caller could not resolve a base version — either way {@link criteriaAdded} is a no-op. */
  baseAcceptance?: AcceptanceCriterion[];
  /** Whether some OTHER task in the same changed set already carries the added criteria — the
   *  follow-up escape hatch. The caller computes it across the whole changed set, since a single
   *  task's lint cannot see its siblings. */
  followUpFiled: boolean;
  /** The ids of the tasks that satisfied {@link followUpFiled}, resolved by the same call site
   *  that already builds `followUpTasks`. Used only to NAME the follow-up in the refusal; the
   *  decision never reads it. */
  followUpTaskIds?: string[];
  /** The follow-up TASKS behind {@link followUpFiled} — the array the call site already builds, so
   *  carrying it needs no new resolution. Supplied ⇒ the refusal names only those that actually
   *  carry an added criterion ({@link followUpTaskIdsCarrying}); omitted ⇒ it falls back to {@link
   *  followUpTaskIds} verbatim. The decision never reads either. Why: W1-T2375. */
  followUpTasks?: Task[];
  /** This task's WHOLE shard at the PR's base ref, not just its `acceptance:`. The call site
   *  already resolves this task to read {@link baseAcceptance} off it, so carrying the whole object
   *  costs no new git read. Undefined under the same conditions as {@link baseAcceptance}.
   *  Why: W1-T2254. */
  baseTask?: Task;
}

/** Diff-scoped base-ref state for {@link sizingViolation}'s risk:high `band_meaning` obligation.
 *  INVARIANT: presence of THIS OBJECT, not a non-undefined `baseTask` inside it, is the "this is a
 *  diff" signal — so a genuinely NEW task is distinguishable from a caller with no diff context,
 *  even though both read `baseTask === undefined`. A caller already resolving {@link
 *  PostMergeAmendmentContext.baseTask} reuses that same lookup here. Why: W1-T2503, W1-T2254. */
export interface RiskTransitionContext {
  /** This task's record in the base-ref plan snapshot. `undefined` ⇒ the task is NEW in this diff,
   *  and always means "looked it up, found nothing", never "didn't look". */
  baseTask: Task | undefined;
}

/** Fields on a merged task's shard that something ELSE still reads AFTER the task merges, so a
 *  post-merge edit silently changes live behaviour nobody signed off on: `status` feeds dispatch
 *  eligibility, `files` overlap serialization, `depends_on` the DAG, `priority` the comparator,
 *  `risk`/`verify`/`type`/`principles`/`budget_usd` a lane, gate or spend cap, and `retirement`
 *  the board's bucketing. DELIBERATELY EXCLUDED, named rather than left implicit: `title`, `note`
 *  and `rationale` are prose an amendment is expected to touch, `hand_built` has zero consumers,
 *  and the rest have no documented post-merge consumer. THE TEST FOR MEMBERSHIP is "does anything
 *  read this after the task merges", never "is this field conceptually final". Why: W1-T2254 §Q1. */
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

/** Human-readable rendering of a reported field's value for a violation message. Never used to
 *  compare — only to display both sides once `JSON.stringify` equality has detected a change. */
function reportedFieldDisplay(v: unknown): string {
  if (v === undefined) return "(absent)";
  if (typeof v === "string") return JSON.stringify(v);
  return JSON.stringify(v);
}

/** Every {@link REPORTED_MERGED_FIELDS} entry whose value differs between `baseTask` and `task`.
 *  REPORT ONLY, never a block: W1-T2248 ruled that a merged `files:` can be provably wrong and must
 *  stay correctable, so this is a DETECTOR, not a lock — the change becomes a declared, visible act
 *  rather than a forbidden one. `baseTask` undefined ⇒ no violations. */
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

/** Criteria in `baseCriteria` whose claim appears nowhere in `currentCriteria` — the mirror of
 *  {@link criteriaAdded}: a merged criterion REMOVED outright. `criteriaAdded` cannot see this,
 *  because removing an entry shrinks the current set, so nothing in it fails to match a base key
 *  and the check reads as "no delta". Keyed on {@link criterionKey}. Why: W1-T2254 §(4). */
export function criteriaRemoved(
  baseCriteria: AcceptanceCriterion[] | undefined,
  currentCriteria: AcceptanceCriterion[],
): AcceptanceCriterion[] {
  if (!baseCriteria) return [];
  const currentKeys = new Set(currentCriteria.map(criterionKey));
  return baseCriteria.filter((c) => !currentKeys.has(criterionKey(c)));
}

/** Criteria present in BOTH sets under the same {@link criterionKey} whose `proof` text differs —
 *  the gap `criterionKey`'s own doc names as unstopped: a claim kept with its proof swapped for a
 *  WEAKER one is invisible to `criteriaAdded`, which compares claims and never proofs. */
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

/** The phrase a rationale uses to record that a title-level claim was later falsified and
 *  corrected. `renderImplementPrompt` renders `task.prompt ?? task.title` — the frozen title, for
 *  every dispatched build — so a correction recorded only in `rationale:` never reaches a worker.
 *  Rule 21 permits the correction to land in `rationale:` post-merge but does not permit the title
 *  to change, so the remedy is a field the worker actually reads, never a relaxed freeze. A MARKER,
 *  not a heuristic, for the same reason {@link PARENT_SURVIVES_MARKER} is one. Why: W1-T2438. */
export const RATIONALE_CORRECTION_MARKER = "CORRECTS TITLE:";

/** Whether `task.rationale` states, via {@link RATIONALE_CORRECTION_MARKER}, that a title-level
 *  claim was later falsified. Exported so a test can drive the marker directly. */
export function rationaleRecordsCorrection(task: Task): boolean {
  return (task.rationale ?? "").includes(RATIONALE_CORRECTION_MARKER);
}

/** A task whose rationale records a correction but carries no `prompt:` — the composition W1-T2438
 *  catches: the only field Rule 21 lets an amendment change is not the field
 *  `renderImplementPrompt` reads, so the correction is invisible to every dispatched build. REPORT
 *  ONLY, like {@link mergedFieldChangeViolations}: it never blocks and never writes a `prompt:` for
 *  anyone. `task.prompt` present and non-blank ⇒ no violation. It gates on NOTHING about the
 *  title's own text: only a recorded, marker-stated correction with no `prompt:` trips it. */
export function correctionWithoutPromptViolation(task: Task): LintViolation | undefined {
  if (!rationaleRecordsCorrection(task)) return undefined;
  if (task.prompt && task.prompt.trim()) return undefined;
  return {
    check: "post-merge-correction-without-prompt",
    severity: "warn",
    message:
      `task ${task.id} is already MERGED and its rationale records a correction (carries ` +
      `"${RATIONALE_CORRECTION_MARKER}") but declares no \`prompt:\` — \`renderImplementPrompt\` ` +
      "(run-task.ts) renders `task.prompt ?? task.title`, so a dispatched build reads only the " +
      "frozen title and never sees this correction. The title stays frozen (Rule 21); add a " +
      "`prompt:` carrying the corrected brief instead.",
  };
}

/** Every acceptance criterion this PR adds or changes on an ALREADY-MERGED task, absent a follow-up
 *  in the same PR to carry it. No {@link LintOpts.postMergeAmendment} ⇒ skipped entirely, since the
 *  pre-dispatch site never dispatches a merged task and so never supplies it. Four REPORT-ONLY
 *  checks run under the same three early exits (no context, unresolvable status, not merged) but
 *  are NOT gated by `followUpFiled`: that escape is specific to the criteria-orphaning harm the
 *  BLOCK prevents, and a warn never blocks anyway. See {@link mergedFieldChangeViolations}, {@link
 *  criteriaRemoved}, {@link criteriaProofChanged} and {@link correctionWithoutPromptViolation}. */
export function postMergeAmendmentViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  const ctx = opts.postMergeAmendment;
  if (!ctx) return [];
  if (!ctx.statusResolvable) return []; // fail OPEN on an unreadable derived status
  if (!ctx.merged) return []; // only a merged task's criteria can orphan this way
  const currentCriteria = task.acceptance ?? [];
  const violations: LintViolation[] = [];
  const added = criteriaAdded(ctx.baseAcceptance, currentCriteria);
  // The escape has TWO conditions, not one: filing a follow-up gives the amended criteria a second
  // home, it does not take the first away. Measured once, a follow-up left its parent dispatchable
  // for 12h37m and the fleet built both in parallel. This is A CONDITION ON THE ESCAPE, not a
  // fourth violation, so the blocking surface stays one predicate wide (W1-T2375, W1-T2248).
  const dispositionStated = parentDispositionStated(task, ctx.baseTask);
  const escapeAvailable = ctx.followUpFiled && dispositionStated;
  if (added.length > 0 && !escapeAvailable) {
    // Prefer the CARRYING subset when the caller supplies the tasks, else the id list. An empty
    // carrying subset falls back too rather than naming nothing: this narrows a message, it never
    // blanks one (W1-T2375).
    const carrying = ctx.followUpTasks ? followUpTaskIdsCarrying(added, ctx.followUpTasks) : [];
    const followUps = carrying.length > 0 ? carrying : ctx.followUpTaskIds ?? [];
    const namedFollowUps = followUps.length > 0 ? followUps.join(", ") : "the follow-up filed here";
    violations.push(
      ...added.map((c) => ({
        check: "post-merge-amendment" as const,
        severity: "block" as const,
        message: ctx.followUpFiled
          ? `task ${task.id} is already MERGED, and this PR adds/changes acceptance criterion ` +
            `("${(c.claim ?? "").slice(0, 80)}") with a follow-up (${namedFollowUps}) carrying it — but ` +
            `${task.id}'s own disposition is unstated, so BOTH stay dispatchable and the fleet can build ` +
            `both. Standing rule 21's follow-up escape gives the criteria a second home; it does not take ` +
            `the first away. State which case this is: move ${task.id} to status: blocked if it is fully ` +
            `superseded, or say what remains in its own note with "${PARENT_SURVIVES_MARKER}" if it is ` +
            "partly superseded. Nothing here retires anything for you — a retirement is an operator act."
          : `task ${task.id} is already MERGED, but this PR adds/changes acceptance criterion ` +
            `("${(c.claim ?? "").slice(0, 80)}") with no follow-up task carrying it filed in the same PR — ` +
            "Standing rule 21: MERGED is terminal (an amendment does not re-queue the task), the drain " +
            "skips a merged id outright, and the retro sweep skips a closed one, so this criterion would " +
            "orphan silently; file a follow-up task carrying it in this SAME PR",
      })),
    );
  }
  // Report-only widening past the single guarded field. Nothing here rewrites a field back to its
  // base value; it only names the drift (W1-T2254).
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
  // The frozen title is the only field renderImplementPrompt reads, so a correction Rule 21 permits
  // in `rationale:` reaches no dispatched build until it also lands in `prompt:` (W1-T2438).
  const correction = correctionWithoutPromptViolation(task);
  if (correction) violations.push(correction);
  return violations;
}

// ── PROVENANCE (Rules 16/17) ─────────────────────────────────────────────────
// plan.ts's loader already guarantees `risk:` — it validates against TASK_RISKS and defaults an
// omitted one, a load-time contract rather than a linter concern. The remaining gap is `origin:`,
// which the loader does NOT default: every task must name where it came from.

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
// A worker's proof that a ruling was WRITTEN is not an operator RATIFYING it. `isDispatchEligible`
// already refuses any task whose `verify !== "auto"`, so a ruling-shaped task at verify:human
// simply PARKS until the operator looks; only the rule that puts it there was missing.
// TRIGGER A ONLY — `files:` contains the exact literal "DECISIONS.md", and a mixed diff still
// triggers, since that is how the entry rides in unnoticed. TRIGGER B, a ruling-shaped TITLE, is
// DELIBERATELY NOT SHIPPED: a bare word match misfires on the very task introducing this check.
// Why: docs/forensics/task-linter.md#rulingverifyviolation (W1-T326, #1302/#1303, W1-T353).

/** The exact repo-relative path this repo's decision log lives at — the literal `files:` entry
 *  {@link rulingVerifyViolation} looks for. */
const DECISIONS_LOG_PATH = "DECISIONS.md";

/** A task whose `files:` includes the decision log but is not verify:human — W1-T326's exact shape.
 *  TRIGGER A only; see the section comment for why the title-word trigger B is not shipped. */
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
// An undeclared `files:` lints clean and then serialises the lane: `overlappingPaths` is
// fail-closed on it, and `undeclaredScopeLast` only demotes such a task to the end of its priority
// tier. Demotion is not containment — a demoted total-blocker that becomes the only eligible
// candidate still serialises everything behind it. THE PREDICATE IS `undeclaredScopeLast`'s OWN,
// restated rather than imported, and the two are pinned by test rather than by coupling.
// DISPATCHER-UNREACHABLE EXEMPTION: `isDispatchEligible` refuses at `t.verify !== "auto"` BEFORE
// any path is read. It gates on `verify`, not `type: manual`, and is SELF-LAPSING, so a re-banded
// record blocks again on the next run.
// Why: docs/forensics/task-linter.md#declaredscopeviolation (W1-T504, W1-T476, W1-T1030).

/** A task whose `files:` is absent, or present and empty. EXEMPT when `verify: human`: such a task
 *  never reaches `isDispatchEligible`'s path-reading step, and the exemption lapses the instant
 *  `verify` reads `auto` again. See the section comment for why this blocks. */
export function declaredScopeViolation(task: Task): LintViolation | undefined {
  if (!(task.files === undefined || task.files.length === 0)) return undefined;
  if (task.verify === "human") return undefined;
  // `isDispatchEligible` refuses `t.status === "blocked"` before it reaches `overlappingPaths`, the
  // only place an undeclared scope can serialise the lane, so a blocked record cannot produce that
  // harm. The exemption keys on the SAME `status` field the dispatcher gates on, not on
  // `retirement:` — which a blocked-and-unscoped record cannot acquire without first tripping this
  // rule, the deadlock this breaks. Un-blocking is a plan edit, so a `--base` pass re-lints the
  // record the moment it becomes dispatchable: the check moves, it is not removed (W1-T2481).
  if (task.status === "blocked") return undefined;
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
// THE MECHANISM. `judgeReview` computes `planOnly = diffFiles.every(isInPlanScope)`, then
// `criteriaTampered = !planOnly && criterionFieldTampered(evidence.diff)`. Withdrawing or repairing
// a record NECESSARILY removes a `claim:`/`proof:` line, which is what `criterionFieldTampered`
// fires on, so the moment ONE declared path falls outside plan scope the carve-out is gone and the
// PR is refused however good the work is — and a dispatched worker gets one PR per run.
// A LITERAL PATH, NOT "ANY PLAN-SCOPE PATH": broadening the clause fires on ~18 legitimate
// config-plus-reader pairings. ONE TRIGGER ONLY, the monolith path and a `plan/tasks.d/` shard.
// Why: docs/forensics/task-linter.md#rule15filingviolation (W1-T384, #1295/#1416, W1-T399/#1060).

/** The exact repo-relative path this repo's task monolith lives at — the literal `files:` entry
 *  {@link rule15FilingViolation} keys on, alongside {@link TASKS_SHARD_PATH_RE}. */
const TASKS_MONOLITH_PATH = "plan/tasks.yaml";

/** A `plan/tasks.d/<id>-<slug>.yaml` (or `.yml`) shard — the ONLY other place a task record
 *  lives (W1-T399). Matched structurally (a `plan/tasks.d/` prefix, one path segment, a
 *  `.yaml`/`.yml` suffix) rather than a loose glob, mirroring `src/lib/review.ts`'s
 *  `isTaskRecordPath`. Widened to `.ya?ml` (R-14, docs/audits/recon-2026-09-05.md): the loader
 *  (`listShardFiles` in plan.ts, `materializeOriginShards` in run-task.ts) accepts both
 *  extensions, so a `.yaml`-only match here let a task declare an out-of-plan-scope file
 *  alongside its own `.yml` shard and pass this filing-time check the identical `.yaml` shape
 *  would have blocked. */
const TASKS_SHARD_PATH_RE = /^plan\/tasks\.d\/[^/]+\.ya?ml$/;

/** True for the monolith or a shard — the two places {@link rule15FilingViolation} treats
 *  as "declares a task record". */
function isTaskRecordFile(f: string): boolean {
  return f === TASKS_MONOLITH_PATH || TASKS_SHARD_PATH_RE.test(f);
}

/** Retired or landed records, excluded from {@link rule15FilingViolation}. A withdrawal preserves
 *  the record, `files:` included, so without this exclusion the operator's plan-only PR withdrawing
 *  such a task would be blocked by the very check that task earned. Declared locally rather than
 *  imported, following W1-T369: a 3-literal Set carries none of an algorithm's drift risk. */
const NON_OPEN_FILING_STATUSES = new Set<TaskStatus>(["blocked", "merged", "done"]);

/** A task that declares a task record — the monolith or its own shard — alongside a path outside
 *  plan scope, at a `verify` the operator will not be asked to judge: the shape `remudero-review`
 *  can only ever refuse. See the section comment for the measured population behind the trigger. */
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
// A WARNING, never a block, when a task's resolved mount turn-budget sits below the observed class
// mean. The mean is ALWAYS an injected argument, read by the caller from MASTER-PLAN's
// current-cycle Calibration row or the retro's aggregate — never a hardcoded literal.

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
// A WARNING, never a block, on the optional `priority:` field that `compareDispatch` reads as its
// FIRST sort key. Two ways it rots silently: a value far outside the sanctioned band (a typo — a
// risk number or turn budget pasted into the wrong column), and a value left on a task that can no
// longer dispatch ({@link NON_OPEN_FILING_STATUSES}, reused unchanged). Neither can produce a
// WRONG verdict — a bad priority only degrades ORDERING — so blocking would overreach the failure
// mode. Why: W1-T422 design (iii).

/** Sanctioned `priority` band — wide enough to rank the whole open queue without doubling as an
 *  unbounded knob. A value outside it still sorts exactly where the comparator says; the warning
 *  exists because a value that far out is very likely a typo. */
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
// SECURITY.md routes OUTSIDE reporters to a private advisory, but nothing told the fleet's OWN
// filers that the same rule applies to a task shard: filing a task IS publishing on this repo,
// world-readable the moment it merges, and it can name a weakness that is not yet fixed.
// PRECISION OVER RECALL, MEASURED: a naive single-word scan hits 63% of the live corpus, wallpaper
// rather than signal, so every row below matches a PHRASE naming a weakness shape, never a noun.
// FIELDS: title + rationale + note; `design:` is DROPPED by the plan parser before a {@link Task}
// exists. WARN-ONLY BY CONSTRUCTION: no knob exists to run this blocking, and the routing decision
// is the operator's. Why: docs/forensics/task-linter.md#advisoryroutingviolations (W1-T519).

export interface AdvisoryRoutingMatcher {
  /** Surfaced in the warn message — the category text acceptance criterion 1 checks for. */
  category: string;
  /** PRECISION-FIRST: must fire only on phrasing that names an actual weakness shape, never on
   *  a bare noun this repo also uses benignly (scope/route/session/grant/tier). */
  pattern: RegExp;
  /** WHY this phrase is security-shaped — read by a reviewer auditing the table, never consumed by
   *  the matcher. A reviewer reads reasons, not a bare list (T427; the same discipline
   *  {@link ENFORCEMENT_DATA} in review.ts follows). */
  reason: string;
}

/** DATA table — a new phrase is a row here, with no engine change. The six categories are
 *  authentication/authorization weakness, token or credential leakage, secret handling,
 *  sandbox/containment escape or bypass, scope enforcement on a reachable route, and
 *  prompt-injection escalation. See the section comment for the precision measurement. */
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

/** `task`'s narrative text (title + rationale + note) matched against {@link
 *  ADVISORY_ROUTING_LEXICON}, shaped as an ARRAY to match this file's violation-family idiom.
 *  Length is 0 or 1, never more: only the FIRST matching category in table order is returned, so a
 *  task matching several entries still draws exactly one warn. WARN-only, with no override. */
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

// ── DUPLICATE-CLOSURE AT KNOWLEDGE INTAKE (W1-T420, narrowed W1-T2486) ───────
// ONE PURE MODULE (knowledge-dedup.ts's `bestNearDuplicate`), THREE CONSUMERS, TWO SEVERITIES,
// matched to population size and false-positive cost. Every consumer takes its corpus by parameter,
// so this module still reads no disk, and THE CUTOFF is MEASURED, not asserted.
// `duplicateTitleViolations` is ADVISORY, warn-only with no override, because title similarity is
// legitimately high for siblings in one arc. `unansweredDuplicateTitleViolations` is the NARROW
// BLOCKING ARM, not a promotion of it, and fires only on an unanswered near-certain match.
// `learningDuplicateViolation` is BLOCKING but unwired, since a `Task` carries no learning
// `fact`/`id` to hang it off, and ANSWERABLE, the W1-T365 shape.
// Why: docs/forensics/task-linter.md#duplicate-closure (W1-T420, W1-T2486, W1-T403/W1-T1062).

/** The shingle width the OPEN-PR SLUG corpus is scored at — 2, deliberately NOT {@link
 *  DEFAULT_SHINGLE_K}'s 3, chosen per call as `bestNearDuplicate`'s `opts.k` was built to allow.
 *  MEASURED on the two pairs filed minutes apart that nothing caught: k=3 misses one outright, and
 *  k=1 catches both but is unusable, its whole-plan false-positive load an order of magnitude
 *  higher. k=2 is the honest middle, and the missed pair sits EXACTLY on the cutoff there — stated
 *  rather than smoothed over. {@link DEFAULT_SHINGLE_K} is NOT changed: it is the measured default
 *  for the learnings corpus. Why: docs/forensics/task-linter.md#duplicate_slug_shingle_k. */
export const DUPLICATE_SLUG_SHINGLE_K = 2;

/** A plan shard path's `<id>` and filename `<slug>`, as a corpus entry whose `text` is the SLUG.
 *  `undefined` for any path that is not a `plan/tasks.d/<id>-<slug>.yaml` shard — a PR's changed-
 *  file list carries every kind of path, and only shard additions belong in the corpus. PURE. */
export function shardSlugFromPath(path: string): DuplicateCorpusEntry | undefined {
  const m = /(?:^|\/)tasks\.d\/(W1-T\d+[a-z]?)-(.+)\.ya?ml$/.exec(path.trim());
  return m ? { id: m[1], text: m[2] } : undefined;
}

/** The SLUG corpus for {@link duplicateTitleViolations}, built from changed-file paths. Deduped by
 *  id, first path per id wins. PURE: the caller does the GitHub read and hands the paths in.
 *  THE TEXT IS THE SLUG ALONE, NEVER SLUG-PLUS-TITLE. Joining the two is measurably WORSE, which is
 *  counter-intuitive enough to state where an implementer will read it: the house title style is
 *  long, distinctive prose, so it floods the shingle set and dilutes the short topical slug's
 *  signal. Measured on the two pairs above, the join scores roughly a quarter of the slug alone. */
export function planShardSlugCorpus(paths: readonly string[]): DuplicateCorpusEntry[] {
  const byId = new Map<string, DuplicateCorpusEntry>();
  for (const path of paths) {
    const entry = shardSlugFromPath(path);
    if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/** The corpus the caller supplies for {@link duplicateTitleViolations} to compare THIS task
 *  against. `undefined` or empty ⇒ the check is silent.
 *  W1-T1076 CHANGED WHAT `text` HOLDS; the field name is kept for continuity, not because it is
 *  still descriptive. The live caller supplies each open PR's added shard FILENAME SLUG (see
 *  {@link planShardSlugCorpus}), because titles score near zero on the pairs this check exists to
 *  catch. A caller that still passes titles gets W1-T420's original behaviour. */
export type OpenTaskTitleCorpus = readonly DuplicateCorpusEntry[];

/** ADVISORY, never blocking: this task scores >= cutoff against some OTHER entry in the supplied
 *  corpus. Absent `opts.openTaskTitles` ⇒ silent. It scores `opts.duplicateSlug` at
 *  `opts.duplicateShingleK` when the caller supplies them, and otherwise falls back byte for byte
 *  to W1-T420's title-at-{@link DEFAULT_SHINGLE_K} behaviour. */
export function duplicateTitleViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  const corpus = opts.openTaskTitles;
  if (!corpus || corpus.length === 0) return [];
  const cutoff = opts.duplicateTitleCutoff ?? DEFAULT_DUPLICATE_CUTOFF;
  // THE SLUG WHEN THERE IS ONE, THE TITLE OTHERWISE — never the two joined; {@link
  // planShardSlugCorpus} carries the measurement that rules the join out.
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

/** The near-identity cutoff for {@link unansweredDuplicateTitleViolations}'s BLOCKING arm. It sits
 *  far above {@link DEFAULT_DUPLICATE_CUTOFF}, above that constant's measured sibling ceiling, and
 *  above its reworded-near-duplicate band, so this arm catches only a near-VERBATIM restatement —
 *  never a paraphrase or a legitimate sibling. Raising the stakes to `block` therefore costs no
 *  false refusal against either measured population. NOT a change to {@link
 *  DEFAULT_DUPLICATE_CUTOFF} or to the scorer knowledge-dedup.ts owns: a separate, higher bar for a
 *  separate, narrower arm. */
export const NEAR_IDENTITY_DUPLICATE_CUTOFF = 0.9;

/** A near-duplicate corpus entry carrying what a plain {@link OpenTaskTitleCorpus} entry cannot
 *  answer: did the OTHER shard already clear this pair from its side? `Task` carries no
 *  `plan_refs` field, so a caller assembles this the way `opts.duplicateSlug` already threads slug
 *  data `Task` lacks. Both fields are optional and independently checked. */
export interface DuplicateAnswerCorpusEntry extends DuplicateCorpusEntry {
  /** This candidate's own `plan_refs` list, verbatim. Cleared when it contains the OTHER task's
   *  id exactly (an exact-string check — plan_refs is a flat list of citations, not prose). */
  planRefs?: readonly string[];
  /** This candidate's own `rationale` prose. Cleared when it NAMES the other task's id — the
   *  deterministic proxy for "says why it differs". A linter cannot grade whether prose correctly
   *  explains a difference; it can tell whether the id is named at all. */
  rationale?: string;
}

/** True iff `id` is named in `refs` by exact-string membership, or mentioned in `text` by a
 *  delimiter-bounded, case-insensitive match. The delimiter matters: `W1-T25` must never match a
 *  mention of `W1-T250`. Either surface clearing is enough; both directions of the citation check
 *  share this predicate. */
export function citesTaskId(refs: readonly string[] | undefined, text: string | undefined, id: string): boolean {
  if (refs?.includes(id)) return true;
  if (!text) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?:$|[^A-Za-z0-9-])`, "i").test(text);
}

/** BLOCKING, the narrow arm: this task scores >= {@link NEAR_IDENTITY_DUPLICATE_CUTOFF} against
 *  some OTHER entry in `opts.openTaskRecords`, AND neither shard has answered — this task does not
 *  cite the match (in `opts.taskPlanRefs` or its own `task.rationale`) and the matched entry does
 *  not cite this task back. Either citation, from either side, clears it, so a legitimate sibling
 *  pair is untouched; absent `opts.openTaskRecords` it is silent. NEVER answered by narrowing
 *  `files:` or deleting a proof, since it reads only the citation surfaces. Why: W1-T2486. */
export function unansweredDuplicateTitleViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  const corpus = opts.openTaskRecords;
  if (!corpus || corpus.length === 0) return [];
  const cutoff = opts.nearIdentityCutoff ?? NEAR_IDENTITY_DUPLICATE_CUTOFF;
  const scored = opts.duplicateSlug?.trim();
  const candidateText = scored && scored.length > 0 ? scored : task.title;
  const k = opts.duplicateShingleK ?? DEFAULT_SHINGLE_K;
  const match = bestNearDuplicate({ id: task.id, text: candidateText }, corpus, { k });
  if (!match || match.score < cutoff) return [];
  const matchEntry = corpus.find((e) => e.id === match.id);
  const thisCites = citesTaskId(opts.taskPlanRefs, task.rationale, match.id);
  const otherCites = citesTaskId(matchEntry?.planRefs, matchEntry?.rationale, task.id);
  if (thisCites || otherCites) return [];
  return [
    {
      check: "duplicate-title",
      severity: "block",
      message:
        `task ${task.id} scores ${match.score.toFixed(2)} (>= near-identity cutoff ${cutoff}, k=${k}) ` +
        `against ${match.id} and NEITHER shard cites the other — an UNANSWERED near-certain match, ` +
        `refused rather than merely flagged. TWO ANSWERS BOTH CLEAR THIS, and both are additive: CITE ` +
        `${match.id} (name it in plan_refs and say what it already covers), or SAY WHY IT DIFFERS in ` +
        `the rationale. Never answer this by deleting a proof, narrowing files:, or removing any other ` +
        "evidence — this check asks for a citation, never for less work.",
    },
  ];
}

/** A stated distinction naming the SAME id `bestNearDuplicate` matched — the W1-T365 exemption
 *  shape: an answerable refusal, cleared by the author explaining the difference. */
export interface DuplicateLearningDistinction {
  /** Must equal the matched entry's id for the exemption to apply. */
  existingId: string;
  /** Non-empty prose explaining how the new entry differs. */
  statement: string;
}

/** BLOCKING: a NEW active learning entry's `fact` scores >= cutoff against an entry already in the
 *  ACTIVE corpus. Clears when no match reaches cutoff, or when `distinction` names the matched id
 *  with a non-empty statement. Corpus and candidate arrive by parameter, so a real
 *  `learnings/*.yaml` read and a test fixture behave identically. */
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

/** CALL-SITE — the code is REACHED, not merely that it exists. NO EXISTING GATE CATCHES IT:
 *  `lint-plan` never opens src/, `tsc` is satisfied because a TEST is an importer,
 *  `coverage-ratchet` because a unit test covers 100% of it, and the reviewer runs those same tests.
 *  Every gate asks whether the code WORKS; none asks whether anything CALLS it. THE RULE: a task
 *  that will CREATE a src/ module must carry a criterion proving a CALL SITE in a DIFFERENT file.
 *  CALL vs MENTION, AND THE EXACT LIMIT: a pattern without the open paren passes on a COMMENT,
 *  which is how one proof exited 0 against entirely unbuilt work. This enforces THE SHAPE OF THE
 *  PROOF, which is mechanically decidable, and cannot verify the eventual hit is code.
 *  Why: docs/forensics/task-linter.md#callsiteviolations (impl-DO, recon-DL, W1-T267, PR #1066). */
export function callSiteViolations(task: Task, opts: LintOpts = {}): LintViolation[] {
  // NO PREDICATE ⇒ NO OPINION. Whether a module already exists is the caller's to answer, and a
  // wrong guess here would flag every task that merely EDITS a module.
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
    // …in a file OTHER than the module being created, since a module calling itself proves nothing
    // about whether the rest of the program reaches it.
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

/** MONOLITH-FILING — one storage convention for new tasks. PR #1060 redirected `rmd triage` to
 *  propose a new task as its own shard, but that is ONLY A PROMPT INSTRUCTION TO AN LLM:
 *  `decideTriage` filters `!f.startsWith("plan/")`, so a shard passes and so does a monolith append.
 *  THIS IS NOT A SIZE EMERGENCY, and the old framing should not be repeated: the reason to enforce
 *  it is CONSISTENCY. ID SETS, NEVER DIFF LINES: a reformat, rename or whitespace change leaves the
 *  id set untouched, and keying on the base's MONOLITH blob catches the REVERSE migration too.
 *  REQUIRES `--base`: "new" has no meaning without one, so this check is silent in whole-plan mode
 *  — said out loud, rather than letting a check that cannot run look like one that passed. */
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
  /** Severity for {@link proofDialectViolations}. Default "block", and since impl-AK every call
   *  site takes it: a proof that cannot execute is refused before a worker spawns. */
  proofDialect?: LintSeverity;
  /** Does this repo-relative path already exist? Supplied by the caller because the linter is pure.
   *  Absent ⇒ {@link callSiteViolations} is silent. */
  moduleExists?: (repoRelPath: string) => boolean;
  /** Severity for {@link callSiteViolations}. Default "warn" — see the report's retrofit count. */
  callSite?: LintSeverity;
  /** Severity for {@link proofResolvabilityViolations}. Default "block", but the pre-dispatch site
   *  DELIBERATELY passes "warn": a queued task's proof legitimately forward-references the test its
   *  own PR will create, and pre-dispatch cannot tell that from a dead reference. */
  proofResolvability?: LintSeverity;
  /** Injected merge-state context for {@link postMergeAmendmentViolations}; see {@link
   *  PostMergeAmendmentContext} for why it arrives by injection. Absent ⇒ the check is skipped. */
  postMergeAmendment?: PostMergeAmendmentContext;
  /** Injected base-ref context for {@link blockedDispositionViolations}. Absent ⇒ silent: the
   *  whole-plan pass must never refuse the standing population of already-blocked tasks. */
  blockedDisposition?: BlockedDispositionContext;
  /** Diff-scoped base-ref state for {@link sizingViolation}'s risk:high `band_meaning` obligation;
   *  see {@link RiskTransitionContext}. Absent ⇒ an undeclared `band_meaning` stays silent. */
  riskTransition?: RiskTransitionContext;
  /** Ids present in THIS branch's `plan/tasks.yaml` and absent from the base ref's monolith.
   *  Supplied only in `--base` mode; undefined ⇒ {@link monolithFilingViolations} is silent. */
  newMonolithIds?: ReadonlySet<string>;
  /** Severity for {@link monolithFilingViolations}. Default "block" — retrofit cost is zero. */
  monolithFiling?: LintSeverity;
  /** Severity for {@link proofScopeViolations}. Default "warn" — see that check's section comment
   *  for the measured retrofit count driving the default. */
  proofScope?: LintSeverity;
  /** The reviewer's OWN `resolveNameFilteredCandidates` (review.ts), bound to a real checkout, so
   *  lint and review cannot disagree. Absent ⇒ {@link proofNameResolutionViolations} is silent. */
  resolveNameFilteredCandidates?: (rawName: string) => NameFilterResolution;
  /** Other OPEN tasks' corpus entries for {@link duplicateTitleViolations} to compare this task
   *  against. Supplied by the caller, never fetched. Absent or empty ⇒ silent. */
  openTaskTitles?: OpenTaskTitleCorpus;
  /** Jaccard cutoff for {@link duplicateTitleViolations}. Default {@link DEFAULT_DUPLICATE_CUTOFF}.
   *  The check is WARN-only regardless of it, and has no severity override. */
  duplicateTitleCutoff?: number;
  /** THIS task's own shard filename slug, for {@link duplicateTitleViolations} to score instead of
   *  the title; the linter reads no disk and `Task` carries no path, so the caller supplies it.
   *  Absent or blank ⇒ the title is scored. ALSO consumed by {@link sizingViolation}. */
  duplicateSlug?: string;
  /** Shingle width for {@link duplicateTitleViolations}. The live caller passes {@link
   *  DUPLICATE_SLUG_SHINGLE_K}; absent ⇒ {@link DEFAULT_SHINGLE_K}. */
  duplicateShingleK?: number;
  /** The richer corpus {@link unansweredDuplicateTitleViolations}'s BLOCKING arm scores against:
   *  each entry carries its own `planRefs`/`rationale`, so the check can tell whether the OTHER
   *  shard already answered. Absent or empty ⇒ silent. */
  openTaskRecords?: readonly DuplicateAnswerCorpusEntry[];
  /** Jaccard cutoff for {@link unansweredDuplicateTitleViolations}. Default {@link
   *  NEAR_IDENTITY_DUPLICATE_CUTOFF}. */
  nearIdentityCutoff?: number;
  /** THIS task's own `plan_refs` list, which `Task` carries no field for, so {@link
   *  unansweredDuplicateTitleViolations} can see whether this shard already cites its match.
   *  Absent ⇒ only `task.rationale` is checked on this side. */
  taskPlanRefs?: readonly string[];
  /** A `grep:` proof's named path -> that file's text, or `undefined` when the path is not on
   *  disk, for {@link proofGrepUnmatchableViolations} and {@link proofEngineDivergenceViolations}:
   *  one contract for two checks that both need today's text. Absent ⇒ both are silent. */
  readGrepProofFile?: (repoRelPath: string) => string | undefined;
}

/** Lint one task, aggregating every check below. The hard checks — sizing, headless-fitness,
 *  proof-shape, proof-dialect, proof-resolvability, provenance, ruling-verify — always run. Each
 *  injected-predicate check is a no-op absent its own `opts` field: post-merge-amendment,
 *  blocked-disposition, budget-sanity, duplicate-title and its narrow arm, proof-name-resolution.
 *  Dispatch-priority, advisory-routing and blocked-record-unruled always run with no `opts` field
 *  at all, and the last two can never block. */
export function lintTask(task: Task, opts: LintOpts = {}): LintResult {
  const violations: LintViolation[] = [];
  const sizing = sizingViolation(task, opts);
  if (sizing) violations.push(sizing);
  violations.push(...headlessFitnessViolations(task));
  violations.push(...proofShapeViolations(task));
  violations.push(...proofDialectViolations(task, opts));
  violations.push(...proofResolvabilityViolations(task, opts));
  violations.push(...proofGrepSafetyViolations(task));
  violations.push(...proofScopeViolations(task, opts));
  violations.push(...proofNameResolutionViolations(task, opts));
  violations.push(...postMergeAmendmentViolations(task, opts));
  violations.push(...blockedDispositionViolations(task, opts));
  violations.push(...blockedRecordUnruledViolations(task));
  violations.push(...callSiteViolations(task, opts));
  violations.push(...monolithFilingViolations(task, opts));
  violations.push(...duplicateTitleViolations(task, opts));
  violations.push(...unansweredDuplicateTitleViolations(task, opts));
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

/** Split a raw plan yaml corpus into per-task RECORD blocks, keyed by id. A block runs from its
 *  `- id:` line to the next one or EOF, trimmed of trailing whitespace so a record moved to a
 *  file's tail never differs by its final newline alone. Pure over the supplied text. Why: W1-T428. */
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

/** Ids whose RAW record text differs between two corpora — the companion {@link changedTaskIds}
 *  cannot replace and must not be replaced by. THE TRAP: the parser DROPS six fields the corpus
 *  uses (design, plan_refs, queue_note, amendment_note, cycle_residual, fixture_forensics), so a
 *  design-only edit is INVISIBLE to the parsed comparison — one PR measured `0 task(s) checked` on
 *  exactly that diff, and the next dispatched worker acted on instructions no gate re-checked.
 *  Comparing record BYTES catches every dropped field, present and future, by construction, while
 *  the parsed side still owns semantic equivalence. The gate consumes the UNION, which dedups.
 *  Why: W1-T428, #1544. */
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

/** The task ids NEW or CHANGED between two plan snapshots, by deep value rather than reference — a
 *  pure diff, no git I/O. This is what scopes the CI check to the PR's OWN edit rather than the
 *  whole historical queue; re-grading the whole open queue is the retro's separate plan-health
 *  sweep (W1-T20d), not every PR's gate. */
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
// A gate that reads a task or plan must be provably reading the RIGHT ONE: a silent wrong-file read
// is still green and still wrong. In the #271 false-green, one checkout's `bin/rmd`, invoked with
// cwd inside a DIFFERENT work tree, linted the install tree's plan and never opened the file under
// test. These two pure helpers let a gate refuse an out-of-root `--plan` BY NAME rather than
// failing downstream as a confusing base-resolution error, and print the absolute path and content
// hash of the file actually opened, so a wrong-file run is visible in its own output.

/** True iff `candidate` resolves OUTSIDE `root`; `root` itself and anything under it is IN. Both
 *  arguments must already be absolute — this does no resolving or symlink-following of its own. */
export function isPathOutsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === ".." || rel.startsWith(`..${sep}`);
}

/** `<abs path> (sha256:<first 12 hex chars>)` — the read-identity assertion a gate's summary line
 *  carries, so the file it opened is legible in its own output rather than inferred from cwd. */
export function formatReadIdentity(absPath: string, raw: string): string {
  const hash = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
  return `${absPath} (sha256:${hash})`;
}
