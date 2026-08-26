/**
 * W1-T412 — the implement phase's follow-up harvest is skipped by an early return.
 *
 * THE DEFECT, re-derived from source. `harvestFollowupsFromReport` (src/run-task.ts) already
 * declares `prUrl` OPTIONAL and spreads `pr_url` into its ledger line only when defined, and the
 * RECON call site already passes none — so the PR-less shape runs on every dispatch and is not new
 * code. But `runTask`'s implement-phase harvest call sits BELOW `gh pr create`/`pr.opened`, placed
 * there because that is where `prUrl` becomes known on the orchestrator-fallback path. The silent
 * no-op guard returns above it on EVERY path it takes — `already_satisfied` and `no_pr` alike — so
 * recon follow-ups survive and implement follow-ups die on exactly the verdict where a worker most
 * needs to say something. Measured across four empty-diff runs: W1-T388, W1-T392 twice, W1-T393.
 *
 * WHY BOTH DIRECTIONS ARE LOCKED HERE. A test asserting only that a `no_pr` run now harvests would
 * pass against a change that harvests UNCONDITIONALLY and broke the PR-bearing path — so the second
 * test is a control differing in ONE variable (the implement worker reports a PR_URL) and asserts
 * the PR-bearing run still harvests EXACTLY ONCE with its `pr_url` intact.
 *
 * REACHING THE PATH IS ITSELF ASSERTED. Both tests assert the verdict they meant to exercise before
 * asserting anything about the ledger — a fixture that silently failed to reach the no-op guard
 * would otherwise make the whole file vacuous.
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts, which
 * intermittently crashes at FILE level under --experimental-test-coverage.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTask } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

const FIXTURE_PLAN = [
  "- id: T-NOPR-FOLLOWUP",
  "  title: implement follow-up harvest on a PR-less exit",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

function gitFixture(root: string): void {
  const originGit = mkdtempSync(join(tmpdir(), "nopr-followup-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "nopr-followup-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "nopr-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "nopr-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "nopr-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "nopr-test"]);
}

/** A fake `gh` answering ownership/trailer/CI (RED on the first poll), the same shape the
 *  sibling suites use. The no_pr run returns before ever reaching `gh pr create`. */
function fakeGh(branch: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "nopr-followup-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${branch}"}'; exit 0; fi`,
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then",
      "    echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"FAILURE\"}]}'",
      "    exit 0",
      "  fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'merge' ]]; then exit 0; fi",
      // W1-T2268 moved both poll loops off `gh pr view --json state,statusCheckRollup` onto REST,
      // so the three argv shapes below are what production now asks for. Answering them keeps this
      // fixture's ORIGINAL contract intact -- red CI on the first poll -- rather than changing what
      // the test asserts.
      "if [[ \"$1\" == 'api' ]]; then",
      "  case \"$2\" in",
      "    */check-runs*) echo '{\"check_runs\":[{\"name\":\"ci\",\"status\":\"completed\",\"conclusion\":\"failure\"}]}'; exit 0 ;;",
      "    */status) echo '{\"state\":\"failure\",\"statuses\":[]}'; exit 0 ;;",
      `    */pulls/*) echo '{"number":1,"state":"open","merged":false,"head":{"sha":"deadbee","ref":"${branch}"}}'; exit 0 ;;`,
      "  esac",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

function result(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function readLedger(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const RECON_TEXT =
  "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n\n" +
  "## Follow-ups\nresearch: a recon-discovered idea, out of scope for this task\n";

/** The implement report both tests use, differing in ONE variable: whether it reports a PR_URL. */
function implementText(prUrl?: string): string {
  return (
    "REPORT\n" +
    (prUrl ? `PR_URL: ${prUrl}\n` : "") +
    "\n## Follow-ups\ntask: the declared scope cannot hold this change, out of scope for this task\n"
  );
}

/** The run branch is `run-<taskId>-<Date.now()>`, so the clock is pinned and the fake `gh` is
 *  told the SAME name — otherwise `checkPrOwnership` sees a foreign head and the control ends
 *  `pr_attribution_failed` before it ever reaches the harvest it exists to observe. */
const FIXED_TS = 1785000000000;

async function runFixture(
  t: { mock: { method: typeof import("node:test").mock.method } },
  label: string,
  implPrUrl: string | undefined,
): Promise<{ verdict: string; ledger: Array<Record<string, unknown>> }> {
  const root = mkdtempSync(join(tmpdir(), `nopr-followup-${label}-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);

  t.mock.method(Date, "now", () => FIXED_TS);
  const fakeBinDir = fakeGh(`run-T-NOPR-FOLLOWUP-${FIXED_TS}`);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    // The implement worker writes NOTHING to the worktree in either case, so the branch is
    // zero commits ahead of origin/main — which is half of the no-op guard's own condition.
    return spawnCalls.length === 1
      ? result({ sessionId: "s-recon", text: RECON_TEXT })
      : result({ sessionId: "s-implement", text: implementText(implPrUrl) });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-NOPR-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );
    return { verdict: res.verdict, ledger: readLedger(root) };
  } finally {
    process.env.PATH = savedPath;
  }
}

test("a run that ends no_pr harvests the implement worker's follow-ups, with no blank pr_url on the line", async (t) => {
  const { verdict, ledger } = await runFixture(t, "nopr", undefined);

  // REACHING THE PATH IS THE FIRST ASSERTION — without it the rest is vacuous.
  assert.equal(verdict, "no_pr", "the fixture must actually reach the silent no-op guard's return");

  const harvests = ledger.filter((l) => l.step === "report.followups");
  assert.equal(harvests.length, 2, "recon AND implement follow-ups both survive a PR-less exit");

  const implementHarvest = harvests[1];
  assert.deepEqual(implementHarvest.entries, [
    { type: "task", text: "the declared scope cannot hold this change, out of scope for this task" },
  ]);
  // Absent, never present-and-blank: `harvestFollowupsFromReport` spreads pr_url in only when
  // defined, the same shape the recon call site emits on every dispatch.
  assert.equal("pr_url" in implementHarvest, false, "a run that opened no PR carries no pr_url field");

  // The verdict itself is untouched by this change — the harvest is an added call, not a
  // different ending. Ordering matters too: the follow-ups are on record BEFORE the verdict.
  const steps = ledger.map((l) => l.step);
  assert.ok(
    steps.lastIndexOf("report.followups") < steps.lastIndexOf("verdict"),
    "the harvest is recorded before the verdict that ends the run",
  );
});

test("a run that opens a PR still harvests exactly once, carrying its pr_url — the change adds no duplicate", async (t) => {
  const prUrl = "https://github.com/acme/remudero/pull/1";
  const { verdict, ledger } = await runFixture(t, "withpr", prUrl);

  // The ONE variable that differs from the test above: the implement worker reported a PR_URL,
  // so the no-op guard is not entered and the run proceeds to the CI poll (answered RED).
  assert.equal(verdict, "blocked_ci", "the control must take the PR-bearing path, not the no-op guard");

  const harvests = ledger.filter((l) => l.step === "report.followups");
  assert.equal(harvests.length, 2, "exactly recon + implement — the new call site did not double-harvest");

  const implementHarvest = harvests[1];
  assert.equal(implementHarvest.pr_url, prUrl, "the PR-bearing harvest still carries its pr_url unchanged");
  assert.deepEqual(implementHarvest.entries, [
    { type: "task", text: "the declared scope cannot hold this change, out of scope for this task" },
  ]);
});
