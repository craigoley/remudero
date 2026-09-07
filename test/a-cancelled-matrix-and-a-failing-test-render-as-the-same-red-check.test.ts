// W1-T3014 — the two collapse jobs in ci.yml branched on `!= "success"` and printed one sentence
// for failure, cancellation and skip alike. MEASURED: of nine red collapsed checks in one session,
// SEVEN were `cancelled` (a superseded matrix) and two were real failures that nearly rode out
// because readers had learned to discount the sentence.
//
// ⚠ THESE TESTS EXECUTE THE SCRIPT, THEY DO NOT GREP IT. The shard is explicit that a test which
// only greps the workflow for a phrase "proves the string exists and nothing about which arm exits
// what". Each case below runs the real `run:` body out of ci.yml under bash with SHARD_RESULT set,
// and asserts on the exit status and stdout.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const workflow = parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, { steps: Array<{ run?: string; env?: Record<string, string> }> }>;
};

/** The `run:` body of the collapse step in one of the two required-check jobs, read as DATA. */
function collapseScript(job: string): string {
  const steps = workflow.jobs[job]?.steps ?? [];
  const step = steps.find((s) => typeof s.run === "string" && s.run.includes("SHARD_RESULT"));
  assert.ok(step?.run, `${job} has no collapse step reading SHARD_RESULT`);
  return step.run;
}

/** Run that script exactly as the runner would, with SHARD_RESULT bound to `result`. */
function collapse(job: string, result: string): { status: number; out: string } {
  const r = spawnSync("bash", ["-c", collapseScript(job)], {
    encoding: "utf8",
    env: { ...process.env, SHARD_RESULT: result },
  });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const JOBS = ["ci-required", "coverage-ratchet-required"] as const;

test("W1-T3014 criterion 1: a cancelled matrix NAMES cancellation and does not assert a shard failed", () => {
  for (const job of JOBS) {
    const { status, out } = collapse(job, "cancelled");
    assert.match(out, /CANCELLED/, `${job}: the first clause must name cancellation`);
    assert.doesNotMatch(out, /did not succeed/, `${job}: the old conflating sentence must be gone`);
    assert.match(out, /not by itself evidence of a test failure/, `${job}: must say what it is NOT`);
    assert.match(out, /Open the shard log/, `${job}: design (v) — it still means go look`);
    assert.equal(status, 1, `${job}: cancelled must still be red — it proves nothing about the tree`);
  }
});

test("W1-T3014 criterion 2: a failure NAMES a failing shard and still exits non-zero", () => {
  for (const job of JOBS) {
    const { status, out } = collapse(job, "failure");
    assert.match(out, /FAILED/, `${job}`);
    assert.match(out, /real break until that log says otherwise/, `${job}`);
    assert.doesNotMatch(out, /CANCELLED/, `${job}: a failure must not read as a cancellation`);
    assert.equal(status, 1, `${job}`);
  }
});

test("W1-T3014 criterion 3 (falsifier): AN UNRECOGNISED RESULT IS REFUSED, NOT PASSED", () => {
  // THE ROW THAT MATTERS, AND IT ASSERTS REFUSAL ALONE — deliberately NOT the wording. A `case`
  // whose `*)` arm fell through to success would turn a novel GitHub result into a green required
  // check: strictly worse than the defect being fixed, and invisible until it happened.
  //
  // ⚠ IT MUST SURVIVE A REVERT OF THIS TASK, and that is the falsifier's explicit requirement. The
  // pre-task single `if` also refused unknown values, so this row is GREEN either way. That is
  // what makes it evidence about ADMISSION rather than about phrasing: pairing a message
  // assertion in here would couple the safety property to the wording and the row would redden on
  // revert like any cosmetic one, proving nothing.
  for (const job of JOBS) {
    for (const invented of ["neutral", "action_required", "", "success_", "SUCCESS"]) {
      const { status } = collapse(job, invented);
      assert.equal(status, 1, `${job}: result '${invented}' must be REFUSED, not passed`);
    }
  }
});

test("W1-T3014: the unrecognised arm also NAMES itself, which is new and may redden on revert", () => {
  // Split from the row above on purpose: this one is about wording, so it is allowed to move with
  // the task. Keeping the two apart is what lets the refusal row stay invariant.
  for (const job of JOBS) {
    assert.match(collapse(job, "neutral").out, /unrecognised matrix result/, `${job}`);
  }
});

test("W1-T3014 criterion 3: `skipped` is named as never-ran, distinct from both", () => {
  for (const job of JOBS) {
    const { status, out } = collapse(job, "skipped");
    assert.match(out, /never ran/, `${job}`);
    assert.equal(status, 1, `${job}`);
  }
});

test("W1-T3014 (falsifier): the SUCCESS path is byte-identical per job", () => {
  // If the happy path moved, every green PR in the fleet is being re-decided by a reporting change.
  // The two jobs differ on purpose: ci-required printed a line before this task and still does;
  // coverage-ratchet-required printed nothing and still prints nothing.
  const ci = collapse("ci-required", "success");
  assert.equal(ci.status, 0);
  assert.equal(ci.out, "ci: all four test shards succeeded.\n");

  const cov = collapse("coverage-ratchet-required", "success");
  assert.equal(cov.status, 0);
  assert.equal(cov.out, "", "coverage-ratchet printed nothing on success before this task");
});

test("W1-T3014 criterion 4: BOTH collapse jobs carry the treatment, neither keeps the old sentence", () => {
  // Fixing one job would leave half the session's false alarms in place (design iii).
  for (const job of JOBS) {
    const script = collapseScript(job);
    assert.doesNotMatch(script, /did not succeed/, `${job} still carries the conflating sentence`);
    assert.match(script, /case "\$SHARD_RESULT" in/, `${job} was not converted`);
    assert.match(script, /\*\)/, `${job} has no default arm`);
  }
});

test("W1-T3014: neither job gained an `if:` condition (W1-T1033 guards the always() shape)", () => {
  // Design (iv): both jobs carry `if: ${{ always() }}` deliberately. This task edits the run:
  // script's reporting only, so the job-level gating must be untouched.
  for (const job of JOBS) {
    const j = (workflow.jobs as Record<string, { if?: unknown }>)[job];
    // OBSERVED, not assumed: the YAML parser leaves the expression as a STRING, it does not
    // evaluate it. An earlier draft asserted `true` here and failed on that assumption.
    assert.equal(j.if, "${{ always() }}", `${job}'s always() condition must survive`);
  }
});
