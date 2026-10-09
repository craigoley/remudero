import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock } from "../src/lib/clock.js";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";
import { withTempDir } from "../src/lib/tmp.js";
import { buildCoverageNightlyDaemonHook } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import {
  readCoverageNightlySummary,
  coverageNightlyGithubReader,
  type CoverageNightlyReader,
} from "../src/lib/coverage-nightly-intake.js";

const day = 24 * 60 * 60 * 1000;
const at = Date.now() - 7 * day;
const run = { id: 1234, head_sha: "abc123", head_branch: "main", status: "completed", conclusion: "failure" };
const summary = {
  kind: "coverage_nightly.measured", task: "W1-T5704", sha: run.head_sha,
  ref: "refs/heads/main", run_id: String(run.id), measured_at: "2026-10-09T11:00:00Z",
  lines_pct: 93, branches_pct: 88, lf: 100, lh: 93, brf: 100, brh: 88,
  skipped_records: 0, tier: "improve", shard_test_exits: { "1": 1, "2": 0 },
};
const reader: CoverageNightlyReader = {
  newestCompletedRun: async () => run,
  summaryForRun: async () => summary,
};
const rows = (path: string): Record<string, unknown>[] => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

test("test/the-coverage-nightly-summary-reaches-the-ledger.test.ts: totals, run identity, deduplication and read failure", async () => {
  await withTempDir("nightly-intake-test", async (stateDir) => {
    const ledgerPath = join(stateDir, LEDGER_FILENAME);
    const logs: string[] = [];
    const opts = { ledgerPath, owner: "owner", repo: "repo", reader, log: (line: string) => logs.push(line) };
    assert.equal((await readCoverageNightlySummary({ ...opts, clock: fixedClock(at) })).status, "appended");
    const [row] = rows(ledgerPath);
    assert.equal(row.run_id, summary.run_id);
    assert.equal(row.head_sha, run.head_sha);
    assert.equal(row.conclusion, "failure");
    assert.equal(row.kind, summary.kind);
    for (const field of ["lines_pct", "branches_pct", "lf", "lh", "brf", "brh", "skipped_records", "tier", "shard_test_exits", "measured_at"]) {
      assert.deepEqual(row[field], summary[field as keyof typeof summary], field);
    }
    assert.equal((await readCoverageNightlySummary({ ...opts, clock: fixedClock(at + day) })).status, "duplicate");
    assert.equal(rows(ledgerPath).length, 1);
    const broken: CoverageNightlyReader = { ...reader, newestCompletedRun: async () => { throw new Error("github unavailable"); } };
    const failed = await readCoverageNightlySummary({ ...opts, reader: broken, clock: fixedClock(at + 2 * day) });
    assert.equal(failed.status, "failed");
    assert.equal(rows(ledgerPath).length, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /github unavailable/);
    assert.equal((await readCoverageNightlySummary({ ...opts, reader: broken, clock: fixedClock(at + 2 * day + 1) })).status, "not-due");
    assert.equal(logs.length, 1);
    assert.equal((await readCoverageNightlySummary({ ...opts, clock: fixedClock(at + 3 * day) })).status, "duplicate");
  });
});

test("the daily marker survives restart and the next cadence ingests a newer run", async () => {
  await withTempDir("nightly-intake-test", async (stateDir) => {
    const opts = { ledgerPath: join(stateDir, LEDGER_FILENAME), owner: "owner", repo: "repo", reader };
    await readCoverageNightlySummary({ ...opts, clock: fixedClock(at) });
    const next: CoverageNightlyReader = {
      newestCompletedRun: async () => ({ ...run, id: 1235, conclusion: "success" }),
      summaryForRun: async () => ({ ...summary, run_id: "1235" }),
    };
    assert.equal((await readCoverageNightlySummary({ ...opts, reader: next, clock: fixedClock(at + day - 1) })).status, "not-due");
    assert.equal((await readCoverageNightlySummary({ ...opts, reader: next, clock: fixedClock(at + day) })).status, "appended");
    assert.deepEqual(rows(opts.ledgerPath).map((row) => row.run_id), ["1234", "1235"]);
  });
});

for (const form of ["plain", "gzip"] as const) {
  test(`run-id deduplication reads ${form} rotations`, async () => {
    await withTempDir("nightly-intake-test", async (stateDir) => {
      const opts = { ledgerPath: join(stateDir, LEDGER_FILENAME), owner: "owner", repo: "repo", reader };
      await readCoverageNightlySummary({ ...opts, clock: fixedClock(at) });
      const archive = join(stateDir, `ledger.2026-10-09T12-00-00Z.ndjson${form === "gzip" ? ".gz" : ""}`);
      if (form === "plain") renameSync(opts.ledgerPath, archive);
      else {
        writeFileSync(archive, gzipSync(readFileSync(opts.ledgerPath)));
        writeFileSync(opts.ledgerPath, "");
      }
      assert.equal((await readCoverageNightlySummary({ ...opts, clock: fixedClock(at + day) })).status, "duplicate");
      assert.deepEqual(rows(opts.ledgerPath), []);
    });
  });
}

for (const invalid of [
  { ...summary, run_id: "other" }, { ...summary, sha: "other" },
  { ...summary, ref: "refs/heads/other" }, { ...summary, lf: -1 },
  { ...summary, lines_pct: "93" }, { ...summary, measured_at: "invalid" },
  { ...summary, lh: summary.lf + 1 }, { ...summary, tier: "unknown" },
  { ...summary, shard_test_exits: { "1": -1 } },
]) {
  test(`an invalid summary is logged without a measurement: ${JSON.stringify(invalid)}`, async () => {
    await withTempDir("nightly-intake-test", async (stateDir) => {
      const logs: string[] = [];
      const ledgerPath = join(stateDir, LEDGER_FILENAME);
      const result = await readCoverageNightlySummary({
        ledgerPath, owner: "owner", repo: "repo", clock: fixedClock(at),
        reader: { ...reader, summaryForRun: async () => invalid }, log: (line) => logs.push(line),
      });
      assert.equal(result.status, "failed");
      assert.deepEqual(rows(ledgerPath), []);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /summary/);
    });
  });
}

test("the GitHub reader asks for the newest completed main nightly, including a failed conclusion", async () => {
  await withTempDir("nightly-intake-test", async (stateDir) => {
    const calls: string[][] = [];
    let downloadDir = "";
    const github = coverageNightlyGithubReader({
      ghJsonAsync: async (args) => {
        calls.push(args);
        return { workflow_runs: [run] };
      },
      ghTextAsync: async (args) => {
        calls.push(args);
        downloadDir = args[args.indexOf("--dir") + 1];
        writeFileSync(join(downloadDir, "coverage-nightly-summary.json"), JSON.stringify(summary));
        return "";
      },
    });
    assert.deepEqual(await github.newestCompletedRun("owner", "repo"), run);
    assert.match(calls[0][1], /coverage-nightly\.yml\/runs\?branch=main&status=completed&per_page=1$/);
    assert.deepEqual(await github.summaryForRun("owner", "repo", run), summary);
    assert.deepEqual(calls[1].slice(0, 7), ["run", "download", "1234", "--repo", "owner/repo", "--name", "coverage-nightly"]);
    assert.equal(existsSync(downloadDir), false);
  });
});

test("a failed artifact download logs once, cleans up, and retries next cadence", async () => {
  await withTempDir("nightly-intake-test", async (stateDir) => {
    let downloads = 0;
    let downloadDir = "";
    const logs: string[] = [];
    const github = coverageNightlyGithubReader({
      ghJsonAsync: async () => ({ workflow_runs: [run] }),
      ghTextAsync: async (args) => {
        downloads++;
        downloadDir = args[args.indexOf("--dir") + 1];
        if (downloads === 1) throw new Error("artifact expired");
        writeFileSync(join(downloadDir, "coverage-nightly-summary.json"), JSON.stringify(summary));
        return "";
      },
    });
    const opts = { ledgerPath: join(stateDir, LEDGER_FILENAME), owner: "owner", repo: "repo", reader: github, log: (line: string) => logs.push(line) };
    assert.equal((await readCoverageNightlySummary({ ...opts, clock: fixedClock(at) })).status, "failed");
    assert.equal(existsSync(downloadDir), false);
    assert.deepEqual(rows(opts.ledgerPath), []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /artifact expired/);
    assert.equal((await readCoverageNightlySummary({ ...opts, clock: fixedClock(at + day) })).status, "appended");
    assert.equal(downloads, 2);
  });
});

test("the daemon GitHub cadence invokes the intake before its sibling check can fail", async () => {
  await withTempDir("nightly-intake-test", async (root) => {
    let reads = 0;
    const hook = buildCoverageNightlyDaemonHook({
      ledgerPath: join(root, "state", LEDGER_FILENAME), owner: "owner", repo: "repo", clock: fixedClock(at),
      reader: {
        ...reader, newestCompletedRun: async () => { reads++; return run; },
      },
      next: () => { throw new Error("sibling check stopped"); },
    });
    await assert.rejects(hook(), /sibling check stopped/);
    assert.equal(reads, 1);
    const [row] = rows(join(root, "state", LEDGER_FILENAME));
    assert.equal(row.run_id, "1234");
    assert.equal(row.head_sha, run.head_sha);
    assert.equal(row.kind, summary.kind);
    await assert.rejects(hook(), /sibling check stopped/);
    assert.equal(reads, 1);
  });
});

test("both default GitHub transports really spawn and propagate their child failure", { concurrency: false }, async () => {
  await withTempDir("nightly-intake-test", async (root) => {
    const shim = ghShim([
      { when: "api repos/owner/repo/actions/workflows/", stderr: "nightly list unavailable", exit: 1 },
      { when: "run download 1234", stderr: "nightly artifact unavailable", exit: 1 },
    ]);
    const previousPath = process.env.PATH;
    const previousCache = process.env.RMD_GH_CACHE_HOME;
    process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
    process.env.RMD_GH_CACHE_HOME = join(root, "cache");
    try {
      for (const useDefaultDownload of [false, true]) {
        const stateDir = join(root, String(useDefaultDownload));
        mkdirSync(stateDir);
        const logs: string[] = [];
        const result = await readCoverageNightlySummary({
          ledgerPath: join(stateDir, LEDGER_FILENAME), owner: "owner", repo: "repo", clock: fixedClock(at),
          reader: useDefaultDownload ? coverageNightlyGithubReader({ ghJsonAsync: async () => ({ workflow_runs: [run] }) }) : undefined,
          log: (line) => logs.push(line),
        });
        assert.equal(result.status, "failed");
        assert.equal(logs.length, 1);
        assert.match(logs[0], useDefaultDownload ? /nightly artifact unavailable/ : /nightly list unavailable/);
        assert.deepEqual(rows(join(stateDir, LEDGER_FILENAME)), []);
      }
      assert.equal(shim.calls().length, 2);
      assert.match(shim.calls()[0], /^api repos\/owner\/repo\/actions\/workflows\/coverage-nightly\.yml\/runs\?/);
      assert.match(shim.calls()[1], /^run download 1234 --repo owner\/repo --name coverage-nightly --dir /);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousCache === undefined) delete process.env.RMD_GH_CACHE_HOME; else process.env.RMD_GH_CACHE_HOME = previousCache;
    }
  });
});

test("an unreadable archive refuses deduplication and logs its reason", async () => {
  await withTempDir("nightly-intake-test", async (stateDir) => {
    writeFileSync(join(stateDir, "ledger.2026-10-09T12-00-00Z.ndjson.gz"), "not gzip");
    const logs: string[] = [];
    const ledgerPath = join(stateDir, LEDGER_FILENAME);
    const result = await readCoverageNightlySummary({
      ledgerPath, owner: "owner", repo: "repo", reader, clock: fixedClock(at), log: (line) => logs.push(line),
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(rows(ledgerPath), []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /dedup ledger union is incomplete/);
  });
});

test("a null workflow response fails with its own reason, logs once and appends no measurement", async () => {
  await withTempDir("nightly-intake-test", async (stateDir) => {
    const ledgerPath = join(stateDir, LEDGER_FILENAME);
    const logs: string[] = [];
    const github = coverageNightlyGithubReader({ ghJsonAsync: async () => null });
    const result = await readCoverageNightlySummary({
      ledgerPath, owner: "owner", repo: "repo", reader: github, clock: fixedClock(at),
      log: (line) => logs.push(line),
    });
    assert.deepEqual(result, { status: "failed", reason: "coverage-nightly workflow run response is null" });
    assert.deepEqual(logs, ["coverage-nightly intake failed: coverage-nightly workflow run response is null"]);
    assert.deepEqual(rows(ledgerPath), []);
  });
});

test("an empty workflow list is no-run, while malformed and non-main runs fail visibly", async () => {
  await withTempDir("nightly-intake-test", async (stateDir) => {
    const ledgerPath = join(stateDir, LEDGER_FILENAME);
    const logs: string[] = [];
    const opts = { ledgerPath, owner: "owner", repo: "repo", log: (line: string) => logs.push(line) };
    const empty = coverageNightlyGithubReader({ ghJsonAsync: async () => ({ workflow_runs: [] }) });
    assert.equal((await readCoverageNightlySummary({ ...opts, reader: empty, clock: fixedClock(at) })).status, "no-run");
    assert.equal(logs.length, 0);
    const malformed = coverageNightlyGithubReader({ ghJsonAsync: async () => ({ message: "unreadable" }) });
    assert.equal((await readCoverageNightlySummary({ ...opts, reader: malformed, clock: fixedClock(at + day) })).status, "failed");
    const other = coverageNightlyGithubReader({ ghJsonAsync: async () => ({ workflow_runs: [{ ...run, head_branch: "other" }] }) });
    assert.equal((await readCoverageNightlySummary({ ...opts, reader: other, clock: fixedClock(at + 2 * day) })).status, "failed");
    assert.deepEqual(rows(ledgerPath), []);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /run list is unreadable/);
    assert.match(logs[1], /not a completed main run/);
  });
});

test("the default clock and logger preserve a non-Error read failure", async (t) => {
  await withTempDir("nightly-intake-test", async (stateDir) => {
    const logs: string[] = [];
    t.mock.method(console, "error", (line: string) => logs.push(line));
    const ledgerPath = join(stateDir, LEDGER_FILENAME);
    const result = await readCoverageNightlySummary({
      ledgerPath, owner: "owner", repo: "repo",
      reader: { ...reader, newestCompletedRun: async () => { throw "reader failed"; } },
    });
    assert.deepEqual(result, { status: "failed", reason: "reader failed" });
    assert.deepEqual(logs, ["coverage-nightly intake failed: reader failed"]);
    assert.deepEqual(rows(ledgerPath), []);
  });
});
