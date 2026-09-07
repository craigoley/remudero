/**
 * W1-T2804 — THE CI GATE READ A SUPERSEDED ATTEMPT, AND THE TWO READERS ANSWERED ABOUT
 * DIFFERENT COMMITS.
 *
 * `ciGateFromRollup` filtered `remudero-review` and nothing else: no dedupe, no required-context
 * filter. A sha accumulates one rollup entry PER ATTEMPT, so a retried check's superseded
 * CANCELLED/FAILURE entry outvoted its own green successor and the run booked `blocked_ci`
 * against a PR GitHub was already merging. Its three siblings — `checksStateFromRollup`,
 * `fetchCiFailures` and `redQualityGateNames` — had both rules already (W1-T457).
 *
 * THE PARSE IS ONLY HALF. `waitForCiGreen` resolved its own head and the wired
 * `deps.fetchCiFailures` resolved another over a second transport, so the fix rung's stand-down
 * text — "the checks-red rollup and the ci-log evidence miner disagree" — could assert a
 * disagreement about two different commits. A dedupe-only change would leave that intact while
 * looking complete, which is why this file tests BOTH halves and says so.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ciGateFromRollup, ciGateSha, ciGateState, waitForCiGreen } from "../src/run-task.js";

const PR_URL = "https://github.com/acme/remudero/pull/42";
const OWNER = "acme";
const REPO = "remudero";

/** The measured incident's own three attempts of ONE required check on ONE sha (`acceptance-author-gate`
 *  at edb9cfb3), newest last. */
const THREE_ATTEMPTS = [
  { name: "acceptance-author-gate", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-09-04T13:48:42Z" },
  { name: "acceptance-author-gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-04T13:49:20Z" },
  { name: "acceptance-author-gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-04T13:50:02Z" },
];
const CI_GREEN = { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-04T13:50:30Z" };

// ── FORWARD: a superseded red attempt no longer outvotes its own successor ───────────────────

test("W1-T2804: three attempts of one required check whose LATEST is green read green — a superseded red cannot outvote its successor", () => {
  assert.equal(
    ciGateFromRollup([...THREE_ATTEMPTS, CI_GREEN]),
    "green",
    "the 13:49:20 FAILURE is SUPERSEDED by the 13:50:02 SUCCESS on the same sha; only the latest attempt votes",
  );
});

test("W1-T2804: attempt order in the rollup array does not decide the verdict — startedAt does", () => {
  const shuffled = [THREE_ATTEMPTS[2], THREE_ATTEMPTS[0], CI_GREEN, THREE_ATTEMPTS[1]];
  assert.equal(ciGateFromRollup(shuffled), "green", "GitHub may report attempts in any order; the timestamp is the rule");
});

// ── REVERSE: the direction that matters more — a dedupe must not manufacture a green ─────────

test("W1-T2804: genuine red still reds — the LATEST attempt FAILURE reads red even with two older siblings", () => {
  const latestRed = [
    { name: "acceptance-author-gate", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-09-04T13:48:42Z" },
    { name: "acceptance-author-gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-04T13:49:20Z" },
    { name: "acceptance-author-gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-04T13:50:02Z" },
  ];
  assert.equal(ciGateFromRollup([...latestRed, CI_GREEN]), "red", "a dedupe that swallowed this would turn a true red into a MERGING green");
});

test("W1-T2804: genuine red still reds — a single FAILURE with no siblings is not satisfiable by an empty gate", () => {
  assert.equal(ciGateFromRollup([{ name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-04T13:50:02Z" }]), "red");
});

// ── BOUNDARY: the ordering dedupeRollupByLatestAttempt defines, now inherited here ───────────

test("W1-T2804: an entry with NO startedAt sorts OLDER than one that has it — the sibling rule's own boundary", () => {
  const noStamp = { name: "ci", status: "COMPLETED", conclusion: "FAILURE" };
  const stamped = { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-04T13:50:02Z" };
  assert.equal(ciGateFromRollup([noStamp, stamped]), "green", "the stamped SUCCESS is the later attempt");
  assert.equal(ciGateFromRollup([stamped, noStamp]), "green", "…and array position does not change that");
});

// ── THE REQUIRED-CONTEXT FILTER, BOTH DIRECTIONS ────────────────────────────────────────────

test("W1-T2804: a red NON-required context does not make the gate red once the required list is readable", () => {
  const rollup = [CI_GREEN, { name: "optional-scan", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-04T13:50:10Z" }];
  assert.equal(ciGateFromRollup(rollup, ["ci"]), "green", "only branch protection's own required contexts vote");
});

test("W1-T2804: a red REQUIRED context still makes the gate red", () => {
  const rollup = [CI_GREEN, { name: "commitlint", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-04T13:50:10Z" }];
  assert.equal(ciGateFromRollup(rollup, ["ci", "commitlint"]), "red");
});

test("W1-T2804: an UNREADABLE required list fails CLOSED — every reported context counts again, never a manufactured green", () => {
  const rollup = [CI_GREEN, { name: "optional-scan", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-04T13:50:10Z" }];
  // The container PAT gets 403 on the protection endpoint, so this is the COMMON case on this
  // fleet, not an edge one. The degrade is read from `checksStateFromRollup`, not re-decided.
  assert.equal(ciGateFromRollup(rollup, undefined), "red", "no list at all");
  assert.equal(ciGateFromRollup(rollup, []), "red", "an empty list is the same darkness");
});

test("W1-T2804: remudero-review's own pinned status is still excluded unconditionally (W1-T102, the #177 exhaustion)", () => {
  const rollup = [CI_GREEN, { context: "remudero-review", state: "FAILURE", startedAt: "2026-09-04T13:50:10Z" }];
  assert.equal(ciGateFromRollup(rollup), "green");
  assert.equal(ciGateFromRollup(rollup, ["ci", "remudero-review"]), "green", "…even when it appears in the required list");
});

test("W1-T2804: the GREEN verdict is unchanged — it still requires a check named `ci` reporting SUCCESS", () => {
  assert.equal(ciGateFromRollup(THREE_ATTEMPTS), "pending", "nothing red, but no `ci` SUCCESS either — sharing RULES with checksStateFromRollup must not merge the two VERDICTS");
});

// ── shared rule not a fourth filter ─────────────────────────────────────────────────────────

test("W1-T2804: shared rule not a fourth filter — the gate CALLS dedupeRollupByLatestAttempt rather than re-deriving it", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function ciGateFromRollup"));
  const fn = body.slice(0, body.indexOf("\n}\n") + 3);
  assert.ok(
    fn.includes("dedupeRollupByLatestAttempt("),
    "W1-T457's standing instruction: give this reader the rule the gate already has, never invent a fourth one that can drift",
  );
  assert.ok(!/\.sort\(/.test(fn), "a hand-rolled ordering here would be exactly that fourth filter");
});

// ── one sha per decision / pinning is not parsing ────────────────────────────────────────────

test("W1-T2804: one sha per decision — the gate reports the head it judged, so the evidence miner can be pinned to that same commit", async () => {
  // The head MOVES after the gate resolves. A reader that resolved its own head afterwards would
  // answer about `sha-two`; the gate's verdict was about `sha-one`, and says so.
  const heads = ["sha-one", "sha-two"];
  let rowReads = 0;
  const readJson = async (args: string[]): Promise<unknown> => {
    const path = args[1];
    if (path === `repos/${OWNER}/${REPO}/pulls/42`) {
      const sha = heads[Math.min(rowReads, heads.length - 1)];
      rowReads++;
      return { number: 42, state: "OPEN", merged: false, merged_at: null, head: { sha } };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/sha-one/check-runs?per_page=100`) {
      return { check_runs: [{ name: "ci", status: "completed", conclusion: "success", started_at: "2026-09-04T13:50:30Z" }] };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/sha-one/status`) return { statuses: [] };
    throw new Error(`unrouted read (a SECOND head resolution would land here): ${JSON.stringify(args)}`);
  };

  const outcome = await waitForCiGreen(PR_URL, () => {}, 6, { readJson, sleep: async () => {} });
  assert.equal(ciGateState(outcome), "green");
  assert.equal(ciGateSha(outcome), "sha-one", "the verdict names the commit it was actually read for, not whatever the head became afterwards");
  assert.equal(rowReads, 1, "the sha is the ALREADY-RESOLVED head — a second read would be a second chance to skew");
});

test("W1-T2804: pinning is not parsing — a bare verdict from a caller-supplied reader pins nothing and every consumer falls open", () => {
  // Every pre-existing `deps.waitForCiGreen` stub returns a bare verdict. Those keep working and
  // change no behavior: `ciGateSha` reports undefined, the miner resolves its own head exactly as
  // it did before this task. Recorded so a later reader cannot mistake the dedupe above for the
  // whole concern — the parse fix alone leaves the two readers free to answer about two commits.
  assert.equal(ciGateState("timeout"), "timeout");
  assert.equal(ciGateSha("timeout"), undefined);
  assert.equal(ciGateSha({ state: "red" }), undefined);
  assert.equal(ciGateSha({ state: "red", sha: "abc" }), "abc");

  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  assert.ok(
    src.includes("currentCiFailures = await deps.fetchCiFailures(opts.prUrl, ciGateSha(ci));"),
    "the post-strike miner must be pinned to the sha the round's own gate read judged",
  );
  assert.ok(
    src.includes("sha: disagreement.sha,"),
    "and the sha both readers answered about must be OBSERVABLE in the row that reports their disagreement",
  );
});
