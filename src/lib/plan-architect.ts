import { execFileSync } from "node:child_process";
import { shapeCommitMessage } from "./commit-message.js";

/**
 * `rmd plan --mode=create|clarify|expand` — the unified Architect PLAN skill (MASTER-PLAN
 * §5B, W1-T45).
 *
 * §5B's unification: "Setup, Plan, Refine, Expand, Feedback/triage, Refactor, Design Review,
 * Retro, and the Reviewer are ALL THE SAME PRIMITIVE — a higher-tier (G-17) worker that
 * GROUNDS -> RESEARCHES -> GRILLS-or-PRODUCES." The operator flagged "Refine is maybe a
 * duplicate of Plan" as correct: Refine=clarify and Expand=expand are MODES of `plan`, not
 * three skills that would triplicate ground/research/grill logic and drift apart from each
 * other over time. This module is the ONE code path all three modes run through — exactly
 * one {@link planArchitectPrompt}, one {@link parsePlanVerdict}, one
 * {@link decidePlanArchitect} — never a per-mode copy of any of the three. The mode only
 * selects which STEP-3 instructions the shared prompt embeds and which extra provenance
 * guard the harness checks on a PROPOSED diff (see lib/run-task.ts's `planCommand`).
 *
 * THE THREE MODES, over `plan/tasks.yaml` + `MASTER-PLAN.md` (this repo's own plan — no
 * `--repo` targeting; that is a materially different, cross-repo capability the task's own
 * spec never asks for — `.remudero/skills/plan.yaml`'s `grounding_sources` are all
 * self-referential):
 *   - create  — scaffold NEW plan content for an initiative described by a REQUIRED brief.
 *   - clarify — grill (or, if grounding/research resolves it, silently fix) ambiguous or
 *               underspecified EXISTING tasks; an optional brief narrows the focus, e.g. a
 *               task id or subsystem name; omitted, the worker considers the whole plan.
 *   - expand  — propose gap-filling tasks the plan is missing, each one CITING a research
 *               source (`diffCitesResearchSource` is expand's own extra guard, mirroring
 *               triage's `diffCitesFeedback`).
 *
 * THE THREE-WAY VERDICT (mirrors lib/triage.ts's `decideTriage` — the judge is CODE, the LLM
 * layer is advisory only, Standing rule 2), generalized from triage's feedback-entry shape to
 * the plan-as-a-whole shape (there is no discrete per-id status file to update here, so a
 * CLEAR or GRILL verdict touches NOTHING and needs no commit/PR at all — only PROPOSED does):
 *   - CLEAR    — grounding (+ research) shows the ask is already covered / not ambiguous.
 *                Touch NO files, open NO PR — nothing to do.
 *   - GRILL    — the ask needs a human call this pass cannot safely make alone. Touch NO
 *                files, open NO PR — print the question(s). (The actual interactive
 *                AskUserQuestion / async needs-human delivery is W1-T42's job, same deferral
 *                triage.ts already documents — LEARNINGS "no live operator in a headless
 *                worker".)
 *   - PROPOSED — edit ONLY `plan/tasks.yaml` and/or `MASTER-PLAN.md` and end with a summary.
 *                The harness (never the LLM) commits/pushes/opens the PR.
 *
 * THE WORKER NEVER RUNS GIT — it only grounds/researches/edits plan-scope files via
 * Read/Grep/Glob/WebSearch/WebFetch/Write/Edit; the commit/push/PR-open/gate sequence is
 * HARNESS-OWNED (run-task.ts's `planCommand`), identical in shape to `triageCommand`'s split.
 */

/** The three `rmd plan --mode=` values (MASTER-PLAN §5B). */
export type PlanMode = "create" | "clarify" | "expand";

const PLAN_MODES: readonly PlanMode[] = ["create", "clarify", "expand"];

// ── Arg parsing (pure — the `rmd plan --mode=<mode> [<brief>...]` CLI arg shape) ────────────

export interface ParsedPlanArgs {
  mode: PlanMode;
  /** Free-text focus/initiative brief; "" when omitted (clarify/expand default to the whole plan). */
  brief: string;
}

/**
 * Parse `rmd plan --mode=create|clarify|expand [<brief>...]`. Pure (no I/O), so it is
 * unit-testable without a filesystem. FAILS LOUD (returns `{ error }`, never a silent
 * best-guess) on a missing/duplicate/unrecognized `--mode=`, any other `--` flag, or a missing
 * brief on `--mode=create` (create has nothing to scaffold without one) — the same
 * control-surface discipline every `rmd` subcommand follows (validate flags BEFORE any
 * spawn/write).
 */
export function parsePlanArgs(rest: string[]): ParsedPlanArgs | { error: string } {
  const modeTokens = rest.filter((t) => t.startsWith("--mode="));
  if (modeTokens.length === 0) {
    return { error: "rmd plan: no --mode given — usage: rmd plan --mode=create|clarify|expand [<brief>...]" };
  }
  if (modeTokens.length > 1) {
    return { error: `rmd plan: --mode given more than once — got ${JSON.stringify(modeTokens)}` };
  }
  const modeValue = modeTokens[0].slice("--mode=".length);
  if (!PLAN_MODES.includes(modeValue as PlanMode)) {
    return {
      error: `rmd plan: unrecognized --mode '${modeValue}' — must be one of ${PLAN_MODES.join("|")}`,
    };
  }
  const others = rest.filter((t) => t !== modeTokens[0]);
  for (const tok of others) {
    if (tok.startsWith("--")) {
      return { error: `rmd plan: unrecognized flag '${tok}' — see \`rmd --help\`` };
    }
  }
  const mode = modeValue as PlanMode;
  const brief = others.join(" ").trim();
  if (mode === "create" && brief.length === 0) {
    return {
      error: "rmd plan --mode=create: no brief given — usage: rmd plan --mode=create <brief...> describing what to scaffold",
    };
  }
  return { mode, brief };
}

// ── The Architect prompt — ONE definition, all three modes ──────────────────────────────────

/** Mode-specific STEP-3 instructions, keyed once — {@link planArchitectPrompt} is the single
 *  call site that reads this table; there is no per-mode copy of the function itself. */
function step3Instructions(mode: PlanMode, brief: string): string[] {
  const focus = brief.length > 0 ? brief : "(none given — consider the whole plan)";
  if (mode === "create") {
    return [
      "You are in CREATE mode: scaffold NEW plan content for the initiative below.",
      `INITIATIVE: ${brief}`,
      "",
      "Decide exactly ONE of:",
      "",
      "  CLEAR — the plan ALREADY covers this initiative (grep found an existing task/§section",
      "  that does it). Touch NO files. End with a line starting exactly `CLEAR:` naming the",
      "  existing task id/§section, e.g. `CLEAR: already covered by W1-T27 / §5A`.",
      "",
      "  GRILL — the initiative is too underspecified to scaffold safely (e.g. it could mean two",
      "  very different things). Touch NO files. End with a line starting exactly `GRILL:`",
      "  naming the open question, e.g. `GRILL: onboard which repo — this one or a new one?`.",
      "",
      "  PROPOSED — scaffold it: add one or more new `plan/tasks.yaml` task(s) (and, if the",
      "  initiative is big enough to need one, a new `MASTER-PLAN.md` §section) covering the",
      "  initiative. End with a line starting exactly `PROPOSED:` with a one-line summary, e.g.",
      "  `PROPOSED: add W1-T300 scaffolding the <initiative> initiative`.",
    ];
  }
  if (mode === "clarify") {
    return [
      "You are in CLARIFY mode (Refine): grill ambiguous or underspecified EXISTING tasks.",
      `FOCUS: ${focus}`,
      "",
      "Decide exactly ONE of:",
      "",
      "  CLEAR — nothing in scope is actually ambiguous (or grounding/research resolves the",
      "  apparent ambiguity outright). Touch NO files. End with a line starting exactly `CLEAR:`",
      "  naming what you checked, e.g. `CLEAR: W1-T27's profile flag is fully specified`.",
      "",
      "  GRILL — a real ambiguity needs a human call this pass cannot safely make alone. Touch",
      "  NO files. End with a line starting exactly `GRILL:` naming the open question, e.g.",
      "  `GRILL: does W1-T90's 'the daemon' mean rmd daemon or rmd drain?`.",
      "",
      "  PROPOSED — the ambiguity has a clear resolution: rewrite the affected `plan/tasks.yaml`",
      "  task(s) (and/or `MASTER-PLAN.md`) to remove it. End with a line starting exactly",
      "  `PROPOSED:` with a one-line summary, e.g. `PROPOSED: disambiguate W1-T90's 'the daemon'`.",
    ];
  }
  // expand
  return [
    "You are in EXPAND mode: find a GAP the plan is missing and propose a task that fills it,",
    "GROUNDED in a cited research source (a URL) — a gap-filling task with no citation is a",
    "guess, not a proposal.",
    `FOCUS: ${focus}`,
    "",
    "Decide exactly ONE of:",
    "",
    "  CLEAR — you looked for a gap in scope and found none worth proposing. Touch NO files.",
    "  End with a line starting exactly `CLEAR:` naming what you checked, e.g.",
    "  `CLEAR: §5C's linter already covers every rule scanned for gaps`.",
    "",
    "  GRILL — you found a candidate gap but closing it safely needs a human call (e.g. which",
    "  of two directions to take). Touch NO files. End with a line starting exactly `GRILL:`",
    "  naming the open question.",
    "",
    "  PROPOSED — add one or more new `plan/tasks.yaml` task(s) filling the gap. Every new task's",
    "  `rationale:` MUST cite the research source (a URL) that grounds it. End with a line",
    "  starting exactly `PROPOSED:` with a one-line summary, e.g.",
    "  `PROPOSED: add W1-T301 for <gap>, citing <url>`.",
  ];
}

/**
 * The `rmd plan` Architect prompt — the SINGLE definition invoked by all three modes (W1-T45
 * acceptance: "the ground/research/grill functions have a SINGLE definition invoked by all
 * three modes; no per-mode copy"). Fed the mode + an optional free-text brief, told to GROUND
 * -> RESEARCH -> CLEAR-OR-GRILL-OR-PROPOSE, and required to end with exactly one of the three
 * verdict markers {@link parsePlanVerdict} anchors on. The worker has NO Bash — it only edits
 * files; the caller (run-task.ts) owns commit/push/PR.
 */
export function planArchitectPrompt(mode: PlanMode, brief: string, runId: string): string {
  return [
    "You are the REMUDERO ARCHITECT running the unified PLAN skill (MASTER-PLAN §5B) in",
    `--mode=${mode}. You ride a HIGHER tier than implement workers (G-17). You do NOT have a`,
    "Bash tool — you cannot run git or gh. Your job ends when you have edited the right files",
    "(or none) and printed your verdict; the harness commits/pushes/opens the PR after you finish.",
    "",
    "=== STEP 1 — GROUND ===",
    "Grep/Read MASTER-PLAN.md, plan/tasks.yaml, LEARNINGS.md, and DECISIONS.md (all in this",
    "working directory) for what is already decided. Re-deciding a settled question, or",
    "proposing a task that duplicates an existing one, is a failure mode, not a feature.",
    "",
    "=== STEP 2 — RESEARCH ===",
    "If (and only if) grounding leaves a genuine platform-facts gap this mode's ask turns on,",
    "use WebSearch/WebFetch to close it. Skip this step when grounding already answers the",
    "question — research exists to make a proposal GROUNDED, not to pad the transcript.",
    "",
    "=== STEP 3 — CLEAR, GRILL, OR PROPOSE ===",
    ...step3Instructions(mode, brief),
    "",
    "Exactly one of CLEAR / GRILL / PROPOSED must be the LAST line of your output. Whenever you",
    "add or rewire a `plan/tasks.yaml` task, only touch `plan/tasks.yaml` and/or",
    "`MASTER-PLAN.md` — NEVER `src/` or `test/`. Do NOT touch docs/ORIENTATION.md.",
    "",
    `(mode: ${mode})`,
    `(run: ${runId})`,
  ].join("\n");
}

// ── Verdict parsing (pure) ───────────────────────────────────────────────────

export type PlanVerdict =
  | { kind: "clear"; note: string }
  | { kind: "grill"; question: string }
  | { kind: "proposed"; summary: string };

/**
 * Extract the worker's terminal verdict off its concatenated output text — same line-anchored,
 * last-marker-wins shape as {@link "./triage.js".parseTriageVerdict}, generalized to the
 * CLEAR/GRILL/PROPOSED vocabulary.
 */
export function parsePlanVerdict(text: string): PlanVerdict | null {
  const clear = [...text.matchAll(/^[ \t]*CLEAR[ \t]*:[ \t]*(.+)$/gim)];
  const grill = [...text.matchAll(/^[ \t]*GRILL[ \t]*:[ \t]*(.+)$/gim)];
  const proposed = [...text.matchAll(/^[ \t]*PROPOSED[ \t]*:[ \t]*(.+)$/gim)];
  type Hit = { at: number; verdict: PlanVerdict };
  const hits: Hit[] = [];
  if (clear.length) {
    const m = clear[clear.length - 1];
    hits.push({ at: m.index ?? 0, verdict: { kind: "clear", note: m[1].trim() } });
  }
  if (grill.length) {
    const m = grill[grill.length - 1];
    hits.push({ at: m.index ?? 0, verdict: { kind: "grill", question: m[1].trim() } });
  }
  if (proposed.length) {
    const m = proposed[proposed.length - 1];
    hits.push({ at: m.index ?? 0, verdict: { kind: "proposed", summary: m[1].trim() } });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.at - b.at);
  return hits[hits.length - 1].verdict;
}

// ── Plan-scope guard (pure) ───────────────────────────────────────────────────

/**
 * Whether a repo-relative path is IN scope for a `rmd plan` proposal — `plan/**` or
 * `MASTER-PLAN.md` (the plan skill's output can rewire MASTER-PLAN §sections too, unlike
 * triage's narrower "plan/ only" floor — `.remudero/skills/plan.yaml`'s output_contract names
 * both).
 */
export function isInPlanScope(path: string): boolean {
  return path === "MASTER-PLAN.md" || path.startsWith("plan/");
}

/** Every path in `files` that is OUT of plan scope (see {@link isInPlanScope}). */
export function outOfPlanScopeFiles(files: string[]): string[] {
  return files.filter((f) => !isInPlanScope(f));
}

/** Out-of-scope paths touched by a unified diff (mirrors {@link "./triage.js".nonPlanFilesInDiff}). */
export function outOfPlanScopeFilesInDiff(diff: string): string[] {
  return outOfPlanScopeFiles([...diff.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1]));
}

/** Whether a diff cites a research source (a URL) — the EXPAND-mode-only extra guard mirroring
 *  triage's `diffCitesFeedback`; a gap-filling task with no citation is a guess, not a proposal. */
export function diffCitesResearchSource(diff: string): boolean {
  return /https?:\/\/\S+/.test(diff);
}

// ── Deterministic decision (pure) ────────────────────────────────────────────

export interface DecidePlanInput {
  verdict: PlanVerdict | null;
  /** Repo-relative paths the worker itself touched (`git diff --name-only` before any harness
   * side effect), e.g. from `git -C <worktree> diff --name-only origin/main`. */
  changedFiles: string[];
}

export type PlanDecision =
  | { action: "no_action"; detail: string }
  | { action: "grill"; detail: string }
  | { action: "propose"; detail: string; files: string[] }
  | { action: "error"; reason: string };

/**
 * The three-way verdict as a PURE function — the SINGLE definition invoked for all three
 * modes (mirrors {@link "./triage.js".decideTriage}): ground truth is what FILES the worker
 * actually touched, cross-checked against its declared verdict AND against plan scope — an
 * inconsistency (e.g. claiming CLEAR while also editing plan/tasks.yaml, or touching src/)
 * fails loud rather than silently trusting either signal alone.
 */
export function decidePlanArchitect(input: DecidePlanInput): PlanDecision {
  const outOfScope = outOfPlanScopeFiles(input.changedFiles);
  if (outOfScope.length > 0) {
    return {
      action: "error",
      reason: `plan worker touched file(s) outside plan scope (plan/** or MASTER-PLAN.md): ${outOfScope.join(", ")}`,
    };
  }
  if (!input.verdict) {
    return { action: "error", reason: "no CLEAR:/GRILL:/PROPOSED: verdict line found in the worker's output" };
  }
  if (input.verdict.kind === "clear") {
    if (input.changedFiles.length > 0) {
      return { action: "error", reason: `CLEAR but files were changed: ${input.changedFiles.join(", ")}` };
    }
    return { action: "no_action", detail: input.verdict.note };
  }
  if (input.verdict.kind === "grill") {
    if (input.changedFiles.length > 0) {
      return { action: "error", reason: `GRILL but files were changed: ${input.changedFiles.join(", ")}` };
    }
    return { action: "grill", detail: input.verdict.question };
  }
  // proposed
  if (input.changedFiles.length === 0) {
    return { action: "error", reason: "PROPOSED but no plan files were changed" };
  }
  return { action: "propose", detail: input.verdict.summary, files: input.changedFiles };
}

/**
 * The one-line, human-readable summary the CLI prints for a terminal decision — the SINGLE
 * definition `run-task.ts`'s `planCommand` calls for its `say(...)` output AND the
 * acceptance-proof tests paste into the PR body ("one run of each" mode). Sharing this function
 * (rather than each side hand-writing its own copy of the same template) guarantees the pasted
 * transcript can never drift from what a real `rmd plan` invocation actually prints — the exact
 * gap a "the proof looks hand-written, not a real run" review objection turns on.
 */
export function formatPlanVerdictLine(mode: PlanMode, decision: PlanDecision): string {
  if (decision.action === "no_action") return `--mode=${mode}: CLEAR — ${decision.detail}`;
  if (decision.action === "grill") {
    return `--mode=${mode}: GRILL — ${decision.detail} (interactive/async delivery is W1-T42's job)`;
  }
  if (decision.action === "propose") return `--mode=${mode}: PROPOSED — ${decision.detail}`;
  return `--mode=${mode}: ERROR — ${decision.reason}`;
}

// ── Commit message authorship (harness-owned, deterministic) ────────────────

/**
 * The commit message (and, via `gh pr create --fill`, the PR title+body) the HARNESS authors
 * for a PROPOSED `rmd plan` outcome — never the LLM, mirroring
 * {@link "./triage.js".triageCommitMessage}'s discipline. Only PROPOSED needs one: CLEAR and
 * GRILL touch no files and open no PR (there is no per-item status file to update, unlike
 * triage's feedback entry).
 */
export function planCommitMessage(opts: {
  decision: Extract<PlanDecision, { action: "propose" }>;
  mode: PlanMode;
  brief: string;
  taskId: string;
}): string {
  const { decision, mode, brief, taskId } = opts;
  // W1-T136 class: `decision.detail` is LLM free text, so this header could exceed
  // commitlint's header-max-length (100) — a red REQUIRED check on an already-open PR.
  // shapeCommitMessage caps it and preserves the overflow in the body.
  const shapedHeader = shapeCommitMessage(`chore(plan)`, `--mode=${mode} — ${decision.detail}`).header;
  return [
    shapedHeader,
    "",
    brief.length > 0 ? `Brief: ${brief}` : "Brief: (none — whole-plan scope)",
    "",
    "Acceptance:",
    `- rmd plan --mode=${mode} produced a plan-only proposal | this diff touches only plan/** and/or MASTER-PLAN.md (${decision.files.join(", ")}), gated by ci-gate+remudero-review`,
    "",
    `Remudero-Task: ${taskId}`,
  ].join("\n");
}

// ── Propose-outcome commit (harness-owned, REAL git — no dry-run) ───────────

/**
 * Stage + commit a PROPOSED outcome's plan-scope edits — the two `git` calls
 * `run-task.ts`'s `planCommand` runs for every mode's propose branch
 * (`git add -A -- plan/ MASTER-PLAN.md` then `git commit -m <message>`), factored out
 * here so it is the SAME function both the harness and the W1-T45 acceptance-proof
 * tests invoke. This exists specifically so "paste one run of each" proof can paste a
 * REAL `git diff`/`git log` read back off a commit this function actually made — never a
 * hand-typed string standing in for one (the round-1 review's "semantic downgrade": a
 * fabricated `diff --git ...` block is not a run, it is prose shaped like a run).
 */
export function applyPlanProposalCommit(cwd: string, commitMessage: string): void {
  execFileSync("git", ["-C", cwd, "add", "-A", "--", "plan/", "MASTER-PLAN.md"], { stdio: "inherit" });
  execFileSync("git", ["-C", cwd, "commit", "-m", commitMessage], { stdio: "inherit" });
}
