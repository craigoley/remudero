/**
 * The QUANTITY figure (W1-T437): every plan-shipping merge carries either zero human steering or
 * a named touch — nothing joined that before this. This suite proves lib/autonomy.ts's own seams:
 *
 *   (i)   parseTrailerMerges / mineAutonomyLedgerLines — the two pure/impure miners over each
 *         corpus (the git "merge record" and the ledger union).
 *   (ii)  zeroTouchMergeRate — the pure core: both falsifier directions from design (iv) (a mixed
 *         window reports the rate with the touched merge's touch NAMED; unreadable ledger
 *         archives report UNMEASURED, never a live-file-only rate), every individual touch
 *         signal, the verdict-class split, and the empty-corpus refusal.
 *   (iii) autonomyRateCommand — the printed report, exercised against an actual scratch git repo
 *         (the #978 rule: when every test injects a fake, the default reader is dead code).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import {
  mineAutonomyLedgerLines,
  parseTrailerMerges,
  zeroTouchMergeRate,
  CURRENT_ARMING_POSTURE,
  type AutonomyLedgerMining,
} from "../src/lib/autonomy.js";
import type { LedgerUnionResult } from "../src/lib/ledger-grep.js";
import { autonomyRateCommand } from "../src/run-task.js";
import { configPath } from "../src/lib/config.js";

function tmpStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeGzArchive(stateDir: string, name: string, lines: string[]): void {
  writeFileSync(join(stateDir, name), gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8")));
}

function ledgerLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

/** Same `\x02%H%x00%cI%x00%s%x00%b%x01` + `--name-only` wire shape
 *  `defaultVerdictCalibrationGitLog` produces, that {@link parseTrailerMerges} reads via
 *  lib/verdict-calibration.ts's `parseGitEventDump` — same discipline as
 *  test/verdict-calibration.test.ts's own `dumpOf`. */
function dumpOf(commits: Array<{ sha: string; ts: string; subject: string; body?: string; files?: string[] }>): string {
  return commits
    .map((c) => `\x02${c.sha}\x00${c.ts}\x00${c.subject}\x00${c.body ?? ""}\x01\n${(c.files ?? []).join("\n")}\n`)
    .join("");
}

function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...extraEnv },
  });
}

/** A fixture {@link AutonomyLedgerMining} — hand-built, bypassing `resolveLedgerUnion`'s own fs
 *  read, so the PURE core ({@link zeroTouchMergeRate}) is exercised directly, same discipline as
 *  test/verdict-calibration.test.ts's hand-built `VerdictRow[]`. */
function mining(linesByTaskId: Record<string, Record<string, unknown>[]>, ledgerOverrides: Partial<LedgerUnionResult> = {}): AutonomyLedgerMining {
  const ledger: LedgerUnionResult = {
    stateDir: "/fixture/state",
    archiveFiles: ["/fixture/state/ledger.2026-01-01.ndjson.gz"],
    archiveCount: 1,
    liveFileRead: false,
    ok: true,
    matches: [],
    ...ledgerOverrides,
  };
  return { ledger, linesByTaskId: new Map(Object.entries(linesByTaskId)) };
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

// ── (i) parseTrailerMerges ───────────────────────────────────────────────────────────────────

test("parseTrailerMerges: extracts the anchored Remudero-Task trailer, sha and date", () => {
  const dump = dumpOf([
    { sha: SHA_A, ts: "2026-01-01T00:00:00+00:00", subject: "feat(x): thing (#900)", body: "detail\n\nRemudero-Task: W1-T900" },
  ]);
  const merges = parseTrailerMerges(dump);
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0], { taskId: "W1-T900", sha: SHA_A, ts: "2026-01-01T00:00:00+00:00" });
});

test("parseTrailerMerges: a commit with no trailer line is excluded, not guessed from the subject", () => {
  const dump = dumpOf([{ sha: SHA_A, ts: "2026-01-01T00:00:00+00:00", subject: "feat(x): thing (W1-T900) (#900)", body: "no trailer here" }]);
  assert.deepEqual(parseTrailerMerges(dump), []);
});

test("parseTrailerMerges: an empty dump yields zero merges, never a crash", () => {
  assert.deepEqual(parseTrailerMerges(""), []);
});

test("parseTrailerMerges: multiple trailer-bearing commits all parse", () => {
  const dump = dumpOf([
    { sha: SHA_A, ts: "2026-01-01T00:00:00+00:00", subject: "one", body: "Remudero-Task: W1-T1" },
    { sha: SHA_B, ts: "2026-01-02T00:00:00+00:00", subject: "two", body: "Remudero-Task: W1-T2" },
  ]);
  const merges = parseTrailerMerges(dump);
  assert.deepEqual(
    merges.map((m) => m.taskId),
    ["W1-T1", "W1-T2"],
  );
});

// ── (i) mineAutonomyLedgerLines ──────────────────────────────────────────────────────────────

test("mineAutonomyLedgerLines: zero archive files degrades to an unreadable union, never a live-file-only read", () => {
  const dir = tmpStateDir("rmd-autonomy-noarchive-");
  try {
    writeFileSync(join(dir, "ledger.ndjson"), ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T900" }) + "\n");
    const { ledger, linesByTaskId } = mineAutonomyLedgerLines(dir);
    assert.equal(ledger.ok, false);
    assert.equal(linesByTaskId.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mineAutonomyLedgerLines: groups matched lines by task_id, excluding steps outside the pattern", () => {
  const dir = tmpStateDir("rmd-autonomy-group-");
  try {
    writeGzArchive(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz", [
      ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T900" }),
      ledgerLine({ ts: "2026-01-01T00:00:01.000Z", step: "ratify.reframed", task_id: "W1-T900" }),
      ledgerLine({ ts: "2026-01-02T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T901" }),
      // A step outside the read pattern — must be excluded from the union match entirely.
      ledgerLine({ ts: "2026-01-02T00:00:01.000Z", step: "escalate.opened", task_id: "W1-T901" }),
    ]);
    const { linesByTaskId } = mineAutonomyLedgerLines(dir);
    assert.equal(linesByTaskId.get("W1-T900")?.length, 2);
    assert.equal(linesByTaskId.get("W1-T901")?.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (ii) zeroTouchMergeRate: the pure core ──────────────────────────────────────────────────

test("FALSIFIER: a mixed window (one auto-armed strike-free merge, one reframed merge) reports 50% with the touch NAMED", () => {
  const merges = [
    { taskId: "W1-T1", sha: SHA_A, ts: "2026-01-01T00:00:00+00:00" },
    { taskId: "W1-T2", sha: SHA_B, ts: "2026-01-02T00:00:00+00:00" },
  ];
  const m = mining({
    "W1-T1": [{ step: "automerge.armed", task_id: "W1-T1" }],
    "W1-T2": [{ step: "automerge.armed", task_id: "W1-T2" }, { step: "ratify.reframed", task_id: "W1-T2" }],
  });
  const report = zeroTouchMergeRate(merges, m);
  assert.equal(report.status, "measured");
  assert.equal(report.totalMerges, 2);
  assert.equal(report.zeroTouchCount, 1);
  assert.equal(report.zeroTouchRate, 0.5);
  const t1 = report.rows.find((r) => r.taskId === "W1-T1")!;
  const t2 = report.rows.find((r) => r.taskId === "W1-T2")!;
  assert.equal(t1.zeroTouch, true);
  assert.deepEqual(t1.touches, []);
  assert.equal(t2.zeroTouch, false, "deleting the touch attribution fails this falsifier");
  assert.deepEqual(t2.touches, ["reframed 1 time before merge"]);
});

test("FALSIFIER: unreadable ledger archives report UNMEASURED, never a rate computed from the live file alone", () => {
  const merges = [{ taskId: "W1-T1", sha: SHA_A, ts: "2026-01-01T00:00:00+00:00" }];
  const m = mining({ "W1-T1": [{ step: "automerge.armed", task_id: "W1-T1" }] }, { ok: false, archiveCount: 0, matches: [] });
  const report = zeroTouchMergeRate(merges, m);
  assert.equal(report.status, "unmeasured");
  assert.equal(report.zeroTouchRate, null);
  assert.deepEqual(report.rows, []);
  assert.match(report.reason ?? "", /zero ledger archive files matched/);
  assert.match(report.reason ?? "", /not a rate over the live file alone/);
});

test("an EMPTY merge corpus reports n=0 and a null rate, never a false 0% or 100%", () => {
  const report = zeroTouchMergeRate([], mining({}));
  assert.equal(report.totalMerges, 0);
  assert.equal(report.zeroTouchRate, null);
  assert.equal(report.classes.length, 4);
  for (const c of report.classes) {
    assert.equal(c.total, 0);
    assert.equal(c.zeroTouchRate, null);
  }
});

test("touch: not auto-armed (no automerge.armed line at all) is named", () => {
  const merges = [{ taskId: "W1-T1", sha: SHA_A, ts: "2026-01-01T00:00:00+00:00" }];
  const report = zeroTouchMergeRate(merges, mining({ "W1-T1": [] }));
  assert.equal(report.rows[0].zeroTouch, false);
  assert.match(report.rows[0].touches[0], /not auto-armed/);
});

test("touch: fix-rung strikes are named with the count", () => {
  const merges = [{ taskId: "W1-T1", sha: SHA_A, ts: "2026-01-01T00:00:00+00:00" }];
  const m = mining({ "W1-T1": [{ step: "automerge.armed", task_id: "W1-T1" }, { step: "fix.resolved", task_id: "W1-T1", strikes: 2 }] });
  const report = zeroTouchMergeRate(merges, m);
  assert.equal(report.rows[0].zeroTouch, false);
  assert.deepEqual(report.rows[0].touches, ["2 fix-rung strikes spent"]);
});

test("touch: a fix.exhausted line's strikes count also names a touch", () => {
  const merges = [{ taskId: "W1-T1", sha: SHA_A, ts: "2026-01-01T00:00:00+00:00" }];
  const m = mining({ "W1-T1": [{ step: "automerge.armed", task_id: "W1-T1" }, { step: "fix.exhausted", task_id: "W1-T1", strikes: 1 }] });
  const report = zeroTouchMergeRate(merges, m);
  assert.deepEqual(report.rows[0].touches, ["1 fix-rung strike spent"]);
});

test("touch: operator note added is named with its count", () => {
  const merges = [{ taskId: "W1-T1", sha: SHA_A, ts: "2026-01-01T00:00:00+00:00" }];
  const m = mining({
    "W1-T1": [
      { step: "automerge.armed", task_id: "W1-T1" },
      { step: "panel.operator_note_added", task_id: "W1-T1" },
      { step: "panel.operator_note_added", task_id: "W1-T1" },
    ],
  });
  const report = zeroTouchMergeRate(merges, m);
  assert.deepEqual(report.rows[0].touches, ["operator note added (2)"]);
});

test("touch: a capped override is named with who granted it", () => {
  const merges = [{ taskId: "W1-T1", sha: SHA_A, ts: "2026-01-01T00:00:00+00:00" }];
  const m = mining({
    "W1-T1": [
      { step: "automerge.armed", task_id: "W1-T1" },
      { step: "automerge.capped_override_granted", task_id: "W1-T1", by: "op-name" },
    ],
  });
  const report = zeroTouchMergeRate(merges, m);
  assert.deepEqual(report.rows[0].touches, ["capped override granted by op-name"]);
});

test("touch: fix-rung human evidence (a stood_down line carrying issue_url) is named", () => {
  const merges = [{ taskId: "W1-T1", sha: SHA_A, ts: "2026-01-01T00:00:00+00:00" }];
  const m = mining({
    "W1-T1": [
      { step: "automerge.armed", task_id: "W1-T1" },
      { step: "fix.stood_down", task_id: "W1-T1", issue_url: "https://example/issues/1" },
      // A stood_down line with NO issue_url is a non-human (terminal-state) stand-down — must not count.
      { step: "fix.stood_down", task_id: "W1-T1" },
    ],
  });
  const report = zeroTouchMergeRate(merges, m);
  assert.deepEqual(report.rows[0].touches, ["fix rung stood down for human evidence (1)"]);
});

test("every firing touch is named on the row, never just the first", () => {
  const merges = [{ taskId: "W1-T1", sha: SHA_A, ts: "2026-01-01T00:00:00+00:00" }];
  const m = mining({
    "W1-T1": [
      // deliberately NO automerge.armed line
      { step: "fix.resolved", task_id: "W1-T1", strikes: 1 },
      { step: "ratify.reframed", task_id: "W1-T1" },
      { step: "panel.operator_note_added", task_id: "W1-T1" },
      { step: "automerge.capped_override_granted", task_id: "W1-T1", by: "op" },
      { step: "fix.stood_down", task_id: "W1-T1", issue_url: "https://example/issues/2" },
    ],
  });
  const report = zeroTouchMergeRate(merges, m);
  assert.equal(report.rows[0].touches.length, 6);
});

test("split BY VERDICT CLASS: each class's zero-touch rate is computed independently", () => {
  const merges = [
    { taskId: "W1-T1", sha: SHA_A, ts: "2026-01-01T00:00:00+00:00" }, // full-pass, zero-touch
    { taskId: "W1-T2", sha: SHA_B, ts: "2026-01-02T00:00:00+00:00" }, // keyword-floor, touched
  ];
  const m = mining({
    "W1-T1": [
      { step: "automerge.armed", task_id: "W1-T1" },
      { step: "review.posted", task_id: "W1-T1", capped: false, floor_degraded: false },
    ],
    "W1-T2": [
      { step: "automerge.armed", task_id: "W1-T2" },
      { step: "review.posted", task_id: "W1-T2", capped: false, floor_degraded: true },
      { step: "ratify.reframed", task_id: "W1-T2" },
    ],
  });
  const report = zeroTouchMergeRate(merges, m);
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  const keywordFloor = report.classes.find((c) => c.verdictClass === "keyword-floor")!;
  const degradedArm = report.classes.find((c) => c.verdictClass === "degraded-arm")!;
  assert.equal(fullPass.total, 1);
  assert.equal(fullPass.zeroTouchRate, 1);
  assert.equal(keywordFloor.total, 1);
  assert.equal(keywordFloor.zeroTouchRate, 0);
  assert.equal(degradedArm.total, 0);
  assert.equal(degradedArm.zeroTouchRate, null);
});

test("a merge with no review.posted line lands in the 'unclassified' bucket, never guessed into a real class", () => {
  const merges = [{ taskId: "W1-T1", sha: SHA_A, ts: "2026-01-01T00:00:00+00:00" }];
  const report = zeroTouchMergeRate(merges, mining({ "W1-T1": [{ step: "automerge.armed", task_id: "W1-T1" }] }));
  assert.equal(report.rows[0].verdictClass, null);
  const unclassified = report.classes.find((c) => c.verdictClass === "unclassified")!;
  assert.equal(unclassified.total, 1);
});

test("the current arming posture travels with every report, measured or unmeasured", () => {
  const measured = zeroTouchMergeRate([], mining({}));
  const unmeasured = zeroTouchMergeRate([], mining({}, { ok: false }));
  assert.equal(measured.armingPosture, CURRENT_ARMING_POSTURE);
  assert.equal(unmeasured.armingPosture, CURRENT_ARMING_POSTURE);
  assert.match(measured.armingPosture, /decideAutoMergeArm/);
});

// ── (iii) autonomyRateCommand ────────────────────────────────────────────────────────────────

test("autonomyRateCommand: refuses an unknown flag, spawning nothing", () => {
  const realErr = console.error;
  console.error = () => {};
  try {
    assert.equal(autonomyRateCommand(["--bogus"]), 2);
  } finally {
    console.error = realErr;
  }
});

test("autonomyRateCommand: with no opts.stateDir and an unreadable config, reports 'cannot resolve', never a throw", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-autonomy-cfg-bad-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const errs: string[] = [];
  const realErr = console.error;
  const realLog = console.log;
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  console.log = () => {};
  try {
    const p = configPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "not json");

    const code = autonomyRateCommand([]);

    assert.equal(code, 1);
    assert.match(errs.join("\n"), /rmd autonomy-rate: cannot resolve a state dir — unreadable config/);
  } finally {
    console.error = realErr;
    console.log = realLog;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

/** Builds a scratch repo with two trailer-bearing commits: W1-T900 (zero-touch) and W1-T901
 *  (reframed), plus a fabricated `origin/main` tracking ref — same pattern
 *  test/verdict-calibration.test.ts's `buildFixtureRepo` uses for the sibling verb. */
function buildFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-autonomy-repo-"));
  git(["init", "-q", "-b", "main"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"], dir);
  writeFileSync(join(dir, "x.ts"), "one\n");
  git(["add", "-A"], dir);
  git(
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat(x): thing (#900)\n\nRemudero-Task: W1-T900", "--date", "2026-01-01T00:00:00+00:00"],
    dir,
    { GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00" },
  );
  writeFileSync(join(dir, "y.ts"), "one\n");
  git(["add", "-A"], dir);
  git(
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat(y): other thing (#901)\n\nRemudero-Task: W1-T901", "--date", "2026-01-02T00:00:00+00:00"],
    dir,
    { GIT_COMMITTER_DATE: "2026-01-02T00:00:00+00:00" },
  );
  git(["update-ref", "refs/remotes/origin/main", "main"], dir);
  return dir;
}

test("autonomyRateCommand: end-to-end over a real repo — reports the zero-touch rate, the class split and names the touched merge", () => {
  const repoDir = buildFixtureRepo();
  const stateDir = tmpStateDir("rmd-autonomy-cli-");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    writeGzArchive(stateDir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz", [
      ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T900" }),
      ledgerLine({ ts: "2026-01-02T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T901" }),
      ledgerLine({ ts: "2026-01-02T00:00:01.000Z", step: "ratify.reframed", task_id: "W1-T901" }),
    ]);

    const code = autonomyRateCommand([], { stateDir, cwd: repoDir });
    assert.equal(code, 0);
    const out = logs.join("\n");
    assert.match(out, /arming posture: decideAutoMergeArm/);
    assert.match(out, /zero-touch merge rate: 50\.0% \(1\/2\)/);
    assert.match(out, /1 touched merge\(s\) cost a human or fix-rung step/);
    assert.match(out, /touched merges: 1/);
    assert.match(out, /W1-T901 @ [0-9a-f]{7}: reframed 1 time before merge/);
  } finally {
    console.log = realLog;
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("autonomyRateCommand: a git-history read failure still prints a report, naming git history UNAVAILABLE", () => {
  const stateDir = tmpStateDir("rmd-autonomy-cli-giterr-");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    writeGzArchive(stateDir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz", [ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T900" })]);
    const nonexistentCwd = join(tmpdir(), "rmd-autonomy-nonexistent-xyz-does-not-exist");

    const code = autonomyRateCommand([], { stateDir, cwd: nonexistentCwd });
    assert.equal(code, 0, "an unreadable git history must degrade to n=0, never crash the command");
    const out = logs.join("\n");
    assert.match(out, /git history: UNAVAILABLE/);
    assert.match(out, /zero-touch merge rate: n=0 — no trailer-bearing merges in this window/);
  } finally {
    console.log = realLog;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("autonomyRateCommand: zero ledger archive files reports UNMEASURED, never a rate over the live file alone", () => {
  const repoDir = buildFixtureRepo();
  const stateDir = tmpStateDir("rmd-autonomy-cli-noarchive-");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    // A live ledger file, but no `.ndjson.gz` archive — the exact zgrep-union undercount shape.
    writeFileSync(join(stateDir, "ledger.ndjson"), ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T900" }) + "\n");

    const code = autonomyRateCommand([], { stateDir, cwd: repoDir });
    assert.equal(code, 0);
    const out = logs.join("\n");
    assert.match(out, /zero-touch merge rate: UNMEASURED — zero ledger archive files matched/);
  } finally {
    console.log = realLog;
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
