import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── W1-T3729 — A CRITERION CREDITED TO A PRIOR MERGE IS NOT A STALE PROOF ────────────────────
//
// MEASURED on #5852: all four of W1-T3693's criteria carry `satisfied_by:` — the Architect-only
// field (§12 rule 16) that stands IN PLACE OF a proof and names the PR that already met the
// criterion. A criterion met by an EARLIER merge passes at THIS PR's merge base by definition, so
// `rmd check-proof --base` returns `executed_stale` for every one of them. The gate counted all
// four and refused 4-over-0, and neither remedy it prints applies: the proofs are correctly
// pointed (repointing them would make the plan lie), and the baseline it offers as the alternative
// says of itself that its allowance never rises.
//
// review.ts already excludes exactly this set from the criteria a proof gate should walk —
// `executableCriteria = criteria.filter((c) => !c.satisfied_by)` (review.ts:3718) — and grades
// them MET without executing anything (2359). The gate's own header says it runs the reviewer's
// parser and executor.
//
// WHAT IS REAL HERE: `evaluateProofDiscrimination` and `main` are the production functions from
// `scripts/proof-discrimination-gate.mjs`, imported directly. Only the proof EXECUTOR is injected,
// the same seam test/a-stale-proof-is-invisible-until-a-capped-verdict-hours-later.test.ts uses.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "proof-discrimination-gate.mjs");

type Criterion = { claim?: string; proof?: string; satisfied_by?: string };
type ProofResult = { status: number | null; stdout: string; stderr?: string; error?: string };

const gate = (await import(pathToFileURL(SCRIPT).href)) as {
  evaluateProofDiscrimination: (
    criteria: Criterion[],
    mergeBase: string,
    runProof: (proof: string, base: string) => ProofResult,
  ) => { stale: Array<{ proof: string }>; unreadable: unknown[]; executed: number; credited: number };
  main: (argv: string[], deps?: Record<string, unknown>) => number;
};

const STALE = "grep: persistent marker in src/example.ts";
const CREDITED: Criterion = {
  claim: "a request that never answers is abandoned at a deadline",
  proof: "unit test: the request carries an abort signal",
  satisfied_by: "https://github.com/craigoley/remudero/pull/5797",
};

/** Head/base parity — what `check-proof --base` reports for a proof that establishes nothing. */
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
    readPayload: () => ({ readable: true, body: "Remudero-Task: W1-T3693\n", baseSha: "base-tip", headSha: "head" }),
    mergeBase: () => ({ ok: true, mergeBase: "fork" }),
    resolveCriteria: () => ({ criteria, source: "task acceptance" }),
    runProof,
    baseline,
    log: sink.log,
  });
  return { code, out: sink.out.join("\n"), err: sink.err.join("\n") };
}

test("a satisfied_by criterion is never run against the merge base", () => {
  // THE ASSERTION THE WHOLE TASK RESTS ON, and it is about the EXECUTOR, not the verdict: a
  // criterion the plan already credits must not reach `check-proof` at all. A test that only
  // checked the exit code would pass for a gate that ran it and then forgave the result — and
  // that gate still burns a full base-worktree re-run per criterion on every PR.
  const asked: string[] = [];
  const result = gate.evaluateProofDiscrimination([CREDITED], "fork", (proof) => {
    asked.push(proof);
    return staleRun();
  });
  assert.deepEqual(asked, [], "the credited criterion was handed to check-proof");
  assert.deepEqual(result.stale, []);
  assert.equal(result.credited, 1);
});

test("a task whose every criterion is satisfied_by is not refused", () => {
  // #5852's exact shape: four criteria, all credited, refused 4-over-0 with allowance 0.
  const { code, out } = runMain([CREDITED, { ...CREDITED, claim: "b" }, { ...CREDITED, claim: "c" }, { ...CREDITED, claim: "d" }], staleRun);
  assert.equal(code, 0, out);
});

test("an ordinary stale proof beside a satisfied_by criterion is still refused", () => {
  // THE HOLE THIS MUST NOT OPEN. Skipping the whole criterion list because ONE member is credited
  // would turn a correct exemption into a way to smuggle a non-discriminating proof through.
  const { code, err } = runMain([CREDITED, { claim: "x", proof: STALE }], staleRun);
  assert.equal(code, 1);
  assert.match(err, /1 proof\(s\) pass at both PR head and merge base/);
  assert.match(err, /proof: grep: persistent marker/);
});

test("the gate reports how many criteria it credited to a prior merge", () => {
  // A gate that quietly stops looking at things is how a census goes hollow: the count is what a
  // later reader needs to tell "nothing to execute" from "nothing executed".
  const credited = runMain([CREDITED, { claim: "x", proof: STALE }], liveRun);
  assert.match(credited.out, /1 criterion\(s\) credited to a prior merge/);

  const none = runMain([{ claim: "x", proof: STALE }], liveRun);
  assert.doesNotMatch(none.out, /credited to a prior merge/, "no line when there is nothing to report");
});

test("a credited criterion does not inflate the executed count", () => {
  // `executed` is this gate's evidence that it did work. Counting a criterion it deliberately
  // never ran would let a task of entirely-credited criteria report a green it did not earn.
  const result = gate.evaluateProofDiscrimination([CREDITED, { claim: "x", proof: STALE }], "fork", liveRun);
  assert.equal(result.executed, 1, "only the criterion that actually ran counts as executed");
  assert.equal(result.credited, 1);
});

test("an empty satisfied_by is not a credit — it falls through to the proof, as the plan loader requires", () => {
  // plan.ts:287 refuses an empty-string `satisfied_by` at load, so both the truthiness test used
  // here and review.ts:3718's agree in practice. Pinned so a later edit to either cannot drift
  // into treating a blank field as a credit and silently exempting a real proof.
  const result = gate.evaluateProofDiscrimination([{ claim: "x", proof: STALE, satisfied_by: "" }], "fork", staleRun);
  assert.equal(result.credited, 0);
  assert.equal(result.executed, 1);
  assert.equal(result.stale.length, 1);
});
