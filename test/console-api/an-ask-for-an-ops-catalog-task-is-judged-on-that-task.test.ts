// W1-T15105. OBSERVED 2026-11-27 08:00Z in prod: machine-judge:W1-T9939 stayed in the Waiting folder although its task
// was released 24 days earlier. The task moved to the ops catalog on 2026-11-24 (#20632), and the core Inbox judged its
// asks on the public plan alone, so neither the release retirement nor the draft-free release could see the task.
// 70 of the 141 task ids in the Waiting folder were ops-only.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { updateProposalRegistry, type Proposal } from "#src/lib/inbox.js";
import { askTaskPlan, buildInboxVerbActions, classifyAllProposalsMemo, classifyAllProposalsSliced, projectInboxPlan, readAskTaskPlan,
  type PanelGraphDeps } from "#src/lib/panel-graph.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { BoardCatalogContext } from "#src/lib/serve-plan-reload.js";
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

const context = (combined?: Plan): BoardCatalogContext => (combined
  ? Object.assign({ outcome: "ok" as const, observedAt: "2026-11-27T08:00:00.000Z", taskCount: 2 }, { plan: combined, opsIds: new Set<string>() })
  : Object.assign({ outcome: "unreadable" as const, observedAt: "2026-11-27T08:00:00.000Z", reason: "fixture" }, { opsIds: new Set<string>() }));

function fixture(t: TestContext, proposals: Proposal[], catalog: Plan | undefined, wired = true) {
  const root = makeTempDir("rmd-ops-catalog-ask");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  updateProposalRegistry(join(state, "inbox-proposals.json"), () => proposals);
  const ledgerPath = join(state, "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ step: "ratify.approved", task_id: OPS_RELEASED, released: "verify-human", run_id: "RELEASE-8" })}\n`);
  const reads = { referent: 0, catalog: 0, plan: 0 };
  const approved: string[] = [];
  const deps: PanelGraphDeps = { root, inboxRoot: root, ledgerPath, planPath: join(root, "plan", "tasks.yaml"),
    statusGithub: fakeGitHub(), github: { prView: () => null },
    ratify: { approve: (id) => { approved.push(id); }, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40),
    readPlanSnapshot: () => { reads.plan++; return corePlan; },
    readPlanSource: () => ({ state: "loaded", generation: 1, identity: "ref:fixture", observedAt: "2026-11-27T08:00:00.000Z" }),
    ...(wired ? { inboxReferentPlan: () => { reads.referent++; return catalog; } } : {}),
    readInboxCatalog: async () => { reads.catalog++; return context(catalog); },
  };
  return { deps, reads, approved };
}

const states = (deps: PanelGraphDeps) =>
  new Map(classifyAllProposalsMemo(deps, () => corePlan).classifications.map(c => [c.proposalId, c]));

async function approve(deps: PanelGraphDeps, proposalId: string): Promise<number> {
  let status = 0;
  await buildInboxVerbActions(deps).approve({ proposalId }, { origin: "fixture" }, code => { status = code; });
  return status;
}

test("W1-T15105 criterion 1: an ask whose task is only in the ops catalog is judged on that task", async (t) => {
  const { deps } = fixture(t, [ask(PARKED_ASK), ask(RELEASED_ASK)], combinedPlan);
  const judged = states(deps);
  assert.equal(judged.get(PARKED_ASK)?.state, "ready", "a parked ops verify:human task's ask is its release");
  assert.equal(judged.get(PARKED_ASK)?.releaseTaskId, OPS_PARKED);
  assert.equal(judged.get(RELEASED_ASK)?.state, "retired", "an ask for a released ops task leaves the Inbox");

  // An ops-repo plan merge edits the named ops tasks; the slow lane's catalog hands the next pass the new
  // combined plan while the public plan, the ledger and the ids stay the same. The memo must not reuse.
  let catalog = plan(...corePlan.tasks, task(OPS_PARKED, "auto"), { ...task(OPS_RELEASED, "auto"), dispatch_hold: true });
  const live = { ...fixture(t, [ask(PARKED_ASK), ask(RELEASED_ASK)], combinedPlan).deps, inboxReferentPlan: () => catalog };
  const pass = async () => new Map((await classifyAllProposalsSliced(live, () => corePlan)).classifications.map(c => [c.proposalId, c.state]));
  const before = await pass();
  assert.notEqual(before.get(PARKED_ASK), "ready", "a verify:auto ops task has no release to offer");
  assert.notEqual(before.get(RELEASED_ASK), "retired", "a held ops task's release answers nothing");
  catalog = combinedPlan;
  const after = await pass();
  assert.equal(after.get(PARKED_ASK), "ready", "the ops task edited to parked: its ask is ready as its release");
  assert.equal(after.get(RELEASED_ASK), "retired", "the ops task's hold lifted: its released ask retires");
  assert.equal(states(live).get(PARKED_ASK)?.state, "ready", "the synchronous memo judges the same ops tasks");
});

test("W1-T15105 criterion 2: Approve judges an ops-catalog task's ask as the Inbox that offered it did", async (t) => {
  const world = fixture(t, [ask(PARKED_ASK)], combinedPlan, false);
  const status = await approve(world.deps, PARKED_ASK);
  assert.ok(status >= 200 && status < 300, `approve answered ${status}`);
  assert.equal(world.approved.length, 1, "the release is handed to the approve gateway");
  assert.equal(world.reads.catalog, 1, "the write read the catalog once");
  assert.equal(world.reads.plan, 1, "approve classifies against the same public plan object it checked");
});

test("W1-T15105: Keep classifies an ops-catalog ask with the same task as the Inbox", async (t) => {
  const world = fixture(t, [ask(PARKED_ASK)], combinedPlan, false);
  let status = 0;
  await buildInboxVerbActions(world.deps).keep({ proposalId: PARKED_ASK, kept: true }, { origin: "fixture" }, code => { status = code; });
  assert.ok(status < 300, `keep answered ${status}`);
  assert.equal(world.reads.catalog, 1, "keep reads the catalog once before saving the classification");
  assert.equal(world.reads.plan, 1, "keep classifies against the same public plan object it checked");
});

test("W1-T15105 criterion 3: invariant:public-plan-otherwise — no ok catalog, or an ask naming a public task, is judged exactly as before", async (t) => {
  const unreadable = fixture(t, [ask(PARKED_ASK), ask(RELEASED_ASK)], undefined);
  const judged = states(unreadable.deps);
  assert.notEqual(judged.get(PARKED_ASK)?.state, "ready", "no catalog: the task is unknown, so no release is offered");
  assert.notEqual(judged.get(RELEASED_ASK)?.state, "retired", "no catalog: the release cannot be matched to a task");
  const refused = fixture(t, [ask(PARKED_ASK)], undefined, false);
  assert.equal(await approve(refused.deps, PARKED_ASK), 409, "no ok catalog: the approve refuses");
  assert.deepEqual(refused.approved, []);
  assert.equal(refused.reads.catalog, 1, "the approve read the catalog, found it not ok, and kept the public plan");

  const publicOnly = fixture(t, [ask(PUBLIC_ASK)], combinedPlan);
  const result = classifyAllProposalsMemo(publicOnly.deps, () => corePlan);
  assert.equal(result.classifications[0]?.state, "ready", "a public task's ask is judged on the public plan");
  assert.equal(publicOnly.reads.referent, 0, "an ask naming a public task never reads the catalog");
  const opsNamed = fixture(t, [ask(PARKED_ASK)], combinedPlan);
  assert.deepEqual([...classifyAllProposalsMemo(opsNamed.deps, () => corePlan).projection.keys()], [PUBLIC],
    "the ops task never joins the Inbox's public projection");
  const composed = askTaskPlan(corePlan, [ask(PARKED_ASK)], () => combinedPlan);
  assert.equal(askTaskPlan(corePlan, [ask(PARKED_ASK)], () => combinedPlan), composed,
    "unchanged public plan, combined catalog and named ids preserve the composed Plan identity");
  const publicApprove = fixture(t, [ask(PUBLIC_ASK)], combinedPlan, false);
  assert.ok((await approve(publicApprove.deps, PUBLIC_ASK)) < 300);
  assert.equal(publicApprove.reads.catalog, 0, "an approve naming a public task never reads the catalog");
});

// The review's probe: a catalog holding ops tasks no ask names. Only the named ones may join the plan asks are judged on.
const OPS_UNNAMED = ["W1-T7", "W1-T6"];
const wideCatalog = plan(...corePlan.tasks, task("W1-T7", "auto"), task(OPS_PARKED, "human"), task("W1-T6", "human"));
const ids = (p: Plan) => p.tasks.map(x => x.id);

test("W1-T15105 criterion 3: invariant:public-plan-otherwise — verify-human:W1-T9 adds only W1-T9, not W1-T7 or W1-T6", async (t) => {
  const { deps, reads } = fixture(t, [ask(PARKED_ASK)], wideCatalog);
  const inbox = projectInboxPlan(deps, corePlan, undefined, () => [ask(PARKED_ASK)]);
  assert.deepEqual(ids(inbox.askPlan), [PUBLIC, OPS_PARKED], "the Inbox judges asks on the public plan plus W1-T9 alone");
  assert.deepEqual([...inbox.askProjection.keys()].sort(), [PUBLIC, OPS_PARKED].sort(), "only the named ops task is projected");
  assert.deepEqual([...inbox.projection.keys()], [PUBLIC], "the public projection is unchanged");
  assert.equal(reads.referent, 1, "one catalog read per pass");
  assert.equal(states(deps).get(PARKED_ASK)?.state, "ready", "the named task is still judged: its ask is its release");

  let terminalReads = 0;
  const read = async () => { terminalReads++; return context(wideCatalog); };
  assert.equal(await readAskTaskPlan(corePlan, [ask(PARKED_ASK)], deps.root, read), inbox.askPlan,
    "the terminal composes the very same plan as the Inbox");
  // The terminal approve passes the whole registry, so it composes what the Inbox composes from that registry.
  const registry = [ask(PARKED_ASK), ask("machine-judge:W1-T7")];
  const approving = await readAskTaskPlan(corePlan, registry, deps.root, read, [ask(PARKED_ASK)]);
  assert.deepEqual(ids(approving), [PUBLIC, "W1-T7", OPS_PARKED], "a task another ask names joins; W1-T6, named by none, does not");
  assert.equal(approving, projectInboxPlan(deps, corePlan, undefined, () => registry).askPlan, "terminal and Inbox: one set");
  assert.equal(terminalReads, 2);
  for (const id of OPS_UNNAMED) assert.ok(!inbox.askPlan.byId.has(id), `${id} is named by no ask`);
});

test("W1-T15105 criterion 3: invariant:public-plan-otherwise — an ask naming a task in neither catalog is judged exactly as before", async (t) => {
  const NOWHERE = ask("verify-human:W1-T404");
  const wired = fixture(t, [NOWHERE], wideCatalog);
  const inbox = projectInboxPlan(wired.deps, corePlan, undefined, () => [NOWHERE]);
  assert.equal(inbox.askPlan, corePlan, "no named task is found in the catalog: the public plan object itself");
  assert.equal(inbox.askProjection, inbox.projection, "and the public projection itself");
  assert.equal(askTaskPlan(corePlan, [NOWHERE], () => wideCatalog), corePlan, "no catalog task is projected for it");
  assert.equal(await readAskTaskPlan(corePlan, [NOWHERE], wired.deps.root, async () => context(wideCatalog)), corePlan);
  const judged = (deps: PanelGraphDeps) => classifyAllProposalsMemo(deps, () => corePlan).classifications
    .map(c => ({ id: c.proposalId, state: c.state, reasons: c.reasons, releaseTaskId: c.releaseTaskId }));
  const before = fixture(t, [NOWHERE], undefined, false);
  assert.deepEqual(judged(wired.deps), judged(before.deps), "judged exactly as with no catalog wired");
});

test("W1-T15105 criterion 3: invariant:public-plan-otherwise — an ask naming a public task reads no catalog", async (t) => {
  const registry = [ask(PUBLIC_ASK), ask(PARKED_ASK)];
  let reads = 0;
  const read = async () => { reads++; return context(wideCatalog); };
  assert.equal(await readAskTaskPlan(corePlan, registry, "unused", read, [ask(PUBLIC_ASK)]), corePlan,
    "the terminal approve of a public task keeps the public plan");
  assert.equal(reads, 0, "even beside an ops task's ask in the registry, the terminal read no catalog");
  const serve = fixture(t, registry, wideCatalog, false);
  assert.ok((await approve(serve.deps, PUBLIC_ASK)) < 300);
  assert.equal(serve.reads.catalog, 0, "serve's approve of a public task read no catalog");
  const publicOnly = fixture(t, [ask(PUBLIC_ASK)], wideCatalog);
  assert.equal(projectInboxPlan(publicOnly.deps, corePlan, undefined, () => [ask(PUBLIC_ASK)]).askPlan, corePlan);
  assert.equal(publicOnly.reads.referent, 0, "the Inbox pass read no catalog");
});
