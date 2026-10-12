import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import {
  applyTestGardenActions, DURATION_ADOPTION_CADENCE_MS, DURATION_WINDOW_RUNS,
  loadTestManifestProbe, refreshTestManifestProposalAsync,
  testGardenCheapFingerprint, testGardenInventory, testGardenSpec,
} from "../src/lib/test-gardener.js";
import { ghShim } from "./helpers/gh-shim.js";

const FAST = "scripts/test-tier-manifest.json";
const COVERAGE = "scripts/test-tier-coverage-manifest.json";
const FAST_PREFIX = "test-tier-manifest-proposal";
const COVERAGE_PREFIX = "test-tier-coverage-manifest-proposal";
const probePromise = loadTestManifestProbe(fileURLToPath(new URL("..", import.meta.url)));
const files = { "test/a.test.ts": 100, "test/b.test.ts": 0 };
const manifest = (rows = files) => JSON.stringify({ thresholdMs: 5000, files: rows }) + "\n";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-coverage-gardener-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "test", "state"]) mkdirSync(join(root, dir));
  for (const file of Object.keys(files)) writeFileSync(join(root, file), "export {};\n");
  for (const path of [FAST, COVERAGE]) writeFileSync(join(root, path), manifest());
  const stateDir = join(root, "state");
  const downloads: string[][] = [];
  const io = (coverage: boolean, ids = [10], fastRows = files) => ({
    readJson: async () => ids.map((id) => ({ id, status: "completed", conclusion: "success" })),
    download: async (args: string[]) => {
      downloads.push(args);
      const artifact = args[args.indexOf("--name") + 1]!;
      const isCoverage = artifact === COVERAGE_PREFIX;
      assert.ok(isCoverage || artifact === FAST_PREFIX);
      if (isCoverage && !coverage) throw new Error("no artifact matches any of the names or patterns provided");
      const dir = args[args.indexOf("--dir") + 1]!;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, isCoverage ? "test-tier-coverage-manifest.next.json" : "test-tier-manifest.next.json"),
        manifest(isCoverage ? { ...files, "test/b.test.ts": 6200 } : fastRows));
      return "";
    },
  });
  const read = (prefix: string, suffix: string) => JSON.parse(readFileSync(join(stateDir, `${prefix}${suffix}.json`), "utf8"));
  return { root, stateDir, downloads, io, read };
}

test("W1-T6174: the refresh fetches the coverage proposal beside the fast-lane one", async (t) => {
  const f = fixture(t);
  const ids = Array.from({ length: DURATION_WINDOW_RUNS + 2 }, (_, i) => 20 - i);
  const feed = await refreshTestManifestProposalAsync("acme", "remudero", f.stateDir, f.io(true, ids));
  assert.ok("coverage" in feed);
  assert.deepEqual(feed.coverage, { status: "fresh", runId: 20 });
  assert.equal(feed.status, "fresh");
  for (const prefix of [FAST_PREFIX, COVERAGE_PREFIX]) {
    assert.deepEqual(f.read(prefix, ".source"), { runId: 20 });
    assert.deepEqual(f.read(prefix, ".history").runs.map((r: { runId: number }) => r.runId), [14, 15, 16, 17, 18, 19, 20]);
    assert.deepEqual(f.read(prefix, ".history").absent, []);
    assert.equal(existsSync(join(f.stateDir, `${prefix}.download`)), false);
  }
  assert.equal(f.read(FAST_PREFIX, "").files["test/b.test.ts"], 0);
  assert.equal(f.read(COVERAGE_PREFIX, "").files["test/b.test.ts"], 6200);
  assert.equal(f.downloads.length, 2 * DURATION_WINDOW_RUNS);
  const again = await refreshTestManifestProposalAsync("acme", "remudero", f.stateDir, f.io(true, ids));
  assert.ok("coverage" in again);
  assert.deepEqual(again.coverage, { status: "unchanged", runId: 20 });
  assert.equal(f.downloads.length, 2 * DURATION_WINDOW_RUNS);
  assert.equal(JSON.parse(JSON.stringify(feed)).coverage.status, "fresh", "the daemon's feed log includes coverage");
});

test("W1-T6174: a coverage proposal is adopted into the coverage ledger only", async (t) => {
  const f = fixture(t);
  const probe = await probePromise;
  await refreshTestManifestProposalAsync("acme", "remudero", f.stateDir, f.io(true));
  const before = readFileSync(join(f.root, FAST), "utf8");
  const actions = testGardenInventory(f.root, f.stateDir, probe, { manifestChangedAtMs: () => undefined }).candidates;
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.class, "adopt-durations");
  assert.equal(actions[0]!.file, COVERAGE);
  assert.equal(actions[0]!.target, `${COVERAGE}#test/b.test.ts`);
  assert.deepEqual(applyTestGardenActions(f.root, probe, actions), [COVERAGE]);
  assert.equal(probe.loadManifest(join(f.root, COVERAGE)).files["test/b.test.ts"], 6200);
  assert.equal(readFileSync(join(f.root, FAST), "utf8"), before);
  const workspace = { root: f.root, land: () => undefined, dispose: () => {} };
  const spec = testGardenSpec({ repoRoot: f.root, stateDir: f.stateDir, log: () => {}, openWorkspace: () => workspace }, probe);
  const applied = spec.apply(workspace, { actions, acting: ["adopt-durations"] }, {});
  assert.ok(applied);
  assert.match(applied.body, /tends scripts\/test-tier-coverage-manifest\.json/);
});

test("W1-T6174: a run with no coverage proposal is recorded absent", async (t) => {
  const f = fixture(t);
  const probe = await probePromise;
  const io = f.io(false, [10, 9], { ...files, "test/b.test.ts": 6000 });
  const feed = await refreshTestManifestProposalAsync("acme", "remudero", f.stateDir, io);
  assert.ok("coverage" in feed);
  assert.deepEqual(feed.coverage, { status: "absent", runId: 10, reason: "run 10 published no proposal" });
  assert.deepEqual(f.read(COVERAGE_PREFIX, ".source"), { runId: 10, artifact: "absent" });
  assert.deepEqual(f.read(COVERAGE_PREFIX, ".history"), { runs: [], absent: [10, 9] });
  const again = await refreshTestManifestProposalAsync("acme", "remudero", f.stateDir, io);
  assert.ok("coverage" in again);
  assert.deepEqual(again.coverage, feed.coverage);
  assert.equal(f.downloads.length, 4, "neither ledger retries an observed run");
  const before = readFileSync(join(f.root, COVERAGE), "utf8");
  const actions = testGardenInventory(f.root, f.stateDir, probe, { manifestChangedAtMs: () => undefined }).candidates;
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.file, FAST);
  assert.deepEqual(applyTestGardenActions(f.root, probe, actions), [FAST]);
  assert.equal(probe.loadManifest(join(f.root, FAST)).files["test/b.test.ts"], 6000);
  assert.equal(readFileSync(join(f.root, COVERAGE), "utf8"), before);
});

test("coverage adoption uses its own cadence and grouped writes return both ledgers", async (t) => {
  const f = fixture(t);
  const probe = await probePromise;
  await refreshTestManifestProposalAsync("acme", "remudero", f.stateDir, f.io(true, [10], { ...files, "test/b.test.ts": 6000 }));
  const now = 2 * DURATION_ADOPTION_CADENCE_MS;
  const paths: string[] = [];
  const held = testGardenInventory(f.root, f.stateDir, probe, {
    clock: fixedClock(now),
    manifestChangedAtMs: (path: string) => (paths.push(path), path === COVERAGE ? now : 0),
  }).candidates;
  assert.deepEqual(paths, [FAST, COVERAGE]);
  assert.deepEqual(held.map((a) => a.file), [FAST]);
  const actions = testGardenInventory(f.root, f.stateDir, probe, { manifestChangedAtMs: () => undefined }).candidates;
  assert.deepEqual(applyTestGardenActions(f.root, probe, actions), [FAST, COVERAGE]);
  assert.equal(probe.loadManifest(join(f.root, FAST)).files["test/b.test.ts"], 6000);
  assert.equal(probe.loadManifest(join(f.root, COVERAGE)).files["test/b.test.ts"], 6200);
});

test("the cheap fingerprint sees coverage proposals and manifest changes", async (t) => {
  const f = fixture(t);
  const probe = await probePromise;
  const fingerprint = () => testGardenCheapFingerprint(f.root, f.stateDir, probe, fixedClock(0));
  const before = fingerprint();
  writeFileSync(join(f.stateDir, `${COVERAGE_PREFIX}.json`), manifest());
  assert.notEqual(fingerprint(), before);
  const proposed = fingerprint();
  utimesSync(join(f.root, COVERAGE), 100, 100);
  assert.notEqual(fingerprint(), proposed);
});

test("coverage download failures propagate without being recorded as absent", async (t) => {
  const f = fixture(t);
  const io = f.io(true);
  const error = Object.assign(new Error("coverage download failed"), { stderr: "HTTP 502" });
  await assert.rejects(refreshTestManifestProposalAsync("acme", "remudero", f.stateDir, {
    ...io,
    download: async (args) => {
      if (args[args.indexOf("--name") + 1] === COVERAGE_PREFIX) throw error;
      return io.download(args);
    },
  }), (caught) => caught === error);
  assert.equal(existsSync(join(f.stateDir, `${COVERAGE_PREFIX}.source.json`)), false);
  assert.equal(existsSync(join(f.stateDir, `${COVERAGE_PREFIX}.history.json`)), false);
  const feed = await refreshTestManifestProposalAsync("acme", "remudero", f.stateDir, io);
  assert.deepEqual(feed.coverage, { status: "fresh", runId: 10 });
  assert.equal(feed.status, "unchanged", "the successful fast-lane fetch was retained");
});

test("malformed coverage proposals are rejected and successful runs are required for both feeds", async (t) => {
  const f = fixture(t);
  const io = f.io(true);
  await assert.rejects(refreshTestManifestProposalAsync("acme", "remudero", f.stateDir, {
    ...io,
    download: async (args) => {
      await io.download(args);
      if (args[args.indexOf("--name") + 1] === COVERAGE_PREFIX) {
        const dir = args[args.indexOf("--dir") + 1]!;
        writeFileSync(join(dir, "test-tier-coverage-manifest.next.json"), '{"thresholdMs":5000,"files":{"test/a.test.ts":"invalid"}}');
      }
      return "";
    },
  }), /not a \{thresholdMs, files\} manifest/);
  assert.equal(existsSync(join(f.stateDir, `${COVERAGE_PREFIX}.source.json`)), false);
  const count = f.downloads.length;
  const feed = await refreshTestManifestProposalAsync("acme", "remudero", f.stateDir, f.io(true, []));
  assert.deepEqual(feed, { status: "absent", reason: "no successful main run among the newest ten",
    coverage: { status: "absent", reason: "no successful main run among the newest ten" } });
  assert.equal(f.downloads.length, count);
  await assert.rejects(refreshTestManifestProposalAsync("acme", "remudero", f.stateDir, {
    ...io, readJson: async () => ({}),
  }), /no main-run list/);
});

test("a settled non-material coverage decrease shrinks only that ledger", async (t) => {
  const f = fixture(t);
  const probe = await probePromise;
  writeFileSync(join(f.root, COVERAGE), manifest({ "test/a.test.ts": 1000, "test/b.test.ts": 200 }));
  writeFileSync(join(f.stateDir, `${COVERAGE_PREFIX}.history.json`), JSON.stringify({
    runs: Array.from({ length: DURATION_WINDOW_RUNS }, (_, i) => ({ runId: i + 1,
      files: { "test/a.test.ts": 1000, "test/b.test.ts": 100 } })), absent: [],
  }));
  const before = readFileSync(join(f.root, FAST), "utf8");
  const actions = testGardenInventory(f.root, f.stateDir, probe, { manifestChangedAtMs: () => undefined }).candidates;
  assert.deepEqual(actions.map((a) => [a.class, a.file, a.edit.key, a.edit.to]),
    [["shrink-baseline", COVERAGE, "test/b.test.ts", 100]]);
  assert.deepEqual(applyTestGardenActions(f.root, probe, actions), [COVERAGE]);
  assert.equal(readFileSync(join(f.root, FAST), "utf8"), before);
});

test("the default transport shells out for both artifacts and remembers missing proposals", async (t) => {
  const f = fixture(t);
  const shim = ghShim([
    { when: "actions/workflows/ci.yml/runs", stdout: '[{"id":10,"status":"completed","conclusion":"success"}]' },
    { when: "run download", stderr: "no valid artifacts found", exit: 1 },
  ]);
  const previousPath = process.env.PATH;
  const previousFloor = process.env.RMD_GH_TRANSPORT_FLOOR;
  const previousCache = process.env.RMD_GH_CACHE_HOME;
  t.after(() => {
    for (const [key, value] of [["PATH", previousPath], ["RMD_GH_TRANSPORT_FLOOR", previousFloor], ["RMD_GH_CACHE_HOME", previousCache]]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
    rmSync(shim.dir, { recursive: true, force: true });
  });
  process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_CACHE_HOME = f.root;
  const feed = await refreshTestManifestProposalAsync("acme", "remudero", f.stateDir);
  assert.equal(feed.status, "absent");
  assert.equal(feed.coverage.status, "absent");
  assert.ok(shim.calls().some((call) => call.includes(`--name ${FAST_PREFIX} --dir`)));
  assert.ok(shim.calls().some((call) => call.includes(`--name ${COVERAGE_PREFIX} --dir`)));
  const again = await refreshTestManifestProposalAsync("acme", "remudero", f.stateDir);
  assert.deepEqual(again, feed);
  assert.equal(shim.calls().filter((call) => call.startsWith("run download")).length, 2);
});
