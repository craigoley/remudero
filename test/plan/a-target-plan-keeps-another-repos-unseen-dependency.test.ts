// W1-T14712 — a plan read for a target repository keeps the unseen dependency of a task that names another repository.
// The catalog move put core records (`repo: remudero`) depending on public ids into remudero-ops's plan. The ops daemon's
// boot read already kept them (W1-T13585), but each lane run synced its plan through the daemon's strict plan store, so
// the first dispatch threw and the daemon stopped with "W1-T14555: task W1-T10052: depends_on unknown task 'W1-T9710'".
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  keepsForeignTaskUnseenDependency, loadTargetPlanForReload, loadTargetPlanOrEmptyWhenAbsent, runDrain, runnableCandidates,
  targetPlanRevisionStore, taskTargetsRepo,
} from "#src/lib/drain.js";
import { createPlanRevisionStore, type PlanRevisionStore } from "#src/lib/plan-revision-store.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const OPS = { owner: "owner", repo: "remudero-ops" };
const OPS_REPO = `${OPS.owner}/${OPS.repo}`;
const CORE_TASK = "W1-T900301"; // the shape of W1-T10052: a core record the catalog move copied into the ops plan
const UNSEEN = "W1-T900300"; // the shape of W1-T9710: a merged public record the ops plan never holds
const OPS_TASK = "W1-T900302"; // the shape of W1-T14555: the ops daemon's own task, the one its lane runs
const REVISION = { key: "fixture-blob:fixture-tree", commit: "0".repeat(40), repoDir: "/fixture", relPath: "plan/tasks.yaml" };

function record(id: string, repo: string, dependsOn: string[]): string {
  return `- id: ${id}\n  title: Fixture ${id}\n  repo: ${repo}\n  depends_on: [${dependsOn.join(", ")}]\n  type: implement\n` +
    "  verify: auto\n  risk: low\n  budget_usd: 5\n  status: queued\n  files: [fixture.ts]\n  acceptance:\n" +
    `    - claim: ${id} holds\n      proof: "grep: ${id} in fixture.ts"\n`;
}

/** The blobs a lane's sync reads at origin/main: an empty monolith and one shard per record, as the ops catalog is. */
function opsCatalogBlobs(shards: string[]): Array<{ label: string; text: string }> {
  return [{ label: "origin/main:plan/tasks.yaml", text: "[]\n" },
    ...shards.map((text, i) => ({ label: `origin/main:plan/tasks.d/fixture-${i}.yaml`, text }))];
}

const liveShape = () => opsCatalogBlobs([record(CORE_TASK, "remudero", [UNSEEN]), record(OPS_TASK, "remudero-ops", [])]);

/** The lane run's plan load: what syncPlanFromOriginAsync does with the daemon's store once git has read the blobs. */
const laneSync = (store: PlanRevisionStore, blobs: Array<{ label: string; text: string }>): Plan => store.adopt(REVISION, blobs).plan;

function checkoutPlan(t: TestContext, shards: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}target-plan-keeps-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  shards.forEach((text, i) => writeFileSync(join(dir, "plan", "tasks.d", `fixture-${i}.yaml`), text));
  return join(dir, "plan", "tasks.yaml");
}

const ok = (taskId: string): RunResult => ({ taskId, runId: `${taskId}-run`, merged: true, costUsd: 0, verdict: "merged" });

test("W1-T14712 criterion 1: a plan loaded for owner/remudero-ops keeps a repo: remudero task's dependency on an id it does not hold", () => {
  // Positive control: the store every daemon built until now (and still builds for self) throws the production text.
  assert.throws(() => laneSync(createPlanRevisionStore(), liveShape()),
    { message: `task ${CORE_TASK}: depends_on unknown task '${UNSEEN}'` });
  const plan = laneSync(targetPlanRevisionStore(OPS_REPO), liveShape());
  assert.deepEqual(plan.tasks.map((t) => t.id), [CORE_TASK, OPS_TASK]);
  assert.deepEqual(plan.byId.get(CORE_TASK)?.depends_on, [UNSEEN], "the dependency is kept, never dropped");
  assert.equal(plan.byId.has(UNSEEN), false);
});

test("W1-T14712 criterion 2: a task of the target itself, or one naming no repo, with an unresolved dependency still throws", (t) => {
  // The target's own task, through the lane's store, the reload and the boot read: each throws exactly as before.
  const own = opsCatalogBlobs([record(OPS_TASK, "remudero-ops", [UNSEEN])]);
  assert.throws(() => laneSync(targetPlanRevisionStore(OPS_REPO), own), { message: `task ${OPS_TASK}: depends_on unknown task '${UNSEEN}'` });
  const ownOwnerQualified = opsCatalogBlobs([record(OPS_TASK, "Owner/Remudero-Ops", [UNSEEN])]);
  assert.throws(() => laneSync(targetPlanRevisionStore(OPS_REPO), ownOwnerQualified), { message: /depends_on unknown task/ });
  const path = checkoutPlan(t, [record(OPS_TASK, "remudero-ops", [UNSEEN])]);
  assert.throws(() => loadTargetPlanForReload(path, OPS_REPO), { message: `task ${OPS_TASK}: depends_on unknown task '${UNSEEN}'` });
  assert.throws(() => loadTargetPlanOrEmptyWhenAbsent(path, OPS_REPO, () => {}), { message: /depends_on unknown task/ });
  // A task naming no repository is the dispatch guard's "nothing to compare" case: it may dispatch, so it stays strict.
  const keep = keepsForeignTaskUnseenDependency(OPS_REPO);
  assert.equal(keep({ repo: "" } as Task), false);
  assert.equal(keep({ repo: undefined } as unknown as Task), false);
  assert.equal(keep({ repo: "remudero-ops" } as Task), false);
  assert.equal(keep({ repo: "remudero" } as Task), true);
  // Self keeps the strict store: the core daemon's own plan is unchanged.
  assert.throws(() => laneSync(targetPlanRevisionStore(undefined), liveShape()), { message: /depends_on unknown task/ });
});

test("W1-T14712 criterion 3: a daemon run of a remudero-ops task over the live ops catalog shape no longer stops with error", async (t) => {
  // The boot read and the reload of the same catalog on disk both keep it.
  const path = checkoutPlan(t, [record(CORE_TASK, "remudero", [UNSEEN]), record(OPS_TASK, "remudero-ops", [])]);
  const boot = loadTargetPlanOrEmptyWhenAbsent(path, OPS_REPO, () => {});
  assert.deepEqual(boot.plan.tasks.map((task) => task.id), [CORE_TASK, OPS_TASK]);
  assert.deepEqual(loadTargetPlanForReload(path, OPS_REPO).byId.get(CORE_TASK)?.depends_on, [UNSEEN]);

  // A drain whose lane syncs the plan through `store`, as runTask does through the daemon's coalescer.
  const drainWith = async (store: PlanRevisionStore) => {
    const ran: string[] = [];
    const summary = await runDrain(boot.plan, {
      refreshMerged: () => () => false,
      runOne: async (id) => {
        laneSync(store, liveShape());
        ran.push(id);
        return ok(id);
      },
    }, { max: 1 });
    return { summary, ran };
  };
  // Positive control: the strict store stops the drain with the production row's own detail.
  const strict = await drainWith(createPlanRevisionStore());
  assert.equal(strict.summary.stopReason, "error");
  assert.equal(strict.summary.stopDetail, `${OPS_TASK}: task ${CORE_TASK}: depends_on unknown task '${UNSEEN}'`);
  const kept = await drainWith(targetPlanRevisionStore(OPS_REPO));
  assert.notEqual(kept.summary.stopReason, "error", kept.summary.stopDetail);
  assert.deepEqual(kept.ran, [OPS_TASK]);
});

test("W1-T14712 criterion 4: invariant:only-foreign-tasks-keep-unseen-deps — nothing a target can dispatch loads with an unresolved dependency", () => {
  const plan = laneSync(targetPlanRevisionStore(OPS_REPO), liveShape());
  const unresolved = plan.tasks.filter((task) => task.depends_on.some((dep) => !plan.byId.has(dep)));
  assert.deepEqual(unresolved.map((task) => task.id), [CORE_TASK], "control: the kept plan really holds an unresolved dependency");
  for (const task of unresolved) assert.equal(taskTargetsRepo(task.repo, OPS.repo), false, `${task.id} is another repository's`);
  // Dispatch for the target refuses the kept task as another repository's, before its dependency is ever walked.
  const filtered: Array<[string, string]> = [];
  const candidates = runnableCandidates(plan, () => false, 10, {
    targetRepo: OPS.repo,
    onFiltered: (task, reason) => filtered.push([task.id, reason]),
  });
  assert.deepEqual(candidates.map((task) => task.id), [OPS_TASK]);
  assert.deepEqual(filtered, [[CORE_TASK, "foreign-repo"]]);
});
