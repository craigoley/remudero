import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { fixedClock } from "../src/lib/clock.js";
import { FLAKE_INCIDENT_POLICY } from "../src/lib/flake-incident-gardener.js";
import { applyTestGardenActions, DURATION_WINDOW_RUNS, loadTestManifestProbe, retierFlakerCandidates,
  settleDurationRows, testGardenInventory, testManifestProposalHistoryPath } from "../src/lib/test-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const script = fileURLToPath(new URL("../scripts/test-tier-manifest.mjs", import.meta.url));
const tier = await import(new URL("../scripts/test-tier-manifest.mjs", import.meta.url).href);
const author = await import(new URL("../scripts/preflight-author.mjs", import.meta.url).href);
const screen = await import(new URL("../scripts/flake-screen.mjs", import.meta.url).href);
const probe = await loadTestManifestProbe(fileURLToPath(new URL("..", import.meta.url)));
const old = "test/flaky.test.ts", moved = "test/gardeners/flaky.test.ts";
const manifest = (files: Record<string, number>) => ({ thresholdMs: 5000, files });

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}moved-tier-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  };
  write(moved, "fixture");
  mkdirSync(join(root, "state"));
  return { root, write, state: join(root, "state") };
}

test("W1-T9861: a moved flaker keeps its slow-tier pin", (t) => {
  const committed = manifest({ [old]: 5000, "test/quick.test.ts": 100 });
  assert.deepEqual(tier.tierFiles([moved, "test/new.test.ts"], committed), {
    fast: ["test/new.test.ts"], slow: [moved],
  });
  const f = fixture(t);
  f.write("scripts/test-tier-manifest.json", committed);
  const result = spawnSync(process.execPath, [script, "--root", f.root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 fast, 1 slow/);
  assert.match(result.stderr, /tier: 1 files matched by basename/);
});

test("W1-T9861: a moved test keeps its measured shard weight", (t) => {
  const committed = manifest({ [old]: 9000, "test/quick.test.ts": 100, "test/other.test.ts": 200 });
  assert.equal(tier.weightedDurationMs(moved, committed), 9000);
  assert.equal(tier.unmeasuredSummary([moved], committed).unmeasuredCount, 0);
  assert.deepEqual(tier.balanceFilesByDuration([moved, "test/quick.test.ts", "test/other.test.ts"], committed, 2),
    [[moved], ["test/other.test.ts", "test/quick.test.ts"]]);
  const coverage = tier.instrumentedManifest(committed, manifest({ [moved]: 18000 }));
  assert.equal(tier.weightedDurationMs(moved, coverage), 18000);
  assert.equal(coverage.ratio, 2);
  assert.equal(tier.weightedDurationMs("test/quick.test.ts", coverage), 200);
  assert.equal(author.priceSelection([moved], committed).unmeasured, 0);
  assert.equal(author.priceSelection([moved], committed).rawMs, 9000);
  const f = fixture(t);
  f.write("scripts/test-tier-manifest.json", manifest({ [old]: 9000, "test/quick.test.ts": 100 }));
  f.write("scripts/test-tier-coverage-manifest.json", manifest({ [old]: 18000, "test/quick.test.ts": 200 }));
  assert.equal(screen.screenBudgetMs(f.root), 18000);
});

test("W1-T9861: a ghost row whose basename resolves is named as a re-key", (t) => {
  const f = fixture(t);
  f.write("scripts/test-tier-manifest.json", manifest({ [old]: 5000, "test/deleted.test.ts": 200 }));
  assert.deepEqual(tier.findGhostRows([moved], manifest({ [old]: 5000 })), [old]);
  const result = spawnSync(process.execPath, [script, "--root", f.root, "--check"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`re-key: ${old} -> ${moved}`), result.stderr);
  assert.ok(result.stderr.includes("test/deleted.test.ts"));
  f.write("scripts/test-tier-manifest.json", manifest({ [moved]: 5000 }));
  assert.equal(spawnSync(process.execPath, [script, "--root", f.root, "--check"], { encoding: "utf8" }).status, 0);
});

test("W1-T9861: flake retries recorded under the old path count for the moved file", (t) => {
  const f = fixture(t), now = Date.now();
  const rows = [old, "test/intermediate/flaky.test.ts", moved].map((file, i) => ({
    step: "test.flake_retry", file, ci_run_id: i + 1, retry_outcome: "recovered", ts: new Date(now - 1000).toISOString(),
  }));
  const ledger = (value: unknown[]) => writeFileSync(join(f.state, "ledger.ndjson"), value.map(r => JSON.stringify(r)).join("\n") + "\n");
  ledger(rows.slice(0, 2));
  assert.deepEqual(retierFlakerCandidates(f.state, probe, manifest({ [old]: 100 }), [moved], false, now), []);
  ledger([...rows, { ...rows[0], file: moved }]);
  const actions = retierFlakerCandidates(f.state, probe, manifest({ [old]: 100 }), [moved], false, now);
  assert.deepEqual(actions.map(a => a.edit), [{ kind: "row", key: moved, to: 5000 }]);
  assert.match(actions[0]!.reason, /3 distinct CI run/);
  assert.deepEqual(retierFlakerCandidates(f.state, probe, manifest({ [old]: 5000 }), [moved], false, now), []);
  f.write("scripts/test-tier-manifest.json", manifest({ [old]: 100 }));
  applyTestGardenActions(f.root, probe, actions);
  assert.deepEqual(probe.loadManifest(join(f.root, "scripts/test-tier-manifest.json")).files, { [moved]: 5000 });
});

test("W1-T9861: shared lookup prefers exact keys and refuses ambiguous basenames", () => {
  const committed = manifest({ [old]: 5000, [moved]: 0 });
  assert.equal(tier.manifestEntryFor(committed, moved), 0);
  assert.equal(tier.manifestEntryFor(committed, "test/elsewhere/flaky.test.ts"), undefined);
  assert.equal(tier.manifestEntryFor(committed, "test/absent.test.ts"), undefined);
  assert.equal(tier.weightedDurationMs(moved, committed), 5000);
});

test("W1-T9861: native deadline admission prices the moved file at its recorded cost", () => {
  const profile = { files: { "test/calibration.test.ts": 100 }, at: "fixture" };
  const options = { workers: 1, deadline: 1000000, now: 0, staticReserveMs: 0 };
  const rest = { "test/calibration.test.ts": 100, "test/quick.test.ts": 200 };
  const actual = author.runtimeSelectionFit([moved], manifest({ [old]: 9000, ...rest }), profile, options);
  const exact = author.runtimeSelectionFit([moved], manifest({ [moved]: 9000, ...rest }), profile, options);
  assert.equal(actual.unmeasuredLedgerFiles, 0);
  assert.deepEqual(actual, exact);
  assert.ok(actual.predictedMs >= 9000);
});

test("W1-T9861: basename indexing enumerates each loaded manifest only once", () => {
  let walks = 0;
  const files = new Proxy({ [old]: 5000 }, { ownKeys(target) {
    walks += 1;
    return Reflect.ownKeys(target);
  } });
  const committed = manifest(files);
  assert.equal(tier.manifestEntryFor(committed, old), 5000);
  assert.equal(walks, 0, "an exact match needs no index");
  for (let i = 0; i < 10; i += 1) assert.equal(tier.manifestEntryFor(committed, moved), 5000);
  assert.equal(walks, 1);
  const lines: string[] = [];
  tier.reportManifestFallbacks([moved, moved, "test/unknown.test.ts"], committed, (line: string) => lines.push(line));
  assert.deepEqual(lines, ["tier: 1 files matched by basename"]);
});

test("W1-T9861: duration merge re-keys a moved row without losing a real measurement", () => {
  const committed = manifest({ [old]: 5000, "test/other.test.ts": 200 });
  assert.deepEqual(tier.mergeDurations(committed, { [moved]: 7000 }).files, { [moved]: 7000, "test/other.test.ts": 200 });
  assert.deepEqual(tier.mergeDurations(committed, { [moved]: 0 }).files, { [moved]: 5000, "test/other.test.ts": 200 });
  assert.equal(committed.files[old], 5000);
  const ambiguous = manifest({ [old]: 1, [moved]: 2 });
  assert.equal(Object.keys(tier.mergeDurations(ambiguous, { "test/third/flaky.test.ts": 3 }).files).length, 3);
});

test("W1-T9861: coverage EWMA carries the moved row and raw history forward", () => {
  const committed = { ...manifest({ [old]: 1000 }), history: { [old]: [900, 1000, 1100] } };
  const folded = tier.foldDurationsEwma(committed, { [moved]: 1200 }, { knownFiles: [moved] });
  assert.deepEqual(folded.files, { [moved]: 1100 });
  assert.deepEqual(folded.history, { [moved]: [900, 1000, 1100, 1200] });
  assert.deepEqual(tier.durationStalenessWarnings(manifest({ [old]: 100 }), { [moved]: 1000 }),
    [`stale duration for ${moved}: recorded 100ms, observed 1000ms (10.00x; threshold 2x)`]);
});

test("W1-T9861: gardener duration observations and quiet pins survive a move", (t) => {
  const known = new Set([moved]);
  const history = Array.from({ length: DURATION_WINDOW_RUNS }, (_, i) => ({ [i % 2 ? moved : old]: 200 }));
  assert.deepEqual(settleDurationRows(manifest({ [old]: 100 }), history, known).rows,
    [{ file: moved, from: 100, to: 200, kind: "drift" }]);
  assert.deepEqual(settleDurationRows(manifest({ [old]: 5000 }), history, known).rows, []);
  const f = fixture(t), now = Date.now();
  f.write("scripts/test-tier-manifest.json", manifest({ [old]: 5000 }));
  f.write("scripts/test-tier-coverage-manifest.json", manifest({}));
  writeFileSync(testManifestProposalHistoryPath(f.state), JSON.stringify({ runs: history.map((files, runId) => ({ files, runId })), absent: [] }));
  const retries = (file: string, at: number) => ({ step: "test.flake_retry", file, ci_run_id: 1,
    retry_outcome: "recovered", ts: new Date(at).toISOString() });
  const inventory = () => testGardenInventory(f.root, f.state, probe, {
    clock: fixedClock(now), manifestChangedAtMs: () => now - 2 * 24 * 3600000,
  }).candidates;
  writeFileSync(join(f.state, "ledger.ndjson"), JSON.stringify(retries(old, now - FLAKE_INCIDENT_POLICY.windowMs - 1000)) + "\n");
  assert.deepEqual(inventory().map(a => a.edit), [{ kind: "row", key: moved, to: 200 }]);
  writeFileSync(join(f.state, "ledger.ndjson"), [retries(old, now - FLAKE_INCIDENT_POLICY.windowMs - 1000), retries(moved, now - 1000)].map(r => JSON.stringify(r)).join("\n") + "\n");
  assert.deepEqual(inventory(), []);
});
