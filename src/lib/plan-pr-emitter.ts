/**
 * lib/plan-pr-emitter.ts — the shared gate-contract module for every MACHINE flow that
 * opens a "plan PR" (W1-T136; `rmd retro` and `rmd approve` today, more later).
 *
 * WHY THIS EXISTS. Two flows independently reinvented commit/PR-body hygiene and both
 * tripped the same CI gate stack (commitlint header+body limits, `plan-index:check`
 * staleness, and `remudero-review`'s fail-closed-on-no-Acceptance-block behavior):
 *
 *   - #287 (retro): `retroCommand` edited MASTER-PLAN.md without regenerating
 *     `plan/plan-index.json`, so `plan-index:check` redded; it also emitted a
 *     non-conventional-commit-type message. Needed two hand-fixes to merge.
 *   - #387 (approve): `approveCommand` (a) spliced a 673-character `stampLine`
 *     VERBATIM, unwrapped, into the commit body -> commitlint `body-max-line-length`
 *     failure; (b) opened a PR body with NO Acceptance section at all ->
 *     `remudero-review` failed CLOSED ("no acceptance criteria to judge"). Needed the
 *     same two-hand fix.
 *   - #394 (a hand-authored filing PR): an Acceptance header that was not BARE on its
 *     own line (`## Acceptance criteria and how each is proved`) was NOT recognized by
 *     {@link "./review.js".parseAcceptanceBlock} and self-posted a RED review — proof
 *     that "looks like an Acceptance block" is not the same as "IS an Acceptance block".
 *
 * The fix is ONE shared, independently-tested module every plan-PR-opening flow calls,
 * so the gate contract lives in one place instead of per-site discipline. It provides
 * six primitives:
 *
 *   1. Acceptance-block RENDERING — {@link renderAcceptanceBlock} — the missing
 *      counterpart to `parseAcceptanceBlock`, guaranteed to round-trip through it.
 *   2. "Ensure judgeable" REPAIR — {@link ensureJudgeableBody} — never clobbers a real
 *      Acceptance block, only appends a fallback when there is none (the #394 backstop).
 *   3. Filing-PR Acceptance auto-authorship — {@link filingAcceptanceCriteria} — a PR
 *      that FILES a new task cannot cite that task's own (not-yet-existing) acceptance
 *      criteria, so it needs criteria about the filing itself.
 *   4. Gate-compliant commit-message assembly — {@link buildPlanPrCommitMessage} — wraps
 *      {@link "./commit-message.js".shapeCommitMessage} (never reimplemented) and adds an
 *      OPTIONAL task-id trailer (see the correctness rule below).
 *   5. PR-body assembly — {@link buildPlanPrBody} — intro + a rendered Acceptance block +
 *      an optional trailer, guaranteed judgeable by construction.
 *   6. Plan-index regeneration — {@link regeneratePlanIndexFile} /
 *      {@link regeneratePlanIndexAndCommit} — mirrors {@link "./orientation.js".regenerateOrientation}'s
 *      write/add/diff-cached-quiet/commit-if-changed pattern, for `plan/plan-index.json`
 *      (the #287 fix), invoking `scripts/generate-plan-index.mjs` (never reimplementing
 *      its parsing).
 *
 * THE CORRECTNESS RULE (not just style): a plan-FILING PR — one that introduces a NEW
 * task into `plan/tasks.yaml` that did not exist on `origin/main` — must NEVER carry a
 * `Remudero-Task: <id>` trailer. `findMergedByTrailer` (lib/status.ts) searches merged
 * PRs for that trailer and marks the named task DONE; a filing PR only ADDS the task, it
 * does not implement it, so crediting it would permanently mark a brand-new,
 * never-built task complete. Every function here that emits a trailer takes the task id
 * as an OPTIONAL argument for exactly this reason: omit it for a filing PR, supply it
 * for a real implementing PR.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceCriterion } from "./plan.js";
import { parseAcceptanceBlock } from "./review.js";
import { shapeCommitMessage } from "./commit-message.js";

// ── 1. Acceptance-block rendering (the missing counterpart to parseAcceptanceBlock) ─────────

/**
 * Render a BARE `Acceptance:` header (nothing else on that line, per the #394 lesson —
 * `parseAcceptanceBlock`'s header regex requires the line to be otherwise empty) followed
 * by CONTIGUOUS `- <claim> | <proof>` bullets, one per criterion, with no blank or prose
 * line between the header and the bullets (the #394 lesson, again — any such line
 * terminates the block early). Guaranteed to round-trip through `parseAcceptanceBlock`
 * with `criteria.length` matching.
 *
 * Throws on an empty `criteria` list: an empty Acceptance block is unjudgeable by
 * construction (`parseAcceptanceBlock` would return `[]`, which fails CLOSED in
 * `judgeReview`), so a caller bug here must surface immediately rather than silently ship
 * an unjudgeable PR.
 */
export function renderAcceptanceBlock(criteria: AcceptanceCriterion[]): string {
  if (criteria.length === 0) {
    throw new Error(
      "renderAcceptanceBlock: at least one criterion is required — an empty Acceptance block is " +
        "unjudgeable by construction (parseAcceptanceBlock would resolve zero criteria, which fails " +
        "CLOSED at review time).",
    );
  }
  const lines = ["Acceptance:"];
  for (const { claim, proof } of criteria) {
    lines.push(`- ${claim} | ${proof}`);
  }
  return lines.join("\n");
}

// ── 2. "Ensure judgeable" repair (the #394 backstop) ─────────────────────────────────────────

/**
 * Given an arbitrary PR body (e.g. what a retro's LLM worker produced), leave it
 * COMPLETELY untouched if `parseAcceptanceBlock` already resolves at least one
 * criterion — this NEVER clobbers a caller's or an LLM's real Acceptance block, even a
 * differently-formatted but still-parseable one. Otherwise, APPEND a rendered fallback
 * block (see {@link renderAcceptanceBlock}) built from `fallbackCriteria`, so the result
 * is always judgeable. This is the harness-side repair pass that keeps a worker's #394-shaped
 * mistake (an Acceptance header the parser doesn't recognize) from sinking an otherwise-fine PR.
 */
export function ensureJudgeableBody(body: string, fallbackCriteria: AcceptanceCriterion[]): string {
  if (parseAcceptanceBlock(body).length > 0) return body;
  const block = renderAcceptanceBlock(fallbackCriteria);
  const trimmed = body.replace(/\s*$/, "");
  return trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

// ── 3. Filing-PR Acceptance auto-authorship ──────────────────────────────────────────────────

/**
 * Acceptance criteria ABOUT THE FILING ITSELF, for a PR that files one or more new plan
 * tasks. A filing PR structurally cannot cite the filed task's own eventual acceptance
 * criteria as proof of anything yet — `remudero-review` resolves acceptance criteria via
 * `loadPlan` against the working checkout, and a task the PR itself is introducing is not
 * there until the PR is opened, so a "prove the task's own acceptance" claim is
 * unreachable at filing time. This substitutes a claim about the filing being
 * well-formed, provable by the gate that already runs on every PR (commitlint,
 * `plan-index:check`).
 */
export function filingAcceptanceCriteria(taskIds: string[], files: string[]): AcceptanceCriterion[] {
  if (taskIds.length === 0) {
    throw new Error("filingAcceptanceCriteria: at least one filed task id is required");
  }
  const idList = taskIds.join("/");
  const fileList = files.join(", ");
  return [
    {
      claim: `${idList} filed as well-formed plan task shard(s), not (yet) implemented`,
      proof: `this diff's only files are ${fileList}; commitlint and plan-index-check both pass on the resulting commit`,
    },
  ];
}

// ── 4. Gate-compliant commit-message assembly (the #387 body fix) ───────────────────────────

export interface PlanPrCommitOpts {
  /** The conventional-commit scope, e.g. `"plan"` -> `chore(plan): ...`. */
  scope: string;
  /** The commit subject (goes through `shapeCommitMessage`'s header shaping/trimming). */
  subject: string;
  /** Free-text extra body. WRAPPED via `shapeCommitMessage`/`wrapBodyLines` — NEVER
   *  spliced in raw (this is the literal #387 fix: a raw stamp line blew
   *  `body-max-line-length`). Paragraphs are separated by a blank line (`"\n\n"`); a
   *  single logical paragraph should contain no internal `"\n"` so it reflows as one
   *  unit rather than wrapping each original line independently. */
  extraBody?: string;
  /** The task id for the `Remudero-Task:` trailer. OMIT for a plan-FILING PR (the
   *  correctness rule above) — no argument means no trailer, never a wrong one. */
  taskId?: string;
}

/**
 * Assemble a commit message that is guaranteed commitlint-clean (header <= 100 chars,
 * lower-case subject, no over-long body line — all via `shapeCommitMessage`, never
 * reimplemented here) and carries a `Remudero-Task:` trailer ONLY when `taskId` is given.
 */
export function buildPlanPrCommitMessage(opts: PlanPrCommitOpts): string {
  const { scope, subject, extraBody, taskId } = opts;
  const shaped = shapeCommitMessage(`chore(${scope})`, subject, extraBody ?? "");
  if (!taskId) return shaped.message;
  return `${shaped.message.replace(/\n+$/, "")}\n\nRemudero-Task: ${taskId}\n`;
}

// ── 5. PR-body assembly ───────────────────────────────────────────────────────────────────

export interface PlanPrBodyOpts {
  /** Free-text intro prose (may itself be multi-line/multi-paragraph). */
  intro: string;
  /** Rendered via {@link renderAcceptanceBlock} — always the LAST thing before an optional
   *  trailer, so the block's bullets are never interrupted (the #394 lesson). */
  criteria: AcceptanceCriterion[];
  /** OMIT for a plan-FILING PR — see the correctness rule above. */
  taskId?: string;
}

/**
 * Assemble a PR body: intro prose, a blank line, a rendered (always judgeable)
 * Acceptance block, and an optional `Remudero-Task:` trailer.
 */
export function buildPlanPrBody(opts: PlanPrBodyOpts): string {
  const { intro, criteria, taskId } = opts;
  const parts = [intro.trim(), "", renderAcceptanceBlock(criteria)];
  if (taskId) parts.push("", `Remudero-Task: ${taskId}`);
  return `${parts.join("\n")}\n`;
}

// ── 6. Plan-index regeneration (the #287 fix, mirrors lib/orientation.ts) ───────────────────

const PLAN_INDEX_REL_PATH = "plan/plan-index.json";
const PLAN_INDEX_COMMIT_MESSAGE = "chore(plan): regenerate plan/plan-index.json";

export interface RegeneratePlanIndexOpts {
  /** The git worktree containing MASTER-PLAN.md / plan/plan-index.json / the generator
   *  script (all three are tracked files, so any worktree of this repo has all three). */
  worktreePath: string;
  /** Repo-relative source, forwarded to the generator as `--source`. */
  sourceRelPath?: string;
  /** Repo-relative output, forwarded to the generator as `--out`. */
  outRelPath?: string;
}

export interface RegeneratePlanIndexResult {
  /** The repo-relative path written (defaults to `plan/plan-index.json`). */
  relPath: string;
  /** True iff the regenerated content differs from what was on disk beforehand. */
  changed: boolean;
}

function readIfExists(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Low-level primitive: regenerate `plan/plan-index.json` in `worktreePath` by invoking
 * the REAL `scripts/generate-plan-index.mjs` (never reimplementing its parsing), and
 * report whether the content changed. Does NOT `git add`/commit — `rmd approve` uses this
 * directly, since its own single `git add -A -- plan/ MASTER-PLAN.md` already sweeps up
 * the regenerated file into its one commit. See {@link regeneratePlanIndexAndCommit} for
 * the "regenerate AND commit if changed" wrapper `rmd retro` uses instead.
 */
export function regeneratePlanIndexFile(opts: RegeneratePlanIndexOpts): RegeneratePlanIndexResult {
  const { worktreePath, sourceRelPath = "MASTER-PLAN.md", outRelPath = PLAN_INDEX_REL_PATH } = opts;
  let scriptPath = join(worktreePath, "scripts", "generate-plan-index.mjs");
  // realpathSync: the script's own "run as main" guard
  // (`import.meta.url === pathToFileURL(process.argv[1]).href`) compares a RESOLVED URL
  // against argv[1]'s literal path. If `worktreePath` sits under a symlink (e.g. macOS's
  // `/tmp` -> `/private/tmp`, which any temp-dir-rooted worktree could), an unresolved
  // scriptPath never matches and `main()` silently never runs — exit 0, nothing written,
  // and the STALE index survives (the exact #287 failure this module exists to prevent).
  // Resolving here makes the primitive correct regardless of where `worktreePath` lives.
  try {
    scriptPath = realpathSync(scriptPath);
  } catch {
    // Missing script — the execFileSync below will fail loudly with a clear ENOENT.
  }
  const outPath = join(worktreePath, outRelPath);
  const before = readIfExists(outPath);
  execFileSync(process.execPath, [scriptPath, "--source", sourceRelPath, "--out", outRelPath], {
    cwd: worktreePath,
    stdio: "pipe",
  });
  const after = readFileSync(outPath, "utf8");
  return { relPath: outRelPath, changed: before !== after };
}

export interface RegeneratePlanIndexAndCommitResult {
  relPath: string;
  /** True iff content differed from HEAD and a new commit was made. */
  committed: boolean;
  /** `git show` of the new commit (patch + stat) — OMITTED when `committed` is false. */
  diff?: string;
}

/**
 * Higher-level wrapper: regenerate (via {@link regeneratePlanIndexFile}), `git add`, and —
 * ONLY if the content changed from what's currently committed — commit it as its own
 * labeled commit, EXACTLY mirroring {@link "./orientation.js".regenerateOrientation}'s
 * write/add/diff-cached-quiet/commit-if-changed discipline. `rmd retro` calls this
 * (its own separate commit, alongside ORIENTATION.md's); `rmd approve` does not need it
 * (see {@link regeneratePlanIndexFile}'s doc comment).
 */
export function regeneratePlanIndexAndCommit(opts: RegeneratePlanIndexOpts): RegeneratePlanIndexAndCommitResult {
  const { worktreePath } = opts;
  const { relPath } = regeneratePlanIndexFile(opts);
  execFileSync("git", ["-C", worktreePath, "add", relPath]);
  try {
    execFileSync("git", ["-C", worktreePath, "diff", "--cached", "--quiet"]);
    // exit 0 ⇒ nothing staged ⇒ content is unchanged from HEAD; nothing to commit.
    return { relPath, committed: false };
  } catch {
    // non-zero ⇒ staged changes exist ⇒ commit them as their own, clearly-labeled commit.
    execFileSync("git", ["-C", worktreePath, "commit", "-m", PLAN_INDEX_COMMIT_MESSAGE]);
    const diff = execFileSync("git", ["-C", worktreePath, "show", "--stat=200", "-p", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    return { relPath, committed: true, diff };
  }
}
