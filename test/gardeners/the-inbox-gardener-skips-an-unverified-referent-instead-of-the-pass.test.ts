// W1-T13682: on the host (2026-11-18 05:00-06:52Z) two Console test proposals carried an originatingItemId that no
// board item has. Their referents read unverified, the census set githubProjection partial, and every gardener pass
// stopped as source_partial with gap coverage:github, over 2,400 proposals whose referents were fine.
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
import { parseProposalRegistry } from "#src/lib/inbox.js";
import { mintProofDebtProposals } from "#src/lib/measurement-cadence.js";
import { loadPlan } from "#src/lib/plan.js";
import { world } from "#test/helpers/why-me-world.js";

const TASK = "W1-T1200", ID = `proof-debt:${TASK}`, TEST_ITEM = "operator-test:console-answers-a";

async function snapshotWorld(t: TestContext) {
  const w = await world(t);
  appendFileSync(w.planPath, `- id: ${TASK}\n  title: Repair mechanical proof\n  repo: core\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n`);
  mintProofDebtProposals([{ taskId: TASK, criterionIndex: 0, cause: "grep-path-absent", claim: "has proof", proof: "grep: missing in src/missing.ts" }], () => "plan/tasks.yaml", w.registry,
    { sourcePermit: proofDebtPopulationPermit(loadPlan(w.planPath).tasks.filter(task => task.id === TASK)) });
  const proposals = parseProposalRegistry(readFileSync(w.registry, "utf8"));
  proposals.push({ id: TEST_ITEM, summary: "TEST ITEM, not a real decision", evidenceAnchors: [], originatingItemId: "operator-test-a" });
  writeFileSync(w.registry, JSON.stringify({ proposals }));
  await w.refresh();
  const scope = { repository: w.repository, instance: w.instance, root: w.root };
  const capture = () => defaultInboxGardenerPorts({ stateDir: w.state, scope, planPath: w.planPath, codeSha: "c".repeat(40), clock: fixedClock(Date.now()), githubJson: async () => [] }).capture();
  // The snapshot as the host's census wrote it: one unverified referent, no indeterminate projection value.
  const restamp = (projectionIndeterminate: boolean) => {
    const path = persistedInboxPath(w.state), snapshot = JSON.parse(readFileSync(path, "utf8"));
    snapshot.classifications = snapshot.classifications.map((c: { proposalId: string }) => c.proposalId === TEST_ITEM ? { ...c, referentUnverified: true } : c);
    snapshot.projectionIndeterminate = projectionIndeterminate;
    snapshot.attentionCensus = { ...snapshot.attentionCensus, sources: { ...snapshot.attentionCensus.sources, githubProjection: "partial" } };
    delete snapshot.whyMeFeedback;
    // Re-key exactly as the writer does, so the reader accepts the restamped file (checked below).
    const { identity: _i, generatedAt: _g, snapshotKey: _k, attentionCensus, whyMeFeedback: _w, ...content } = snapshot;
    const { snapshotKey: _ck, ...facts } = attentionCensus;
    snapshot.snapshotKey = attentionCensus.snapshotKey = classificationSnapshotKey(content, facts);
    writeFileSync(path, JSON.stringify(snapshot));
    assert.equal(readPersistedInbox(w.state)?.snapshotKey, snapshot.snapshotKey, "positive control: the restamped snapshot is read, not refused");
  };
  return { capture, restamp };
}

test("W1-T13682 criterion 1: when only referents are unverified, GitHub coverage reads observed and each such candidate is marked", async t => {
  const f = await snapshotWorld(t);
  f.restamp(false);
  const pack = await f.capture();
  assert.equal(pack.coverage.github, "observed");
  assert.equal(pack.candidates.find(c => c.proposal.id === TEST_ITEM)?.referentUnverified, true);
  assert.equal(pack.candidates.find(c => c.proposal.id === ID)?.referentUnverified, undefined, "a verified referent is not marked");
});

test("W1-T13682 criterion 2: invariant indeterminate-projection-stays-partial — an indeterminate projection value keeps GitHub coverage partial", async t => {
  const f = await snapshotWorld(t);
  f.restamp(true);
  assert.equal((await f.capture()).coverage.github, "partial");
});

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const SCOPE: InboxGardenerScope = { repository: "craigoley/remudero", instance: "core", root: "/r" };
const clock: Clock = { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() } as Clock;

test("W1-T13682 criterion 3: an unverified candidate is skipped and counted, never proven or retired, while the rest are still read", async t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-gardener-unverified-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const candidate = (id: string, extra: Partial<InboxGardenerCandidate> = {}) =>
    ({ proposal: { id, summary: "ask", evidenceAnchors: [] }, operatorIntent: "", unansweredReply: false, resolvedByOperator: false, ...extra }) as InboxGardenerCandidate;
  const pack: InboxGardenerPack = { scope: SCOPE, snapshotKey: "b".repeat(64), generatedAt: new Date(NOW - 60_000).toISOString(), checkedAt: new Date(NOW).toISOString(),
    codeSha: "a".repeat(40), coverage: { plan: "observed", registry: "observed", github: "observed", ledger: "observed", threads: "observed" },
    candidates: [candidate("adoption:a"), candidate("operator-test:b", { referentUnverified: true })], ledgerEventIds: new Set() };
  const result = await runInboxGardener({ stateDir: dir, scope: SCOPE, mode: "act", clock, ports: { capture: async () => pack,
    proof: async () => assert.fail("an unverified candidate is never proven"), mirror: async () => assert.fail("nothing is retired") } });
  assert.deepEqual(result, { state: "complete", complete: true, evaluated: 2, retired: 0, judged: 0, proofReads: 0, unverified_referents: 1 });
  const store = readInboxGardenerStore(dir, SCOPE);
  assert.equal(store.state === "observed" && store.store.entries["operator-test:b"]?.decision, "defer_source");
  assert.equal(store.state === "observed" && store.store.entries["adoption:a"]?.decision, "keep_protected", "the verified candidate was still read");
});
