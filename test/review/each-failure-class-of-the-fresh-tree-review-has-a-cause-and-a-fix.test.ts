/**
 * W1-T12226: the row of a fresh-tree review says how the review ended.
 *
 * `ended_as` is `verdict`, `no_verdict` or `defect`. Each test goes through the production gate, the
 * production runner and the production spawn, and the child is a real process: the review command of this
 * checkout run through `tsx` ("command"), or a shell script for the exits the command cannot make itself.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { REVIEW_EXIT_CAUSES, reviewEndedAs } from "#src/cli/commands/review.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { buildFreshTreeReviewRunner, buildReviewerCodeFreshnessGate, spawnRmdReviewForFreshTree } from "#test/helpers/run-task-test.js";

/** The loader of `tsx`, named directly: its `tsx` command opens a socket in the temp directory and a sandbox can refuse that. */
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "esm", "index.mjs")).href;
const MAIN_SHA = "b".repeat(40);
const STALE = { status: "stale" as const, codeSha: "a".repeat(12), originMainSha: MAIN_SHA, changedPaths: ["src/lib/review.ts"] };

type Row = Record<string, unknown>;
type Scenario = "closed" | "withheld" | "failure" | "success" | "threw";

/** The child of a "command" tree: the review command of this checkout, started the way `bin/rmd` starts it with no bundle. */
const COMMAND_CHILD = `
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const REPO_ROOT = ${JSON.stringify(REPO_ROOT)};
const [scenario, configRoot, verb, prArg, ...rest] = process.argv.slice(2);
if (verb !== "review") process.exit(64);
const { reviewCommand } = await import(pathToFileURL(join(REPO_ROOT, "src/cli/commands/review.ts")).href);
const unexpected = () => { throw new Error("unexpected review fixture dependency"); };
const host = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
  attributeWorkerStreamEvent: unexpected, ledgeredNonDispatchSpawn: unexpected, lintPlanForReview: unexpected,
  liveWorkerRunIds: new Set(), materializeReviewWorktree: unexpected, readHeadShaRest: unexpected,
  readMainPlanTreeSha: unexpected, realDeps: () => ({ reviewWorktree: { fetch: unexpected } }),
  reviewPostedDescription: (verdict) => verdict.summary, reviewWorkerLockId: (runId) => runId,
  reviewerClockBoundMs: unexpected, reviewSubjectGit: unexpected,
};
const HEAD = "c".repeat(40);
const pull = {
  number: Number(prArg), state: scenario === "closed" ? "closed" : "open", html_url: "https://github.com/craigoley/remudero/pull/" + prArg,
  head: { sha: HEAD, ref: "feature-branch" }, body: "## Acceptance\\n- the change works | grep: review in src/lib/review.ts\\n",
};
const verdict = {
  state: scenario === "failure" ? "failure" : "success", headSha: HEAD, reviewerOutcome: "success", criteria: [],
  testTheater: false, summary: "fixture review complete", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
  ...(scenario === "withheld" ? { verdictWithheld: "the fixture did not post" } : {}),
};
try {
  process.exitCode = await reviewCommand(host, prArg, rest, {
    resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    fetchView: () => { if (scenario === "threw") throw new RangeError("the fixture read of the pull request failed"); return pull; },
    loadConfig: () => ({ root: configRoot, installRoot: REPO_ROOT, claudeBin: "/bin/true" }),
    fetchHead: () => {},
    postReviewPending: async () => ({ posted: true }),
    postStatus: async () => ({ posted: true }),
    reviewerCodeFreshness: () => ({ status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" }),
    materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "fixture" } }),
    runReview: async () => verdict,
  });
} catch (error) {
  console.error("### RUN-TASK ERROR " + String(error));
  process.exitCode = 1;
}
`;

/** A reviewer tree at the path that the runner derives for MAIN_SHA. Its `bin/rmd` is `script`. */
function reviewerTree(script: (root: string) => string, files: Record<string, string> = {}): { root: string; cleanup: () => void } {
  const root = makeTempDir("t12226-fresh-tree");
  const tree = join(root, `reviewer-${MAIN_SHA.slice(0, 12)}`);
  mkdirSync(join(tree, "bin"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(tree, name), text);
  writeFileSync(join(tree, "bin", "rmd"), `#!/usr/bin/env bash\n${script(root)}\n`);
  chmodSync(join(tree, "bin", "rmd"), 0o755);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The production gate over the production runner and spawn. Only git and the worktree cut are replaced. */
async function reviewThroughGate(root: string): Promise<{ code: number; row: Row }> {
  const rows: Row[] = [];
  const runner = buildFreshTreeReviewRunner("/repo", {
    git: () => "", addWorktree: () => {}, inspectExistingWorktree: () => "reusable", prepareWorktree: () => true,
    withWorktreeLease: async (_tree, action) => action(), spawnReview: spawnRmdReviewForFreshTree, worktreeRoot: root,
  });
  const gate = buildReviewerCodeFreshnessGate(
    () => STALE, (step, extra) => { rows.push({ step, ...extra }); },
    async () => assert.fail("a stale reviewer must not judge in its own process"), runner,
  );
  const code = await gate.call("7", ["--repo", "craigoley/remudero"], {} as never);
  const ran = rows.filter((row) => row.step === "review.ran_from_fresh_tree");
  assert.equal(ran.length, 1, `one row for one review: ${JSON.stringify(rows)}`);
  return { code, row: ran[0]! };
}

const commandRuns = new Map<Scenario, Promise<{ code: number; row: Row }>>();
/** One real run of the review command per scenario; the tests share the result. */
function commandRun(scenario: Scenario): Promise<{ code: number; row: Row }> {
  let run = commandRuns.get(scenario);
  if (run === undefined) {
    const tree = reviewerTree(
      (root) => `exec node --import ${JSON.stringify(TSX_LOADER)} "$(dirname "$0")/../child.mjs" ${scenario} ${JSON.stringify(join(root, "config-root"))} "$@"`,
      { "child.mjs": COMMAND_CHILD },
    );
    run = reviewThroughGate(tree.root).finally(tree.cleanup);
    commandRuns.set(scenario, run);
  }
  return run;
}

/** A shell child: it writes `report` (when given) to the file that the flag names, then runs `end`. */
async function stubRun(end: string, report?: string): Promise<{ code: number; row: Row; exitFile: string }> {
  const tree = reviewerTree(() => [
    'file=""; prev=""',
    'for arg in "$@"; do if [ "$prev" = "--exit-cause-file" ]; then file="$arg"; fi; prev="$arg"; done',
    '[ -n "$file" ] || exit 97',
    'printf "%s" "$file" > "$(dirname "$0")/../exit-file-path.txt"',
    ...(report === undefined ? [] : ['cat "$(dirname "$0")/../report.txt" > "$file"']),
    end,
  ].join("\n"), report === undefined ? {} : { "report.txt": `${report}\n` });
  try {
    const run = await reviewThroughGate(tree.root);
    return { ...run, exitFile: readFileSync(join(tree.root, `reviewer-${MAIN_SHA.slice(0, 12)}`, "exit-file-path.txt"), "utf8") };
  } finally {
    tree.cleanup();
  }
}


test("W1-T12226 criterion 2: a verdict and a review with nothing to post carry no `failure`, every other exit is a defect that keeps it", async () => {
  const closed = await commandRun("closed");
  assert.equal(closed.code, 2, JSON.stringify(closed.row));
  assert.equal(closed.row.exit_cause, "closed-before-review");
  assert.equal(closed.row.ended_as, "no_verdict");
  assert.equal("failure" in closed.row, false, "a review that correctly had nothing to post did not fail");

  const clean = await commandRun("success");
  assert.equal(clean.code, 0, JSON.stringify(clean.row));
  assert.equal(clean.row.ended_as, "verdict");
  assert.equal("failure" in clean.row, false);

  for (const [scenario, cause] of [["withheld", "verdict-not-posted"], ["threw", "threw-in-view"]] as const) {
    const run = await commandRun(scenario);
    assert.equal(run.row.exit_cause, cause);
    assert.equal(run.row.ended_as, "defect", `${cause} judged nothing or could not post`);
    assert.equal(typeof run.row.failure, "string", `${cause} keeps its failure text`);
  }
  const killed = await stubRun("kill -KILL $$");
  assert.equal(killed.row.ended_as, "defect");
  assert.equal(killed.row.exit_cause, "signal");
  const silent = await stubRun("exit 2");
  assert.equal(silent.row.ended_as, "defect");
  assert.equal(typeof silent.row.failure, "string", "a defect keeps its failure text");
  const newer = await stubRun("exit 2", "a-name-from-newer-code");
  assert.equal(newer.row.ended_as, "defect", "a name this code does not know is a defect");

  // A runner that gives the gate no exit at all still gets the class.
  const rows: Row[] = [];
  const gate = buildReviewerCodeFreshnessGate(() => STALE, (step, extra) => { rows.push({ step, ...extra }); },
    async () => assert.fail("a stale reviewer must not judge in its own process"), async () => 2);
  assert.equal(await gate.call("7", [], {} as never), 2);
  assert.equal(rows[0]?.ended_as, "defect");
});

test("W1-T12226 criterion 2: every name in the list has a class, and the class never rests on the code alone", () => {
  const classes = new Map(REVIEW_EXIT_CAUSES.map((cause) => [cause, reviewEndedAs(1, cause)]));
  assert.deepEqual([...classes].filter(([, as]) => as === "verdict").map(([cause]) => cause).sort(),
    ["verdict-failure", "verdict-not-success", "verdict-pending"]);
  assert.deepEqual([...classes].filter(([, as]) => as === "no_verdict").map(([cause]) => cause), ["closed-before-review"]);
  for (const cause of ["verdict-not-posted", "shadow-verdict-withheld", "replayed-verdict-withheld", "subject-refused", "repo-unresolvable"]) {
    assert.equal(classes.get(cause as never), "defect", cause);
  }
  assert.equal(reviewEndedAs(0, "not-reported"), "verdict", "a child that exits 0 posted its verdict");
  assert.equal(reviewEndedAs(2, "verdict-failure"), "verdict");
  assert.equal(reviewEndedAs(1, "not-reported"), "defect");
});

test("W1-T12226 criterion 4: a child that exits 1 because the verdict is not success writes `ended_as: verdict`, and the gate returns its code", async () => {
  const finished = await commandRun("failure");
  assert.equal(finished.code, 1, JSON.stringify(finished.row));
  assert.equal(finished.row.exit_code, 1);
  assert.equal(finished.row.exit_cause, "verdict-failure");
  assert.equal(finished.row.ended_as, "verdict");
  assert.equal("failure" in finished.row, false, "a review that judged and said no is not a failed child");
});
