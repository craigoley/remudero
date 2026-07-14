import { execFileSync } from "node:child_process";
import type { AcceptanceCriterion } from "./plan.js";

/**
 * The JUDGE (MASTER-PLAN §12 rule 4 / rule 3B; task W1-T1C).
 *
 * Standing rule 4: green checks are NOT evidence. `ci` proves the code typechecks
 * and its tests pass; it says nothing about whether the task's ACCEPTANCE CRITERIA
 * were met. This module is the second half of the merge contract: after ci goes
 * green a FRESH-context REVIEW worker (never the implementer's session; read-only
 * tools + gh) verdicts each criterion against its stated PROOF and posts a commit
 * status `remudero-review`.
 *
 * THE VERDICT LOGIC IS A PURE FUNCTION ({@link judgeReview}) so the falsifier —
 * "does the reviewer actually FAIL a test-passing-but-acceptance-ignoring diff?"
 * — is a UNIT FIXTURE, proven before any live gate depends on it. The pure layer
 * is the mechanical FLOOR: it catches the failure modes that need no LLM (a proof
 * never pasted into the report; tests that assert nothing). A semantic verdict
 * from the LLM reviewer may only DOWNGRADE a criterion to failure, never rescue an
 * unpasted proof — proof must be pasted, not vibed.
 *
 * This module NEVER edits code and exposes no write path: the reviewer is
 * read-only + gh by construction (acceptance #3). It does NOT touch branch
 * protection — remudero-review is POSTED here but made REQUIRED by W1-T1D.
 */

/** The commit-status context string the merge gate keys on. Never change casually. */
export const REVIEW_CONTEXT = "remudero-review";

/** A commit-status state. GitHub statuses also allow `pending`/`error`; the gate uses these two. */
export type ReviewState = "success" | "failure";

/** One criterion's verdict against its stated proof. */
export interface CriterionVerdict {
  claim: string;
  proof: string;
  met: boolean;
  reason: string;
}

/** The evidence the JUDGE reads: the PR diff, the implement REPORT, optional LLM verdicts. */
export interface ReviewEvidence {
  /** The unified PR diff (as `gh pr diff` / `git diff` would produce). */
  diff: string;
  /** The implement worker's REPORT text (where proofs are pasted). */
  report: string;
  /**
   * Optional per-criterion semantic verdicts from the fresh LLM reviewer,
   * index-aligned to the criteria list. `false` FORCES that criterion to fail;
   * `true`/`undefined` defer to the mechanical floor. Semantic can only
   * downgrade — it can never upgrade an unpasted proof to a pass.
   */
  semantic?: (boolean | undefined)[];
}

/** The rolled-up review verdict — exactly what {@link postReviewStatus} posts. */
export interface ReviewVerdict {
  state: ReviewState;
  criteria: CriterionVerdict[];
  /** True when the diff adds tests that assert nothing (a global fail signal). */
  testTheater: boolean;
  /** One-line human summary, safe to use as the commit-status description. */
  summary: string;
}

// ── Tokenisation (deterministic, dependency-free) ──────────────────────────

/** Generic words that carry no proof-specific signal — excluded from keywords. */
const STOPWORDS = new Set([
  "shows",
  "show",
  "with",
  "real",
  "that",
  "this",
  "used",
  "over",
  "into",
  "from",
  "each",
  "their",
  "than",
  "then",
  "them",
  "were",
  "will",
  "have",
  "has",
  "the",
  "and",
  "for",
  "are",
  "was",
  "not",
  "any",
  "per",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Distinctive keywords of a proof: tokens ≥4 chars, not stopwords, not bare
 * numbers. Placeholders like `<sha>` reduce to `sha` (len 3) and drop out, so a
 * proof's template noise does not pollute the responsiveness check.
 */
function proofKeywords(proof: string): string[] {
  return [
    ...new Set(
      tokenize(proof).filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
    ),
  ];
}

/**
 * Fraction of a proof's distinctive keywords the report must echo before we
 * treat the proof as "responsively addressed". A missing/unpasted/non-responsive
 * proof scores near zero; a report that pastes the proof scores near one. This is
 * a FLOOR, not a semantic judge — the LLM reviewer does the real judging on top.
 */
const MIN_COVERAGE = 0.34;

// ── Test-theater detection over a unified diff ─────────────────────────────

/** True once we are inside an added test file (per `+++ b/…test…` headers). */
function isTestPath(path: string): boolean {
  return /(^|\/)test(s)?\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path) || /\.spec\./.test(path);
}

const ASSERTION_RE = /\b(assert|expect|should)\b|\.(is|ok|equal|deepEqual|match|throws|rejects)\(/;
const NOOP_ASSERTION_RE =
  /assert(\.\w+)?\(\s*true\s*[),]|assert\.equal\(\s*true\s*,\s*true|expect\(\s*true\s*\)/;

/**
 * Detect test theater: added test code that asserts nothing (or asserts a
 * tautology). Scans only ADDED lines inside test files. Returns false when the
 * diff touches no test file (nothing to judge) or when a real assertion is added.
 */
export function detectTestTheater(diff: string): boolean {
  let inTestFile = false;
  const addedTestLines: string[] = [];
  for (const line of diff.split("\n")) {
    // File headers (`+++ b/path`) precede their `+`-prefixed body lines.
    if (line.startsWith("+++ ")) {
      const path = line.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      inTestFile = isTestPath(path);
      continue;
    }
    if (line.startsWith("diff --git")) {
      // A `diff --git a/x b/y` header names both paths; use the `b/` side.
      const m = line.match(/\sb\/(\S+)\s*$/);
      inTestFile = m ? isTestPath(m[1]) : false;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (inTestFile && line.startsWith("+")) addedTestLines.push(line.slice(1));
  }
  if (addedTestLines.length === 0) return false;
  if (addedTestLines.some((l) => NOOP_ASSERTION_RE.test(l))) return true;
  const hasRealAssertion = addedTestLines.some((l) => ASSERTION_RE.test(l));
  return !hasRealAssertion;
}

// ── The pure JUDGE ─────────────────────────────────────────────────────────

/** Verdict one criterion against its proof, given the report + optional semantic. */
export function judgeCriterion(
  criterion: AcceptanceCriterion,
  reportTokens: Set<string>,
  semantic?: boolean,
): CriterionVerdict {
  const base = { claim: criterion.claim, proof: criterion.proof };
  const kws = proofKeywords(criterion.proof);

  // Mechanical floor: is the proof responsively pasted into the report?
  let met: boolean;
  let reason: string;
  if (kws.length === 0) {
    // A proof with no distinctive anchors cannot be mechanically checked; defer
    // entirely to the semantic layer (fail closed only if the reviewer says so).
    met = true;
    reason = "no mechanical anchors in proof; deferred to reviewer judgment";
  } else {
    const covered = kws.filter((k) => reportTokens.has(k));
    const coverage = covered.length / kws.length;
    if (coverage < MIN_COVERAGE) {
      met = false;
      reason = `proof unmet: report does not substantiate it (matched ${covered.length}/${kws.length} proof keywords)`;
    } else {
      met = true;
      reason = `proof substantiated in report (matched ${covered.length}/${kws.length} proof keywords)`;
    }
  }

  // Semantic can only DOWNGRADE: an explicit `false` fails the criterion even if
  // it was mechanically substantiated; it can never rescue an unpasted proof.
  if (semantic === false && met) {
    met = false;
    reason = "reviewer judged the proof non-responsive (semantic downgrade)";
  }

  return { ...base, met, reason };
}

/**
 * The pure verdict function (acceptance #2). Given the acceptance criteria and
 * the evidence (diff + report [+ optional semantic verdicts]), roll up a single
 * `remudero-review` state. FAIL-CLOSED: empty criteria, any unmet criterion, or
 * test theater all yield `failure`.
 */
export function judgeReview(
  criteria: AcceptanceCriterion[],
  evidence: ReviewEvidence,
): ReviewVerdict {
  const reportTokens = new Set(tokenize(evidence.report));
  const verdicts = criteria.map((c, i) =>
    judgeCriterion(c, reportTokens, evidence.semantic?.[i]),
  );
  const testTheater = detectTestTheater(evidence.diff);

  const reasons: string[] = [];
  if (criteria.length === 0) reasons.push("no acceptance criteria to judge (fail closed)");
  const unmet = verdicts.filter((v) => !v.met);
  if (unmet.length > 0) reasons.push(`${unmet.length} criterion/criteria unmet`);
  if (testTheater) reasons.push("test theater: added tests assert nothing");

  const state: ReviewState = reasons.length === 0 ? "success" : "failure";
  const summary =
    state === "success"
      ? `remudero-review: PASS — ${verdicts.length} criteria substantiated, no test theater`
      : `remudero-review: FAIL — ${reasons.join("; ")}`;

  return { state, criteria: verdicts, testTheater, summary };
}

// ── The fresh-context reviewer prompt (read-only + gh, never edits) ─────────

export interface ReviewPromptInput {
  task: { id: string; acceptance?: AcceptanceCriterion[] };
  prUrl: string;
  owner: string;
  repo: string;
  headSha: string;
}

/**
 * Render the prompt for a FRESH-context REVIEW worker (acceptance #1/#3). The
 * worker is read-only + gh: it reads the PR diff, the task's acceptance criteria,
 * and the implement REPORT, verdicts each criterion against its proof, and posts
 * the `remudero-review` commit status. It is told NEVER to edit code — and the
 * runner spawns it with a read-only settings profile, so this is belt-and-braces.
 */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const criteria = (input.task.acceptance ?? [])
    .map((c, i) => `  ${i + 1}. CLAIM: ${c.claim}\n     PROOF: ${c.proof}`)
    .join("\n");
  const post = (state: ReviewState) =>
    `gh api -X POST repos/${input.owner}/${input.repo}/statuses/${input.headSha} ` +
    `-f context=${REVIEW_CONTEXT} -f state=${state} -f description="<one line>"`;

  return [
    `You are a REVIEW worker with FRESH context — you are NOT the implementer and`,
    `have none of their session. You are READ-ONLY: you may inspect the repo and`,
    `use \`gh\`, but you must NEVER edit, modify, or write any code or file. The PR`,
    `head sha must be unchanged by your review.`,
    ``,
    `TASK UNDER REVIEW: ${input.task.id}`,
    `PR: ${input.prUrl}`,
    ``,
    `Do this:`,
    `1. Read the PR diff:            gh pr diff ${input.prUrl}`,
    `2. Read the implement REPORT (the PR body / last worker message).`,
    `3. For EACH acceptance criterion below, verdict its stated PROOF against the`,
    `   diff and the REPORT. A proof that is missing, unpasted, or non-responsive`,
    `   = FAILURE. Test theater (assertions that assert nothing) = FAILURE.`,
    ``,
    `ACCEPTANCE CRITERIA:`,
    criteria || "  (none stated — treat as FAILURE: nothing to verify)",
    ``,
    `Then post the commit status on the PR head sha (${input.headSha}):`,
    `  on PASS:  ${post("success")}`,
    `  on FAIL:  ${post("failure")}`,
    ``,
    `This does NOT touch branch protection — you only POST the ${REVIEW_CONTEXT}`,
    `status; whether it is REQUIRED is a separate concern. End with a REPORT: the`,
    `per-criterion verdicts, the state you posted, and the sha.`,
  ].join("\n");
}

/**
 * Machine-readable verdict contract appended to the fresh reviewer's prompt so
 * its per-criterion judgment can be folded into the deterministic verdict as a
 * SEMANTIC downgrade (never an upgrade — {@link judgeReview}). The reviewer emits
 * one `REVIEW_VERDICT <n>: PASS|FAIL` line per criterion. This is advisory: the
 * mechanical floor is the binding gate (Standing rules 2/4/12), so a reviewer
 * that emits nothing parseable simply leaves the floor untouched — never a stall,
 * never a deadlock.
 */
export function reviewerVerdictContract(count: number): string {
  return [
    ``,
    `MACHINE-READABLE OUTPUT (required, in addition to posting the status): emit`,
    `EXACTLY one line per criterion, in this form and nothing else on the line:`,
    `  REVIEW_VERDICT <n>: PASS   (proof is responsive and substantiated)`,
    `  REVIEW_VERDICT <n>: FAIL   (proof missing, unpasted, or non-responsive)`,
    `for n = 1..${count}. These are folded into the deterministic verdict and may`,
    `only DOWNGRADE a criterion to failure, never rescue an unpasted proof.`,
  ].join("\n");
}

/**
 * Parse the reviewer's `REVIEW_VERDICT <n>: PASS|FAIL` lines into a semantic
 * array index-aligned to the criteria (length `count`). `FAIL` ⇒ `false` (forces
 * that criterion to fail); `PASS`/absent ⇒ `undefined` (defer to the mechanical
 * floor). Advisory + downgrade-only, so an unparseable reviewer output yields an
 * all-`undefined` array — the floor stands alone, fail-closed. Case-insensitive;
 * tolerant of surrounding prose.
 */
export function parseReviewerVerdicts(text: string, count: number): (boolean | undefined)[] {
  const semantic: (boolean | undefined)[] = new Array(count).fill(undefined);
  const re = /REVIEW_VERDICT\s+(\d+)\s*:\s*(PASS|FAIL)\b/gi;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]) - 1;
    if (n < 0 || n >= count) continue;
    // Only ever record a downgrade; a PASS leaves the floor to decide.
    if (m[2].toUpperCase() === "FAIL") semantic[n] = false;
  }
  return semantic;
}

// ── gh poster (runs outside the sandbox; TLS fails under Seatbelt) ──────────

/**
 * Post the `remudero-review` commit status to a PR head sha. Thin wrapper over
 * the exact `gh api` call from the design; mirrors the other gh helpers in
 * lib/worker.ts (untested by unit — it shells out). WRITE-scoped to a commit
 * STATUS only; it can never edit code.
 */
export function postReviewStatus(opts: {
  owner: string;
  repo: string;
  sha: string;
  state: ReviewState;
  description?: string;
}): void {
  const args = [
    "api",
    "-X",
    "POST",
    `repos/${opts.owner}/${opts.repo}/statuses/${opts.sha}`,
    "-f",
    `context=${REVIEW_CONTEXT}`,
    "-f",
    `state=${opts.state}`,
  ];
  if (opts.description) args.push("-f", `description=${opts.description.slice(0, 140)}`);
  execFileSync("gh", args, { stdio: "pipe" });
}
