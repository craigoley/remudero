import type { FeedbackEntry, FeedbackStatus } from "./feedback.js";

/**
 * `rmd triage` — the Architect intake worker (MASTER-PLAN §7B, W1-T41).
 *
 * "An Architect worker over a feedback entry. Tools: Read/Glob/Grep/WebSearch/WebFetch + Write
 * scoped to plan files ONLY (never src/). Grounds against plan/learnings/ledger/DECISIONS,
 * researches via server-side WebSearch, then (if clear) opens a plan PR naming the §sections
 * changed, tasks added/rewired, rationale, and provenance back to feedback#<id>." [MASTER-PLAN §7B]
 *
 * THE THREE-WAY VERDICT, deterministic (mirroring lib/dep-review.ts's `decideDepReview` — the
 * judge is CODE, the LLM layer is advisory only, Standing rule 2):
 *   - ALREADY_DECIDED — the ground step found the feedback's answer already settled somewhere in
 *     plan/learnings/DECISIONS. No plan files change. NO redundant task is created — the whole
 *     point of grounding (re-deciding a settled question is a failure mode, not a feature).
 *   - AMBIGUOUS        — the item needs a human's judgment call. No plan files change. Status
 *     parks at `grilling`; the actual grill mechanics (AskUserQuestion / a needs-human issue,
 *     reusing §4's escalation machinery) are W1-T42's job, not this task's — `.remudero/skills/
 *     feedback.yaml` lists `AskUserQuestion` in its tools for that later wiring, but this module
 *     does not hand the worker that tool yet (LEARNINGS "no live operator in a headless worker":
 *     an interactive prompt with no TTY just hangs / burns turns).
 *   - PROPOSED         — a plan-only PR naming the §sections/tasks changed, with `origin:
 *     feedback#<id>` provenance on every new/rewired task.
 *
 * THE WORKER NEVER RUNS GIT (`.remudero/skills/feedback.yaml`'s `tools:` carries no `Bash`, unlike
 * `retro.yaml`) — it only GROUNDS/RESEARCHES/EDITS plan files via Read/Grep/Glob/WebSearch/Write.
 * The commit/push/PR-open/gate sequence is HARNESS-OWNED (run-task.ts's `triageCommand`),
 * deterministic, and identical in shape for all three verdicts — the same "the harness eats
 * first" discipline `regenerateOrientation` already established for the retro's docs write.
 */

// ── Arg parsing (pure — the `rmd triage` CLI arg shape) ─────────────────────

export interface ParsedTriageArgs {
  feedbackId: string;
}

/**
 * Parse `rmd triage <feedback-id>`. Pure (no I/O) so it is unit-testable without a filesystem.
 * FAILS LOUD (returns `{ error }`, never a silent best-guess) on a missing id, an unrecognized
 * flag, or extra positional arguments — the control-surface discipline every `rmd` subcommand
 * follows (Standing rule: validate flags BEFORE any spawn/write).
 */
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

// ── The Architect prompt ─────────────────────────────────────────────────────

/**
 * The triage Architect prompt — fed one feedback entry, told to GROUND -> RESEARCH ->
 * GRILL-OR-PROPOSE, and required to end with exactly one of the three verdict markers this
 * module's {@link parseTriageVerdict} anchors on. The worker has NO Bash/git — it only edits
 * files; the caller (run-task.ts) owns commit/push/PR.
 */
export function triagePrompt(entry: FeedbackEntry, runId: string): string {
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
    `raw: ${entry.raw}`,
    entry.attachments.length ? `attachments: ${entry.attachments.join(", ")}` : "attachments: (none)",
    "",
    "=== STEP 1 — GROUND ===",
    "Grep/Read MASTER-PLAN.md, plan/tasks.yaml, LEARNINGS.md, and DECISIONS.md (all in this working",
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
    "  AMBIGUOUS — this needs a human call this triage pass cannot safely make alone (the actual",
    "  grill — AskUserQuestion / a needs-human issue — is a separate, later capability). Touch NO",
    "  files. End your output with a line starting exactly `AMBIGUOUS:` naming the open question,",
    "  e.g. `AMBIGUOUS: does this want a CLI flag or a config default?`.",
    "",
    "  PROPOSED — the ask is CLEAR and NOVEL. Edit ONLY plan files in this working directory",
    "  (plan/tasks.yaml and/or MASTER-PLAN.md — NEVER src/ or test/) to add or rewire whatever the",
    "  feedback calls for. Every new or rewired plan/tasks.yaml task MUST carry",
    `  \`origin: feedback#${entry.id}\` so the provenance is traceable. End your output with a line`,
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
  | { kind: "ambiguous"; question: string }
  | { kind: "proposed"; summary: string };

/**
 * Extract the worker's terminal verdict off its concatenated output text. Anchored to a line
 * start (like {@link "./worker.js".parseReport}'s `PR_URL:` anchoring) so a marker mentioned in
 * passing prose (e.g. quoting this very prompt back) never counts — only a line that STARTS with
 * one of the three keywords does. When more than one marker line appears, the LAST one wins
 * (mirrors the "last line of the REPORT" convention).
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
    hits.push({ at: m.index ?? 0, verdict: { kind: "ambiguous", question: m[1].trim() } });
  }
  if (proposed.length) {
    const m = proposed[proposed.length - 1];
    hits.push({ at: m.index ?? 0, verdict: { kind: "proposed", summary: m[1].trim() } });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.at - b.at);
  return hits[hits.length - 1].verdict;
}

// ── Deterministic decision (pure) ────────────────────────────────────────────

export interface DecideTriageInput {
  verdict: TriageVerdict | null;
  /** Repo-relative paths the worker itself touched (`git diff --name-only` before the harness's
   * own status write), e.g. from `git -C <worktree> diff --name-only origin/main`. */
  changedFiles: string[];
}

export type TriageDecision =
  | { action: "no_task"; status: Extract<FeedbackStatus, "rejected">; detail: string }
  | { action: "grill"; status: Extract<FeedbackStatus, "grilling">; detail: string }
  | { action: "propose"; status: Extract<FeedbackStatus, "proposed">; detail: string; files: string[] }
  | { action: "error"; reason: string };

/**
 * The three-way verdict as a PURE function (mirrors {@link "./dep-review.js".decideDepReview}):
 * ground truth is what FILES the worker actually touched, cross-checked against its declared
 * verdict — an inconsistency (e.g. claiming ALREADY_DECIDED while also editing plan/tasks.yaml)
 * fails loud rather than silently trusting either signal alone.
 */
export function decideTriage(input: DecideTriageInput): TriageDecision {
  const nonPlan = input.changedFiles.filter((f) => !f.startsWith("plan/"));
  if (nonPlan.length > 0) {
    return { action: "error", reason: `triage worker touched non-plan file(s): ${nonPlan.join(", ")}` };
  }
  if (!input.verdict) {
    return {
      action: "error",
      reason: "no ALREADY_DECIDED:/AMBIGUOUS:/PROPOSED: verdict line found in the worker's output",
    };
  }
  if (input.verdict.kind === "already_decided") {
    if (input.changedFiles.length > 0) {
      return { action: "error", reason: `ALREADY_DECIDED but files were changed: ${input.changedFiles.join(", ")}` };
    }
    return { action: "no_task", status: "rejected", detail: input.verdict.citation };
  }
  if (input.verdict.kind === "ambiguous") {
    if (input.changedFiles.length > 0) {
      return { action: "error", reason: `AMBIGUOUS but files were changed: ${input.changedFiles.join(", ")}` };
    }
    return { action: "grill", status: "grilling", detail: input.verdict.question };
  }
  // proposed
  if (input.changedFiles.length === 0) {
    return { action: "error", reason: "PROPOSED but no plan files were changed" };
  }
  return { action: "propose", status: "proposed", detail: input.verdict.summary, files: input.changedFiles };
}

// ── Post-hoc deterministic guards (pure, mirroring lib/retro.ts's codeFilesInDiff) ─────────────

/**
 * Files OUTSIDE `plan/` touched by a unified diff. A triage PR is PLAN-ONLY by construction
 * (`.remudero/skills/feedback.yaml`'s Write-scoped-to-plan design) — this is the same deterministic
 * fail-closed guard `lib/retro.ts`'s `codeFilesInDiff` gives the retro, generalized from
 * "never src/test/" to "never outside plan/" (a triage may legitimately touch MASTER-PLAN.md,
 * which a retro's narrower guard already covers, plus plan/tasks.yaml and plan/feedback/*).
 */
export function nonPlanFilesInDiff(diff: string): string[] {
  return [...diff.matchAll(/^\+\+\+ b\/(\S+)/gm)]
    .map((m) => m[1])
    .filter((f) => !f.startsWith("plan/"));
}

/** Whether a diff carries the `feedback#<id>` provenance token the PROPOSED contract requires. */
export function diffCitesFeedback(diff: string, feedbackId: string): boolean {
  return diff.includes(`feedback#${feedbackId}`);
}

// ── Commit message / PR body authorship (harness-owned, deterministic) ──────────────────────

/**
 * The commit message (and, via `gh pr create --fill`, the PR title+body) the HARNESS authors for
 * a triage outcome — never the LLM, so the `Acceptance:`/`Remudero-Task:` contract can never be
 * skipped or malformed the way a free-text worker report could be. Title line first (conventional
 * commit style, matching this repo's `chore(plan): ...` convention), blank line, then an
 * `Acceptance:` block `rmd review`'s PR-body fallback path parses ({@link
 * "./review.js".parseAcceptanceBlock}) since a synthetic `TRIAGE-<id>` task carries no
 * plan/tasks.yaml entry of its own, then the provenance trailer.
 */
export function triageCommitMessage(opts: {
  decision: Exclude<TriageDecision, { action: "error" }>;
  feedbackId: string;
  taskId: string;
}): string {
  const { decision, feedbackId, taskId } = opts;
  if (decision.action === "no_task") {
    return [
      `chore(triage): feedback#${feedbackId} — already decided, no task`,
      "",
      `Grounding found this already answered: ${decision.detail}`,
      "",
      "Acceptance:",
      `- feedback#${feedbackId} is already decided and adds NO redundant task | ${decision.detail}; this diff touches only plan/feedback/${feedbackId}.yaml (status: rejected), never plan/tasks.yaml`,
      "",
      `Remudero-Task: ${taskId}`,
    ].join("\n");
  }
  if (decision.action === "grill") {
    return [
      `chore(triage): feedback#${feedbackId} — ambiguous, parked for the grill`,
      "",
      `Open question: ${decision.detail}`,
      "",
      "Acceptance:",
      `- feedback#${feedbackId} is ambiguous and adds NO redundant task | plan/feedback/${feedbackId}.yaml status is set to grilling; this diff touches only that file`,
      "",
      `Remudero-Task: ${taskId}`,
    ].join("\n");
  }
  // propose
  return [
    `chore(plan): triage feedback#${feedbackId} — ${decision.detail}`,
    "",
    `Proposed by the intake triage: ${decision.detail}`,
    "",
    "Acceptance:",
    `- feedback#${feedbackId} produced a plan-only proposal carrying its provenance | this diff's plan/tasks.yaml/MASTER-PLAN.md changes include \`origin: feedback#${feedbackId}\`, and plan/feedback/${feedbackId}.yaml status is set to proposed with proposal_pr recorded`,
    "",
    `Remudero-Task: ${taskId}`,
  ].join("\n");
}
