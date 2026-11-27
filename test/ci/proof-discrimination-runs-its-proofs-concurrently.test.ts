import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Criterion = { claim?: string; proof?: string; kind?: string; satisfied_by?: string };
type ProofResult = { status: number | null; signal?: string | null; error?: string; stdout: string; stderr?: string };
type Evaluation = Record<string, unknown>;
type Deps = Record<string, unknown>;

const gate = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "proof-discrimination-gate.mjs")).href)) as {
  evaluateProofDiscrimination: (criteria: Criterion[], base: string, run: (proof: string, base: string) => ProofResult) => Evaluation;
  evaluateProofDiscriminationConcurrently: (criteria: Criterion[], base: string,
    run: (proof: string, base: string) => Promise<ProofResult>, opts?: { poolSize?: (count: number) => number }) => Promise<Evaluation>;
  proofPoolSize: (count: number, read?: () => number) => number;
  runCheckProof: (proof: string, base: string, opts?: { root?: string }) => ProofResult;
  runCheckProofAsync: (proof: string, base: string, opts?: { root?: string }) => Promise<ProofResult>;
  main: (argv: string[], deps: Deps) => number;
  mainConcurrent: (argv: string[], deps: Deps) => Promise<number>;
};

const PROOF_TIME_MS = 200;
const PASSED = "hits: 1\nverdict: pass\nbase hits: 0\nbase: no-match\n";

test("W1-T15183 criterion 1: eight timed proofs in a pool of four take about two proof-times, each run at head and base", async () => {
  const criteria = Array.from({ length: 8 }, (_, i) => ({ claim: `c${i}`, proof: `grep: marker ${i} in src/x.ts` }));
  const calls: Array<{ proof: string; base: string }> = [];
  let running = 0;
  let peak = 0;
  const started = performance.now();
  const result = await gate.evaluateProofDiscriminationConcurrently(criteria, "merge-base", async (proof, base) => {
    calls.push({ proof, base });
    running += 1;
    peak = Math.max(peak, running);
    await sleep(PROOF_TIME_MS);
    running -= 1;
    return { status: 0, stdout: PASSED, stderr: "" };
  }, { poolSize: () => 4 });
  const elapsed = performance.now() - started;

  assert.equal(peak, 4, "four proofs run at once");
  assert.ok(elapsed < PROOF_TIME_MS * 4, `the gate took ${Math.round(elapsed)} ms, not about two proof-times`);
  assert.deepEqual(calls.map((call) => call.proof).sort(), criteria.map((c) => c.proof).sort(), "every criterion ran once");
  assert.ok(calls.every((call) => call.base === "merge-base"), "every proof ran against the merge base");
  assert.equal(result.executed, 8);
});

/** A mixed body: credited, guarded, prose, stale, count-discriminated, unreadable and passing criteria. */
const MIXED: Criterion[] = [
  { claim: "credited", proof: "grep: credited in src/a.ts", satisfied_by: "#100" },
  { claim: "pass one", proof: "grep: one in src/a.ts" },
  { claim: "guard", proof: "grep: guard in src/a.ts", kind: "guard" },
  { claim: "stale grep", proof: "grep: same in src/b.ts" },
  { claim: "prose", proof: "it works on my machine" },
  { claim: "grown grep", proof: "grep: grown in src/c.ts" },
  { claim: "unreadable", proof: "grep: lost in src/d.ts" },
  { claim: "stale unit", proof: "unit test: test/e.test.ts" },
  { claim: "pass two", proof: "grep: two in src/f.ts" },
];

function outcome(proof: string): ProofResult {
  if (proof.includes("same")) return { status: 5, stdout: "hits: 2\nverdict: pass\nbase hits: 2\nbase: pass\n" };
  if (proof.includes("grown")) return { status: 5, stdout: "hits: 3\nverdict: pass\nbase hits: 1\nbase: pass\n" };
  if (proof.includes("lost")) return { status: null, signal: "SIGKILL", stdout: "" };
  if (proof.startsWith("unit test:")) return { status: 5, stdout: "verdict: pass\nbase: pass\n" };
  return { status: 0, stdout: PASSED };
}

test("W1-T15183 criterion 2: the concurrent gate returns the sequential gate's results and record, in criterion order", async () => {
  const sequential = gate.evaluateProofDiscrimination(MIXED, "fork", (proof) => outcome(proof));
  const order = MIXED.map((c) => c.proof ?? "");
  const concurrent = await gate.evaluateProofDiscriminationConcurrently(MIXED, "fork", async (proof) => {
    await sleep(10 * (order.length - order.indexOf(proof)));
    return outcome(proof);
  }, { poolSize: () => 8 });
  assert.deepEqual(concurrent, sequential);

  // Through both entry points: the same exit code, log lines and published record.
  const run = async (entry: "main" | "mainConcurrent") => {
    const logs: string[] = [];
    const written: string[] = [];
    const deps: Deps = {
      root: REPO_ROOT,
      readPayload: () => ({ readable: true, baseSha: "b", headSha: "h", body: "Remudero-Task: W1-T15183\n", headRefName: "x" }),
      mergeBase: () => ({ ok: true, mergeBase: "fork" }),
      resolveCriteria: () => ({ criteria: MIXED, source: "task acceptance" }),
      runProof: entry === "main" ? (proof: string) => outcome(proof) : async (proof: string) => outcome(proof),
      baseline: () => ({}),
      executorDigests: () => ({ files: [], executor_digest: "e", workflow_digest: "w" }),
      writeResult: (_path: string, text: string) => written.push(text),
      log: { log: (line: string) => logs.push(`log ${line}`), error: (line: string) => logs.push(`error ${line}`) },
    };
    const argv = ["--event-path", "event.json", "--result-path", "result.json"];
    const code = entry === "main" ? gate.main(argv, deps) : await gate.mainConcurrent(argv, { ...deps, poolSize: () => 4 });
    return { code, logs, written };
  };
  const viaMain = await run("main");
  const viaConcurrent = await run("mainConcurrent");
  assert.equal(viaMain.code, 1, "the unreadable proof refuses the head");
  assert.deepEqual(viaConcurrent, viaMain);
});

test("W1-T15183 criterion 2: the non-blocking check-proof child returns what the blocking one does", async () => {
  const proof = "grep: W1-T15183 no such marker anywhere in package.json";
  const blocking = gate.runCheckProof(proof, "HEAD", { root: REPO_ROOT });
  const pooled = await gate.runCheckProofAsync(proof, "HEAD", { root: REPO_ROOT });
  assert.equal(pooled.status, blocking.status);
  assert.equal(pooled.error, blocking.error);
  assert.equal(pooled.stdout, blocking.stdout);
});

test("W1-T15183 criterion 3: the pool is the runner's available parallelism, capped at the proof count, and one when unread", () => {
  assert.equal(gate.proofPoolSize(8, () => 4), 4);
  assert.equal(gate.proofPoolSize(2, () => 16), 2, "never above the executable criteria");
  assert.equal(gate.proofPoolSize(8, () => { throw new Error("no cores"); }), 1, "one when it cannot be read");
  assert.equal(gate.proofPoolSize(8, () => 0), 1);
  assert.equal(gate.proofPoolSize(0, () => 4), 1);
  assert.equal(gate.proofPoolSize(1_000), Math.min(availableParallelism(), 1_000), "the default reads os.availableParallelism");
});
