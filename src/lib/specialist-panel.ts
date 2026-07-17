import { execFileSync } from "node:child_process";
import type { DiffSummary, RiskBand } from "./risk-score.js";
import type { Mount } from "./mounts.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";

/**
 * Specialist panel (Layer 4) — MASTER-PLAN §4B, W2-T1.
 *
 * "Consult, don't committee." There is no standing panel and no specialist runs
 * on every task (cost + slop) — a deterministic ROUTER ({@link routeSpecialists})
 * maps the diff + risk-score signals (risk-score.ts, W1-T22) to zero or more
 * specialists. This is a pure predicate, exactly like Layer 1's flight signals
 * and Layer 3's risk scorer: it FIRES, it never JUDGES (Standing rule 2/12) — the
 * same diff + task metadata ALWAYS routes to the same specialist set, no clock,
 * no randomness, no LLM call inside the router itself.
 *
 * Four specialists (§4B design), each keyed off a distinct trigger:
 *   - security    <- auth / credentials / egress / new dependencies / hooks / settings
 *   - testing     <- `tdd: strict`, a negative coverage/mutation delta, or new
 *                     code paths declared without tests
 *   - design      <- the diff crosses a layer boundary (fitness rules) or adds
 *                     a new abstraction (task-declared — not diff-derivable,
 *                     mirrors risk-score.ts's `novel` flag)
 *   - containment <- ANY diff touching sandbox / settings / deny-floor / env,
 *                     PLUS a critical overall risk band as a backstop (FIELD
 *                     FINDING 10a: a typo in a path pattern must never silently
 *                     drop containment)
 *
 * Each triggered specialist is spawned FRESH, with a scoped rubric and READ-ONLY
 * tools ({@link SPECIALIST_TOOLS} — no Write/Edit/NotebookEdit/MultiEdit in its
 * tool list at all, the same structural guarantee isolation.ts's preflight probe
 * and flight-judge.ts's judge use: not a rule the model is trusted to follow, a
 * capability it does not have). Specialists ADVISE by posting a PR review
 * comment ({@link buildSpecialistCommentArgs} — `gh pr comment`, never a commit
 * status and never a merge); the GitHub-enforced gate DECIDES (Standing rule 3B).
 * This module never itself posts a commit status and never merges.
 */

// ── The trigger contract ───────────────────────────────────────────────────

export type SpecialistName = "security" | "testing" | "design" | "containment";

export interface SpecialistTrigger {
  specialist: SpecialistName;
  reason: string;
}

/** Task-declared facts the diff alone cannot carry (mirrors risk-score.ts's
 * `RiskTaskMetadata`: novelty/layer-crossing are judgment calls stated by the
 * task/plan, never inferred from the diff). */
export interface SpecialistTaskMetadata {
  /** `principles: {tdd: strict}` on the task (plan/tasks.yaml). */
  tddStrict?: boolean;
  /** Coverage delta vs. base, when a coverage tool has already run. Negative = regression. */
  coverageDelta?: number;
  /** Mutation-score delta vs. base. Negative = regression. */
  mutationDelta?: number;
  /** The diff adds a code path with no accompanying test (task/reviewer-declared). */
  newCodePathsWithoutTests?: boolean;
  /** The diff crosses a documented layer boundary (fitness rules). */
  crossesLayerBoundary?: boolean;
  /** The diff introduces a new abstraction. */
  addsAbstraction?: boolean;
}

export interface SpecialistPanelInput {
  diff: DiffSummary;
  task?: SpecialistTaskMetadata;
  /**
   * The overall band from {@link scoreRisk} (risk-score.ts, W1-T22) — the panel
   * is triggered BY risk + diff signals (§4B design). OPTIONAL: callers that
   * have not run risk scoring yet still get the full diff-pattern router below;
   * a `critical` band is honored as a containment BACKSTOP even when no path
   * pattern matches (FIELD FINDING 10a).
   */
  riskBand?: RiskBand;
}

// ── Specialist 1: security <- auth/credentials/egress/new-deps/hooks/settings ──

const SECURITY_PATH_PATTERNS: RegExp[] = [
  /(^|\/)hooks\//i,
  /(^|\/)\.claude\/settings.*\.json$/i,
  /(^|\/)settings\/.*\.json$/i,
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /\.(pem|key)$/i,
  /id_rsa/i,
  /credential|secret|token/i,
  /(^|\/)package(-lock)?\.json$/i,
  /(^|\/)requirements.*\.txt$/i,
  /(^|\/)(Gemfile|Gemfile\.lock)$/i,
  /(^|\/)go\.(mod|sum)$/i,
  /(^|\/)Cargo\.(toml|lock)$/i,
  /(^|\/)(poetry\.lock|pyproject\.toml)$/i,
  /allowedDomains|egress|network[-_]polic/i,
];

/** An egress call to a literal domain, ADDED in a hunk's content (a diff can add
 * a network call without touching any path pattern above — the content itself
 * is the signal). */
const NETWORK_CALL_CONTENT_RE =
  /\b(fetch|axios\.\w+|http\.request|https\.request)\s*\(\s*['"`]https?:\/\/|https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/i;

export function securityTrigger(diff: DiffSummary): SpecialistTrigger | null {
  for (const file of diff.files) {
    for (const re of SECURITY_PATH_PATTERNS) {
      if (re.test(file.path)) {
        return {
          specialist: "security",
          reason: `touches an auth/credential/dependency/hooks/settings path: ${file.path} (matches ${re})`,
        };
      }
    }
  }
  for (const file of diff.files) {
    if (file.content && NETWORK_CALL_CONTENT_RE.test(file.content)) {
      return {
        specialist: "security",
        reason: `introduces a network call to a domain: ${file.path}`,
      };
    }
  }
  return null;
}

// ── Specialist 2: testing <- tdd:strict, negative coverage/mutation delta, ──
// ── or new code paths declared without tests ─────────────────────────────

export function testingTrigger(task?: SpecialistTaskMetadata): SpecialistTrigger | null {
  if (!task) return null;
  if (task.tddStrict) {
    return { specialist: "testing", reason: "task declares `principles: {tdd: strict}`" };
  }
  if (task.coverageDelta !== undefined && task.coverageDelta < 0) {
    return { specialist: "testing", reason: `negative coverage delta (${task.coverageDelta})` };
  }
  if (task.mutationDelta !== undefined && task.mutationDelta < 0) {
    return { specialist: "testing", reason: `negative mutation-score delta (${task.mutationDelta})` };
  }
  if (task.newCodePathsWithoutTests) {
    return { specialist: "testing", reason: "new code path(s) declared without an accompanying test" };
  }
  return null;
}

// ── Specialist 3: design <- crosses a layer boundary or adds an abstraction ──
// (task-declared; not diff-derivable, mirrors risk-score.ts's `novel` flag)

export function designTrigger(task?: SpecialistTaskMetadata): SpecialistTrigger | null {
  if (!task) return null;
  if (task.crossesLayerBoundary) {
    return { specialist: "design", reason: "diff crosses a documented layer boundary (fitness rules)" };
  }
  if (task.addsAbstraction) {
    return { specialist: "design", reason: "diff adds a new abstraction" };
  }
  return null;
}

// ── Specialist 4: containment <- ANY diff touching sandbox/settings/ ────────
// ── deny-floor/env, plus a critical risk band as a backstop (FIELD FINDING 10a) ─

const CONTAINMENT_PATH_PATTERNS: RegExp[] = [
  /(^|\/)hooks\//i,
  /(^|\/)\.claude\/settings.*\.json$/i,
  /(^|\/)settings\/.*\.json$/i,
  /(^|\/)\.env(\..*)?$/i,
  /sandbox/i,
  /deny[-_]?floor/i,
];

export function containmentTrigger(diff: DiffSummary, riskBand?: RiskBand): SpecialistTrigger | null {
  for (const file of diff.files) {
    for (const re of CONTAINMENT_PATH_PATTERNS) {
      if (re.test(file.path)) {
        return {
          specialist: "containment",
          reason: `touches sandbox/settings/deny-floor/env: ${file.path} (matches ${re})`,
        };
      }
    }
  }
  if (riskBand === "critical") {
    return {
      specialist: "containment",
      reason:
        "overall risk band is critical — containment consulted as a BACKSTOP even though no path pattern matched (FIELD FINDING 10a: a typo in a pattern must never silently drop containment)",
    };
  }
  return null;
}

// ── The router: fold all four triggers, in a fixed order ───────────────────

/**
 * Route a diff (+ optional task metadata / risk band) to the specialists it
 * trips. Deterministic: the SAME input always returns the SAME set, in the
 * SAME order (security, testing, design, containment) — no clock, no
 * randomness, no LLM call. A diff/task that trips nothing returns `[]`: the
 * panel is a CONSULT, never a resident committee.
 */
export function routeSpecialists(input: SpecialistPanelInput): SpecialistTrigger[] {
  const triggers = [
    securityTrigger(input.diff),
    testingTrigger(input.task),
    designTrigger(input.task),
    containmentTrigger(input.diff, input.riskBand),
  ];
  return triggers.filter((t): t is SpecialistTrigger => t !== null);
}

// ── The scoped rubric each specialist is briefed with ───────────────────────

const SPECIALIST_RUBRIC: Record<SpecialistName, string> = {
  security:
    "Auth, credentials, egress, new dependencies, hooks, and settings. Flag anything that widens what " +
    "this diff (or code it calls) can read, write, or call out to — a new domain, a loosened permission, " +
    "a dependency with a known CVE, a secret handled in plaintext.",
  testing:
    "`tdd: strict` claims, coverage/mutation deltas, and new code paths. Flag any added path with no " +
    "accompanying test, any test that would not have failed before this change (test theater), and any " +
    "claimed red->green proof that is not actually pasted/reproducible.",
  design:
    "Layer boundaries and abstractions (fitness rules). Flag anything that crosses a documented layer " +
    "boundary, or introduces a new abstraction the codebase does not already need in two or more places.",
  containment:
    "Sandbox, settings, the deny-floor hooks, and env. Flag ANY change here, however small — a single " +
    "misplaced character in one of these files can silently drop containment (FIELD FINDING 10a); this " +
    "specialist reads with the LOWEST tolerance for 'looks fine' of the four.",
};

// ── The fresh-context specialist prompt (read-only, advisory, never merges) ─

export interface SpecialistPromptInput {
  specialist: SpecialistName;
  taskId: string;
  prUrl: string;
  triggers: SpecialistTrigger[];
}

/**
 * Render the FRESH-context specialist's prompt. Mirrors flight-judge.ts's
 * `buildJudgePrompt` and review.ts's `buildReviewPrompt`: a specialist is READ
 * ONLY — it may inspect the repo/diff and use `gh` to post its review comment,
 * but it must NEVER edit, modify, or write any code or file, and it NEVER
 * posts a commit status or merges (that is the reviewer's/gate's job, never
 * this one's).
 */
export function buildSpecialistPrompt(input: SpecialistPromptInput): string {
  const reasons = input.triggers
    .filter((t) => t.specialist === input.specialist)
    .map((t) => `  - ${t.reason}`)
    .join("\n");

  return [
    `You are the ${input.specialist.toUpperCase()} SPECIALIST (Layer 4, MASTER-PLAN §4B) —`,
    `a FRESH-context, on-demand consultant. You were triggered for THIS PR by:`,
    reasons || "  (triggered explicitly)",
    ``,
    `You are READ-ONLY: you may inspect the repo and the PR diff and use \`gh\` to`,
    `post a PR review comment, but you must NEVER edit, modify, or write any code`,
    `or file. You NEVER post a commit status and you NEVER merge — you ADVISE; the`,
    `GitHub-enforced merge gate DECIDES (Standing rule 3B/12).`,
    ``,
    `TASK: ${input.taskId}`,
    `PR: ${input.prUrl}`,
    ``,
    `YOUR SCOPED RUBRIC:`,
    `  ${SPECIALIST_RUBRIC[input.specialist]}`,
    ``,
    `Read the PR diff (\`gh pr diff ${input.prUrl}\`), judge ONLY your rubric above`,
    `(other specialists, if any, cover the rest — do not restate their concerns),`,
    `and post ONE PR review comment with your finding:`,
    `  gh pr comment ${input.prUrl} --body "<your finding>"`,
    ``,
    `MACHINE-READABLE OUTPUT (required, in addition to posting the comment): emit`,
    `exactly one line and nothing else on it:`,
    `  SPECIALIST_VERDICT: PASS      (nothing in your rubric's scope is a concern)`,
    `  SPECIALIST_VERDICT: CONCERN   (something in your rubric's scope needs a human look)`,
    `and, when CONCERN, one or more lines:`,
    `  SPECIALIST_COMMENT: <one concrete concern>`,
  ].join("\n");
}

// ── Read-only tool allowlist (structural, mirrors isolation.ts + flight-judge.ts) ─

/**
 * The specialist's SDK tool allowlist. Read/Grep/Glob to inspect the repo,
 * Bash for `gh pr diff` / `gh pr comment` — and NOTHING that writes. This is
 * the SAME structural guarantee as isolation.ts's preflight probe and
 * flight-judge.ts's empty `JUDGE_TOOLS`: Write/Edit/NotebookEdit/MultiEdit are
 * never in the model's context, so a specialist cannot use one even if asked.
 */
export const SPECIALIST_TOOLS: string[] = ["Read", "Grep", "Glob", "Bash"];

const WRITE_TOOL_NAMES = ["Write", "Edit", "NotebookEdit", "MultiEdit"];

/** True if `tools` carries no write-capable tool — the structural read-only proof. */
export function isReadOnlyToolset(tools: string[]): boolean {
  return !tools.some((t) => WRITE_TOOL_NAMES.includes(t));
}

/** Build the {@link SpawnWorkerArgs} for a real specialist spawn — a pure
 * function so the "no write tool" guarantee is unit-testable without a spawn. */
export function buildSpecialistSpawnArgs(opts: {
  input: SpecialistPromptInput;
  mount: Mount;
  cwd: string;
  settingsFile: string;
}): SpawnWorkerArgs {
  return {
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    prompt: buildSpecialistPrompt(opts.input),
    model: opts.mount.model,
    effort: opts.mount.effort,
    maxTurns: opts.mount.maxTurns,
    tools: SPECIALIST_TOOLS,
  };
}

/** Spawn the real fresh-context specialist. Untested by unit (it shells out via
 * the SDK, same as every other real spawn in worker.ts) — {@link buildSpecialistSpawnArgs}
 * carries the testable contract. */
export async function spawnSpecialistWorker(opts: {
  input: SpecialistPromptInput;
  mount: Mount;
  cwd: string;
  settingsFile: string;
}): Promise<WorkerResult> {
  return spawnWorker(buildSpecialistSpawnArgs(opts));
}

// ── Parsing the specialist's machine-readable verdict ───────────────────────

export type SpecialistVerdictState = "pass" | "concern";

export interface SpecialistVerdict {
  specialist: SpecialistName;
  state: SpecialistVerdictState;
  comments: string[];
}

/**
 * Parse a specialist's `SPECIALIST_VERDICT`/`SPECIALIST_COMMENT` lines.
 * Advisory + fail-SAFE (never fail-closed): a specialist's job is to ADVISE,
 * never to block by itself, so unparseable output defaults to `pass` with no
 * comments — the GitHub-enforced gate (review.ts) is what actually decides
 * (Standing rule 3B/12); a dead/garbled specialist spawn must never itself
 * stall or hard-fail a PR.
 */
export function parseSpecialistVerdict(specialist: SpecialistName, text: string): SpecialistVerdict {
  const stateMatch = text.match(/SPECIALIST_VERDICT:\s*(PASS|CONCERN)/i);
  const state: SpecialistVerdictState = stateMatch?.[1]?.toUpperCase() === "CONCERN" ? "concern" : "pass";
  const comments = [...text.matchAll(/SPECIALIST_COMMENT:\s*(.+)/gi)].map((m) => m[1].trim());
  return { specialist, state, comments };
}

/** True when ANY specialist verdict raised a concern — a pure fold a caller
 * can use to decide whether to surface the panel loudly, without re-deriving
 * per-specialist state. Never itself an action (Standing rule 12). */
export function anySpecialistConcern(verdicts: SpecialistVerdict[]): boolean {
  return verdicts.some((v) => v.state === "concern");
}

// ── Posting the PR review comment (advisory only — NEVER a commit status) ──

/**
 * Build the exact `gh` argv for posting a specialist's PR review comment.
 * Extracted as a pure builder (mirrors review.ts's `postReviewStatus` shape)
 * so "a specialist never posts a commit status and never merges" is
 * unit-testable without shelling out: this argv is `pr comment`, never
 * `api ... statuses` (review.ts's REVIEW_CONTEXT path) and never touches
 * branch protection or a merge.
 */
export function buildSpecialistCommentArgs(prUrl: string, body: string): string[] {
  return ["pr", "comment", prUrl, "--body", body];
}

/** Render one combined PR-comment body from a panel's verdicts (used when a
 * caller posts one comment for the whole panel rather than one per specialist). */
export function renderSpecialistPanelComment(verdicts: SpecialistVerdict[]): string {
  const lines = ["**Specialist panel (Layer 4, consult-don't-committee)**", ""];
  for (const v of verdicts) {
    lines.push(`- **${v.specialist}**: ${v.state === "concern" ? "CONCERN" : "PASS"}`);
    for (const c of v.comments) lines.push(`  - ${c}`);
  }
  return lines.join("\n");
}

/**
 * Post one specialist's (or the panel's combined) review comment. Thin
 * wrapper over `gh pr comment` (runs outside the sandbox; TLS fails under
 * Seatbelt, same as review.ts's `postReviewStatus`) — WRITE-scoped to a PR
 * COMMENT only; it can never post a commit status and can never merge.
 * Untested by unit — it shells out; {@link buildSpecialistCommentArgs} carries
 * the testable contract.
 */
export function postSpecialistPanelComment(prUrl: string, body: string): void {
  execFileSync("gh", buildSpecialistCommentArgs(prUrl, body), { stdio: "pipe" });
}
