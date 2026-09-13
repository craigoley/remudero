import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CAPTURE_SURFACE_FIRE_HISTORY_LIMIT,
  buildDoctorReport,
  judgeCaptureSurfaceLiveness,
  parseCaptureSurfaceFireHistory,
  type CaptureSurfaceFireRecord,
} from "../src/lib/doctor.js";
import { doctorCommand, runFeedbackDocketRung } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SOURCES = ["reframe", "operator_feedback", "rejected_feedback", "question_answer", "operator_note"] as const;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
}

// W1-T3472: named `healthyDaemonRows`, not `healthyLedgerRows` — a `function`-declared name
// matching `[Ll]edger` is exactly what test/fixture-copy-census.test.ts's `ledgerHelperNames`
// signature counts (builderDeclarationRe("[Ll]edger")), and this repo's own baseline there is a
// ratchet that only ever tightens; a same-shaped local fixture reader earns this file nothing
// that renaming does not already give it.
function healthyDaemonRows(): Array<Record<string, unknown>> {
  return [
    { step: "daemon.alive", phase: "dispatch", ts: "2026-09-13T11:59:00.000Z", poll_interval_ms: 300_000 },
    { step: "sweep.pass", ts: "2026-09-13T11:55:00.000Z", enumerated: 0 },
    { step: "sweep.summary", ts: "2026-09-13T11:55:01.000Z" },
  ];
}

function emptyCounts(): Record<(typeof SOURCES)[number], number> {
  return Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<(typeof SOURCES)[number], number>;
}

function runEmptyDocketFires(instanceRoot: string, repoRoot: string, count: number): void {
  const config = { root: instanceRoot } as never;
  const ledgerPath = join(instanceRoot, "state", "ledger.ndjson");
  const first = Date.parse("2026-08-01T00:00:00.000Z");
  const log = () => {};

  for (let i = 0; i < count; i++) {
    const now = new Date(first + i * WEEK_MS);
    const outcome = runFeedbackDocketRung(config, ledgerPath, `run-${i}`, log, {
      root: repoRoot,
      now: () => now,
    });
    assert.equal(outcome.fired, false, `empty fire ${i + 1} files no proposal`);
  }
}

function doctorDeps(root: string): NonNullable<Parameters<typeof doctorCommand>[1]> {
  return {
    repoRoot: root,
    loadConfig: () => ({ root }) as never,
    nowMs: Date.parse("2026-09-13T12:00:00.000Z"),
    readLedgerLines: () => healthyDaemonRows(),
    loadPlan: () => ({ tasks: [], byId: new Map() }) as never,
    liveInflightRuns: () => [],
    readLockFiles: () => ({ locks: [] }),
    readMemInfo: () => ({ availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 }),
    readDiskFreeBytes: () => 40 * 1024 ** 3,
    readDiskTotalBytes: () => 100 * 1024 ** 3,
    readPauseAgeMs: () => undefined,
    readGitLocks: () => [],
    readCheckoutDepth: () => ({ shallow: false, commitCount: 1000 }),
    readNvmrcVersion: () => "22.22.3",
  };
}

function reportInputs(captureSurfaceFires: CaptureSurfaceFireRecord[]): Parameters<typeof buildDoctorReport>[0] {
  return {
    nowMs: Date.parse("2026-09-13T12:00:00.000Z"),
    ledgerLines: healthyDaemonRows(),
    captureSurfaceFires,
    candidateCount: 0,
    mem: { availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 },
    diskFreeBytes: 40 * 1024 ** 3,
    diskTotalBytes: 100 * 1024 ** 3,
    totalLocks: 0,
    deadLocks: [],
    gitLocks: [],
    workerCount: 0,
    checkoutDepth: { shallow: false, commitCount: 1000 },
    runningNodeVersion: "22.22.3",
    nvmrcVersion: "22.22.3",
  };
}

test("W1-T3472: doctor judges rung-recorded fires even when the live ledger holds none", async () => {
  const instanceRoot = tmp("capture-surface-instance-");
  const repoRoot = tmp("capture-surface-repo-");
  try {
    runEmptyDocketFires(instanceRoot, repoRoot, 3);

    const marker = JSON.parse(readFileSync(join(instanceRoot, "state", "last-feedback-docket.json"), "utf8")) as unknown;
    assert.equal(parseCaptureSurfaceFireHistory(marker).length, 3, "the rung persisted three judged fires beside its marker");

    const output: string[] = [];
    const code = await doctorCommand(["--json"], { ...doctorDeps(instanceRoot), out: (line) => output.push(line) });
    assert.equal(code, 2, "three retained silent fires make capture-surfaces a real doctor failure");

    const report = JSON.parse(output[0]) as { checks: Array<{ name: string; verdict: string; measured: string; detail?: string }> };
    const check = report.checks.find((c) => c.name === "capture-surfaces");
    assert.ok(check, "the capture-surface check is wired into the doctor command");
    assert.equal(check.verdict, "FAIL");
    assert.match(check.measured, /3 counted fire\(s\) of 3 observed/);
    assert.doesNotMatch(
      check.measured,
      /0 counted fire\(s\) of 0 observed/,
      "a live ledger with no feedback_docket rows must not erase the persisted fire history",
    );
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("W1-T3472: too few retained fires still decline judgement, and retained history is bounded", () => {
  const twoFires: CaptureSurfaceFireRecord[] = [0, 1].map((i) => ({
    ts: new Date(Date.parse("2026-08-01T00:00:00.000Z") + i * WEEK_MS).toISOString(),
    step: "feedback_docket.empty",
    window: {},
    counts_by_source: emptyCounts(),
  }));
  const check = judgeCaptureSurfaceLiveness(twoFires);
  assert.equal(check.verdict, "OK");
  assert.match(check.detail ?? "", /not yet judged/);
  assert.match(check.measured, /2 counted fire\(s\) of 2 observed/);

  const instanceRoot = tmp("capture-surface-bounded-instance-");
  const repoRoot = tmp("capture-surface-bounded-repo-");
  try {
    runEmptyDocketFires(instanceRoot, repoRoot, CAPTURE_SURFACE_FIRE_HISTORY_LIMIT + 3);

    const marker = JSON.parse(readFileSync(join(instanceRoot, "state", "last-feedback-docket.json"), "utf8")) as unknown;
    const fires = parseCaptureSurfaceFireHistory(marker);
    assert.equal(fires.length, CAPTURE_SURFACE_FIRE_HISTORY_LIMIT);
    assert.equal(fires[0].ts, "2026-08-22T00:00:00.000Z", "older fires are trimmed once the bound is reached");

    const report = buildDoctorReport(reportInputs(fires));
    const boundedCheck = report.checks.find((c) => c.name === "capture-surfaces");
    assert.equal(boundedCheck?.verdict, "FAIL", "the bound still leaves enough recent fires to judge silence");
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
