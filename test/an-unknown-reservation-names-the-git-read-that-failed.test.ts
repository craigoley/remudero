/**
 * test/an-unknown-reservation-names-the-git-read-that-failed.test.ts — W1-T9674.
 *
 * MEASURED 2026-10-15: #12011 was withheld twice with "id W1-T9645 reservation unreadable (UNKNOWN) — verdict
 * withheld" while refs/rmd-id/W1-T9645 existed and named its own branch. The reader knew which git call failed and
 * what git said; the status and the review.post_refused row dropped it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AcceptanceCriterion } from "#src/lib/plan.js";
import { failSummary, judgeReview, taskIdOwnershipFindings, unknownReservationReads, type TaskIdOwnershipFinding } from "#src/lib/review.js";
import { readReservationAnchors, readReservationAnchorsAsync } from "#src/lib/task-id-reservation.js";

const CLEAN_PLAN_LINT = { ran: true as const, label: "fixture", checked: 1, violations: [] };
const CRITERIA: AcceptanceCriterion[] = [{ claim: "the widget renders", proof: "the widget renders" }];
const REPORT = "REPORT\n- the widget renders.\nPR_URL: https://github.com/o/r/pull/7";
const HEAD = "plan-file-1792068079473";
const ID = "W1-T9645";
const SHARD = `plan/tasks.d/${ID}-a-baked-path-fix-is-recycled-in.yaml`;
const DIFF = [`diff --git a/${SHARD} b/${SHARD}`, `+++ b/${SHARD}`, "@@", `+- id: ${ID}`, '+  title: "t"'].join("\n");
const ANCHOR = "cbfc26fb6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GIT_SAID = `fatal: couldn't find remote ref refs/rmd-id/${ID}`;

type Answer = { status: number; stdout: string; stderr: string };
const listed: Answer = { status: 0, stdout: `${ANCHOR}\trefs/rmd-id/${ID}\n`, stderr: "" };
const holder = `rmd-id holder branch=${HEAD} pid=1 host=h started_at=2026-10-15T00%3A00%3A00.000Z source=automatic\n\0`;

/** A reservation reader whose ls-remote finds the anchor and whose `failing` verb answers with git's error. */
function gitAnswering(failing: "fetch" | "log" | "none") {
  return (args: string[]): Answer => {
    if (args[0] === "ls-remote") return listed;
    if (args[0] === failing) return { status: 128, stdout: "", stderr: `${GIT_SAID}\n` };
    return args[0] === "fetch" ? { status: 0, stdout: "", stderr: "" } : { status: 0, stdout: holder, stderr: "" };
  };
}

function verdictFor(failing: "fetch" | "log" | "none") {
  const reads = readReservationAnchors([ID], gitAnswering(failing));
  const noBaseline = mkdtempSync(join(tmpdir(), "rmd-t9674-"));
  try {
    const ownership = taskIdOwnershipFindings(DIFF, [{ id: ID, file: SHARD }], [], HEAD, noBaseline, () => reads);
    return judgeReview(CRITERIA, { planLint: CLEAN_PLAN_LINT, diff: DIFF, report: REPORT, headRefName: HEAD, reservationOwnership: ownership, baseTaskIdDeclarations: [] });
  } finally {
    rmSync(noBaseline, { recursive: true, force: true });
  }
}

const summaryOf = (reason: string, more: TaskIdOwnershipFinding[] = []): string =>
  failSummary([], false, false, false, 0, [], undefined, [], [], [], [{ id: ID, file: SHARD, kind: "unknown", reason }, ...more]);

test("W1-T9674: a failed anchor fetch withholds the review naming the fetch and what git said", () => {
  const v = verdictFor("fetch");
  assert.equal(v.summary, `remudero-review: FAIL — id ${ID} reservation unreadable (UNKNOWN): fetch failed — verdict withheld`);
  assert.deepEqual(v.taskIdOwnership, [{ id: ID, file: SHARD, kind: "unknown", reason: `fetch failed: ${GIT_SAID}` }]);
  assert.equal(v.taskIdOwnershipWithheld, v.summary);
});

test("W1-T9674: an unknown reservation read still withholds the verdict", () => {
  const owned = verdictFor("none");
  assert.deepEqual(owned.taskIdOwnership, [], "control: the same anchor read cleanly is owned by this head");
  assert.equal(owned.state, "success");
  for (const [failing, step] of [["fetch", "fetch failed"], ["log", "anchor log failed"]] as const) {
    const v = verdictFor(failing);
    assert.equal(v.state, "failure", `${failing}: never a pass`);
    assert.deepEqual(v.taskIdOwnership?.map((f) => f.kind), ["unknown"], `${failing}: never judged owned or foreign`);
    assert.equal(v.taskIdOwnershipWithheld, v.summary, `${failing}: withheld, not posted`);
    assert.match(v.summary, new RegExp(`reservation unreadable \\(UNKNOWN\\): ${step} — verdict withheld$`));
  }
});

test("W1-T9674: every unknown reason the review records names its step inside the status cap", () => {
  const steps: Array<[string, string]> = [
    ["ls-remote failed: fatal: unable to access origin", "ls-remote failed"],
    ["ls-remote failed: git ls-remote timed out after 600000ms and was killed. git said: connecting", "ls-remote failed (timed out)"],
    ["log failed: fatal: bad object", "anchor log failed"],
    ["head-ref-unavailable", "no head ref"],
    ["head-checkout-unavailable", "no head checkout"],
    ["base-unreadable: git ls-tree timed out after 150ms and was killed", "base read timed out"],
    ["baseline-unreadable: git show timed out after 150ms and was killed", "baseline read timed out"],
    ["no read", "no read"],
    ["  ", "no reason recorded"],
  ];
  for (const [reason, step] of steps) {
    assert.equal(summaryOf(reason), `remudero-review: FAIL — id ${ID} reservation unreadable (UNKNOWN): ${step} — verdict withheld`, reason);
  }
  const long = summaryOf(`something new: ${"x".repeat(200)}`, [{ id: "W1-T9647", file: "b.yaml", kind: "unknown", reason: "no read" }]);
  assert.equal(long.length, 140, "clipped to exactly the commit-status cap");
  assert.match(long, /: something new: x+… — verdict withheld \(\+1 more\)$/, "the clip keeps the withheld tail");
});

test("W1-T9674: the awaited reader names the failed verb too, and an empty stderr names the exit", async () => {
  const run = (failing: "fetch" | "log") => async (args: string[]) => gitAnswering(failing)(args);
  assert.deepEqual((await readReservationAnchorsAsync([ID], run("fetch"))).get(ID), { status: "unknown", reason: `fetch failed: ${GIT_SAID}` });
  assert.deepEqual((await readReservationAnchorsAsync([ID], run("log"))).get(ID), { status: "unknown", reason: `log failed: ${GIT_SAID}` });
  const silent = readReservationAnchors([ID], (args) => (args[0] === "ls-remote" ? { status: 2, stdout: "", stderr: "" } : listed));
  assert.deepEqual(silent.get(ID), { status: "unknown", reason: "ls-remote failed: exited 2" });
});

test("W1-T9674: a withheld review's post_refused row carries each unknown read's id and what git said", () => {
  const v = verdictFor("fetch");
  assert.deepEqual(unknownReservationReads(v.taskIdOwnership), [{ id: ID, reason: `fetch failed: ${GIT_SAID}` }]);
  const mixed: TaskIdOwnershipFinding[] = [
    { id: "W1-T9647", file: "b.yaml", kind: "unreserved" },
    { id: ID, file: SHARD, kind: "unknown", reason: "head-ref-unavailable" },
  ];
  assert.deepEqual(unknownReservationReads(mixed), [{ id: ID, reason: "head-ref-unavailable" }], "only unknown reads ride the row");
  assert.deepEqual(unknownReservationReads(undefined), []);
});
