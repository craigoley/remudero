import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── W1-T4419 — A REGRESSION GUARD IS EXEMPT FROM PROOF DISCRIMINATION, BUT STILL RUNS IN REVIEW ──
//
// THE LIVE DEFECT (OBSERVED 2026-09-24): three shards (W1-T4409, W1-T4413, W1-T4388) each carried a
// legitimate regression guard ("loadPlan itself still refuses a duplicate id", "a genuinely merged
// task is still reported merged", "a W1-T mint without a prefix is unchanged"). Such a proof passes
// at the merge base BY DESIGN — that is what a guard proves, that nothing broke — so
// proof-discrimination refused it as non-discriminating (#6916), and an operator amendment (#6918)
// had to delete all three criteria outright even though the guard tests still run in the suites.
//
// THE FIX (design, plan/tasks.d/W1-T4419-*.yaml): `kind: guard` (src/lib/plan.ts) marks a criterion
// this way. `evaluateProofDiscrimination` (scripts/proof-discrimination-gate.mjs) now skips it for
// the head-vs-base comparison exactly like a `satisfied_by`-credited criterion, WITHOUT touching
// review.ts: review still executes a guard's proof like any other criterion, and it must still pass
// at head — this gate is the only place that changes.
//
// WHAT IS REAL HERE: `evaluateProofDiscrimination` and `main` are the production functions from
// `scripts/proof-discrimination-gate.mjs`, imported directly — the same seam
// test/a-criterion-credited-to-a-prior-merge-is-not-a-stale-proof.test.ts uses for `satisfied_by`.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "proof-discrimination-gate.mjs");

type Criterion = { claim?: string; proof?: string; satisfied_by?: string; kind?: string };
type ProofResult = { status: number | null; stdout: string; stderr?: string; error?: string };

const gate = (await import(pathToFileURL(SCRIPT).href)) as {
  evaluateProofDiscrimination: (
    criteria: Criterion[],
    mergeBase: string,
    runProof: (proof: string, base: string) => ProofResult,
  ) => { stale: Array<{ proof: string }>; unreadable: unknown[]; executed: number; credited: number; guarded: number };
  main: (argv: string[], deps?: Record<string, unknown>) => number;
};

const STALE = "grep: persistent marker in src/example.ts";
const GUARD: Criterion = {
  claim: "loadPlan itself still refuses a duplicate id",
  proof: "unit test: loadPlan itself still refuses a duplicate id",
  kind: "guard",
};

/** Head/base parity — what `check-proof --base` reports for a proof that establishes nothing (exactly
 *  what a correct guard proof looks like: it passes identically before and after the PR). */
const staleRun = (): ProofResult => ({ status: 5, stdout: "hits:       2\nbase hits:  2\n" });
/** A discriminating proof: passes at head, misses at base. */
const liveRun = (): ProofResult => ({ status: 0, stdout: "hits:       1\nbase hits:  0\n" });

function logs() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) } };
}

function runMain(criteria: Criterion[], runProof: (proof: string, base: string) => ProofResult, baseline = () => ({})) {
  const sink = logs();
  const code = gate.main(["--event-path", "event.json"], {
    readPayload: () => ({ readable: true, body: "Remudero-Task: W1-T4419\n", baseSha: "base-tip", headSha: "head" }),
    mergeBase: () => ({ ok: true, mergeBase: "fork" }),
    resolveCriteria: () => ({ criteria, source: "task acceptance" }),
    runProof,
    baseline,
    log: sink.log,
  });
  return { code, out: sink.out.join("\n"), err: sink.err.join("\n") };
}

test("a guard criterion is exempt from proof discrimination but still must pass at head: it is never run against the merge base by this gate", () => {
  // THE ASSERTION THE WHOLE TASK RESTS ON, and it is about the EXECUTOR, not the verdict: a `kind:
  // guard` criterion must not reach `check-proof --base` at all — that comparison is exactly what a
  // correct guard fails BY DESIGN. ("still pass at head" is review.ts's job, unchanged by this gate.)
  const asked: string[] = [];
  const result = gate.evaluateProofDiscrimination([GUARD], "fork", (proof) => {
    asked.push(proof);
    return staleRun();
  });
  assert.deepEqual(asked, [], "the guard criterion was handed to check-proof");
  assert.deepEqual(result.stale, []);
  assert.equal(result.guarded, 1);
});

test("a guard criterion that would otherwise be flagged stale does not refuse the PR", () => {
  const { code, out } = runMain([GUARD], staleRun);
  assert.equal(code, 0, out);
});

test("an ordinary stale proof beside a guard criterion is still refused — the exemption is per-criterion, not per-task", () => {
  // THE HOLE THIS MUST NOT OPEN. One `kind: guard` criterion in a task's list must not exempt an
  // unrelated non-discriminating proof sitting right beside it.
  const { code, err } = runMain([GUARD, { claim: "x", proof: STALE }], staleRun);
  assert.equal(code, 1);
  assert.match(err, /1 proof\(s\) pass at both PR head and merge base/);
  assert.match(err, /proof: grep: persistent marker/);
});

test("the gate reports how many criteria it skipped as guards, distinctly from `credited`", () => {
  const skipped = runMain([GUARD, { claim: "x", proof: STALE }], liveRun);
  assert.match(skipped.out, /1 criterion\(s\) declared `kind: guard`/);
  assert.doesNotMatch(skipped.out, /credited to a prior merge/, "a guard is not a credited-by-prior-merge criterion");

  const none = runMain([{ claim: "x", proof: STALE }], liveRun);
  assert.doesNotMatch(none.out, /declared `kind: guard`/, "no line when there is nothing to report");
});

test("a guarded criterion does not inflate the executed count", () => {
  // `executed` is this gate's evidence that it did work. Counting a criterion it deliberately never
  // ran against the merge base would let a task with a guard report a green it did not earn there.
  const result = gate.evaluateProofDiscrimination([GUARD, { claim: "x", proof: STALE }], "fork", liveRun);
  assert.equal(result.executed, 1, "only the criterion that actually ran counts as executed");
  assert.equal(result.guarded, 1);
});

test("a task whose every criterion is a guard is not refused by this gate", () => {
  // plan.ts refuses this shape at PARSE time (nothing discriminates the task's own work) — this
  // gate's own job is narrower: given whatever criteria it is handed, never re-litigate that rule.
  const { code, out } = runMain([GUARD, { ...GUARD, claim: "b" }], staleRun);
  assert.equal(code, 0, out);
});
