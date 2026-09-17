import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { CHECK_PROOF_EXIT, preflightSummarySentence, runPreflightProofs, type PreflightTier } from "../src/run-task.js";

// ── W1-T3738 — THE PROOF GATE HAS NO LOCAL TIER ──────────────────────────────────────────────
//
// MEASURED across one session: `proof-discrimination` refused on `executed_stale` in #5897 (2
// proofs), #5852 (4), #5927 (3), #5928 (1), #5895 and #5898. Every one cost a full CI round — a
// code pull request's cycle measured 20.3 min — for a question `rmd check-proof --base` answers
// offline in seconds, and which is what I used to FIX every one of them afterwards.
//
// Nothing about it needs the network. The gate resolves criteria through
// `resolvePlanCriteriaAtHead`, whose input is the `Remudero-Task:` trailer the HEAD COMMIT already
// carries — so the same criteria resolve from the same plan at the same sha with no pull request
// in existence.
//
// AND THE CLASS IS NOT SLOPPINESS. Every stale proof above was a CONTROL assertion — "a build diff
// is still refused", "the push trigger carries no filter" — true on the merge base BY DESIGN. That
// is what makes it a control. Noticing that a control needs a corpus control of its own is a
// per-proof judgement, and the only reliable way to make it is to run the thing.

const GIT = (over: Record<string, string> = {}) => (args: readonly string[]) => {
  const key = args.join(" ");
  if (key.startsWith("rev-parse")) return over.head ?? "headsha0000000000000000000000000000000\n";
  if (key.startsWith("merge-base")) return over.base ?? "basesha0000000000000000000000000000000\n";
  if (key.startsWith("log")) return over.body ?? "feat(x): a thing\n\nRemudero-Task: W1-T1\n";
  throw new Error("unexpected git call: " + key);
};

/** Records every check-proof invocation and answers with the exit code the caller chose. */
function spawnWith(byProof: Record<string, number>) {
  const asked: string[] = [];
  const spawn = (_file: string, args: string[]) => {
    const proof = args[args.indexOf("check-proof") + 1];
    asked.push(proof);
    return { status: byProof[proof] ?? 0, stdout: "", stderr: "" };
  };
  return { spawn, asked };
}

test("a stale proof is named locally", () => {
  // THE WHOLE TASK: the refusal arrives before the push, naming the proof, so the fix costs
  // seconds instead of a CI round.
  const stale = "grep: alreadyThere in src/lib/review.ts";
  const live = "grep: brandNewSymbol in src/lib/review.ts";
  const { spawn, asked } = spawnWith({ [stale]: CHECK_PROOF_EXIT.executedStale });
  const out = runPreflightProofs("/repo", {
    git: GIT(),
    spawn,
    resolveCriteria: () => [{ proof: stale }, { proof: live }],
  });
  assert.equal(out.ok, false);
  assert.match(out.steps[0].detail, /1 of 2 proof\(s\) pass at BOTH head and basesha00/);
  assert.match(out.steps[0].detail, new RegExp(stale.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(out.steps[0].detail, /brandNewSymbol/, "a proof that discriminates is never named as stale");
  assert.deepEqual(asked, [stale, live], "every executable proof is actually run, through check-proof");
});

test("a discriminating proof is not reported", () => {
  // THE TIER REFUSES ONLY WHAT THE GATE REFUSES. Exit 3 is no-match and 4 is exec_error; neither
  // says a proof failed to discriminate, and reading any non-zero as stale would refuse on an
  // environment gap — which is how a local tier gets switched off and never switched back on.
  for (const status of [0, 3, 4]) {
    const proof = "unit test: something real";
    const { spawn } = spawnWith({ [proof]: status });
    const out = runPreflightProofs("/repo", { git: GIT(), spawn, resolveCriteria: () => [{ proof }] });
    assert.equal(out.ok, true, `exit ${status} must not be read as stale`);
    assert.match(out.steps[0].detail, /proofs: OK/);
  }
});

test("no resolvable criteria is not a refusal", () => {
  // "no predicate ⇒ no opinion". A branch with no trailer, a criterion the plan credits to an
  // earlier merge (W1-T3729 — no proof text at all), and a proof in no known dialect all pass.
  const { spawn, asked } = spawnWith({});
  for (const criteria of [
    [],
    // THE REAL SHAPE, and the one that makes this assertion load-bearing: W1-T3693's four criteria
    // each carry a `satisfied_by` AND a parseable proof, which is what #5852 was refused over. A
    // fixture with satisfied_by and NO proof is filtered by the dialect check anyway and would let
    // a build that executed credited criteria pass this test.
    [{ satisfied_by: "https://github.com/craigoley/remudero/pull/5797", proof: "unit test: the request carries an abort signal" }],
    [{ satisfied_by: "https://github.com/craigoley/remudero/pull/5797" }],
    [{ proof: "just some prose that is not a dialect" }],
  ]) {
    const out = runPreflightProofs("/repo", { git: GIT(), spawn, resolveCriteria: () => criteria });
    assert.equal(out.ok, true);
    assert.match(out.steps[0].detail, /no executable criterion resolved/);
  }
  assert.deepEqual(asked, [], "nothing is executed when nothing resolves");

  // An unreadable head is an ENVIRONMENT gap, never a finding.
  const unreadable = runPreflightProofs("/repo", {
    git: () => { throw new Error("fatal: not a git repository"); },
    spawn,
  });
  assert.equal(unreadable.ok, true);
  assert.match(unreadable.steps[0].detail, /SKIPPED/);
});

test("the passing summary names the proof tier when it did not run", () => {
  // W1-T3737's lesson, applied to the tier this task adds: a green that hides what it skipped is
  // read as "CI will pass". A builder who has not run the proof tier is told so on every green.
  const tiers: PreflightTier[] = [
    { name: "commitlint/typecheck/emitter", enableWith: "always runs", ran: true },
    { name: "the fast gate", enableWith: "drop --no-fast", ran: true },
    { name: "proof discrimination", enableWith: "--proofs", ran: false },
  ];
  assert.match(preflightSummarySentence(true, [{ name: "a" }], tiers), /proof discrimination \(--proofs\)/);

  // And it is NOT named once it has run — the list is of what was skipped, not a fixed sentence.
  const ran = tiers.map((t) => (t.name === "proof discrimination" ? { ...t, ran: true } : t));
  assert.doesNotMatch(preflightSummarySentence(true, [{ name: "a" }], ran), /not checked here/);
});

// ── THE UNINJECTED PATH, WHICH EVERY OTHER TEST HERE SEAMS AWAY ──────────────────────────────
//
// `diff-coverage` refused #5940 naming the default seams: every test above injects `git`, so the
// real one was never executed and the lines were dead to the instrument. That is not a reporting
// artefact — it is the "when every test injects a fake, the seam's DEFAULT implementation is
// unreachable" shape this repo has paid for (#978). This test runs the real seam once, on the one
// input that stays offline and fast: a repository with no `origin/main` to resolve against.
test("a repo with no origin/main is SKIPPED, not refused — through the real git seam", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}proof-tier-real-git-`));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-qm", "chore: a commit carrying no task trailer");

  // No `git` and no `spawn` injected: this is the production wiring.
  const out = runPreflightProofs(dir);

  // SKIPPED, never a finding. An unfetched origin/main is an environment gap, and a tier that
  // invented a refusal from one would be worse than no tier — builders would learn to ignore it.
  assert.equal(out.ok, true);
  assert.equal(out.steps.length, 1);
  assert.match(out.steps[0]!.detail ?? "", /proofs: SKIPPED/);
  assert.match(out.steps[0]!.detail ?? "", /merge-base/);
  rmSync(dir, { recursive: true, force: true });
});
