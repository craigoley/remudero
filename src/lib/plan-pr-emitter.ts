/**
 * The shared gate-contract module for every machine flow that opens a plan PR (W1-T136: `rmd retro` and
 * `rmd approve`). Two flows once reinvented commit and PR-body hygiene independently and both tripped the
 * same CI gate stack — commitlint, `plan-index:check`, and the review gate's fail-closed-on-no-Acceptance-
 * block rule. Why: the three incidents that forced this module into existence — docs/forensics/plan-pr-emitter.md
 * Six primitives: {@link renderAcceptanceBlock} renders a judgeable Acceptance block; {@link ensureJudgeableBody}
 * repairs one that parses defectively; {@link filingAcceptanceCriteria} writes acceptance for a PR that files a
 * task rather than building it; {@link buildPlanPrCommitMessage} / {@link buildPlanPrBody} assemble a gate-clean
 * commit and PR body; {@link regeneratePlanIndexFile} / {@link regeneratePlanIndexAndCommit} regenerate `plan/plan-index.json`.
 * INVARIANT: a plan-FILING PR — one adding a task to `plan/tasks.yaml` that did not exist on `origin/main` —
 * must never carry a `Remudero-Task: <id>` trailer. `findMergedByTrailer` (lib/status.ts) marks the trailered
 * task DONE on merge, and a filing PR only adds the task, it does not build it. Every function below that
 * emits a trailer takes the task id as an optional argument for exactly this reason: omit it to file, supply it to implement.
 * FALSIFIER: test/plan-pr-emitter.test.ts and the acceptance-block/retro-acceptance test suites.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceCriterion } from "./plan.js";
import { acceptanceBlockDiagnostics } from "./review.js";
import { emDashSeparatedProof } from "./body-repair.js";
import {
  renderCommitNarrativeParagraphs,
  shapeCommitMessage,
} from "./commit-message.js";
import {
  type OperatorMessageSlot,
} from "./operator-message.js";
import type { GhApiFetcher } from "./open-prs-rest.js";

// ── 1. Acceptance-block rendering (the missing counterpart to parseAcceptanceBlock) ─────────

/**
 * Render a bare `Acceptance:` header (nothing else on the line) followed directly by one bullet per
 * criterion, with no blank or prose line between them — `parseAcceptanceBlock` requires both, and the
 * round trip through it is this function's whole contract.
 * TRAP: a `|` anywhere in a claim or proof cannot ride the single-line `- <claim> | <proof>` form, because
 * the parser splits the line at it. Emit the other accepted shape instead — `- claim: "<claim>"` / indented
 * `  proof: "<proof>"` — which carries no separator to split. Why: the pipe-truncation incident (PR #4082) — docs/forensics/plan-pr-emitter.md
 * Throws on an empty `criteria` list: an empty block resolves to zero criteria and fails closed at review
 * time, so a caller bug must surface immediately, not ship silently.
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
    // Both sides quoted so `stripQuotes` returns exactly what was passed in.
    if (claim.includes("|") || proof.includes("|")) {
      lines.push(`- claim: "${claim}"`, `  proof: "${proof}"`);
      continue;
    }
    lines.push(`- ${claim} | ${proof}`);
  }
  return lines.join("\n");
}

// ── 2. "Ensure judgeable" repair (the #394 backstop) ─────────────────────────────────────────

/**
 * Repair `body`'s Acceptance block only when {@link bodyNeedsAcceptanceRepair} calls it defective — a
 * healthy block, even a differently-formatted one, is never touched. Otherwise demote the defective header
 * (if any) and append a rendered fallback block built from `fallbackCriteria`, so the result parses judgeably.
 *
 * `bodyNeedsAcceptanceRepair` checks more than "zero criteria parsed": a wrapped or truncated bullet can
 * still parse to one criterion with a real proof, which used to read as healthy even though every bullet
 * after it was silently discarded (W1-T2316; `truncatedAtBullet`, from
 * {@link "./review.js".acceptanceBlockDiagnostics}, reads that off the text itself). Why: the measured
 * false-healthy rate — docs/forensics/plan-pr-emitter.md. `parseAcceptanceBlock` itself stays unchanged and
 * permissive, since it must keep accepting bodies that merge today; this is where the stricter check lives.
 */
export function bodyNeedsAcceptanceRepair(body: string): boolean {
  const diagnostics = acceptanceBlockDiagnostics(body);
  // No header, or a header with no bullets.
  if (diagnostics.criteriaParsed === 0) return true;
  // A bullet the parser wrote but never reached.
  if (diagnostics.truncatedAtBullet !== undefined) return true;
  // Everything parsed, but at least one resolved with nothing to execute.
  return diagnostics.emptyProofs > 0;
}

/** Mirrors {@link "./review.js".parseAcceptanceBlock}'s header regex, to demote a defective header so the
 *  parser walks past it to the repaired block appended below — otherwise a broken block would still be the only one the parser reaches. */
const ACCEPTANCE_HEADER_RE = /^(\s*#{0,6}\s*\**\s*acceptance(\s+criteria)?\b\s*\**\s*:?\s*\**\s*)$/i;

/** The suffix that demotes a superseded header. Prose, not a marker — nothing parses it. */
export const SUPERSEDED_HEADER_SUFFIX = " (superseded — unparseable, see the repaired block below)";

/**
 * W1-T3038 — RECOVER BEFORE YOU REPLACE.
 *
 * MEASURED: a body carrying FOUR real criteria written `- <claim> — unit test: <title>` went in and
 * ONE placeholder came out, silently. An em dash is not a separator, so each bullet parsed with an
 * empty proof, `bodyNeedsAcceptanceRepair` called the body defective, and the fallback displaced
 * the author's own criteria — which were one character from correct the whole time.
 *
 * `emDashSeparatedProof` (body-repair.ts, W1-T3028) already knew how to split those bullets; it
 * fed the DIAGNOSER and nothing else, so the REPAIR could not use what the report had worked out.
 * That is the gap this closes: the fallback is for a body with nothing recoverable in it, not for
 * one whose criteria merely need their separator fixed.
 *
 * Returns `[]` when nothing is recoverable, which is exactly when the fallback is right.
 */
export function recoverableCriteria(body: string): AcceptanceCriterion[] {
  const out: AcceptanceCriterion[] = [];
  for (const raw of body.split("\n")) {
    const m = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(raw);
    if (!m) continue;
    const split = emDashSeparatedProof(m[1]);
    if (split) out.push({ claim: split.claim, proof: split.proof });
  }
  return out;
}

export function ensureJudgeableBody(body: string, fallbackCriteria: AcceptanceCriterion[]): string {
  if (!bodyNeedsAcceptanceRepair(body)) return body;
  // The author's own criteria, where they are recoverable, ALWAYS beat a generic fallback: they say
  // something about this diff and the fallback says only that the body parses.
  const recovered = recoverableCriteria(body);
  const block = renderAcceptanceBlock(recovered.length > 0 ? recovered : fallbackCriteria);
  // Demote only the first matching header; a body with no header is unaffected.
  let demoted = false;
  const lines = body.split("\n").map((line) => {
    if (demoted) return line;
    const m = ACCEPTANCE_HEADER_RE.exec(line);
    if (!m) return line;
    demoted = true;
    return `${m[1].replace(/\s+$/, "")}${SUPERSEDED_HEADER_SUFFIX}`;
  });
  const trimmed = lines.join("\n").replace(/\s*$/, "");
  return trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

// ── 3. Filing-PR Acceptance auto-authorship ──────────────────────────────────────────────────

/**
 * Acceptance criteria about the filing itself, for a PR that files one or more new plan tasks. A filing PR
 * cannot yet cite the filed task's own acceptance criteria — the task does not exist in the working checkout
 * `remudero-review` resolves against until the PR is opened — so this substitutes a claim about the filing
 * being well-formed, provable by the gate that already runs on every PR (commitlint, `plan-index:check`).
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
  /** Free-text extra body, wrapped via `shapeCommitMessage` — never spliced in raw (a raw stamp line once
   *  blew `body-max-line-length`, PR #387). Paragraphs separated by `"\n\n"`. */
  extraBody?: string;
  /** Task id for the `Remudero-Task:` trailer. Omit for a plan-FILING PR (file header's invariant). */
  taskId?: string;
  /** W1-T2807: what a reader can do about this commit ({@link PlanPrCommitOpts.consequence} says why). Both
   *  optional; omitting either leaves the output byte-identical, and an explicit `null` records "nothing to do" rather than silence. */
  whatToDo?: OperatorMessageSlot;
  consequence?: OperatorMessageSlot;
}

/** Assemble a commit message that is guaranteed commitlint-clean (header/body limits all via
 *  `shapeCommitMessage`, never reimplemented here) and carries a `Remudero-Task:` trailer only when `taskId` is given. */
export function buildPlanPrCommitMessage(opts: PlanPrCommitOpts): string {
  const { scope, subject, extraBody, taskId } = opts;
  // The narrative slots render as ordinary body paragraphs, above the trailer, so shapeCommitMessage wraps
  // them like any other body text. Both omitted renders nothing.
  const narrative = renderCommitNarrativeParagraphs({
    prefix: `chore(${scope})`,
    subject,
    whatToDo: opts.whatToDo,
    consequence: opts.consequence,
  });
  const body = [extraBody ?? "", narrative].filter((part) => part.trim() !== "").join("\n\n");
  const shaped = shapeCommitMessage(`chore(${scope})`, subject, body);
  if (!taskId) return shaped.message;
  return `${shaped.message.replace(/\n+$/, "")}\n\nRemudero-Task: ${taskId}\n`;
}

// ── 5. PR-body assembly ───────────────────────────────────────────────────────────────────

/** The heading {@link renderChangedFilesBlock} emits and {@link changedFilesBlockIsStale} reads. One
 *  constant so the writer and the reader can never drift — the two-enumerator defect this repo has paid for elsewhere. */
export const CHANGED_FILES_HEADING = "## Changed files";

/**
 * The "## Changed files" section, generated from the diff rather than restated in prose — a rendered block
 * cannot contradict the diff, because it IS the diff. A hand-written claim like "exactly N files" went stale
 * the moment a later commit widened the diff, the same failure {@link renderAcceptanceBlock} already solved
 * for hand-written acceptance blocks by generating the section instead. Why: the staleness incidents this
 * reproduces — docs/forensics/plan-pr-emitter.md
 * Emits no count: a count is a second assertion about the same list, and the two drift apart.
 */
export function renderChangedFilesBlock(files: readonly string[]): string {
  const sorted = [...files].map((f) => f.trim()).filter(Boolean).sort();
  if (sorted.length === 0) {
    // An empty section reads as an omission; say explicitly that nothing changed.
    return `${CHANGED_FILES_HEADING}\n\n(none — this changeset adds, removes and modifies no files.)`;
  }
  return [CHANGED_FILES_HEADING, "", ...sorted.map((f) => `- \`${f}\``)].join("\n");
}

/**
 * Does a body carry a rendered changed-files block that no longer matches the diff it names — one left
 * behind by a later commit, or hand-edited to disagree? Returns the two differences rather than a bare
 * boolean, since "which files" is the whole remedy.
 * A body with no block at all is absent, not stale: both arrays come back empty, and
 * {@link hasChangedFilesBlock} tells the caller which case it is.
 */
export function changedFilesBlockDrift(
  body: string,
  actual: readonly string[],
): { missing: string[]; extra: string[] } {
  const listed = listedChangedFiles(body);
  if (listed === undefined) return { missing: [], extra: [] };
  const a = new Set([...actual].map((f) => f.trim()).filter(Boolean));
  const l = new Set(listed);
  return {
    missing: [...a].filter((f) => !l.has(f)).sort(),
    extra: [...l].filter((f) => !a.has(f)).sort(),
  };
}

/** True iff `body` carries a rendered changed-files block at all. */
export function hasChangedFilesBlock(body: string): boolean {
  return listedChangedFiles(body) !== undefined;
}

/** The paths a rendered block lists, or undefined when the body carries no block. Reads only the backticked
 *  bullets the renderer emits, so ordinary prose mentioning a path is never mistaken for the block itself. */
function listedChangedFiles(body: string): string[] | undefined {
  const i = (body ?? "").indexOf(CHANGED_FILES_HEADING);
  if (i < 0) return undefined;
  const rest = body.slice(i + CHANGED_FILES_HEADING.length);
  const end = rest.search(/\n#{1,6} /);
  const section = end < 0 ? rest : rest.slice(0, end);
  const out: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^- `([^`]+)`\s*$/.exec(line.trim());
    if (m) out.push(m[1].trim());
  }
  return out;
}
export interface PlanPrBodyOpts {
  /** Free-text intro prose (may itself be multi-line/multi-paragraph). */
  intro: string;
  /** Rendered via {@link renderAcceptanceBlock} — always the last thing before an optional trailer, so the
   *  block's bullets are never interrupted. */
  criteria: AcceptanceCriterion[];
  /** Omit for a plan-FILING PR — see the file header's invariant. */
  taskId?: string;
  /** The diff this body describes, rendered via {@link renderChangedFilesBlock} instead of restated in
   *  prose. Optional; omitting it leaves the output byte-identical. */
  changedFiles?: readonly string[];
  /** W1-T2807: who is speaking, what the reviewer can do, and why it matters. All optional and independent;
   *  omitting any leaves the body byte-identical, and an explicit `null` on `whatToDo` records "nothing to do" rather than silence. */
  speaker?: string;
  whatToDo?: OperatorMessageSlot;
  consequence?: OperatorMessageSlot;
}

/**
 * Assemble a PR body: intro prose, a blank line, a rendered (always judgeable) Acceptance block, and an
 * optional `Remudero-Task:` trailer.
 */
export function buildPlanPrBody(opts: PlanPrBodyOpts): string {
  const { intro, criteria, taskId, changedFiles } = opts;
  // Order is load-bearing: the changed-files block sits above the Acceptance block, and the narrative slots
  // render inside the intro region, above both. Nothing goes below the acceptance bullets — one interposed
  // line breaks parseAcceptanceBlock and fails closed.
  const narrative = renderPrNarrativeParagraphs(opts);
  const parts = [[intro.trim(), narrative].filter((part) => part !== "").join("\n\n")];
  if (changedFiles !== undefined) parts.push("", renderChangedFilesBlock(changedFiles));
  parts.push("", renderAcceptanceBlock(criteria));
  if (taskId) parts.push("", `Remudero-Task: ${taskId}`);
  return `${parts.join("\n")}\n`;
}

/** The PR body's narrative slots as intro paragraphs, in the standard's order. `""` when neither carries
 *  text — which is what keeps an existing caller's body byte-identical. */
export function renderPrNarrativeParagraphs(opts: PlanPrBodyOpts): string {
  const paragraphs: string[] = [];
  if (typeof opts.consequence === "string" && opts.consequence.trim() !== "") {
    paragraphs.push(opts.consequence.trim());
  }
  if (typeof opts.whatToDo === "string" && opts.whatToDo.trim() !== "") {
    paragraphs.push(opts.whatToDo.trim());
  }
  return paragraphs.join("\n\n");
}

// ── 6. Plan-index regeneration (the #287 fix, mirrors lib/orientation.ts) ───────────────────

const PLAN_INDEX_REL_PATH = "plan/plan-index.json";
const PLAN_INDEX_COMMIT_MESSAGE = "chore(plan): regenerate plan/plan-index.json";

export interface RegeneratePlanIndexOpts {
  /** The git worktree containing MASTER-PLAN.md, plan/plan-index.json, and the generator script. */
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

/** Regenerate `plan/plan-index.json` in `worktreePath` via the real `scripts/generate-plan-index.mjs`
 *  (never reimplementing its parsing), and report whether the content changed. Does not `git add`/commit
 *  — `rmd approve`'s own `git add -A` sweeps it up; see {@link regeneratePlanIndexAndCommit} for the commit-if-changed wrapper `rmd retro` uses instead. */
export function regeneratePlanIndexFile(opts: RegeneratePlanIndexOpts): RegeneratePlanIndexResult {
  const { worktreePath, sourceRelPath = "MASTER-PLAN.md", outRelPath = PLAN_INDEX_REL_PATH } = opts;
  let scriptPath = join(worktreePath, "scripts", "generate-plan-index.mjs");
  // Resolve symlinks: the script's own "run as main" guard compares a resolved URL against argv[1]'s
  // literal path, so an unresolved scriptPath under a symlinked worktree root (e.g. macOS's /tmp)
  // Why: never matches, and main() silently writes nothing — the #287 incident this caused, docs/forensics/plan-pr-emitter.md
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
 * Regenerate (via {@link regeneratePlanIndexFile}), `git add`, and — only if the content changed from
 * what's committed — commit it, mirroring {@link "./orientation.js".regenerateOrientation}'s
 * write/add/diff-cached-quiet/commit-if-changed discipline. `rmd retro` calls this as its own separate
 * commit; `rmd approve` does not need it.
 */
export function regeneratePlanIndexAndCommit(opts: RegeneratePlanIndexOpts): RegeneratePlanIndexAndCommitResult {
  const { worktreePath } = opts;
  const { relPath } = regeneratePlanIndexFile(opts);
  execFileSync("git", ["-C", worktreePath, "add", relPath]);
  try {
    execFileSync("git", ["-C", worktreePath, "diff", "--cached", "--quiet"]);
    // exit 0: nothing staged, content unchanged from HEAD.
    return { relPath, committed: false };
  } catch {
    // Non-zero: staged changes exist; commit them as their own, clearly-labeled commit.
    execFileSync("git", ["-C", worktreePath, "commit", "-m", PLAN_INDEX_COMMIT_MESSAGE]);
    const diff = execFileSync("git", ["-C", worktreePath, "show", "--stat=200", "-p", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    return { relPath, committed: true, diff };
  }
}

// ── 7. Ratification PR — REST create + resumption probe (W1-T903) ───────────────────────────
// `gh pr create` is GraphQL: an exhausted GraphQL budget once stranded an already-pushed ratification
// branch with no PR, and a naive re-run pushed a second branch instead of finishing the first. These two
// primitives are a pure REST transport swap at that one site, reusing the same {@link GhApiFetcher} `fetchOpenPrsRest` already takes.

/** `gh api --method POST repos/{owner}/{repo}/pulls` argv — the REST create call. */
export function ratifyPrCreateRestArgs(owner: string, repo: string, opts: { title: string; body: string; head: string; base: string }): string[] {
  return ["api", "--method", "POST", `repos/${owner}/${repo}/pulls`, "-f", `title=${opts.title}`, "-f", `body=${opts.body}`, "-f", `head=${opts.head}`, "-f", `base=${opts.base}`];
}

/** A ratification PR reference — `number` and `html_url` are both present on the create response and the
 *  list-by-head probe response below, so neither caller needs a second call. */
export interface RatifyPrRef {
  prUrl: string;
  prNumber: number;
}

/** Open the ratification PR over REST. Throws on a malformed/absent response — a create that produced no
 *  usable reference must fail loud, not silently report success. */
export function createPlanPrRest(fetch: GhApiFetcher, owner: string, repo: string, opts: { title: string; body: string; head: string; base: string }): RatifyPrRef {
  const row = fetch(ratifyPrCreateRestArgs(owner, repo, opts)) as { html_url?: string; number?: number };
  if (!row?.html_url || typeof row.number !== "number") {
    throw new Error("rmd approve: `gh api ... pulls` (POST) produced no html_url/number");
  }
  return { prUrl: row.html_url, prNumber: row.number };
}

/** `gh api repos/{owner}/{repo}/pulls?head=...` argv, filtered to one head branch — the same REST surface
 *  {@link "./open-prs-rest.js".fetchOpenPrsRest} reads, never `gh pr list` (GraphQL). `state=open`: a
 *  stranded prior attempt's PR, if any, is still open moments later. */
export function ratifyPrProbeRestArgs(owner: string, repo: string, headBranch: string): string[] {
  return ["api", `repos/${owner}/${repo}/pulls?head=${owner}:${headBranch}&state=open`];
}

/**
 * The resumption probe: whether a PR already exists for `headBranch`, asked before creating one — covers a
 * prior run whose create succeeded server-side but never returned a reference. `undefined` means none
 * found; a probe failure throws, rather than risk a duplicate PR.
 */
export function probeExistingPlanPr(fetch: GhApiFetcher, owner: string, repo: string, headBranch: string): RatifyPrRef | undefined {
  const rows = fetch(ratifyPrProbeRestArgs(owner, repo, headBranch)) as Array<{ html_url?: string; number?: number }>;
  const row = rows?.[0];
  if (!row?.html_url || typeof row.number !== "number") return undefined;
  return { prUrl: row.html_url, prNumber: row.number };
}

// ── 8. Retro changeset-claim reconciliation (W1-T911) ───────────────────────────────────────
// The retro worker opens a PR body whose changeset claim is true at that instant; the harness then commits
// ORIENTATION.md and plan-index.json into the same PR afterward, widening the diff past what the body
// already described, and `bodyContradictsDiff` (review.ts) correctly refuses the now-stale claim. Why: the
// four incidents this reconciler exists to stop — docs/forensics/plan-pr-emitter.md
// A pure reconciler — no git, no network, no I/O — repairing only the two claim shapes `bodyContradictsDiff`
// keys on: (a) a stated file count, rewritten as an enumeration with no count at all (see
// {@link retroChangesetSentence}); (b) a "no <path>" denial the diff actually refutes, dropped rather than
// rewritten. A denial the diff does not refute survives untouched.
// Deliberately not built on `bodyContradictsDiff`'s own regexes, so the two are held together by a falsifier
// (test/retro-changeset-claim.test.ts) instead of a shared symbol that could drift.

/** Matches the count-shaped claim `bodyContradictsDiff`'s arm (a) reads, including an optional colon-led
 *  enumeration ("exactly one file: MASTER-PLAN.md"). Built fresh per call: a `/g` regex carries `lastIndex`
 *  between calls, so a shared instance answers `.test()` wrong twice. */
function changesetCountClaimRe(): RegExp {
  return /\bexactly\s+\w+\s+files?\b(?:\s*:\s*[^\s,]+(?:\s*,\s*[^\s,]+)*)?/gi;
}

/**
 * Render the changeset as paths, never a count — a count is what failed four PRs, and a corrected count is
 * the same defect with a new number. Sorted for a stable sentence.
 */
export function retroChangesetSentence(paths: readonly string[]): string {
  const sorted = [...paths].sort();
  if (sorted.length === 0) return "no files";
  if (sorted.length === 1) return sorted[0];
  return `${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}`;
}

/** Arm (a): replace every count-shaped claim in `body` with {@link retroChangesetSentence}'s enumeration.
 *  `undefined` when there is nothing to repair. */
function reconcileChangesetCountClaim(body: string, paths: readonly string[]): string | undefined {
  if (!changesetCountClaimRe().test(body)) return undefined;
  return body.replace(changesetCountClaimRe(), retroChangesetSentence(paths));
}

/** Matches a `no <path>` denial the way `bodyContradictsDiff`'s arm (b) does. */
const NO_PATH_CLAIM_RE = /\bno\s+([A-Za-z0-9_./-]+)/gi;

/** A path-shaped token (contains `.` or `/`), so "no bugs"/"no issues" never match — mirrored from
 *  `bodyContradictsDiff`'s arm (b), not imported (see the module comment above). */
function looksLikeChangesetPath(token: string): boolean {
  return /[./]/.test(token);
}

/** Does `file` fall under the claimed-absent `path` (an exact file, or a directory prefix)? */
function fileUnderClaimedPath(file: string, path: string): boolean {
  const normalized = path.replace(/\/$/, "");
  return file === normalized || file.startsWith(`${normalized}/`);
}

/** Tidy the punctuation a dropped `no <path>` clause leaves behind — dangling or doubled commas, doubled
 *  spacing. Never touches a newline: a paragraph break is structural. */
function cleanupDroppedNoPathClauses(text: string): string {
  return text
    .replace(/,([ \t]*)(?=[.!?]|\n|$)/g, "$1")
    .replace(/(^|[.!?\n][ \t]*),([ \t]*)/g, "$1$2")
    .replace(/,([ \t]*),/g, ",$1")
    .replace(/[ \t]{2,}/g, " ");
}

/** Arm (b): drop every `no <path>` denial `paths` refutes; a denial it does not refute survives untouched.
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
 * The pure reconciler. Given a retro PR body and the real changeset it carries, returns the corrected body,
 * or `undefined` when it already agrees with `paths` — so a caller can tell "healthy" from "rewritten"
 * without diffing strings. Runs arm (a) before arm (b), since (a)'s replacement sentence can introduce new
 * prose for (b) to read, never the reverse.
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
