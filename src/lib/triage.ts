import type { Escalation, EscalationOption } from "./escalate.js";
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
 *     parks at `grilling`, and the harness (run-task.ts's `triageCommand`) opens a `needs-human`
 *     GitHub issue reusing §4's escalation machinery (W1-T42) — the ONLY viable grill mechanism.
 *     ★ VERIFIED (LEARNINGS.md "AskUserQuestion neither works headlessly nor stalls"):
 *     AskUserQuestion silently auto-resolves EMPTY with no TTY (~37ms, no error, nothing
 *     collected) rather than hanging, and this worker always runs via spawnWorker — a subprocess
 *     with no TTY BY CONSTRUCTION, regardless of the invoking shell — so the interactive branch
 *     MASTER-PLAN §7B names is structurally unreachable here; `.remudero/skills/feedback.yaml`
 *     no longer lists `AskUserQuestion` in its tools. Because the async issue is the only path,
 *     the AMBIGUOUS verdict below must always carry actionable OPTION:/RECOMMENDATION: lines —
 *     `escalate()` refuses a bare-alert issue with no options.
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
  | { kind: "ambiguous"; question: string; options: EscalationOption[]; recommendation: string }
  | { kind: "proposed"; summary: string };

/**
 * `OPTION: <label>|<detail>` lines anywhere in the worker's output — the grill's actionable
 * choices (escalate.ts's `EscalationOption[]` shape), mirroring `rmd escalate --option`'s CLI
 * parsing (run-task.ts's `parseOptionFlags`). Only meaningful when the verdict resolves to
 * AMBIGUOUS (decideTriage validates count/shape there); harmless if unused otherwise.
 */
function parseGrillOptions(text: string): EscalationOption[] {
  return [...text.matchAll(/^[ \t]*OPTION[ \t]*:[ \t]*(.+)$/gim)].map((m) => {
    const raw = m[1].trim();
    const sep = raw.indexOf("|");
    return sep >= 0
      ? { label: raw.slice(0, sep).trim(), detail: raw.slice(sep + 1).trim() }
      : { label: raw, detail: "" };
  });
}

/** The LAST `RECOMMENDATION: <label>` line — {@link decideTriage} fails loud unless it matches
 * one of the parsed OPTION labels exactly. `""` when no such line appears. */
function parseGrillRecommendation(text: string): string {
  const hits = [...text.matchAll(/^[ \t]*RECOMMENDATION[ \t]*:[ \t]*(.+)$/gim)];
  return hits.length ? hits[hits.length - 1][1].trim() : "";
}

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

// ── Deterministic decision (pure) ────────────────────────────────────────────

export interface DecideTriageInput {
  verdict: TriageVerdict | null;
  /** Repo-relative paths the worker itself touched (`git diff --name-only` before the harness's
   * own status write), e.g. from `git -C <worktree> diff --name-only origin/main`. */
  changedFiles: string[];
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
    const verdict = input.verdict; // narrowed local — property-access narrowing doesn't survive into a closure below
    if (input.changedFiles.length > 0) {
      return { action: "error", reason: `AMBIGUOUS but files were changed: ${input.changedFiles.join(", ")}` };
    }
    // The async needs-human issue is the ONLY grill mechanism (W1-T42, LEARNINGS.md
    // "AskUserQuestion neither works headlessly nor stalls") — an AMBIGUOUS verdict with fewer
    // than 2 OPTION: lines, or a RECOMMENDATION: that doesn't name one of them, is not an
    // actionable escalation; fail loud rather than let escalate() throw deeper in the pipeline
    // (or worse, silently drop the recommendation).
    if (verdict.options.length < 2) {
      return {
        action: "error",
        reason: `AMBIGUOUS verdict carries ${verdict.options.length} OPTION: line(s) — a grill needs at least 2 actionable choices`,
      };
    }
    if (!verdict.options.some((o) => o.label === verdict.recommendation)) {
      return {
        action: "error",
        reason: `AMBIGUOUS verdict's RECOMMENDATION (${JSON.stringify(verdict.recommendation)}) does not match any OPTION label (${verdict.options.map((o) => o.label).join(", ")})`,
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
  /** The needs-human issue URL {@link buildGrillEscalation}/`escalate()` opened for a `grill`
   * decision (W1-T42) — undefined only when `decision.action !== "grill"`. */
  grillIssueUrl?: string;
}): string {
  const { decision, feedbackId, taskId, grillIssueUrl } = opts;
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
      `Grill (needs-human, ${decision.options.length} options, recommends "${decision.recommendation}"): ${grillIssueUrl ?? "(see run ledger — issue open failed to record here)"}`,
      "",
      "Acceptance:",
      `- feedback#${feedbackId} is ambiguous, opens a needs-human issue with options + a recommendation, and adds NO redundant task | the grill issue (${grillIssueUrl ?? "see run ledger"}) carries ${decision.options.length} OPTION lines and recommends "${decision.recommendation}"; plan/feedback/${feedbackId}.yaml status is set to grilling; this diff touches only that file`,
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

// ── THE GRILL: the needs-human escalation payload (W1-T42) ──────────────────────────────────

/**
 * Build the `Escalation` (lib/escalate.ts) for an AMBIGUOUS feedback item — the async
 * needs-human GitHub issue that IS the grill (★ VERIFIED the only viable mechanism: see this
 * module's header doc and LEARNINGS.md "AskUserQuestion neither works headlessly nor stalls").
 * Pure — `run-task.ts`'s `triageCommand` is the only caller that hands this to the real
 * `escalate()`/`ghIssueGateway()` I/O, mirroring how `triageCommitMessage` stays pure while the
 * caller owns git/gh. `class: "GRILL"` reuses escalate.ts's SAME machinery (labels, ledger line,
 * digest-only — no real-time ping) rather than inventing a second one, per this task's directive.
 */
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
    detail: [`Feedback: ${entry.raw}`, "", `Open question: ${decision.detail}`].join("\n"),
    options: decision.options,
    recommendation: decision.recommendation,
  };
}
