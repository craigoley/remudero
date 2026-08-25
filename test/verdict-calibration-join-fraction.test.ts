/**
 * W1-T2258 — THE CALIBRATION VERB REPORTS ONE UNMEASURABLE COUNT AND HAS TWO, AND HIDES THE
 * LARGER: `mineVerdictRows` (lib/verdict-calibration.ts:137, pre-fix) dropped an `automerge.armed`
 * row with no `head_sha` BEFORE the join, with no `classifyWhy` and no entry in the unmeasurable
 * list — silently, and by LANE, not by sample: only the review lane's own arm helper
 * (`armIfVerdictPermits`) ever put `head_sha` on its row; every other lane's arm (run-task's
 * deferred at-verdict arm, and every `armAndLogOutcome` caller — dep-review, retro, triage, plan,
 * approve, sweep) systematically did not, so the published class rates were rates over
 * review-lane arms presented as rates over all arms.
 *
 * This suite proves the seven acceptance criteria, matching the module's own seams:
 *   (i)    mineVerdictRows — a head-less row is now COUNTED, with a written reason.
 *   (ii)   verdictCalibrationReport — the denominator (armsSeen/armsClassified) is named.
 *   (iii)  verdictCalibrationReport — the unmeasurable count is broken out BY CAUSE.
 *   (iv)   verdictCalibrationReport — a class rate is LABELLED by lane, and refuses to blend
 *          more than one lane into one published rate.
 *   (v)    run-task.ts — the non-review arm paths put the head sha they already hold (or can
 *          recover from the PR that already exists) onto the row they write.
 *   (vi)   mineVerdictRows / verdictCalibrationReport — a head-less row is NEVER admitted to the
 *          join by inferring or defaulting the key, even when doing so would be unambiguous.
 *   (vii)  the verb stays READ-ONLY, and MIN_POPULATION_FLOOR is untouched.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import {
  MIN_POPULATION_FLOOR,
  mineVerdictRows,
  verdictCalibrationReport,
  type VerdictRow,
} from "../src/lib/verdict-calibration.js";
import { armAndLogOutcome } from "../src/run-task.js";

function tmpStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeGzArchive(stateDir: string, name: string, lines: string[]): void {
  writeFileSync(join(stateDir, name), gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8")));
}

function ledgerLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

/** The exact `\x02%H%x00%cI%x00%s%x00%b%x01` + `--name-only` wire shape
 *  `defaultVerdictCalibrationGitLog` produces — see test/verdict-calibration.test.ts's own
 *  `dumpOf` for the precedent this mirrors. */
function dumpOf(commits: Array<{ sha: string; ts: string; subject: string; files?: string[] }>): string {
  return commits.map((c) => `\x02${c.sha}\x00${c.ts}\x00${c.subject}\x00\x01\n${(c.files ?? []).join("\n")}\n`).join("");
}

const SRC = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
const LIB_SRC = readFileSync(new URL("../src/lib/verdict-calibration.ts", import.meta.url), "utf8");

// ── (i) mineVerdictRows: a head-less row is COUNTED, not silently dropped ──────────────────────

test("mineVerdictRows: an automerge.armed row with a real task id and timestamp but NO head_sha is COUNTED, carrying a written reason — never dropped in silence", () => {
  const dir = tmpStateDir("rmd-verdict-join-nohead-");
  try {
    writeGzArchive(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz", [
      // The LANE SPLIT shape this task measured: run-task.ts's at-verdict emitter (lane
      // "run-task") wrote no head_sha at all before this task's fix.
      ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T900", lane: "run-task" }),
    ]);
    const { rows } = mineVerdictRows(dir);
    assert.equal(rows.length, 1, "the row is COUNTED — the pre-fix behaviour dropped it to zero rows");
    assert.equal(rows[0].taskId, "W1-T900");
    assert.equal(rows[0].headSha, undefined, "no head_sha on the source line ⇒ none on the row — never inferred");
    assert.equal(rows[0].verdictClass, null, "unclassifiable — a row with no head can never be joined");
    assert.equal(rows[0].unjoinableCause, "no-head-sha", "told apart from every other unmeasurable cause");
    assert.match(rows[0].classifyWhy ?? "", /head_sha/, "the written reason names what is actually missing");
    assert.equal(rows[0].lane, "run-task", "the row's own lane travels with it, for the report's lane label");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mineVerdictRows: a genuinely unidentifiable line (no task id at all) still drops silently — the ONE continue this task leaves alone (design note (vii))", () => {
  const dir = tmpStateDir("rmd-verdict-join-malformed-");
  try {
    writeGzArchive(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz", [
      ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "automerge.armed", head_sha: "deadbeef" }), // no task_id
    ]);
    const { rows } = mineVerdictRows(dir);
    assert.deepEqual(rows, [], "no identity to key a row by — correctly untraceable, not this task's defect");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (ii)/(iii) verdictCalibrationReport: the denominator, and the cause breakdown ──────────────

test("verdictCalibrationReport: states how many arms it saw and how many it classified, and breaks the unmeasurable count out BY CAUSE — 'no head sha' is never merged into 'merge sha unrecoverable' or 'no review.posted'", () => {
  const MERGE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const rows: VerdictRow[] = [
    // cause: no-head-sha (mineVerdictRows' own shape)
    { taskId: "W1-T1", armedTs: "2026-01-01T00:00:00.000Z", verdictClass: null, unjoinableCause: "no-head-sha", classifyWhy: "no head_sha on the row" },
    // cause: no-review-posted (mineVerdictRows' pre-existing shape)
    { taskId: "W1-T2", headSha: "sha2", armedTs: "2026-01-01T00:00:00.000Z", verdictClass: null, unjoinableCause: "no-review-posted", classifyWhy: "no matching review.posted line" },
    // cause: merge-sha-unrecoverable (verdictCalibrationReport's own join, against git history that cites nothing)
    { taskId: "W1-T3", headSha: "sha3", armedTs: "2026-01-01T00:00:00.000Z", verdictClass: "full-pass", lane: "review" },
    // classifies AND locates a merge — reaches `classes`
    { taskId: "W1-T900", headSha: "sha900", armedTs: "2026-01-01T00:00:00.000Z", verdictClass: "full-pass", lane: "review" },
  ];
  const dump = dumpOf([{ sha: MERGE_SHA, ts: "2026-01-01T00:00:00+00:00", subject: "feat(x): thing (W1-T900) (#900)", files: [] }]);

  const report = verdictCalibrationReport(rows, dump);

  assert.equal(report.armsSeen, 4, "every row this report was handed — the denominator, named");
  assert.equal(report.armsClassified, 1, "only W1-T900 reached a verdict class AND a locatable merge commit");
  assert.equal(report.unmeasurable.length, 3);
  assert.equal(report.armsSeen, report.armsClassified + report.unmeasurable.length, "every row lands in exactly one bucket");

  assert.deepEqual(report.unmeasurableByCause, {
    "no-head-sha": 1,
    "no-review-posted": 1,
    "merge-sha-unrecoverable": 1,
    "git-history-unavailable": 0,
  });

  const byTask = new Map(report.unmeasurable.map((u) => [u.taskId, u]));
  assert.equal(byTask.get("W1-T1")?.cause, "no-head-sha");
  assert.equal(byTask.get("W1-T1")?.headSha, undefined, "never inferred — the unmeasurable row carries no head either");
  assert.equal(byTask.get("W1-T2")?.cause, "no-review-posted");
  assert.equal(byTask.get("W1-T3")?.cause, "merge-sha-unrecoverable");
  assert.match(byTask.get("W1-T3")?.why ?? "", /merge sha could not be recovered/);
});

test("verdictCalibrationReport: gitReadError degrades every row to its OWN cause (git-history-unavailable), never conflated with the other three", () => {
  const rows: VerdictRow[] = [{ taskId: "W1-T1", headSha: "s1", armedTs: "2026-01-01T00:00:00.000Z", verdictClass: "full-pass" }];
  const report = verdictCalibrationReport(rows, "irrelevant", { gitReadError: "shallow clone" });
  assert.deepEqual(report.unmeasurableByCause, {
    "no-head-sha": 0,
    "no-review-posted": 0,
    "merge-sha-unrecoverable": 0,
    "git-history-unavailable": 1,
  });
});

// ── (iv) a class rate is LABELLED by lane, and refuses to blend more than one lane ─────────────

test("verdictCalibrationReport: a class populated ENTIRELY from the review lane prints a real rate, labelled 'review'", () => {
  const commits = Array.from({ length: MIN_POPULATION_FLOOR }, (_, i) => ({
    sha: `${i}`.repeat(40).slice(0, 40),
    ts: "2026-01-01T00:00:00+00:00",
    subject: `feat(x): thing (W1-T7${i})`,
    files: [],
  }));
  const rows: VerdictRow[] = commits.map((c, i) => ({
    taskId: `W1-T7${i}`,
    headSha: `sha7${i}`,
    armedTs: "2025-12-31T23:50:00.000Z",
    verdictClass: "full-pass",
    lane: "review",
  }));
  const report = verdictCalibrationReport(rows, dumpOf(commits));
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fullPass.total, MIN_POPULATION_FLOOR);
  assert.equal(fullPass.lanes, "review");
  assert.notEqual(fullPass.revertRate, null, "a single-lane population AT the floor prints a real rate");
  assert.equal(fullPass.rateRefusedReason, undefined);
});

test("FALSIFIER: the SAME total (at the population floor) refuses the rate the instant a SECOND lane enters the population — never a fleet-wide blend (W1-T2258 design note (v))", () => {
  const commits = Array.from({ length: MIN_POPULATION_FLOOR }, (_, i) => ({
    sha: `${i}`.repeat(40).slice(0, 40),
    ts: "2026-01-01T00:00:00+00:00",
    subject: `feat(x): thing (W1-T8${i})`,
    files: [],
  }));
  const rows: VerdictRow[] = commits.map((c, i) => ({
    taskId: `W1-T8${i}`,
    headSha: `sha8${i}`,
    armedTs: "2025-12-31T23:50:00.000Z",
    verdictClass: "full-pass",
    // ONE row's arm came from the sweep lane — everything else is identical to the passing
    // fixture immediately above (same total, same floor, same git history shape).
    lane: i === 0 ? "sweep" : "review",
  }));
  const report = verdictCalibrationReport(rows, dumpOf(commits));
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fullPass.total, MIN_POPULATION_FLOOR, "the population floor is unchanged — this is not a floor refusal");
  assert.equal(fullPass.revertRate, null, "a mixed-lane population REFUSES the rate — the honest presentation is per-lane, never blended");
  assert.equal(fullPass.followupFixRate, null);
  assert.equal(fullPass.rateRefusedReason, "mixed-lane-population", "told apart from a below-floor refusal");
  assert.equal(fullPass.lanes, "review, sweep", "the lanes are NAMED, not merely hidden behind a null");
});

test("verdictCalibrationReport: a class below the population floor still refuses for the ORIGINAL reason, not relabelled as a lane mix", () => {
  const rows: VerdictRow[] = [
    { taskId: "W1-T1", headSha: "s1", armedTs: "2025-12-31T23:50:00.000Z", verdictClass: "full-pass", lane: "review" },
  ];
  const dump = dumpOf([{ sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ts: "2026-01-01T00:00:00+00:00", subject: "feat(x): thing (W1-T1)", files: [] }]);
  const report = verdictCalibrationReport(rows, dump);
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fullPass.total, 1);
  assert.equal(fullPass.revertRate, null);
  assert.equal(fullPass.rateRefusedReason, "below-population-floor");
  assert.equal(fullPass.lanes, "review");
});

test("verdictCalibrationReport: an ABSENT lane (rows mined before W1-T449 added the field) reads as 'review' — the only lane capable of a classified row before this task, never blended by omission", () => {
  const commits = Array.from({ length: MIN_POPULATION_FLOOR }, (_, i) => ({
    sha: `${i}`.repeat(40).slice(0, 40),
    ts: "2026-01-01T00:00:00+00:00",
    subject: `feat(x): thing (W1-T6${i})`,
    files: [],
  }));
  const rows: VerdictRow[] = commits.map((c, i) => ({
    taskId: `W1-T6${i}`,
    headSha: `sha6${i}`,
    armedTs: "2025-12-31T23:50:00.000Z",
    verdictClass: "full-pass",
    // no `lane` at all — every fixture in the pre-existing test/verdict-calibration.test.ts
    // constructs VerdictRow this way, and must keep classifying exactly as before.
  }));
  const report = verdictCalibrationReport(rows, dumpOf(commits));
  const fullPass = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fullPass.lanes, "review");
  assert.notEqual(fullPass.revertRate, null, "backward-compatible with every pre-existing lane-less fixture");
});

// ── (v) the non-review arm paths put the head sha they already hold onto the row they write ────

test("armAndLogOutcome: an injected headSha rides onto the SAME row as head_sha — the field every non-review lane's write path now threads", () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const outcome = armAndLogOutcome(
    "https://github.com/craigoley/remudero/pull/900",
    "W1-T900",
    (step, extra) => void logs.push({ step, extra }),
    () => "armed",
    "sweep",
    "cafef00dcafef00dcafef00dcafef00dcafef00d",
  );
  assert.equal(outcome, "armed");
  const armed = logs.find((l) => l.step === "automerge.armed");
  assert.equal(armed?.extra?.head_sha, "cafef00dcafef00dcafef00dcafef00dcafef00d");
});

test("armAndLogOutcome: an OMITTED headSha is simply absent from the row — never defaulted to null/empty, matching every pre-existing call site's behaviour", () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  armAndLogOutcome(
    "https://github.com/craigoley/remudero/pull/901",
    "W1-T901",
    (step, extra) => void logs.push({ step, extra }),
    () => "armed",
  );
  const armed = logs.find((l) => l.step === "automerge.armed");
  assert.equal("head_sha" in (armed?.extra ?? {}), false, "no head_sha key at all when the caller supplies none");
});

test("SITE dep-review and SITE sweep put the head sha they ALREADY HOLD (view.headRefOid / pr.headSha) onto the arm row — no new read needed", () => {
  assert.match(
    SRC,
    /armAndLogOutcome\(view\.url, taskId, log, deps\.arm, "operator", view\.headRefOid\)/,
    "dep-review: view.headRefOid is the SAME head its own review.posted line was keyed to",
  );
  const sweepArmAt = SRC.indexOf("arm: (pr) => {");
  assert.ok(sweepArmAt > 0, "the sweep arm effect site is gone — this test is stale");
  const sweepArmSite = SRC.slice(sweepArmAt, sweepArmAt + 1400);
  const laneAt = sweepArmSite.indexOf('"sweep",');
  const headShaAt = sweepArmSite.indexOf("pr.headSha,");
  assert.ok(laneAt > 0 && headShaAt > laneAt, "sweep: pr.headSha (OpenPrView) rides onto the row AFTER the \"sweep\" lane, as the 6th arg");
});

test("SITE run-task's deferred at-verdict arm (the LARGEST dropped population) puts head_sha on its row — review.headSha was already in scope, simply not put on the row", () => {
  const at = SRC.indexOf('log("automerge.armed", {\n      at: "verdict",');
  assert.ok(at > 0, "the at-verdict emitter is gone or reshaped — this test is stale");
  const site = SRC.slice(at, at + 250);
  assert.match(site, /head_sha: review\.headSha,/);
});

test("SITE retro/triage/plan/approve recover a head sha from the PR that already exists (readHeadShaRest) and thread it into armAndLogOutcome — the 4 lanes with no headSha variable of their own", () => {
  for (const anchor of [
    "const armOutcome = armAndLogOutcome(prUrl, runId, log, undefined, undefined, armHeadSha);", // retro
    "const armOutcome = armAndLogOutcome(prUrl, taskId, log, undefined, undefined, armHeadSha);", // triage/plan (both, checked below)
    "const armOutcome = armAndLogOutcome(result.prUrl, `PR-${prNum}`, log, undefined, undefined, armHeadSha);", // approve
  ]) {
    const count = SRC.split(anchor).length - 1;
    assert.ok(count >= 1, `wiring not found (stale test): ${anchor}`);
  }
  // triage AND plan both use the identical taskId-keyed call — confirm both sites, not just one.
  assert.equal(
    SRC.split("const armOutcome = armAndLogOutcome(prUrl, taskId, log, undefined, undefined, armHeadSha);").length - 1,
    2,
    "triage and plan each recover and thread their own head sha",
  );
  assert.equal(
    SRC.split("armHeadSha = readHeadShaRest(prUrl)").length - 1,
    3,
    "retro, triage, and plan each attempt the live REST read (best-effort, wrapped)",
  );
  assert.match(SRC, /armHeadSha = readHeadShaRest\(result\.prUrl\)/, "approve recovers from result.prUrl");
});

// ── (vi) never admitted by inferring or defaulting the key ─────────────────────────────────────

test("mineVerdictRows: a head-less row is NEVER joined even when exactly one review.posted line exists for the same task id — no fallback join by task id alone", () => {
  const dir = tmpStateDir("rmd-verdict-join-noinfer-");
  try {
    writeGzArchive(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz", [
      // No head_sha on the armed row — the exact defect shape.
      ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "automerge.armed", task_id: "W1-T900", lane: "operator" }),
      // Exactly ONE review.posted line for this task — a lesser fix might be tempted to treat
      // this as unambiguous and join to it anyway. It must not.
      ledgerLine({ ts: "2026-01-01T00:00:00.000Z", step: "review.posted", task_id: "W1-T900", head_sha: "sha900", capped: false, floor_degraded: false }),
    ]);
    const { rows } = mineVerdictRows(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].headSha, undefined, "never inferred from the sole matching review.posted line");
    assert.equal(rows[0].verdictClass, null, "stays unclassified — a guessed join would silently read as 'full-pass'");
    assert.equal(rows[0].unjoinableCause, "no-head-sha");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verdictCalibrationReport: an unmeasurable row's headSha is reported exactly as mined — undefined stays undefined, never backfilled from the PR's current head or a git read", () => {
  const row: VerdictRow = { taskId: "W1-T900", armedTs: "2026-01-01T00:00:00.000Z", verdictClass: null, unjoinableCause: "no-head-sha", classifyWhy: "no head_sha on the row" };
  const report = verdictCalibrationReport([row], "");
  assert.equal(report.unmeasurable.length, 1);
  assert.equal(report.unmeasurable[0].headSha, undefined);
});

// ── (vii) the verb stays READ-ONLY, and the population floor is unchanged ──────────────────────

test("MIN_POPULATION_FLOOR is unchanged at 5 — not tuned to make a thinner population look publishable", () => {
  assert.equal(MIN_POPULATION_FLOOR, 5);
});

test("lib/verdict-calibration.ts writes no ledger line and executes nothing — READ-ONLY, per its own module doc ('v1 files nothing and proposes nothing')", () => {
  assert.doesNotMatch(LIB_SRC, /appendLedger\s*\(/, "no ledger append anywhere in this module");
  assert.doesNotMatch(LIB_SRC, /execFileSync\s*\(/, "no process spawn anywhere in this module");
  assert.doesNotMatch(LIB_SRC, /writeFileSync\s*\(/, "no filesystem write anywhere in this module");
});
