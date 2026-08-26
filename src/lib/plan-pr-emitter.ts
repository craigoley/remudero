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
 *   2. "Ensure judgeable" REPAIR — {@link ensureJudgeableBody} — never clobbers a HEALTHY
 *      Acceptance block; repairs one that is absent OR present-but-unparseable (a criterion
 *      resolving with an empty proof — see {@link bodyNeedsAcceptanceRepair}).
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
import { acceptanceBlockDiagnostics, parseAcceptanceBlock } from "./review.js";
import { shapeCommitMessage } from "./commit-message.js";
import type { GhApiFetcher } from "./open-prs-rest.js";

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
 * Given an arbitrary PR body (e.g. what a retro's LLM worker produced), leave it COMPLETELY
 * untouched when {@link bodyNeedsAcceptanceRepair} says it is healthy — this NEVER clobbers a
 * caller's or an LLM's real Acceptance block, even a differently-formatted but still-judgeable one,
 * and the regression lock for that matters more than the repair itself. Otherwise demote the
 * defective header (if any) and APPEND a rendered fallback block (see
 * {@link renderAcceptanceBlock}) built from `fallbackCriteria`, so the result actually PARSES
 * judgeably rather than merely gaining a block the parser never reaches.
 *
 * The harness-side backstop for a worker's shape mistake — originally #394's unrecognised header,
 * and now also the far more common empty-proof shape that header-only trigger walked past.
 */
/**
 * TRUE when a body's Acceptance block needs the repair below — the single definition of
 * "defective", so the repair and its callers can never drift apart on what triggers it.
 *
 * WHY THIS IS NOT `parseAcceptanceBlock(body).length === 0`. That was the original trigger, and it
 * is OFF BY ONE from the defect it exists to catch. `parseAcceptanceBlock` ends the block at the
 * first indented line that is not `proof:`, so a bullet whose text wraps — or one written in the
 * `- **"claim"** — prose` shape with no `|` separator and no `proof:` continuation — pushes ONE
 * criterion with an EMPTY proof and silently discards every bullet after it. Parsed length is 1,
 * not 0, so the repair declined to fire on exactly the shape it was built for.
 *
 * MEASURED over the 100 most recent PRs at 5ea9172: 67 carry a healthy block, 11 carry no block at
 * all (the only case the old trigger caught), and **22 parse to a criterion with an empty proof** —
 * every one of them `parsed=1 empty=1`. The missed shape is twice as common as the caught one.
 *
 * AN EMPTY PROOF WAS THE WHOLE SIGNAL, AND IT IS NO LONGER ENOUGH (W1-T2316). The paragraph that
 * stood here argued that "fewer criteria than were written" had NO BASIS, because the body comes
 * from `gh pr view --json body` and no emitter count exists to compare against. THAT PREMISE WAS
 * WRONG IN ONE WORD: the count does not come from an emitter, it comes from COUNTING THE BULLETS
 * THE AUTHOR WROTE, with the parser's own {@link ACCEPTANCE_BULLET_RE}. {@link
 * acceptanceBlockDiagnostics} (lib/review.ts) has computed exactly that as `bulletsWritten` the
 * whole time, one module away and already imported here. Nothing is guessed and no author intent
 * is inferred: two counts over the same text are compared, and they disagree or they do not.
 *
 * THE SHAPE THIS ADDS, MEASURED ON r29's OWN BULLETS. A wrap BEFORE the `|` leaves the surviving
 * criterion with an EMPTY proof, so the old trigger already caught it — reproduced at
 * `written 5 / parsed 1 / emptyProofs 1`, predicate `true` both before and after. A wrap AFTER the
 * `|` does not: the first criterion keeps a non-empty proof and every later bullet vanishes —
 * `written 5 / parsed 1 / emptyProofs 0`, predicate **false** before and **true** after. That
 * second shape is the r29 incident, and it is the only thing this widening adds.
 *
 * `truncatedAtBullet` IS NOT A SECOND CONDITION. It is defined as `parsed.length < bulletsWritten
 * ? parsed.length + 1 : undefined`, so testing it would be testing this same inequality in 1-based
 * clothing. One condition, stated once.
 *
 * IT CANNOT FIRE ON PROSE. Both counts are taken INSIDE an Acceptance block, a region whose grammar
 * is already one bullet per physical line; a body with no such header yields `bulletsWritten: 0`
 * and is decided by the zero-criteria arm exactly as before. Freely-wrapped rationale prose is
 * never read by this predicate at all.
 *
 * RETROFIT, MEASURED BEFORE THE CHANGE over 308 real PR bodies (8 open, 295 merged): flagged today
 * 108, flagged widened 108, NEWLY flagged 0, and 0 bodies lose a flag they have today. The
 * widening is a strict superset that is silent on the live corpus — the one body it was built for
 * had been hand-repaired before it merged.
 *
 * {@link parseAcceptanceBlock} is NOT changed. It must stay permissive — making it throw would fail
 * bodies that merge today (any with trailing prose under the block) and move a hard failure into the
 * gate, where the author is already gone. The parser keeps its contract; the repair widens.
 */
export function bodyNeedsAcceptanceRepair(body: string): boolean {
  const parsed = parseAcceptanceBlock(body);
  if (parsed.length === 0) return true;
  if (parsed.some((c) => c.proof.trim().length === 0)) return true;
  // W1-T2316: the block says less than its author wrote. `headerFound` is required so this arm can
  // only ever speak about text inside an Acceptance block, never about a body without one.
  const d = acceptanceBlockDiagnostics(body);
  return d.headerFound && d.bulletsWritten > d.criteriaParsed;
}

/**
 * The header regex {@link parseAcceptanceBlock} matches, mirrored here for ONE purpose: to demote a
 * defective header so the parser walks PAST it to the repaired block appended below. It requires the
 * line to be ONLY the header, so appending a suffix is sufficient to stop it matching — no content is
 * removed and the author's original text stays verbatim and readable.
 *
 * WHY THE REPAIR NEEDS THIS AT ALL, which is the half the trigger widening exposed. `ensureJudgeableBody`
 * APPENDS its fallback, and the parser stops at the FIRST header it finds. That is fine for the case the
 * repair was built for — a body with NO block, where there is nothing earlier to stop at. It is NOT fine
 * for a body whose block is PRESENT BUT DEFECTIVE: the parser reaches the broken bullets first, resolves
 * the same empty-proof criterion, and never sees the appended block. Widening the trigger without this
 * would have produced a guard that edits a PR body, logs `acceptance.repaired`, and leaves the body
 * exactly as unjudgeable as before — worse than not firing, because it claims a repair that did not
 * happen. Verified before writing this: the appended-only form returned
 * `[{claim:"…wraps it onto a second", proof:""}]` from the REPAIRED body.
 */
const ACCEPTANCE_HEADER_RE = /^(\s*#{0,6}\s*\**\s*acceptance(\s+criteria)?\b\s*\**\s*:?\s*\**\s*)$/i;

/** The suffix that demotes a superseded header. Prose, not a marker — nothing parses it. */
export const SUPERSEDED_HEADER_SUFFIX = " (superseded — unparseable, see the repaired block below)";

export function ensureJudgeableBody(body: string, fallbackCriteria: AcceptanceCriterion[]): string {
  if (!bodyNeedsAcceptanceRepair(body)) return body;
  const block = renderAcceptanceBlock(fallbackCriteria);
  // Demote ONLY the first matching header — the one the parser would have stopped at. A body with no
  // header is unaffected, so the original no-block behaviour is byte-for-byte what it always was.
  let demoted = false;
  const lines = body.split("\n").map((line) => {
    if (demoted) return line;
    const m = ACCEPTANCE_HEADER_RE.exec(line);
    if (!m) return line;
    demoted = true;
    return `${m[1].replace(/\s+$/, "")}${SUPERSEDED_HEADER_SUFFIX}`;
  });
  const trimmed = lines.join("\n").replace(/\s*$/, "");
  const repaired = trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  // W1-T2316 design (iv) — REFUSE TO CLAIM A REPAIR THAT DID NOT LAND. Every caller logs
  // `acceptance.repaired` (or returns a `repairedBody`) on the strength of this return value, so a
  // body that still trips the predicate would ship a false claim rather than a defect. The failure
  // is a CALLER bug — `fallbackCriteria` whose claim or proof carries a newline or an unescaped
  // separator cannot round-trip through `renderAcceptanceBlock` — and it surfaces here immediately,
  // the same posture `renderAcceptanceBlock` already takes on an empty list. NOT a widening of what
  // counts as judgeable: this throws instead of returning an unjudgeable body, never the reverse.
  if (bodyNeedsAcceptanceRepair(repaired)) {
    throw new Error(
      "ensureJudgeableBody: the repaired body still needs repair — the fallback criteria do not " +
        "round-trip through parseAcceptanceBlock (a claim or proof carrying a newline or a bare `|` " +
        "is the usual cause). Refusing to return a body a caller would log as repaired.",
    );
  }
  return repaired;
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

// ── 7. Ratification PR — REST create + resumption probe (W1-T903) ───────────────────────────
//
// `rmd approve`'s ratification PR used to open over `gh pr create`, which is GraphQL — an
// exhausted GraphQL budget stranded an already-pushed ratification branch with no PR, and the
// naive re-run pushed a SECOND branch rather than finishing the first. Both primitives below are
// a PURE TRANSPORT SWAP at this ONE site: `openPlanPr` (run-task.ts) already authors an explicit
// `--title` and `--body` (buildPlanPrBody + filingAcceptanceCriteria above), so unlike the four
// `--fill` sites this module's header doc excludes, no body has to be invented to make the swap.
// `fetch` is the SAME {@link GhApiFetcher} `fetchOpenPrsRest` (open-prs-rest.ts) already takes,
// reused unchanged rather than re-derived — real callers pass `ghJson` (lib/worker.ts).

/** `gh api --method POST repos/{owner}/{repo}/pulls` argv — the REST create call. */
export function ratifyPrCreateRestArgs(owner: string, repo: string, opts: { title: string; body: string; head: string; base: string }): string[] {
  return ["api", "--method", "POST", `repos/${owner}/${repo}/pulls`, "-f", `title=${opts.title}`, "-f", `body=${opts.body}`, "-f", `head=${opts.head}`, "-f", `base=${opts.base}`];
}

/** A ratification PR reference, read back from ONE REST response — `number` and `html_url` are
 *  both present on both the create response and the list-by-head probe response below, so
 *  neither caller ever needs a second call to learn the other. */
export interface RatifyPrRef {
  prUrl: string;
  prNumber: number;
}

/**
 * Open the ratification PR over REST. Throws on a malformed/absent response — mirrors the
 * `if (!prUrl) throw ...` this replaces (a create that produced no usable reference must fail
 * loud, not silently ledger nothing and report success).
 */
export function createPlanPrRest(fetch: GhApiFetcher, owner: string, repo: string, opts: { title: string; body: string; head: string; base: string }): RatifyPrRef {
  const row = fetch(ratifyPrCreateRestArgs(owner, repo, opts)) as { html_url?: string; number?: number };
  if (!row?.html_url || typeof row.number !== "number") {
    throw new Error("rmd approve: `gh api ... pulls` (POST) produced no html_url/number");
  }
  return { prUrl: row.html_url, prNumber: row.number };
}

/**
 * `gh api repos/{owner}/{repo}/pulls?head=...` argv, filtered to ONE head branch — the SAME
 * REST surface {@link "./open-prs-rest.js".fetchOpenPrsRest} already reads, never `gh pr list`
 * (which would reintroduce the GraphQL dependency this task exists to remove). `state=open`:
 * a stranded ratification's own prior attempt, if it created a PR at all, created an OPEN one
 * moments earlier — never merged or manually closed by the time the SAME proposal is re-approved.
 */
export function ratifyPrProbeRestArgs(owner: string, repo: string, headBranch: string): string[] {
  return ["api", `repos/${owner}/${repo}/pulls?head=${owner}:${headBranch}&state=open`];
}

/**
 * The resumption probe (W1-T903 design ii): whether a PR already exists for `headBranch`, asked
 * BEFORE anything is created — covers a prior run whose `gh`/REST create actually succeeded
 * server-side but never returned a usable reference to the CLI. `undefined` means "none found";
 * a probe failure throws exactly as the create call does, rather than swallowing an error that
 * could otherwise hide a real PR the caller would go on to duplicate.
 */
export function probeExistingPlanPr(fetch: GhApiFetcher, owner: string, repo: string, headBranch: string): RatifyPrRef | undefined {
  const rows = fetch(ratifyPrProbeRestArgs(owner, repo, headBranch)) as Array<{ html_url?: string; number?: number }>;
  const row = rows?.[0];
  if (!row?.html_url || typeof row.number !== "number") return undefined;
  return { prUrl: row.html_url, prNumber: row.number };
}

// ── 8. Retro changeset-claim reconciliation (W1-T911) ───────────────────────────────────────
//
// `retroCommand` (run-task.ts) spawns the Architect worker, which edits MASTER-PLAN.md, pushes,
// and OPENS THE PR — writing a body whose changeset claim is TRUE at that instant (the diff
// really is one file). Only AFTER the worker returns does the harness commit
// `docs/ORIENTATION.md` (regenerateOrientation) and `plan/plan-index.json`
// (regeneratePlanIndexAndCommit) into that SAME PR, widening the diff the body already
// described. `bodyContradictsDiff` (review.ts) then reads the widened diff against the
// now-stale body and refuses it — four real instances (#974, #1685, #1943, #1944), the last two
// 23 minutes apart with a byte-identical "exactly one file" failure. The claim's author (the
// Architect) cannot be the one to fix this: it does not exist anymore by the time the body goes
// stale, and it never knew what the harness would append after it returned.
//
// This is a PURE reconciler — no git, no network, no I/O — taking the body and the paths the
// caller already computed (run-task.ts reads them via `gh pr diff --name-only`, after both
// harness commits land). It repairs ONLY the two arms `bodyContradictsDiff` actually keys on
// (that function's own doc forbids guessing at prose beyond them):
//
//   (a) a stated file COUNT ("exactly N files[: a, b]") that disagrees with the real changeset.
//       Repaired by replacing the whole count-shaped claim with a sentence that ENUMERATES the
//       real paths and states no count at all — never a recomputed number, which would just be
//       the same defect wearing a new number the next time the harness regenerates a different
//       arity of companion file. See {@link retroChangesetSentence}.
//   (b) a "no <path>" DENIAL for a path the diff actually carries — what #1943 tripped by
//       writing "No docs/ORIENTATION.md" while carrying it. Repaired by DROPPING that specific
//       denial (never rewriting it into a new claim, which could itself go stale). A denial the
//       diff does NOT refute — "no src/" on a genuinely plan-only retro — is TRUE and SURVIVES:
//       it is the reader's real assurance the retro carried no code, so only a denial the diff
//       actually contradicts is ever touched.
//
// Deliberately NOT built on top of `bodyContradictsDiff`'s own detection regexes (imported or
// otherwise): sharing symbols would let a future widening of the detector silently change what
// this rewrites without either side noticing. The two are held together by a FALSIFIER instead
// (test/retro-changeset-claim.test.ts drives the real `bodyContradictsDiff` over this function's
// output and requires it to fall silent), which is the same discipline run-task.ts's prior
// arm-(a)-only rung (W1-T908) already used.

/** Matches the count-shaped claim `bodyContradictsDiff`'s arm (a) reads, including an optional
 *  colon-led enumeration ("exactly one file: MASTER-PLAN.md"). Built fresh per call: a
 *  module-level `/g` regex carries `lastIndex` between calls, so a shared instance would answer
 *  `.test()` differently on a second invocation over the same input. */
function changesetCountClaimRe(): RegExp {
  return /\bexactly\s+\w+\s+files?\b(?:\s*:\s*[^\s,]+(?:\s*,\s*[^\s,]+)*)?/gi;
}

/**
 * Render the changeset as PATHS AND NEVER A COUNT — the canonical replacement for arm (a)'s
 * claim. A count is what failed four PRs; a corrected count is the same defect wearing a new
 * number, wrong again the moment a later run regenerates a different arity of companion file.
 * Naming the paths is correct for any arity by construction. Sorted so the sentence is stable
 * across two runs over the same changeset.
 */
export function retroChangesetSentence(paths: readonly string[]): string {
  const sorted = [...paths].sort();
  if (sorted.length === 0) return "no files";
  if (sorted.length === 1) return sorted[0];
  return `${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}`;
}

/** Arm (a): replace every count-shaped claim in `body` with {@link retroChangesetSentence}'s
 *  enumeration. `undefined` when there is nothing to repair. */
function reconcileChangesetCountClaim(body: string, paths: readonly string[]): string | undefined {
  if (!changesetCountClaimRe().test(body)) return undefined;
  return body.replace(changesetCountClaimRe(), retroChangesetSentence(paths));
}

/** Matches a `no <path>` denial the way `bodyContradictsDiff`'s arm (b) does — a path-shaped
 *  token is anything containing `.` or `/`, so "no bugs"/"no issues" never match here at all
 *  (nothing to check a diff against, and nothing this reconciler should ever touch). */
const NO_PATH_CLAIM_RE = /\bno\s+([A-Za-z0-9_./-]+)/gi;

/** A path-SHAPED token — the same guard `bodyContradictsDiff`'s arm (b) uses to stay silent on
 *  "no bugs"/"no issues", mirrored here (not imported — see the module-comment falsifier note
 *  above) rather than shared. */
function looksLikeChangesetPath(token: string): boolean {
  return /[./]/.test(token);
}

/** Does `file` fall under the claimed-absent `path` (an exact file, or a directory prefix)? */
function fileUnderClaimedPath(file: string, path: string): boolean {
  const normalized = path.replace(/\/$/, "");
  return file === normalized || file.startsWith(`${normalized}/`);
}

/**
 * Tidy the punctuation a dropped `no <path>` clause leaves behind: a dangling comma right
 * before whatever now ends the clause (a full stop, end of line, or end of body), a bare comma
 * right after whatever began it, two commas left adjacent by a middle drop, and doubled interior
 * spacing. Never touches a newline — a paragraph break is structural, not residue.
 */
function cleanupDroppedNoPathClauses(text: string): string {
  return text
    .replace(/,([ \t]*)(?=[.!?]|\n|$)/g, "$1")
    .replace(/(^|[.!?\n][ \t]*),([ \t]*)/g, "$1$2")
    .replace(/,([ \t]*),/g, ",$1")
    .replace(/[ \t]{2,}/g, " ");
}

/** Arm (b): drop every `no <path>` denial the real `paths` refute; a denial `paths` does NOT
 *  refute is TRUE and survives untouched (design (iv) — see the module comment above).
 *  `undefined` when there is nothing to repair. */
function reconcileNoPathDenials(body: string, paths: readonly string[]): string | undefined {
  let changed = false;
  const out = body.replace(NO_PATH_CLAIM_RE, (whole: string, rawToken: string) => {
    const token = rawToken.replace(/[,.\s]+$/, "");
    if (!looksLikeChangesetPath(token)) return whole;
    const refuted = paths.some((f) => fileUnderClaimedPath(f, token));
    if (!refuted) return whole;
    changed = true;
    return "";
  });
  if (!changed) return undefined;
  return cleanupDroppedNoPathClauses(out);
}

/**
 * THE PURE RECONCILER (W1-T911 design (i)). Given a retro PR body and the real changeset it
 * ultimately carries (both companion files included), returns the corrected body — or `undefined`
 * when the body already agrees with `paths` and needs no edit at all, so a caller can distinguish
 * "healthy" from "rewritten" without diffing strings.
 *
 * Runs BOTH arms in sequence (arm (a) first, since its replacement sentence can itself introduce
 * new prose for arm (b) to read, never the reverse — arm (b) only removes text). See the module
 * comment above this section for the two arms' individual contracts and the falsifier discipline
 * that holds this function and `bodyContradictsDiff` together without sharing a regex.
 */
export function reconcileRetroChangesetClaim(body: string, paths: readonly string[]): string | undefined {
  let current = body;
  let changed = false;
  const afterCount = reconcileChangesetCountClaim(current, paths);
  if (afterCount !== undefined) {
    current = afterCount;
    changed = true;
  }
  const afterDenials = reconcileNoPathDenials(current, paths);
  if (afterDenials !== undefined) {
    current = afterDenials;
    changed = true;
  }
  return changed ? current : undefined;
}
