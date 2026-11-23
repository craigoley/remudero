/**
 * W1-T12226: each failure class of the fresh-tree review has a known cause and a fix.
 *
 * Every test goes through the production gate (`buildReviewerCodeFreshnessGate`), the production runner and
 * the production spawn. The child is a real process: it runs the review command of this checkout through
 * `tsx`, with GitHub and the reviewer replaced. One test per `exit_cause` with two or more rows in the
 * ledger window of the build, plus one test per fixed defect.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { buildFreshTreeReviewRunner, buildReviewerCodeFreshnessGate, spawnRmdReviewForFreshTree } from "#test/helpers/run-task-test.js";

const FIRST_MAIN = "b".repeat(40);
const NEXT_MAIN = "d".repeat(40);
const staleAt = (originMainSha: string) =>
  ({ status: "stale" as const, codeSha: "a".repeat(12), originMainSha, changedPaths: ["src/lib/review.ts"] });

type Row = Record<string, unknown>;
type Scenario = "failure" | "pending" | "closed" | "cut-output" | "success" | "stale-start" | "ops-moved-once" | "ops-moved-twice";

/** The child of a tree: the review command of this checkout, started the way `bin/rmd` starts it with no bundle. */
const COMMAND_CHILD = `
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const REPO_ROOT = ${JSON.stringify(REPO_ROOT)};
const [scenario, configRoot, verb, prArg, ...rest] = process.argv.slice(2);
if (verb !== "review") process.exit(64);
mkdirSync(join(configRoot, "state"), { recursive: true });
const { reviewCommand } = await import(pathToFileURL(join(REPO_ROOT, "src/cli/commands/review.ts")).href);
const { mergePlanBlobs } = await import(pathToFileURL(join(REPO_ROOT, "src/lib/plan.ts")).href);
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
const ops = scenario.startsWith("ops-moved");
const TASK = "W1-T999226";
const HEAD = ops ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim() : "c".repeat(40);
const pull = {
  number: Number(prArg), state: scenario === "closed" ? "closed" : "open", html_url: "https://github.com/craigoley/remudero/pull/" + prArg,
  head: { sha: HEAD, ref: ops ? "run-" + TASK + "-1" : "feature-branch" },
  body: ops ? "Remudero-Task: " + TASK + "\\n" : "## Acceptance\\n- the change works | grep: review in src/lib/review.ts\\n",
};
// A moved ops ref refuses the read; the next read finds the task (once) or the ref moved again (twice).
let opsReads = 0;
const opsPlan = mergePlanBlobs([{ label: "ops.yaml", text: "- id: " + TASK + "\\n  title: Ops fixture\\n  repo: remudero\\n  depends_on: []\\n" +
  "  type: implement\\n  priority: 0\\n  files: [src/fixture.ts]\\n  acceptance:\\n    - claim: ops criterion\\n      proof: \\"grep: x in src/fixture.ts\\"\\n" }]);
if (ops) writeFileSync(join(configRoot, "state", "plan-destination.json"), JSON.stringify({ repository: "fixture-private/ops", kinds: [] }));
const taskLookup = {
  get opsSnapshot() {
    opsReads += 1;
    writeFileSync(join(configRoot, "ops-reads"), String(opsReads));
    if (opsReads === 1 || scenario === "ops-moved-twice") return { outcome: "ref_moved", counts: {} };
    return { outcome: "ok", plan: opsPlan, counts: {} };
  },
};
const staleCode = { status: "stale", codeSha: "b".repeat(40), originMainSha: "e".repeat(40), changedPaths: ["src/lib/review.ts"] };
try {
  process.exitCode = await reviewCommand(host, prArg, rest, {
    resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    fetchView: () => pull,
    loadConfig: () => ({ root: configRoot, installRoot: REPO_ROOT, claudeBin: "/bin/true" }),
    fetchHead: () => {},
    taskLookup,
    postReviewPending: async () => ({ posted: true }),
    postStatus: async () => ({ posted: true }),
    reviewerCodeFreshness: () => scenario === "stale-start" ? staleCode : { status: "fresh", codeSha: HEAD, originMainSha: HEAD, advance: "none" },
    materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "fixture" } }),
    runReview: async (args) => {
      writeFileSync(join(configRoot, "judged-" + scenario), "judged");
      const verdict = {
        state: scenario === "failure" ? "failure" : scenario === "pending" ? "pending" : "success", headSha: HEAD,
        reviewerOutcome: "success", criteria: [], testTheater: false, summary: "fixture review complete",
        floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
      };
      // As in production: the reviewer output was cut at its cap, so the verdict is withheld.
      if (scenario === "cut-output") verdict.verdictWithheld = "required semantic review incomplete: error_incomplete_output";
      // As in production: the publication guard withholds a terminal verdict judged by stale code.
      const code = await args.reviewerCodeFreshness();
      if (code.status === "stale" && verdict.state !== "pending") {
        verdict.verdictWithheld = "reviewer code " + code.codeSha.slice(0, 12) + " is materially behind origin/main";
      }
      return verdict;
    },
  });
} catch (error) {
  console.error("### RUN-TASK ERROR " + String(error));
  process.exitCode = 1;
}
`;

type Run = { code: number; rows: Row[]; row: Row; childRows: Row[]; root: string; judged: (scenario: Scenario) => boolean; opsReads: number };

/**
 * One fresh-tree review through the production gate. `trees` maps an origin/main sha to the scenario of the
 * child in that sha's tree; `readings` are the gate's freshness readings, in order (the last one repeats).
 */
async function throughGate(trees: Record<string, Scenario>, readings = [staleAt(FIRST_MAIN)]): Promise<Run> {
  const root = makeTempDir("t12226-fresh-tree");
  const configRoot = join(root, "config-root");
  try {
    for (const [sha, scenario] of Object.entries(trees)) {
      const tree = join(root, `reviewer-${sha.slice(0, 12)}`);
      mkdirSync(join(tree, "bin"), { recursive: true });
      writeFileSync(join(tree, "child.mjs"), COMMAND_CHILD);
      const tsx = JSON.stringify(join(REPO_ROOT, "node_modules", ".bin", "tsx"));
      writeFileSync(join(tree, "bin", "rmd"),
        `#!/usr/bin/env bash\nexec ${tsx} "$(dirname "$0")/../child.mjs" ${scenario} ${JSON.stringify(configRoot)} "$@"\n`);
      chmodSync(join(tree, "bin", "rmd"), 0o755);
    }
    const rows: Row[] = [];
    const runner = buildFreshTreeReviewRunner("/repo", {
      git: () => "", addWorktree: () => {}, inspectExistingWorktree: () => "reusable", prepareWorktree: () => true,
      withWorktreeLease: async (_tree, action) => action(), spawnReview: spawnRmdReviewForFreshTree, worktreeRoot: root,
    });
    let read = 0;
    const gate = buildReviewerCodeFreshnessGate(
      () => readings[Math.min(read++, readings.length - 1)]!, (step, extra) => { rows.push({ step, ...extra }); },
      async () => assert.fail("a stale reviewer must not judge in its own process"), runner,
    );
    const code = await gate.call("7", ["--repo", "craigoley/remudero"], {} as never);
    const ran = rows.filter((row) => row.step === "review.ran_from_fresh_tree");
    assert.equal(ran.length, 1, `one row for one review: ${JSON.stringify(rows)}`);
    const ledgerFile = join(configRoot, "state", "ledger.ndjson");
    const childRows = existsSync(ledgerFile)
      ? readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row) : [];
    const judgedSet = new Set(Object.values(trees).filter((scenario) => existsSync(join(configRoot, `judged-${scenario}`))));
    const opsFile = join(configRoot, "ops-reads");
    return {
      code, rows, row: ran[0]!, childRows, root, judged: (scenario) => judgedSet.has(scenario),
      opsReads: existsSync(opsFile) ? Number(readFileSync(opsFile, "utf8")) : 0,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const shared = new Map<Scenario, Promise<Run>>();
/** One run per scenario in the tree of the first reading; the tests share the result. */
function once(scenario: Scenario): Promise<Run> {
  let run = shared.get(scenario);
  if (run === undefined) {
    run = throughGate({ [FIRST_MAIN]: scenario });
    shared.set(scenario, run);
  }
  return run;
}

test("W1-T12226 criterion 1: verdict-failure, a review that judged and said no, ends as verdict", async () => {
  const run = await once("failure");
  assert.deepEqual([run.code, run.row.exit_code, run.row.exit_cause, run.row.ended_as], [1, 1, "verdict-failure", "verdict"], JSON.stringify(run.row));
});

test("W1-T12226 criterion 1: closed-before-review, a pull request closed before its review, ends as no_verdict", async () => {
  const run = await once("closed");
  assert.deepEqual([run.code, run.row.exit_cause, run.row.ended_as], [2, "closed-before-review", "no_verdict"], JSON.stringify(run.row));
  assert.equal(run.judged("closed"), false, "a closed pull request is not judged");
});

test("W1-T12226 criterion 1: verdict-not-posted, reviewer output cut at its cap, ends as defect", async () => {
  // The three rows of this source were fixed on main by W1-T13951 and W1-T14207. This test pins the class only.
  const run = await once("cut-output");
  assert.deepEqual([run.code, run.row.exit_cause, run.row.ended_as], [2, "verdict-not-posted", "defect"], JSON.stringify(run.row));
  assert.equal(run.judged("cut-output"), true);
  assert.equal(typeof run.row.failure, "string", "a defect row keeps `failure`");
});

test("W1-T12226 criterion 1: verdict-pending, the pending of a cannot-evaluate escalation, ends as verdict", async () => {
  const run = await once("pending");
  assert.deepEqual([run.code, run.row.exit_cause, run.row.ended_as], [1, "verdict-pending", "verdict"], JSON.stringify(run.row));
});

test("W1-T12226 criterion 1: task-metadata-unavailable, an ops ref that moves on both reads, ends as defect", async () => {
  const run = await once("ops-moved-twice");
  assert.deepEqual([run.code, run.row.exit_cause, run.row.ended_as], [2, "task-metadata-unavailable", "defect"], JSON.stringify(run.row));
  assert.equal(run.opsReads, 2, "the review reads the ops catalog twice, never more");
  assert.equal(run.judged("ops-moved-twice"), false);
  assert.ok(run.childRows.some((row) => row.step === "review.catalog.unreadable" && row.reason === "ops-ref_moved"));
});

test("W1-T12226 criterion 2: `ended_as` is on every row, and only a defect row carries `failure`", async () => {
  for (const scenario of ["failure", "pending", "closed", "success"] as const) {
    const { row } = await once(scenario);
    assert.ok(row.ended_as === "verdict" || row.ended_as === "no_verdict", `${scenario}: ${JSON.stringify(row)}`);
    assert.equal("failure" in row, false, `${scenario}: a ${String(row.ended_as)} row carries no failure`);
  }
  assert.equal((await once("success")).row.ended_as, "verdict", "a child that exits 0 posted its verdict");
  for (const scenario of ["cut-output", "ops-moved-twice"] as const) {
    const { row } = await once(scenario);
    assert.equal(row.ended_as, "defect");
    assert.equal(typeof row.failure, "string", `${scenario}: a defect row keeps the stderr text`);
  }
  // A runner that gives the gate no exit (older code) is a defect with its failure, as before.
  const rows: Row[] = [];
  const gate = buildReviewerCodeFreshnessGate(() => staleAt(FIRST_MAIN), (step, extra) => { rows.push({ step, ...extra }); },
    async () => assert.fail("a stale reviewer must not judge in its own process"), async () => 2);
  assert.equal(await gate.call("7", [], {} as never), 2);
  assert.deepEqual([rows[0]?.exit_cause, rows[0]?.ended_as, rows[0]?.failure], ["not-reported", "defect", "no failure reported"]);
});

test("W1-T12226 criterion 3: reviewer-stale-at-start, a child stale at its own start posts nothing and the gate retries once in a newer tree", async () => {
  const run = await throughGate({ [FIRST_MAIN]: "stale-start", [NEXT_MAIN]: "success" }, [staleAt(FIRST_MAIN), staleAt(NEXT_MAIN)]);
  assert.equal(run.judged("success"), true, "the child in the newer tree judges and posts");
  assert.equal(run.code, 0, JSON.stringify(run.row));
  assert.equal(run.row.ended_as, "verdict");
  assert.equal(run.row.origin_main_sha, NEXT_MAIN);
  assert.deepEqual([run.row.retried_after, run.row.retry_of_origin_main_sha], ["reviewer-stale-at-start", FIRST_MAIN]);
});

test("W1-T12226 criterion 3: reviewer-stale-at-start is retried once only, and never in the same tree", async () => {
  const twice = await throughGate({ [FIRST_MAIN]: "stale-start", [NEXT_MAIN]: "stale-start" }, [staleAt(FIRST_MAIN), staleAt(NEXT_MAIN), staleAt("f".repeat(40))]);
  assert.deepEqual([twice.code, twice.row.exit_cause, twice.row.ended_as], [2, "reviewer-stale-at-start", "defect"], JSON.stringify(twice.row));
  assert.equal(twice.row.origin_main_sha, NEXT_MAIN, "the second tree is the last one");

  const sameSha = await throughGate({ [FIRST_MAIN]: "stale-start" }, [staleAt(FIRST_MAIN)]);
  assert.deepEqual([sameSha.code, sameSha.row.exit_cause, sameSha.row.ended_as], [2, "reviewer-stale-at-start", "defect"]);
  assert.equal("retried_after" in sameSha.row, false, "an unmoved main gives no newer tree to retry in");
});

test("W1-T12226 criterion 3: task-metadata-unavailable after one moved ops ref is read once more and the review judges", async () => {
  const run = await once("ops-moved-once");
  assert.equal(run.opsReads, 2);
  assert.equal(run.judged("ops-moved-once"), true, "the second read finds the ops task and the review judges it");
  assert.deepEqual([run.code, run.row.ended_as], [0, "verdict"], JSON.stringify(run.row));
  assert.equal(run.childRows.some((row) => row.step === "review.catalog.unreadable"), false);
});

test("W1-T12226 criterion 4: a child that exits 1 because the verdict is not success ends as verdict, and the gate returns its code", async () => {
  for (const scenario of ["failure", "pending"] as const) {
    const run = await once(scenario);
    assert.equal(run.code, 1, "the gate returns the code of the child, as today");
    assert.equal(run.row.exit_code, 1);
    assert.equal(run.row.ended_as, "verdict", `${scenario}: a posted verdict is not a defect`);
    assert.ok(typeof run.row.exit_cause === "string" && run.row.exit_cause.startsWith("verdict-"), "the row keeps `exit_cause`");
  }
});
