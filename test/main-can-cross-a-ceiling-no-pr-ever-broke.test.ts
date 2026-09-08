import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "ci.yml");

/**
 * test/main-can-cross-a-ceiling-no-pr-ever-broke.test.ts — W1-T3068.
 *
 * An ABSOLUTE per-file ceiling can be crossed by a MERGE rather than by a diff: two PRs each sit
 * under it, both go green, and their sum crosses it. Nothing measured main, so the first symptom was
 * open PRs failing on a breach none of them caused. MEASURED 2026-09-07: at c8a5c5e8e
 * `src/run-task.ts` was 40516 lines against a ceiling of 40500 while that sha's push run reported
 * SUCCESS, because every ratchet job is `pull_request`-only.
 */

interface Job {
  if?: string;
  name?: string;
  steps?: Array<{ run?: string; name?: string }>;
}

function jobs(): Record<string, Job> {
  return (parseYaml(readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, Job> }).jobs;
}

function runScript(job: Job): string {
  return (job.steps ?? []).map((s) => s.run ?? "").join("\n");
}

/** The ceilings this job exists to measure — absolute, so a merge can cross one with no PR red. */
const ABSOLUTE_CEILING_GATES = [
  "source-size-ratchet",
  "learnings-budget-ratchet",
  "claude-md-budget-ratchet",
  "comment-load-signal",
];

test("a job measures the absolute ceilings against main itself, on push", () => {
  const job = jobs()["main-ceiling-drift"];
  assert.ok(job, "ci.yml must carry a job that measures main, or nothing does");
  assert.equal(job.if, "github.event_name == 'push'", "it must run on the event that produced the drift");
});

test("it runs EVERY absolute ceiling, so one breach cannot hide behind another's absence", () => {
  const script = runScript(jobs()["main-ceiling-drift"]);
  for (const gate of ABSOLUTE_CEILING_GATES) {
    assert.ok(script.includes(gate), `main is unmeasured against ${gate}`);
  }
  assert.match(
    script,
    /comment-load-signal -- --base HEAD\^/,
    "comment-load must compare the push against the previous main commit, not origin/main at HEAD",
  );
});

test("a failing ceiling does not short-circuit the rest — one breach must never mask another", () => {
  // The failure mode this pins is a `set -e`/`&&` chain: the first breach exits, the remaining
  // ceilings are never measured, and the report names one file when several are over.
  const script = runScript(jobs()["main-ceiling-drift"]);
  assert.match(script, /\|\|\s*\{\s*rc=1/, "each gate's failure must be recorded and the loop continue");
  assert.match(script, /exit "\$rc"/, "and the accumulated result must still fail the job");
});

test("it is a SIGNAL, never a gate: push-only, so requiring it would deadlock every PR", () => {
  // ci.yml's INVARIANT 2 — a required check that goes SKIPPED deadlocks merges as hard as a failing
  // one. This job is SKIPPED on every pull_request, so its name must never enter branch protection.
  const job = jobs()["main-ceiling-drift"];
  assert.doesNotMatch(job.if ?? "", /pull_request/, "it must not claim to run on PRs");
  assert.equal(job.name, "main-ceiling-drift", "the check name is the job name; a rename silently orphans it");
});

test("every ceiling main is measured against is one a PR is ALSO measured against", () => {
  // The two lists must not drift: a ceiling enforced on PRs but unmeasured on main reopens exactly
  // this defect, and one measured on main but not on PRs would red the branch with no way to fix it
  // before merging. Derived from the workflow, never a second hand-kept roster.
  const all = jobs();
  const mainScript = runScript(all["main-ceiling-drift"]);
  const prScripts = Object.entries(all)
    .filter(([id]) => id !== "main-ceiling-drift")
    .map(([, j]) => runScript(j))
    .join("\n");
  for (const gate of ABSOLUTE_CEILING_GATES) {
    assert.ok(mainScript.includes(gate), `${gate} must be measured on main`);
    assert.ok(prScripts.includes(gate), `${gate} is measured on main but on no PR — a branch nobody can fix`);
  }
});
