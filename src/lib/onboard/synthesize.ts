import { execFileSync } from "node:child_process";
// Imported as the module's DEFAULT export (a plain, mutable object), never as named
// bindings — the SAME W1-T115 "assert via injected fs" discipline inventory.ts/recon.ts/
// session.ts already follow (see inventory.ts's header comment for the full rationale):
// ESM named bindings off `node:fs` are non-configurable, so a test that wants to prove
// "the only writes land under <target-dir>, and never under plan/onboarding/" by spying on
// the REAL module needs every call site below to be a live `fs.<method>(...)` property
// lookup, never a destructured local.
import fs from "node:fs";
import { dirname, join } from "node:path";
import type { Candidate } from "./recon.js";
import type { GhExec, Inventory } from "./inventory.js";
import { generateOnboardQuestions, type OnboardAnswer, type OnboardQuestion } from "./session.js";
import { lintPlan } from "../task-linter.js";
import { parseTasksFromYaml, type Plan, type Task } from "../plan.js";

/**
 * `rmd onboard <target-dir> --phase synthesize` — phase 4 (and last) of the four-phase
 * `rmd onboard` family (MASTER-PLAN ★P24(5)+(6), W1-T85). Ratifies the ENTIRE onboarding
 * as ONE draft PR: an Architect worker (the injected {@link SynthesizeDraftFn}) drafts the
 * target repo's constitution (`MASTER-PLAN.md`: mission, conventions AS FOUND), a
 * CHANGE-LEVEL `plan/tasks.yaml` seed from the ratified goals (progressive adoption, never
 * a big-bang respec), and `AGENTS.md` (the cross-tool convention) — fed the FULL set of
 * phase 1-3 artifacts: inventory ({@link readInventory}), findings + candidates
 * ({@link readCandidates}/{@link readFindings}), and answers ({@link readAnswers}).
 *
 * TWO hard gates, both enforced HERE, before any spawn/write/branch/PR:
 *
 *  1. COMPLETENESS ({@link assertAnswersComplete}): the phase-3 session's FULL question set
 *     (the SAME {@link generateOnboardQuestions} phase 3 uses — never a second, drifting
 *     copy) must be fully answered. An incomplete set REFUSES loud, naming every
 *     unanswered question id — goals are never guessed.
 *  2. LINT-PLAN-CLEAN AT BIRTH ({@link draftPlanUntilClean}): the drafted `tasks.yaml` is
 *     parsed and run through the REAL `lintPlan` (src/lib/task-linter.ts, §5C Layer A) —
 *     the SAME linter `rmd lint-plan`/the pre-dispatch guard run, never a re-implementation
 *     that could drift. A BLOCKING violation folds its message into `feedback` and the
 *     draft fn is called AGAIN (same signature, `feedback` populated) — up to
 *     {@link MAX_DRAFT_ATTEMPTS} attempts — before this phase gives up loud. The PR is
 *     opened ONLY once a drafted plan is fully clean.
 *
 * Only ONE seam is genuinely non-deterministic — the LLM's phrasing of the three documents
 * (`deps.draft`, {@link SynthesizeDraftFn}) — mirroring recon.ts's `runLens`/session.ts's
 * `ask` DI shape: every deterministic part of this module (completeness, parsing, linting,
 * the git/gh call shape) is pure/unit-testable without ever spawning a live worker or
 * shelling real git/gh (Rule 2 — policy as data, not code).
 *
 * WRITE SCOPE: this phase writes ONLY three files, all under `<target-dir>` on the freshly
 * checked-out `onboard/<repo>-plan` branch — `MASTER-PLAN.md`, `plan/tasks.yaml`,
 * `AGENTS.md` — and NOTHING under `<target-dir>/plan/onboarding/` (phases 1-3's own
 * artifacts are READ-ONLY inputs here, never touched). Exactly ONE branch, ONE commit, ONE
 * `gh pr create --draft` call — standing rule 15 ("the Architect proposes, merges nothing"):
 * this phase never opens more than one PR, and never merges anything itself; the human's
 * merge of the draft PR IS the ratification.
 *
 * COMPOSITION (documented per this task's own design note): `rmd onboard` (this whole
 * four-phase family) produces the BRAIN — a ratified MASTER-PLAN.md/tasks.yaml/AGENTS.md.
 * `rmd project init` (W1-T27, src/lib/project-init.ts) installs the BAR — the CI gate stack
 * (workflows/configs/branch protection) a plan is drained against. The daemon (W1-T ongoing
 * drain loop) is what actually DRAINS the ratified plan once both are in place. Onboarding a
 * fresh target is: inventory -> recon -> session -> synthesize (this phase) -> `rmd project
 * init` -> drain.
 */

// ── Errors ───────────────────────────────────────────────────────────────────────────────

export class SynthesizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SynthesizeError";
  }
}

// ── The injectable fs surface + real deps (mirrors ReconFsDeps/SessionFsDeps) ─────────────

export interface SynthesizeFsDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
  mkdirSync: (path: string, opts: { recursive: true }) => void;
  writeFileSync: (path: string, content: string) => void;
  renameSync: (from: string, to: string) => void;
}

export const realSynthesizeFsDeps: SynthesizeFsDeps = {
  existsSync: (path) => fs.existsSync(path),
  readFileSync: (path) => fs.readFileSync(path, "utf8"),
  mkdirSync: (path, opts) => {
    fs.mkdirSync(path, opts);
  },
  writeFileSync: (path, content) => {
    fs.writeFileSync(path, content, "utf8");
  },
  renameSync: (from, to) => {
    fs.renameSync(from, to);
  },
};

// ── Reading the phase 1-3 artifacts (all READ-ONLY inputs to this phase) ──────────────────

function inventoryPathFor(targetDir: string): string {
  return join(targetDir, "plan", "onboarding", "inventory.json");
}
function findingsPathFor(targetDir: string): string {
  return join(targetDir, "plan", "onboarding", "findings.md");
}
function candidatesPathFor(targetDir: string): string {
  return join(targetDir, "plan", "onboarding", "candidates.json");
}
function answersPathFor(targetDir: string): string {
  return join(targetDir, "plan", "onboarding", "answers.json");
}

/** The phase-1 inventory — REQUIRED (drives {@link generateOnboardQuestions}, so this
 *  phase's own completeness gate has nothing to check against without it). Missing or
 *  malformed fails loud, naming the prerequisite phase, mirroring session.ts's
 *  `readInventory`. */
function readInventory(fsDeps: SynthesizeFsDeps, targetDir: string): Inventory {
  const path = inventoryPathFor(targetDir);
  if (!fsDeps.existsSync(path)) {
    throw new SynthesizeError(`rmd onboard synthesize: ${path} not found — run \`rmd onboard ${targetDir} --phase inventory\` first`);
  }
  try {
    return JSON.parse(fsDeps.readFileSync(path)) as Inventory;
  } catch {
    throw new SynthesizeError(`rmd onboard synthesize: ${path} exists but is not valid JSON`);
  }
}

/** The phase-3 answers — `{}` when absent (every question is then, correctly, unanswered).
 *  A PRESENT but malformed file fails loud, never silently treated as "nothing answered". */
function readAnswers(fsDeps: SynthesizeFsDeps, targetDir: string): Record<string, OnboardAnswer> {
  const path = answersPathFor(targetDir);
  if (!fsDeps.existsSync(path)) return {};
  try {
    return JSON.parse(fsDeps.readFileSync(path)) as Record<string, OnboardAnswer>;
  } catch {
    throw new SynthesizeError(`rmd onboard synthesize: ${path} exists but is not valid JSON`);
  }
}

/** The phase-2 candidates — `[]` when absent (recon is not a hard prerequisite this phase
 *  enforces; the ONLY hard gate is answer completeness). Present-but-malformed fails loud. */
function readCandidates(fsDeps: SynthesizeFsDeps, targetDir: string): Candidate[] {
  const path = candidatesPathFor(targetDir);
  if (!fsDeps.existsSync(path)) return [];
  try {
    return JSON.parse(fsDeps.readFileSync(path)) as Candidate[];
  } catch {
    throw new SynthesizeError(`rmd onboard synthesize: ${path} exists but is not valid JSON`);
  }
}

/** The phase-2 findings prose — `""` when absent (same non-prerequisite reasoning as
 *  {@link readCandidates}). */
function readFindings(fsDeps: SynthesizeFsDeps, targetDir: string): string {
  const path = findingsPathFor(targetDir);
  if (!fsDeps.existsSync(path)) return "";
  return fsDeps.readFileSync(path);
}

// ── Gate 1: completeness — goals are never guessed ─────────────────────────────────────────

/** The phase-3 question set NOT present in `answers` — REUSES {@link generateOnboardQuestions}
 *  (session.ts's own pure question generator) rather than a second, driftable copy, so "the
 *  full question set" always means exactly what phase 3 itself asked. */
export function unansweredQuestions(inventory: Inventory, answers: Record<string, OnboardAnswer>): OnboardQuestion[] {
  return generateOnboardQuestions(inventory).filter((q) => !(q.id in answers));
}

/** FAIL LOUD, before any draft/git/gh/write work: an incomplete answer set refuses, naming
 *  every unanswered question id (acceptance criterion 1). */
export function assertAnswersComplete(inventory: Inventory, answers: Record<string, OnboardAnswer>, targetDir: string): void {
  const unanswered = unansweredQuestions(inventory, answers);
  if (unanswered.length === 0) return;
  throw new SynthesizeError(
    `rmd onboard synthesize: refusing to draft — ${unanswered.length} unanswered question(s): ` +
      unanswered.map((q) => q.id).join(", ") +
      ` — goals are never guessed; run \`rmd onboard ${targetDir} --phase session\` first`,
  );
}

// ── The draft seam — the ONE non-deterministic part of this module ─────────────────────────

export interface SynthesizeDraftInput {
  inventory: Inventory;
  candidates: Candidate[];
  answers: Record<string, OnboardAnswer>;
  findings: string;
  targetDir: string;
  owner: string;
  repo: string;
}

export interface SynthesizeDraft {
  masterPlan: string;
  tasksYaml: string;
  agentsMd: string;
}

/** Produce the three drafted documents. `feedback` — present only on a RE-draft after a
 *  failed lint-plan pass — is a list of the blocking violation messages the PRIOR attempt
 *  produced; the SAME signature drives every attempt of {@link draftPlanUntilClean}'s loop,
 *  so a re-draft is not a different code path, just the same call with feedback populated. */
export type SynthesizeDraftFn = (input: SynthesizeDraftInput, feedback?: string[]) => Promise<SynthesizeDraft>;

// ── Gate 2: lint-plan-clean at birth — iterate until clean, BEFORE any branch/PR ───────────

/** Bounded retry cap for {@link draftPlanUntilClean} — 3 attempts: one honest first draft,
 *  one correction from concrete lint feedback, one final check that the correction actually
 *  landed. A draft still dirty after this many attempts fails loud rather than opening a PR
 *  the §5C linter would immediately block anyway. */
export const MAX_DRAFT_ATTEMPTS = 3;

export interface DraftPlanResult {
  draft: SynthesizeDraft;
  tasks: Task[];
  attempts: number;
}

/**
 * Call `draft`, parse its `tasksYaml`, and run it through the REAL {@link lintPlan} — the
 * SAME linter `rmd lint-plan`/the pre-dispatch guard run (never a re-implementation that
 * could drift, §5C Layer A). Any BLOCKING violation (or an unparseable `tasksYaml`) folds
 * into `feedback` and `draft` is called again, up to `maxAttempts`; the loop returns the
 * FIRST attempt with zero blocking violations. Still dirty after the cap ⇒
 * {@link SynthesizeError} — no branch, no PR, no write (acceptance criterion 2).
 */
export async function draftPlanUntilClean(
  input: SynthesizeDraftInput,
  draft: SynthesizeDraftFn,
  maxAttempts: number = MAX_DRAFT_ATTEMPTS,
): Promise<DraftPlanResult> {
  let feedback: string[] | undefined;
  let lastViolationSummary = "(no attempt completed)";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptDraft = await draft(input, feedback);

    let tasks: Task[];
    try {
      tasks = parseTasksFromYaml(attemptDraft.tasksYaml, "onboard synthesis drafted tasks.yaml");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      feedback = [`the drafted tasks.yaml did not parse as a valid plan: ${message}`];
      lastViolationSummary = feedback[0]!;
      continue;
    }

    const plan: Plan = { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
    const results = lintPlan(plan);
    const blocking = [...results.values()].flatMap((r) => r.violations.filter((v) => v.severity === "block"));

    if (blocking.length === 0) {
      return { draft: attemptDraft, tasks, attempts: attempt };
    }
    feedback = blocking.map((v) => v.message);
    lastViolationSummary = feedback.join("; ");
  }

  throw new SynthesizeError(
    `rmd onboard synthesize: the drafted tasks.yaml failed lint-plan (§5C) after ${maxAttempts} attempt(s) — ` +
      `refusing to open a PR with an unclean plan. Last violations: ${lastViolationSummary}`,
  );
}

// ── The injectable git/gh surfaces + real gateways ─────────────────────────────────────────

/** `execFileSync("git", args, {cwd}).toString()` — injectable so a unit test can assert the
 *  EXACT call shape (one `checkout -b`, one `push`) without shelling a real git process. */
export type GitExec = (args: string[], cwd: string) => string;

export interface SynthesizeGitGateway {
  exec: GitExec;
}

const defaultSynthesizeGitExec: GitExec = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" });

export function realSynthesizeGitGateway(opts: { exec?: GitExec } = {}): SynthesizeGitGateway {
  return { exec: opts.exec ?? defaultSynthesizeGitExec };
}

export interface SynthesizeOpenPrOpts {
  owner: string;
  repo: string;
  branch: string;
  title: string;
  body: string;
}

/** Mirrors inventory.ts's `GhExec`/`realOnboardGhGateway` shape, but for `gh pr create`
 *  directly — NOT `gh api` (inventory.ts's own `defaultGhExec` always prefixes `api`, wrong
 *  for this call), hence a locally-declared default exec reusing only the {@link GhExec}
 *  TYPE. */
export interface SynthesizeGhGateway {
  /** Open exactly one draft PR; returns the PR URL (`gh pr create`'s own stdout, trimmed). */
  openPr(opts: SynthesizeOpenPrOpts): string;
}

const defaultSynthesizeGhExec: GhExec = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function realSynthesizeGhGateway(opts: { exec?: GhExec } = {}): SynthesizeGhGateway {
  const exec = opts.exec ?? defaultSynthesizeGhExec;
  return {
    openPr: (o) =>
      exec([
        "pr",
        "create",
        "--repo",
        `${o.owner}/${o.repo}`,
        "--draft",
        "--head",
        o.branch,
        "--title",
        o.title,
        "--body",
        o.body,
      ]).trim(),
  };
}

// ── The runner: gate, draft-until-clean, branch + write + commit + push + PR ──────────────

export interface SynthesizeDeps {
  fs: SynthesizeFsDeps;
  git: SynthesizeGitGateway;
  gh: SynthesizeGhGateway;
  draft: SynthesizeDraftFn;
  /** Overrides {@link MAX_DRAFT_ATTEMPTS} — tests only; real callers omit it. */
  maxDraftAttempts?: number;
}

export interface OnboardSynthesizeResult {
  branch: string;
  prUrl: string;
  masterPlanPath: string;
  tasksYamlPath: string;
  agentsMdPath: string;
  tasks: Task[];
  attempts: number;
}

/** Sibling-temp-file + `renameSync` atomic write — the SAME idiom inventory.ts's
 *  `writeInventoryAtomic`/recon.ts's `writeReconArtifactAtomic`/session.ts's
 *  `writeJsonAtomic` already use. */
function writeSynthesisArtifactAtomic(fsDeps: SynthesizeFsDeps, path: string, content: string): void {
  fsDeps.mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  fsDeps.writeFileSync(tmpPath, content);
  fsDeps.renameSync(tmpPath, path);
}

function renderPrBody(input: SynthesizeDraftInput, tasks: Task[]): string {
  return [
    `## rmd onboard synthesize — drafted plan for ${input.owner}/${input.repo}`,
    "",
    "This PR was drafted by `rmd onboard <target-dir> --phase synthesize` (MASTER-PLAN P24(5)+(6), W1-T85):",
    "an Architect worker read the phase 1-3 artifacts (inventory + findings + candidates + this target's own",
    "ratified answers) and drafted `MASTER-PLAN.md`, `plan/tasks.yaml`, and `AGENTS.md` as ONE change.",
    "",
    `Every task below is lint-plan-clean at birth (§5C Layer A ran ${tasks.length ? "and passed" : "over an empty seed"} ` +
      "before this PR was opened).",
    "",
    `Tasks drafted: ${tasks.length} (${tasks.map((t) => t.id).join(", ") || "none"})`,
    "",
    "**This is a DRAFT PR — nothing here auto-merges (Standing rule 15). Merging it IS the ratification.**",
    "",
    "Composition: this PR is the BRAIN (mission, conventions, a change-level plan seed). `rmd project init`",
    "installs the BAR (the CI gate stack this plan is drained against); the daemon drains it.",
  ].join("\n");
}

/**
 * Run phase 4: gate on answer completeness ({@link assertAnswersComplete}), draft until
 * lint-plan-clean ({@link draftPlanUntilClean}), then — and ONLY then — check out
 * `onboard/<repo>-plan`, write the three drafted files (the ONLY writes this module ever
 * performs, and the ONLY ones under `<target-dir>` at all — never under
 * `<target-dir>/plan/onboarding/`), commit, push, and open EXACTLY ONE draft PR.
 */
export async function runOnboardSynthesize(targetDir: string, deps: SynthesizeDeps): Promise<OnboardSynthesizeResult> {
  if (!deps.fs.existsSync(targetDir)) {
    throw new SynthesizeError(`rmd onboard: target directory "${targetDir}" does not exist`);
  }

  const inventory = readInventory(deps.fs, targetDir);
  const answers = readAnswers(deps.fs, targetDir);
  // Gate 1 — FAIL LOUD before any draft/git/gh/write work (acceptance criterion 1).
  assertAnswersComplete(inventory, answers, targetDir);

  const owner = inventory.target.owner;
  const repo = inventory.target.repo;
  if (owner === "unknown" || repo === "unknown") {
    throw new SynthesizeError(
      `rmd onboard synthesize: target owner/repo is unresolved in ${inventoryPathFor(targetDir)} — re-run ` +
        `\`rmd onboard ${targetDir} --phase inventory --owner <o> --repo <r>\` first (a draft PR needs a real repo to open against)`,
    );
  }

  const candidates = readCandidates(deps.fs, targetDir);
  const findings = readFindings(deps.fs, targetDir);

  const input: SynthesizeDraftInput = { inventory, candidates, answers, findings, targetDir, owner, repo };

  // Gate 2 — draft, lint, re-draft on feedback, up to the cap; throws before any branch/PR
  // if still dirty (acceptance criterion 2).
  const { draft, tasks, attempts } = await draftPlanUntilClean(input, deps.draft, deps.maxDraftAttempts);

  const branch = `onboard/${repo}-plan`;
  const masterPlanPath = join(targetDir, "MASTER-PLAN.md");
  const tasksYamlPath = join(targetDir, "plan", "tasks.yaml");
  const agentsMdPath = join(targetDir, "AGENTS.md");

  // EXACTLY one branch (acceptance criterion 3).
  deps.git.exec(["checkout", "-b", branch], targetDir);

  // The ONLY writes this module performs.
  writeSynthesisArtifactAtomic(deps.fs, masterPlanPath, draft.masterPlan);
  writeSynthesisArtifactAtomic(deps.fs, tasksYamlPath, draft.tasksYaml);
  writeSynthesisArtifactAtomic(deps.fs, agentsMdPath, draft.agentsMd);

  deps.git.exec(["add", "-A"], targetDir);
  deps.git.exec(["commit", "-m", `onboard: draft MASTER-PLAN.md, plan/tasks.yaml, AGENTS.md (rmd onboard synthesize)`], targetDir);
  deps.git.exec(["push", "-u", "origin", branch], targetDir);

  // EXACTLY one draft PR (acceptance criterion 3) — never auto-merged (Standing rule 15).
  const prUrl = deps.gh.openPr({
    owner,
    repo,
    branch,
    title: `rmd onboard: draft MASTER-PLAN + tasks.yaml + AGENTS.md for ${owner}/${repo}`,
    body: renderPrBody(input, tasks),
  });

  return { branch, prUrl, masterPlanPath, tasksYamlPath, agentsMdPath, tasks, attempts };
}

// ── CLI arg parsing (pure) — independent of inventory.ts's/recon.ts's/session.ts's own
// parsers; run-task.ts's onboardCommand peeks `--phase` and routes to THIS parser for
// `--phase synthesize` before inventory.ts's own parser (KNOWN_ONBOARD_PHASES stays exactly
// `["inventory"]`) ever sees it. No `--owner`/`--repo` flags here (unlike recon/inventory) —
// deliberately: owner/repo are resolved from the phase-1 inventory's own `target` field
// (itself resolved/overridden back when `--phase inventory` ran), never re-specified here. ──

export const SYNTHESIZE_PHASE = "synthesize" as const;

export interface ParsedSynthesizeArgs {
  targetDir: string;
}

export type ParseSynthesizeArgsResult = { ok: true; args: ParsedSynthesizeArgs } | { ok: false; error: string };

const SYNTHESIZE_VALUE_FLAGS = ["--phase"];

/** Parse+validate `rmd onboard <target-dir> --phase synthesize`'s argv tail. FAIL LOUD,
 *  BEFORE ANY WORK — the same control-surface-fail-loud discipline inventory.ts's/recon.ts's/
 *  session.ts's own parsers already apply. */
export function parseSynthesizeArgs(rest: string[]): ParseSynthesizeArgsResult {
  const targetDir = rest[0];
  if (!targetDir || targetDir.startsWith("--")) {
    return { ok: false, error: "rmd onboard: <target-dir> is required as the first positional argument" };
  }

  const tail = rest.slice(1);
  for (let i = 0; i < tail.length; i++) {
    const tok = tail[i]!;
    if (SYNTHESIZE_VALUE_FLAGS.includes(tok)) {
      i++;
      continue;
    }
    return { ok: false, error: `rmd onboard: unrecognized argument '${tok}'` };
  }

  const phase = tail[tail.indexOf("--phase") + 1];
  if (phase !== SYNTHESIZE_PHASE) {
    return { ok: false, error: `rmd onboard synthesize: --phase must be "${SYNTHESIZE_PHASE}" here; got ${phase ? `"${phase}"` : "nothing"}` };
  }

  return { ok: true, args: { targetDir } };
}
