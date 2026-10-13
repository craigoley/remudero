import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bodyCreditedMergeTimes, readCiFrictionPlanTasks } from "../src/lib/ci-friction-gardener.js";
import { FLOW_LADDER, readLadderPlan } from "../src/lib/flow-remedy-gardener.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "./helpers/git-repo.js";

// A GitHub squash body carries `Remudero-Task:` mid-body, where git's `%(trailers)` never looks. Read that way the
// ladders saw almost no merged remedy, so no remedy's effect was ever measured.
const squashBody = (pr: number, ...ids: string[]) =>
  `fix: remedy (#${pr})\n\n## Summary\n\n${ids.map(id => `Remudero-Task: ${id}`).join("\n")}\n\n## Release boundary\n\nprose after the credit line\n`;

function shard(id: string, origin: string): string {
  return `- id: ${id}
  title: remedy
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  status: queued
  attempts: 0
  origin: "${origin}"
  files: [src/lib/sweep.ts]
  acceptance: [{claim: fixed, proof: "unit test: fixed"}]
`;
}

function commitAt(repo: GitRepo, message: string, at: string): string {
  execFileSync("git", ["-C", repo.dir, "-c", `user.name=${GIT_REPO_FIXTURE_IDENTITY.name}`,
    "-c", `user.email=${GIT_REPO_FIXTURE_IDENTITY.email}`, "commit", "-q", "--allow-empty", "-m", message], {
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }, stdio: "ignore",
  });
  return repo.git("show", "-s", "--format=%cI", "HEAD");
}

test("a remedy merged through a squash body's mid-body Remudero-Task line is credited by both ladders", (t) => {
  const repo = gitRepo({ kind: "squash-credit" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T9101.yaml"), shard("W1-T9101", "ci-friction:check:ci-log:ci"));
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T9102.yaml"), shard("W1-T9102", "flow-blocker:escalated:metadata-only body red"));
  repo.git("add", ".");
  commitAt(repo, "chore(plan): file two remedies", "2026-10-01T10:00:00Z");
  const frictionMerged = commitAt(repo, squashBody(7, "W1-T9101"), "2026-10-02T10:00:00Z");
  const flowMerged = commitAt(repo, squashBody(8, "W1-T9102"), "2026-10-03T10:00:00Z");
  commitAt(repo, squashBody(9, "W1-T9101", "W1-T9888"), "2026-10-04T10:00:00Z");
  assert.equal(repo.git("show", "-s", "--format=%(trailers:key=Remudero-Task,valueonly)", "HEAD"), "",
    "positive control: the formal-trailer query misses this shape");

  const git = (args: string[]) => repo.git(...args) + "\n";
  const friction = readCiFrictionPlanTasks(git, "plan/tasks.d", "HEAD");
  assert.equal(friction.find(task => task.id === "W1-T9101")?.mergedAt, frictionMerged, "the oldest crediting commit is the merge");

  repo.addRemote("origin", repo.dir);
  repo.git("fetch", "origin");
  const flow = readLadderPlan(repo.dir, FLOW_LADDER);
  assert.equal(flow.tasks.find(task => task.id === "W1-T9102")?.mergedAt, flowMerged);

  assert.deepEqual([...bodyCreditedMergeTimes(git, "HEAD", ["W1-T9101", "W1-T9999", "not an id"]).keys()], ["W1-T9101"],
    "only the asked ids are credited, and a malformed id never reaches the grep");
  assert.equal(bodyCreditedMergeTimes(git, "HEAD", []).size, 0);
});
