/**
 * The test gardener adopted run-to-run duration noise: on 2026-09-29 five adopt-durations PRs
 * (#7856, #7864, #7876, #7878, #7884) merged in three hours, each rewriting about 2,100 rows of
 * scripts/test-tier-manifest.json. A row now moves only when a rolling window of CI runs settles
 * it outside the measured noise band, a tier move needs the whole window past the threshold, and a
 * recent manifest commit holds the next adoption for about a day.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import {
  DURATION_ADOPTION_CADENCE_MS,
  DURATION_WINDOW_RUNS,
  loadTestManifestProbe,
  manifestLastCommitMs,
  readTestProposalHistory,
  refreshTestManifestProposalAsync,
  roundDurationMs,
  settleDurationRows,
  testGardenInventory,
  testManifestProposalHistoryPath,
  testManifestProposalPath,
} from "../src/lib/test-gardener.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const probePromise = loadTestManifestProbe(REPO_ROOT);
const MANIFEST = "scripts/test-tier-manifest.json";
const DAY = DURATION_ADOPTION_CADENCE_MS;

/** A suite of `count` measured files with a committed manifest; returns its root. */
function suiteWith(files: Record<string, number>): string {
  const repo = gitRepo({ kind: "duration-noise" });
  const root = repo.dir;
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  for (const f of Object.keys(files)) writeFileSync(join(root, f), "export {};\n");
  writeFileSync(join(root, MANIFEST), JSON.stringify({ thresholdMs: 5000, files }, null, 2) + "\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "seed");
  return root;
}

function writeWindow(root: string, runs: Array<Record<string, number>>): void {
  writeFileSync(testManifestProposalHistoryPath(join(root, "state")), JSON.stringify({ runs: runs.map((files, i) => ({ runId: i + 1, files })), absent: [] }));
}

/** Deterministic multiplicative jitter of up to about 30% either side, like the measured runs. */
const jitter = (i: number, run: number) => 1 + 0.3 * Math.sin(i * 7.1 + run * 3.3);

const committedSuite = (): Record<string, number> =>
  Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`test/n${String(i).padStart(2, "0")}.test.ts`, 200 + 150 * i]));

test("a window of runs that only jitters around the committed rows adopts nothing", async () => {
  const probe = await probePromise;
  const committed = committedSuite();
  const root = suiteWith(committed);
  const runs = Array.from({ length: DURATION_WINDOW_RUNS }, (_, run) =>
    Object.fromEntries(Object.entries(committed).map(([f, ms], i) => [f, Math.round(ms * jitter(i, run))])));
  writeWindow(root, runs);
  // The old rule adopted the newest run whole whenever it moved a shard, which this one does.
  const newest = { thresholdMs: 5000, files: runs.at(-1)! };
  assert.equal(probe.proposalIsMaterial({ thresholdMs: 5000, files: committed }, newest, 8), true, "one run's noise alone is material");
  const inv = testGardenInventory(root, join(root, "state"), probe, { clock: fixedClock(Date.now() + 2 * DAY) });
  assert.deepEqual(inv.candidates, [], "noise inside every row's envelope adopts nothing");
});

test("a row every run in the window measures well away from its committed value is adopted at the rounded median", async () => {
  const probe = await probePromise;
  const committed = committedSuite();
  const root = suiteWith(committed);
  const moved = "test/n03.test.ts";
  const runs = Array.from({ length: DURATION_WINDOW_RUNS }, (_, run) =>
    Object.fromEntries(Object.entries(committed).map(([f, ms], i) => [f, Math.round((f === moved ? 3 * ms : ms) * jitter(i, run))])));
  writeWindow(root, runs);
  const inv = testGardenInventory(root, join(root, "state"), probe, { clock: fixedClock(Date.now() + 2 * DAY) });
  assert.deepEqual(inv.candidates.map((a) => a.target), [`${MANIFEST}#${moved}`]);
  assert.equal(inv.candidates[0]!.class, "adopt-durations");
  assert.equal(inv.candidates[0]!.edit.to % 10, 0, "stored at two significant figures");
  assert.match(inv.candidates[0]!.reason, /drift: was 650ms, the median of 7 CI run\(s\)/);
});

test("a recent manifest commit holds a settled drift for a day", async () => {
  const probe = await probePromise;
  const committed = committedSuite();
  const root = suiteWith(committed);
  const moved = "test/n03.test.ts";
  writeWindow(root, Array.from({ length: DURATION_WINDOW_RUNS }, (_, run) =>
    Object.fromEntries(Object.entries(committed).map(([f, ms], i) => [f, Math.round((f === moved ? 3 * ms : ms) * jitter(i, run))]))));
  const at = (ms: number) => testGardenInventory(root, join(root, "state"), probe, { clock: fixedClock(ms), manifestChangedAtMs: () => 1_000_000 });
  assert.deepEqual(at(1_000_000 + DAY / 2).candidates, [], "held inside the cadence window");
  assert.equal(at(1_000_000 + DAY + 1).candidates.length, 1, "released once the day has passed");
});

test("an urgent fast-lane move is not held by the daily cadence", async () => {
  const probe = await probePromise;
  const committed = committedSuite();
  const root = suiteWith(committed);
  const heavy = "test/n23.test.ts";
  // The heaviest fast file really takes 30s on every run: it belongs in the slow tier, and the
  // fast lane's slowest shard shrinks by far more than the noise band once it moves.
  writeWindow(root, Array.from({ length: DURATION_WINDOW_RUNS }, (_, run) =>
    Object.fromEntries(Object.entries(committed).map(([f, ms], i) => [f, f === heavy ? 30_000 + run * 100 : Math.round(ms * jitter(i, run))]))));
  const inv = testGardenInventory(root, join(root, "state"), probe, { clock: fixedClock(1_000_000 + 60_000), manifestChangedAtMs: () => 1_000_000 });
  assert.deepEqual(inv.candidates.map((a) => a.target), [`${MANIFEST}#${heavy}`]);
  assert.match(inv.candidates[0]!.reason, /\(tier: was 3650ms/);
});

test("a file near the slow threshold does not flip tier until the whole window is past it", async () => {
  const known = new Set(["test/edge.test.ts", "test/pin.test.ts"]);
  const committed = { thresholdMs: 5000, files: { "test/edge.test.ts": 4000, "test/pin.test.ts": 5000 } };
  const straddling = [4900, 5600, 5700, 5800, 5900, 5600, 5700].map((ms) => ({ "test/edge.test.ts": ms, "test/pin.test.ts": 300 }));
  assert.deepEqual(settleDurationRows(committed, straddling, known).rows, [], "one run below the threshold holds the tier; the pinned flaker stays");
  const past = [5100, 5600, 5700, 5800, 5900, 5600, 5700].map((ms) => ({ "test/edge.test.ts": ms, "test/pin.test.ts": 300 }));
  assert.deepEqual(settleDurationRows(committed, past, known).rows, [{ file: "test/edge.test.ts", from: 4000, to: 5700, kind: "tier" }]);
  assert.deepEqual(settleDurationRows(committed, past.slice(0, 3), known).rows, [], "a window not yet full judges no drift");
  assert.deepEqual(settleDurationRows({ thresholdMs: 5000, files: {} }, past.slice(0, 1), known).rows.map((r) => r.kind), ["first", "first"]);
});

test("a stored duration keeps two significant figures", () => {
  assert.deepEqual([0, -3, 7, 42, 655, 1234, 98_765].map(roundDurationMs), [0, 0, 7, 42, 660, 1200, 99_000]);
});

test("the refresh backfills the rolling window from every successful main run and never downloads a run twice", async () => {
  const repo = gitRepo({ kind: "duration-window" });
  const stateDir = join(repo.dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const ids = [30, 29, 28, 27, 26, 25, 24, 23, 22, 21];
  const downloads: number[] = [];
  const io = {
    readJson: async () => [{ id: 31, status: "in_progress", conclusion: null }, ...ids.map((id) => ({ id, status: "completed", conclusion: "success" }))],
    download: async (args: string[]) => {
      const id = Number(args[2]);
      downloads.push(id);
      if (id === 28) throw Object.assign(new Error("Command failed"), { stderr: "no artifact matches any of the names or patterns provided" });
      const dir = args[args.indexOf("--dir") + 1]!;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "test-tier-manifest.next.json"), JSON.stringify({ thresholdMs: 5000, files: { "test/x.test.ts": id } }));
      return "";
    },
  };
  assert.deepEqual(await refreshTestManifestProposalAsync("acme", "remudero", stateDir, io), { status: "fresh", runId: 30 });
  const history = readTestProposalHistory(stateDir);
  assert.deepEqual(history.runs.map((r) => r.runId), [23, 24, 25, 26, 27, 29, 30], "the newest seven runs that published a proposal");
  assert.deepEqual(history.absent, [28]);
  assert.deepEqual(downloads, [30, 29, 28, 27, 26, 25, 24, 23], "stops once the window is full and older runs fall outside it");
  assert.deepEqual(await refreshTestManifestProposalAsync("acme", "remudero", stateDir, io), { status: "unchanged", runId: 30 });
  assert.equal(downloads.length, 8, "a held window downloads nothing more");
  assert.equal(JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(testManifestProposalPath(stateDir), "utf8"))).files["test/x.test.ts"], 30);
});

test("the cadence reads when the manifest last changed from git", () => {
  const repo = gitRepo({ kind: "duration-cadence" });
  assert.equal(manifestLastCommitMs(repo.dir, MANIFEST), undefined, "a manifest never committed has no age");
  mkdirSync(join(repo.dir, "scripts"), { recursive: true });
  writeFileSync(join(repo.dir, MANIFEST), "{}\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "seed");
  const at = manifestLastCommitMs(repo.dir, MANIFEST)!;
  assert.ok(Math.abs(at - Date.now()) < 120_000, `the commit time is now, got ${at}`);
});
