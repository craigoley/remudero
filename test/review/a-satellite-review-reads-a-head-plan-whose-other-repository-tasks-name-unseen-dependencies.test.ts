// W1-T13794 — the reviewer reads a satellite PR's task contract from the plan at its head. remudero-ops's plan holds core
// tasks (`repo: remudero`) depending on core public ids it cannot hold, so the strict at-ref read threw on the first one
// and every ops PR's review refused setup with head-task-metadata-unavailable (ops#171, 2026-11-19). A task of the
// satellite's own repository with an unseen dependency still diverges, exactly as before.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { taskTargetsRepo } from "#src/lib/drain.js";
import { resolvePlanCriteriaAtHeadAsync } from "#src/lib/review.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const UNSEEN = "W1-T900201";
const OPS = "owner/remudero-ops";
const keepsForeign = (task: { repo: string }) => !taskTargetsRepo(task.repo, OPS);

function record(id: string, repo: string, dependsOn: string[]): string {
  return `- id: ${id}\n  title: Fixture ${id}\n  repo: ${repo}\n  depends_on: [${dependsOn.join(", ")}]\n  type: implement\n` +
    "  verify: auto\n  risk: low\n  budget_usd: 5\n  status: queued\n  files: [fixture.ts]\n  acceptance:\n" +
    `    - claim: ${id} holds\n      proof: "grep: ${id} in fixture.ts"\n`;
}

/** A committed checkout whose plan/tasks.yaml is `plan`; returns its root and HEAD sha. */
function checkoutAt(t: TestContext, plan: string): { root: string; head: string } {
  const repo = gitRepo({ seedCommit: false, kind: "rmd-satellite-review-head" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), plan);
  repo.git("add", ".");
  repo.git("commit", "-qm", "plan");
  return { root: repo.dir, head: repo.git("rev-parse", "HEAD") };
}

test("W1-T13794 criterion 1: a satellite review resolves its task's contract at a head whose other-repository task names an unseen dependency", async (t) => {
  const { root, head } = checkoutAt(t, record("W1-T900202", "remudero", [UNSEEN]) + record("W1-T900203", "remudero-ops", ["W1-T900202"]));
  // Positive control: the strict read (every core review) still diverges on this plan.
  const strict = await resolvePlanCriteriaAtHeadAsync("Remudero-Task: W1-T900203", root, "plan/tasks.yaml", head);
  assert.match(strict.divergence?.reason ?? "", new RegExp(`task W1-T900202: depends_on unknown task '${UNSEEN}'`));
  const resolved = await resolvePlanCriteriaAtHeadAsync("Remudero-Task: W1-T900203", root, "plan/tasks.yaml", head, undefined, keepsForeign);
  assert.equal(resolved.divergence, undefined);
  assert.deepEqual(resolved.criteria.map((c) => c.claim), ["W1-T900203 holds"]);
  assert.equal(resolved.taskRisk, "low");
  assert.equal(resolved.taskBudgetUsd, 5);
});

test("W1-T13794 criterion 2: invariant:own-repo-dependencies-stay-strict — a satellite's own task with an unseen dependency still diverges at head", async (t) => {
  const { root, head } = checkoutAt(t, record("W1-T900204", "remudero-ops", [UNSEEN]) + record("W1-T900205", "remudero", [UNSEEN]));
  const resolved = await resolvePlanCriteriaAtHeadAsync("Remudero-Task: W1-T900204", root, "plan/tasks.yaml", head, undefined, keepsForeign);
  assert.equal(resolved.divergence?.reason, `task W1-T900204: depends_on unknown task '${UNSEEN}'`);
  assert.deepEqual(resolved.criteria, []);
  assert.equal(resolved.taskRisk, undefined);
});
