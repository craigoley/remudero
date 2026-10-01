// test/a-worker-catches-its-own-diff-coverage-drop-before-pushing.test.ts — W1-T4797: coverage-ratchet is the
// fleet's costliest red check, and it was only ever discovered AFTER the push. The harness now runs CI's own
// diff-coverage, scoped, between the worker's commit and its push. The runTask tests below drive the REAL runTask
// against a real local origin whose tracked hook logs every run-branch push, and inject only the instrumented run
// (the one thing that costs minutes), so "was anything pushed yet" is read off the hook's own log.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  coveragePrecheck,
  coveragePushRefusal,
  FixRoundPushError,
  pushFixRoundPrechecked,
  runTask,
  type CoveragePrecheckPorts,
  type CoverageRunResult,
} from "../src/run-task.js";
import type { AffectedSelection } from "../src/lib/affected-suites.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const TASK_ID = "T-COVERAGE-PRECHECK";

const FIXTURE_PLAN = [
  `- id: ${TASK_ID}`,
  "  title: a worker catches its own diff-coverage drop",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/feature.ts, test/feature.test.ts]",
  "  origin: test",
  "  status: queued",
  "",
].join("\n");

const UNCOVERED_OUTPUT = [
  "diff-coverage-local: running the instrumented suite exactly as ci.yml's step does, over 1 file(s)...",
  "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests; cover each line:",
  "  - src/feature.ts:1",
  "  - src/feature.ts:2",
  "diff-coverage-local: see the gate output above",
].join("\n");

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

const selection = (suites: string[], over: Partial<AffectedSelection> = {}): AffectedSelection => ({ suites, fullRun: false, reasons: [], recentOnly: { floor: [] }, ...over });

const ran = (status: number | null, output = "", over: Partial<CoverageRunResult> = {}): CoverageRunResult => ({ status, output, timedOut: false, ...over });

/** Ports whose instrumented run answers from a script, recording every call it was made with. */
function scriptedPorts(answers: CoverageRunResult[], suites: string[] = ["test/feature.test.ts"], files: Record<string, number> = {}) {
  const calls: Array<{ suites: string[]; timeoutMs: number }> = [];
  const ports: CoveragePrecheckPorts = {
    changedFiles: () => ["src/feature.ts"],
    select: () => selection(suites),
    manifest: () => ({ thresholdMs: 5000, files }),
    run: (_wt, s, timeoutMs) => {
      calls.push({ suites: s, timeoutMs });
      return answers.shift() ?? ran(1, "diff-coverage-local: script ran out of answers");
    },
  };
  return { ports, calls };
}

interface Fixture {
  root: string;
  planPath: string;
  config: Config;
  hookLog: () => string[];
  cleanup: () => void;
}

/** The pre-push hook reduced to a ledger of every run-branch push it sees — always accepting. */
const hookScript = (logPath: string): string =>
  ["#!/bin/sh", "while read -r _lref lsha rref _rsha; do", '  case "$rref" in refs/heads/run-*) ;; *) continue ;; esac', `  echo "accepted $lsha" >> '${logPath}'`, "done", "exit 0", ""].join("\n");

function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}coverage-precheck-root-`));
  const planPath = join(root, "tasks.yaml");
  const logPath = join(root, "hook.log");
  writeFileSync(planPath, FIXTURE_PLAN);
  writeFileSync(logPath, "");
  const origin = gitRepo({ bare: true, kind: "coverage-precheck-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "coverage-precheck-seed" });
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
    hookLog: () => readFileSync(logPath, "utf8").split("\n").filter(Boolean),
    cleanup: () => {
      origin.cleanup();
      seed.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const readLedger = (root: string): Array<Record<string, unknown>> =>
  readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const rows = (ledger: Array<Record<string, unknown>>, step: string) => ledger.filter((row) => row.step === step);

function commitIn(cwd: string, message: string, edit: () => void): string {
  edit();
  execFileSync("git", ["-C", cwd, "add", "-A"]);
  execFileSync("git", ["-C", cwd, "commit", "-q", "-m", message]);
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** Recon, then an implement worker that commits `src/feature.ts`, then every FIX prompt to `fix`. */
function scriptedSpawn(fix: (args: SpawnWorkerArgs) => string, fixCalls: SpawnWorkerArgs[], built: string[]): typeof spawnWorker {
  let calls = 0;
  return async (args) => {
    calls += 1;
    if (calls === 1) return workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" });
    if (String(args.prompt).startsWith("You are a FIX worker")) {
      fixCalls.push(args);
      fix(args);
      return workerResult({ sessionId: `fix-session-${fixCalls.length}`, text: "REPORT\nadded the tests\n" });
    }
    built.push(
      commitIn(args.cwd!, "feat: the feature", () => {
        mkdirSync(join(args.cwd!, "src"), { recursive: true });
        writeFileSync(join(args.cwd!, "src", "feature.ts"), "export const a = 1;\nexport const b = 2;\n");
      }),
    );
    return workerResult({ text: "REPORT\nbuilt it\n" });
  };
}

async function drive(fx: Fixture, ports: CoveragePrecheckPorts, fix: (args: SpawnWorkerArgs) => string = () => "") {
  const fixCalls: SpawnWorkerArgs[] = [];
  const built: string[] = [];
  const shim = ghShim([], { kind: "coverage-precheck-gh" });
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  try {
    const outcome = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath: fx.planPath,
        config: fx.config,
        github: OFFLINE_GITHUB,
        spawn: scriptedSpawn(fix, fixCalls, built),
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
        coveragePrecheckPorts: ports,
      }),
    ).then(
      (result) => ({ result, error: undefined as unknown }),
      (error: unknown) => ({ result: undefined, error }),
    );
    return { ...outcome, fixCalls, built, ledger: readLedger(fx.root) };
  } finally {
    process.env.PATH = savedPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

test("W1-T4797: a commit that drops diff coverage is returned to the worker before any push", async () => {
  const fx = buildFixture();
  try {
    const { ports, calls } = scriptedPorts([ran(1, UNCOVERED_OUTPUT), ran(0, "diff-coverage: OK")]);
    const run = await drive(fx, ports, (args) =>
      commitIn(args.cwd!, "test: cover the feature", () => {
        mkdirSync(join(args.cwd!, "test"), { recursive: true });
        writeFileSync(join(args.cwd!, "test", "feature.test.ts"), "// covers it\n");
      }),
    );
    assert.equal(run.error, undefined, `the run must not throw: ${String((run.error as Error)?.message)}`);
    assert.equal(run.fixCalls.length, 1, "the uncovered head went back to the worker once");
    const prompt = String(run.fixCalls[0]!.prompt);
    assert.ok(prompt.includes("src/feature.ts:1") && prompt.includes("src/feature.ts:2"), "the worker is handed CI's own uncovered lines");
    assert.match(prompt, /PRE-PUSH DIFF-COVERAGE/);

    const hook = fx.hookLog();
    assert.notEqual(hook[0]!.split(" ")[1], run.built[0], "the FIRST push carries the repaired head, never the uncovered commit");
    assert.ok(hook.every((l) => !l.endsWith(run.built[0]!)), "the uncovered commit never reached origin");
    assert.equal(calls.length, 2, "the precheck re-ran after the repair commit, before the push");

    const prechecks = rows(run.ledger, "push.coverage_precheck");
    assert.deepEqual(prechecks.map((r) => [r.site, r.outcome]), [["fallback_push", "uncovered"], ["fallback_push.repair", "covered"]]);
    assert.match(String(prechecks[0]!.refusal), /src\/feature\.ts:1/);
    assert.deepEqual(rows(run.ledger, "census_push.refused")[0]!.censuses, ["diff-coverage"]);
    assert.equal(rows(run.ledger, "census_push.cleared").length, 1);
  } finally {
    fx.cleanup();
  }
});

test("W1-T4797: a still-uncovered repair gets a second strike before any push", async () => {
  const fx = buildFixture();
  try {
    const { ports, calls } = scriptedPorts([ran(1, UNCOVERED_OUTPUT), ran(1, UNCOVERED_OUTPUT), ran(0, "diff-coverage: OK")]);
    let repair = 0;
    const run = await drive(fx, ports, (args) => {
      repair += 1;
      return commitIn(args.cwd!, `test: repair coverage round ${repair}`, () => {
        mkdirSync(join(args.cwd!, "test"), { recursive: true });
        writeFileSync(join(args.cwd!, "test", "feature.test.ts"), `// coverage repair ${repair}\n`);
      });
    });
    assert.equal(run.error, undefined);
    assert.equal(run.fixCalls.length, 2, "a still-uncovered first repair spends the second bounded strike");
    assert.equal(calls.length, 3, "the gate checks the original commit and both repairs");
    assert.deepEqual(rows(run.ledger, "push.coverage_precheck").map((r) => r.outcome), ["uncovered", "uncovered", "covered"]);
    assert.equal(rows(run.ledger, "census_push.refused").length, 2);
    assert.equal(rows(run.ledger, "census_push.cleared").length, 1);
    assert.ok(fx.hookLog().every((line) => !line.endsWith(run.built[0]!)), "the uncovered original never reached origin");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4797: two still-uncovered repairs leave the branch unpushed with a failed verdict", async () => {
  const fx = buildFixture();
  try {
    const { ports, calls } = scriptedPorts([ran(1, UNCOVERED_OUTPUT), ran(1, UNCOVERED_OUTPUT), ran(1, UNCOVERED_OUTPUT)]);
    let repair = 0;
    const run = await drive(fx, ports, (args) => {
      repair += 1;
      return commitIn(args.cwd!, `test: incomplete coverage round ${repair}`, () => {
        mkdirSync(join(args.cwd!, "test"), { recursive: true });
        writeFileSync(join(args.cwd!, "test", "feature.test.ts"), `// incomplete repair ${repair}\n`);
      });
    });
    assert.equal(run.error, undefined);
    assert.equal(run.result?.verdict, "failed");
    assert.equal(run.fixCalls.length, 2, "the fix rung spends only its two allowed strikes");
    assert.equal(calls.length, 3);
    assert.deepEqual(fx.hookLog(), [], "an uncovered branch never leaves the worktree");
    const verdict = rows(run.ledger, "verdict").at(-1);
    assert.match(String(verdict?.reason), /coverage-refused push not cleared by the fix rung/);
  } finally {
    fx.cleanup();
  }
});

test("W1-T4797: the default precheck shells out with its scoped suite from the worktree", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}coverage-precheck-spawn-`));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "diff-coverage-local.mjs"),
      `import { cwd, argv } from "node:process";\nif (cwd() !== ${JSON.stringify(realpathSync(root))} || !argv.includes("test/feature.test.ts")) process.exit(2);\nprocess.stdout.write("diff-coverage: OK\\n");\n`);
    const ports = scriptedPorts([]).ports;
    const result = coveragePrecheck(root, { ...ports, run: undefined });
    assert.equal(result.outcome, "covered", `the real child process executes the scoped precheck: ${JSON.stringify(result)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4797: a covered commit pushes with no extra round", async () => {
  const fx = buildFixture();
  try {
    const { ports, calls } = scriptedPorts([ran(0, "diff-coverage: OK -- every added source line lcov instruments is covered.")]);
    const run = await drive(fx, ports);
    assert.equal(run.error, undefined);
    assert.equal(run.fixCalls.length, 0, "no repair round was spent");
    assert.equal(calls.length, 1);
    assert.equal(fx.hookLog()[0], `accepted ${run.built[0]}`, "the worker's own commit is what was pushed first");
    const prechecks = rows(run.ledger, "push.coverage_precheck");
    assert.equal(prechecks.length, 1);
    assert.equal(prechecks[0]!.outcome, "covered");
    assert.equal(rows(run.ledger, "census_push.refused").length, 0);
  } finally {
    fx.cleanup();
  }
});

test("W1-T4797: a precheck that cannot run pushes anyway and ledgers why", async () => {
  const fx = buildFixture();
  try {
    const { ports } = scriptedPorts([ran(null, "", { timedOut: true })]);
    const run = await drive(fx, ports);
    assert.equal(run.error, undefined);
    assert.equal(run.fixCalls.length, 0, "an unavailable precheck never sends the worker back");
    assert.equal(fx.hookLog()[0], `accepted ${run.built[0]}`, "the push went ahead");
    const prechecks = rows(run.ledger, "push.coverage_precheck");
    assert.equal(prechecks.length, 1);
    assert.equal(prechecks[0]!.outcome, "unavailable");
    assert.match(String(prechecks[0]!.reason), /timed out over its 5000ms bound/);
  } finally {
    fx.cleanup();
  }
});

test("W1-T4797: each way the precheck cannot look is unavailable, never uncovered", () => {
  const unavailable = (ports: CoveragePrecheckPorts) => {
    const r = coveragePrecheck("/w", ports);
    assert.equal(r.outcome, "unavailable");
    return (r as { reason: string }).reason;
  };
  const base = scriptedPorts([]).ports;
  assert.match(unavailable({ ...base, changedFiles: () => { throw new Error("git said no"); } }), /changed files unreadable: git said no/);
  assert.match(unavailable({ ...base, select: () => { throw new Error("no graph"); } }), /could not derive the affected-suite scope: no graph/);
  assert.match(unavailable({ ...base, select: () => selection([], { fullRun: true, reasons: ["full run: test/helpers/x.ts forces it"] }) }), /forces it/);
  assert.match(unavailable({ ...base, select: () => selection([]) }), /no suite reaches/);
  assert.match(unavailable(scriptedPorts([ran(null, "", { spawnError: "spawn ENOENT" })]).ports), /spawn failed: spawn ENOENT/);
  assert.match(unavailable(scriptedPorts([ran(1, "diff-coverage-local: no lcov produced -- FAILING.")]).ports), /no lcov produced/);
  assert.match(unavailable(scriptedPorts([ran(2, "")]).ports), /exited 2/);
  assert.equal(coveragePrecheck("/w", { ...base, changedFiles: () => ["docs/x.md", "test/a.test.ts"] }).outcome, "covered", "no src change, nothing to prove");
});

test("W1-T4797: the bound is the manifest's own measured duration for the suites it runs, and widening is only for a missing SF record", () => {
  const files = { "test/fast.test.ts": 1000, "test/also.test.ts": 2000, "test/slow.test.ts": 9000 };
  const missing = "diff-coverage: BLOCKED -- changed source file(s) have no SF record in the coverage report; coverage would otherwise pass vacuously:";
  const widened = scriptedPorts([ran(1, missing), ran(0, "diff-coverage: OK")], Object.keys(files), files);
  assert.equal(coveragePrecheck("/w", widened.ports).outcome, "covered");
  assert.deepEqual(widened.calls.map((c) => c.suites), [["test/fast.test.ts", "test/also.test.ts"], ["test/fast.test.ts", "test/also.test.ts", "test/slow.test.ts"]]);
  assert.deepEqual(widened.calls.map((c) => c.timeoutMs), [6000, 24000], "twice the measured sum of exactly the suites that pass runs");

  const stillMissing = scriptedPorts([ran(1, missing), ran(1, missing)], Object.keys(files), files);
  const r = coveragePrecheck("/w", stillMissing.ports);
  assert.equal(r.outcome, "unavailable");
  assert.match((r as { reason: string }).reason, /no SF record even after widening/);

  const covered = scriptedPorts([ran(0, "")], Object.keys(files), files);
  coveragePrecheck("/w", covered.ports);
  assert.equal(covered.calls.length, 1, "a covered fast tier never pays for the slow siblings");

  const slowOnly = scriptedPorts([ran(0, "")], ["test/slow.test.ts"], files);
  coveragePrecheck("/w", slowOnly.ports);
  assert.deepEqual(slowOnly.calls.map((c) => c.suites), [["test/slow.test.ts"]], "a selection with no fast suite runs its slow ones directly");
});

test("W1-T4797: an INVALID directive is refused like CI refuses it, and the refusal text stays bounded", () => {
  const invalid = `diff-coverage: INVALID process-boundary directive(s) -- the gate fails closed:\n  - src/x.ts:3 -- bad\n${"  - src/y.ts:1\n".repeat(1000)}`;
  const r = coveragePrecheck("/w", scriptedPorts([ran(1, invalid)]).ports);
  assert.equal(r.outcome, "uncovered");
  assert.ok((r as { text: string }).text.length <= 4000);
  assert.match((r as { text: string }).text, /INVALID process-boundary/);
});

test("W1-T4797: the fix rung's push is refused before it leaves the worktree when the head is uncovered", () => {
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const log = (step: string, extra?: Record<string, unknown>) => void logged.push([step, extra]);
  const pushed: string[] = [];
  const push = (wt: string, _branch: string, sha?: string) => void pushed.push(`${wt}@${sha}`);

  assert.throws(
    () => pushFixRoundPrechecked(log, "/w", "run-b", "abc", scriptedPorts([ran(1, UNCOVERED_OUTPUT)]).ports, push),
    (e: unknown) => e instanceof FixRoundPushError && /src\/feature\.ts:2/.test(e.refusal?.text ?? "") && e.refusal?.censuses[0] === "diff-coverage",
  );
  assert.deepEqual(pushed, [], "an uncovered head was never pushed");

  pushFixRoundPrechecked(log, "/w", "run-b", "def", scriptedPorts([ran(0, "")]).ports, push);
  assert.deepEqual(pushed, ["/w@def"]);
  assert.deepEqual(logged.map(([step, extra]) => [step, extra?.outcome, extra?.site]), [["push.coverage_precheck", "uncovered", "rung.fix_push"], ["push.coverage_precheck", "covered", "rung.fix_push"]]);
});

test("W1-T4797: coveragePushRefusal hands back a refusal only for an uncovered head", () => {
  const log = () => {};
  assert.equal(coveragePushRefusal({ outcome: "covered", reason: "ok", suites: 1 }, log, "s"), undefined);
  assert.equal(coveragePushRefusal({ outcome: "unavailable", reason: "x" }, log, "s"), undefined);
  assert.match(coveragePushRefusal({ outcome: "uncovered", text: "  - src/a.ts:1", suites: 1 }, log, "s")!.text, /coverage-ratchet would refuse this head/);
});
