// W1-T13752 — an instance's Inbox classifies against its own repository's plan. remudero-ops carries core tasks
// (`repo: remudero`) that depend on core's public ids, which that plan cannot hold; serve's inbox:ops unit threw
// "depends_on unknown task" on every pass and the ops Inbox stopped updating. A task for the instance's own
// repository still fails the read on an unseen dependency, exactly as before.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { refreshInboxClassification } from "#src/lib/inbox-view.js";
import { loadPlanKeepingUnseenDependencies, PlanError } from "#src/lib/plan.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

const UNSEEN = "W1-T900001";

function record(id: string, repo: string, dependsOn: string[]): string {
  return `- id: ${id}\n  title: Fixture ${id}\n  repo: ${repo}\n  depends_on: [${dependsOn.join(", ")}]\n  type: implement\n` +
    "  verify: auto\n  risk: low\n  status: queued\n  files: [fixture.ts]\n  acceptance: []\n";
}

/** An instance state root holding `plan`, an empty proposal registry and an empty ledger. */
function instance(t: TestContext, plan: string) {
  const root = makeTempDir("rmd-instance-inbox-unseen");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "repos", "ops");
  const planPath = join(checkout, "plan", "tasks.yaml");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(join(checkout, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(planPath, plan);
  writeFileSync(ledgerPath, "");
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [] }));
  const base = { root: checkout, planPath, ledgerPath, inboxRoot: root, github: { prView: () => null }, statusGithub: fakeGitHub(),
    ratify: { approve() {}, reframe() {} } };
  const identity = { instance: "ops", repository: "owner/remudero-ops", root: checkout, planPath, ledgerPath, inboxRoot: root };
  return { planPath, core: base, ops: { ...base, inboxSourceIdentity: identity } };
}

test("W1-T13752 criterion 1: an instance Inbox classifies a plan whose other-repository task names a dependency that plan does not hold", async (t) => {
  const f = instance(t, record("W1-T900002", "remudero", [UNSEEN]) + record("W1-T900003", "remudero-ops", ["W1-T900002"]));
  // Positive control: the core Inbox, which names no source instance, still refuses the same plan strictly.
  await assert.rejects(refreshInboxClassification(f.core, {}), new RegExp(`task W1-T900002: depends_on unknown task '${UNSEEN}'`));
  const refreshed = await refreshInboxClassification(f.ops, {});
  assert.equal(refreshed.proposals, 0, "the instance pass completes over the plan");
  const plan = loadPlanKeepingUnseenDependencies(f.planPath, (task) => task.repo === "remudero");
  assert.deepEqual(plan.byId.get("W1-T900002")?.depends_on, [UNSEEN], "the unseen dependency is kept, not dropped");
});

test("W1-T13752 criterion 2: invariant:own-repo-dependencies-stay-strict — an instance Inbox still refuses its own repository's task with an unseen dependency", async (t) => {
  const f = instance(t, record("W1-T900004", "remudero-ops", [UNSEEN]) + record("W1-T900005", "remudero", [UNSEEN]));
  await assert.rejects(refreshInboxClassification(f.ops, {}), (err: unknown) => {
    assert.ok(err instanceof PlanError);
    assert.equal(err.message, `task W1-T900004: depends_on unknown task '${UNSEEN}'`);
    return true;
  });
});
