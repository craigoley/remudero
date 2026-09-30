// test/a-census-refused-push-kills-a-finished-build.test.ts — W1-T4656: the pre-push census
// precheck refused the orchestrator's fallback push, gitPushRunBranch threw, and a finished build
// died on run.error (34 runs across 19 tasks since 2026-09-24). Each runTask test below drives the
// REAL runTask against a real local origin whose TRACKED hooks/pre-push refuses a run branch while
// it carries `census.red`, and asserts the refusal now reaches the fix rung and the push is retried
// through that same hook.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { censusPushRefusal, runTask, type CensusPushRefusal } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const TASK_ID = "T-CENSUS-PUSH";
const CLOCK_BASELINE = "scripts/clock-signature-baseline.json";

const FIXTURE_PLAN = [
  `- id: ${TASK_ID}`,
  "  title: a census-refused push reaches the fix rung",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: test",
  "  status: queued",
  "",
].join("\n");

const REFUSAL_HEAD = "census-precheck: this branch grows 1 census count(s) CI will refuse:";
const REFUSAL_ROW =
  `  clock-signature: census.red dateNow 1 > baseline 0 — move it onto the Clock port, or record the row in ${CLOCK_BASELINE}`;

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "implement-session",
    costUsd: 0.02,
    numTurns: 1,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "test",
    effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

interface Fixture {
  root: string;
  planPath: string;
  config: Config;
  origin: string;
  hookLog: () => string[];
  cleanup: () => void;
}

/** The hook the fleet runs, reduced to its census arm: a run branch carrying `census.red` is refused
 *  unless the clock baseline records it; `other.red` is refused with a NON-census message. Every run
 *  branch push it sees is logged with its verdict and sha, which is how a test proves the retry went
 *  through the hook rather than around it. */
function hookScript(logPath: string): string {
  return [
    "#!/bin/sh",
    "while read -r _lref lsha rref _rsha; do",
    '  case "$rref" in refs/heads/run-*) ;; *) continue ;; esac',
    `  if [ -f census.red ] && ! grep -qs census.red ${CLOCK_BASELINE}; then`,
    `    echo "refused $lsha" >> '${logPath}'`,
    `    echo '${REFUSAL_HEAD}' >&2`,
    `    echo '${REFUSAL_ROW}' >&2`,
    "    exit 1",
    "  fi",
    "  if [ -f other.red ]; then",
    `    echo "other $lsha" >> '${logPath}'`,
    "    echo 'rule15-precheck: a plan record rides with code' >&2",
    "    exit 1",
    "  fi",
    `  echo "accepted $lsha" >> '${logPath}'`,
    "done",
    "exit 0",
    "",
  ].join("\n");
}

function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}census-push-root-`));
  const planPath = join(root, "tasks.yaml");
  const logPath = join(root, "hook.log");
  writeFileSync(planPath, FIXTURE_PLAN);
  writeFileSync(logPath, "");
  const origin = gitRepo({ bare: true, kind: "census-push-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "census-push-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  mkdirSync(join(seed.dir, "plan"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), FIXTURE_PLAN);
  mkdirSync(join(seed.dir, "hooks"), { recursive: true });
  writeFileSync(join(seed.dir, "hooks", "pre-push"), hookScript(logPath));
  chmodSync(join(seed.dir, "hooks", "pre-push"), 0o755);
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const repoDir = join(root, "repos", "remudero");
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "fixture@remudero.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero test fixture"]);
  return {
    root,
    planPath,
    config: { claudeBin: "/bin/true", root, installRoot: process.cwd() },
    origin: origin.dir,
    hookLog: () => readFileSync(logPath, "utf8").split("\n").filter(Boolean),
    cleanup: () => {
      origin.cleanup();
      seed.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function readLedger(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function commitIn(cwd: string, message: string, edit: () => void): void {
  edit();
  execFileSync("git", ["-C", cwd, "add", "-A"]);
  execFileSync("git", ["-C", cwd, "commit", "-q", "-m", message]);
}

type FixRound = (args: SpawnWorkerArgs) => void | Promise<void>;

/** Recon, then an implement worker that commits `census.red`, then every FIX prompt to `fix`. */
function scriptedSpawn(fix: FixRound, fixCalls: SpawnWorkerArgs[]): typeof spawnWorker {
  let calls = 0;
  return async (args) => {
    calls += 1;
    if (calls === 1) return workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" });
    if (String(args.prompt).startsWith("You are a FIX worker")) {
      fixCalls.push(args);
      await fix(args);
      return workerResult({ sessionId: `fix-session-${fixCalls.length}`, text: "REPORT\nfixed the census\n" });
    }
    commitIn(args.cwd!, "feat: the finished build", () => writeFileSync(join(args.cwd!, "census.red"), "Date.now()\n"));
    return workerResult({ text: "REPORT\nbuilt it\n" });
  };
}

async function drive(fx: Fixture, fix: FixRound, extra: { spawnWallClockBoundMs?: number } = {}) {
  const fixCalls: SpawnWorkerArgs[] = [];
  // Offline `gh`: PR creation answers nothing, so a run that got past its push ends on `no PR opened`.
  const gh = ghShim([], { kind: "census-push-gh" });
  const savedPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${savedPath}`;
  try {
    const outcome = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath: fx.planPath,
        config: fx.config,
        github: OFFLINE_GITHUB,
        spawn: scriptedSpawn(fix, fixCalls),
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
        ...extra,
      }),
    ).then(
      (result) => ({ result, error: undefined as unknown }),
      (error: unknown) => ({ result: undefined, error }),
    );
    return { ...outcome, fixCalls, ledger: readLedger(fx.root) };
  } finally {
    process.env.PATH = savedPath;
    rmSync(gh.dir, { recursive: true, force: true });
  }
}

const rows = (ledger: Array<Record<string, unknown>>, step: string) => ledger.filter((row) => row.step === step);

function originBranchTree(fx: Fixture): string[] {
  const heads = execFileSync("git", ["-C", fx.origin, "for-each-ref", "--format=%(refname)", "refs/heads/run-*"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.equal(heads.length, 1, "exactly one run branch reached origin");
  return execFileSync("git", ["-C", fx.origin, "ls-tree", "-r", "--name-only", heads[0]!], { encoding: "utf8" }).split("\n").filter(Boolean);
}

test("W1-T4656: a census refusal reaches the fix rung with the refusal text, and the retried push goes through the hook", async () => {
  const fx = buildFixture();
  try {
    const run = await drive(fx, (args) =>
      commitIn(args.cwd!, "fix: move the clock read onto the port", () => execFileSync("git", ["-C", args.cwd!, "rm", "-q", "census.red"])),
    );
    assert.equal(run.error, undefined, `the run must not throw: ${String((run.error as Error)?.message)}`);
    assert.equal(rows(run.ledger, "run.error").length, 0, "a census refusal is a repairable gate failure, never run.error");

    assert.equal(run.fixCalls.length, 1, "one strike cleared it");
    const prompt = String(run.fixCalls[0]!.prompt);
    assert.match(prompt, /MODE: ci-log/);
    assert.ok(prompt.includes(REFUSAL_HEAD) && prompt.includes(REFUSAL_ROW.trim()), "the fix rung is handed the hook's own refusal text");
    assert.match(prompt, /never .*--no-verify/i, "the rung is told never to bypass the hook");
    assert.equal(run.fixCalls[0]!.resumeSessionId, "implement-session", "strike 1 resumes the implement session, as the rung does");

    const refused = rows(run.ledger, "census_push.refused");
    assert.equal(refused.length, 1);
    assert.deepEqual(refused[0]!.censuses, ["clock-signature"]);
    const cleared = rows(run.ledger, "census_push.cleared");
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0]!.remedy, "code-change");
    assert.deepEqual(cleared[0]!.baseline_files, []);
    assert.equal(cleared[0]!.strikes, 1);

    const hook = fx.hookLog();
    assert.match(hook[0] ?? "", /^refused [0-9a-f]{40}$/, "the first push was refused by the hook");
    assert.match(hook[1] ?? "", /^accepted [0-9a-f]{40}$/, "the retried push ran the hook and passed it");
    assert.notEqual(hook[0]!.split(" ")[1], hook[1]!.split(" ")[1], "the accepted push carries the rung's new head");
    assert.ok(!originBranchTree(fx).includes("census.red"), "origin holds the repaired branch");

    const verdicts = rows(run.ledger, "verdict");
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]!.reason, "no PR opened", "the run went on past its push to PR creation");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4656: a baseline row the refusal itself offers is a legitimate remedy, and it is ledgered as one", async () => {
  const fx = buildFixture();
  try {
    const run = await drive(fx, (args) =>
      commitIn(args.cwd!, "chore: record the clock row", () => {
        mkdirSync(join(args.cwd!, "scripts"), { recursive: true });
        writeFileSync(join(args.cwd!, CLOCK_BASELINE), JSON.stringify({ "census.red": { dateNow: 1 } }));
      }),
    );
    assert.equal(run.error, undefined);
    const cleared = rows(run.ledger, "census_push.cleared");
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0]!.remedy, "baseline-row");
    assert.deepEqual(cleared[0]!.baseline_files, [CLOCK_BASELINE]);
    assert.match(String(run.fixCalls[0]!.prompt), /GATE REMEDY[^\n]*scripts\/clock-signature-baseline\.json \(gate: census-precheck\)/);
    assert.match(fx.hookLog()[1] ?? "", /^accepted /);
  } finally {
    fx.cleanup();
  }
});

test("W1-T4656: a refusal the rung cannot clear ends with a terminal census verdict, no run.error, and the worktree kept", async () => {
  const fx = buildFixture();
  try {
    const run = await drive(fx, () => {});
    assert.equal(run.error, undefined, "the run resolves with a verdict instead of throwing");
    assert.equal(run.result?.verdict, "failed");
    assert.equal(rows(run.ledger, "run.error").length, 0);
    assert.equal(run.fixCalls.length, 2, "bounded by the rung's own strike cap (default 2)");
    assert.equal(run.fixCalls[1]!.resumeSessionId, undefined, "strike 2 is a fresh worker, as the rung's ladder has it");
    assert.deepEqual(fx.hookLog().map((l) => l.split(" ")[0]), ["refused", "refused", "refused"], "every retry went through the hook");

    const verdicts = rows(run.ledger, "verdict");
    assert.equal(verdicts.length, 1);
    const verdict = verdicts[0]!;
    assert.equal(verdict.verdict, "failed");
    assert.equal(verdict.stage, "fallback_push.census");
    assert.equal(verdict.cause, "census-refused-push");
    assert.deepEqual(verdict.censuses, ["clock-signature"]);
    assert.equal(verdict.strikes, 2);
    assert.ok(String(verdict.refusal).startsWith(REFUSAL_HEAD));
    assert.match(String(verdict.head_sha), /^[0-9a-f]{40}$/);
    assert.equal(rows(run.ledger, "worktree.remove").length, 0, "the unpushable branch is kept as evidence, not reaped");
    const worktree = rows(run.ledger, "census_push.refused")[0]!.worktree;
    assert.ok(typeof worktree === "string" && existsSync(join(worktree, "census.red")), "the finished build is still on disk");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4656: a baseline the refusal does not offer is never pushed", async () => {
  const fx = buildFixture();
  try {
    const run = await drive(fx, (args) =>
      commitIn(args.cwd!, "chore: raise a fixture ceiling", () => {
        mkdirSync(join(args.cwd!, "scripts"), { recursive: true });
        writeFileSync(join(args.cwd!, "scripts", "fixture-copy-baseline.json"), "{}\n");
      }),
    );
    assert.equal(run.error, undefined);
    assert.equal(run.fixCalls.length, 1, "the rung stops at the unoffered baseline");
    assert.deepEqual(fx.hookLog().map((l) => l.split(" ")[0]), ["refused"], "no retry push was attempted");
    const verdict = rows(run.ledger, "verdict")[0]!;
    assert.equal(verdict.cause, "census-refused-push");
    assert.match(String(verdict.reason), /scripts\/fixture-copy-baseline\.json/);
  } finally {
    fx.cleanup();
  }
});

test("W1-T4656: a retried push refused by a NON-census check still takes the run.error path", async () => {
  const fx = buildFixture();
  try {
    const run = await drive(fx, (args) =>
      commitIn(args.cwd!, "fix: trade one red for another", () => {
        execFileSync("git", ["-C", args.cwd!, "rm", "-q", "census.red"]);
        writeFileSync(join(args.cwd!, "other.red"), "x\n");
      }),
    );
    assert.match(String((run.error as Error)?.message), /rule15-precheck/);
    assert.equal(rows(run.ledger, "run.error").length, 1);
    assert.equal(rows(run.ledger, "verdict")[0]!.cause, "git-push-failed");
    assert.deepEqual(fx.hookLog().map((l) => l.split(" ")[0]), ["refused", "other"]);
  } finally {
    fx.cleanup();
  }
});

test("W1-T4656: a fix worker that outlives the rung's wall-clock bound ends the census rung, not the run", async () => {
  const fx = buildFixture();
  try {
    const run = await drive(fx, () => new Promise((resolve) => setTimeout(resolve, 400)), { spawnWallClockBoundMs: 20 });
    assert.equal(run.error, undefined);
    const verdict = rows(run.ledger, "verdict")[0]!;
    assert.equal(verdict.cause, "census-refused-push");
    assert.match(String(verdict.reason), /abandoned/);
    await new Promise((resolve) => setTimeout(resolve, 450));
  } finally {
    fx.cleanup();
  }
});

test("W1-T4656: censusPushRefusal reads the hook's block, its census names, and the baselines it offers", () => {
  const err = new Error(
    [
      "Command failed: git -C /w/run-W1-T1-1 push origin HEAD",
      "pre-push: rule15-precheck could not read the diff — not blocking on an unreadable check",
      "census-precheck: this branch grows 3 census count(s) CI will refuse:",
      "  clock-signature: src/run-task.ts dateNow 54 > baseline 53 — move it onto src/lib/clock.ts's Clock port, or record the row in scripts/clock-signature-baseline.json",
      '  comment-load: src/x.ts has 900 comment lines > ceiling 800 — trim them, or record "src/x.ts": 1000 in scripts/comment-load-baseline.json',
      "  fixture-copy: mkdtemp 5 > baseline 4 — build the fixture with test/helpers/ instead of by hand",
      "",
      "pre-push REFUSED. These are checks CI runs on this diff; fixing them here costs one",
      "error: failed to push some refs to 'origin'",
    ].join("\n"),
  );
  const refusal = censusPushRefusal(err) as CensusPushRefusal;
  assert.deepEqual(refusal.censuses, ["clock-signature", "comment-load", "fixture-copy"]);
  assert.deepEqual(refusal.offeredBaselines, ["scripts/clock-signature-baseline.json", "scripts/comment-load-baseline.json"]);
  assert.equal(refusal.text.split("\n").length, 4, "the block stops at the hook's own trailer");
  assert.equal(censusPushRefusal(new Error("Command failed: git push\nremote: Internal Server Error")), undefined);
  assert.equal(censusPushRefusal(new Error("census-precheck: could not measure — git merge-base: no diagnostic")), undefined);
  assert.equal(censusPushRefusal("census-precheck: this branch grows 0 census count(s) CI will refuse:"), undefined, "no rows, nothing to repair");
});
