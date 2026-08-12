/**
 * The correctness join (W1-T424): verdicts are never compared against what happened next. This
 * suite proves the join at three layers, matching the module's own seams:
 *
 *   (i)   parseGitEventDump / mineVerdictRows — the two pure/impure miners over each corpus.
 *   (ii)  verdictCalibrationReport — the pure core: both falsifier directions from design (v)
 *         (a revert inside the window is a miss, the same revert outside is not; a fix-typed
 *         commit with zero overlap and no citation attributes to nothing), the minimum
 *         population floor, the UNMEASURABLE arm (both failure shapes: unrecoverable verdict
 *         class, unrecoverable merge sha), and the empty-corpus refusal.
 *   (iii) defaultVerdictCalibrationGitLog / verdictCalibrationCommand — the real reader and the
 *         printed report, exercised against an actual scratch git repo (the #978 rule: when
 *         every test injects a fake, the default reader is dead code).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import {
  ATTRIBUTION_POLICY,
  MIN_POPULATION_FLOOR,
  mineVerdictRows,
  parseGitEventDump,
  verdictCalibrationReport,
  type VerdictRow,
} from "../src/lib/verdict-calibration.js";
import { defaultVerdictCalibrationGitLog, verdictCalibrationCommand } from "../src/run-task.js";
import { configPath, type Config } from "../src/lib/config.js";

function tmpStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeGzArchive(stateDir: string, name: string, lines: string[]): void {
  writeFileSync(join(stateDir, name), gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8")));
}

function ledgerLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

/** Builds the exact `\x02%H%x00%cI%x00%s%x00%b%x01` + `--name-only` wire shape
 *  `defaultVerdictCalibrationGitLog` produces, so the pure functions are tested over the real
 *  format (same discipline as test/lint-plan-merge-evidence.test.ts's `dumpOf`). */
function dumpOf(commits: Array<{ sha: string; ts: string; subject: string; body?: string; files?: string[] }>): string {
  return commits
    .map((c) => `\x02${c.sha}\x00${c.ts}\x00${c.subject}\x00${c.body ?? ""}\x01\n${(c.files ?? []).join("\n")}\n`)
    .join("");
}

const MERGE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ── (i) parseGitEventDump ────────────────────────────────────────────────────────────────────

test("parseGitEventDump: round-trips sha, date, subject, body and files", () => {
  const dump = dumpOf([
    { sha: MERGE_SHA, ts: "2026-01-01T00:00:00+00:00", subject: "feat(x): thing (W1-T900) (#900)", body: "detail\nmore", files: ["src/x.ts", "src/y.ts"] },
  ]);
  const events = parseGitEventDump(dump);
  assert.equal(events.length, 1);
  assert.equal(events[0].sha, MERGE_SHA);
  assert.equal(events[0].ts, "2026-01-01T00:00:00+00:00");
  assert.equal(events[0].subject, "feat(x): thing (W1-T900) (#900)");
  assert.equal(events[0].body, "detail\nmore");
  assert.deepEqual(events[0].files, ["src/x.ts", "src/y.ts"]);
});

test("parseGitEventDump: an empty dump yields zero events, never a crash", () => {
  assert.deepEqual(parseGitEventDump(""), []);
});

test("parseGitEventDump: multiple commits parse independently", () => {
  const events = parseGitEventDump(
    dumpOf([
      { sha: "1111111111111111111111111111111111111a", ts: "2026-01-01T00:00:00+00:00", subject: "one", files: ["a.ts"] },
      { sha: "2222222222222222222222222222222222222b", ts: "2026-01-02T00:00:00+00:00", subject: "two", files: [] },
    ]),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].subject, "one");
  assert.equal(events[1].subject, "two");
  assert.deepEqual(events[1].files, []);
});

// ── (i) mineVerdictRows ──────────────────────────────────────────────────────────────────────

test("mineVerdictRows: zero archive files degrades to zero rows, never a live-file-only read", () => {
  const dir = tmpStateDir("rmd-verdict-cal-noarchive-");
  try {
    writeFileSync(
      join(dir, "ledger.ndjson"),
      ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T900", head_sha: "deadbeef" }) + "\n",
    );
    const { ledger, rows } = mineVerdictRows(dir);
    assert.equal(ledger?.ok, false);
    assert.deepEqual(rows, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mineVerdictRows: joins automerge.armed to review.posted by task+head, classifying full-pass/keyword-floor/degraded-arm", () => {
  const dir = tmpStateDir("rmd-verdict-cal-join-");
  try {
    writeGzArchive(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz", [
      ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T900", head_sha: "sha900" }),
      ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "review.posted", task_id: "W1-T900", head_sha: "sha900", capped: false, floor_degraded: false }),
      ledgerLine({ ts: "2026-01-02T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T901", head_sha: "sha901" }),
      ledgerLine({ ts: "2026-01-02T00:00:00.000Z", step: "review.posted", task_id: "W1-T901", head_sha: "sha901", capped: false, floor_degraded: true }),
      ledgerLine({ ts: "2026-01-03T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T902", head_sha: "sha902" }),
      ledgerLine({ ts: "2026-01-03T00:00:00.000Z", step: "review.posted", task_id: "W1-T902", head_sha: "sha902", capped: true, floor_degraded: false }),
      // W1-T903 armed with NO matching review.posted line at all.
      ledgerLine({ ts: "2026-01-04T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T903", head_sha: "sha903" }),
    ]);
    const { rows } = mineVerdictRows(dir);
    const byTask = new Map(rows.map((r) => [r.taskId, r]));
    assert.equal(byTask.get("W1-T900")?.verdictClass, "full-pass");
    assert.equal(byTask.get("W1-T901")?.verdictClass, "keyword-floor");
    assert.equal(byTask.get("W1-T902")?.verdictClass, "degraded-arm");
    assert.equal(byTask.get("W1-T903")?.verdictClass, null);
    assert.match(byTask.get("W1-T903")?.classifyWhy ?? "", /no matching review\.posted line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (ii) verdictCalibrationReport: the pure core ────────────────────────────────────────────

test("an EMPTY verdict corpus prints counts and refuses rates for every class, never a false 0%", () => {
  const report = verdictCalibrationReport([], "");
  assert.equal(report.classes.length, 3);
  for (const c of report.classes) {
    assert.equal(c.total, 0);
    assert.equal(c.revertedCount, 0);
    assert.equal(c.followupFixedCount, 0);
    assert.equal(c.revertRate, null);
    assert.equal(c.followupFixRate, null);
  }
  assert.deepEqual(report.unmeasurable, []);
});

test("FALSIFIER: a revert INSIDE the window classifies as a miss", () => {
  const row: VerdictRow = { taskId: "W1-T900", headSha: "sha900", armedTs: "2025-12-31T23:50:00.000Z", verdictClass: "full-pass" };
  const dump = dumpOf([
    { sha: MERGE_SHA, ts: "2026-01-01T00:00:00+00:00", subject: "feat(x): thing (W1-T900) (#900)", files: ["src/x.ts"] },
    { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ts: "2026-01-05T00:00:00+00:00", subject: 'Revert "feat(x): thing (W1-T900) (#900)"', body: `This reverts commit ${MERGE_SHA}.`, files: ["src/x.ts"] },
  ]);
  const report = verdictCalibrationReport([row], dump);
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fullPass.total, 1);
  assert.equal(fullPass.revertedCount, 1);
});

test("FALSIFIER: the SAME revert dated OUTSIDE the window does not classify as a miss", () => {
  const row: VerdictRow = { taskId: "W1-T900", headSha: "sha900", armedTs: "2025-12-31T23:50:00.000Z", verdictClass: "full-pass" };
  const dump = dumpOf([
    { sha: MERGE_SHA, ts: "2026-01-01T00:00:00+00:00", subject: "feat(x): thing (W1-T900) (#900)", files: ["src/x.ts"] },
    // 31 days later — past the 14-day ATTRIBUTION_POLICY window.
    { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ts: "2026-02-01T00:00:00+00:00", subject: 'Revert "feat(x): thing (W1-T900) (#900)"', body: `This reverts commit ${MERGE_SHA}.`, files: ["src/x.ts"] },
  ]);
  const report = verdictCalibrationReport([row], dump);
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fullPass.total, 1);
  assert.equal(fullPass.revertedCount, 0, "a revert past the window must never count as a miss");
});

test("over-attribution guard: a fix-typed commit with ZERO file overlap and NO id citation attributes to nothing", () => {
  const row: VerdictRow = { taskId: "W1-T900", headSha: "sha900", armedTs: "2025-12-31T23:50:00.000Z", verdictClass: "full-pass" };
  const dump = dumpOf([
    { sha: MERGE_SHA, ts: "2026-01-01T00:00:00+00:00", subject: "feat(x): thing (W1-T900) (#900)", files: ["src/x.ts"] },
    { sha: "cccccccccccccccccccccccccccccccccccccccc", ts: "2026-01-03T00:00:00+00:00", subject: "fix(y): an unrelated bug", files: ["other/unrelated.ts"] },
  ]);
  const report = verdictCalibrationReport([row], dump);
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fullPass.followupFixedCount, 0, "a busy repo fixing unrelated things must never inflate the rate");
});

test("follow-up fix attributes via FILE OVERLAP alone", () => {
  const row: VerdictRow = { taskId: "W1-T900", headSha: "sha900", armedTs: "2025-12-31T23:50:00.000Z", verdictClass: "full-pass" };
  const dump = dumpOf([
    { sha: MERGE_SHA, ts: "2026-01-01T00:00:00+00:00", subject: "feat(x): thing (W1-T900) (#900)", files: ["src/x.ts"] },
    { sha: "cccccccccccccccccccccccccccccccccccccccc", ts: "2026-01-03T00:00:00+00:00", subject: "fix: patch a regression", files: ["src/x.ts"] },
  ]);
  const report = verdictCalibrationReport([row], dump);
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fullPass.followupFixedCount, 1);
});

test("follow-up fix attributes via TASK-ID CITATION alone, with zero file overlap", () => {
  const row: VerdictRow = { taskId: "W1-T900", headSha: "sha900", armedTs: "2025-12-31T23:50:00.000Z", verdictClass: "full-pass" };
  const dump = dumpOf([
    { sha: MERGE_SHA, ts: "2026-01-01T00:00:00+00:00", subject: "feat(x): thing (W1-T900) (#900)", files: ["src/x.ts"] },
    { sha: "cccccccccccccccccccccccccccccccccccccccc", ts: "2026-01-03T00:00:00+00:00", subject: "fix(z): patch (W1-T900)", files: ["completely/different.ts"] },
  ]);
  const report = verdictCalibrationReport([row], dump);
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fullPass.followupFixedCount, 1);
});

test("a class BELOW the minimum population floor refuses the rate but still prints the counts", () => {
  assert.ok(MIN_POPULATION_FLOOR >= 2, "sanity: the floor is a real bound");
  const rows: VerdictRow[] = [];
  const dumpCommits: Array<{ sha: string; ts: string; subject: string; files?: string[] }> = [];
  for (let i = 0; i < MIN_POPULATION_FLOOR - 1; i++) {
    const taskId = `W1-T9${i}`;
    const sha = `${i}`.repeat(40).slice(0, 40);
    rows.push({ taskId, headSha: `sha9${i}`, armedTs: "2025-12-31T23:50:00.000Z", verdictClass: "full-pass" });
    dumpCommits.push({ sha, ts: "2026-01-01T00:00:00+00:00", subject: `feat(x): thing (${taskId})`, files: [] });
  }
  const report = verdictCalibrationReport(rows, dumpOf(dumpCommits));
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fullPass.total, MIN_POPULATION_FLOOR - 1);
  assert.equal(fullPass.revertRate, null);
  assert.equal(fullPass.followupFixRate, null);
});

test("a class AT the minimum population floor prints a real rate", () => {
  const rows: VerdictRow[] = [];
  const dumpCommits: Array<{ sha: string; ts: string; subject: string; files?: string[] }> = [];
  for (let i = 0; i < MIN_POPULATION_FLOOR; i++) {
    const taskId = `W1-T8${i}`;
    const sha = `${i}`.repeat(40).slice(0, 40);
    rows.push({ taskId, headSha: `sha8${i}`, armedTs: "2025-12-31T23:50:00.000Z", verdictClass: "full-pass" });
    dumpCommits.push({ sha, ts: "2026-01-01T00:00:00+00:00", subject: `feat(x): thing (${taskId})`, files: [] });
  }
  const report = verdictCalibrationReport(rows, dumpOf(dumpCommits));
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fullPass.total, MIN_POPULATION_FLOOR);
  assert.equal(fullPass.revertRate, 0);
  assert.equal(fullPass.followupFixRate, 0);
});

test("UNMEASURABLE (merge sha unrecoverable): no commit cites the task id at/after the arm", () => {
  const row: VerdictRow = { taskId: "W1-T999", headSha: "sha999", armedTs: "2025-12-31T23:50:00.000Z", verdictClass: "full-pass" };
  const report = verdictCalibrationReport([row], dumpOf([{ sha: MERGE_SHA, ts: "2026-01-01T00:00:00+00:00", subject: "chore: something unrelated" }]));
  assert.equal(report.classes.every((c) => c.total === 0), true);
  assert.equal(report.unmeasurable.length, 1);
  assert.equal(report.unmeasurable[0].taskId, "W1-T999");
  assert.match(report.unmeasurable[0].why, /merge sha could not be recovered/);
});

test("UNMEASURABLE (verdict class unrecoverable): a row with no classification is named, not guessed", () => {
  const row: VerdictRow = { taskId: "W1-T998", headSha: "sha998", armedTs: "2025-12-31T23:50:00.000Z", verdictClass: null, classifyWhy: "fixture: no review.posted line" };
  const report = verdictCalibrationReport([row], "");
  assert.equal(report.unmeasurable.length, 1);
  assert.equal(report.unmeasurable[0].why, "fixture: no review.posted line");
});

test("gitReadError degrades EVERY row to UNMEASURABLE, never a partial/guessed search over broken history", () => {
  const rows: VerdictRow[] = [
    { taskId: "W1-T1", headSha: "s1", armedTs: "2026-01-01T00:00:00.000Z", verdictClass: "full-pass" },
    { taskId: "W1-T2", headSha: "s2", armedTs: "2026-01-01T00:00:00.000Z", verdictClass: "keyword-floor" },
  ];
  const report = verdictCalibrationReport(rows, "irrelevant", { gitReadError: "shallow clone" });
  assert.equal(report.unmeasurable.length, 2);
  for (const u of report.unmeasurable) assert.match(u.why, /git history unavailable: shallow clone/);
  assert.equal(report.classes.every((c) => c.total === 0), true);
});

test("the attribution policy (window + overlap rule) travels with the report", () => {
  const report = verdictCalibrationReport([], "");
  assert.equal(report.policy.windowDays, ATTRIBUTION_POLICY.windowDays);
  assert.ok(report.policy.overlapRuleDescription.length > 0);
  assert.equal(report.minPopulationFloor, MIN_POPULATION_FLOOR);
});

test("a synthetic PR-<n> task id locates its merge via GitHub's own (#n) citation, never the literal string PR-<n>", () => {
  const row: VerdictRow = { taskId: "PR-970", headSha: "sha970", armedTs: "2025-12-31T23:50:00.000Z", verdictClass: "full-pass" };
  const report = verdictCalibrationReport(
    [row],
    dumpOf([{ sha: MERGE_SHA, ts: "2026-01-01T00:00:00+00:00", subject: "fix(console): tidy the panel (#970)", files: ["a.ts"] }]),
  );
  assert.equal(report.unmeasurable.length, 0, "the merge must be found via the (#970) citation");
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fullPass.total, 1);
});

// ── (iii) the real reader + the CLI shell ───────────────────────────────────────────────────

function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...extraEnv },
  });
}

test("defaultVerdictCalibrationGitLog: a SHALLOW clone is refused by name", () => {
  const src = mkdtempSync(join(tmpdir(), "rmd-verdict-cal-shallow-src-"));
  const dest = join(src, "shallow-clone");
  try {
    git(["init", "-q", "-b", "main"], src);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"], src);
    git(["clone", "-q", "--depth", "1", `file://${src}`, dest], src);
    assert.throws(() => defaultVerdictCalibrationGitLog(dest), /shallow/);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("defaultVerdictCalibrationGitLog: an unusable git dir throws rather than an empty dump", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-verdict-cal-nonrepo-"));
  try {
    writeFileSync(join(dir, ".git"), "gitdir: /nonexistent-xyzzy-gitdir\n", "utf8");
    assert.throws(() => defaultVerdictCalibrationGitLog(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Builds a scratch repo with a "merge" commit citing `taskId` and a same-file fix commit two
 *  days later, plus a fabricated `origin/main` tracking ref (no real remote needed —
 *  `defaultVerdictCalibrationGitLog` always reads `origin/main`, exactly like
 *  `defaultMergeEvidenceLog` does for the sibling lint-plan verb). */
function buildFixtureRepo(taskId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-verdict-cal-repo-"));
  git(["init", "-q", "-b", "main"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"], dir);
  writeFileSync(join(dir, "x.ts"), "one\n");
  git(["add", "-A"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat(x): thing (${taskId}) (#900)`, "--date", "2026-01-01T00:00:00+00:00"], dir, {
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00",
  });
  writeFileSync(join(dir, "x.ts"), "one\ntwo\n");
  git(["add", "-A"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `fix(x): patch a regression (${taskId})`, "--date", "2026-01-03T00:00:00+00:00"], dir, {
    GIT_COMMITTER_DATE: "2026-01-03T00:00:00+00:00",
  });
  git(["update-ref", "refs/remotes/origin/main", "main"], dir);
  return dir;
}

test("defaultVerdictCalibrationGitLog: the REAL reader over a real repo yields a parseable dump naming the fixture task", () => {
  const dir = buildFixtureRepo("W1-T900");
  try {
    const { dump, ref } = defaultVerdictCalibrationGitLog(dir);
    assert.equal(ref, "origin/main");
    assert.ok(dump.includes("\x02"), "dump must be \\x02-delimited");
    const events = parseGitEventDump(dump);
    assert.ok(events.some((e) => e.subject.includes("W1-T900")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verdictCalibrationCommand: refuses an unknown flag, spawning nothing", () => {
  const realErr = console.error;
  console.error = () => {};
  try {
    assert.equal(verdictCalibrationCommand(["--bogus"]), 2);
  } finally {
    console.error = realErr;
  }
});

test("verdictCalibrationCommand: with no opts.stateDir and an unreadable config, reports 'cannot resolve', never a throw", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-verdict-cal-cfg-bad-"));
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

    const code = verdictCalibrationCommand([]);

    assert.equal(code, 1);
    assert.match(errs.join("\n"), /rmd verdict-calibration: cannot resolve a state dir — unreadable config/);
  } finally {
    console.error = realErr;
    console.log = realLog;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

/** Builds a scratch repo with one commit per `taskIds` entry (each citing its own id, touching
 *  its own file), plus the fabricated `origin/main` tracking ref. */
function buildMultiFixtureRepo(taskIds: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-verdict-cal-multi-"));
  git(["init", "-q", "-b", "main"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"], dir);
  taskIds.forEach((taskId, i) => {
    const file = `f${i}.ts`;
    writeFileSync(join(dir, file), `${i}\n`);
    git(["add", "-A"], dir);
    const date = `2026-01-0${i + 1}T00:00:00+00:00`;
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat(x): thing ${i} (${taskId})`, "--date", date], dir, {
      GIT_COMMITTER_DATE: date,
    });
  });
  git(["update-ref", "refs/remotes/origin/main", "main"], dir);
  return dir;
}

test("verdictCalibrationCommand: AT the population floor prints real percentages, and an unattributable row lands in the UNMEASURABLE listing", () => {
  const ids = Array.from({ length: MIN_POPULATION_FLOOR }, (_, i) => `W1-T81${i}`);
  const repoDir = buildMultiFixtureRepo(ids);
  const stateDir = tmpStateDir("rmd-verdict-cal-cli-floor-");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    // Each fixture commit lands at 2026-01-0<i+1>T00:00:00+00:00 (buildMultiFixtureRepo) —
    // arming at the SAME instant satisfies locateMergeCommit's "at/after arm minus slack" floor.
    const lines = ids.flatMap((taskId, i) => [
      ledgerLine({ ts: `2026-01-0${i + 1}T00:00:00.000Z`, step: "automerge.armed", task_id: taskId, head_sha: `sha${i}` }),
      ledgerLine({ ts: `2026-01-0${i + 1}T00:00:00.000Z`, step: "review.posted", task_id: taskId, head_sha: `sha${i}`, capped: false, floor_degraded: false }),
    ]);
    // One extra armed row citing a task id absent from the fixture repo's history entirely —
    // must surface in the UNMEASURABLE listing, never silently dropped.
    lines.push(
      ledgerLine({ ts: "2025-12-30T23:50:00.000Z", step: "automerge.armed", task_id: "W1-T999-missing", head_sha: "shamissing" }),
      ledgerLine({ ts: "2025-12-30T23:50:00.000Z", step: "review.posted", task_id: "W1-T999-missing", head_sha: "shamissing", capped: false, floor_degraded: false }),
    );
    writeGzArchive(stateDir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz", lines);

    const code = verdictCalibrationCommand([], { stateDir, cwd: repoDir });
    assert.equal(code, 0);
    const out = logs.join("\n");
    assert.match(out, new RegExp(`full PASS\\s+n=${MIN_POPULATION_FLOOR} — revert rate 0\\.0% \\(0/${MIN_POPULATION_FLOOR}\\), follow-up-fix rate 0\\.0% \\(0/${MIN_POPULATION_FLOOR}\\)`));
    assert.match(out, /unmeasurable: 1 row\(s\)/);
    assert.match(out, /W1-T999-missing/);
  } finally {
    console.log = realLog;
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("verdictCalibrationCommand: a git-history read failure still prints a report, naming git history UNAVAILABLE", () => {
  const stateDir = tmpStateDir("rmd-verdict-cal-cli-giterr-");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    writeGzArchive(stateDir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz", [
      ledgerLine({ ts: "2025-12-31T23:50:00.000Z", step: "automerge.armed", task_id: "W1-T900", head_sha: "deadbeef" }),
      ledgerLine({ ts: "2025-12-31T23:50:00.000Z", step: "review.posted", task_id: "W1-T900", head_sha: "deadbeef", capped: false, floor_degraded: false }),
    ]);
    const nonexistentCwd = join(tmpdir(), "rmd-verdict-cal-nonexistent-xyz-does-not-exist");

    const code = verdictCalibrationCommand([], { stateDir, cwd: nonexistentCwd });
    assert.equal(code, 0, "an unreadable git history must degrade to UNMEASURABLE, never crash the command");
    const out = logs.join("\n");
    assert.match(out, /git history: UNAVAILABLE/);
    assert.match(out, /unmeasurable: 1 row\(s\)/);
    assert.match(out, /git history unavailable/);
  } finally {
    console.log = realLog;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("verdictCalibrationCommand: end-to-end over a real repo — joins the ledger to git reality and prints the figures", () => {
  const repoDir = buildFixtureRepo("W1-T900");
  const stateDir = tmpStateDir("rmd-verdict-cal-cli-");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    writeGzArchive(stateDir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz", [
      ledgerLine({ ts: "2025-12-31T23:50:00.000Z", step: "automerge.armed", task_id: "W1-T900", head_sha: "deadbeef" }),
      ledgerLine({ ts: "2025-12-31T23:50:00.000Z", step: "review.posted", task_id: "W1-T900", head_sha: "deadbeef", capped: false, floor_degraded: false }),
    ]);

    const code = verdictCalibrationCommand([], { stateDir, cwd: repoDir });
    assert.equal(code, 0);
    const out = logs.join("\n");
    assert.match(out, /attribution policy: window 14d/);
    assert.match(out, /full PASS/);
    assert.match(out, /reverted 0\/1, follow-up-fixed 1\/1/, "the fixture's fix-typed commit must have joined via file overlap or task-id citation");
    assert.match(out, /unmeasurable: none/);
  } finally {
    console.log = realLog;
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
