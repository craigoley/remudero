// W1-T15105. OBSERVED 2026-11-27 08:00Z in prod: machine-judge:W1-T9939 stayed in the Waiting folder although its task
// was released 24 days earlier. The task moved to the ops catalog on 2026-11-24 (#20632), and the core Inbox judged its
// asks on the public plan alone, so neither the release retirement nor the draft-free release could see the task.
// 70 of the 141 task ids in the Waiting folder were ops-only.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { updateProposalRegistry, type Proposal } from "#src/lib/inbox.js";
import { buildPanelGraphRoutes, classifyAllProposalsMemo, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { BoardCatalogContext } from "#src/lib/serve-plan-reload.js";
import { createService } from "#src/lib/service.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

const PUBLIC = "W1-T1";
const OPS_PARKED = "W1-T9"; // a queued verify:human task in the ops catalog
const OPS_RELEASED = "W1-T8"; // an ops task the ledger shows released
const task = (id: string, verify: "human" | "auto"): Task => ({ id, title: `Task ${id}`, repo: "remudero", depends_on: [],
  type: "implement", risk: "medium", verify, status: "queued", attempts: 0 });
const plan = (...tasks: Task[]): Plan => ({ tasks, byId: new Map(tasks.map(t => [t.id, t])) });
const corePlan = plan(task(PUBLIC, "human"));
const combinedPlan = plan(...corePlan.tasks, task(OPS_PARKED, "human"), task(OPS_RELEASED, "auto"));
const ask = (id: string): Proposal => ({ id, summary: `Release ${id}`, evidenceAnchors: [] });
const PARKED_ASK = `verify-human:${OPS_PARKED}`;
const RELEASED_ASK = `machine-judge:${OPS_RELEASED}`;
const PUBLIC_ASK = `verify-human:${PUBLIC}`;

function fixture(t: TestContext, proposals: Proposal[], catalog: Plan | undefined, wired = true) {
  const root = makeTempDir("rmd-ops-catalog-ask");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  updateProposalRegistry(join(state, "inbox-proposals.json"), () => proposals);
  const ledgerPath = join(state, "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ step: "ratify.approved", task_id: OPS_RELEASED, released: "verify-human", run_id: "RELEASE-8" })}\n`);
  const reads = { referent: 0, catalog: 0 };
  const approved: string[] = [];
  const context = (combined?: Plan): BoardCatalogContext => (combined
    ? Object.assign({ outcome: "ok" as const, observedAt: "2026-11-27T08:00:00.000Z", taskCount: 2 }, { plan: combined, opsIds: new Set<string>() })
    : Object.assign({ outcome: "unreadable" as const, observedAt: "2026-11-27T08:00:00.000Z", reason: "fixture" }, { opsIds: new Set<string>() }));
  const deps: PanelGraphDeps = { root, inboxRoot: root, ledgerPath, planPath: join(root, "plan", "tasks.yaml"),
    statusGithub: fakeGitHub(), github: { prView: () => null },
    ratify: { approve: (id) => { approved.push(id); }, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40),
    readPlanSnapshot: () => corePlan,
    readPlanSource: () => ({ state: "loaded", generation: 1, identity: "ref:fixture", observedAt: "2026-11-27T08:00:00.000Z" }),
    ...(wired ? { inboxReferentPlan: () => { reads.referent++; return catalog; } } : {}),
    readInboxCatalog: async () => { reads.catalog++; return context(catalog); },
  };
  return { deps, reads, approved };
}

const states = (deps: PanelGraphDeps) =>
  new Map(classifyAllProposalsMemo(deps, () => corePlan).classifications.map(c => [c.proposalId, c]));

async function approve(deps: PanelGraphDeps, proposalId: string): Promise<number> {
  const server = createService({ tokens: { read: "read-token", write: "write-token" }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox/approve`, {
      method: "POST", headers: { authorization: "Bearer write-token", "content-type": "application/json" },
      body: JSON.stringify({ proposalId }),
    });
    await response.text();
    return response.status;
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("W1-T15105 criterion 1: an ask whose task is only in the ops catalog is judged on that task", (t) => {
  const { deps } = fixture(t, [ask(PARKED_ASK), ask(RELEASED_ASK)], combinedPlan);
  const judged = states(deps);
  assert.equal(judged.get(PARKED_ASK)?.state, "ready", "a parked ops verify:human task's ask is its release");
  assert.equal(judged.get(PARKED_ASK)?.releaseTaskId, OPS_PARKED);
  assert.equal(judged.get(RELEASED_ASK)?.state, "retired", "an ask for a released ops task leaves the Inbox");
});

test("W1-T15105 criterion 2: Approve judges an ops-catalog task's ask as the Inbox that offered it did", async (t) => {
  const world = fixture(t, [ask(PARKED_ASK)], combinedPlan, false);
  const status = await approve(world.deps, PARKED_ASK);
  assert.ok(status >= 200 && status < 300, `approve answered ${status}`);
  assert.equal(world.approved.length, 1, "the release is handed to the approve gateway");
  assert.equal(world.reads.catalog, 1, "the write read the catalog once");
});

test("W1-T15105 criterion 3: invariant:public-plan-otherwise — no ok catalog, or an ask naming a public task, is judged exactly as before", async (t) => {
  const unreadable = fixture(t, [ask(PARKED_ASK), ask(RELEASED_ASK)], undefined);
  const judged = states(unreadable.deps);
  assert.notEqual(judged.get(PARKED_ASK)?.state, "ready", "no catalog: the task is unknown, so no release is offered");
  assert.notEqual(judged.get(RELEASED_ASK)?.state, "retired", "no catalog: the release cannot be matched to a task");
  const refused = fixture(t, [ask(PARKED_ASK)], undefined, false);
  assert.equal(await approve(refused.deps, PARKED_ASK), 409, "no ok catalog: the approve refuses");
  assert.deepEqual(refused.approved, []);

  const publicOnly = fixture(t, [ask(PUBLIC_ASK)], combinedPlan);
  const result = classifyAllProposalsMemo(publicOnly.deps, () => corePlan);
  assert.equal(result.classifications[0]?.state, "ready", "a public task's ask is judged on the public plan");
  assert.equal(publicOnly.reads.referent, 0, "an ask naming a public task never reads the catalog");
  const opsNamed = fixture(t, [ask(PARKED_ASK)], combinedPlan);
  assert.deepEqual([...classifyAllProposalsMemo(opsNamed.deps, () => corePlan).projection.keys()], [PUBLIC],
    "the ops task never joins the Inbox's public projection");
  const publicApprove = fixture(t, [ask(PUBLIC_ASK)], combinedPlan, false);
  assert.ok((await approve(publicApprove.deps, PUBLIC_ASK)) < 300);
  assert.equal(publicApprove.reads.catalog, 0, "an approve naming a public task never reads the catalog");
});
