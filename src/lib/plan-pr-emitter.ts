/**
 * The shared gate-contract module for every machine flow that opens a plan PR (W1-T136: `rmd retro` and
 * `rmd approve`). Two flows once reinvented commit and PR-body hygiene independently and both tripped the
 * same CI gate stack — commitlint and the review gate's fail-closed-on-no-Acceptance-
 * block rule. Why: the three incidents that forced this module into existence — docs/forensics/plan-pr-emitter.md
 * Six primitives: {@link renderAcceptanceBlock} renders a judgeable Acceptance block; {@link ensureJudgeableBody}
 * repairs one that parses defectively; {@link filingAcceptanceCriteria} writes acceptance for a PR that files a
 * task rather than building it; {@link buildPlanPrCommitMessage} / {@link buildPlanPrBody} assemble a gate-clean
 * commit and PR body.
 * INVARIANT: a plan-FILING PR — one adding a task to `plan/tasks.yaml` that did not exist on `origin/main` —
 * must never carry a `Remudero-Task: <id>` trailer. `findMergedByTrailer` (lib/status.ts) marks the trailered
 * task DONE on merge, and a filing PR only adds the task, it does not build it. Every function below that
 * emits a trailer takes the task id as an optional argument for exactly this reason: omit it to file, supply it to implement.
 * FALSIFIER: test/plan-pr-emitter.test.ts and the acceptance-block/retro-acceptance test suites.
 */

import type { AcceptanceCriterion } from "./plan.js";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { acceptanceBlockDiagnostics, acceptanceHeaderLine, parseAcceptanceBlock, parseWhitelistedProof } from "./review.js";
import { emDashSeparatedProof, refuseNonDiscriminatingCriteria } from "./body-repair.js";
import {
  checkCommitMessage,
  renderCommitNarrativeParagraphs,
  shapeCommitMessage,
} from "./commit-message.js";
import {
  type OperatorMessageSlot,
} from "./operator-message.js";
import type { GhApiFetcher } from "./open-prs-rest.js";
import { RMD_TMP_PREFIX } from "./tmp.js";
import { RmdError } from "./errors.js";
import { isTaskShardName } from "./task-shard-name.js";

const PLAN_TASK_SHARD_PREFIX = ["plan", "tasks.d"].join("/") + "/";

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
  return replaceAcceptanceBlock(body, fallbackCriteria);
}

/**
 * The unconditional half of {@link ensureJudgeableBody} — demote any existing header and append a
 * fresh block, with NO `bodyNeedsAcceptanceRepair` guard. Extracted (W1-T3066 class) so a caller that
 * has ALREADY decided repair is warranted for a reason `bodyNeedsAcceptanceRepair` cannot see — e.g.
 * `repairRetroAcceptanceBlock` (run-task.ts) detecting that a body's only criterion IS the generic
 * PR-open-time fallback, which parses fine and carries a non-empty proof (so `bodyNeedsAcceptanceRepair`
 * calls it healthy) but whose proof is stale by construction and REFUSED by `proof-discrimination` —
 * can still replace it, rather than being silently no-op'd by `ensureJudgeableBody`'s own guard.
 */
export function replaceAcceptanceBlock(body: string, fallbackCriteria: AcceptanceCriterion[]): string {
  // The author's own criteria, where they are recoverable, ALWAYS beat a generic fallback: they say
  // something about this diff and the fallback says only that the body parses.
  const recovered = recoverableCriteria(body);
  const block = renderAcceptanceBlock(recovered.length > 0 ? recovered : fallbackCriteria);
  // Demote the header the parser reads, so it walks past it to the repaired block appended below —
  // otherwise a broken block would still be the only one it reaches. THE SAME fence-aware walker
  // (W1-T5621): a fenced example header is left as written; a body with no header is unaffected.
  const lines = body.split("\n");
  const header = acceptanceHeaderLine(lines);
  if (header >= 0) lines[header] = `${lines[header].replace(/\s+$/, "")}${SUPERSEDED_HEADER_SUFFIX}`;
  const trimmed = lines.join("\n").replace(/\s*$/, "");
  return trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

// ── 3. Filing-PR Acceptance auto-authorship ──────────────────────────────────────────────────

/**
 * Acceptance criteria about the filing itself, for a PR that files one or more new plan tasks. A filing PR
 * cannot yet cite the filed task's own acceptance criteria — the task does not exist in the working checkout
 * `remudero-review` resolves against until the PR is opened — so this substitutes a claim about the filing
 * being well-formed, provable by the gate that already runs on every PR (commitlint, lint-plan).
 */
export function filingAcceptanceCriteria(taskIds: string[], files: string[]): AcceptanceCriterion[] {
  if (taskIds.length === 0) {
    throw new Error("filingAcceptanceCriteria: at least one filed task id is required");
  }
  // W1-T3383b — THE PROOF MUST EXECUTE, OR THE OPERATOR'S ONE-BIT APPROVE CANNOT PRODUCE A
  // MERGEABLE PR. This function used to emit ONE criterion whose proof was PROSE ("this diff's only
  // files are …; commitlint and lint-plan both pass"), which carries no runnable dialect
  // prefix. `acceptance-author-gate` refuses exactly that with `proof-shape`: the verdict caps at
  // proof_exec 0/1 and cannot arm. MEASURED 2026-09-11: every open ratification PR on the board was
  // refused this way — #5122, #5123, #5124, #5125 — so `rmd approve` was structurally incapable of
  // opening a PR that could land, and each one had to be repaired by hand.
  //
  // A `grep:` ON THE FILED SHARD DOES RESOLVE, and the header's old objection does not apply to it.
  // That objection — "a filing PR cannot cite the filed task's own acceptance criteria, the task
  // does not exist in the checkout review resolves against" — is about citing the task's OWN
  // criteria. This cites the shard FILE, which exists on the PR head that review reads.
  const shardFor = (taskId: string): string | undefined =>
    files.find(
      (f) =>
        f.startsWith(PLAN_TASK_SHARD_PREFIX) &&
        isTaskShardName(f.slice(PLAN_TASK_SHARD_PREFIX.length), taskId),
    );
  const criteria: AcceptanceCriterion[] = [];
  for (const taskId of taskIds) {
    const shard = shardFor(taskId);
    if (shard === undefined) continue;
    criteria.push({
      claim: `${taskId} is filed as a well-formed plan task shard by this PR, not (yet) implemented`,
      // `id: <taskId>` rather than the bare id: the id also appears in the FILENAME, and a pattern
      // that matched the path would pass against a file holding no such record.
      proof: `grep: id: ${taskId} in ${shard}`,
    });
  }
  // NO SHARD PAIRED WITH ANY ID — a filing shape this function has not seen. Keep the legacy prose
  // criterion rather than inventing a path: an unexecutable proof caps the verdict, while a WRONG
  // one would fail it outright, and capping is the direction this repo already takes on ignorance.
  if (criteria.length === 0) {
    return [
      {
        claim: `${taskIds.join("/")} filed as well-formed plan task shard(s), not (yet) implemented`,
        proof: `this diff's only files are ${files.join(", ")}; commitlint and lint-plan both pass on the resulting commit`,
      },
    ];
  }
  return criteria;
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

/**
 * W1-T3362 — does this diff CONTRIBUTE the task's own plan shard for `taskId`?
 * That is exactly the refusal condition of the shipped `files-and-credits-the-same-task` gate
 * (`filingSelfCreditCheck`, lib/review.ts): a PR that introduces a task's record cannot be that task's
 * implementation, so a `Remudero-Task: <taskId>` trailer on it is a self-credit. Path-only, like
 * {@link filingAcceptanceCriteria}'s shard lookup, so producer and gate agree on what "the shard" is.
 */
export function diffContributesTaskShard(taskId: string, files: readonly string[]): boolean {
  return files.some(
    (f) => f.startsWith(PLAN_TASK_SHARD_PREFIX) && isTaskShardName(f.slice(PLAN_TASK_SHARD_PREFIX.length), taskId),
  );
}

export interface PlanPrBodyOpts {
  /** Free-text intro prose (may itself be multi-line/multi-paragraph). */
  intro: string;
  /** Rendered via {@link renderAcceptanceBlock} — always the last thing before an optional trailer, so the
   *  block's bullets are never interrupted. */
  criteria: AcceptanceCriterion[];
  /** Omit for a plan-FILING PR — see the file header's invariant. W1-T3362: a `taskId` whose shard this same
   *  diff contributes (see `addedFiles` / `changedFiles`) is dropped rather than emitted, since the shipped gate
   *  refuses that self-credit — the producer must not write a body its own gate rejects. */
  taskId?: string;
  /** The diff this body describes, rendered via {@link renderChangedFilesBlock} instead of restated in
   *  prose. Optional; omitting it leaves the output byte-identical unless `taskId` names a shard listed here. */
  changedFiles?: readonly string[];
  /** W1-T3362: the paths the diff ADDS, when the caller knows them apart from modifications — a plan-only PR
   *  that merely EDITS an existing shard still legitimately credits it. Defaults to `changedFiles`. */
  addedFiles?: readonly string[];
  /** W1-T2807: who is speaking, what the reviewer can do, and why it matters. All optional and independent;
   *  omitting any leaves the body byte-identical, and an explicit `null` on `whatToDo` records "nothing to do" rather than silence. */
  speaker?: string;
  whatToDo?: OperatorMessageSlot;
  consequence?: OperatorMessageSlot;
  /** The fork point to compare with this checkout; the default is `git merge-base origin/main HEAD`. */
  baseRef?: string;
  /** `rmd check-proof --base`'s exit status. Injected only to test the author-time decision. */
  proofCheck?: (proof: string, baseRef: string) => number | null;
  /** Checkout whose HEAD and `origin/main` describe the body being emitted (usually its author worktree). */
  proofCwd?: string;
}

function authorBaseRef(cwd: string): string {
  const result = spawnSync("git", ["merge-base", "origin/main", "HEAD"], { cwd, encoding: "utf8" });
  const base = result.stdout?.trim();
  if (result.status !== 0 || !base) {
    throw new Error(`body emission refused: cannot resolve the merge base for acceptance proofs; ask for a human ruling (checkout: ${cwd})`);
  }
  return base;
}

function checkProofAtAuthorTime(proof: string, baseRef: string, cwd: string): number | null {
  // A consumer checkout has no tsx: use rmd's own launcher, but inspect the consumer's HEAD/base.
  const rmdBin = fileURLToPath(new URL("../../bin/rmd", import.meta.url));
  const result = spawnSync(
    rmdBin,
    ["check-proof", proof, "--base", baseRef],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, RMD_SELF_SYNC_DONE: "1" },
    },
  );
  return result.status;
}

/**
 * Assemble a PR body: intro prose, a blank line, a rendered (always judgeable) Acceptance block, and an
 * optional `Remudero-Task:` trailer.
 */
export function buildPlanPrBody(opts: PlanPrBodyOpts): string {
  const { intro, criteria, taskId, changedFiles } = opts;
  // Execute at base rather than guessing from claim wording. Keep synthetic legacy inputs for the
  // other author gate, but never emit a runnable stale or zero-match proof.
  if (opts.proofCheck || criteria.some((c) => parseWhitelistedProof(c.proof.trim()) !== null)) {
    const proofCwd = opts.proofCwd ?? process.cwd();
    const baseRef = opts.baseRef ?? authorBaseRef(proofCwd);
    refuseNonDiscriminatingCriteria(criteria, (proof) =>
      opts.proofCheck ? opts.proofCheck(proof, baseRef) : checkProofAtAuthorTime(proof, baseRef, proofCwd),
    );
  }
  // W1-T3362: never credit a task whose record this same diff adds — `filingSelfCreditCheck` refuses it.
  const selfCredit = taskId !== undefined && diffContributesTaskShard(taskId, opts.addedFiles ?? changedFiles ?? []);
  // Order is load-bearing: the changed-files block sits above the Acceptance block, and the narrative slots
  // render inside the intro region, above both. Nothing goes below the acceptance bullets — one interposed
  // line breaks parseAcceptanceBlock and fails closed.
  const narrative = renderPrNarrativeParagraphs(opts);
  const parts = [[intro.trim(), narrative].filter((part) => part !== "").join("\n\n")];
  if (changedFiles !== undefined) parts.push("", renderChangedFilesBlock(changedFiles));
  parts.push("", renderAcceptanceBlock(criteria));
  if (taskId && !selfCredit) parts.push("", `Remudero-Task: ${taskId}`);
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

// ── 6. Ratification PR — REST create + resumption probe (W1-T903) ───────────────────────────
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

// ── 7. Plan-PR preflight (W1-T5348) ──────────────────────────────────────────────────────────
// MEASURED 09-25..10-02: 31 machine-lane plan-only PRs went red for 67.2 red-hours; the 8 generator template
// defects among them (#7946 a proof grepping a record id already on base, #7861 a declared path that did not exist,
// #8725 a 105-character title) were each detectable offline before the push. W1-T4901's pre-push hook does not
// reach them: feedback-landing pushes a `commit-tree` sha from a checkout whose HEAD is not that commit, and the
// hook runs only the plan lint. So every machine plan-PR producer asks {@link planPrPreflight} about the EXACT tree
// it is about to push, and a red answer refuses the push. A check that cannot run is reported, never refusing —
// the same rule the hook keeps with its exit 2. Operator and session PRs never pass through here.

export type PlanPrPreflightCheck = "tree" | "lint-plan" | "task-id-existence" | "proof-discrimination" | "pr-title" | "shard-census";
export interface PlanPrPreflightFinding {
  check: PlanPrPreflightCheck;
  firstLine: string;
}
export interface PlanPrPreflightResult {
  ok: boolean;
  failures: PlanPrPreflightFinding[];
  unreadable: PlanPrPreflightFinding[];
}
/** One check's reading: 0 green, 1 red, anything else (null included) could not run. */
export interface PlanPrPreflightReading {
  status: number | null;
  output: string;
}

const LINT_PLAN_SCRIPT = "scripts/lint-plan-precheck.mjs";
const TASK_ID_SCRIPT = "scripts/task-id-existence-check.mjs";
const SHARD_CENSUS_TEST = "test/every-shard-on-main-is-lintable.test.ts";
const RUN_TASK_ENTRY = "src/run-task.ts";
/** `--require-open-prs` refuses an unreadable open-PR list or base; that is a check that could not run, not a red. */
export const TASK_ID_UNREADABLE_RE = /REQUIRED \(--require-open-prs\) but|could not read declared plan ids at base/;
/** check-proof exits that make a PR-body proof red (fail, refused, no match, passes at base too). */
const RED_BODY_PROOF_EXIT: Record<number, string> = { 1: "fails on this tree", 2: "does not parse as a proof", 3: "matches no tests", 5: "passes at origin/main too" };
const CHECK_PROOF_STALE_EXIT = 5;

const LINT_PLAN_ARGV = [LINT_PLAN_SCRIPT];
const TASK_ID_ARGV = [TASK_ID_SCRIPT, "--base", "origin/main", "--require-open-prs"];
const taskIdArgv = (headRef?: string): string[] => (headRef ? [...TASK_ID_ARGV, "--head-ref", headRef] : TASK_ID_ARGV);
const SHARD_CENSUS_ARGV = ["--import", "tsx", "--test", "--test-reporter=tap", SHARD_CENSUS_TEST];
const checkProofArgv = (proof: string): string[] => ["--import", "tsx", RUN_TASK_ENTRY, "check-proof", proof, "--base", "origin/main"];

function inTreeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, RMD_SELF_SYNC_DONE: "1" };
  delete env.NODE_TEST_CONTEXT; // a nested `node --test` under a test runner otherwise reports to the parent, not to stdout
  return env;
}
const absentFromTree = (relPath: string): PlanPrPreflightReading => ({ status: null, output: `${relPath} is absent from the tree` });
const taskIdReading = (r: PlanPrPreflightReading): PlanPrPreflightReading =>
  r.status === 1 && TASK_ID_UNREADABLE_RE.test(r.output) ? { ...r, status: null } : r;
const shardCensusReading = (r: PlanPrPreflightReading): PlanPrPreflightReading =>
  r.status === 1 && !/^# fail [1-9]/m.test(r.output) ? { ...r, status: null } : r; // no `# fail N`: a load error, not a result

/** Run a script the tree itself carries; a tree without it is a check that cannot run. */
function runInTree(cwd: string, relPath: string, argv: string[]): PlanPrPreflightReading {
  if (!existsSync(join(cwd, relPath))) return absentFromTree(relPath);
  const r = spawnSync(process.execPath, argv, { cwd, encoding: "utf8", maxBuffer: 1 << 26, env: inTreeEnv() });
  return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

const execFileAsync = promisify(execFile);
/** One awaited child process, read as a {@link PlanPrPreflightReading}: `spawnSync`'s status, never its stall (W1-T5521). */
async function runChildAsync(file: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<PlanPrPreflightReading> {
  try {
    const r = await execFileAsync(file, args, { cwd, encoding: "utf8", maxBuffer: 1 << 26, env });
    return { status: 0, output: `${r.stdout}\n${r.stderr}` };
  } catch (e) {
    // A numeric code is a non-zero exit; a signal, spawn error or buffer cap is spawnSync's null (could not run).
    const err = e as { code?: unknown; stdout?: string; stderr?: string };
    return { status: typeof err.code === "number" ? err.code : null, output: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
  }
}
async function runInTreeAsync(cwd: string, relPath: string, argv: string[]): Promise<PlanPrPreflightReading> {
  if (!existsSync(join(cwd, relPath))) return absentFromTree(relPath);
  return runChildAsync(process.execPath, argv, cwd, inTreeEnv());
}

/** The four checks that shell out inside `cwd` (`checkProof` answers check-proof's exit), sync and awaited. */
const defaultPreflightChecks = {
  lintPlan: (cwd: string): PlanPrPreflightReading => runInTree(cwd, LINT_PLAN_SCRIPT, LINT_PLAN_ARGV),
  taskIdExistence: (cwd: string, headRef?: string): PlanPrPreflightReading => taskIdReading(runInTree(cwd, TASK_ID_SCRIPT, taskIdArgv(headRef))),
  shardCensus: (cwd: string): PlanPrPreflightReading => shardCensusReading(runInTree(cwd, SHARD_CENSUS_TEST, SHARD_CENSUS_ARGV)),
  checkProof: (cwd: string, proof: string): number | null => runInTree(cwd, RUN_TASK_ENTRY, checkProofArgv(proof)).status,
};
/** A test's stand-ins for any of {@link defaultPreflightChecks}. */
export type PlanPrPreflightChecks = Partial<typeof defaultPreflightChecks>;
const defaultPreflightChecksAsync = {
  lintPlan: (cwd: string): Promise<PlanPrPreflightReading> => runInTreeAsync(cwd, LINT_PLAN_SCRIPT, LINT_PLAN_ARGV),
  taskIdExistence: async (cwd: string, headRef?: string): Promise<PlanPrPreflightReading> =>
    taskIdReading(await runInTreeAsync(cwd, TASK_ID_SCRIPT, taskIdArgv(headRef))),
  shardCensus: async (cwd: string): Promise<PlanPrPreflightReading> => shardCensusReading(await runInTreeAsync(cwd, SHARD_CENSUS_TEST, SHARD_CENSUS_ARGV)),
  checkProof: async (cwd: string, proof: string): Promise<number | null> => (await runInTreeAsync(cwd, RUN_TASK_ENTRY, checkProofArgv(proof))).status,
};
export type PlanPrPreflightAsyncChecks = Partial<typeof defaultPreflightChecksAsync>;

function firstLineOf(output: string, status: number | null): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const diagnosticLine = /^(?:not ok |REFUSES\b|FAILED\b|✗|task-id-existence: FAILED\b|lint-plan-precheck:[^\n]*\bREFUSES\b)/;
  return lines.find((l) => diagnosticLine.test(l)) ?? lines[0] ?? `exited ${status}`;
}

function parsedShardProofs(text: string, opts?: { uniqueKeys: false }): string[] | undefined {
  let tasks: unknown;
  try {
    tasks = parseYaml(text, opts);
  } catch {
    // A head is the plan lint's to refuse, by name; a base (duplicate keys allowed: a W1-T5519 repair's) falls back to its bytes.
    return undefined;
  }
  const proofs: string[] = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const acceptance = (task as { acceptance?: unknown } | null)?.acceptance;
    for (const c of Array.isArray(acceptance) ? (acceptance as Array<{ proof?: unknown } | null>) : []) {
      if (typeof c?.proof === "string") proofs.push(c.proof.trim());
    }
  }
  return proofs;
}

function introducedProofs(headText: string, baseText: string | undefined): string[] {
  const head = parsedShardProofs(headText) ?? [];
  if (baseText === undefined) return head;
  const atBase = parsedShardProofs(baseText, { uniqueKeys: false });
  const preexisting = atBase === undefined ? (p: string) => baseText.includes(p) : (p: string) => atBase.includes(p);
  return head.filter((p) => !preexisting(p));
}
const CHANGED_SHARDS_ARGS = ["diff", "--name-only", "--diff-filter=AM", "origin/main...HEAD", "--", PLAN_TASK_SHARD_PREFIX];

/** Proofs this tree INTRODUCES in changed task shards (undefined when unreadable): a MERGED task's own proofs pass at
 *  base by construction, so a status edit to its shard (plan-reconcile) is not this PR's to discriminate. */
function changedShardProofs(cwd: string): string[] | undefined {
  const diff = spawnSync("git", CHANGED_SHARDS_ARGS, { cwd, encoding: "utf8" });
  if (diff.status !== 0) return undefined;
  const proofs: string[] = [];
  for (const rel of diff.stdout.split("\n").filter(Boolean)) {
    const base = spawnSync("git", ["show", `origin/main:${rel}`], { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
    proofs.push(...introducedProofs(readFileSync(join(cwd, rel), "utf8"), base.status === 0 ? base.stdout : undefined));
  }
  return proofs;
}
async function changedShardProofsAsync(cwd: string): Promise<string[] | undefined> {
  const diff = await runChildAsync("git", CHANGED_SHARDS_ARGS, cwd);
  if (diff.status !== 0) return undefined;
  const proofs: string[] = [];
  for (const rel of diff.output.split("\n").filter(Boolean)) {
    const base = await execFileAsync("git", ["show", `origin/main:${rel}`], { cwd, encoding: "utf8", maxBuffer: 1 << 26 }).then(
      (r) => r.stdout,
      () => undefined, // a failed `git show` (the shard is new on this tree) reads as no base, as the sync form's does
    );
    proofs.push(...introducedProofs(await readFile(join(cwd, rel), "utf8"), base));
  }
  return proofs;
}

const bodyProofsOf = (body: string): Set<string> => new Set(parseAcceptanceBlock(body).map((c) => c.proof.trim()).filter(Boolean));
function sortBodyProof(proof: string, status: number | null, red: string[], unreadable: string[]): void {
  if (status === 0) return;
  if (status !== null && RED_BODY_PROOF_EXIT[status]) red.push(`PR-body proof ${JSON.stringify(proof)} ${RED_BODY_PROOF_EXIT[status]}`);
  else unreadable.push(`PR-body proof ${JSON.stringify(proof)} could not be checked (check-proof exit ${status})`);
}
function sortShardProof(proof: string, status: number | null, red: string[]): void {
  if (status === CHECK_PROOF_STALE_EXIT) red.push(`shard proof ${JSON.stringify(proof)} passes at origin/main too`);
}
function discriminationReading(red: string[], unreadable: string[], shardProofList: string[] | undefined): PlanPrPreflightReading {
  if (shardProofList === undefined) unreadable.push("the changed task shards could not be read against origin/main");
  if (red.length > 0) return { status: 1, output: red.join("\n") };
  return unreadable.length > 0 ? { status: null, output: unreadable.join("\n") } : { status: 0, output: "" };
}

/** A PR-body proof is red on any non-pass; a shard's only when it passes at origin/main (a filed task fails at head). */
function proofDiscrimination(cwd: string, body: string, checkProof: (cwd: string, proof: string) => number | null): PlanPrPreflightReading {
  const red: string[] = [];
  const unreadable: string[] = [];
  for (const proof of bodyProofsOf(body)) sortBodyProof(proof, checkProof(cwd, proof), red, unreadable);
  const shardProofList = changedShardProofs(cwd);
  for (const proof of new Set(shardProofList ?? [])) sortShardProof(proof, checkProof(cwd, proof), red);
  return discriminationReading(red, unreadable, shardProofList);
}
async function proofDiscriminationAsync(
  cwd: string,
  body: string,
  checkProof: (cwd: string, proof: string) => Promise<number | null>,
): Promise<PlanPrPreflightReading> {
  const red: string[] = [];
  const unreadable: string[] = [];
  for (const proof of bodyProofsOf(body)) sortBodyProof(proof, await checkProof(cwd, proof), red, unreadable);
  const shardProofList = await changedShardProofsAsync(cwd);
  for (const proof of new Set(shardProofList ?? [])) sortShardProof(proof, await checkProof(cwd, proof), red);
  return discriminationReading(red, unreadable, shardProofList);
}

function preflightTally() {
  const failures: PlanPrPreflightFinding[] = [];
  const unreadable: PlanPrPreflightFinding[] = [];
  return {
    record(check: PlanPrPreflightCheck, reading: PlanPrPreflightReading): void {
      if (reading.status === 0) return;
      (reading.status === 1 ? failures : unreadable).push({ check, firstLine: firstLineOf(reading.output, reading.status) });
    },
    result: (): PlanPrPreflightResult => ({ ok: failures.length === 0, failures, unreadable }),
  };
}
const errorText = (e: unknown): string => String((e as Error)?.message ?? e);
function prTitleReading(title: string): PlanPrPreflightReading {
  const v = checkCommitMessage(title)[0];
  return v ? { status: 1, output: `${v.rule}: ${v.message}` } : { status: 0, output: "" };
}

/**
 * Would CI refuse this plan PR? Runs, inside `cwd` (a checkout whose HEAD is the commit about to be pushed and whose
 * `origin/main` is current): the plan lint on changed tasks (W1-T4901's `runLintPlanPrecheck`, never a retyped argv),
 * task-id-existence `--require-open-prs`, proof discrimination of the PR body and of each changed shard through
 * `rmd check-proof --base origin/main`, the PR-title lint, and the `every-shard-on-main-is-lintable` census.
 */
export function planPrPreflight(input: { cwd: string; title: string; body: string; headRef?: string }, checks: PlanPrPreflightChecks = {}): PlanPrPreflightResult {
  const d = { ...defaultPreflightChecks, ...checks };
  const tally = preflightTally();
  const read = (check: PlanPrPreflightCheck, run: () => PlanPrPreflightReading): void => {
    let reading: PlanPrPreflightReading;
    try {
      reading = run();
    } catch (e) {
      reading = { status: null, output: errorText(e) };
    }
    tally.record(check, reading);
  };
  read("lint-plan", () => d.lintPlan(input.cwd));
  read("task-id-existence", () => d.taskIdExistence(input.cwd, input.headRef));
  read("proof-discrimination", () => proofDiscrimination(input.cwd, input.body, d.checkProof));
  read("pr-title", () => prTitleReading(input.title));
  read("shard-census", () => d.shardCensus(input.cwd));
  return tally.result();
}

/** {@link planPrPreflight} as awaited child processes (W1-T5521): the same checks, order and verdict, off the loop. */
export async function planPrPreflightAsync(
  input: { cwd: string; title: string; body: string; headRef?: string },
  checks: PlanPrPreflightAsyncChecks = {},
): Promise<PlanPrPreflightResult> {
  const d = { ...defaultPreflightChecksAsync, ...checks };
  const tally = preflightTally();
  const read = async (check: PlanPrPreflightCheck, run: () => PlanPrPreflightReading | Promise<PlanPrPreflightReading>): Promise<void> => {
    let reading: PlanPrPreflightReading;
    try {
      reading = await run();
    } catch (e) {
      reading = { status: null, output: errorText(e) };
    }
    tally.record(check, reading);
  };
  await read("lint-plan", () => d.lintPlan(input.cwd));
  await read("task-id-existence", () => d.taskIdExistence(input.cwd, input.headRef));
  await read("proof-discrimination", () => proofDiscriminationAsync(input.cwd, input.body, d.checkProof));
  await read("pr-title", () => prTitleReading(input.title));
  await read("shard-census", () => d.shardCensus(input.cwd));
  return tally.result();
}

const unmaterialized = (commitSha: string, e: unknown): PlanPrPreflightFinding => ({
  check: "tree",
  firstLine: `${commitSha} could not be materialized: ${firstLineOf(errorText(e), null)}`,
});
function borrowNodeModules(repoDir: string, tree: string): void {
  if (existsSync(join(repoDir, "node_modules"))) symlinkSync(join(repoDir, "node_modules"), join(tree, "node_modules"));
}

/** {@link planPrPreflight} on a commit no checkout has at HEAD (feedback-landing's `commit-tree` sha): a detached
 *  worktree of it is materialized beside `repoDir`, borrows its node_modules, and is removed after. */
export function planPrPreflightAtCommit(
  repoDir: string,
  commitSha: string,
  pr: { title: string; body: string; headRef?: string },
  checks: PlanPrPreflightChecks = {},
): PlanPrPreflightResult {
  const parent = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}plan-pr-preflight-`));
  const tree = join(parent, "tree");
  try {
    execFileSync("git", ["-C", repoDir, "worktree", "add", "--detach", "--quiet", tree, commitSha], { stdio: "pipe" });
  } catch (e) {
    rmSync(parent, { recursive: true, force: true });
    return { ok: true, failures: [], unreadable: [unmaterialized(commitSha, e)] };
  }
  try {
    borrowNodeModules(repoDir, tree);
    return planPrPreflight({ cwd: tree, ...pr }, checks);
  } finally {
    spawnSync("git", ["-C", repoDir, "worktree", "remove", "--force", tree], { stdio: "pipe" });
    rmSync(parent, { recursive: true, force: true });
  }
}

/** {@link planPrPreflightAtCommit} for a daemon lane (W1-T5521): the tree's add and removal are awaited too. */
export async function planPrPreflightAtCommitAsync(
  repoDir: string,
  commitSha: string,
  pr: { title: string; body: string; headRef?: string },
  checks: PlanPrPreflightAsyncChecks = {},
): Promise<PlanPrPreflightResult> {
  const parent = await mkdtemp(join(tmpdir(), `${RMD_TMP_PREFIX}plan-pr-preflight-`));
  const tree = join(parent, "tree");
  try {
    await execFileAsync("git", ["-C", repoDir, "worktree", "add", "--detach", "--quiet", tree, commitSha]);
  } catch (e) {
    await rm(parent, { recursive: true, force: true });
    return { ok: true, failures: [], unreadable: [unmaterialized(commitSha, e)] };
  }
  try {
    borrowNodeModules(repoDir, tree);
    return await planPrPreflightAsync({ cwd: tree, ...pr }, checks);
  } finally {
    await runChildAsync("git", ["-C", repoDir, "worktree", "remove", "--force", tree], repoDir);
    await rm(parent, { recursive: true, force: true });
  }
}

/** Ledger a preflight verdict for one lane — `plan_pr.preflight_unreadable` when a check could not run,
 *  `plan_pr.preflight_refused { lane, branch, failures }` when one is red — and answer whether to push. */
export function planPrPreflightAllows(
  result: PlanPrPreflightResult,
  ctx: { lane: string; branch: string; log?: (step: string, extra?: Record<string, unknown>) => void },
): boolean {
  if (result.unreadable.length > 0) ctx.log?.("plan_pr.preflight_unreadable", { lane: ctx.lane, branch: ctx.branch, unreadable: result.unreadable });
  if (result.ok) return true;
  ctx.log?.("plan_pr.preflight_refused", { lane: ctx.lane, branch: ctx.branch, failures: result.failures });
  return false;
}

export class PlanPrPreflightRefusedError extends RmdError {
  constructor(readonly lane: string, readonly failures: PlanPrPreflightFinding[]) {
    super("plan", 1, `plan-PR preflight refused the ${lane} push: ${failures.map((f) => `[${f.check}] ${f.firstLine}`).join("; ")}`, { lane, failures });
    this.name = "PlanPrPreflightRefusedError";
  }
}

/** The throwing form of {@link planPrPreflightAllows}, for a lane whose not-landed outcome is a throw. */
export function refuseRedPlanPr(result: PlanPrPreflightResult, ctx: Parameters<typeof planPrPreflightAllows>[1]): void {
  if (!planPrPreflightAllows(result, ctx)) throw new PlanPrPreflightRefusedError(ctx.lane, result.failures);
}

// ── 8. Retro changeset-claim reconciliation (W1-T911) ───────────────────────────────────────
// The retro worker opens a PR body whose changeset claim is true at that instant; the harness then commits
// ORIENTATION.md into the same PR afterward, widening the diff past what the body
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
