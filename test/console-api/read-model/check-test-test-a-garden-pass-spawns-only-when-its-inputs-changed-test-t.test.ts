import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { gardenPacingPath } from "#src/lib/garden-registry.js";
import { machineJudgeInputs, machineJudgeInputsAsync } from "#src/lib/machine-filing-judge.js";
import { buildRegisteredGarden, type GardenBuildContext } from "#src/run-task.js";

// The flaking probe read the live checkout's origin/main, which a CI clone may not carry (or may move). A
// private fixture repo pins the plan tree the stamp reads, so the paced probe answers the same every run.
test("W1-T10904: check:test:test/a-garden-pass-spawns-only-when-its-inputs-changed.test.ts is prevented, not retried", async (t) => {
  const repo = gitRepo({ kind: "garden-pacing-pinned" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan"), { recursive: true });
  mkdirSync(join(repo.dir, "state"), { recursive: true });
  writeFileSync(join(repo.dir, ".gitignore"), "state/\n");
  writeFileSync(join(repo.dir, "plan/policy.yaml"), "rules: []\n");
  repo.git("add", ".gitignore", "plan");
  repo.git("commit", "-m", "fixture: plan tree");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const stateDir = join(repo.dir, "state");
  const sync = machineJudgeInputs(repo.dir, stateDir, "origin/main");
  assert.notEqual(sync.split(":")[0], "unreadable", "the pinned ref resolves to a plan tree");
  assert.equal(await machineJudgeInputsAsync(repo.dir, stateDir, "origin/main"), sync, "the daemon's async stamp equals the sync stamp");
  writeFileSync(gardenPacingPath(stateDir, "machine-judge"), JSON.stringify({
    lastPassAt: new Date(Date.now() - 60_000).toISOString(), lastNewAt: new Date(Date.now() - 3_600_000).toISOString(), inputs: sync,
  }));
  const ctx = { config: { root: repo.dir }, repoRoot: repo.dir, owner: "o", repo: "r", log: () => {}, raiseDuplicate: () => "" } as unknown as GardenBuildContext;
  const judge = await buildRegisteredGarden("machine-judge", ctx);
  assert.equal(await judge.due!(), false, "nothing new for an hour, and the inputs are unchanged");
});
