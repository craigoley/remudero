import assert from "node:assert/strict";
import {mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {gzipSync} from "node:zlib";
import {test, type TestContext} from "node:test";
import {createEscalationTriageHistoryReader} from "#src/lib/sweep.js";
import {projectRetroReadCost, RETRO_TRIGGER_RUN_SLICE, rotationDigestFile} from "#src/run-task.js";
import {writeLedger} from "#test/helpers/ledger-fixture.js";

const at = "2026-10-01T00:00:00.000Z";
const name = "ledger.2026-10-01T00-00-00-000Z.ndjson.gz";
const row = {ts: at, run_id: "W1-T1-fixture", task_id: "W1-T1", step: "run.start", pad: "x".repeat(2000)};
const newReader = () => createEscalationTriageHistoryReader({slice: RETRO_TRIGGER_RUN_SLICE});
function fixture(scope: TestContext) {
  const {dir} = writeLedger([], {scope, rotations: [{at, gz: true, rows: [row]}]});
  return {dir, archive: join(dir, name), digest: rotationDigestFile(dir, RETRO_TRIGGER_RUN_SLICE.holder, name)};
}
type Fixture = ReturnType<typeof fixture>;
async function warm(f: Fixture) {
  const reader = newReader();
  const read = await reader(f.dir);
  assert.equal(read.ok, true);
  assert.equal(read.rows.length, 1);
  assert.equal(reader.lastLoad().digestMisses, 1);
  return JSON.parse(readFileSync(f.digest, "utf8"));
}
async function miss(scope: TestContext, mutate: (f: Fixture, digest: Record<string, unknown>) => void) {
  const f = fixture(scope);
  const cold = await projectRetroReadCost(f.dir);
  assert.ok(cold.projectedBytes > 2000, "real cold-size positive control");
  mutate(f, await warm(f));
  const projected = await projectRetroReadCost(f.dir);
  const reader = newReader();
  assert.equal((await reader(f.dir)).ok, true);
  assert.equal(reader.lastLoad().digestMisses, 1, "REAL reader rejected the existing digest");
  assert.equal(reader.lastLoad().digestHits, 0);
  assert.equal(projected.undigested, 1, "the cost projection must agree with the real miss");
  assert.ok(projected.projectedBytes >= cold.projectedBytes, "the rejected digest cannot make archive decompression free");
}

test("retro cost projection treats invalid digests as archive reads: corrupt JSON", async t => {
  await miss(t, f => writeFileSync(f.digest, "{corrupt"));
});

test("retro cost projection treats invalid digests as archive reads: invalid row schema", async t => {
  await miss(t, (f, d) => writeFileSync(f.digest, JSON.stringify({...d, read: {rows: [null], torn: 0, tornLines: []}})));
});

test("retro cost projection treats invalid digests as archive reads: obsolete reducer version", async t => {
  await miss(t, (f, d) => writeFileSync(f.digest, JSON.stringify({...d, reducerVersion: "obsolete-fixture-version"})));
});

test("retro cost projection treats invalid digests as archive reads: changed archive identity", async t => {
  await miss(t, f => writeFileSync(f.archive, gzipSync(JSON.stringify({...row, pad: "larger".repeat(2000)}) + "\n")));
});

test("retro cost projection treats invalid digests as archive reads: foreign holder", async t => {
  await miss(t, (f, d) => writeFileSync(f.digest, JSON.stringify({...d, holder: "another-holder"})));
});

test("retro cost projection treats invalid digests as archive reads: another archive", async t => {
  await miss(t, (f, d) => writeFileSync(f.digest, JSON.stringify({...d, archive: "another-archive.ndjson.gz"})));
});

test("retro cost projection treats invalid digests as archive reads: unreadable digest", async t => {
  await miss(t, f => { rmSync(f.digest); mkdirSync(f.digest); });
});

test("retro cost projection preserves genuine current hits and cold archive reads", async t => {
  const f = fixture(t);
  assert.equal((await projectRetroReadCost(f.dir)).undigested, 1);
  await warm(f);
  assert.deepEqual(await projectRetroReadCost(f.dir), {projectedBytes: 0, rotations: 1, undigested: 0});
  const restarted = newReader();
  assert.equal((await restarted(f.dir)).ok, true);
  assert.equal(restarted.lastLoad().digestHits, 1, "REAL restarted-reader hit is the positive control");
  assert.equal(restarted.lastLoad().digestMisses, 0);
});
