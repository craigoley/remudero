import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlanQuarantiningDuplicates, mergePlanBlobs, mergePlanBlobsQuarantiningDuplicates } from "../src/lib/plan.js";
import { withTempDir } from "../src/lib/tmp.js";
import { syncPlanFromOrigin } from "../src/run-task.js";
import type { QuarantinedTask } from "../src/lib/plan.js";

// W1-T4421 — W1-T4409 kept consumer daemons alive on a duplicate task id, but the core daemon loads its own plan
// from origin/main blobs through mergePlanBlobs, which still threw, and an id declared twice inside ONE file threw
// everywhere. A duplicate on core main would crash-loop the fleet's reviewer for every repo.

function task(id: string, dependsOn: string[] = []): string {
  return `- id: ${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  depends_on: [${dependsOn.join(", ")}]\n  status: queued\n`;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A clone whose origin/main holds a plan with W1-T60 declared by two shards and W1-T61 depending on it. */
function cloneWithDuplicateOnMain(root: string): string {
  const seed = join(root, "seed");
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  git(root, ["init", "--quiet", "-b", "main", seed]);
  git(seed, ["config", "user.email", "w1-t4421@example.invalid"]);
  git(seed, ["config", "user.name", "W1-T4421"]);
  writeFileSync(join(seed, "plan", "tasks.yaml"), task("W1-T1"));
  writeFileSync(join(seed, "plan", "tasks.d", "W1-T60-first.yaml"), task("W1-T60"));
  writeFileSync(join(seed, "plan", "tasks.d", "W1-T60-second.yaml"), task("W1-T60"));
  writeFileSync(join(seed, "plan", "tasks.d", "W1-T61-after.yaml"), task("W1-T61", ["W1-T60"]));
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "--quiet", "-m", "plan with a duplicate"]);
  const bare = join(root, "origin.git");
  execFileSync("git", ["clone", "--quiet", "--bare", seed, bare]);
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "--quiet", bare, clone]);
  return clone;
}

test("the core daemon's origin-blob plan load quarantines a duplicate id instead of throwing", async () => {
  await withTempDir("core-dup-origin", (root) => {
    const clone = cloneWithDuplicateOnMain(root);
    let reported: QuarantinedTask[] = [];

    const { plan } = syncPlanFromOrigin(clone, "plan/tasks.yaml", { quarantine: (q) => (reported = q) });

    assert.deepEqual(plan.tasks.map((t) => t.id), ["W1-T1"], "the daemon still gets a plan to run");
    assert.deepEqual(
      reported.map((q) => [q.id, q.reason]),
      [
        ["W1-T60", "duplicate_id"],
        ["W1-T61", "depends_on_quarantined"],
      ],
    );
    assert.deepEqual(reported[0]!.files, ["origin/main:plan/tasks.d/W1-T60-first.yaml", "origin/main:plan/tasks.d/W1-T60-second.yaml"]);
    // Every other caller (run-task, drain, lint) stays strict.
    assert.throws(() => syncPlanFromOrigin(clone, "plan/tasks.yaml"), /duplicate task id 'W1-T60'/);
  });
});

test("an id declared twice in one file is quarantined in daemon mode", async () => {
  const blob = { label: "origin/main:plan/tasks.yaml", text: task("W1-T7") + task("W1-T8") + task("W1-T7") };
  const { plan, quarantined } = mergePlanBlobsQuarantiningDuplicates([blob]);
  assert.deepEqual(plan.tasks.map((t) => t.id), ["W1-T8"]);
  assert.deepEqual(quarantined, [{ id: "W1-T7", files: ["origin/main:plan/tasks.yaml"], reason: "duplicate_id" }]);
  assert.throws(() => mergePlanBlobs([blob]), /duplicate task id 'W1-T7'/, "strict merging still refuses");

  await withTempDir("core-dup-infile", (dir) => {
    const path = join(dir, "tasks.yaml");
    writeFileSync(path, task("W1-T7") + task("W1-T8") + task("W1-T7"));
    const loaded = loadPlanQuarantiningDuplicates(path);
    assert.deepEqual(loaded.plan.tasks.map((t) => t.id), ["W1-T8"]);
    assert.deepEqual(loaded.quarantined.map((q) => q.id), ["W1-T7"]);
  });
});
