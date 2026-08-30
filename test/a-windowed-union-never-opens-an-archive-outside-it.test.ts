/**
 * W1-T2484 — resolveLedgerUnion's new OPTIONAL window (`opts.since`): a caller who already knows
 * the instant it cares about can skip a rotation without ever opening it, because the archive's
 * own NAME is the ISO write instant (`datedArchivePath`, ledger.ts) and `ledgerRotationEntries`
 * already returns the list sorted by that name — so a window is a prefix skip, not a scan.
 *
 * THE HAZARD THIS PROVES SAFE: `resolveLedgerUnion`'s whole reason to exist is refusing to answer
 * from a partially-read corpus (W1-T444's zgrep-union lesson). A window must distinguish
 * SKIPPED-BECAUSE-OUTSIDE-THE-WINDOW (fine — the caller declined that coverage on purpose) from
 * COULD-NOT-BE-READ (the failure this whole module exists to refuse). This suite drives both
 * through the SAME fixture shape so the two can never be confused with each other.
 *
 * Every test below exercises `resolveLedgerUnion` (the reader) or `mineAutonomyLedgerLines` /
 * `zeroTouchMergeRate` (the one converted consumer, lib/autonomy.ts) — never a glob, per this
 * repo's own ledger-corpus-needs-the-resolver lesson.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { test } from "node:test";

import { resolveLedgerUnion, type LedgerGrepFsDeps } from "../src/lib/ledger-grep.js";
import { mineAutonomyLedgerLines, zeroTouchMergeRate, type MergeRecord } from "../src/lib/autonomy.js";

function tmpStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeGzArchive(stateDir: string, name: string, lines: string[]): void {
  writeFileSync(join(stateDir, name), gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8")));
}

function ledgerLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

/** Real fs deps that additionally record every path handed to `readFileSync` — so a test can
 *  assert a specific archive was never OPENED, not merely that its lines are absent from the
 *  result (which a post-read filter could also produce). */
function spyingFsDeps(readCalls: string[]): LedgerGrepFsDeps {
  return {
    readdirSync: (dir) => readdirSync(dir),
    existsSync: (p) => existsSync(p),
    readFileSync: (p) => {
      readCalls.push(p);
      return readFileSync(p);
    },
    gunzipSync: (buf) => gunzipSync(buf),
  };
}

// Three archives, deliberately named so their ISO write instants (`rotationStampIso`'s inverse of
// `datedArchivePath`) sort OLD < MID < NEW, exactly like a real rotation directory.
const OLD_NAME = "ledger.2026-01-01T00-00-00-000Z.ndjson.gz";
const MID_NAME = "ledger.2026-02-01T00-00-00-000Z.ndjson.gz";
const NEW_NAME = "ledger.2026-03-01T00-00-00-000Z.ndjson.gz";
// Strictly between OLD's and MID's stamps: OLD must be skipped, MID and NEW must not.
const SINCE_AFTER_OLD = "2026-01-15T00:00:00.000Z";

function buildThreeArchiveFixture(dir: string): void {
  writeGzArchive(dir, OLD_NAME, [ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "run.start", task_id: "W1-OLD" })]);
  writeGzArchive(dir, MID_NAME, [ledgerLine({ ts: "2026-02-05T00:00:00.000Z", step: "run.start", task_id: "W1-MID" })]);
  writeGzArchive(dir, NEW_NAME, [ledgerLine({ ts: "2026-03-05T00:00:00.000Z", step: "run.start", task_id: "W1-NEW" })]);
  writeFileSync(join(dir, "ledger.ndjson"), ledgerLine({ ts: "2026-04-01T00:00:00.000Z", step: "run.start", task_id: "W1-LIVE" }) + "\n");
}

// ── acceptance: an unwindowed read is byte-identical to today's ────────────────────────────────

test("an unwindowed read (opts.since omitted) returns every archive's matches, exactly as before this parameter existed", () => {
  const dir = tmpStateDir("rmd-windowed-union-unwindowed-");
  try {
    buildThreeArchiveFixture(dir);
    const result = resolveLedgerUnion(dir, "run\\.start");
    assert.equal(result.ok, true);
    assert.equal(result.archiveCount, 3);
    assert.equal(result.liveFileRead, true);
    assert.deepEqual(
      result.matches.map((l) => (JSON.parse(l) as { task_id: string }).task_id).sort(),
      ["W1-LIVE", "W1-MID", "W1-NEW", "W1-OLD"],
      "no archive is skipped when no window is supplied — the exact behaviour every existing caller relies on",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance: a windowed read never OPENS an archive outside it ──────────────────────────────

test("a windowed read never opens an archive whose name sorts below the window start", () => {
  const dir = tmpStateDir("rmd-windowed-union-never-opens-");
  const readCalls: string[] = [];
  try {
    buildThreeArchiveFixture(dir);
    const oldPath = join(dir, OLD_NAME);
    const result = resolveLedgerUnion(dir, "run\\.start", spyingFsDeps(readCalls), { since: SINCE_AFTER_OLD });

    // Acceptance #8: this assertion NAMES the archive it must never open, so removing the skip
    // (reading every rotation regardless of `since`) fails it with `oldPath` printed, not a bare
    // boolean mismatch.
    assert.ok(
      !readCalls.includes(oldPath),
      `since=${SINCE_AFTER_OLD} must never open ${oldPath} (stamped before it) — readFileSync calls were: ${JSON.stringify(readCalls)}`,
    );
    assert.ok(result.ok, "the skip is not a failure — the union still resolves");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance: a windowed read still returns every matching row at or after the window start ──

test("a windowed read still returns every matching row from archives at or after the window start", () => {
  const dir = tmpStateDir("rmd-windowed-union-still-returns-");
  try {
    buildThreeArchiveFixture(dir);
    const result = resolveLedgerUnion(dir, "run\\.start", undefined, { since: SINCE_AFTER_OLD });
    const taskIds = result.matches.map((l) => (JSON.parse(l) as { task_id: string }).task_id).sort();
    assert.deepEqual(taskIds.filter((t) => t !== "W1-LIVE"), ["W1-MID", "W1-NEW"], "MID and NEW, both at or after the window start, are returned");
    assert.ok(!taskIds.includes("W1-OLD"), "OLD, stamped before the window, is excluded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance: the live ledger is always read regardless of the window ────────────────────────

test("the live ledger is always read regardless of the window, even one that excludes every archive", () => {
  const dir = tmpStateDir("rmd-windowed-union-live-always-");
  try {
    buildThreeArchiveFixture(dir);
    // Later than every archive's own stamp — every rotation is skipped, but the live file (never
    // a rotation, never dated) is not bounded by any archive's name.
    const result = resolveLedgerUnion(dir, "run\\.start", undefined, { since: "2026-12-01T00:00:00.000Z" });
    assert.equal(result.liveFileRead, true);
    assert.deepEqual(
      result.matches.map((l) => (JSON.parse(l) as { task_id: string }).task_id),
      ["W1-LIVE"],
      "every archive was skipped by the window; only the live file's row survives",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance: a window-skipped archive is not reported as unread coverage ────────────────────

test("an archive skipped for being outside the window is not reported as unread coverage", () => {
  const dir = tmpStateDir("rmd-windowed-union-not-unread-");
  try {
    buildThreeArchiveFixture(dir);
    // Every archive skipped (same window as the live-always test above), yet nothing failed.
    const result = resolveLedgerUnion(dir, "run\\.start", undefined, { since: "2026-12-01T00:00:00.000Z" });
    assert.deepEqual(result.unread, [], "a window-skipped archive is declined coverage, not failed coverage");
    assert.equal(result.archiveCount, 3, "archiveCount still answers what EXISTS — the window does not change that");
    assert.equal(result.ok, true, "ok stays true: coverage was never attempted-and-failed, only intentionally skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance: a genuinely unreadable archive still refuses, window or not ────────────────────

test("an archive that genuinely cannot be read is still reported as partial coverage, even inside the window", () => {
  const dir = tmpStateDir("rmd-windowed-union-genuinely-unread-");
  try {
    // OLD is a real, readable archive stamped BEFORE the window — it must be skipped, not opened.
    writeGzArchive(dir, OLD_NAME, [ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "run.start", task_id: "W1-OLD" })]);
    // MID is stamped AT-OR-AFTER the window start but is not actually gzip — a corrupt rotation
    // the window does NOT exempt from the readability guard.
    writeFileSync(join(dir, MID_NAME), "not gzip data");
    writeGzArchive(dir, NEW_NAME, [ledgerLine({ ts: "2026-03-05T00:00:00.000Z", step: "run.start", task_id: "W1-NEW" })]);

    const result = resolveLedgerUnion(dir, "run\\.start", undefined, { since: SINCE_AFTER_OLD });

    assert.deepEqual(result.unread, [join(dir, MID_NAME)], "MID was IN the window and attempted, and failed — that is real partial coverage");
    assert.equal(result.ok, false, "a genuinely unread rotation refuses the answer regardless of the window");
    assert.deepEqual(result.matches, [], "coverage, not readability — the same refusal an unwindowed corrupt archive gets");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance: the converted consumer (autonomy.ts) reports the same rate windowed or not ─────

test("mineAutonomyLedgerLines + zeroTouchMergeRate: a window that excludes only an irrelevant archive reports the identical rate", () => {
  const dir = tmpStateDir("rmd-windowed-union-autonomy-consumer-");
  try {
    // OLD, before the window, carries a touch signal for a task that is NOT in this run's merge
    // corpus at all — it must never affect the report whether it is opened or skipped.
    writeGzArchive(dir, OLD_NAME, [ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "automerge.armed", task_id: "W1-IRRELEVANT" })]);
    // NEW, at-or-after the window, carries the two merges' own ledger lines.
    writeGzArchive(dir, NEW_NAME, [
      ledgerLine({ ts: "2026-03-01T00:00:01.000Z", step: "automerge.armed", task_id: "W1-T1" }),
      ledgerLine({ ts: "2026-03-01T00:00:02.000Z", step: "automerge.armed", task_id: "W1-T2" }),
      ledgerLine({ ts: "2026-03-01T00:00:03.000Z", step: "ratify.reframed", task_id: "W1-T2" }),
    ]);

    const merges: MergeRecord[] = [
      { taskId: "W1-T1", sha: "a".repeat(40), ts: "2026-03-02T00:00:00.000Z" },
      { taskId: "W1-T2", sha: "b".repeat(40), ts: "2026-03-02T00:00:01.000Z" },
    ];

    const fullMining = mineAutonomyLedgerLines(dir);
    const windowedMining = mineAutonomyLedgerLines(dir, undefined, { since: SINCE_AFTER_OLD });

    // Confirms the window actually did something (OLD's archive is excluded from the union) —
    // otherwise this test could pass for the wrong reason (the window silently doing nothing).
    assert.equal(fullMining.linesByTaskId.has("W1-IRRELEVANT"), true);
    assert.equal(windowedMining.linesByTaskId.has("W1-IRRELEVANT"), false, "OLD, before the window, was never opened");

    const fullReport = zeroTouchMergeRate(merges, fullMining);
    const windowedReport = zeroTouchMergeRate(merges, windowedMining);

    assert.deepEqual(windowedReport, fullReport, "the merges this run cares about are unaffected by excluding an irrelevant, out-of-window archive");
    assert.equal(fullReport.zeroTouchRate, 0.5, "sanity: one zero-touch (W1-T1), one reframed (W1-T2)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
