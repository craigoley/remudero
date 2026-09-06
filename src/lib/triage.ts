import type { Escalation, EscalationOption } from "./escalate.js";
import { join } from "node:path";
import { shapeCommitMessage } from "./commit-message.js";
import { loadPlan } from "./plan.js";
import { ACCEPTANCE_PROOF_GRAMMAR } from "./proof-grammar.js";
import { diffEmptyAgainstScope } from "./review.js";
import { feedbackEntryRepoPath } from "./feedback.js";
import { envelope } from "./untrusted-envelope.js";
import type { FeedbackEntry, FeedbackStatus } from "./feedback.js";

/**
 * `rmd triage` — the Architect intake worker (MASTER-PLAN §7B, W1-T41). Reads one feedback entry,
 * grounds it against plan/learnings/ledger/DECISIONS, researches with WebSearch only on a genuine
 * gap, then returns one of three verdicts (below). Write is scoped to plan files only — never
 * `src/` — and there is no Bash or git: the harness (run-task.ts's `triageCommand`) owns commit,
 * push, and PR open.
 *
 * INVARIANT: triage must run strictly serially, with itself and any hand-run — two concurrent
 * runs mint the same task id but write different shard files, so a duplicate-id merge to `main`
 * can go unnoticed until `loadPlan` throws for everyone. Held by three mechanisms together: the
 * daemon's single-threaded poll loop, a shared lock (PR #1069), and an atomic id reservation
 * before the worker spawns. `assertProposedPlanLoads` below is the pre-push backstop either way.
 *
 * The three-way verdict is deterministic, not the LLM's call (Standing rule 2): ALREADY_DECIDED
 * and AMBIGUOUS touch no plan files; PROPOSED opens a plan-only PR with `origin: feedback#<id>`
 * provenance. AMBIGUOUS opens an async needs-human issue — the only grill mechanism, since
 * AskUserQuestion auto-resolves empty under this worker's headless spawn.
 */
// Why: docs/forensics/triage.md#module-header (W1-T236 triple-mint, PR #1069, W1-T42).

// ── Arg parsing (pure — the `rmd triage` CLI arg shape) ─────────────────────

export interface ParsedTriageArgs {
  feedbackId: string;
}

/** Parse `rmd triage <feedback-id>`. Pure. Fails loud (`{ error }`, never a silent best-guess) on
 *  a missing id, an unrecognized flag, or extra positionals — validate before any spawn/write. */
export function parseTriageArgs(rest: string[]): ParsedTriageArgs | { error: string } {
  const positionals: string[] = [];
  for (const tok of rest) {
    if (tok.startsWith("--")) {
      return { error: `rmd triage: unrecognized flag '${tok}' — see \`rmd --help\`` };
    }
    positionals.push(tok);
  }
  if (positionals.length === 0) {
    return { error: "rmd triage: no feedback id given — usage: rmd triage <feedback-id>" };
  }
  if (positionals.length > 1) {
    return { error: `rmd triage: too many arguments — usage: rmd triage <feedback-id>, got ${JSON.stringify(positionals)}` };
  }
  return { feedbackId: positionals[0] };
}

// ── The "no such feedback entry" message (W1-T243) ───────────────────────────

/** Build `rmd triage`'s exit-2 message when `feedbackId` is absent from the fresh `origin/main`
 *  worktree — a genuine typo vs. an entry not yet landed (W1-T243). Pure; the caller supplies
 *  `existsLocally` and the best-effort `landingPrUrl`. */
export function missingFeedbackMessage(
  feedbackId: string,
  opts: { existsLocally: boolean; landingPrUrl?: string },
): string {
  if (!opts.existsLocally) return `no such feedback entry: ${feedbackId}`;
  const where = opts.landingPrUrl
    ? `pending landing PR ${opts.landingPrUrl}`
    : "a pending landing (the durable-inbox commit bridge has not opened its PR yet)";
  return (
    `feedback#${feedbackId} exists locally but has not landed on origin/main yet — ${where}. ` +
    `Re-run \`rmd triage ${feedbackId}\` once it merges.`
  );
}

// ── The Architect prompt ─────────────────────────────────────────────────────

/**
 * W1-T2700: the enveloped feedback block, built ONCE per dispatch. The envelope's boundary is
 * drawn fresh PER CALL, so calling this twice yields two different strings — a caller that wants
 * to both render the prompt AND fingerprint what the worker saw must build the block once and pass
 * it to {@link triagePrompt}, or the manifest would attest bytes the worker never received.
 */
export function feedbackEntryBlock(entry: FeedbackEntry): string {
  return envelope(entry.raw, "feedback-entry");
}

/**
 * The triage Architect prompt — fed one feedback entry, told to GROUND -> RESEARCH ->
 * GRILL-OR-PROPOSE, ending in one of the three verdict markers {@link parseTriageVerdict}
 * anchors on. `mintedId` (W1-T263) hands the worker its id directly, since it has no Bash tool to
 * compute one. `additionalReservedIds` (W1-T949 (ii)) names the rest of a reserved id block, so a
 * multi-task filing can't invent an id the harness never reserved; defaults to empty.
 */
export function triagePrompt(
  entry: FeedbackEntry,
  runId: string,
  mintedId?: string,
  additionalReservedIds: string[] = [],
  // APPENDED LAST and defaulted, so every existing positional caller is byte-identical to before
  // this parameter existed; only a caller that must fingerprint the block passes its own.
  feedbackBlock: string = feedbackEntryBlock(entry),
): string {
  return [
    "You are the REMUDERO ARCHITECT running an INTAKE TRIAGE (MASTER-PLAN §7B) over one captured",
    "feedback entry. You ride a HIGHER tier than implement workers (G-17). You do NOT have a Bash",
    "tool — you cannot run git or gh. Your job ends when you have edited the right files (or none)",
    "and printed your verdict; the harness commits/pushes/opens the PR after you finish.",
    "",
    "=== THE FEEDBACK ENTRY (plan/feedback/" + entry.id + ".yaml) ===",
    `id: ${entry.id}`,
    `ts: ${entry.ts}`,
    `origin: ${entry.origin}`,
    // W1-T2700: `raw` is the WIDEST FIRST INGESTION POINT in this harness. On the `rmd issues`
    // path it is a GitHub issue body -- anyone who can open an issue on a managed repo wrote it --
    // and on the `rmd feedback` path it is operator prose that may itself quote outside text. It
    // used to be spliced bare between narrative instruction lines, one `raw:` label away from the
    // STEP 1 heading a worker obeys. `id`/`ts`/`origin` above are harness-derived and stay bare.
    "raw:",
    feedbackBlock,
    entry.attachments.length ? `attachments: ${entry.attachments.join(", ")}` : "attachments: (none)",
    "",
    "=== STEP 1 — GROUND ===",
    "Grep/Read MASTER-PLAN.md, plan/tasks.yaml, plan/tasks.d/*.yaml, LEARNINGS.md, and DECISIONS.md (all in this working",
    "directory) for whatever this feedback is asking about. Re-deciding a settled question is a",
    "failure mode, not a feature — if the answer is ALREADY there, that is your verdict, full stop.",
    "",
    "=== STEP 2 — RESEARCH ===",
    "If (and only if) grounding leaves a genuine platform-facts gap this feedback turns on, use",
    "WebSearch to close it. Skip this step entirely when grounding already answers the question —",
    "research exists to make a proposal GROUNDED, not to pad the transcript.",
    "",
    "=== STEP 3 — GRILL OR PROPOSE ===",
    "Decide exactly ONE of:",
    "",
    "  ALREADY_DECIDED — the plan/learnings/DECISIONS already answer this. Touch NO files. End your",
    "  output with a line starting exactly `ALREADY_DECIDED:` naming the deciding section/PR/entry,",
    "  e.g. `ALREADY_DECIDED: MASTER-PLAN.md §7B / PR #238`.",
    "",
    "  AMBIGUOUS — this needs a human call this triage pass cannot safely make alone. Touch NO",
    "  files. This triage runs HEADLESSLY (no terminal, no live operator) — the grill is an async",
    "  `needs-human` GitHub issue, never an interactive prompt. End your output with:",
    "    OPTION: <short label>|<what choosing it means>",
    "    OPTION: <short label>|<what choosing it means>",
    "  at least TWO `OPTION:` lines (add more only if there are genuinely more than two live",
    "  choices) — these become the issue's actionable choices (MASTER-PLAN §4: an escalation with",
    "  no options is refused as a bare alert) — then:",
    "    RECOMMENDATION: <the exact label of the option you'd pick if forced to guess>",
    "    AMBIGUOUS: <the open question, one line>",
    "  e.g.:",
    "    OPTION: cli-flag|add a --foo flag to the relevant command",
    "    OPTION: config-default|add a config default instead, no new flag",
    "    RECOMMENDATION: cli-flag",
    "    AMBIGUOUS: does this want a CLI flag or a config default?",
    "",
    "  PROPOSED — the ask is CLEAR and NOVEL. Edit ONLY plan files in this working directory",
    "  (NEVER src/ or test/) to add or rewire whatever the feedback calls for.",
    "  A NEW task MUST be created as its OWN SHARD at plan/tasks.d/<id>-<kebab-slug>.yaml — one task",
    "  per file, a single-element YAML list. plan/tasks.d/W1-T278-task-id-from-plan-history.yaml is the",
    "  model for that STRUCTURE (file shape and fields) only; for `proof:` values follow the ACCEPTANCE",
    "  PROOFS rules below, which are what CI actually enforces.",
    "  NEVER append a new task to plan/tasks.yaml: 69 filings appending to one 12.5k-line file all",
    "  collide at EOF, which is the conflict storm W1-T122 sharded the plan to prevent.",
    "  REWIRING an EXISTING task edits wherever that task already lives (the monolith or its shard).",
    "  EVERY new or rewired task MUST declare `files:` — the repo-relative paths it will touch.",
    "  An absent or EMPTY list is fail-closed at dispatch: overlappingPaths reports it as overlapping",
    "  every co-dispatched candidate, so the task can never batch and serialises the lane behind it.",
    "  You have Read/Grep/Glob here — derive the paths, never omit the field and never leave it empty.",
    "  MASTER-PLAN.md remains a legitimate target for a plan amendment. Every new or rewired task MUST carry",
    `  \`origin: feedback#${entry.id}\` so the provenance is traceable.`,
    ...(mintedId
      ? [
          `  ID SELECTION for any NEW task: USE EXACTLY \`${mintedId}\` — the harness already minted it`,
          "  from the max across plan/tasks.yaml, EVERY plan/tasks.d/*.yaml shard, and the ids open plan",
          "  PRs have already minted. Do NOT pick your own id and do NOT 'correct' this one: a colliding",
          "  id is refused pre-push, so a wrong pick means NO proposal opens.",
          ...(additionalReservedIds.length > 0
            ? [
                `  The harness has ALSO RESERVED ${additionalReservedIds.join(", ")} for this run, on the`,
                "  SAME shared remote store — if the feedback needs MORE than one new task, use them IN",
                "  THIS ORDER after the first. Do NOT invent an id yourself and do NOT renumber past this",
                "  reserved set: an id you choose yourself is unreserved, and another lane may be filing",
                "  it at this very moment. Filing fewer than the reserved count is normal and costs",
                `  nothing; you may file AT MOST ${1 + additionalReservedIds.length} new task(s) this run.`,
              ]
            : [
                `  If the feedback needs MORE than one new task, number them upward from ${mintedId}`,
                `  (${mintedId}, then the next integers).`,
              ]),
        ]
      : [
          "  ID SELECTION for any NEW task: ids live in BOTH plan/tasks.yaml AND plan/tasks.d/*.yaml",
          "  (the shards own ids the monolith does not — a colliding id is refused pre-push, so a wrong",
          "  pick means NO proposal opens). Mint the next integer above the highest id across the",
          "  monolith AND every shard — read both, never the monolith alone.",
        ]),
    ...ACCEPTANCE_PROOF_GRAMMAR,
    "  End your output with a line",
    "  starting exactly `PROPOSED:` with a one-line summary of what changed and why, e.g.",
    "  `PROPOSED: add W1-T200 (origin: feedback#" + entry.id + ") to cover the requested CLI flag`.",
    "",
    "Exactly one of ALREADY_DECIDED / AMBIGUOUS / PROPOSED must be the LAST line of your output.",
    "Do NOT edit plan/feedback/" + entry.id + ".yaml yourself (the harness records the resulting",
    "status/proposal_pr deterministically). Do NOT touch docs/ORIENTATION.md.",
    "",
    `(run: ${runId})`,
  ].join("\n");
}

// ── Verdict parsing (pure) ───────────────────────────────────────────────────

export type TriageVerdict =
  | { kind: "already_decided"; citation: string }
  | { kind: "ambiguous"; question: string; options: EscalationOption[]; recommendation: string }
  | { kind: "proposed"; summary: string };

/**
 * `OPTION: <label>|<detail>` lines anywhere in the worker's output — the grill's actionable
 * choices, meaningful only for an AMBIGUOUS verdict. Idempotent on the `(label, detail)` pair
 * (W1-T2205), since a model can restate or quote its own options back; first occurrence wins.
 */
function parseGrillOptions(text: string): EscalationOption[] {
  const seen = new Set<string>();
  const options: EscalationOption[] = [];
  for (const m of text.matchAll(/^[ \t]*OPTION[ \t]*:[ \t]*(.+)$/gim)) {
    const raw = m[1].trim();
    const sep = raw.indexOf("|");
    const option = sep >= 0 ? { label: raw.slice(0, sep).trim(), detail: raw.slice(sep + 1).trim() } : { label: raw, detail: "" };
    const key = JSON.stringify([option.label, option.detail]);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  return options;
}

/** The LAST `RECOMMENDATION: <label>` line — {@link decideTriage} fails loud unless it matches
 * one of the parsed OPTION labels exactly. `""` when no such line appears. */
function parseGrillRecommendation(text: string): string {
  const hits = [...text.matchAll(/^[ \t]*RECOMMENDATION[ \t]*:[ \t]*(.+)$/gim)];
  return hits.length ? hits[hits.length - 1][1].trim() : "";
}

/**
 * Extract the worker's terminal verdict from its output. Anchored to a line start, like {@link
 * "./worker.js".parseReport}'s `PR_URL:`, so a marker only mentioned in passing prose never
 * counts. The LAST marker line wins when more than one appears.
 */
export function parseTriageVerdict(text: string): TriageVerdict | null {
  const already = [...text.matchAll(/^[ \t]*ALREADY_DECIDED[ \t]*:[ \t]*(.+)$/gim)];
  const ambiguous = [...text.matchAll(/^[ \t]*AMBIGUOUS[ \t]*:[ \t]*(.+)$/gim)];
  const proposed = [...text.matchAll(/^[ \t]*PROPOSED[ \t]*:[ \t]*(.+)$/gim)];
  type Hit = { at: number; verdict: TriageVerdict };
  const hits: Hit[] = [];
  if (already.length) {
    const m = already[already.length - 1];
    hits.push({ at: m.index ?? 0, verdict: { kind: "already_decided", citation: m[1].trim() } });
  }
  if (ambiguous.length) {
    const m = ambiguous[ambiguous.length - 1];
    hits.push({
      at: m.index ?? 0,
      verdict: {
        kind: "ambiguous",
        question: m[1].trim(),
        options: parseGrillOptions(text),
        recommendation: parseGrillRecommendation(text),
      },
    });
  }
  if (proposed.length) {
    const m = proposed[proposed.length - 1];
    hits.push({ at: m.index ?? 0, verdict: { kind: "proposed", summary: m[1].trim() } });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.at - b.at);
  return hits[hits.length - 1].verdict;
}

// THE THIRD STATE (W1-T2212): `TriageOutcome` below distinguishes "unparseable" from "produced a
// verdict" before either reaches `decideTriage`, which used to fold a `null` verdict into the
// SAME `action: "error"` a worker that physically misbehaved also produces. `runTriageWithRetry`'s
// retry branch is reachable only from `kind: "unparseable"`, never from a parsed verdict.
// Why: docs/forensics/triage.md#the-third-state (W1-T2212).

export type TriageOutcome = { kind: "verdict"; verdict: TriageVerdict } | { kind: "unparseable" };

/** Classify one worker attempt's raw output text — the third-state boundary {@link
 *  runTriageWithRetry} narrows its retry decision on. Pure wrapper over {@link
 *  parseTriageVerdict}. */
export function classifyTriageOutcome(text: string): TriageOutcome {
  const verdict = parseTriageVerdict(text);
  return verdict === null ? { kind: "unparseable" } : { kind: "verdict", verdict };
}

// ── Deterministic decision (pure) ────────────────────────────────────────────

export interface DecideTriageInput {
  verdict: TriageVerdict | null;
  /** Repo-relative paths the worker itself touched (`git diff --name-only` before the harness's
   * own status write), e.g. from `git -C <worktree> diff --name-only origin/main`. */
  changedFiles: string[];
  /** How many attempts {@link runTriageWithRetry} spent before this call (W1-T2212). Undefined for
   *  a caller with no retry loop; otherwise folded into the error message alongside `verdict: null`. */
  attempts?: number;
}

export type TriageDecision =
  | { action: "no_task"; status: Extract<FeedbackStatus, "rejected">; detail: string }
  | {
      action: "grill";
      status: Extract<FeedbackStatus, "grilling">;
      detail: string;
      /** The grill's actionable choices — always >= 2, {@link decideTriage} enforces it (the
       * async needs-human issue is the ONLY grill mechanism, W1-T42, and escalate() refuses a
       * bare alert with no options). */
      options: EscalationOption[];
      /** Must exactly match one of `options[].label` — {@link decideTriage} enforces it. */
      recommendation: string;
    }
  | { action: "propose"; status: Extract<FeedbackStatus, "proposed">; detail: string; files: string[] }
  | {
      action: "error";
      reason: string;
      /** The cause AS DATA (W1-T2212): `non_plan_files` (physical misbehavior), `unparseable_verdict`
       *  (output {@link runTriageWithRetry} could not read), or `inconsistent_verdict` (a parseable
       *  verdict that contradicted its own files or OPTION/RECOMMENDATION contract). Optional: the
       *  AMBIGUOUS-with-fewer-than-2-options branch below omits it (pinned in test/triage.test.ts). */
      cause?: "non_plan_files" | "unparseable_verdict" | "inconsistent_verdict";
    };

/**
 * The three-way verdict as a pure function (mirrors {@link "./dep-review.js".decideDepReview}):
 * cross-checks the declared verdict against what files the worker actually touched, failing loud
 * on any inconsistency rather than trusting either signal alone.
 */
export function decideTriage(input: DecideTriageInput): TriageDecision {
  // MASTER-PLAN.md is a plan file by the prompt's own contract despite living at the repo root:
  // a bare `plan/`-prefix filter once fail-closed every proposal that touched it (#550, feedback
  // 728bc1). This guard and the prompt must keep agreeing on what "plan file" means.
  const nonPlan = input.changedFiles.filter((f) => !f.startsWith("plan/") && f !== "MASTER-PLAN.md");
  if (nonPlan.length > 0) {
    return {
      action: "error",
      reason: `triage worker touched non-plan file(s): ${nonPlan.join(", ")}`,
      cause: "non_plan_files",
    };
  }
  if (!input.verdict) {
    // The third state's terminal shape (W1-T2212), reached directly or via runTriageWithRetry's
    // exhausted bound — the same escalation either way.
    return {
      action: "error",
      reason:
        input.attempts === undefined
          ? "no ALREADY_DECIDED:/AMBIGUOUS:/PROPOSED: verdict line found in the worker's output"
          : `no ALREADY_DECIDED:/AMBIGUOUS:/PROPOSED: verdict line found after ${input.attempts} attempt(s) — ` +
            "the worker's output was unparseable (a MALFORMED RESPONSE), not an adverse verdict",
      cause: "unparseable_verdict",
    };
  }
  if (input.verdict.kind === "already_decided") {
    if (input.changedFiles.length > 0) {
      return {
        action: "error",
        reason: `ALREADY_DECIDED but files were changed: ${input.changedFiles.join(", ")}`,
        cause: "inconsistent_verdict",
      };
    }
    return { action: "no_task", status: "rejected", detail: input.verdict.citation };
  }
  if (input.verdict.kind === "ambiguous") {
    const verdict = input.verdict; // narrowed local — property-access narrowing doesn't survive into a closure below
    if (input.changedFiles.length > 0) {
      return {
        action: "error",
        reason: `AMBIGUOUS but files were changed: ${input.changedFiles.join(", ")}`,
        cause: "inconsistent_verdict",
      };
    }
    // The async needs-human issue is the only grill mechanism (W1-T42) — fewer than 2 OPTION:
    // lines is not an actionable escalation; fail loud here, not deeper in escalate().
    if (verdict.options.length < 2) {
      // `cause` deliberately omitted here — see the DecideTriageInput.cause doc comment above.
      return {
        action: "error",
        reason: `AMBIGUOUS verdict carries ${verdict.options.length} OPTION: line(s) — a grill needs at least 2 actionable choices`,
      };
    }
    if (!verdict.options.some((o) => o.label === verdict.recommendation)) {
      return {
        action: "error",
        reason: `AMBIGUOUS verdict's RECOMMENDATION (${JSON.stringify(verdict.recommendation)}) does not match any OPTION label (${verdict.options.map((o) => o.label).join(", ")})`,
        cause: "inconsistent_verdict",
      };
    }
    return {
      action: "grill",
      status: "grilling",
      detail: verdict.question,
      options: verdict.options,
      recommendation: verdict.recommendation,
    };
  }
  // proposed
  if (input.changedFiles.length === 0) {
    return { action: "error", reason: "PROPOSED but no plan files were changed", cause: "inconsistent_verdict" };
  }
  return { action: "propose", status: "proposed", detail: input.verdict.summary, files: input.changedFiles };
}

// W1-T2212: the retry RE-REQUESTS `deps.spawnAttempt` with the SAME `prompt` every time, never
// RE-ASKS with new information — unlike the relint loop (run-task.ts's `runRelintLoop`), which
// folds the prior round's violations into a new prompt to fix plan-lint errors.
// Why: docs/forensics/triage.md#the-bounded-retry (design ii/iii/v).

/** BACKSTOP (W1-T1266): a parsed verdict, adverse or not, always returns on attempt 1 — this
 *  bound fires only once the worker has repeatedly produced unparseable output, mirroring
 *  risk-judge.ts's `RISK_JUDGE_MAX_ATTEMPTS` (the retry contract must match both rungs). */
export const TRIAGE_VERDICT_MAX_ATTEMPTS = 3;

/** One triage worker attempt's raw result — the caller's own spawn, never this module's concern. */
export interface TriageAttemptResult {
  /** The worker's raw concatenated output text, fed to {@link classifyTriageOutcome}. */
  text: string;
  /** What the worker touched THIS attempt — re-read fresh per attempt, never carried over. */
  changedFiles: string[];
}

export interface TriageRetryDeps {
  /** Spawn ONE triage attempt and return its raw result. Called with the IDENTICAL `prompt`
   *  every time. */
  spawnAttempt: (prompt: string) => Promise<TriageAttemptResult>;
  /** One ledger-shaped line per attempt, so the count is auditable, not inferred. No-op default. */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

export interface TriageRetryResult {
  decision: TriageDecision;
  changedFiles: string[];
  /** 1 when the first attempt parsed, up to `maxAttempts` when every attempt was unparseable. */
  attempts: number;
}

/**
 * Spawn up to `maxAttempts` attempts with the SAME `prompt`, retrying only while {@link
 * classifyTriageOutcome} reports `unparseable`. At the bound, falls through to {@link
 * decideTriage} with `verdict: null` — the same error a single unparseable response produces.
 */
export async function runTriageWithRetry(
  prompt: string,
  deps: TriageRetryDeps,
  maxAttempts: number = TRIAGE_VERDICT_MAX_ATTEMPTS,
): Promise<TriageRetryResult> {
  if (maxAttempts < 1) throw new Error("runTriageWithRetry: maxAttempts must be >= 1");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text, changedFiles } = await deps.spawnAttempt(prompt);
    const outcome = classifyTriageOutcome(text);
    deps.log?.("triage.verdict_attempt", { attempt, max_attempts: maxAttempts, kind: outcome.kind });
    if (outcome.kind === "verdict") {
      return { decision: decideTriage({ verdict: outcome.verdict, changedFiles }), changedFiles, attempts: attempt };
    }
    if (attempt === maxAttempts) {
      return {
        decision: decideTriage({ verdict: null, changedFiles, attempts: attempt }),
        changedFiles,
        attempts: attempt,
      };
    }
  }
  /* c8 ignore next */
  throw new Error("runTriageWithRetry: unreachable — the loop above always returns by its last iteration");
}

// ── Post-hoc deterministic guards (pure, mirroring lib/retro.ts's codeFilesInDiff) ─────────────

/** ID-COLLISION GUARD (W1-T236): loads the FULL merged plan (monolith + shards) from the
 *  worker's own worktree before anything is pushed, so a duplicate id `loadPlan` would reject is
 *  refused pre-push instead of shipping a PR every plan-loading CI check would then reject. */
// Why: docs/forensics/triage.md#assertproposedplanloads (the 2026-07-22 triple-mint, W1-T236).
export function assertProposedPlanLoads(worktreeRoot: string): void {
  loadPlan(join(worktreeRoot, "plan", "tasks.yaml"));
}

/** Files OUTSIDE `plan/` touched by a unified diff — the same fail-closed guard `lib/retro.ts`'s
 *  `codeFilesInDiff` gives the retro, generalized to allow `MASTER-PLAN.md` alongside plan/*. */
export function nonPlanFilesInDiff(diff: string): string[] {
  // Same "plan file" definition as decideTriage's guard above — keep them in sync (728bc1).
  return [...diff.matchAll(/^\+\+\+ b\/(\S+)/gm)]
    .map((m) => m[1])
    .filter((f) => !f.startsWith("plan/") && f !== "MASTER-PLAN.md");
}

/** Whether a diff carries the `feedback#<id>` provenance token the PROPOSED contract requires. */
export function diffCitesFeedback(diff: string, feedbackId: string): boolean {
  return diff.includes(`feedback#${feedbackId}`);
}

// W1-T963: `nonPlanFilesInDiff` compares against a frozen fork-point, so it stays non-empty even
// once a sibling triage PR for the same entry already landed the same change on `origin/main`.
// `triageDeclaredScope`/`triageEmptyScopeDisposition` below check the LIVE diff instead.
// Why: docs/forensics/triage.md#the-empty-diff-triage-merge-incident (#2075/#2077/#2078).

/** The declared scope of a `no_task`/`grill` decision: only the feedback entry's status flip.
 *  Not used for `propose`, whose new plan/tasks.d/ shard needs the wider check. */
export function triageDeclaredScope(feedbackId: string): string[] {
  return [feedbackEntryRepoPath(feedbackId)];
}

/** What a triage merge gate does once it knows whether the live diff against {@link
 *  triageDeclaredScope} is empty: `close` (a sibling already shipped it) or `proceed`. */
export interface TriageEmptyScopeDisposition {
  action: "close" | "proceed";
  /** Present only for `action: "close"` — the `gh pr close --comment` text naming why. */
  comment?: string;
}

/** Decide close-vs-proceed. Pure: `liveDiffFiles` is the caller's own fresh `git diff
 *  --name-only origin/main HEAD -- <scope>` read. */
export function triageEmptyScopeDisposition(
  liveDiffFiles: readonly string[],
  scopeFiles: readonly string[],
): TriageEmptyScopeDisposition {
  if (!diffEmptyAgainstScope(liveDiffFiles, scopeFiles)) return { action: "proceed" };
  return {
    action: "close",
    comment:
      `rmd triage: closing, not merging — this PR's diff against the current \`origin/main\` is empty ` +
      `for its declared scope (${scopeFiles.join(", ")}); a sibling triage PR already landed this ` +
      `same change (W1-T963).`,
  };
}

// ── Commit message / PR body authorship (harness-owned, deterministic) ──────────────────────


// Commit-body line budget: `shapeCommitMessage` protects the header (W1-T136), but commitlint
// also caps body lines at 100 chars, and the templates below interpolate LLM free text. Prose
// word-wraps; an `Acceptance:` bullet must stay one line (a wrap would orphan later criteria) so
// it is truncated with an ellipsis instead, never the full detail above it.
// Why: docs/forensics/triage.md#commit-body-line-budget (the 2026-07-22 commitlint outage).

/** commitlint's body-max-line-length bound, mirrored from commitlint.config.mjs. */
export const COMMIT_BODY_MAX_LINE = 100;

/** Word-wrap one prose line to the body budget (never used on Acceptance bullets). */
export function wrapBodyLine(line: string, max: number = COMMIT_BODY_MAX_LINE): string[] {
  if (line.length <= max) return [line];
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(" ")) {
    if (cur && (cur + " " + word).length > max) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? cur + " " + word : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Hard-cap an Acceptance bullet to ONE line within the budget (ellipsis, never wrapped). */
export function fitAcceptanceBullet(bullet: string, max: number = COMMIT_BODY_MAX_LINE): string {
  return bullet.length <= max ? bullet : bullet.slice(0, max - 1) + "\u2026";
}

/** The executable proof for a triage outcome, in the house `grep: <pattern> in <path>` dialect
 *  {@link "./review.js".parseWhitelistedProof} accepts \u2014 a fixed English phrase here used to cap
 *  every triage PR at 0 proofs executed. Derived from `decision.status`, never re-typed, so it
 *  can't drift from the status `setFeedbackStatus` writes into the same diff; it discriminates
 *  because the entry reads `status: new` at the merge base. */
// Why: docs/forensics/triage.md#triageacceptanceproof (the fixed-phrase capped-verdict incident).
export function triageAcceptanceProof(feedbackId: string, status: FeedbackStatus): string {
  return `grep: status: ${status} in ${feedbackEntryRepoPath(feedbackId)}`;
}

/** One Acceptance criterion as the labelled two-line form (`- claim: \u2026` + indented `proof: \u2026`),
 *  which {@link "./review.js".parseAcceptanceBlock} also recognises \u2014 split from the one-line
 *  `- claim | proof` shape because a long feedback id's proof alone runs ~90 chars and the
 *  combined bullet used to exceed the 100-char body budget and get elided mid-phrase. The claim
 *  may be elided; the proof line never is. */
// Why: docs/forensics/triage.md#acceptancecriterionlines (the mid-phrase-ellipsis incident).
export function acceptanceCriterionLines(claim: string, proof: string, max: number = COMMIT_BODY_MAX_LINE): string[] {
  return [fitAcceptanceBullet(`- claim: ${claim}`, max), ` proof: ${proof}`];
}

/** The commit message (and PR title+body) the HARNESS authors for a triage outcome — never the
 *  LLM, so the `Acceptance:`/`Remudero-Task:` contract can never be malformed: title, blank line,
 *  an `Acceptance:` block {@link "./review.js".parseAcceptanceBlock} parses, then provenance. */
export function triageCommitMessage(opts: {
  decision: Exclude<TriageDecision, { action: "error" }>;
  feedbackId: string;
  taskId: string;
  /** The needs-human issue URL {@link buildGrillEscalation}/`escalate()` opened for a `grill`
   * decision (W1-T42) — undefined only when `decision.action !== "grill"`. */
  grillIssueUrl?: string;
}): string {
  const { decision, feedbackId, taskId, grillIssueUrl } = opts;
  if (decision.action === "no_task") {
    return [
      `chore(triage): feedback#${feedbackId} — already decided, no task`,
      "",
      ...wrapBodyLine(`Grounding found this already answered — adds NO redundant task: ${decision.detail}`),
      "",
      "Acceptance:",
      ...acceptanceCriterionLines(
        `feedback#${feedbackId} already decided, NO task — the entry is closed out, not left open`,
        triageAcceptanceProof(feedbackId, decision.status),
      ),
      "",
      `Remudero-Task: ${taskId}`,
    ].join("\n");
  }
  if (decision.action === "grill") {
    return [
      `chore(triage): feedback#${feedbackId} — ambiguous, parked for the grill`,
      "",
      ...wrapBodyLine(`Open question: ${decision.detail}`),
      "",
      ...wrapBodyLine(
        `Grill (needs-human, ${decision.options.length} options, recommends "${decision.recommendation}"): ${grillIssueUrl ?? "(see run ledger — issue open failed to record here)"}`,
      ),
      "",
      "Acceptance:",
      ...acceptanceCriterionLines(
        `feedback#${feedbackId} grilled: ambiguous, NO task — parked on a needs-human issue`,
        triageAcceptanceProof(feedbackId, decision.status),
      ),
      "",
      `Remudero-Task: ${taskId}`,
    ].join("\n");
  }
  // propose — `decision.detail` is LLM free text that can blow the header limit, so it's shaped.
  const shapedHeader = shapeCommitMessage(`chore(plan)`, `triage feedback#${feedbackId} — ${decision.detail}`).header;
  return [
    shapedHeader,
    "",
    ...wrapBodyLine(`Proposed by the intake triage (origin: feedback#${feedbackId}): ${decision.detail}`),
    "",
    "Acceptance:",
    ...acceptanceCriterionLines(
      `feedback#${feedbackId} proposal filed — in-diff provenance back to the entry`,
      triageAcceptanceProof(feedbackId, decision.status),
    ),
    "",
    `Remudero-Task: ${taskId}`,
  ].join("\n");
}

// ── THE GRILL: the needs-human escalation payload (W1-T42) ──────────────────────────────────

/** Build the `Escalation` (lib/escalate.ts) for an AMBIGUOUS feedback item — the async
 *  needs-human GitHub issue that is the grill, the only viable mechanism (see the module header).
 *  Pure, like {@link triageCommitMessage}; the caller owns the real `escalate()`/git I/O. */
export function buildGrillEscalation(opts: {
  entry: FeedbackEntry;
  decision: Extract<TriageDecision, { action: "grill" }>;
  taskId: string;
  runId: string;
}): Escalation {
  const { entry, decision, taskId, runId } = opts;
  return {
    class: "GRILL",
    taskId,
    runId,
    summary: `feedback#${entry.id} needs a human call: ${decision.detail}`,
    // W1-T2700: this detail becomes a needs-human ISSUE BODY, which later rungs read back into
    // prompts -- so the same outside text makes a round trip and is enveloped on the way out too,
    // not only where it first enters. `decision.detail` is the triage worker's own words.
    detail: [`Feedback:`, envelope(entry.raw, "feedback-entry"), "", `Open question: ${decision.detail}`].join("\n"),
    options: decision.options,
    recommendation: decision.recommendation,
  };
}
