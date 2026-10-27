import assert from "node:assert/strict";
import fs, { chmodSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { captureGardenerSpendSource, foldGardenerSpend, GARDENER_SPEND_MAX_BYTES,
  GARDENER_SPEND_MAX_GARDENS, type GardenerSpendSource } from "#src/lib/gardener-spend.js";
import { fixedClock } from "#src/lib/clock.js";
import { fingerprintLedgerLine } from "#src/lib/ledger-union.js";
import { SPEND_STEP_ROLES, spendAmountUsd } from "#src/lib/spend-rows.js";
import { makeTempDir } from "#src/lib/tmp.js";

const repository = "fixture/repo";
const at = new Date().toISOString();
const observedAt = new Date(Date.parse(at) + 1000).toISOString();
const materializedAt = new Date(Date.parse(at) + 2000).toISOString();
const passId = "12345678-1234-4123-8123-123456789abc";
const origin = { state: "linked", version: 1, name: "config", passId } as const;
const parent = { ts: at, step: "garden.lifecycle", name: "config", passId, repository,
  daemon_run_id: "daemon-1", phase: "completed", exit: 0 };
const child = { ts: at, step: "implement.done", total_cost_usd: 2, gardener_origin: origin };
const runtime = () => ({ version: 1, repository, daemonRunId: "daemon-1", codeSha: null,
  configuredAt: at, observedAt: at, gardens: [{ name: "config", enabled: false, scope: "repository",
    cadenceMs: 1000, phase: "scheduled", observedAt: at, passId: null, nextDueAt: null,
    queueMs: null, executionMs: null, exit: null, reason: null, attempts: 1, completions: 1,
    failures: 0, lastCompletedAt: null, lastSuccessAt: null, lastFailureAt: null }] });

async function capture(t: { after(fn: () => void): void }, rows: object[], inventory = runtime()) {
  const dir = makeTempDir("gardener-compact-cost");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "gardener-runtime.json"), JSON.stringify(inventory));
  writeFileSync(join(dir, "ledger.ndjson"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const source = await captureGardenerSpendSource(dir, fixedClock(Date.parse(observedAt)));
  return { dir, source, spend: foldGardenerSpend(source, repository, materializedAt) };
}

test("W1-T8667: many priced receipts fit bounded gardener summaries", async t => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ ...child, run_id: `child-${i}` }));
  const { source, spend } = await capture(t, [...rows, parent]);
  assert.equal(source.reason, undefined);
  assert.ok(source.compact, "capture must materialize a compact source");
  assert.ok(source.receipts === undefined);
  assert.equal(spend.state, "complete");
  assert.equal(spend.totalUsd, 1000);
  assert.equal(spend.gardens[0]!.totalUsd, 1000);
  assert.deepEqual(spend.counts, { priced: 500, unpriced: 0, unlinked: 0 });
  assert.equal(spend.gardens[0]!.enabled, false);
  assert.equal(spend.window!.from, at);
  assert.equal(spend.observedAt, observedAt);
  assert.equal(spend.materializedAt, materializedAt);
  assert.equal(GARDENER_SPEND_MAX_BYTES, 65536);
  assert.equal(GARDENER_SPEND_MAX_GARDENS, 32);
  assert.ok(Buffer.byteLength(JSON.stringify(source)) < 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(spend)) <= GARDENER_SPEND_MAX_BYTES);
});

test("W1-T8667: compact costs preserve scoped parent and unknown evidence", async t => {
  const steps = Object.entries(SPEND_STEP_ROLES).filter(([, role]) => role === "produced").map(([step]) => step);
  const rows = steps.map(step => ({ ...child, step }));
  const { source, spend } = await capture(t, [...rows, { ...child, total_cost_usd: undefined }, parent,
    { ...parent, phase: "cancelled", exit: undefined },
    { ...child, repository: "wrong/repo" }, { ...child, daemon_run_id: "wrong-generation" },
    { ...child, gardener_origin: { ...origin, passId: "22345678-1234-4123-8123-123456789abc" } },
    { ...child, gardener_origin: { ...origin, token: "secret" } },
    { ...child, step: "verdict", total_cost_usd: 999 }]);
  assert.equal(source.reason, undefined);
  assert.ok(source.compact);
  assert.ok(source.receipts === undefined);
  assert.equal(spend.state, "partial");
  assert.equal(spend.totalUsd, null);
  assert.equal(spend.pricedSubtotalUsd, steps.length * 2);
  assert.deepEqual(spend.counts, { priced: steps.length, unpriced: 1, unlinked: 4 });
  for (const mismatch of [{ repository: "wrong/repo" }, { daemon_run_id: "wrong-generation" },
    { name: "other" }, { passId: "22345678-1234-4123-8123-123456789abc" }]) {
    const rejected = await capture(t, [child, { ...parent, ...mismatch }]);
    assert.equal(rejected.spend.pricedSubtotalUsd, null);
    assert.equal(rejected.spend.counts.unlinked, 1);
  }
  for (const phase of ["running", "failed", "cancelled"]) {
    const partial = await capture(t, [child, { ...parent, phase, exit: undefined }]);
    assert.equal(partial.spend.totalUsd, null);
    assert.equal(partial.spend.pricedSubtotalUsd, 2);
  }
  for (const scope of ["host", "fleet"]) {
    const inventory = runtime();
    inventory.gardens[0]!.scope = scope;
    const excluded = await capture(t, [child, parent], inventory);
    assert.equal(excluded.spend.pricedSubtotalUsd, null);
    assert.deepEqual(excluded.spend.counts, { priced: 0, unpriced: 0, unlinked: 0 });
  }
});

test("W1-T8667: compact and legacy spend sources agree across rotation", async t => {
  const rows = [child, { ...child, step: "recon.done" },
    { ...child, run_id: "unpriced", total_cost_usd: undefined }, parent];
  const { dir } = await capture(t, rows);
  const replay = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  const archive = `ledger.${observedAt.replace(/[:.]/g, "-")}.ndjson`;
  writeFileSync(join(dir, archive), replay);
  writeFileSync(join(dir, archive + ".gz"), gzipSync(replay));
  const receipts: NonNullable<GardenerSpendSource["receipts"]> = rows.map(row => ({
    identity: fingerprintLedgerLine(JSON.stringify(row)), ts: row.ts, step: row.step,
    ...("passId" in row ? { name: row.name, passId: row.passId, repository: row.repository,
      daemonRunId: row.daemon_run_id, phase: row.phase, exit: row.exit }
      : { origin: row.gardener_origin, cost: spendAmountUsd(row) }) }));
  const legacy: GardenerSpendSource = { runtime: runtime(), receipts: [...receipts, ...receipts],
    observedAt, corpusComplete: true };
  for (let restart = 0; restart < 2; restart++) {
    const compact = await captureGardenerSpendSource(dir, fixedClock(Date.parse(observedAt)));
    assert.ok(compact.compact);
    assert.ok(compact.receipts === undefined);
    const spend = foldGardenerSpend(compact, repository, materializedAt);
    const { workerCalls, ...money } = spend;
    const { workerCalls: legacyCalls, ...legacyMoney } = foldGardenerSpend(legacy, repository, materializedAt);
    assert.deepEqual(money, legacyMoney);
    assert.ok(workerCalls && legacyCalls);
    assert.equal(workerCalls?.state, "complete");
    assert.equal(workerCalls.counts.assignments, 0);
    assert.equal(workerCalls.counts.matched, 0);
    assert.equal(legacyCalls?.state, "not_collected");
    assert.equal(legacyCalls.reason, "missing_capture");
    assert.equal(legacyCalls.counts.matched, null);
    assert.deepEqual(spend.counts, { priced: 2, unpriced: 1, unlinked: 0 });
    assert.equal(spend.pricedSubtotalUsd, 4);
    assert.equal(spend.totalUsd, null);
  }
});

test("compact capture refuses exhausted exact replay memory without returning a subtotal", async t => {
  const rows = Array.from({ length: 16383 }, (_, i) => ({ ...child, run_id: `child-${i}` }));
  const { dir, source, spend } = await capture(t, [parent, ...rows, ...rows]);
  assert.equal(source.reason, undefined, "duplicates do not consume a second fingerprint slot");
  assert.equal(spend.totalUsd, 32766);
  assert.deepEqual(spend.counts, { priced: 16383, unpriced: 0, unlinked: 0 });
  writeFileSync(join(dir, "ledger.ndjson"), [parent, ...rows, { ...child, run_id: "one-too-many" }]
    .map(row => JSON.stringify(row)).join("\n") + "\n");
  const refused = await captureGardenerSpendSource(dir, fixedClock(Date.parse(observedAt)));
  assert.deepEqual(refused, { reason: "over_budget" });
  const unknown = foldGardenerSpend(refused, repository, materializedAt);
  assert.equal(unknown.totalUsd, null);
  assert.equal(unknown.pricedSubtotalUsd, null);
  assert.equal(unknown.coverage.truncated, true);
});

test("compact capture retains time and corpus gaps and refuses overflowing arithmetic", async t => {
  const { dir, source } = await capture(t, [parent, child, { ...child, run_id: "future",
    ts: new Date(Date.parse(observedAt) + 1000).toISOString() }]);
  const spend = foldGardenerSpend(source, repository, materializedAt);
  assert.equal(spend.totalUsd, null);
  assert.equal(spend.pricedSubtotalUsd, 2);
  assert.equal(spend.coverage.retainedCorpus, "partial");
  writeFileSync(join(dir, "ledger.ndjson"), [parent, child].map(row => JSON.stringify(row)).join("\n") + "\nnot json\n");
  const malformed = foldGardenerSpend(await captureGardenerSpendSource(dir), repository, materializedAt);
  assert.equal(malformed.pricedSubtotalUsd, 2);
  assert.equal(malformed.totalUsd, null);
  assert.equal(malformed.coverage.retainedCorpus, "partial");
  const overflow = await capture(t, [parent, { ...child, total_cost_usd: Number.MAX_VALUE },
    { ...child, step: "recon.done", total_cost_usd: Number.MAX_VALUE }]);
  assert.deepEqual(overflow.source, { reason: "over_budget" });
});

test("invalid retained compact evidence cannot claim complete priced costs", async t => {
  const { source } = await capture(t, [parent, child]);
  assert.ok(source.compact);
  for (const scope of [{ repository: "other/repo" }, { daemonRunId: "daemon-2" },
    { from: observedAt }, { through: materializedAt }]) {
    const mismatched = foldGardenerSpend({ ...source, compact: { ...source.compact, ...scope } }, repository, materializedAt);
    assert.equal(mismatched.reason, "scope_mismatch");
    assert.equal(mismatched.pricedSubtotalUsd, null);
  }
  for (const compact of [{ ...source.compact, version: 0 }, { ...source.compact, unlinked: -1 },
    { ...source.compact, passes: [...source.compact.passes, ...source.compact.passes] },
    { ...source.compact, passes: [{ ...source.compact.passes[0], parent: false }] },
    { ...source.compact, passes: [{ ...source.compact.passes[0], usd: null }] }]) {
    const invalid = foldGardenerSpend({ ...source, compact } as GardenerSpendSource, repository, materializedAt);
    assert.equal(invalid.reason, "invalid_registry");
    assert.equal(invalid.totalUsd, null);
  }
});

test("compact source serialization can overflow independently of its pass accumulator", async t => {
  const inventory = runtime();
  inventory.gardens = Array.from({ length: 32 }, (_, i) => ({ ...inventory.gardens[0]!,
    name: `garden-${String(i).padStart(2, "0")}-${"x".repeat(48)}` }));
  const receipt = { ...parent, name: inventory.gardens[0]!.name, passId };
  const priced = (row: typeof receipt) => ({ ...child, gardener_origin: { ...origin, name: row.name, passId: row.passId } });
  const control = await capture(t, [receipt, priced(receipt)], inventory);
  assert.equal(control.source.reason, undefined);
  assert.equal(control.spend.gardens.length, 32);
  assert.ok(control.source.compact);
  const width = Buffer.byteLength(JSON.stringify(control.source.compact.passes[0])) + 1;
  const { workerCalls, ...moneySource } = control.source;
  assert.ok(workerCalls && workerCalls !== "over_budget");
  const overhead = Buffer.byteLength(JSON.stringify(moneySource)) - width;
  const population = Math.floor((GARDENER_SPEND_MAX_BYTES - overhead) / width) + 1;
  assert.ok(population * width < GARDENER_SPEND_MAX_BYTES,
    "pass evidence fits; runtime and source metadata cause the serialization overflow");
  const parents = Array.from({ length: population }, (_, i) => ({ ...receipt,
    passId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
  const costs = (rows: typeof parents) => rows.flatMap(row => [row, priced(row)]);
  assert.equal((await capture(t, costs(parents), inventory)).source.reason, "over_budget");
  const fits = await capture(t, costs(parents.slice(0, -1)), inventory);
  assert.equal(fits.source.reason, undefined);
  assert.equal(fits.spend.pricedSubtotalUsd, (population - 1) * 2);
  assert.equal(fits.spend.totalUsd, null, "the other gardens have no complete price evidence");
  assert.ok(fits.source.workerCalls === undefined || fits.source.workerCalls === "over_budget");
  assert.ok(fits.spend.workerCalls);
  assert.equal(fits.spend.workerCalls?.state, "not_collected");
  assert.equal(fits.spend.workerCalls.counts.matched, null);
});

async function retainedCostCorpus(t: { after(fn: () => void): void }) {
  const { dir } = await capture(t, [parent, child]);
  const archive = join(dir, `ledger.${observedAt.replace(/[:.]/g, "-")}.ndjson`);
  writeFileSync(archive, JSON.stringify({ ...child, run_id: "plain-archive", total_cost_usd: 5 }) + "\n");
  writeFileSync(archive + ".gz", gzipSync(JSON.stringify({ ...child, run_id: "gzip-archive", total_cost_usd: 7 }) + "\n"));
  const collect = () => captureGardenerSpendSource(dir, fixedClock(Date.parse(observedAt)));
  const control = await collect();
  const spend = foldGardenerSpend(control, repository, materializedAt);
  assert.equal(control.corpusComplete, true);
  assert.equal(spend.state, "complete");
  assert.equal(spend.totalUsd, 14, "the default reader must observe plain, gzip and live costs");
  assert.deepEqual(spend.counts, { priced: 3, unpriced: 0, unlinked: 0 });
  return { dir, archive, collect };
}

function assertUnlistedCostCorpus(source: GardenerSpendSource) {
  const spend = foldGardenerSpend(source, repository, materializedAt);
  assert.equal(source.corpusComplete, false, "a readable live ledger does not certify an unlisted archive corpus");
  assert.equal(spend.state, "partial");
  assert.equal(spend.reason, "incomplete_evidence");
  assert.equal(spend.pricedSubtotalUsd, 2);
  assert.equal(spend.totalUsd, null);
  assert.equal(spend.gardens[0]!.pricedSubtotalUsd, 2);
  assert.equal(spend.gardens[0]!.totalUsd, null);
  assert.deepEqual(spend.counts, { priced: 1, unpriced: 0, unlinked: 0 });
  assert.deepEqual(spend.coverage, { retainedCorpus: "partial", truncated: false });
}

test("gardener spend keeps known costs partial when the default filesystem cannot list archives", async t => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("POSIX directory read permissions require a non-root user; the enumeration fault test covers this case");
    return;
  }
  const { dir, archive, collect } = await retainedCostCorpus(t);
  const live = readFileSync(join(dir, "ledger.ndjson"));
  const plain = readFileSync(archive), gzip = readFileSync(archive + ".gz");
  try {
    chmodSync(dir, 0o100);
    assert.throws(() => readdirSync(dir), { code: "EACCES" });
    assert.deepEqual(readFileSync(join(dir, "ledger.ndjson")), live,
      "named file reads must remain available while directory enumeration fails");
    assertUnlistedCostCorpus(await collect());
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.deepEqual(readFileSync(archive), plain);
  assert.deepEqual(readFileSync(archive + ".gz"), gzip);
  const restored = await collect();
  assert.equal(restored.corpusComplete, true);
  assert.equal(foldGardenerSpend(restored, repository, materializedAt).totalUsd, 14);
});

test("gardener spend refuses complete totals on an enumeration fault while reading real live files", async t => {
  const { dir, collect } = await retainedCostCorpus(t);
  const originalReaddir = fs.readdirSync;
  let refusals = 0;
  const fault = t.mock.method(fs, "readdirSync", (path: fs.PathLike, ...args: unknown[]) => {
    if (path === dir) {
      refusals++;
      throw Object.assign(new Error("fixture archive enumeration unavailable"), { code: "EACCES" });
    }
    return Reflect.apply(originalReaddir, fs, [path, ...args]);
  });
  syncBuiltinESMExports();
  try {
    assertUnlistedCostCorpus(await collect());
    assert.equal(refusals, 1, "the real union must exercise the directory-listing failure path");
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
  const restored = await collect();
  assert.equal(restored.corpusComplete, true);
  assert.equal(foldGardenerSpend(restored, repository, materializedAt).totalUsd, 14);
});
