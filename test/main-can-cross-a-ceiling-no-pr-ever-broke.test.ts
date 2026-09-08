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

function stepScript(job: Job, stepName: string): string {
  const step = (job.steps ?? []).find((s) => s.name === stepName);
  assert.ok(step?.run, `ci.yml must carry a ${stepName} step with a run body`);
  return step.run;
}

/** The ceilings this job exists to measure — absolute, so a merge can cross one with no PR red. */
const ABSOLUTE_CEILING_GATES = [
  "source-size-ratchet",
  "learnings-budget-ratchet",
  "claude-md-budget-ratchet",
  "comment-load-signal",
];

test("the ci push lane measures the absolute ceilings against main itself", () => {
  const ci = jobs().ci;
  assert.ok(ci, "ci.yml must carry the ci job that runs on main pushes");
  assert.equal(ci.if, undefined, "the ci job must stay ungated so it runs on both PRs and main pushes");
  const script = stepScript(ci, "Test");
  assert.match(script, /\$\{GITHUB_EVENT_NAME\}" = "push"/, "the ceiling signal must run on the push event");
  assert.match(script, /\$\{\{ matrix\.shard \}\}" = "1"/, "one shard must own the non-sharded ceiling checks");
});

test("it runs EVERY absolute ceiling, so one breach cannot hide behind another's absence", () => {
  const script = stepScript(jobs().ci, "Test");
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
  const script = stepScript(jobs().ci, "Test");
  assert.match(script, /npm run --silent "\$@" \|\| \{[\s\S]*CODE=1/, "each gate's failure must be recorded and the loop continue");
  assert.match(script, /exit "\$CODE"/, "and the accumulated result must still fail the job");
});

test("it adds no skipped PR check context", () => {
  // ci.yml's INVARIANT 2 — a required check that goes SKIPPED deadlocks merges as hard as a failing
  // one. The signal rides inside `ci`, which already registers on PRs, instead of adding a
  // push-only job that the PR check census would have to classify.
  assert.equal(jobs()["main-ceiling-drift"], undefined, "the main signal must not be a separate PR-visible job");
  assert.equal(jobs()["ci-required"]?.name, "ci", "main push failures still surface under the existing stable ci name");
});

test("every ceiling main is measured against is one a PR is ALSO measured against", () => {
  // The two lists must not drift: a ceiling enforced on PRs but unmeasured on main reopens exactly
  // this defect, and one measured on main but not on PRs would red the branch with no way to fix it
  // before merging. Derived from the workflow, never a second hand-kept roster.
  const all = jobs();
  const mainScript = stepScript(all.ci, "Test");
  const prScripts = Object.entries(all)
    .map(([, j]) => (j.steps ?? []).map((s) => s.run ?? "").join("\n"))
    .join("\n");
  for (const gate of ABSOLUTE_CEILING_GATES) {
    assert.ok(mainScript.includes(gate), `${gate} must be measured on main`);
    assert.ok(prScripts.includes(gate), `${gate} is measured on main but on no PR — a branch nobody can fix`);
  }
});
