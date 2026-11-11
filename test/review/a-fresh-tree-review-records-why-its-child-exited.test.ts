/**
 * W1-T12225: a fresh-tree review records why its child exited.
 *
 * In 7 days the fresh-tree review ran 56 times and its child exited with a code that is not 0 in 26 of
 * them. The row held only the code and stderr text. Each test here goes through the production gate, the
 * production runner and the production spawn, and the child is a real process. A "command" child runs
 * the review command of this checkout through `tsx`, with GitHub and the reviewer replaced. A "stub"
 * child is a shell script, for the exits that the command cannot make itself.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { REVIEW_EXIT_CAUSES } from "#src/cli/commands/review.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { buildFreshTreeReviewRunner, buildReviewerCodeFreshnessGate, spawnRmdReviewForFreshTree } from "#test/helpers/run-task-test.js";

const MAIN_SHA = "b".repeat(40);
const STALE = { status: "stale" as const, codeSha: "a".repeat(12), originMainSha: MAIN_SHA, changedPaths: ["src/lib/review.ts"] };
const NAME_FORM = /^[a-z][a-z0-9-]{0,47}$/;
const TOKEN = `ghp_${"A".repeat(36)}`;

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
  const root = makeTempDir("t12225-fresh-tree");
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
      (root) => `exec ${JSON.stringify(join(REPO_ROOT, "node_modules", ".bin", "tsx"))} "$(dirname "$0")/../child.mjs" ${scenario} ${JSON.stringify(join(root, "config-root"))} "$@"`,
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

test("W1-T12225 criterion 1: the row of a child that exits with a code that is not 0 holds the name that the review command gave", async () => {
  const finished = await commandRun("failure");
  assert.equal(finished.code, 1, JSON.stringify(finished.row));
  assert.equal(finished.row.exit_code, 1);
  assert.equal(finished.row.exit_cause, "verdict-failure", "a review that judged and said no is not a failed child");

  const beforeReview = await commandRun("threw");
  assert.equal(beforeReview.code, 1, JSON.stringify(beforeReview.row));
  assert.equal(beforeReview.row.exit_cause, "threw-in-view", "the name holds the step in which the command threw");
  assert.equal(beforeReview.row.exit_error_class, "RangeError");
  assert.match(String(beforeReview.row.failure), /the fixture read of the pull request failed/);
});

test("W1-T12225 criterion 2: the real command gives three different names to three exits", async () => {
  const closed = await commandRun("closed");
  const withheld = await commandRun("withheld");
  const failure = await commandRun("failure");
  assert.deepEqual([closed.code, withheld.code, failure.code], [2, 2, 1], "the exit codes are the codes of today");
  assert.equal(closed.row.exit_cause, "closed-before-review");
  assert.equal(withheld.row.exit_cause, "verdict-not-posted");
  assert.equal(failure.row.exit_cause, "verdict-failure");
  const names = [closed, withheld, failure].map((run) => String(run.row.exit_cause));
  assert.equal(new Set(names).size, 3, `two exits share a name: ${names.join(", ")}`);
  for (const name of names) assert.ok((REVIEW_EXIT_CAUSES as readonly string[]).includes(name), `${name} is in the exported list`);
  assert.equal(new Set(REVIEW_EXIT_CAUSES).size, REVIEW_EXIT_CAUSES.length, "no name is in the list twice");
});

test("W1-T12225 criterion 3: a signal and a silent child each have a cause, and the row never lacks the field", async () => {
  const killed = await stubRun("kill -KILL $$");
  assert.equal(killed.row.exit_cause, "signal");
  assert.equal(killed.row.exit_signal, "SIGKILL");
  // The name that the child wrote before the signal does not replace the signal.
  const killedAfterReport = await stubRun("kill -TERM $$", "verdict-failure");
  assert.equal(killedAfterReport.row.exit_cause, "signal");
  assert.equal(killedAfterReport.row.exit_signal, "SIGTERM");

  const silent = await stubRun("exit 2");
  assert.equal(silent.code, 2);
  assert.equal(silent.row.exit_cause, "not-reported");
  assert.equal("exit_signal" in silent.row, false);

  // A runner that gives the gate no exit at all (older code, or a test double) still gets the field.
  const rows: Row[] = [];
  const gate = buildReviewerCodeFreshnessGate(() => STALE, (step, extra) => { rows.push({ step, ...extra }); },
    async () => assert.fail("a stale reviewer must not judge in its own process"), async () => 2);
  assert.equal(await gate.call("7", [], {} as never), 2);
  assert.equal(rows[0]?.exit_cause, "not-reported");
});

test("W1-T12225 criterion 4: the row keeps `failure`, and a child that exits 0 writes no `exit_cause`", async () => {
  const failed = await stubRun('echo "fatal: the stderr line of the child" >&2\nexit 2', "closed-before-review");
  assert.equal(failed.code, 2);
  assert.equal(failed.row.failure, "fatal: the stderr line of the child", "the stderr text stays in `failure`, as before");
  assert.equal(failed.row.exit_cause, "closed-before-review");
  assert.equal(existsSync(dirname(failed.exitFile)), false, "the directory of the result file does not stay on disk");

  const clean = await commandRun("success");
  assert.equal(clean.code, 0, JSON.stringify(clean.row));
  assert.equal(clean.row.exit_code, 0);
  for (const field of ["exit_cause", "exit_signal", "exit_error_class", "failure"]) {
    assert.equal(field in clean.row, false, `a clean review has no ${field}`);
  }
  // A child that reports a name and then exits 0 also writes no field: the code decides.
  const reportedButClean = await stubRun("exit 0", "verdict-failure");
  assert.equal("exit_cause" in reportedButClean.row, false);
  assert.equal(existsSync(dirname(reportedButClean.exitFile)), false);
});

test("W1-T12225 criterion 5: `exit_cause` is one short name, never stderr text, a path or a credential", async () => {
  const refused = [
    `fatal: https://x-access-token:${TOKEN}@github.com/o/r.git`,
    "/Users/someone/Remudero/state/ledger.ndjson",
    TOKEN,
    "Error: Cannot find package 'yaml' imported from src/lib/plan.ts",
    `a${"-very-long-name".repeat(4)}`,
    "",
  ];
  for (const report of refused) {
    const run = await stubRun(`echo "stderr with ${TOKEN}" >&2\nexit 2`, report);
    assert.equal(run.row.exit_cause, "not-reported", `the file content ${JSON.stringify(report)} is not a name`);
    assert.equal("exit_error_class" in run.row, false);
  }
  // The class name of an error has its own form check: text after the name is not copied.
  const withClass = await stubRun("exit 1", "threw-in-setup\tTypeError");
  assert.deepEqual([withClass.row.exit_cause, withClass.row.exit_error_class], ["threw-in-setup", "TypeError"]);
  const withText = await stubRun("exit 1", "threw-in-setup\tTypeError: /a/path");
  assert.deepEqual([withText.row.exit_cause, "exit_error_class" in withText.row], ["threw-in-setup", false]);

  // The parent checks the form, not the list: the child runs newer code and can hold a newer name.
  const newer = await stubRun("exit 2", "a-name-from-newer-code");
  assert.equal(newer.row.exit_cause, "a-name-from-newer-code");
  for (const name of REVIEW_EXIT_CAUSES) assert.match(name, NAME_FORM, `${name} has the form that the parent accepts`);
  for (const scenario of ["closed", "withheld", "failure", "threw"] as const) {
    const cause = String((await commandRun(scenario)).row.exit_cause);
    assert.match(cause, NAME_FORM);
    assert.ok((REVIEW_EXIT_CAUSES as readonly string[]).includes(cause), `${cause} is from the fixed list of the command`);
  }
});
