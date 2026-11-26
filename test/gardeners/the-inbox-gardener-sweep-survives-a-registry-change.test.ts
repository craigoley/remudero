// W1-T13668: on the host (2026-11-18 07:27-10:47Z) four clean shadow passes each evaluated 8 candidates, yet the store held
// only 16 entries and its cursor sat at position 9 of 2,429 proposals. The cursor was keyed to a digest of the whole
// candidate population, so any registry change between passes sent the sweep back to the first id.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runInboxGardener, type InboxGardenerCandidate, type InboxGardenerPack, type InboxGardenerPorts } from "#src/lib/inbox-gardener.js";
import { readInboxGardenerStore, type InboxGardenerScope } from "#src/lib/inbox-retirement.js";
import type { Clock } from "#src/lib/clock.js";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const SCOPE: InboxGardenerScope = { repository: "craigoley/remudero", instance: "core", root: "/r" };
const clock: Clock = { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() } as Clock;
// W1-T14978: a pass has no default count bound, so this file splits its sweep with an explicit per-pass count.
const PER_PASS = 8;

const id = (n: number) => `adoption:sweep-${String(n).padStart(3, "0")}`;
const candidate = (proposalId: string, summary = "unowned ask"): InboxGardenerCandidate =>
  ({ proposal: { id: proposalId, summary, evidenceAnchors: [] }, operatorIntent: "", unansweredReply: false, resolvedByOperator: false }) as InboxGardenerCandidate;
const pack = (candidates: InboxGardenerCandidate[]): InboxGardenerPack => ({ scope: SCOPE, snapshotKey: "b".repeat(64),
  generatedAt: new Date(NOW - 60_000).toISOString(), checkedAt: new Date(NOW).toISOString(), codeSha: "a".repeat(40),
  coverage: { plan: "observed", registry: "observed", github: "observed", ledger: "observed", threads: "observed" }, candidates, ledgerEventIds: new Set() });

function gardener(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-gardener-sweep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pass = (candidates: InboxGardenerCandidate[]) => {
    const ports: InboxGardenerPorts = { capture: async () => pack(candidates), proof: async () => assert.fail("no candidate here needs a proof"),
      mirror: async () => assert.fail("shadow mode mirrors nothing") };
    return runInboxGardener({ stateDir: dir, scope: SCOPE, ports, mode: "shadow", clock, limits: { candidates: PER_PASS } });
  };
  const store = () => { const read = readInboxGardenerStore(dir, SCOPE); assert.equal(read.state, "observed"); return read.state === "observed" ? read.store : assert.fail(); };
  return { pass, store };
}

test("W1-T13668 criterion 1: a registry change between passes resumes the sweep after the cursor instead of restarting at the first id", async t => {
  const g = gardener(t);
  const population = Array.from({ length: PER_PASS * 3 }, (_, i) => candidate(id(i + 1)));
  const first = await g.pass(population);
  assert.equal(first.state, "pending");
  assert.equal(g.store().cursor?.after, id(PER_PASS));
  const changed = [...population, candidate(id(900))]; // a new proposal changes the population digest
  changed[PER_PASS * 2] = candidate(id(PER_PASS * 2 + 1), "edited summary");
  const second = await g.pass(changed);
  assert.equal(second.state, "pending");
  assert.equal(g.store().cursor?.after, id(PER_PASS * 2), "the second pass read ids 9-16, not ids 1-8 again");
  assert.equal(Object.keys(g.store().entries).length, PER_PASS * 2);
});

test("W1-T13668 criterion 2: after the last id the next pass starts at the first id, so an id added behind the cursor is reached", async t => {
  const g = gardener(t);
  const population = Array.from({ length: PER_PASS + 2 }, (_, i) => candidate(id(i + 10)));
  await g.pass(population);
  const behind = [candidate(id(1)), ...population]; // sorts before the cursor
  const end = await g.pass(behind);
  assert.equal(end.state, "complete", "the sweep reached the last id");
  assert.equal(g.store().entries[id(1)], undefined, "an id added behind the cursor waits for the next sweep");
  const next = await g.pass(behind);
  assert.equal(next.state, "pending");
  assert.equal(g.store().entries[id(1)]?.decision, "keep_protected", "the next sweep starts at the first id");
});

test("W1-T13668 criterion 3: invariant cursor-past-end-wraps — a cursor past every remaining id wraps to the first id", async t => {
  const g = gardener(t);
  const population = Array.from({ length: PER_PASS + 1 }, (_, i) => candidate(id(i + 1)));
  await g.pass(population);
  assert.equal(g.store().cursor?.after, id(PER_PASS));
  const shrunk = population.slice(0, PER_PASS - 1); // every id after the cursor, and the cursor's own id, were removed
  const result = await g.pass(shrunk);
  assert.equal(result.state, "complete");
  assert.equal("evaluated" in result && result.evaluated, PER_PASS - 1);
  assert.equal(g.store().cursor?.after, "");
});
