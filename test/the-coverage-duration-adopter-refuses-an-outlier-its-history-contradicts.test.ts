// W1-T7810 — scripts/test-tier-coverage-manifest.json weighed test/retro-marker-atomic.test.ts at
// 851,971 ms against 20,298 ms in the regular manifest (42x; the fleet median ratio is 1.57x), and
// the CI EWMA fold moved a row halfway toward ANY single run. The fold now judges each observation
// against the file's own raw history, carries that history in the proposal, and the gardener
// settles the committed value on the RAW window, not on folded proposals.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadTestManifestProbe, rawObservationWindow, testGardenInventory } from "../src/lib/test-gardener.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type Outlier = { observedMs: number; medianMs: number; bandLog: number; boundLog: number };
type Ledger = { thresholdMs: number; files: Record<string, number>; history?: Record<string, number[]>; outliers?: Record<string, Outlier> };
const tier = (await import(pathToFileURL(join(ROOT, "scripts", "test-tier-manifest.mjs")).href)) as {
  foldDurationsEwma: (m: Ledger, measured: Record<string, number>, opts?: { alpha?: number; knownFiles?: string[]; history?: Record<string, number[]> }) => Required<Ledger>;
  writeManifest: (path: string, m: Ledger) => void;
  loadInstrumentedLedger: (committed: string, snapshot?: string) => { manifest: Ledger };
  DURATION_HISTORY_RUNS: number;
};

const TARGET = "test/target.test.ts";
const PATTERN = [-1, -0.5, 0, 0.5, 1, -0.25, 0.25];

/** Nine files with seven raw observations each, `amplitude` apart: the measured fleet noise. */
function fleet(amplitude: number): Record<string, number[]> {
  const history: Record<string, number[]> = {};
  for (let f = 0; f < 9; f += 1) history[`test/fleet-${f}.test.ts`] = PATTERN.map((p) => Math.round(10_000 * (1 + amplitude * p)));
  return history;
}

const ledger = (rows: Record<string, number>, history?: Record<string, number[]>): Ledger => ({ thresholdMs: 5000, files: rows, ...(history ? { history } : {}) });

test("W1-T7810: one run far outside a file history is listed as an outlier and not folded", () => {
  const history = { ...fleet(0.02), [TARGET]: [20_000, 20_400, 19_800, 20_200, 20_100, 19_900, 20_300] };
  const committed = ledger({ [TARGET]: 20_000 }, history);

  const refused = tier.foldDurationsEwma(committed, { [TARGET]: 851_971 });
  assert.equal(refused.files[TARGET], 20_000, "the committed row is not moved halfway toward one 852 s run");
  const outlier = refused.outliers[TARGET]!;
  assert.equal(outlier.observedMs, 851_971);
  assert.equal(outlier.medianMs, 20_100, "the median of the file's own raw history");
  assert.ok(outlier.bandLog > 0 && outlier.boundLog >= outlier.bandLog, "the band it was judged against is listed");
  assert.equal(refused.history[TARGET]!.at(-1), 851_971, "a refused observation stays in the raw history");
  assert.equal(refused.history[TARGET]!.length, tier.DURATION_HISTORY_RUNS);

  const admitted = tier.foldDurationsEwma(committed, { [TARGET]: 20_600 });
  assert.deepEqual(admitted.outliers, {});
  assert.equal(admitted.files[TARGET], 20_300, "an observation inside the history is folded halfway as before");
});

test("W1-T7810: a sustained shift is adopted once it becomes the history median", () => {
  let state: Ledger = ledger({ [TARGET]: 20_000 }, { ...fleet(0.02), [TARGET]: [20_000, 20_100, 19_900, 20_000, 20_200, 19_800, 20_000] });
  for (let run = 1; run <= 4; run += 1) {
    const next = tier.foldDurationsEwma(state, { [TARGET]: 852_000 });
    assert.equal(next.files[TARGET], 20_000, `run ${run}: the shift is not the median yet, so it is not folded`);
    assert.equal(next.outliers[TARGET]?.observedMs, 852_000, `run ${run}: it is listed as an outlier`);
    state = next;
  }
  assert.deepEqual(state.history![TARGET]!.slice(-4), [852_000, 852_000, 852_000, 852_000]);
  const adopted = tier.foldDurationsEwma(state, { [TARGET]: 852_000 });
  assert.deepEqual(adopted.outliers, {}, "the fifth run agrees with the history median");
  assert.equal(adopted.files[TARGET], 436_000, "and is folded");
});

test("W1-T7810: a committed row the raw history contradicts moves to the median in one adoption", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-adopter-outlier-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "test", "state"]) mkdirSync(join(root, dir));
  const names = ["test/a.test.ts", "test/b.test.ts"];
  for (const name of names) writeFileSync(join(root, name), "export {};\n");
  const fast = "scripts/test-tier-manifest.json";
  const coverage = "scripts/test-tier-coverage-manifest.json";
  const write = (path: string, files: Record<string, number>) => writeFileSync(join(root, path), JSON.stringify({ thresholdMs: 5000, files }) + "\n");
  write(fast, { "test/a.test.ts": 100, "test/b.test.ts": 100 });
  write(coverage, { "test/a.test.ts": 852_000, "test/b.test.ts": 9_000 });

  // Seven CI runs, each EWMA-folded onto the committed row: the folded values halve from 852 s.
  const rawA = [20_000, 21_000, 19_500, 20_500, 20_200, 19_800, 20_300];
  const rawB = [9_000, 9_100, 8_900, 9_050, 9_000, 8_950, 9_020];
  let folded = 852_000;
  const runs = rawA.map((ms, i) => {
    folded = Math.round(folded + 0.5 * (ms - folded));
    return { runId: 100 + i, files: { "test/a.test.ts": folded, "test/b.test.ts": rawB[i]! }, raw: { "test/a.test.ts": rawA.slice(0, i + 1), "test/b.test.ts": rawB.slice(0, i + 1) } };
  });
  const foldedMedian = runs.map((r) => r.files["test/a.test.ts"]).sort((x, y) => x - y)[3]!;
  assert.ok(foldedMedian > 20_000 * 3, `the folded window's median (${foldedMedian}) still sits far from the raw median`);
  writeFileSync(join(root, "state", "test-tier-coverage-manifest-proposal.history.json"), JSON.stringify({ runs, absent: [] }) + "\n");

  const probe = await loadTestManifestProbe(ROOT);
  const actions = testGardenInventory(root, join(root, "state"), probe, { manifestChangedAtMs: () => undefined }).candidates
    .filter((a) => a.file === coverage);
  const move = actions.find((a) => a.target === `${coverage}#test/a.test.ts`);
  assert.ok(move, "the contradicted row is adopted");
  assert.equal((move.edit as { to: number }).to, 20_000, "straight to the raw median, not the halved folded value");
  assert.equal(actions.some((a) => a.target.endsWith("#test/b.test.ts")), false, "a row its history agrees with is left alone");

  assert.deepEqual(rawObservationWindow(runs.map(({ raw: _raw, ...r }) => r)).map((r) => r["test/a.test.ts"]), runs.map((r) => r.files["test/a.test.ts"]),
    "a feed carrying no raw history keeps the folded window");
  assert.equal(rawObservationWindow(runs).length, runs.length);
});

test("W1-T7810: the outlier bound follows the measured noise band", () => {
  const verdict = (amplitude: number, observed: number) => {
    const base = ledger({ [TARGET]: 20_000 }, { ...fleet(amplitude), [TARGET]: [20_000, 20_000] });
    return tier.foldDurationsEwma(base, { [TARGET]: observed });
  };
  const tight = verdict(0.02, 30_000);
  const loose = verdict(0.4, 30_000);
  assert.ok(tight.outliers[TARGET], "a 1.5x run is an outlier when the fleet is quiet");
  assert.equal(tight.files[TARGET], 20_000);
  assert.equal(loose.outliers[TARGET], undefined, "the same 1.5x run is ordinary when the fleet is noisy");
  assert.equal(loose.files[TARGET], 25_000);
  const [lo, hi] = [tight.outliers[TARGET]!.boundLog, Math.log(1.5)];
  assert.ok(lo < hi, "the quiet bound sits below the run's log ratio");
  // The same run is refused at any ratio once the band is tight: the bound is not a fixed multiple.
  assert.ok(verdict(0.02, 60_000).outliers[TARGET]);
  assert.ok(verdict(0.4, 600_000).outliers[TARGET], "and a loose fleet still refuses a far enough run");
});

test("W1-T7810: the raw history rides the proposal artifact and is read back by the next fold", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-adopter-roundtrip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folded = tier.foldDurationsEwma(ledger({ [TARGET]: 20_000 }, { [TARGET]: [20_000] }), { [TARGET]: 21_000 });
  const snapshot = join(dir, "snapshot.json");
  tier.writeManifest(snapshot, folded);
  const reloaded = tier.loadInstrumentedLedger(join(dir, "absent.json"), snapshot).manifest;
  assert.deepEqual(reloaded.history, { [TARGET]: [20_000, 21_000] });
});
