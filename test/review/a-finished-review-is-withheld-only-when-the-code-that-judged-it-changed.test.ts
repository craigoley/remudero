/**
 * W1-T12824 — a finished review is withheld only when the code that judged it changed.
 *
 * Core ledger, 2026-11-14 06:45Z to 2026-11-15 06:45Z: 20 `review.post_refused` "materially behind" rows, all from the run
 * child. That path skipped the sweep's start check, so a merge to main during the review withheld the verdict at post time.
 * Two of the merges that counted were false alarms: c79f9fd5b added unused names to a src/run-task.ts import line, and
 * 8b221c208 only compressed the comments of src/lib/task-linter.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { reviewerFreshnessForPublication } from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { postReviewStatusGuarded } from "#src/lib/review.js";
import { reviewerCodeStartGate, runDetachedReview, type DetachedWorkSpec, type FreshTreeReview } from "#src/lib/run-child.js";
import { reviewerCodeFreshnessAt, tokensEqualWithoutComments, type GitRunner, type ReviewerCodeFreshness } from "#src/lib/self-sync.js";
import { readLedgerLines } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const CODE = "a".repeat(40);
const MAIN_AT_START = "b".repeat(40);
const MAIN_AFTER_MERGE = "c".repeat(40);
const HEAD = "d".repeat(40);
const FRESH: ReviewerCodeFreshness = { status: "fresh", codeSha: MAIN_AT_START, originMainSha: MAIN_AT_START, advance: "none" };
const STALE: ReviewerCodeFreshness = { status: "stale", codeSha: CODE, originMainSha: MAIN_AT_START, changedPaths: ["src/lib/review.ts"] };
const MERGED_DURING_REVIEW: ReviewerCodeFreshness = {
  status: "stale", codeSha: MAIN_AT_START, originMainSha: MAIN_AFTER_MERGE, changedPaths: ["src/lib/review.ts"],
};
const WORK: DetachedWorkSpec = { kind: "review", prNumber: 6011, inputs: { repo: "acme/remudero", reviewAttemptId: "attempt-1" } };
const CTX = { runId: "run-child-review-6011", taskId: "PR-6011" };
type ReviewOptions = { reviewAttemptId?: string; reviewStartFreshness?: ReviewerCodeFreshness };

/** The run child's review: runDetachedReview over the start gate, a reviewer that posts through the real W1-T228 guard. */
async function runChildReview(readings: ReviewerCodeFreshness[], options: { gated?: boolean; freshTree?: FreshTreeReview } = {}) {
  const root = makeTempDir("w1-t12824");
  const ledgerPath = ledgerPathFor({ root } as Config);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const rows: Array<Record<string, unknown> & { step: string }> = [];
  const posts: string[] = [];
  const events: string[] = [];
  let reads = 0;
  const reviewer = async (_pr: string, _rest: string[], deps: ReviewOptions): Promise<number> => {
    events.push("reviewer started");
    const freshness = reviewerFreshnessForPublication(deps.reviewStartFreshness, () => MERGED_DURING_REVIEW);
    const posted = await postReviewStatusGuarded({
      readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
      owner: "acme", repo: "remudero", sha: HEAD, state: "success", taskId: "PR-6011", evidence: "no_evidence",
      ledgerPath, runId: CTX.runId, reviewerCodeFreshness: await freshness(),
      fetchLifecycle: () => ({ merged: false, closed: false }),
      post: (o) => { posts.push(o.state); },
    });
    return posted.posted ? 0 : 2;
  };
  const gate = reviewerCodeStartGate<ReviewOptions>(
    () => { events.push("freshness read"); return readings[Math.min(reads++, readings.length - 1)]; },
    (step, extra) => { rows.push({ step, ...extra }); },
    reviewer,
    () => ["--judge-at-own-start"],
    options.freshTree,
  );
  try {
    const outcome = await runDetachedReview(WORK, CTX, options.gated === false ? reviewer : (pr, rest, opts) => gate.call(pr, rest, opts))
      .then((result) => ({ result }), (error: { reasonClass?: string }) => ({ error }));
    const refused = readLedgerLines(ledgerPath).filter((row) => row.step === "review.post_refused");
    return { outcome, posts, events, rows, refused, reads };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T12824 criterion 1: a run child fresh at its start posts although main materially advanced during the review", async () => {
  const gated = await runChildReview([FRESH, MERGED_DURING_REVIEW]);
  assert.deepEqual(gated.events, ["freshness read", "reviewer started"], "one reading, taken before the reviewer starts");
  assert.equal(gated.reads, 1);
  assert.deepEqual(gated.posts, ["success"], "the start reading decides publication, so the verdict posts");
  assert.equal(gated.refused.length, 0);
  assert.ok("result" in gated.outcome, "the run child's review settles as a success");

  // The bug shape: the same reviewer with no start reading is withheld by the mid-review merge.
  const ungated = await runChildReview([FRESH], { gated: false });
  assert.deepEqual(ungated.posts, []);
  assert.match(String(ungated.refused[0]?.reason), /materially behind/);
  assert.equal("error" in ungated.outcome && ungated.outcome.error.reasonClass, "review_withheld");
});

test("W1-T12824 criterion 2: a stale start runs the review from a fresh tree at origin/main, and its verdict posts", async () => {
  const freshTreeCalls: Array<{ originMainSha: string; rest: string[] }> = [];
  const freshTree: FreshTreeReview = async (_pr, rest, freshness) => {
    freshTreeCalls.push({ originMainSha: freshness.originMainSha, rest });
    return 0;
  };
  const run = await runChildReview([STALE], { freshTree });
  assert.deepEqual(run.events, ["freshness read"], "no reviewer starts in the child's own stale code");
  assert.deepEqual(freshTreeCalls, [{ originMainSha: MAIN_AT_START, rest: ["--repo", "acme/remudero", "--judge-at-own-start"] }]);
  const ran = run.rows.find((row) => row.step === "review.ran_from_fresh_tree");
  assert.equal(ran?.exit_code, 0);
  assert.equal(ran?.origin_main_sha, MAIN_AT_START);
  assert.equal(ran?.pr, "6011");
  assert.ok("result" in run.outcome, "the fresh tree's exit code 0 settles the run child's review as a success");
});

test("W1-T12824 criterion 3: a stale start whose fresh tree cannot run starts no reviewer and names the reason", async () => {
  const cannotRun: FreshTreeReview = async (_pr, _rest, _freshness, onFailure) => {
    onFailure?.("git worktree add refused");
    return undefined;
  };
  for (const freshTree of [cannotRun, undefined]) {
    const run = await runChildReview([STALE], { freshTree });
    assert.deepEqual(run.events, ["freshness read"], "no reviewer starts");
    assert.deepEqual(run.posts, [], "nothing posts");
    const skipped = run.rows.find((row) => row.step === "review.skipped_stale_reviewer_code");
    assert.equal(skipped?.code_sha, CODE);
    if (freshTree) assert.equal(skipped?.fresh_tree_reason, "git worktree add refused");
  }
  // invariant:no-verdict-from-changed-code — code materially behind at its own start never posts a terminal status.
  const root = makeTempDir("w1-t12824-invariant");
  try {
    const posts: string[] = [];
    const posted = await postReviewStatusGuarded({
      readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
      owner: "acme", repo: "remudero", sha: HEAD, state: "success", taskId: "PR-6011", evidence: "no_evidence",
      ledgerPath: ledgerPathFor({ root } as Config), runId: CTX.runId,
      reviewerCodeFreshness: await reviewerFreshnessForPublication(STALE, () => FRESH)(),
      fetchLifecycle: () => ({ merged: false, closed: false }), post: (o) => { posts.push(o.state); },
    });
    assert.equal(posted.posted, false);
    assert.deepEqual(posts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const RUN_TASK = [
  'import { readFileSync } from "node:fs";',
  'import { alpha, worktreeRemove } from "lib/worker.js";',
  'import { gamma } from "lib/letters.js";',
  "",
  "async function runReview(pr: string): Promise<string> {",
  "  return alpha(pr) + gamma;",
  "}",
  "",
  "async function reviewCommand(pr: string): Promise<number> {",
  "  return (await runReview(pr)).length;",
  "}",
  "",
  "export function buildFreshTreeReviewRunner(): string {",
  '  return "fresh";',
  "}",
  "",
  "export function spawnRmdReviewForFreshTree(): string {",
  '  return "spawn";',
  "}",
  "",
  "export function disposeGarden(dir: string): void {",
  "  worktreeRemove(dir);",
  "  readFileSync(dir);",
  "}",
].join("\n");

function commit(repo: GitRepo, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo.dir, dirname(path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
    repo.git("add", path);
  }
  repo.git("commit", "--quiet", "-m", "advance");
  return repo.git("rev-parse", "HEAD");
}

/** The reviewer code at `before`, main at `after`: the predicate the reviewer's start check and post-time guard share. */
function freshnessAcross(before: Record<string, string>, after: Record<string, string>): ReviewerCodeFreshness {
  const repo = gitRepo({ kind: "w1-t12824-advance" });
  const codeSha = commit(repo, before);
  const mainSha = commit(repo, after);
  const git: GitRunner = (args) => repo.git(...args);
  return reviewerCodeFreshnessAt(codeSha, mainSha, git);
}

function editRunTask(from: string, to: string): string {
  assert.ok(RUN_TASK.includes(from), `fixture must contain ${from}`);
  return RUN_TASK.replace(from, to);
}

test("W1-T12824 criterion 4: an import line that only adds or removes names the review path does not use is immaterial", () => {
  // The c79f9fd5b shape: a new name on an import line that binds a used name, and a garden dispose change.
  const c79f9fd5b = editRunTask("import { alpha, worktreeRemove }", "import { alpha, worktreeRemove, worktreeRemoveIfPresent }")
    .replace("  worktreeRemove(dir);", "  worktreeRemoveIfPresent(dir);");
  const advance = freshnessAcross({ "src/run-task.ts": RUN_TASK }, { "src/run-task.ts": c79f9fd5b });
  assert.equal(advance.status, "fresh");
  assert.equal((advance as { advance: string }).advance, "immaterial");
  const removed = editRunTask("import { alpha, worktreeRemove }", "import { alpha }").replace("  worktreeRemove(dir);\n", "");
  assert.equal(freshnessAcross({ "src/run-task.ts": RUN_TASK }, { "src/run-task.ts": removed }).status, "fresh");

  // A name the review path uses, added, removed or bound from another module, stays material.
  const moved = editRunTask("import { alpha, worktreeRemove }", "import { worktreeRemove }")
    .replace("import { gamma } from", "import { alpha, gamma } from");
  assert.equal(freshnessAcross({ "src/run-task.ts": RUN_TASK }, { "src/run-task.ts": moved }).status, "stale");
  const respecified = editRunTask('import { gamma } from "lib/letters.js";', 'import { gamma } from "lib/other-letters.js";');
  assert.equal(freshnessAcross({ "src/run-task.ts": RUN_TASK }, { "src/run-task.ts": respecified }).status, "stale");
  const aliased = editRunTask("import { gamma } from", "import { delta as gamma } from");
  assert.equal(freshnessAcross({ "src/run-task.ts": RUN_TASK }, { "src/run-task.ts": aliased }).status, "stale");
  const unparsed = editRunTask('import { alpha, worktreeRemove } from "lib/worker.js";',
    'import { alpha, worktreeRemove, extra } from "lib/worker.js" with { type: "json" };');
  assert.equal(freshnessAcross({ "src/run-task.ts": RUN_TASK }, { "src/run-task.ts": unparsed }).status, "stale",
    "an import this reader cannot parse keeps the line material");
});

const LINTER = [
  "// The proof dialect.",
  "/** Parses one proof line. */",
  "export function parseProof(line: string): string | undefined {",
  "  const pattern = /^grep: (.+) in (\\S+)$/; // the grep form",
  "  const quoted = /a\\/\\/b/;",
  "  return pattern.exec(line)?.[1] ?? (quoted.test(line) ? `${line}//kept` : undefined);",
  "}",
].join("\n");

test("W1-T12824 criterion 5: a judging .ts file whose code tokens did not change is immaterial; any token change is material", () => {
  // The 8b221c208 shape: the comments of src/lib/task-linter.ts compressed, no code changed.
  const compressed = LINTER.replace("// The proof dialect.\n/** Parses one proof line. */\n", "/** Proof dialect: one line. */\n")
    .replace(" // the grep form", "");
  assert.equal(tokensEqualWithoutComments(LINTER, compressed), true);
  const advance = freshnessAcross({ "src/lib/task-linter.ts": LINTER }, { "src/lib/task-linter.ts": compressed });
  assert.equal(advance.status, "fresh");
  assert.equal((advance as { advance: string }).advance, "immaterial");
  const commentedRunTask = freshnessAcross({ "src/run-task.ts": RUN_TASK }, { "src/run-task.ts": RUN_TASK.replace("async function runReview", "// judged here\nasync function runReview") });
  assert.equal(commentedRunTask.status, "fresh", "a comment on the review path itself changes no code");

  // Each of these changes code that looks like a comment to a naive reader, or cannot be scanned: all stay material.
  for (const [from, to] of [
    ["(.+) in", "(.*) in"],
    ["a\\/\\/b", "a\\/\\/c"],
    ["//kept", "//gone"],
    ["`${line}//kept`", "`${line}//kept"],
  ]) {
    const changed = LINTER.replace(from, to);
    assert.notEqual(changed, LINTER, `fixture must contain ${from}`);
    assert.equal(tokensEqualWithoutComments(LINTER, changed), false, `${from} -> ${to}`);
    assert.equal(freshnessAcross({ "src/lib/task-linter.ts": LINTER }, { "src/lib/task-linter.ts": changed }).status, "stale", `${from} -> ${to}`);
  }
  const unscannable = "const open = `never closed\n// a comment";
  assert.equal(tokensEqualWithoutComments(unscannable, unscannable.replace("a comment", "another comment")), false);
  assert.equal(freshnessAcross({ "package.json": '{ "name": "x" }\n' }, { "package.json": '{ "name": "x" }\n\n' }).status, "stale");
  assert.equal(freshnessAcross({ "package-lock.json": "{}\n" }, { "package-lock.json": "{ }\n" }).status, "stale");
});
