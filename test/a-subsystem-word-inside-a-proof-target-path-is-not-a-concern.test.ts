// 2026-10-10: Rule 19 sizing matched its subsystem lexicon (`\bdaemon\b`) against acceptance text that names the
// proof's target FILE, and `-` is a word boundary, so `test/a-daemon-that-cannot-hold-its-heap-says-so.test.ts` read
// as a mention of the daemon. 105 of 3,151 test files carry `daemon` in their name; a flake incident for any of them
// names that file in its claim and its grep proof, scored two concerns at risk: low, and was refused. A path that is a
// declared file or a proof's target is now blanked before the lexicon reads the text; prose still counts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { runFlakeIncidentGardener } from "../src/lib/flake-incident-gardener.js";
import { parseTasksFromYaml, type Task } from "../src/lib/plan.js";
import { lintTask, sizingViolation, subsystemsOf } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const TEST_FILE = "test/a-daemon-that-cannot-hold-its-heap-says-so.test.ts";
const NOW = Date.parse("2026-10-10T20:00:00Z");
const ID = "W1-T9893";

function record(fields: Partial<Task>): Task {
  return { id: "W1-T9894", title: "a sized record", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0, ...fields };
}

test("a flake filing for a test file whose path names the daemon passes sizing", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}path-concern-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state", "plan/tasks.d", "test"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, TEST_FILE), "");
  const rows = [10701, 10705, 10709].map((pr) => ({
    ts: new Date(NOW).toISOString(), step: "test.flake_retry", file: TEST_FILE, headline: "recovered on retry", ci_run_id: pr * 10,
    shard: 2, source: "selector-shadow", retry_outcome: "recovered", head_sha: `head-${pr}`, base_sha: `base-${pr}`,
    pr_numbers: [pr], titles: ["the heap report names its own limit"],
  }));
  writeFileSync(join(root, "state", "ledger.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const log: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const landed: Array<{ paths: string[] }> = [];
  await runFlakeIncidentGardener(
    {
      stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(NOW), log: (step, extra) => log.push({ step, extra }),
      openWorkspace: () => ({ root, branch: "selector-shadow-garden-4", land: (o: { paths: string[] }) => (landed.push(o), "https://github.com/acme/remudero/pull/4"), dispose: () => {} }),
    },
    { mintTaskId: () => ID, readChangedPaths: () => ["src/lib/unrelated.ts"], planTasks: () => [], readSource: () => "" },
  );

  assert.deepEqual(log.filter((r) => r.step === "flake_incident.filing_failed"), [], "the filing is not refused");
  assert.equal(landed.length, 1, "the gardener files the incident");
  const rel = landed[0]!.paths[0]!;
  const filed = parseTasksFromYaml(readFileSync(join(root, rel), "utf8"), rel)[0]!;
  assert.ok((filed.acceptance ?? []).some((c) => c.claim.includes(TEST_FILE)), "the claim still names the file");
  assert.equal(filed.risk, "low");
  assert.deepEqual([...subsystemsOf(filed)], ["a-daemon-that-cannot-hold-its-heap-says-so"], "one concern: the flaky test file");
  assert.equal(sizingViolation(filed), undefined);
  assert.deepEqual(lintTask(filed).violations.filter((v) => v.check === "sizing"), []);

  // Filtering a declared path must not hide a subsystem that the claim names in prose. Keep this
  // guard inside the discriminating filing test: at the merge base the filing itself is refused,
  // while this regression assertion still proves that genuine daemon prose counts at the head.
  const prose = record({
    files: [TEST_FILE],
    acceptance: [{ claim: `the daemon reports the flaky behavior in ${TEST_FILE}`, proof: `grep: flaky behavior in ${TEST_FILE}` }],
  });
  assert.deepEqual([...subsystemsOf(prose)].sort(), ["a-daemon-that-cannot-hold-its-heap-says-so", "daemon"]);
  assert.equal(sizingViolation(prose)?.severity, "block", "real subsystem prose remains a sizing concern");
});

test("a prose claim naming two subsystems still fails sizing, path or no path", () => {
  const prose = record({
    files: ["src/lib/heap-report.ts"],
    acceptance: [{ claim: "the daemon restarts its launchd job when the heap report trips", proof: "grep: tripsHeap in src/lib/heap-report.ts" }],
  });
  assert.deepEqual([...subsystemsOf(prose)].sort(), ["daemon", "heap-report", "launchd"]);
  assert.equal(sizingViolation(prose)?.severity, "block");

  // The daemon-named file is blanked, but the prose word beside it still counts as a second concern.
  const both = record({
    files: [TEST_FILE],
    acceptance: [{ claim: `the daemon reports its heap limit, pinned in ${TEST_FILE}`, proof: `grep: heap limit in ${TEST_FILE}` }],
  });
  assert.deepEqual([...subsystemsOf(both)].sort(), ["a-daemon-that-cannot-hold-its-heap-says-so", "daemon"]);
  assert.equal(sizingViolation(both)?.severity, "block");
});

test("a unit-test target and an escaped declared path are blanked, and a path the task does not target still counts", () => {
  const escaped = record({
    files: ["src/lib/heap-report.ts"],
    acceptance: [{ claim: "the suite is selected", proof: "unit test: test/a-daemon-that-cannot-hold-its-heap-says-so.test.ts" }],
  });
  assert.deepEqual([...subsystemsOf(escaped)], ["heap-report"], "a unit-test proof's target file is not a concern word");

  const regex = record({
    files: [TEST_FILE, "src/lib/heap-report.ts"],
    acceptance: [{ claim: "the heap report selects its suite", proof: "grep: test/a-daemon-that-cannot-hold-its-heap-says-so\\.test\\.ts in src/lib/heap-report.ts" }],
  });
  assert.ok(!subsystemsOf(regex).has("daemon"), "a declared file written as a grep pattern is the same file");

  const elsewhere = record({
    files: ["src/lib/heap-report.ts"],
    acceptance: [{ claim: "the report is read by src/lib/daemon.ts", proof: "grep: readHeapReport in src/lib/heap-report.ts" }],
  });
  assert.ok(subsystemsOf(elsewhere).has("daemon"), "a file outside files: and the proof targets is still read");
});
