// W1-T13714: serve reloads its plan in place at each plan-only merge (W1-T4481), while the daemon's checkout moves only
// at boot. On the host (2026-11-18 14:22-18:07Z) the gardener's whole-population source identity therefore differed from
// the snapshot's, and every pass stopped as source_partial with gap coverage:plan over about 2,400 proposals.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fixedClock, type Clock } from "#src/lib/clock.js";
import { persistedInboxPath, readPersistedInbox } from "#src/lib/fleet-lane.js";
import { classificationSnapshotKey } from "#src/lib/read-page.js";
import { defaultInboxGardenerPorts, runInboxGardener, type InboxGardenerCandidate, type InboxGardenerPack } from "#src/lib/inbox-gardener.js";
import { proofDebtPopulationPermit, readInboxGardenerStore, type InboxGardenerScope } from "#src/lib/inbox-retirement.js";
import { mintProofDebtProposals } from "#src/lib/measurement-cadence.js";
import { loadPlan } from "#src/lib/plan.js";
import { world } from "#test/helpers/why-me-world.js";

const TASK = "W1-T1200", OTHER = "W1-T1201", ID = `proof-debt:${TASK}`, OTHER_ID = `proof-debt:${OTHER}`;
const taskYaml = (id: string, title: string) => `- id: ${id}\n  title: ${title}\n  repo: core\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n`;

async function snapshotWorld(t: TestContext) {
  const w = await world(t);
  const planText = readFileSync(w.planPath, "utf8");
  writeFileSync(w.planPath, planText + taskYaml(TASK, "Repair mechanical proof") + taskYaml(OTHER, "Repair another proof"));
  const tasks = loadPlan(w.planPath).tasks.filter(task => task.id === TASK || task.id === OTHER);
  mintProofDebtProposals([TASK, OTHER].map(taskId => ({ taskId, criterionIndex: 0, cause: "grep-path-absent" as const, claim: "has proof", proof: "grep: missing in src/missing.ts" })),
    () => "plan/tasks.yaml", w.registry, { sourcePermit: proofDebtPopulationPermit(tasks) });
  await w.refresh();
  const scope = { repository: w.repository, instance: w.instance, root: w.root };
  const capture = () => defaultInboxGardenerPorts({ stateDir: w.state, scope, planPath: w.planPath, codeSha: "c".repeat(40), clock: fixedClock(Date.now()), githubJson: async () => [] }).capture();
  // The daemon's checkout now holds a different plan revision for one task only.
  const retitle = () => writeFileSync(w.planPath, planText + taskYaml(TASK, "Repair mechanical proof, retitled") + taskYaml(OTHER, "Repair another proof"));
  // The snapshot as an older writer stored it: a whole-population identity with no per-proposal digests.
  const dropItems = () => {
    const path = persistedInboxPath(w.state), snapshot = JSON.parse(readFileSync(path, "utf8"));
    assert.ok(snapshot.gardenerSource?.identity, "positive control: the writer stored a source identity");
    delete snapshot.gardenerSource.items;
    delete snapshot.whyMeFeedback;
    const { identity: _i, generatedAt: _g, snapshotKey: _k, attentionCensus, whyMeFeedback: _w, ...content } = snapshot;
    const { snapshotKey: _ck, ...facts } = attentionCensus;
    snapshot.snapshotKey = attentionCensus.snapshotKey = classificationSnapshotKey(content, facts);
    writeFileSync(path, JSON.stringify(snapshot));
    assert.equal(readPersistedInbox(w.state)?.snapshotKey, snapshot.snapshotKey, "positive control: the restamped snapshot is read, not refused");
  };
  return { capture, retitle, dropItems };
}

test("W1-T13714 criterion 1: when only some proposals' plan facts differ from the snapshot's, plan coverage is the census value and only those candidates are marked", async t => {
  const f = await snapshotWorld(t);
  const before = await f.capture();
  assert.equal(before.coverage.plan, "observed", "positive control: an unchanged plan reads observed");
  assert.equal(before.candidates.some(c => c.sourceChanged), false, "positive control: nothing is marked while the plans agree");
  f.retitle();
  const pack = await f.capture();
  assert.equal(pack.coverage.plan, "observed");
  assert.equal(pack.candidates.find(c => c.proposal.id === ID)?.sourceChanged, true);
  assert.equal(pack.candidates.find(c => c.proposal.id === OTHER_ID)?.sourceChanged, undefined, "a proposal whose facts agree is not marked");
});

test("W1-T13714 criterion 2: invariant snapshot-without-digests-stays-unavailable — a snapshot with no per-proposal digests keeps plan coverage unavailable when the identity differs", async t => {
  const f = await snapshotWorld(t);
  f.dropItems();
  assert.equal((await f.capture()).coverage.plan, "observed", "positive control: without a plan change the identity still matches");
  f.retitle();
  const pack = await f.capture();
  assert.equal(pack.coverage.plan, "unavailable");
  assert.equal(pack.candidates.some(c => c.sourceChanged), false);
});

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const SCOPE: InboxGardenerScope = { repository: "craigoley/remudero", instance: "core", root: "/r" };
const clock: Clock = { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() } as Clock;

test("W1-T13714 criterion 3: a marked candidate is skipped and counted as source_changed, never proven or retired, while the rest are still read", async t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-gardener-source-changed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const candidate = (id: string, extra: Partial<InboxGardenerCandidate> = {}) =>
    ({ proposal: { id, summary: "ask", evidenceAnchors: [] }, operatorIntent: "", unansweredReply: false, resolvedByOperator: false, ...extra }) as InboxGardenerCandidate;
  const pack: InboxGardenerPack = { scope: SCOPE, snapshotKey: "b".repeat(64), generatedAt: new Date(NOW - 60_000).toISOString(), checkedAt: new Date(NOW).toISOString(),
    codeSha: "a".repeat(40), coverage: { plan: "observed", registry: "observed", github: "observed", ledger: "observed", threads: "observed" },
    candidates: [candidate("adoption:a"), candidate("proof-debt:W1-T1:0", { sourceChanged: true })], ledgerEventIds: new Set() };
  const result = await runInboxGardener({ stateDir: dir, scope: SCOPE, mode: "act", clock, ports: { capture: async () => pack,
    proof: async () => assert.fail("a marked candidate is never proven"), mirror: async () => assert.fail("nothing is retired") } });
  assert.deepEqual(result, { state: "complete", complete: true, evaluated: 2, retired: 0, judged: 0, proofReads: 0, source_changed: 1 });
  const store = readInboxGardenerStore(dir, SCOPE);
  assert.equal(store.state === "observed" && store.store.entries["proof-debt:W1-T1:0"]?.decision, "defer_source");
  assert.equal(store.state === "observed" && store.store.entries["adoption:a"]?.decision, "keep_protected", "the unmarked candidate was still read");
});
