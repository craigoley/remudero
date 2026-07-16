import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Observed outcome of executing a criterion's proof against the PR head (W1-T65,
 * ratifies P15). Recorded per-criterion on {@link CriterionVerdict} and surfaced on
 * the `review.posted` ledger line + console summary (run-task.ts) so an OBSERVED
 * verdict is legible vs a KEYWORD one:
 *   executed_pass  — the proof's whitelisted test/grep ran and passed/matched on
 *                     the head. MEETS the criterion regardless of report keywords
 *                     (kills the #100 false-block: repo-state truth, unclaimed).
 *   executed_fail  — it ran and FAILED / found no match. OVERRIDES any keyword
 *                     coverage (kills the W1-T51 false-pass: a claim the repo
 *                     state refutes never merges on prose alone).
 *   not_executable — the proof is free prose (or no head checkout dir was given).
 *                     The keyword floor is UNCHANGED — this is the default for
 *                     every caller that predates this task.
 *   exec_error     — the whitelisted check threw or timed out. DEGRADES to the
 *                     keyword floor verdict computed alongside it, verbatim —
 *                     an environment hiccup must never silently hard-fail or
 *                     stall the fleet (Standing rule: no absent-check deadlock).
 */
export type ProofExecOutcome = "executed_pass" | "executed_fail" | "not_executable" | "exec_error";

/** One criterion's verdict against its stated proof. */
export interface CriterionVerdict {
  claim: string;
  proof: string;
  met: boolean;
  reason: string;
  /** See {@link ProofExecOutcome}. Always present — `not_executable` is the safe
   * default when the proof is prose, or no PR-head checkout was supplied. */
  proof_exec: ProofExecOutcome;
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
  /**
   * The checkout dir whitelisted proofs execute in — MUST be the PR HEAD sha (the
   * runner's own worktree when judging its own run; a fresh checkout fetched at
   * the head sha on the `rmd review` path). NEVER the operator's working checkout
   * (HEAD DISCIPLINE, W1-T65 design). Absent ⇒ proof execution is skipped for
   * every criterion (`proof_exec` is `not_executable` throughout) — the keyword
   * floor is byte-identical to pre-W1-T65 behavior, which is what every caller
   * that predates this task (and every fixture below) gets by default.
   */
  headCheckoutDir?: string;
  /**
   * Injected proof executor. Real callers omit this — {@link execWhitelistedProof}
   * (the real, whitelist-bounded shell-out) is the default. Tests inject a fake so
   * override/degrade semantics are proven without touching the filesystem or a
   * shell (acceptance: "unit test over an injected executor").
   */
  execProof?: ProofExecutor;
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

/**
 * Tokenise for keyword matching, NORMALISING identifier casing + separators so a
 * criterion and its proof compare case- and separator-insensitively:
 * `maxTurns` ≡ `max_turns` ≡ `max-turns`. camelCase is split into words BEFORE
 * lowercasing (otherwise `maxTurns`→`maxturns` never matches `max_turns`→`max`,
 * `turns`) — a real reviewer weakness that false-blocked PR #42 (W1-T5). This is a
 * FLOOR hardening; the deeper fix is observing repo state (W1-T3F), not keywords.
 */
function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase: maxTurns → max Turns
    .toLowerCase()
    .split(/[^a-z0-9]+/) // splits on _, -, space, punctuation alike
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

// ── Whitelisted proof execution (W1-T65, ratifies P15) ─────────────────────
//
// Lifts W1-T3F's whitelisted-proof execution — previously only the ADVISORY
// fresh-context reviewer's own judgment (buildReviewPrompt below tells the LLM to
// check out the head and run a proof's test/grep itself) — INTO this deterministic
// FLOOR, so the gate observes repo state whether or not that LLM reviewer ever
// completes. WHITELIST UNCHANGED from W1-T3F: only two shapes are ever executed,
// and NOTHING else — no arbitrary code from proof text:
//   (1) a named TEST FILE path (`test/**/*.test.ts` or `.spec.*`), run via the
//       project's own test runner (`node --test --import tsx <path>`, exactly the
//       package.json `test` script scoped to one file);
//   (2) a literal, BACKTICK-FENCED `grep ...` command (e.g. `` `grep -n foo bar.ts` ``)
//       — fenced so a proof must be UNAMBIGUOUS to qualify; unfenced prose like
//       "grep of src shows X" is NOT this shape and stays on the keyword floor.
// Both are executed via execFile (never a shell), so proof TEXT can never inject
// shell metacharacters into a command line — but the fenced grep body is still
// rejected outright (not_executable, nothing executed) if it contains any of
// `; & \` $ < >` or a newline, as defense in depth (acceptance: proof execution is
// bounded to the whitelist). Anything that doesn't match either shape is
// not_executable — the keyword floor stands alone, unchanged.

/** A proof shape the floor is willing to mechanically execute. */
export interface WhitelistedProof {
  kind: "test" | "grep";
  /** argv[0] — passed to execFile, never a shell. */
  command: string;
  /** argv[1..] — proof text is never concatenated into a shell string. */
  args: string[];
  /** Human-legible label for reasons (the matched path, or the fenced command). */
  label: string;
}

const TEST_PATH_RE = /\btest\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/;
const GREP_FENCE_RE = /`(grep\s+[^`]+)`/;
const UNSAFE_FENCE_CHARS_RE = /[;&`$<>\n]/;

/** Tokenise a fenced shell-like command, honoring simple `"…"` / `'…'` quoting. No
 * escape sequences (a proof needing one is simply not whitelisted — fine). */
function tokenizeFenced(s: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

/**
 * Parse a proof for a whitelisted, mechanically-executable shape. Returns `null`
 * for free prose (or an unsafe/unwhitelisted shape) — the caller then defers
 * entirely to the keyword floor, never attempting execution.
 */
export function parseWhitelistedProof(proof: string): WhitelistedProof | null {
  const testMatch = proof.match(TEST_PATH_RE);
  if (testMatch) {
    const path = testMatch[0];
    if (path.includes("..")) return null; // no path traversal out of the checkout
    return { kind: "test", command: "node", args: ["--test", "--import", "tsx", path], label: path };
  }
  const grepMatch = proof.match(GREP_FENCE_RE);
  if (grepMatch) {
    const fenced = grepMatch[1];
    if (UNSAFE_FENCE_CHARS_RE.test(fenced)) return null; // shell metacharacters ⇒ refuse, not sanitize
    const tokens = tokenizeFenced(fenced);
    if (tokens[0] !== "grep" || tokens.length < 2) return null;
    return { kind: "grep", command: "grep", args: tokens.slice(1), label: fenced };
  }
  return null;
}

/** Executes a {@link WhitelistedProof}'s argv and reports whether it passed —
 * injectable so unit tests fake pass/fail/throw without touching the filesystem. */
export type ProofExecutor = (whitelisted: WhitelistedProof, cwd: string) => "pass" | "fail";

const DEFAULT_PROOF_TIMEOUT_MS = 30_000;
const npmCiPrimed = new Set<string>();

/** `npm ci` a fresh checkout ONCE before its first test proof (design: "fresh
 * worktrees have no node_modules"). Best-effort: a failed/skipped install is never
 * a silent hard-fail here — the test command below will itself fail to run, which
 * surfaces as exec_error on that criterion, never a false pass. */
function ensureDeps(cwd: string): void {
  if (npmCiPrimed.has(cwd)) return;
  npmCiPrimed.add(cwd); // mark attempted regardless of outcome — never retry-storm a cwd
  if (!existsSync(join(cwd, "package.json")) || existsSync(join(cwd, "node_modules"))) return;
  try {
    execFileSync("npm", ["ci"], { cwd, stdio: "pipe", timeout: 120_000 });
  } catch {
    /* best-effort priming; see doc comment above */
  }
}

/**
 * The REAL proof executor (production default): run a {@link WhitelistedProof}'s
 * argv, no shell, in `cwd`, with a HARD per-proof timeout — a hanging test must
 * never stall the required check into the absent-check deadlock class. Returns
 * `"pass"` on a clean exit 0; `"fail"` on ANY clean nonzero exit — a failing test,
 * a grep that found no match (exit 1), AND a grep given a since-renamed/missing
 * path (exit 2) all count as "fail": the proof named something the PR head does
 * not observably contain, which is the criterion genuinely unmet, not an
 * environment hiccup. THROWS only when the process never ran to a clean exit at
 * all (a timeout kill, a spawn error like the command itself missing) so the
 * caller surfaces `exec_error` — a timeout must never be misjudged as an
 * observed "fail".
 */
export function execWhitelistedProof(
  whitelisted: WhitelistedProof,
  cwd: string,
  timeoutMs = DEFAULT_PROOF_TIMEOUT_MS,
): "pass" | "fail" {
  if (whitelisted.kind === "test") ensureDeps(cwd);
  try {
    execFileSync(whitelisted.command, whitelisted.args, { cwd, stdio: "pipe", timeout: timeoutMs });
    return "pass";
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { status?: number | null };
    if (typeof err.status === "number") return "fail"; // ran to a clean nonzero exit
    throw err; // killed by signal (timeout) / spawn error (ENOENT, …) ⇒ exec_error
  }
}

// ── The pure JUDGE ─────────────────────────────────────────────────────────

/** PR-head checkout a criterion's proof may be executed against (W1-T65). */
export interface ProofExecContext {
  cwd: string;
  exec?: ProofExecutor;
}

/** Verdict one criterion against its proof, given the report + optional semantic. */
export function judgeCriterion(
  criterion: AcceptanceCriterion,
  reportTokens: Set<string>,
  semantic?: boolean,
  execCtx?: ProofExecContext,
): CriterionVerdict {
  const base = { claim: criterion.claim, proof: criterion.proof };

  // ARCHITECT-ONLY `satisfied_by`: a criterion already satisfied by an EARLIER PR is
  // MET, cited to that PR. The reviewer judges diff+report, never repo state, so
  // without this an earlier-PR criterion is permanently unsatisfiable by a later PR.
  // (Setting this is a human/Architect act in a plan PR — never a worker's own edit.)
  if (criterion.satisfied_by) {
    return {
      ...base,
      met: true,
      reason: `satisfied by ${criterion.satisfied_by} (prior merge)`,
      proof_exec: "not_executable",
    };
  }

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

  // WHITELISTED PROOF EXECUTION (W1-T65 — lifts W1-T3F's observation into the
  // FLOOR): when a PR-head checkout dir is given AND the proof names an executable
  // check, RUN it and let the OBSERVED result override the keyword floor above in
  // BOTH directions:
  //   executed_pass ⇒ MET, even if the report never claimed it (kills #100).
  //   executed_fail ⇒ UNMET, even if the report keyword-claimed it (kills W1-T51).
  // exec_error DEGRADES to the keyword floor computed above, verbatim — never a
  // silent hard-fail, never a stall.
  let proofExec: ProofExecOutcome = "not_executable";
  if (execCtx) {
    const whitelisted = parseWhitelistedProof(criterion.proof);
    if (whitelisted) {
      const exec = execCtx.exec ?? execWhitelistedProof;
      try {
        const outcome = exec(whitelisted, execCtx.cwd);
        if (outcome === "pass") {
          proofExec = "executed_pass";
          met = true;
          reason = `proof executed and PASSED on the PR head (${whitelisted.kind}: ${whitelisted.label})`;
        } else {
          proofExec = "executed_fail";
          met = false;
          reason = `proof executed and FAILED on the PR head (${whitelisted.kind}: ${whitelisted.label}) — overrides any keyword coverage`;
        }
      } catch {
        proofExec = "exec_error"; // met/reason stay EXACTLY the keyword-floor verdict above
      }
    }
  }

  // Semantic can only DOWNGRADE: an explicit `false` fails the criterion even if
  // it was mechanically substantiated (or executed-pass); it can never rescue an
  // unpasted / executed-fail proof.
  if (semantic === false && met) {
    met = false;
    reason = "reviewer judged the proof non-responsive (semantic downgrade)";
  }

  return { ...base, met, reason, proof_exec: proofExec };
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
  // Absent headCheckoutDir ⇒ execCtx is undefined ⇒ every criterion is
  // not_executable and the keyword floor is byte-identical to pre-W1-T65 —
  // exactly what every fixture/caller that predates this task still gets.
  const execCtx: ProofExecContext | undefined = evidence.headCheckoutDir
    ? { cwd: evidence.headCheckoutDir, exec: evidence.execProof }
    : undefined;
  const verdicts = criteria.map((c, i) =>
    judgeCriterion(c, reportTokens, evidence.semantic?.[i], execCtx),
  );
  const testTheater = detectTestTheater(evidence.diff);

  const unmet = verdicts.filter((v) => !v.met);
  const noCriteria = criteria.length === 0;
  const state: ReviewState =
    noCriteria || unmet.length > 0 || testTheater ? "failure" : "success";
  const summary =
    state === "success"
      ? `remudero-review: PASS — ${verdicts.length} criteria substantiated, no test theater`
      : failSummary(unmet.map((v) => v.claim), testTheater, noCriteria);

  return { state, criteria: verdicts, testTheater, summary };
}

/** Max length of a GitHub commit-status description (postReviewStatus also truncates). */
const STATUS_DESC_MAX = 140;
const FAIL_PREFIX = "remudero-review: FAIL — ";

/**
 * Build a failure summary that TEACHES: it NAMES the first unmet criterion (not
 * just a count — the W1-T2/PR #18 refusal said "1 criterion/criteria unmet" and
 * cost a human round-trip to work out WHICH). The first unmet claim is included in
 * full or truncated with an ellipsis, plus `(+N more)` when others are unmet, kept
 * within the status-description length limit. The full unmet list lives in the
 * ledger `review.posted` line and the PR review comment (run-task.ts).
 */
export function failSummary(
  unmetClaims: string[],
  testTheater: boolean,
  noCriteria: boolean,
): string {
  if (noCriteria) return `${FAIL_PREFIX}no acceptance criteria to judge (fail closed)`;
  if (unmetClaims.length === 0) return `${FAIL_PREFIX}test theater: added tests assert nothing`;
  const more = unmetClaims.length > 1 ? ` (+${unmetClaims.length - 1} more)` : "";
  const theater = testTheater ? "; test theater" : "";
  const budget = Math.max(24, STATUS_DESC_MAX - (FAIL_PREFIX.length + "unmet: ".length + more.length + theater.length));
  const first = unmetClaims[0];
  const claim = first.length > budget ? `${first.slice(0, budget - 1).trimEnd()}…` : first;
  return `${FAIL_PREFIX}unmet: ${claim}${more}${theater}`;
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
 *
 * The reviewer verifies against REPO STATE, not diff+report alone: when a proof
 * names an EXECUTABLE check (a test to run, a grep/command over the source), the
 * reviewer CHECKS OUT the PR head and RUNS that check, verdicting on the OBSERVED
 * result — the report's word that a test passes or a grep matches is not proof it
 * does. Running tests/greps against the checked-out head is read-only in spirit:
 * it never edits the PR's code and never changes the head sha it judges.
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
    `head sha must be unchanged by your review. Running the PR's tests or grepping`,
    `its source to verify a proof is allowed and expected — that is inspection, not`,
    `editing — as long as you never change the code or the head sha.`,
    ``,
    `TASK UNDER REVIEW: ${input.task.id}`,
    `PR: ${input.prUrl}`,
    ``,
    `Do this:`,
    `1. Read the PR diff:            gh pr diff ${input.prUrl}`,
    `2. Read the implement REPORT (the PR body / last worker message).`,
    `3. CHECK OUT the PR head so you can verify against REPO STATE, not just take`,
    `   the report's word. In a THROWAWAY directory (never the runner's cwd), and`,
    `   without changing the PR head sha (${input.headSha}):`,
    `     gh pr checkout ${input.prUrl}   # or: git fetch origin ${input.headSha} && git checkout ${input.headSha}`,
    `4. For EACH acceptance criterion below, verdict its stated PROOF. When the`,
    `   proof names an EXECUTABLE check — a test (RUN it), a grep/command over the`,
    `   source — RUN that check against the checked-out PR head and verdict on the`,
    `   OBSERVED result (repo state), NOT merely on whether the REPORT pasted it. A`,
    `   proof that is missing, unpasted, or non-responsive = FAILURE; a proof whose`,
    `   test FAILS, or whose grep/command does not match on the PR head, = FAILURE.`,
    `   Test theater (assertions that assert nothing) = FAILURE.`,
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

// ── Acceptance criteria from a PR body (manual plan/doc PRs) ───────────────

/**
 * Parse an `Acceptance:` block out of a PR body, for manual plan/doc PRs that
 * carry no task id. The block is a header line — `Acceptance:` (optionally as
 * markdown `**Acceptance:**` or `## Acceptance`) — followed by bullet lines, each
 * `- <claim> | <proof>` (the `|` separates claim from proof). Parsing stops at the
 * first blank line or non-bullet line after the bullets begin.
 *
 * Returns `[]` when there is no block — and an empty criteria list FAILS CLOSED in
 * {@link judgeReview} (nothing to judge is never a pass). A manual PR that wants to
 * merge must therefore STATE what it is claiming and how it is proven; silence is
 * a failure, not a bypass.
 */
export function parseAcceptanceBlock(body: string): AcceptanceCriterion[] {
  const lines = (body ?? "").split("\n");
  const criteria: AcceptanceCriterion[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    // Header: "Acceptance:", "**Acceptance:**", "## Acceptance", "Acceptance criteria:".
    if (!inBlock) {
      if (/^\s*#{0,6}\s*\**\s*acceptance(\s+criteria)?\b\s*\**\s*:?\s*\**\s*$/i.test(line)) {
        inBlock = true;
      }
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/);
    if (bullet) {
      const item = bullet[1].trim();
      const pipe = item.indexOf("|");
      const claim = (pipe >= 0 ? item.slice(0, pipe) : item).trim();
      const proof = pipe >= 0 ? item.slice(pipe + 1).trim() : "";
      if (claim) criteria.push({ claim, proof });
      continue;
    }
    // A blank line before any bullet is tolerated (header, then a gap, then bullets);
    // once bullets have begun, any blank or non-bullet line ends the block.
    if (line.trim() === "" && criteria.length === 0) continue;
    break;
  }
  return criteria;
}

// ── The reviewer RUBRIC (MASTER-PLAN §5 layer 2 — advisory judgment) ────────
/**
 * Layer 2 of the three-tier gate stack: a set of deterministic JUDGMENT items the
 * reviewer runs over a PR's (diff, report). It ADVISES — the GitHub-enforced gate
 * (layer 1) decides (Standing rule 3B) — so each item is a PURE predicate whose
 * falsifier is a unit fixture, never an LLM call. The four items are, verbatim
 * from §5 layer 2:
 *   1. ONE CONCERN per PR
 *   2. ALL CALLERS AUDITED (partial-fix drift — a change that fixes one call site
 *      and orphans the rest)
 *   3. TEST THEATER (assertions that assert nothing)
 *   4. REFACTOR-PHASE HONESTY (a "refactor" that changes behavior)
 * plus the GUARD: no worker-authored `satisfied_by` (a diff that ADDS a
 * `satisfied_by` line to plan/tasks.yaml FAILS unless the PR is plan-only AND
 * human-authored — `satisfied_by` is Architect-only; a worker adding it to its own
 * blocking criterion is editing the criteria to match the diff, Standing rule 15).
 *
 * These are COARSE, diff-scoped heuristics by design: they advise, they do not
 * decide, and they never edit. Each is independently exported so its fixture can
 * falsify it in isolation.
 */

/** The stable key of one rubric judgment item (used in verdicts + summaries). */
export type RubricKey =
  | "one-concern"
  | "callers-audited"
  | "test-theater"
  | "refactor-honesty"
  | "satisfied-by-guard";

/** One rubric item's verdict over a (diff, report). */
export interface RubricItemResult {
  key: RubricKey;
  pass: boolean;
  reason: string;
}

/** PR-level facts the satisfied_by guard needs (unknowable from the diff alone). */
export interface RubricPrMeta {
  /** The PR touches ONLY plan/docs (no product code) — an Architect plan PR. */
  planOnly?: boolean;
  /** The PR is authored by a human/Architect, not a worker session. */
  humanAuthored?: boolean;
}

/** Everything the rubric judges: the diff, the implement report, and PR-level facts. */
export interface RubricInput extends RubricPrMeta {
  diff: string;
  report?: string;
}

/** The rolled-up rubric verdict — all items plus the guard. */
export interface RubricResult {
  items: RubricItemResult[];
  failures: RubricItemResult[];
  pass: boolean;
}

// One classified line of a unified diff.
interface DiffLine {
  file: string;
  kind: "add" | "del" | "ctx";
  text: string;
}

/** Walk a unified diff into classified (file, kind, text) lines. Dependency-free. */
function walkDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const m = raw.match(/\sb\/(\S+)\s*$/);
      file = m ? m[1] : "";
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file = raw.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("@@")) continue;
    if (raw.startsWith("+")) out.push({ file, kind: "add", text: raw.slice(1) });
    else if (raw.startsWith("-")) out.push({ file, kind: "del", text: raw.slice(1) });
    else out.push({ file, kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return out;
}

// ── Item 1: ONE CONCERN per PR ─────────────────────────────────────────────

/**
 * The concern a changed file belongs to, keyed by its source STEM: `src/lib/foo.ts`
 * and its co-located `test/foo.test.ts` are the SAME concern (`foo`). Non-source
 * files (docs, plan, config) carry no concern and return null.
 */
function concernStem(path: string): string | null {
  const isSource = /^src\//.test(path) || /(^|\/)test(s)?\//.test(path) || /\.(test|spec)\./.test(path);
  if (!isSource) return null;
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "").replace(/\.[cm]?[jt]sx?$/, "");
}

/** Distinct files with at least one changed (add/del) line. */
function changedFiles(lines: DiffLine[]): string[] {
  const files = new Set<string>();
  for (const l of lines) {
    if ((l.kind === "add" || l.kind === "del") && l.file && l.file !== "/dev/null") files.add(l.file);
  }
  return [...files];
}

/**
 * ONE CONCERN: a PR should cluster around a single source module. Two or more
 * distinct product/test STEMS is the partial-fix-drift smell of a multi-concern PR.
 */
export function checkOneConcern(diff: string): RubricItemResult {
  const stems = new Set<string>();
  for (const f of changedFiles(walkDiff(diff))) {
    const s = concernStem(f);
    if (s) stems.add(s);
  }
  if (stems.size > 1) {
    return {
      key: "one-concern",
      pass: false,
      reason: `PR spans ${stems.size} concerns (${[...stems].sort().join(", ")}); one concern per PR — split it`,
    };
  }
  return {
    key: "one-concern",
    pass: true,
    reason: stems.size === 1 ? `single concern (${[...stems][0]})` : "no product-source change to concern-check",
  };
}

// ── Item 2: ALL CALLERS AUDITED (partial-fix drift) ────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count top-level (comma-separated) items in an argument/parameter string. */
function countTopLevel(inner: string): number {
  const s = inner.trim();
  if (s === "") return 0;
  let depth = 0;
  let count = 1;
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

/** Parse a single-line function/arrow definition into its name + parameter count. */
function parseDef(line: string): { name: string; params: number } | null {
  let m = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
  if (m) return { name: m[1], params: countTopLevel(m[2]) };
  m = line.match(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/);
  if (m) return { name: m[1], params: countTopLevel(m[2]) };
  return null;
}

/** Count the args at the FIRST call `name(...)` on a line, or null if not called. */
function callArgCount(line: string, name: string): number | null {
  const m = line.match(new RegExp(`(?<![\\w$])${escapeRegExp(name)}\\s*\\(`));
  if (m?.index === undefined) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")") {
      depth--;
      if (depth === 0) return countTopLevel(line.slice(open + 1, i));
    }
  }
  return null; // unterminated call on this line — cannot judge arity
}

/**
 * ALL CALLERS AUDITED: when a function's definition GAINS a parameter in the diff,
 * every call site must be updated too. A call left on an UNCHANGED (context) line
 * with the old (too-few) arity is an orphaned sibling — partial-fix drift.
 */
export function checkCallersAudited(diff: string): RubricItemResult {
  const lines = walkDiff(diff);
  const removedDefs = new Map<string, number>();
  const addedDefs = new Map<string, number>();
  for (const l of lines) {
    const d = parseDef(l.text);
    if (!d) continue;
    if (l.kind === "del") removedDefs.set(d.name, d.params);
    else if (l.kind === "add") addedDefs.set(d.name, d.params);
  }
  const gained = [...addedDefs].filter(([n, p]) => {
    const old = removedDefs.get(n);
    return old !== undefined && p > old;
  });
  for (const [name, need] of gained) {
    for (const l of lines) {
      if (l.kind !== "ctx") continue; // an unchanged caller = one the diff did not audit
      if (parseDef(l.text)?.name === name) continue; // the definition line itself is not a call
      const args = callArgCount(l.text, name);
      if (args !== null && args < need) {
        return {
          key: "callers-audited",
          pass: false,
          reason: `partial-fix drift: ${name}() gained a parameter but an unaudited caller still passes ${args} arg(s)`,
        };
      }
    }
  }
  return {
    key: "callers-audited",
    pass: true,
    reason: gained.length ? "every call site updated to the new signature" : "no signature change to audit",
  };
}

// ── Item 3: TEST THEATER ───────────────────────────────────────────────────

/** TEST THEATER as a rubric item — wraps {@link detectTestTheater}. */
export function checkTestTheater(diff: string): RubricItemResult {
  const theater = detectTestTheater(diff);
  return {
    key: "test-theater",
    pass: !theater,
    reason: theater ? "test theater: added tests assert nothing" : "no test theater detected",
  };
}

// ── Item 4: REFACTOR-PHASE HONESTY ─────────────────────────────────────────

// Lines that carry behavior: control flow, returns/throws, comparisons, boolean logic.
const BEHAVIOR_RE = /\breturn\b|\bif\s*\(|\belse\b|\bthrow\b|\bswitch\b|\bwhile\s*\(|\bfor\s*\(|[!=<>]==?|&&|\|\|/;

function isCommentOrBlank(text: string): boolean {
  const s = text.trim();
  return s === "" || s.startsWith("//") || s.startsWith("*") || s.startsWith("/*");
}

/**
 * REFACTOR-PHASE HONESTY: if the change is LABELLED a refactor (the report says so)
 * it must not change behavior. A pure refactor MOVES behavior-bearing lines verbatim
 * — every ADDED behavior line also appears (trimmed) among the REMOVED ones. A behavior
 * line that is added with no matching removal is net-new logic: dishonest for a refactor.
 */
export function checkRefactorHonesty(diff: string, report?: string): RubricItemResult {
  const labelled = /\brefactor/i.test(report ?? "");
  if (!labelled) return { key: "refactor-honesty", pass: true, reason: "change is not labelled a refactor" };
  const removed = new Set<string>();
  const added: string[] = [];
  for (const l of walkDiff(diff)) {
    if (isTestPath(l.file) || isCommentOrBlank(l.text) || !BEHAVIOR_RE.test(l.text)) continue;
    if (l.kind === "del") removed.add(l.text.trim());
    else if (l.kind === "add") added.push(l.text.trim());
  }
  const novel = added.find((a) => !removed.has(a));
  if (novel) {
    return {
      key: "refactor-honesty",
      pass: false,
      reason: `labelled a refactor but changes behavior (new logic: ${novel.slice(0, 60)})`,
    };
  }
  return { key: "refactor-honesty", pass: true, reason: "labelled a refactor; no behavior-bearing line changed" };
}

// ── The GUARD: no worker-authored satisfied_by ─────────────────────────────

/**
 * THE SATISFIED_BY GUARD: `satisfied_by` is Architect-only (plan.ts / Standing rule
 * 15). A diff that ADDS a `satisfied_by:` line to plan/tasks.yaml FAILS unless the PR
 * is plan-only AND human-authored — a worker adding it to its own blocking criterion
 * is "editing the criteria to match the diff", a failed task, not a merge.
 */
export function checkSatisfiedByGuard(diff: string, meta: RubricPrMeta = {}): RubricItemResult {
  const adds = walkDiff(diff).filter(
    (l) => l.kind === "add" && /(^|\/)plan\/tasks\.yaml$/.test(l.file) && /^\s*satisfied_by\s*:/.test(l.text),
  );
  if (adds.length === 0) {
    return { key: "satisfied-by-guard", pass: true, reason: "no satisfied_by added to plan/tasks.yaml" };
  }
  if (meta.planOnly && meta.humanAuthored) {
    return {
      key: "satisfied-by-guard",
      pass: true,
      reason: "satisfied_by added in a plan-only, human-authored PR (Architect-only — allowed)",
    };
  }
  return {
    key: "satisfied-by-guard",
    pass: false,
    reason:
      "worker-authored satisfied_by: adding it to plan/tasks.yaml outside a plan-only human PR is editing the criteria to match the diff (Standing rule 15)",
  };
}

/**
 * Run the full rubric — the four §5 layer-2 judgment items plus the satisfied_by
 * guard — over a (diff, report) and PR-level facts. ADVISORY: `pass` rolls up all
 * items, but the binding gate is layer 1. `failures` names exactly which items tripped.
 */
export function judgeRubric(input: RubricInput): RubricResult {
  const items: RubricItemResult[] = [
    checkOneConcern(input.diff),
    checkCallersAudited(input.diff),
    checkTestTheater(input.diff),
    checkRefactorHonesty(input.diff, input.report),
    checkSatisfiedByGuard(input.diff, { planOnly: input.planOnly, humanAuthored: input.humanAuthored }),
  ];
  const failures = items.filter((i) => !i.pass);
  return { items, failures, pass: failures.length === 0 };
}

// ── reviewer_outcome (W1-T63/P10-a — the reviewer stops walling silently) ──

/**
 * The observable OUTCOME of the fresh advisory reviewer spawn, surfaced on the
 * `review.posted` ledger line and the console review summary. Before this, a
 * floor-only PASS (the LLM reviewer walled `error_max_turns` on an undeclared
 * `maxTurns: 12` cap, or was never spawned at all) was byte-identical in the
 * ledger to a review the reviewer actually COMPLETED — an operator could not
 * tell "remudero-review=success, verified" from "remudero-review=success,
 * mechanical floor only" (P10-a). `judgeReview`'s binding verdict is unaffected
 * either way (Standing rules 2/4/12); this is purely a LEGIBILITY signal.
 */
export function reviewerOutcome(opts: {
  /** false when spawnReviewer===false or there were no criteria to judge — the
   * reviewer was never dispatched, by design, not by failure. */
  attempted: boolean;
  /** The reviewer WorkerResult.subtype, when a spawn actually ran to a terminal
   * state ("success" | "error_max_turns" | …). */
  subtype?: string;
  /** true when the spawn itself THREW (e.g. before yielding any result) —
   * distinct from a subtype, since there is none to report. */
  spawnError?: boolean;
}): string {
  if (!opts.attempted) return "not_attempted";
  if (opts.spawnError) return "spawn_error";
  return opts.subtype ?? "unknown";
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
