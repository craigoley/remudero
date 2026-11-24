// W1-T14036: a review's proof phase records each execution's time, runs a fold's independent executions at once up
// to the derived slot count, and primes the base checkout while the head proofs run. The real-path tests drive
// judgeReviewAsync with no injected executor against a temp HOME whose config names a temp instance root, a fake
// `npm` first on PATH that logs each call with its start and end time, and real `node --test` proofs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import {
  judgeReview,
  judgeReviewAsync,
  proofExecutionSlots,
  registerReviewerCheckout,
  runPendingProofExecutions,
  type AsyncProofExecutor,
  type ProofExecutor,
  type ReviewEvidence,
  type ReviewVerdict,
  type WhitelistedProof,
} from "#src/lib/review.js";
import { defaultTestSlots } from "#src/lib/test-slot.js";

interface World {
  root: string;
  state: string;
  npmLog: string;
  trees: number;
}

interface NpmCall {
  argv: string[];
  cwd: string;
  startedMs: number;
  endedMs?: number;
}

interface PhaseRow {
  step: string;
  phase: string;
  fold?: number;
  side?: "head" | "base";
  kind?: "test" | "grep";
  proof?: string;
  checkout?: string;
  run_ms?: number;
  install_ms?: number;
  start_load?: unknown;
  slots?: number;
  outcome: string;
  folds?: number;
  executions?: number;
  max_slots?: number;
  total_ms?: number;
}

/** A fake npm: logs argv, cwd and its start and end time; `ci` waits the tree's `ci-delay-ms`, then writes the lockfile's
 *  packages as real ES modules exporting their locked version. */
function fakeNpm(log: string): string {
  return `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const call = { argv: process.argv.slice(2), cwd: process.cwd(), startedMs: Date.now() };
if (process.argv[2] === "--version") { console.log("10.9.9"); process.exit(0); }
if (process.argv[2] === "ci") {
  const delay = fs.existsSync("ci-delay-ms") ? Number(fs.readFileSync("ci-delay-ms", "utf8")) : 0;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  for (const [name, pkg] of Object.entries(lock.packages || {})) {
    if (!name.startsWith("node_modules/")) continue;
    const dir = path.join("node_modules", name.slice("node_modules/".length));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: name.slice(13), version: pkg.version, type: "module", exports: "./index.mjs" }));
    fs.writeFileSync(path.join(dir, "index.mjs"), "export const version = " + JSON.stringify(pkg.version) + ";\\n");
  }
}
call.endedMs = Date.now();
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(call) + "\\n");
`;
}

/** A temp HOME and instance root, the fake npm first on PATH, and the npm-ci install arm; all restored after `t`. */
function world(t: TestContext): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-proof-phase-")));
  const home = join(root, "home");
  const instance = join(root, "instance");
  const state = join(instance, "state");
  const bin = join(root, "bin");
  const npmLog = join(root, "npm.log");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root: instance }));
  writeFileSync(join(bin, "npm"), fakeNpm(npmLog), { mode: 0o755 });
  writeFileSync(npmLog, "");
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, RMD_DEPENDENCY_SEED_ROOT: process.env.RMD_DEPENDENCY_SEED_ROOT };
  process.env.HOME = home;
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
  process.env.RMD_DEPENDENCY_SEED_ROOT = "";
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { root, state, npmLog, trees: 0 };
}

/** Sets RMD_TEST_SLOTS for one test, or removes it, and restores it after `t`. */
function withTestSlots(t: TestContext, value: string | undefined): void {
  const saved = process.env.RMD_TEST_SLOTS;
  if (value === undefined) delete process.env.RMD_TEST_SLOTS;
  else process.env.RMD_TEST_SLOTS = value;
  t.after(() => {
    if (saved === undefined) delete process.env.RMD_TEST_SLOTS;
    else process.env.RMD_TEST_SLOTS = saved;
  });
}

function writePackages(dir: string, packages: Record<string, string>): void {
  for (const [name, version] of Object.entries(packages)) {
    const at = join(dir, "node_modules", name);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "package.json"), JSON.stringify({ name, version, type: "module", exports: "./index.mjs" }));
    writeFileSync(join(at, "index.mjs"), `export const version = ${JSON.stringify(version)};\n`);
  }
}

/** A reviewer-owned proof tree. Its real `node --test` proof passes only when the installed `answer` is 1.0.0, and its
 *  grep proof matches only in a head tree. `primed` writes node_modules first; otherwise the fake npm installs it. */
function proofTree(w: World, side: "head" | "base",
  options: { answer?: string; primed?: boolean; ciDelayMs?: number; testDelayMs?: number } = {}): string {
  const dir = join(w.root, `${side}-${++w.trees}`);
  const answer = options.answer ?? (side === "head" ? "1.0.0" : "2.0.0");
  mkdirSync(join(dir, "test", "setup"), { recursive: true });
  mkdirSync(join(dir, "src"));
  const manifest = { name: "phase-fixture", version: "1.0.0", dependencies: { answer, tsx: "4.0.0" } };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({
    name: "phase-fixture", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": manifest, "node_modules/answer": { version: answer }, "node_modules/tsx": { version: "4.0.0" } },
  }));
  writeFileSync(join(dir, "ci-delay-ms"), String(options.ciDelayMs ?? 0));
  writeFileSync(join(dir, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(dir, "test", "seeded.test.ts"), [
    `import assert from "node:assert/strict";`, `import { test } from "node:test";`, `import { version } from "answer";`,
    `test("the installed answer", async () => {`,
    `  await new Promise((resolve) => setTimeout(resolve, ${options.testDelayMs ?? 0}));`,
    `  assert.equal(version, "1.0.0");`, `});`, "",
  ].join("\n"));
  writeFileSync(join(dir, "src", "marker.ts"), side === "head" ? "export const proofPhaseMarker = 1;\n" : "export const unrelated = 1;\n");
  if (options.primed) writePackages(dir, { answer, tsx: "4.0.0" });
  registerReviewerCheckout(dir);
  return dir;
}

const REAL_CRITERIA: AcceptanceCriterion[] = [
  { claim: "the seeded answer is installed", proof: "unit test: test/seeded.test.ts" },
  { claim: "the proof phase marker exists", proof: "grep: proofPhaseMarker in src/marker.ts" },
];

function realEvidence(head: string, base: string): ReviewEvidence {
  return {
    diff: "diff --git a/src/marker.ts b/src/marker.ts\n+export const proofPhaseMarker = 1;\n",
    report: "the seeded answer is installed. the proof phase marker exists.",
    headCheckoutDir: head,
    baseCheckoutDir: base,
    baseIsCheckout: true,
    sampleLoad: () => ({ load1: 0.5 }),
  };
}

function phaseRows(w: World): PhaseRow[] {
  const text = readFileSync(join(w.state, LEDGER_FILENAME), { encoding: "utf8", flag: "a+" });
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as PhaseRow)
    .filter((row) => row.step === "review.proof_execution" || row.step === "review.proof_phase");
}

const executionRows = (w: World) => phaseRows(w).filter((row) => row.step === "review.proof_execution");

function npmCalls(w: World, cwd: string): NpmCall[] {
  return readFileSync(w.npmLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as NpmCall)
    .filter((call) => call.cwd === cwd && call.argv[0] === "ci");
}

const only = <T>(items: T[], what: string): T => {
  assert.equal(items.length, 1, `exactly one ${what}: ${JSON.stringify(items)}`);
  return items[0]!;
};

/** The parts of a verdict the invariant names: each criterion's proof_exec, floorMet and reason, and the state. */
function verdictShape(verdict: ReviewVerdict): unknown {
  return {
    state: verdict.state,
    criteria: verdict.criteria.map((c) => ({ proof_exec: c.proof_exec, floorMet: c.floorMet, reason: c.reason, load: c.load })),
  };
}

test("W1-T14036 criterion 1: each proof execution writes one review.proof_execution row with its side, kind, run and install milliseconds and start load, and the phase writes one review.proof_phase row", async (t) => {
  const w = world(t);
  const head = proofTree(w, "head", { ciDelayMs: 300 });
  const base = proofTree(w, "base", { primed: true });
  const verdict = await judgeReviewAsync(REAL_CRITERIA, realEvidence(head, base));
  assert.deepEqual(verdict.criteria.map((c) => c.proof_exec), ["executed_pass", "executed_pass"], JSON.stringify(verdict.criteria));

  const rows = executionRows(w);
  const headTest = only(rows.filter((row) => row.side === "head" && row.kind === "test"), "head test row");
  const baseTest = only(rows.filter((row) => row.side === "base" && row.kind === "test"), "base test row");
  only(rows.filter((row) => row.side === "head" && row.kind === "grep"), "head grep row");
  assert.equal(headTest.checkout, head);
  assert.equal(baseTest.checkout, base);
  assert.ok(headTest.install_ms! >= 250, `the head waited on its 300 ms install: ${JSON.stringify(headTest)}`);
  assert.equal(baseTest.install_ms, 0, "a checkout already primed waited on no install");
  for (const row of rows) {
    assert.equal(typeof row.run_ms, "number");
    assert.ok(row.run_ms! >= 0);
    assert.deepEqual(row.start_load, { load1: 0.5 }, "the row names the load sampled at the execution's start");
    if (row.kind === "grep") assert.equal(row.install_ms, 0, "a grep proof waits on no install");
  }
  assert.ok(headTest.run_ms! > 0, "a real node --test run takes time");

  const phase = only(phaseRows(w).filter((row) => row.step === "review.proof_phase"), "proof phase row");
  assert.equal(phase.outcome, "converged");
  assert.equal(phase.executions, rows.length, "the phase counts every execution row");
  assert.ok(phase.folds! >= 2, "a head fold, then a base fold");
  for (const row of rows) {
    assert.equal(row.phase, phase.phase, "every execution row names its phase");
    assert.ok(phase.total_ms! >= row.run_ms! + row.install_ms!, "the phase lasts at least as long as each execution");
  }
  assert.equal(new Set(rows.map((row) => row.proof)).size, 2, "the rows name the proofs they ran");

  // A review of a checkout the reviewer did not cut writes no row.
  const strangerHead = join(w.root, "stranger");
  mkdirSync(join(strangerHead, "src"), { recursive: true });
  writeFileSync(join(strangerHead, "src", "marker.ts"), "export const proofPhaseMarker = 1;\n");
  const before = phaseRows(w).length;
  await judgeReviewAsync([REAL_CRITERIA[1]!], { ...realEvidence(strangerHead, base), baseCheckoutDir: undefined, baseIsCheckout: undefined });
  assert.equal(phaseRows(w).length, before, "no rows for a stranger's checkout");
});

/** An async executor that waits `delayOf(label)` ms, answers `answerOf`, and records start order and the most runs at once. */
function timedExecutor(delayOf: (label: string, cwd: string) => number, answerOf: (label: string, cwd: string) => "pass" | "fail" | "no-match" | Error) {
  const starts: string[] = [];
  let inFlight = 0, most = 0;
  const exec: AsyncProofExecutor = async (whitelisted, cwd) => {
    starts.push(`${cwd}:${whitelisted.label}`);
    most = Math.max(most, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, delayOf(whitelisted.label, cwd)));
    inFlight--;
    const answer = answerOf(whitelisted.label, cwd);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { exec, starts, most: () => most };
}

const proofOf = (label: string): WhitelistedProof => ({ kind: "test", command: "node", args: ["--test", label], label });

test("W1-T14036 criterion 2: runPendingProofExecutions runs a fold's pending executions at most slots at once, in the pending map's order, and one slot is the sequential loop", async () => {
  const delays: Record<string, number> = { a: 120, b: 10, c: 60, d: 10, e: 30 };
  const pending = new Map(Object.keys(delays).map((label) => [label, { whitelisted: proofOf(label), cwd: "/tree" }]));
  for (const [slots, expected] of [[1, 1], [2, 2], [3, 3], [9, 5]] as const) {
    const run = timedExecutor((label) => delays[label]!, () => "pass");
    const results = await runPendingProofExecutions(pending, run.exec, slots);
    assert.equal(run.most(), expected, `slots ${slots}: at most ${expected} at once`);
    assert.deepEqual(run.starts, ["a", "b", "c", "d", "e"].map((label) => `/tree:${label}`), "executions start in the pending order");
    assert.deepEqual(results.map((result) => result.key), ["a", "b", "c", "d", "e"], "results come back in the pending order, not completion order");
    for (const result of results) assert.deepEqual(result.observation, { outcome: "pass", matchedLines: undefined, loadError: undefined,
      failureOutput: undefined, failureTail: undefined, load: undefined });
    assert.ok(results[0]!.runMs >= 100, `the slow execution's run time is its own: ${results[0]!.runMs}`);
  }
});

test("W1-T14036 criterion 2: the slot count is the proof child's derived test-slot count, capped by the cores the sampled load leaves free", (t) => {
  withTestSlots(t, undefined);
  assert.equal(proofExecutionSlots({ cores: 16, load1: 0 }), 4, "one slot per four cores on an idle host");
  assert.equal(proofExecutionSlots({ cores: 16, load1: 12 }), 2, "a loaded host leaves two free cores");
  assert.equal(proofExecutionSlots({ cores: 16, load1: 40 }), 1, "never below one");
  assert.equal(proofExecutionSlots({ cores: 4, load1: 0 }), 1, "a small host runs one at a time");
  process.env.RMD_TEST_SLOTS = "3";
  assert.equal(proofExecutionSlots({ cores: 32, load1: 0 }), 3, "RMD_TEST_SLOTS fixes the slot count as it does for the proof child");
});

test("W1-T14036 criterion 2: judgeReviewAsync runs a fold's independent executions concurrently up to the slot count it records", async (t) => {
  withTestSlots(t, "4");
  const w = world(t);
  const head = join(w.root, "head");
  mkdirSync(head);
  registerReviewerCheckout(head);
  const criteria = ["a", "b", "c", "d"].map((name) => ({ claim: `proof ${name} holds`, proof: `unit test: test/${name}.test.ts` }));
  const run = timedExecutor(() => 80, () => "pass");
  const verdict = await judgeReviewAsync(criteria, {
    diff: "", report: criteria.map((c) => c.claim).join(". "), headCheckoutDir: head, asyncExecProof: run.exec,
  });
  assert.deepEqual(verdict.criteria.map((c) => c.proof_exec), Array(4).fill("executed_pass"));
  const rows = executionRows(w);
  assert.equal(rows.length, 4);
  const slots = only([...new Set(rows.map((row) => row.slots))], "slot count for the fold");
  assert.ok(slots! >= 1 && slots! <= defaultTestSlots(availableParallelism()), `slots ${slots} is the derived count`);
  assert.equal(run.most(), Math.min(slots!, 4), "as many at once as the fold's slots allow, never more");
});

test("W1-T14036 criterion 3: the base checkout's priming starts while the first fold's head proofs run, and the base run awaits that install", async (t) => {
  const w = world(t);
  const head = proofTree(w, "head", { primed: true });
  const base = proofTree(w, "base", { ciDelayMs: 1500 });
  const startedMs = Date.now();
  const verdict = await judgeReviewAsync(REAL_CRITERIA, realEvidence(head, base));
  assert.deepEqual(verdict.criteria.map((c) => c.proof_exec), ["executed_pass", "executed_pass"], JSON.stringify(verdict.criteria));
  const rows = executionRows(w);
  const firstFold = rows.filter((row) => row.fold === 0);
  assert.ok(firstFold.length > 0 && firstFold.every((row) => row.side === "head"), "the first fold runs only head proofs");
  const firstFoldMs = firstFold.reduce((sum, row) => sum + row.run_ms! + row.install_ms!, 0);
  const install = only(npmCalls(w, base), "base install");
  assert.ok(install.startedMs - startedMs < firstFoldMs,
    `the base install started ${install.startedMs - startedMs} ms in, before the head fold's ${firstFoldMs} ms ended`);
  const baseTest = only(rows.filter((row) => row.side === "base" && row.kind === "test"), "base test row");
  assert.ok(baseTest.install_ms! > 0, "the base run awaited the install that was still running");
  const headTest = only(rows.filter((row) => row.side === "head" && row.kind === "test"), "head test row");
  assert.ok(baseTest.fold! > headTest.fold!, "the base run is requested only in a fold after its head proof passed");
});

test("W1-T14036 criterion 3: a base checkout primed before its run starts waits on nothing, and a failing head proof requests no base run", async (t) => {
  const w = world(t);
  const head = proofTree(w, "head", { ciDelayMs: 500, testDelayMs: 1000 });
  const base = proofTree(w, "base", { ciDelayMs: 0 });
  await judgeReviewAsync(REAL_CRITERIA, realEvidence(head, base));
  const baseTest = only(executionRows(w).filter((row) => row.side === "base" && row.kind === "test"), "base test row");
  assert.equal(baseTest.install_ms, 0, "the early priming finished during the head run, so the base run found its checkout primed");
  const baseInstall = only(npmCalls(w, base), "base install");
  const headInstall = only(npmCalls(w, head), "head install");
  assert.ok(baseInstall.startedMs >= headInstall.endedMs!, "the base install starts after the head's own install, so the two never contend");

  const failingHead = proofTree(w, "head", { answer: "2.0.0", primed: true });
  const laterBase = proofTree(w, "base", { primed: true });
  const before = executionRows(w).length;
  const verdict = await judgeReviewAsync([REAL_CRITERIA[0]!], realEvidence(failingHead, laterBase));
  assert.equal(verdict.criteria[0]?.proof_exec, "executed_fail");
  const added = executionRows(w).slice(before);
  assert.deepEqual(added.map((row) => row.side), ["head"], "no base run for a head proof that failed");
});

/** Recorded review inputs: each is criteria and the outcome each tree gave, replayed through both judges. */
const REPLAY_SET: Array<{
  name: string; criteria: AcceptanceCriterion[]; answers: Record<string, "pass" | "fail" | "no-match" | "error" | "timeout">; expected: string[];
}> = [
  {
    name: "a discriminating test and a stale test",
    criteria: [
      { claim: "the new rule holds", proof: "unit test: test/new-rule.test.ts" },
      { claim: "the old rule still holds", proof: "unit test: test/old-rule.test.ts" },
    ],
    answers: { "head:test/new-rule.test.ts": "pass", "base:test/new-rule.test.ts": "fail", "head:test/old-rule.test.ts": "pass", "base:test/old-rule.test.ts": "pass" },
    expected: ["executed_pass", "executed_stale"],
  },
  {
    name: "a failing head, an executor error and a missing name",
    criteria: [
      { claim: "the fix holds", proof: "unit test: test/fix.test.ts" },
      { claim: "the guard holds", proof: "unit test: test/guard.test.ts" },
      { claim: "the third holds", proof: "unit test: test/third.test.ts" },
    ],
    answers: { "head:test/fix.test.ts": "fail", "head:test/guard.test.ts": "error", "head:test/third.test.ts": "no-match" },
    expected: ["executed_fail", "exec_error", "executed_fail"],
  },
  {
    name: "duplicate proofs share one observation",
    criteria: Array.from({ length: 4 }, (_, i) => ({ claim: `shared claim ${i}`, proof: "unit test: test/shared.test.ts" })),
    answers: { "head:test/shared.test.ts": "pass", "base:test/shared.test.ts": "fail" },
    expected: Array(4).fill("executed_pass"),
  },
  {
    name: "a run that timed out under load beside a passing grep",
    criteria: [
      { claim: "the slow suite holds", proof: "unit test: test/slow.test.ts" },
      { claim: "the marker exists", proof: "grep: replayMarker in src/marker.ts" },
    ],
    answers: { "head:test/slow.test.ts": "timeout", "head:src/marker.ts": "pass", "base:src/marker.ts": "fail" },
    expected: ["inconclusive_load", "executed_pass"],
  },
];

test("W1-T14036 criterion 4: invariant:verdicts-identical-on-replay — concurrent folds give the sequential judge's proof_exec, floorMet, reason, state and memo counts", async (t) => {
  withTestSlots(t, "4");
  const w = world(t);
  for (const [index, replay] of REPLAY_SET.entries()) {
    const head = join(w.root, `head-${index}`);
    const base = join(w.root, `base-${index}`);
    mkdirSync(head, { recursive: true });
    mkdirSync(base, { recursive: true });
    const sideOf = (cwd: string) => (cwd === head ? "head" : "base");
    const answerOf = (label: string, cwd: string) => {
      const answer = Object.entries(replay.answers)
        .find(([at]) => at.startsWith(`${sideOf(cwd)}:`) && label.includes(at.slice(at.indexOf(":") + 1)))?.[1] ?? "fail";
      if (answer === "timeout") return Object.assign(new Error(`proof child timed out: ${label}`), { code: "ETIMEDOUT" });
      return answer === "error" ? new Error(`proof child could not start: ${label}`) : answer;
    };
    const syncCalls: string[] = [];
    const syncExec: ProofExecutor = (whitelisted, cwd) => {
      syncCalls.push(`${cwd}:${whitelisted.label}`);
      const answer = answerOf(whitelisted.label, cwd);
      if (answer instanceof Error) throw answer;
      return answer;
    };
    const evidence = (over: Partial<ReviewEvidence>): ReviewEvidence => ({
      diff: "", report: replay.criteria.map((c) => c.claim).join(". "), headCheckoutDir: head, baseCheckoutDir: base,
      baseIsCheckout: true, sampleLoad: () => ({ load1: 0.5 }), ...over,
    });
    const sequential = judgeReview(replay.criteria, evidence({ execProof: syncExec }));
    // The first proof is the slowest, so a fold that stored results in completion order would store them reversed.
    const run = timedExecutor((label) => 60 - 10 * replay.criteria.findIndex((c) => c.proof.endsWith(label)), answerOf);
    const concurrent = await judgeReviewAsync(replay.criteria, evidence({ asyncExecProof: run.exec }));
    assert.deepEqual(concurrent.criteria.map((c) => c.proof_exec), replay.expected, `${replay.name}: the replay covers what it names`);
    assert.deepEqual(verdictShape(concurrent), verdictShape(sequential), `${replay.name}: identical verdicts`);
    assert.deepEqual([concurrent.proofUniqueRuns, concurrent.proofReuses], [sequential.proofUniqueRuns, sequential.proofReuses],
      `${replay.name}: the memo's reuse counts are unchanged`);
    assert.deepEqual([...run.starts].sort(), [...syncCalls].sort(), `${replay.name}: the same observation keys run, each once`);
    for (const label of new Set(run.starts.map((start) => start.slice(start.indexOf(":") + 1)))) {
      const at = (side: string) => run.starts.indexOf(`${side === "head" ? head : base}:${label}`);
      if (at("base") !== -1) assert.ok(at("head") < at("base"), `${replay.name}: ${label} ran at head before base`);
    }
  }
});

test("W1-T14036 criterion 4: invariant:verdicts-identical-on-replay — a real proof phase gives the synchronous judge's verdict", async (t) => {
  const w = world(t);
  const head = proofTree(w, "head", { ciDelayMs: 200 });
  const base = proofTree(w, "base", { ciDelayMs: 400 });
  const concurrent = await judgeReviewAsync(REAL_CRITERIA, realEvidence(head, base));
  const sequential = judgeReview(REAL_CRITERIA, realEvidence(head, base));
  assert.deepEqual(verdictShape(concurrent), verdictShape(sequential));
  assert.deepEqual(concurrent.criteria.map((c) => c.proof_exec), ["executed_pass", "executed_pass"]);
});
