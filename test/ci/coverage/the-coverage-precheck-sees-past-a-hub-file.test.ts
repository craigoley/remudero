// W1-T5309 — the push coverage precheck read `unavailable` on 77% of pushes (401 rows, 2026-10-13..21) and refused
// none, so CI's coverage-ratchet found the uncovered lines a fix round later. One hub file in a diff
// (src/run-task.ts: ~930 direct-importer suites) put the whole narrow pass over its ceiling, the precheck ignored
// .mjs sources CI's gate judges, and the narrow advisory it did produce never reached the worker. The runTask tests
// drive the REAL runTask against a local origin whose hook logs each run-branch push, injecting only the
// instrumented run.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedSourceFiles } from "#scripts/diff-coverage.mjs";
import type { AffectedSelection } from "#src/lib/affected-suites.js";
import type { Config } from "#src/lib/config.js";
import type { ProbeExecResult } from "#src/lib/containment.js";
import {
  COVERAGE_SOURCE_FILE,
  coverageNarrowSuites,
  judgeCoverage,
  narrowListing,
  type CoverageJudgement,
  type CoverageRun,
} from "#src/lib/coverage-narrow.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "#src/lib/isolation.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { GitHub } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "#src/lib/worker.js";
import {
  coveragePrecheck,
  pushFixRoundPrechecked,
  runTask,
  type CoveragePrecheckPorts,
  type CoverageRunResult,
} from "#src/run-task.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { usePassThroughProofSandbox } from "#test/helpers/pass-through-proof-sandbox.js";

usePassThroughProofSandbox();

const CEILING = 40;
const blockedOn = (...lines: string[]) =>
  ["diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests; cover each line:", ...lines.map((l) => `  - ${l}`)].join("\n");
const ok: CoverageRun = { status: 0, output: "diff-coverage: OK", timedOut: false };
const wide = (n: number) => Array.from({ length: n }, (_, i) => `test/reach-${String(i).padStart(4, "0")}.test.ts`);

/** A tree whose diff touches a HUB (45 direct-importer suites) and a small module (its own test and one importer). */
function hubAndSmallTree(): { dir: string; changed: string[] } {
  const tree = gitRepo({ kind: "w5309-hub-tree" });
  mkdirSync(join(tree.dir, "test"), { recursive: true });
  writeFileSync(join(tree.dir, "test", "own.test.ts"), 'import { small } from "../src/lib/small.ts";\nsmall();\n');
  writeFileSync(join(tree.dir, "test", "small-importer.test.ts"), 'import { small } from "../src/lib/small.ts";\nsmall();\n');
  for (let i = 0; i < 45; i++) {
    writeFileSync(join(tree.dir, "test", `hub-${String(i).padStart(2, "0")}.test.ts`), 'import { hub } from "../src/hub.ts";\nhub();\n');
  }
  tree.git("add", "-A");
  tree.git("commit", "-q", "-m", "tree");
  return { dir: tree.dir, changed: ["src/hub.ts", "src/lib/small.ts", "test/own.test.ts"] };
}

function judgement(narrow: string[], results: CoverageRun[], calls: string[][], over: Partial<CoverageJudgement> = {}): CoverageJudgement {
  const reach = wide(2000);
  return {
    narrow,
    narrowUnreadable: "",
    selection: { suites: reach, fullRun: false, reasons: [] },
    passes: [reach],
    ceiling: CEILING,
    bounded: async (s) => {
      calls.push(s);
      return { predictedMs: 1, boundMs: 5000, r: results.shift() ?? ok };
    },
    head: () => "head-sha",
    isUncovered: (output) => /^diff-coverage: BLOCKED -- this diff adds/m.test(output),
    refusalText: (output) => output,
    isMissingSf: (output) => /no SF record in the coverage report/.test(output),
    ...over,
  };
}

test("W1-T5309: a hub file in the diff no longer blinds the narrow pass to a small module", async () => {
  const { dir, changed } = hubAndSmallTree();
  const narrow = await coverageNarrowSuites(dir, changed);
  assert.equal(narrow.length, 47, "the listing itself is every own and direct-importer suite, over the ceiling");
  const calls: string[][] = [];
  const result = await judgeCoverage(judgement(narrow, [{ status: 1, output: blockedOn("src/lib/small.ts:109", "src/hub.ts:7"), timedOut: false }], calls));
  assert.deepEqual(calls, [["test/hub-00.test.ts", "test/own.test.ts", "test/small-importer.test.ts"]],
    "the small module's whole group ran, plus ONE hub importer so the hub keeps its SF record; the 45-suite hub group did not");
  assert.equal(result.outcome, "uncovered-narrow", "advisory, never `uncovered`: the reach is still over the ceiling");
  if (result.outcome !== "uncovered-narrow") assert.fail("expected the narrow advisory");
  assert.match(result.text, /src\/lib\/small\.ts:109/);
  assert.doesNotMatch(result.text, /src\/hub\.ts:7/, "a line in a file whose importers did not all run is never a gap");
  assert.equal(result.suites, 3);
  assert.equal(result.head, "head-sha");
});

test("W1-T5309: a per-file narrow run that covers every added line is covered", async () => {
  const { dir, changed } = hubAndSmallTree();
  const calls: string[][] = [];
  const result = await judgeCoverage(judgement(await coverageNarrowSuites(dir, changed), [ok], calls));
  assert.equal(result.outcome, "covered", "a suite subset covering every added line is a sound verdict");
  assert.equal(calls.length, 1);
});

test("W1-T5309: a gap only in an unmeasured hub file is no advisory", async () => {
  const { dir, changed } = hubAndSmallTree();
  const result = await judgeCoverage(judgement(await coverageNarrowSuites(dir, changed), [{ status: 1, output: blockedOn("src/hub.ts:7"), timedOut: false }], []));
  assert.equal(result.outcome, "unavailable");
  if (result.outcome !== "unavailable") assert.fail("expected no verdict");
  assert.match(result.reason, /too wide to precheck quickly/);
  assert.match(result.reason, /1 changed source file\(s\) had too many direct-importer suites to measure/);
});

test("W1-T5309: own tests alone over the ceiling still run nothing", async () => {
  const own = wide(41);
  const calls: string[][] = [];
  const result = await judgeCoverage(judgement(narrowListing({ own, importers: new Map([["src/a.ts", ["test/a.test.ts"]]]) }), [], calls));
  assert.deepEqual(calls, []);
  assert.equal(result.outcome, "unavailable");
  assert.match((result as { reason: string }).reason, /42 own and direct-importer suite\(s\) were not measured/);
});

test("W1-T5309: a listing that fits the ceiling still runs whole, and its gap still refuses when the reach is inside it", async () => {
  const narrow = narrowListing({ own: ["test/own.test.ts"], importers: new Map([["src/a.ts", ["test/a.test.ts"]]]) });
  const calls: string[][] = [];
  const blocked: CoverageRun = { status: 1, output: blockedOn("src/a.ts:3"), timedOut: false };
  const result = await judgeCoverage(judgement(narrow, [blocked], calls, { selection: { suites: [...narrow], fullRun: false, reasons: [] }, passes: [[...narrow]] }));
  assert.deepEqual(calls, [narrow]);
  assert.equal(result.outcome, "uncovered");
});

// ── the .mjs parity gap ──

const offlineSelection = (suites: string[], over: Partial<AffectedSelection> = {}): AffectedSelection => ({ suites, fullRun: false, reasons: [], recentOnly: { floor: [] }, ...over });

test("W1-T5309: the precheck judges a changed mjs source file as CI does", async () => {
  const paths = ["src/a.ts", "src/lib/b.mjs", "scripts/c.mjs", "scripts/lib/d.mjs", "scripts/e.ts", "bin/f.mjs", "src/g.js", "test/h.test.ts", "docs/i.md"];
  const diff = paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -0,0 +1 @@\n+x`).join("\n");
  assert.deepEqual(paths.filter((p) => COVERAGE_SOURCE_FILE.test(p)).sort(), changedSourceFiles(diff), "the precheck's source predicate is CI's gate predicate");

  const calls: string[][] = [];
  const result = await coveragePrecheck("/w", {
    changedFiles: () => ["scripts/c.mjs", "test/c.test.ts"],
    narrow: async () => ["test/c.test.ts"],
    select: () => offlineSelection(["test/c.test.ts"]),
    manifest: () => ({ thresholdMs: 5000, files: {} }),
    run: (_wt, s) => {
      calls.push(s);
      return { status: 0, output: "diff-coverage: OK", timedOut: false };
    },
  });
  assert.equal(result.outcome, "covered");
  assert.deepEqual(calls, [["test/c.test.ts"]], "an .mjs-only diff is measured, never `no changed src file`");

  const tree = gitRepo({ kind: "w5309-mjs-tree" });
  mkdirSync(join(tree.dir, "test"), { recursive: true });
  writeFileSync(join(tree.dir, "test", "c.test.ts"), 'import { c } from "../scripts/c.mjs";\nc();\n');
  tree.git("add", "-A");
  tree.git("commit", "-q", "-m", "tree");
  assert.deepEqual(await coverageNarrowSuites(tree.dir, ["scripts/c.mjs"]), ["test/c.test.ts"], "an .mjs file's direct importers join the narrow pass");
});

// ── the implement push acts on the narrow advisory ──

const TASK_ID = "T-NARROW-ADVISORY";
const FIXTURE_PLAN = [
  `- id: ${TASK_ID}`,
  "  title: a narrow advisory gets one pre-PR repair",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/feature.ts, test/feature.test.ts]",
  "  origin: test",
  "  status: queued",
  "",
].join("\n");

const offlineHub: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });
const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "implement-session", costUsd: 0.02, numTurns: 1, text: "", blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    ...over,
  };
}

/** The precheck's narrow pass leaves src/feature.ts:1 uncovered and the reach is 2000 suites: `uncovered-narrow`. */
function narrowGapPorts(): { ports: CoveragePrecheckPorts; calls: string[][] } {
  const calls: string[][] = [];
  const answers: CoverageRunResult[] = [{ status: 1, output: blockedOn("src/feature.ts:1"), timedOut: false }];
  return {
    calls,
    ports: {
      changedFiles: () => ["src/feature.ts"],
      narrow: async () => ["test/feature.test.ts"],
      select: () => offlineSelection(wide(2000)),
      manifest: () => ({ thresholdMs: 5000, files: {} }),
      run: (_wt, s) => {
        calls.push(s);
        return answers.shift() ?? { status: 0, output: "diff-coverage: OK", timedOut: false };
      },
    },
  };
}

interface Stage { root: string; planPath: string; config: Config; hookLog: () => string[]; cleanup: () => void }

const hookScript = (logPath: string): string =>
  ["#!/bin/sh", "while read -r _lref lsha rref _rsha; do", '  case "$rref" in refs/heads/run-*) ;; *) continue ;; esac', `  echo "accepted $lsha" >> '${logPath}'`, "done", "exit 0", ""].join("\n");

function buildStage(): Stage {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5309-stage-`));
  const planPath = join(root, "tasks.yaml");
  const logPath = join(root, "hook.log");
  writeFileSync(planPath, FIXTURE_PLAN);
  writeFileSync(logPath, "");
  const origin = gitRepo({ bare: true, kind: "w5309-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "w5309-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  mkdirSync(join(seed.dir, "plan"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), FIXTURE_PLAN);
  mkdirSync(join(seed.dir, "hooks"), { recursive: true });
  writeFileSync(join(seed.dir, "hooks", "pre-push"), hookScript(logPath));
  chmodSync(join(seed.dir, "hooks", "pre-push"), 0o755);
  process.env.RMD_HARNESS_HOOKS_DIR = join(seed.dir, "hooks");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const managed = gitRepo({ cloneFrom: origin.dir, kind: "w5309-managed" });
  managed.git("config", "user.email", "fixture@remudero.invalid");
  managed.git("config", "user.name", "remudero test fixture");
  renameSync(managed.dir, join(root, "repos", "remudero"));
  return {
    root, planPath,
    config: { claudeBin: "/bin/true", root, installRoot: process.cwd() },
    hookLog: () => readFileSync(logPath, "utf8").split("\n").filter(Boolean),
    cleanup: () => {
      origin.cleanup();
      seed.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const readRows = (root: string): Array<Record<string, unknown>> =>
  readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const rowsOf = (rows: Array<Record<string, unknown>>, step: string) => rows.filter((row) => row.step === step);

const execGit = (cwd: string, args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function commitIn(cwd: string, message: string, edit: () => void): string {
  edit();
  execGit(cwd, ["add", "-A"]);
  execGit(cwd, ["commit", "-q", "-m", message]);
  return execGit(cwd, ["rev-parse", "HEAD"]);
}

/** Recon, then an implement worker that commits `src/feature.ts`, then every FIX prompt to `fix`. */
function scriptedSpawn(fix: (args: SpawnWorkerArgs) => void, fixCalls: SpawnWorkerArgs[], built: string[]): typeof spawnWorker {
  let calls = 0;
  return async (args) => {
    calls += 1;
    if (calls === 1) return workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" });
    if (String(args.prompt).startsWith("You are a FIX worker")) {
      fixCalls.push(args);
      fix(args);
      return workerResult({ sessionId: `fix-session-${fixCalls.length}`, text: "REPORT\nrepair round\n" });
    }
    built.push(commitIn(args.cwd!, "feat: the feature", () => {
      mkdirSync(join(args.cwd!, "src"), { recursive: true });
      writeFileSync(join(args.cwd!, "src", "feature.ts"), "export const a = 1;\nexport const b = 2;\n");
    }));
    return workerResult({ text: "REPORT\nbuilt it\n" });
  };
}

async function drive(stage: Stage, ports: CoveragePrecheckPorts, fix: (args: SpawnWorkerArgs) => void = () => {}) {
  const fixCalls: SpawnWorkerArgs[] = [];
  const built: string[] = [];
  const shim = ghShim([], { kind: "w5309-gh" });
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  try {
    const outcome = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true, planPath: stage.planPath, config: stage.config, github: offlineHub,
        spawn: scriptedSpawn(fix, fixCalls, built), containmentExec: holdingContainmentExec, isolationExec: cleanIsolationExec,
        coveragePrecheckPorts: ports,
      }),
    ).then((result) => ({ result, error: undefined as unknown }), (error: unknown) => ({ result: undefined, error }));
    return { ...outcome, fixCalls, built, rows: readRows(stage.root) };
  } finally {
    process.env.PATH = savedPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

test("W1-T5309: an uncovered-narrow implement push gets one pre-PR repair, then pushes", async () => {
  const stage = buildStage();
  try {
    const { ports, calls } = narrowGapPorts();
    const run = await drive(stage, ports);
    assert.equal(run.error, undefined, `the run must not throw: ${String((run.error as Error)?.message)}`);
    assert.equal(run.fixCalls.length, 1, "exactly one repair attempt, before any PR exists");
    const prompt = String(run.fixCalls[0]!.prompt);
    assert.ok(prompt.includes("src/feature.ts:1"), "the worker is handed the narrow pass's own uncovered line");
    assert.equal(stage.hookLog()[0], `accepted ${run.built[0]}`, "the repair changed nothing, and the head pushed anyway");
    assert.notEqual(run.result?.verdict, "failed", "an advisory gap never fails the build");
    assert.equal(calls.length, 1, "no recheck gates the push: CI stays the authority");
    assert.deepEqual(rowsOf(run.rows, "push.coverage_precheck").map((r) => [r.site, r.outcome]), [["fallback_push", "uncovered-narrow"]]);
  } finally {
    stage.cleanup();
  }
});

test("W1-T5309: a repaired narrow gap pushes the repaired head first", async () => {
  const stage = buildStage();
  try {
    const run = await drive(stage, narrowGapPorts().ports, (args) => {
      commitIn(args.cwd!, "test: cover the feature", () => {
        mkdirSync(join(args.cwd!, "test"), { recursive: true });
        writeFileSync(join(args.cwd!, "test", "feature.test.ts"), "// covers it\n");
      });
    });
    assert.equal(run.error, undefined, `the run must not throw: ${String((run.error as Error)?.message)}`);
    assert.equal(run.fixCalls.length, 1);
    const hook = stage.hookLog();
    assert.ok(hook.length > 0, "the branch was pushed");
    assert.ok(hook.every((l) => !l.endsWith(run.built[0]!)), "the first push carries the repair, not the unrepaired commit");
  } finally {
    stage.cleanup();
  }
});

test("W1-T5309: the fix rung's push stays advisory on an uncovered-narrow head", async () => {
  const logged: Array<Record<string, unknown> | undefined> = [];
  const pushed: string[] = [];
  await pushFixRoundPrechecked((_s, extra) => void logged.push(extra), "/w", "run-b", "abc", { ...narrowGapPorts().ports, conflictMarkers: () => [] },
    (wt, _branch, sha) => void pushed.push(`${wt}@${sha}`));
  assert.deepEqual(pushed, ["/w@abc"], "the fix round's head is pushed with no repair");
  assert.equal(logged[0]?.outcome, "uncovered-narrow");
});
