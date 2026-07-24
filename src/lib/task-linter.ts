import type { Plan, Task } from "./plan.js";
import { isDialectPrefixed, parseWhitelistedProof } from "./review.js";

/**
 * Deterministic task linter (MASTER-PLAN §5C Layer A). NO LLM — a PURE function
 * over a loaded {@link Task}/{@link Plan}, no I/O, no side effects. Catches the
 * class of malformed task that reached a worker four times (W1-T6, W1-T9, and
 * W1-T12 twice-over) and burned budget before a human noticed: over-scoping
 * (Rule 19), headless-unfitness (Rule 18), vibe proofs, a proof that CANNOT
 * EXECUTE at all (the dead proof floor, moratorium finding 9, W1-T246), a
 * dialect-prefixed proof that promises executability but names no resolvable
 * artifact (the W1-T100 0/3, W1-T101), and missing provenance (Rules 16/17).
 *
 * Wired at TWO points, both FAIL-CLOSED:
 *   (i)  a CI check on any PR that edits plan/tasks.yaml (`rmd lint-plan`, see
 *        run-task.ts's `lintPlanCommand` + .github/workflows/ci.yml's `lint-plan`
 *        job, aggregated into the required `ci-gate` context).
 *   (ii) a PRE-DISPATCH guard in `rmd run-task` (and therefore `rmd drain`, which
 *        dispatches every task through the same `runTask` path) — a task that
 *        fails a BLOCKING check is NEVER dispatched: `verdict=blocked_illformed`,
 *        no worker spawned, no inflight lock even taken (see run-task.ts,
 *        `assertLintClean` called immediately after `assertRunnable`).
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
  | "provenance"
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
//   - FALSE NEGATIVE — the genuinely headless-unfit proofs the check was BUILT to
//     catch ('paste the red check, then revert' — the W1-T25 no_pr incident,
//     122 turns before verdict=no_pr) are PHRASES, not lexicon words, so the
//     original word-only lexicon never matched them. Phrase-level signals below
//     close this gap.

export interface LexiconEntry {
  tag: string;
  pattern: RegExp;
}

export const HEADLESS_FORBIDDEN_LEXICON: ReadonlyArray<LexiconEntry> = [
  { tag: "overnight", pattern: /\bovernight\b/i },
  { tag: "reboot", pattern: /\breboot\b/i },
  { tag: "launchctl", pattern: /\blaunchctl\b/i },
  { tag: "loads-at-boot", pattern: /\bloads?\s+at\s+boot\b/i },
  { tag: "killed", pattern: /\bkilled\b/i },
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
      (h, idx) => !enumExempt.has(idx) && !isQuoted(text, h.start, h.end) && !isNegationScoped(text, h.start),
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
 *  lands (the dead proof floor, moratorium finding 9). BLOCK by default;
 *  `opts.proofDialect: "warn"` (the pre-dispatch call site, run-task.ts —
 *  the ~90-task legacy backlog must not brick overnight) demotes every
 *  violation here to visibility-only. A criterion whose proof DOES parse but
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

export interface LintOpts {
  /** The task's resolved mount turn-budget — only needed to opt INTO budget-sanity. */
  mountMaxTurns?: number;
  /** The observed class mean, from a real Calibration row — never hardcoded. */
  calibration?: ClassCalibration;
  /** Severity for {@link proofDialectViolations}. Default "block" (CI's `lint-plan`, the
   *  inbox draft rung, and the retro's plan-health sweep all want the default). The
   *  pre-dispatch call site (run-task.ts's `assertLintClean`) passes "warn" — the legacy
   *  backlog must not brick overnight; CI still reds a hand-filed offender. */
  proofDialect?: LintSeverity;
  /** Severity for {@link proofResolvabilityViolations}. Default "block" — same rollout
   *  convention as `proofDialect` above, for the same reason: `rmd run-task`'s pre-dispatch
   *  call site passes "warn" so the legacy backlog (authored before this check existed)
   *  does not brick overnight; CI's `lint-plan`, the inbox draft rung, and the retro's
   *  plan-health sweep all want the default and BLOCK. */
  proofResolvability?: LintSeverity;
}

/** Lint one task. Hard checks (sizing/headless-fitness/proof-shape/proof-dialect/
 *  proof-resolvability/provenance) always run; budget-sanity runs only when
 *  `opts.mountMaxTurns` is supplied. */
export function lintTask(task: Task, opts: LintOpts = {}): LintResult {
  const violations: LintViolation[] = [];
  const sizing = sizingViolation(task);
  if (sizing) violations.push(sizing);
  violations.push(...headlessFitnessViolations(task));
  violations.push(...proofShapeViolations(task));
  violations.push(...proofDialectViolations(task, opts));
  violations.push(...proofResolvabilityViolations(task, opts));
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
