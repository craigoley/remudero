// W1-T13585 — a daemon whose target is remudero-ops boots on that repository's plan. The plan is core's private
// task catalog: `repo: remudero` tasks depending on core public ids the ops checkout cannot hold. The boot read
// threw on the first one ("depends_on unknown task") and the ops daemon crash-looped (observed on the host
// 2026-11-18 02:07Z and 2026-11-19 00:35Z). A task of the target itself still fails the read, as before.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadTargetPlanQuarantiningDuplicates } from "#src/lib/drain.js";
import { loadPlanQuarantiningDuplicates, PlanError } from "#src/lib/plan.js";
import { makeTempDir } from "#src/lib/tmp.js";

const UNSEEN = "W1-T900101";

function record(id: string, repo: string, dependsOn: string[]): string {
  return `- id: ${id}\n  title: Fixture ${id}\n  repo: ${repo}\n  depends_on: [${dependsOn.join(", ")}]\n  type: implement\n` +
    "  verify: auto\n  risk: low\n  status: queued\n  files: [fixture.ts]\n  acceptance: []\n";
}

/** A checkout's plan/tasks.yaml with `monolith` and one tasks.d shard holding `shard`. */
function planAt(t: TestContext, monolith: string, shard: string): string {
  const root = makeTempDir("rmd-foreign-target-boot");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), monolith);
  writeFileSync(join(root, "plan", "tasks.d", "W1-T900103-fixture.yaml"), shard);
  return join(root, "plan", "tasks.yaml");
}

test("W1-T13585: a foreign-target daemon loads a plan whose other-repo task names an unseen dependency", (t) => {
  const path = planAt(t, record("W1-T900102", "remudero", [UNSEEN]), record("W1-T900103", "remudero-ops", ["W1-T900102"]));
  // Positive control: the strict boot read (the self-target path) refuses this plan.
  assert.throws(() => loadPlanQuarantiningDuplicates(path), new RegExp(`task W1-T900102: depends_on unknown task '${UNSEEN}'`));
  for (const target of ["remudero-ops", "craigoley/remudero-ops", "Remudero-Ops"]) {
    const { plan, quarantined } = loadTargetPlanQuarantiningDuplicates(path, target);
    assert.deepEqual(plan.tasks.map((task) => task.id).sort(), ["W1-T900102", "W1-T900103"], `${target}: every task is held`);
    assert.deepEqual(plan.byId.get("W1-T900102")?.depends_on, [UNSEEN], `${target}: the unseen dependency is kept, not dropped`);
    assert.deepEqual(quarantined, []);
  }
});

test("W1-T13585: an own-repo task with an unknown dependency still fails the boot read", (t) => {
  const path = planAt(t, record("W1-T900104", "remudero", [UNSEEN]), record("W1-T900103", "remudero-ops", [UNSEEN]));
  assert.throws(() => loadTargetPlanQuarantiningDuplicates(path, "craigoley/remudero-ops"), (err: unknown) => {
    assert.ok(err instanceof PlanError);
    assert.equal(err.message, `task W1-T900103: depends_on unknown task '${UNSEEN}'`, "the same PlanError text as the strict read");
    return true;
  });
  // Duplicate-id quarantine still applies, and a task depending on a quarantined one is quarantined with it.
  const dup = planAt(t, record("W1-T900105", "remudero", [UNSEEN]) + record("W1-T900106", "remudero-ops", ["W1-T900105"]),
    record("W1-T900105", "remudero", []));
  const { plan, quarantined } = loadTargetPlanQuarantiningDuplicates(dup, "remudero-ops");
  assert.deepEqual(quarantined.map((q) => [q.id, q.reason]).sort(), [["W1-T900105", "duplicate_id"], ["W1-T900106", "depends_on_quarantined"]]);
  assert.deepEqual(plan.tasks, []);
});
