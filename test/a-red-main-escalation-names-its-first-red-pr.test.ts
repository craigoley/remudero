/**
 * W1-T5843 — A RED-MAIN ESCALATION NAMES ITS FIRST RED PR.
 *
 * The decision composes the failing titles and the first-red line into its reason; the issue an
 * operator reads is `escalationFor(...).detail`, which used to carry only `observation.reason`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { prReferentFromIssueText } from "../src/lib/escalate.js";
import { escalationFor } from "../src/lib/main-health-rung.js";
import {
  enrichMainHealthObservation,
  mainHealthFromRollup,
  type MainHealthRunHistoryEntry,
} from "../src/lib/sweep.js";

const HEAD_SHA = "41231c6700000000000000000000000000000000";
const RED_PUSH_SHA = "12ead908aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GREEN_SHA = "green0000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function red() {
  return mainHealthFromRollup(HEAD_SHA, [{ name: "ci-shard (4/4)", conclusion: "FAILURE" }], ["ci-shard (4/4)"]);
}

const HISTORY: MainHealthRunHistoryEntry[] = [
  { headSha: HEAD_SHA, conclusion: "failure", url: "https://github.com/o/r/actions/runs/3" },
  {
    headSha: RED_PUSH_SHA,
    conclusion: "failure",
    url: "https://github.com/o/r/actions/runs/2",
    pullRequests: [{ number: 4552, url: "https://github.com/o/r/pull/4552" }],
  },
  { headSha: GREEN_SHA, conclusion: "success" },
];

test("a red observation with a first red commit and failing titles escalates with a detail naming the PR, its first red push run and the titles", () => {
  const observation = enrichMainHealthObservation(red(), {
    ciFailures: [
      {
        name: "ci-shard (4/4)",
        conclusion: "FAILURE",
        logTail: ["not ok 1 - census rejects a new source-text assertion", "not ok 2 - baseline rejects a new file"].join("\n"),
      },
    ],
    runHistory: HISTORY,
  });

  const { detail } = escalationFor(observation, "main");

  assert.match(detail, /merged PR #4552/);
  assert.match(detail, new RegExp(`first red main push run: ${RED_PUSH_SHA}`));
  assert.match(detail, /actions\/runs\/2/);
  assert.match(detail, /failing test title\(s\): census rejects a new source-text assertion; baseline rejects a new file/);
  assert.match(detail, new RegExp(`The default branch \`main\` at \`${HEAD_SHA}\` is red\\. ${observation.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
  assert.match(detail, /never auto-reverts/);
});

test("the named merged PR is never a /pull/ URL, which the escalation reconciler would read as the issue's referent", () => {
  const observation = enrichMainHealthObservation(red(), { runHistory: HISTORY });

  const { detail } = escalationFor(observation, "main");

  assert.match(detail, /merged PR #4552;/);
  assert.equal(prReferentFromIssueText(detail), undefined);
  assert.doesNotMatch(detail, /\(\)/);
});

test("an observation without a first red commit still escalates with the observation's reason", () => {
  const observation = red();

  const { detail } = escalationFor(observation, "main");

  assert.ok(detail.includes(`${observation.reason}. This observer never auto-reverts`), detail);
  assert.doesNotMatch(detail, /first red main push run|failing test title/);
});
