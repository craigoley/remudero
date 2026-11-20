import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { instancePlanLoader, instanceStateRoot } from "#src/lib/instance-gateway.js";
import { nowInstancePlan } from "#src/lib/now-view.js";
import { loadPlan, PlanError } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const task = (id: string, repo: string, deps: string[]) =>
  `- id: ${id}\n  title: ${id} title\n  repo: ${repo}\n  type: implement\n  depends_on: [${deps.join(", ")}]\n  status: queued\n`;

/** An ops-like catalog: its own task, and a core task (repo: remudero) that depends on a core id it does not hold. */
function plan(t: TestContext, ownDeps: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t13826-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "plan"), { recursive: true });
  const path = join(dir, "plan", "tasks.yaml");
  writeFileSync(path, task("OPS-T1", "remudero-ops", ownDeps) + task("W1-T13722", "remudero", ["W1-T10840"]));
  return path;
}

test("W1-T13826 criterion 1: serve's instance plan read keeps a dependency another repository's task names that the plan does not hold", (t) => {
  const path = plan(t);
  assert.throws(() => loadPlan(path), /depends_on unknown task 'W1-T10840'/, "the strict read refuses this plan");
  const root = instanceStateRoot({ name: "ops", repo: "craigoley/remudero-ops" } as Parameters<typeof instanceStateRoot>[0], "/state");
  assert.equal(root.repo, "craigoley/remudero-ops");
  const read = instancePlanLoader(root)(path);
  assert.deepEqual(read.tasks.map((x) => x.id), ["OPS-T1", "W1-T13722"]);
  assert.deepEqual(read.byId.get("W1-T13722")?.depends_on, ["W1-T10840"], "the dependency is kept, not dropped");
});

test("W1-T13826 criterion 2: invariant:own-repo-dependencies-stay-strict — an instance's own task with an unseen dependency still fails with loadPlan's text", (t) => {
  const path = plan(t, ["OPS-T9"]);
  const strict = (() => { try { loadPlan(path); } catch (error) { return error; } })();
  assert.ok(strict instanceof PlanError);
  assert.throws(() => instancePlanLoader({ repo: "craigoley/remudero-ops" })(path), (error: unknown) =>
    error instanceof PlanError && error.message === "task OPS-T1: depends_on unknown task 'OPS-T9'");
  assert.equal(instancePlanLoader({}), loadPlan, "a root with no repository reads with loadPlan itself");
});

test("W1-T13826 criterion 3: the now view reads another instance's plan with the same rule", (t) => {
  const path = plan(t);
  assert.deepEqual(nowInstancePlan(path, "craigoley/remudero-ops").byId.get("W1-T13722")?.depends_on, ["W1-T10840"]);
  const own = plan(t, ["OPS-T9"]);
  assert.throws(() => nowInstancePlan(own, "craigoley/remudero-ops"), /OPS-T1: depends_on unknown task 'OPS-T9'/);
});
