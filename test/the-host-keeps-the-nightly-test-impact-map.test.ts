import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  COVERAGE_NIGHTLY_IMPACT_MAP_STEP,
  IMPACT_MAP_RUN_RECORD_FILE,
  coverageNightlyGithubReader,
  readCoverageNightlySummary,
  refreshTestImpactMap,
  type CoverageNightlyReader,
  type CoverageNightlyRun,
} from "#src/lib/coverage-nightly-intake.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import {
  decideMeasurementCadence, readMeasurementCadenceMarker, recordMeasurementCadenceFire,
} from "#src/lib/measurement-cadence.js";
import { PINNING_IMPACT_MAP_FILE } from "#src/lib/pinning-tests.js";
import { IMPACT_MAP_FORMAT } from "#src/lib/test-impact-map.js";
import { withTempDir } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const day = 24 * 60 * 60 * 1000;
const at = Date.now() - 7 * day;
const run: CoverageNightlyRun = { id: 77, head_sha: "c0ffee77", head_branch: "main", status: "completed", conclusion: "failure" };
const summary = {
  kind: "coverage_nightly.measured", sha: run.head_sha, ref: "refs/heads/main", run_id: String(run.id),
  measured_at: "2026-10-09T11:00:00Z", lines_pct: 93, branches_pct: 88, lf: 100, lh: 93, brf: 100, brh: 88,
  skipped_records: 0, tier: "improve", shard_test_exits: { "1": 0 },
};
const cadence = {
  check: (path: string, now: Date) => decideMeasurementCadence({
    policy: { enabled: true, minIntervalMinutes: 1440, maxPerDay: 1, escalate: false },
    marker: readMeasurementCadenceMarker(path), now,
  }),
  record: recordMeasurementCadenceFire,
};
/** Map text with its own spacing, so a byte-for-byte check sees any rewrite. */
const mapText = (sha: string): string =>
  `${JSON.stringify({ format: IMPACT_MAP_FORMAT, sha, suites: ["test/a.test.ts"], orphanReports: 0, files: { "src/a.ts": { loadedBy: [0], functions: [] } } }, null, 1)}\n`;
const rows = (path: string): Record<string, unknown>[] => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
const impactRows = (path: string): Record<string, unknown>[] => rows(path).filter((row) => row.step === COVERAGE_NIGHTLY_IMPACT_MAP_STEP);

async function waitForImpactRows(ledgerPath: string, count: number): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 1000; i++) {
    const found = impactRows(ledgerPath);
    if (found.length >= count) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no ${count} ${COVERAGE_NIGHTLY_IMPACT_MAP_STEP} rows in ${ledgerPath}`);
}

function checkout(t: TestContext): { root: string; mapPath: string; recordPath: string } {
  const root = gitRepo({ scope: t }).dir;
  const mapPath = join(root, ".git", PINNING_IMPACT_MAP_FILE);
  return { root, mapPath, recordPath: join(root, ".git", "rmd", IMPACT_MAP_RUN_RECORD_FILE) };
}

function fakeReader(download: (dir: string, run: CoverageNightlyRun) => Promise<"downloaded" | "no-artifact">): CoverageNightlyReader & { downloads: number } {
  const reader = {
    downloads: 0,
    newestCompletedRun: async () => run,
    summaryForRun: async () => summary,
    async impactMapForRun(_owner: string, _repo: string, selected: CoverageNightlyRun, dir: string) {
      reader.downloads++;
      return download(dir, selected);
    },
  };
  return reader;
}

const writeMap = (text: string) => async (dir: string): Promise<"downloaded"> => {
  writeFileSync(join(dir, "test-impact-map.json"), text);
  return "downloaded";
};

test("W1-T14530 criterion 1: one daily fire leaves the run's map under the git common dir, and a second fire for the same run downloads nothing", async (t) => {
  await withTempDir("impact-map-test", async (stateDir) => {
    const { root, mapPath, recordPath } = checkout(t);
    const ledgerPath = join(stateDir, LEDGER_FILENAME);
    const text = mapText(run.head_sha);
    const reader = fakeReader(writeMap(text));
    const opts = { ledgerPath, cadence, owner: "owner", repo: "repo", reader, checkoutRoot: root };
    assert.equal((await readCoverageNightlySummary({ ...opts, clock: fixedClock(at) })).status, "appended");
    const [first] = await waitForImpactRows(ledgerPath, 1);
    assert.equal(readFileSync(mapPath, "utf8"), text);
    assert.equal((JSON.parse(readFileSync(recordPath, "utf8")) as { run_id: string }).run_id, "77");
    assert.equal(first.outcome, "refreshed");
    assert.equal(first.run_id, "77");
    assert.equal(first.map_sha, run.head_sha);
    assert.equal(first.bytes, Buffer.byteLength(text));
    assert.equal((await readCoverageNightlySummary({ ...opts, clock: fixedClock(at + day) })).status, "duplicate");
    const [, second] = await waitForImpactRows(ledgerPath, 2);
    assert.equal(second.outcome, "unchanged");
    assert.equal(second.run_id, "77");
    assert.equal(reader.downloads, 1);
    assert.equal(readFileSync(mapPath, "utf8"), text);
  });
});

test("W1-T14530 criterion 2: a failed, missing, unreadable or wrong-sha download leaves the old map byte for byte", async (t) => {
  await withTempDir("impact-map-test", async (stateDir) => {
    const { root, mapPath, recordPath } = checkout(t);
    const ledgerPath = join(stateDir, LEDGER_FILENAME);
    const old = mapText("01d5ha");
    mkdirSync(join(root, ".git", "rmd"), { recursive: true });
    writeFileSync(mapPath, old);
    writeFileSync(recordPath, `${JSON.stringify({ run_id: "70", sha: "01d5ha", refreshed_at: "2026-10-01T00:00:00Z" })}\n`);
    const cases: { id: number; download: (dir: string) => Promise<"downloaded" | "no-artifact">; outcome: string; reason: RegExp }[] = [
      { id: 71, download: async () => { throw new Error("artifact transfer reset"); }, outcome: "failed", reason: /artifact transfer reset/ },
      { id: 72, download: async () => "no-artifact", outcome: "no-artifact", reason: /no test-impact-map artifact/ },
      { id: 73, download: writeMap("{ not json"), outcome: "invalid", reason: /is not JSON/ },
      { id: 74, download: writeMap(mapText("0ther5ha")), outcome: "invalid", reason: /is not the run's head sha/ },
    ];
    for (const c of cases) {
      const selected = { ...run, id: c.id };
      const result = await refreshTestImpactMap({
        ledgerPath, owner: "owner", repo: "repo", run: selected, checkoutRoot: root, clock: fixedClock(at),
        reader: { impactMapForRun: async (_o, _r, _run, dir) => c.download(dir) },
      });
      assert.equal(result.outcome, c.outcome, String(c.id));
      assert.equal(readFileSync(mapPath, "utf8"), old, `run ${c.id} changed the map`);
      assert.deepEqual(readdirSync(join(root, ".git", "rmd")).sort(), ["test-impact-map.json", IMPACT_MAP_RUN_RECORD_FILE]);
      const row = impactRows(ledgerPath).at(-1);
      assert.equal(row?.outcome, c.outcome);
      assert.equal(row?.run_id, String(c.id));
      assert.match(String(row?.reason), c.reason);
      const recorded = (JSON.parse(readFileSync(recordPath, "utf8")) as { run_id: string }).run_id;
      assert.equal(recorded, c.outcome === "failed" ? "70" : String(c.id), `run record after ${c.outcome}`);
    }
    assert.equal(impactRows(ledgerPath).length, cases.length);
    let downloads = 0;
    const retried = await refreshTestImpactMap({
      ledgerPath, owner: "owner", repo: "repo", run: { ...run, id: 71, head_sha: "0a1b2c" }, checkoutRoot: root, clock: fixedClock(at + day),
      reader: { impactMapForRun: async (_o, _r, _run, dir) => { downloads++; return writeMap(mapText("0a1b2c"))(dir); } },
    });
    assert.equal(retried.outcome, "refreshed");
    assert.equal(downloads, 1);
    assert.equal(readFileSync(mapPath, "utf8"), mapText("0a1b2c"));
  });
});

test("W1-T14530 criterion 3: readCoverageNightlySummary settles before the download, and a second fire starts no second download", async (t) => {
  await withTempDir("impact-map-test", async (stateDir) => {
    const { root, mapPath } = checkout(t);
    const ledgerPath = join(stateDir, LEDGER_FILENAME);
    const order: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const timerFired = new Promise<void>((resolve) => setTimeout(() => { order.push("timer"); resolve(); }, 20));
    const text = mapText(run.head_sha);
    const reader = fakeReader(async (dir) => {
      await timerFired;
      await Promise.race([released, new Promise((resolve) => setTimeout(resolve, 2000))]);
      writeFileSync(join(dir, "test-impact-map.json"), text);
      order.push("download settled");
      return "downloaded";
    });
    const opts = { ledgerPath, cadence, owner: "owner", repo: "repo", reader, checkoutRoot: root };
    const first = await readCoverageNightlySummary({ ...opts, clock: fixedClock(at) });
    order.push("settled");
    assert.equal(first.status, "appended");
    assert.equal(existsSync(mapPath), false);
    assert.equal(impactRows(ledgerPath).length, 0);
    assert.equal((await readCoverageNightlySummary({ ...opts, clock: fixedClock(at + day) })).status, "duplicate");
    release();
    const [row] = await waitForImpactRows(ledgerPath, 1);
    assert.equal(row.outcome, "refreshed");
    assert.equal(readFileSync(mapPath, "utf8"), text);
    assert.ok(order.indexOf("settled") < order.indexOf("download settled"), order.join(", "));
    assert.ok(order.indexOf("timer") < order.indexOf("download settled"), order.join(", "));
    assert.equal(reader.downloads, 1);
    assert.equal(impactRows(ledgerPath).length, 1);
  });
});

test("W1-T14530 criterion 4: a reader without impactMapForRun refreshes nothing, and the GitHub reader downloads the test-impact-map artifact", async (t) => {
  await withTempDir("impact-map-test", async (stateDir) => {
    const { root, mapPath } = checkout(t);
    const ledgerPath = join(stateDir, LEDGER_FILENAME);
    const plain: CoverageNightlyReader = { newestCompletedRun: async () => run, summaryForRun: async () => summary };
    const opts = { ledgerPath, cadence, owner: "owner", repo: "repo", reader: plain, checkoutRoot: root };
    assert.equal((await readCoverageNightlySummary({ ...opts, clock: fixedClock(at) })).status, "appended");
    assert.equal((await readCoverageNightlySummary({ ...opts, clock: fixedClock(at + day) })).status, "duplicate");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(impactRows(ledgerPath).length, 0);
    assert.equal(rows(ledgerPath).length, 1);
    assert.equal(existsSync(mapPath), false);

    const calls: string[][] = [];
    let answer: "ok" | "missing" | "broken" = "ok";
    const github = coverageNightlyGithubReader({
      ghTextAsync: async (args) => {
        calls.push(args);
        if (answer === "missing") throw Object.assign(new Error("gh exited 1"), { stderr: "no artifact matches any of the names or patterns provided" });
        if (answer === "broken") throw new Error("connection reset");
        return "";
      },
    });
    assert.equal(await github.impactMapForRun?.("owner", "repo", run, "/download/dir"), "downloaded");
    assert.deepEqual(calls[0], ["run", "download", "77", "--repo", "owner/repo", "--name", "test-impact-map", "--dir", "/download/dir"]);
    answer = "missing";
    assert.equal(await github.impactMapForRun?.("owner", "repo", run, "/download/dir"), "no-artifact");
    answer = "broken";
    await assert.rejects(async () => github.impactMapForRun?.("owner", "repo", run, "/download/dir"), /connection reset/);
    assert.equal(calls.length, 3);
  });
});
