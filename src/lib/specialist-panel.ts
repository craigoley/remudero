import type { SpawnWorkerArgs } from "./worker.js";
import type { DiffFileChange, DiffSummary } from "./risk-score.js";

/**
 * Specialist panel (Layer 4) — MASTER-PLAN §4B, W2-T1.
 *
 * "Consult, don't committee." Triggered BY risk + diff signals (risk-score.ts,
 * W1-T22) — NEVER resident on every task (cost + slop, §4B design). A
 * deterministic {@link routeSpecialists} maps a diff + task metadata to ZERO or
 * more specialists; a task that trips no trigger consults no specialist
 * (Standing rule 2: trust/pass-fail is a deterministic predicate, never an LLM
 * decision — the ROUTING decision here is pure and pre-dates any spawn).
 *
 * Four specialists, each scoped narrowly (§4B):
 *   - security    <- auth / credentials / egress / new deps / hooks / settings
 *   - testing     <- `tdd: strict`, a negative coverage/mutation delta, or a
 *                    new source path with no corresponding test path
 *   - design      <- the diff crosses layer boundaries (bin/src/hooks/settings
 *                    are this repo's layers) or adds a new abstraction
 *                    (an exported interface/class/abstract class)
 *   - containment <- ANY diff touching sandbox / settings / deny-floor / env
 *                    (FIELD FINDING 10a: a typo there silently drops
 *                    containment — this specialist exists to catch it)
 *
 * Each triggered specialist is spawned FRESH, READ-ONLY BY CONSTRUCTION
 * ({@link SPECIALIST_TOOLS} carries no Write/Edit/NotebookEdit/MultiEdit — the
 * same "a capability it lacks, not a rule it is trusted to follow" shape as
 * flight-judge.ts's `JUDGE_TOOLS` and isolation.ts's `isolationProbeSpawnArgs`).
 * Specialists ADVISE by posting PR review comments; the GitHub-enforced gate
 * DECIDES (Standing rule 3B/12) — this module never merges and never edits.
 *
 * Wiring {@link routeSpecialists}/{@link buildSpecialistSpawnArgs} into the
 * live run-task.ts pipeline (spawning the triggered specialists after
 * risk-score.ts bands a diff, posting their verdicts as PR review comments) is
 * follow-on integration work — mirroring risk-score.ts (W1-T22) and
 * flight-judge.ts (W1-T21), which shipped their own pure logic unwired, same
 * build-order note (MASTER-PLAN §4B "Build order": Layer 4 depends on the
 * reviewer W1-T1D + risk scoring W1-T22, both already merged).
 */

// ── Specialists ─────────────────────────────────────────────────────────

export type SpecialistName = "security" | "testing" | "design" | "containment";

/** Fixed panel order — routeSpecialists always returns triggers in this order. */
const SPECIALIST_ORDER: SpecialistName[] = ["security", "testing", "design", "containment"];

export interface SpecialistTrigger {
  specialist: SpecialistName;
  /** One or more concrete reasons this specialist was triggered (evidence, not a vibe). */
  reasons: string[];
}

/** Task/run metadata the diff alone cannot carry — mirrors risk-score.ts's RiskTaskMetadata shape. */
export interface SpecialistTaskMetadata {
  /** Task declares `principles: {tdd: strict}` — always routes to testing. */
  tddStrict?: boolean;
  /** Coverage delta vs the base branch, when measured. Negative routes to testing. */
  coverageDelta?: number;
  /** Mutation-score delta vs the base branch, when measured. Negative routes to testing. */
  mutationScoreDelta?: number;
}

// ── security <- auth / credentials / egress / new deps / hooks / settings ──

const AUTH_CREDENTIAL_PATH_RE = /credential|secret|token|auth|\.pem$|\.key$|id_rsa|(^|\/)\.netrc$|(^|\/)\.npmrc$/i;
const HOOKS_SETTINGS_PATH_PATTERNS: RegExp[] = [/(^|\/)hooks\//i, /(^|\/)\.claude\/settings.*\.json$/i];
const NEW_DEPENDENCY_PATH_PATTERNS: RegExp[] = [
  /(^|\/)package(-lock)?\.json$/i,
  /(^|\/)requirements.*\.txt$/i,
  /(^|\/)(Gemfile|Gemfile\.lock)$/i,
  /(^|\/)go\.(mod|sum)$/i,
  /(^|\/)Cargo\.(toml|lock)$/i,
  /(^|\/)(poetry\.lock|pyproject\.toml)$/i,
];
/** Network-egress signal: a fetch/http-client call or a domain-shaped literal in the diff content. */
const EGRESS_CONTENT_RE = /\bfetch\(|\baxios\.|\bhttps?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i;
const EGRESS_CONFIG_PATH_RE = /(^|\/)settings\/.*\.json$/i;
const EGRESS_CONFIG_CONTENT_RE = /allowedDomains|egress|network[-_]polic/i;

function securityTriggers(diff: DiffSummary): string[] {
  const reasons: string[] = [];
  for (const file of diff.files) {
    if (AUTH_CREDENTIAL_PATH_RE.test(file.path)) {
      reasons.push(`auth/credentials path: ${file.path}`);
    }
    if (HOOKS_SETTINGS_PATH_PATTERNS.some((re) => re.test(file.path))) {
      reasons.push(`hooks/settings path: ${file.path}`);
    }
    if (NEW_DEPENDENCY_PATH_PATTERNS.some((re) => re.test(file.path))) {
      reasons.push(`new-dependency manifest: ${file.path}`);
    }
    if (EGRESS_CONFIG_PATH_RE.test(file.path) && file.content && EGRESS_CONFIG_CONTENT_RE.test(file.content)) {
      reasons.push(`egress config change: ${file.path}`);
    }
    if (file.content && EGRESS_CONTENT_RE.test(file.content)) {
      reasons.push(`network call / new domain in diff content: ${file.path}`);
    }
  }
  return reasons;
}

// ── testing <- tdd:strict, negative coverage/mutation delta, or a new src ──
// ── path with no matching test path ────────────────────────────────────────

function isSourcePath(path: string): boolean {
  return /^src\//.test(path) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function isTestPath(path: string): boolean {
  return /(^|\/)test(s)?\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/** `src/lib/foo.ts` -> `foo`; used to pair a source file with a co-located test. */
function stemOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "").replace(/\.[cm]?[jt]sx?$/, "");
}

function testingTriggers(diff: DiffSummary, metadata: SpecialistTaskMetadata): string[] {
  const reasons: string[] = [];
  if (metadata.tddStrict) {
    reasons.push("task declares principles.tdd = strict");
  }
  if (metadata.coverageDelta !== undefined && metadata.coverageDelta < 0) {
    reasons.push(`negative coverage delta: ${metadata.coverageDelta}`);
  }
  if (metadata.mutationScoreDelta !== undefined && metadata.mutationScoreDelta < 0) {
    reasons.push(`negative mutation-score delta: ${metadata.mutationScoreDelta}`);
  }
  const testStems = new Set(diff.files.filter((f) => isTestPath(f.path)).map((f) => stemOf(f.path)));
  for (const file of diff.files) {
    if (isSourcePath(file.path) && !testStems.has(stemOf(file.path))) {
      reasons.push(`new/changed source path with no matching test path: ${file.path}`);
    }
  }
  return reasons;
}

// ── design <- crosses layer boundaries, or adds a new abstraction ─────────

/** This repo's top-level layers (§4B "fitness rules" — dependency-cruiser's full
 * declarable form is future work; this is the deterministic floor until then). */
const LAYER_DIRS = ["bin", "src", "hooks", "settings"];

function layerOf(path: string): string | null {
  const top = path.split("/")[0];
  return LAYER_DIRS.includes(top) ? top : null;
}

const NEW_ABSTRACTION_RE = /\b(export\s+)?(interface|abstract\s+class|type\s+\w+\s*=)\b/;

function designTriggers(diff: DiffSummary): string[] {
  const reasons: string[] = [];
  const layersTouched = new Set(
    diff.files.map((f) => layerOf(f.path)).filter((l): l is string => l !== null),
  );
  if (layersTouched.size > 1) {
    reasons.push(`diff crosses layer boundaries: ${[...layersTouched].sort().join(", ")}`);
  }
  for (const file of diff.files) {
    if (file.content && NEW_ABSTRACTION_RE.test(file.content)) {
      reasons.push(`adds a new abstraction: ${file.path}`);
    }
  }
  return reasons;
}

// ── containment <- ANY diff touching sandbox / settings / deny-floor / env ──

const CONTAINMENT_PATH_PATTERNS: RegExp[] = [
  /(^|\/)hooks\//i,
  /(^|\/)\.claude\/settings.*\.json$/i,
  /(^|\/)settings\/.*\.json$/i,
  /sandbox/i,
  /(^|\/)\.env(\..*)?$/i,
];

function containmentTriggers(diff: DiffSummary): string[] {
  const reasons: string[] = [];
  for (const file of diff.files) {
    if (CONTAINMENT_PATH_PATTERNS.some((re) => re.test(file.path))) {
      reasons.push(`touches sandbox/settings/deny-floor/env: ${file.path}`);
    }
  }
  return reasons;
}

// ── The deterministic router ────────────────────────────────────────────

const TRIGGER_FNS: Record<SpecialistName, (diff: DiffSummary, metadata: SpecialistTaskMetadata) => string[]> = {
  security: (diff) => securityTriggers(diff),
  testing: (diff, metadata) => testingTriggers(diff, metadata),
  design: (diff) => designTriggers(diff),
  containment: (diff) => containmentTriggers(diff),
};

/**
 * Route a diff (+ task metadata) to zero or more specialists. Deterministic:
 * the SAME diff + metadata always returns identical triggers — no clock, no
 * randomness, no LLM call anywhere in this function (mirrors risk-score.ts's
 * {@link import("./risk-score.js").scoreRisk}). A diff that trips no
 * specialist's trigger (e.g. docs-only) returns `[]` — the panel is a
 * CONSULT, never a resident committee.
 */
export function routeSpecialists(
  diff: DiffSummary,
  metadata: SpecialistTaskMetadata = {},
): SpecialistTrigger[] {
  const triggers: SpecialistTrigger[] = [];
  for (const specialist of SPECIALIST_ORDER) {
    const reasons = TRIGGER_FNS[specialist](diff, metadata);
    if (reasons.length > 0) triggers.push({ specialist, reasons });
  }
  return triggers;
}

/** Convenience predicate: true when `routeSpecialists` would trigger NOTHING. */
export function noSpecialistsTriggered(diff: DiffSummary, metadata: SpecialistTaskMetadata = {}): boolean {
  return routeSpecialists(diff, metadata).length === 0;
}

// ── Read-only-by-construction spawn (§4B: "fresh context, read-only tools,
// a scoped rubric"; never edits, never merges — Standing rule 12) ─────────

/**
 * The specialist's SDK tool allowlist — Read/Grep/Glob/Bash ONLY, so it can
 * inspect the diff/repo and post a PR review comment via `gh`, but NEVER
 * Write/Edit/NotebookEdit/MultiEdit. Mirrors flight-judge.ts's `JUDGE_TOOLS`
 * (empty — no tools at all) and isolation.ts's `isolationProbeSpawnArgs`
 * (`tools: ["Bash"]`): the read-only guarantee is a capability the model
 * LACKS, not a rule it is trusted to follow.
 */
export const SPECIALIST_TOOLS: string[] = ["Read", "Grep", "Glob", "Bash"];

const SPECIALIST_RUBRIC: Record<SpecialistName, string> = {
  security:
    "Review the diff for auth/credential handling, network egress to new destinations, new " +
    "dependencies, and any change to hooks/settings that could weaken the deny-floor. Flag " +
    "anything that expands what the worker can reach or exfiltrate.",
  testing:
    "Review the diff for test coverage: new code paths without a corresponding test, weakened " +
    "assertions, or a coverage/mutation-score regression. Flag any test-strict violation.",
  design:
    "Review the diff for layer-boundary violations (a change that reaches across bin/src/hooks/" +
    "settings without a clean interface) and any new abstraction — is it justified, or " +
    "premature/duplicative?",
  containment:
    "Review the diff for ANY change to sandbox/settings/deny-floor/env — even a one-character " +
    "typo here can silently drop containment (FIELD FINDING 10a). Verify the change is scoped, " +
    "intentional, and does not widen what a worker can read/write/reach.",
};

/**
 * Render the FRESH-context specialist's prompt. Read-only + gh by construction
 * (see {@link SPECIALIST_TOOLS}); told explicitly it must never edit and only
 * advise via a PR review comment — the GitHub-enforced gate decides.
 */
export function buildSpecialistPrompt(opts: {
  specialist: SpecialistName;
  reasons: string[];
  taskId: string;
  prUrl: string;
}): string {
  return [
    `You are the ${opts.specialist.toUpperCase()} SPECIALIST (Layer 4, MASTER-PLAN §4B) — a`,
    `FRESH-context, READ-ONLY reviewer. You were triggered by:`,
    ...opts.reasons.map((r) => `  - ${r}`),
    ``,
    `SCOPED RUBRIC: ${SPECIALIST_RUBRIC[opts.specialist]}`,
    ``,
    `TASK: ${opts.taskId}`,
    `PR: ${opts.prUrl}`,
    ``,
    `You may inspect the repo and diff (\`gh pr diff ${opts.prUrl}\`) and use \`gh\` to post a PR`,
    `review comment. You must NEVER edit, modify, or write any code or file — you have no write`,
    `tool available for a reason. You ADVISE only; the GitHub-enforced merge gate DECIDES`,
    `(Standing rule 3B/12). Post your findings as a PR review comment:`,
    `  gh pr comment ${opts.prUrl} --body "<your findings>"`,
    ``,
    `End with a REPORT summarizing what you found and the comment you posted.`,
  ].join("\n");
}

/** PURE builder for a specialist's spawn args — extracted so the read-only-by-
 * construction guarantee is unit-testable without spawning a real worker
 * (mirrors isolation.ts's `isolationProbeSpawnArgs`). */
export function buildSpecialistSpawnArgs(opts: {
  specialist: SpecialistName;
  reasons: string[];
  taskId: string;
  prUrl: string;
  cwd: string;
  settingsFile: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}): SpawnWorkerArgs {
  return {
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    settingsFile: opts.settingsFile,
    tools: SPECIALIST_TOOLS,
    model: opts.model,
    effort: opts.effort,
    maxTurns: opts.maxTurns,
    maxBudgetUsd: opts.maxBudgetUsd,
    prompt: buildSpecialistPrompt(opts),
  };
}

export type { DiffFileChange, DiffSummary };
