/**
 * W1-T6301 — verdict calibration indexes commits by cited task ONCE per report. The live daemon
 * profile caught `verdictCalibrationReport` at 186 s, nearly all of it `citesTaskId` compiling a
 * fresh RegExp for every (row, commit, form). These two tests pin the fix from both sides: the
 * compile count is bounded (not rows × commits), and every row's merge, revert and follow-up
 * answer is identical to the per-commit scan it replaced — an in-test copy of that scan is the
 * oracle, and a hand-written outcome table proves the fixture actually exercises each edge.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ATTRIBUTION_POLICY,
  CITATION_SEPARATOR_RE,
  CITATION_LEFT_RE,
  CITATION_RIGHT_RE,
  CITATION_RUN_RE,
  parseGitEventDump,
  verdictCalibrationReport,
  type GitCommitEvent,
  type VerdictRow,
} from "../src/lib/verdict-calibration.js";

interface FixtureCommit {
  sha: string;
  ts: string;
  subject: string;
  body?: string;
  files?: string[];
}

function dumpOf(commits: FixtureCommit[]): string {
  return commits
    .map((c) => `\x02${c.sha}\x00${c.ts}\x00${c.subject}\x00${c.body ?? ""}\x01\n${(c.files ?? []).join("\n")}\n`)
    .join("");
}

function row(taskId: string, armedTs: string): VerdictRow {
  return { taskId, headSha: `head-${taskId}`, armedTs, lane: "review", verdictClass: "full-pass" };
}

// ── The OLD per-commit scan, copied verbatim from origin/main before W1-T6301 (the oracle) ────

function oldEscapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function oldForms(taskId: string): string[] {
  const forms = [taskId];
  const m = /^PR-(\d+)$/i.exec(taskId);
  if (m) forms.push(`#${m[1]}`);
  return forms;
}
function oldCites(event: GitCommitEvent, taskId: string): boolean {
  const subject = ` ${event.subject.toLowerCase()} `;
  const body = ` ${event.body.toLowerCase()} `;
  return oldForms(taskId).some((form) => {
    const re = new RegExp(`[(\\s,:]${oldEscapeRegExp(form.toLowerCase())}[)\\s,:.]`);
    return re.test(subject) || re.test(body);
  });
}
const SLACK_MS = 60 * 60 * 1000;
function oldLocate(commits: readonly GitCommitEvent[], taskId: string, armedTs: string): GitCommitEvent | undefined {
  const floorMs = new Date(armedTs).getTime() - SLACK_MS;
  return commits
    .filter((c) => oldCites(c, taskId))
    .filter((c) => new Date(c.ts).getTime() >= floorMs)
    .sort((a, b) => a.ts.localeCompare(b.ts))[0];
}
function oldShaNames(candidate: string, mergeSha: string): boolean {
  const a = candidate.toLowerCase();
  const b = mergeSha.toLowerCase();
  return a.length >= 7 && b.length >= 7 && (a === b || b.startsWith(a) || a.startsWith(b));
}
function oldReverted(commits: readonly GitCommitEvent[], merge: GitCommitEvent, taskId: string, windowDays: number): boolean {
  const mergedMs = new Date(merge.ts).getTime();
  const windowEndMs = mergedMs + windowDays * 24 * 60 * 60 * 1000;
  return commits.some((c) => {
    const ts = new Date(c.ts).getTime();
    if (!(ts > mergedMs && ts <= windowEndMs)) return false;
    const bodyMatch = /This reverts commit\s+([0-9a-f]{7,40})/i.exec(c.body);
    if (bodyMatch && oldShaNames(bodyMatch[1]!, merge.sha)) return true;
    return /^revert\b/i.test(c.subject.trim()) && oldCites(c, taskId);
  });
}
function oldOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(b);
  return a.some((f) => set.has(f));
}
function oldFixed(commits: readonly GitCommitEvent[], merge: GitCommitEvent, taskId: string, windowDays: number): boolean {
  const mergedMs = new Date(merge.ts).getTime();
  const windowEndMs = mergedMs + windowDays * 24 * 60 * 60 * 1000;
  return commits.some((c) => {
    if (!/^fix(\(|:)/i.test(c.subject.trim())) return false;
    const ts = new Date(c.ts).getTime();
    if (!(ts > mergedMs && ts <= windowEndMs)) return false;
    return oldOverlap(c.files, merge.files) || oldCites(c, taskId);
  });
}

/** What the report says about ONE row: measurable (merge located) or not, reverted, fixed. */
function reportOutcome(r: VerdictRow, dump: string): { merged: boolean; reverted: boolean; fixed: boolean } {
  const rep = verdictCalibrationReport([r], dump, { minPopulationFloor: 1 });
  const fp = rep.classes.find((c) => c.verdictClass === "full-pass")!;
  return { merged: fp.total === 1, reverted: fp.revertedCount === 1, fixed: fp.followupFixedCount === 1 };
}

function oldOutcome(r: VerdictRow, commits: readonly GitCommitEvent[]): { merged: boolean; reverted: boolean; fixed: boolean } {
  const merge = oldLocate(commits, r.taskId, r.armedTs);
  if (!merge) return { merged: false, reverted: false, fixed: false };
  return {
    merged: true,
    reverted: oldReverted(commits, merge, r.taskId, ATTRIBUTION_POLICY.windowDays),
    fixed: oldFixed(commits, merge, r.taskId, ATTRIBUTION_POLICY.windowDays),
  };
}

test("W1-T6301: a calibration report does not rebuild a citation regex per row per commit", () => {
  const TASKS = 40;
  const ROWS_PER_TASK = 5;
  const commits: FixtureCommit[] = [];
  for (let t = 0; t < TASKS; t++) {
    const day = String(1 + (t % 28)).padStart(2, "0");
    commits.push({ sha: `${t.toString(16).padStart(8, "a")}m`, ts: `2026-03-${day}T12:00:00Z`, subject: `feat: thing ${t} (W1-T${9000 + t})`, files: [`src/f${t}.ts`] });
    commits.push({ sha: `${t.toString(16).padStart(8, "b")}x`, ts: `2026-03-${day}T13:00:00Z`, subject: `chore: unrelated ${t}`, body: `touches nothing cited`, files: [`docs/n${t}.md`] });
    commits.push({ sha: `${t.toString(16).padStart(8, "c")}f`, ts: `2026-03-${day}T14:00:00Z`, subject: `fix: patch ${t}`, body: `Remudero-Task: W1-T${9000 + t}`, files: [`src/g${t}.ts`] });
  }
  const rows: VerdictRow[] = [];
  for (let t = 0; t < TASKS; t++) {
    const day = String(1 + (t % 28)).padStart(2, "0");
    for (let k = 0; k < ROWS_PER_TASK; k++) rows.push(row(`W1-T${9000 + t}`, `2026-03-${day}T11:59:00Z`));
  }
  const dump = dumpOf(commits);

  const RealRegExp = globalThis.RegExp;
  let constructed = 0;
  const Counting: RegExpConstructor = new Proxy(RealRegExp, {
    construct(target, args, newTarget): object {
      constructed += 1;
      return Reflect.construct(target, args, newTarget === Counting ? target : newTarget) as object;
    },
    apply(target, thisArg, args): unknown {
      constructed += 1;
      return Reflect.apply(target, thisArg, args);
    },
  });
  let report;
  try {
    globalThis.RegExp = Counting;
    report = verdictCalibrationReport(rows, dump);
  } finally {
    globalThis.RegExp = RealRegExp;
  }

  // Non-vacuous: every row really joined to a merge and found its follow-up fix.
  const fp = report.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.equal(fp.total, rows.length, "every row must locate its merge commit");
  assert.equal(fp.followupFixedCount, rows.length, "every row must find its citing follow-up fix");
  assert.equal(report.unmeasurable.length, 0);

  // The per-commit scan built one regex per (row, commit, form): 200 × 120 = 24,000 here. The
  // indexed report may compile at most one per distinct task id per form, and needs none at all
  // for delimiter-free ids.
  const rowsTimesCommits = rows.length * commits.length;
  assert.ok(constructed <= TASKS * 2, `expected at most ${TASKS * 2} RegExp constructions, saw ${constructed} (rows × commits = ${rowsTimesCommits})`);
});

test("W1-T6301: indexed merge, revert and follow-up answers match the per-commit scan", () => {
  const MERGE_A = "aaaaaaa1000000000000000000000000000000a1";
  const SKEW_EARLY = "bbbbbbb1000000000000000000000000000000b1";
  const SKEW_MERGE = "bbbbbbb2000000000000000000000000000000b2";
  const TIE_FIRST = "ccccccc1000000000000000000000000000000c1";
  const TIE_SECOND = "ccccccc2000000000000000000000000000000c2";
  const commits: FixtureCommit[] = [
    // W1-T1: merged, fixed by citation, reverted by `This reverts commit <sha>`.
    { sha: MERGE_A, ts: "2026-01-01T10:00:00Z", subject: "feat: thing (W1-T1)", files: ["src/a.ts"] },
    { sha: "d000001", ts: "2026-01-03T10:00:00Z", subject: "fix: follow-up", body: "Remudero-Task: W1-T1.", files: ["src/z.ts"] },
    { sha: "d000002", ts: "2026-01-05T10:00:00Z", subject: "chore: undo", body: `This reverts commit ${MERGE_A}.`, files: ["src/a.ts"] },
    // W1-T10 must never be read as a W1-T1 citation (prefix), nor the reverse.
    { sha: "d000003", ts: "2026-01-02T10:00:00Z", subject: "feat: ten (W1-T10)", files: ["src/ten.ts"] },
    // PR-42: cited only as GitHub's (#42); fixed by file overlap with no citation.
    { sha: "e000001", ts: "2026-01-02T09:00:00Z", subject: "feat: other (#42)", files: ["src/b.ts"] },
    { sha: "e000002", ts: "2026-01-04T09:00:00Z", subject: "fix(b): patch", files: ["src/b.ts"] },
    // W1-T3: preceded by '.', or run on into 'x' — neither is a citation → unmeasurable.
    { sha: "f000001", ts: "2026-01-02T08:00:00Z", subject: "docs: see foo.W1-T3 and :W1-T3x", files: ["README.md"] },
    // W1-T4: clock skew — 10:00 is outside the 60-min slack of the 12:00 arm, 11:30 is inside.
    { sha: SKEW_EARLY, ts: "2026-02-01T10:00:00Z", subject: "chore: prep, W1-T4", files: ["src/c.ts"] },
    { sha: SKEW_MERGE, ts: "2026-02-01T11:30:00Z", subject: "feat: four: W1-T4", files: ["src/d.ts"] },
    { sha: "g000001", ts: "2026-02-03T10:00:00Z", subject: "chore: undo four", body: `This reverts commit ${SKEW_MERGE.slice(0, 12)}`, files: [] },
    // W1-T5: only citing commit is one second outside the slack → unmeasurable.
    { sha: "h000001", ts: "2026-02-10T10:59:59Z", subject: "feat: five (W1-T5)", files: ["src/e.ts"] },
    // W1-T6: revert and fix both land OUTSIDE the 14-day window; an in-window fix touches nothing.
    { sha: "i000001", ts: "2026-03-01T10:00:00Z", subject: "feat: six (W1-T6)", files: ["src/f.ts"] },
    { sha: "i000002", ts: "2026-03-02T10:00:00Z", subject: "fix: unrelated", files: ["src/q.ts"] },
    { sha: "i000003", ts: "2026-03-20T10:00:00Z", subject: 'Revert "feat: six (W1-T6)"', files: ["src/f.ts"] },
    { sha: "i000004", ts: "2026-03-20T11:00:00Z", subject: "fix: late (W1-T6)", files: ["src/f.ts"] },
    // w1-t7, lowercase in the subject, '(' must not close a citation: "W1-T7(" is NOT one.
    { sha: "j000001", ts: "2026-03-05T10:00:00Z", subject: "feat: seven (w1-t7)", files: ["src/g.ts"] },
    { sha: "j000002", ts: "2026-03-06T10:00:00Z", subject: "fix: W1-T7(again)", files: ["src/h.ts"] },
    // W1.T8: a form containing a delimiter — must take the regex fallback and still match.
    { sha: "k000001", ts: "2026-03-07T10:00:00Z", subject: "feat: eight (w1.t8)", files: ["src/i.ts"] },
    // W1-T9: reverted by a Revert-typed subject citing the task id, no sha in the body.
    { sha: "l000001", ts: "2026-03-08T10:00:00Z", subject: "feat: nine, W1-T9", files: ["src/j.ts"] },
    { sha: "l000002", ts: "2026-03-09T10:00:00Z", subject: 'Revert "feat: nine (W1-T9)"', files: ["src/j.ts"] },
    // W1-T11: two citing commits at the SAME ts — dump order breaks the tie; the revert names
    // the first, so choosing the second would flip the answer.
    { sha: TIE_FIRST, ts: "2026-03-10T10:00:00Z", subject: "feat: eleven (W1-T11)", files: ["src/k.ts"] },
    { sha: TIE_SECOND, ts: "2026-03-10T10:00:00Z", subject: "chore: eleven again (W1-T11)", files: ["src/l.ts"] },
    { sha: "m000001", ts: "2026-03-11T10:00:00Z", subject: "chore: back out", body: `This reverts commit ${TIE_FIRST}`, files: [] },
  ];
  const rows: VerdictRow[] = [
    row("W1-T1", "2026-01-01T09:55:00Z"),
    row("W1-T10", "2026-01-02T09:55:00Z"),
    row("PR-42", "2026-01-02T08:59:00Z"),
    row("W1-T3", "2026-01-02T07:59:00Z"),
    row("W1-T4", "2026-02-01T12:00:00Z"),
    row("W1-T5", "2026-02-10T12:00:00Z"),
    row("W1-T6", "2026-03-01T09:59:00Z"),
    row("W1-T7", "2026-03-05T09:59:00Z"),
    row("W1.T8", "2026-03-07T09:59:00Z"),
    row("W1-T9", "2026-03-08T09:59:00Z"),
    row("W1-T11", "2026-03-10T09:59:00Z"),
  ];
  // The four character classes the index tokenizes by, each driven on both arms: '(' opens a
  // citation but never closes one, '.' closes one but never opens one.
  assert.equal(CITATION_LEFT_RE.test("("), true);
  assert.equal(CITATION_LEFT_RE.test("."), false);
  assert.equal(CITATION_RIGHT_RE.test("."), true);
  assert.equal(CITATION_RIGHT_RE.test("("), false);
  assert.equal(CITATION_SEPARATOR_RE.test("w1.t8"), true);
  assert.equal(CITATION_SEPARATOR_RE.test("w1-t8"), false);
  CITATION_RUN_RE.lastIndex = 0;
  assert.equal(CITATION_RUN_RE.exec(" (w1-t8), ")?.[0], "w1-t8");
  CITATION_RUN_RE.lastIndex = 0;
  assert.equal(CITATION_RUN_RE.exec(" (),:. "), null);
  CITATION_RUN_RE.lastIndex = 0;

  const dump = dumpOf(commits);
  const parsed = parseGitEventDump(dump);
  assert.equal(parsed.length, commits.length, "fixture dump must parse every commit");

  // The known outcomes — proves the fixture exercises each edge, so the oracle comparison
  // below cannot pass by comparing nothing.
  const expected: Record<string, { merged: boolean; reverted: boolean; fixed: boolean }> = {
    "W1-T1": { merged: true, reverted: true, fixed: true },
    "W1-T10": { merged: true, reverted: false, fixed: false },
    "PR-42": { merged: true, reverted: false, fixed: true },
    "W1-T3": { merged: false, reverted: false, fixed: false },
    "W1-T4": { merged: true, reverted: true, fixed: false },
    "W1-T5": { merged: false, reverted: false, fixed: false },
    "W1-T6": { merged: true, reverted: false, fixed: false },
    "W1-T7": { merged: true, reverted: false, fixed: false },
    "W1.T8": { merged: true, reverted: false, fixed: false },
    "W1-T9": { merged: true, reverted: true, fixed: false },
    "W1-T11": { merged: true, reverted: true, fixed: false },
  };
  for (const r of rows) {
    const old = oldOutcome(r, parsed);
    assert.deepEqual(old, expected[r.taskId], `oracle outcome for ${r.taskId}`);
    assert.deepEqual(reportOutcome(r, dump), old, `indexed outcome for ${r.taskId} must match the per-commit scan`);
  }

  // And the whole multi-row report, as one value.
  const measured = rows.filter((r) => expected[r.taskId]!.merged);
  const full = verdictCalibrationReport(rows, dump, { minPopulationFloor: 1 });
  const fp = full.classes.find((c) => c.verdictClass === "full-pass")!;
  assert.deepEqual(
    {
      total: fp.total,
      revertedCount: fp.revertedCount,
      followupFixedCount: fp.followupFixedCount,
      taskIds: fp.taskIds,
      unmeasurable: full.unmeasurable.map((u) => [u.taskId, u.cause]),
      armsSeen: full.armsSeen,
      armsClassified: full.armsClassified,
    },
    {
      total: measured.length,
      revertedCount: rows.filter((r) => oldOutcome(r, parsed).reverted).length,
      followupFixedCount: rows.filter((r) => oldOutcome(r, parsed).fixed).length,
      taskIds: measured.map((r) => r.taskId),
      unmeasurable: [
        ["W1-T3", "merge-sha-unrecoverable"],
        ["W1-T5", "merge-sha-unrecoverable"],
      ],
      armsSeen: rows.length,
      armsClassified: measured.length,
    },
  );
});
