import assert from "node:assert/strict";
import { test } from "node:test";

import { escalationFor } from "../src/lib/main-health-rung.js";
import {
  enrichMainHealthObservation,
  mainHealthEscalationDecision,
  mainHealthFromRollup,
  type CiFailure,
  type MainHealthRunHistoryEntry,
  type RollupCheckEntry,
} from "../src/lib/sweep.js";

const HEAD_SHA = "41231c6700000000000000000000000000000000";

function redCheck(overrides: Partial<RollupCheckEntry> = {}): RollupCheckEntry {
  return {
    name: "ci-shard (4/4)",
    conclusion: "FAILURE",
    startedAt: "2026-09-08T09:58:00Z",
    ...overrides,
  };
}

function baseObservation() {
  return mainHealthFromRollup(HEAD_SHA, [redCheck()], ["ci-shard (4/4)"]);
}

function failure(logTail: string, overrides: Partial<CiFailure> = {}): CiFailure {
  return {
    name: "ci-shard (4/4)",
    conclusion: "FAILURE",
    logTail,
    ...overrides,
  };
}

test("an escalation for a red main names the failing TEST TITLES from the check log and caps the list with +N more", () => {
  const observation = enrichMainHealthObservation(baseObservation(), {
    ciFailures: [
      failure(
        [
          "TAP version 13",
          "not ok 1 - source-text census rejects a new source-text assertion",
          "not ok 2 - comment-load baseline rejects new file without recorded ceiling",
          "not ok 3 - the REAL test population is at or under the recorded baseline",
          "not ok 4 - bare catch allowance never sits slack above the actual count",
        ].join("\n"),
      ),
    ],
  });

  const reason = mainHealthEscalationDecision(observation).reason;

  assert.match(reason, /required check\(s\) concluded failing on main: ci-shard \(4\/4\)/);
  assert.match(reason, /failing test title\(s\): source-text census rejects a new source-text assertion/);
  assert.match(reason, /comment-load baseline rejects new file without recorded ceiling/);
  assert.match(reason, /the REAL test population is at or under the recorded baseline/);
  assert.match(reason, /\+1 more/);
  assert.doesNotMatch(reason, /bare catch allowance never sits slack/);
});

test("it names the first-red commit after the newest successful main push run", () => {
  const history: MainHealthRunHistoryEntry[] = [
    { headSha: HEAD_SHA, conclusion: "failure", url: "https://github.com/o/r/actions/runs/3" },
    {
      headSha: "12ead908aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      conclusion: "failure",
      url: "https://github.com/o/r/actions/runs/2",
      pullRequests: [{ number: 4552, url: "https://github.com/o/r/pull/4552" }],
    },
    { headSha: "green0000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", conclusion: "success" },
  ];

  const observation = enrichMainHealthObservation(baseObservation(), {
    ciFailures: [failure("not ok 1 - failing census assertion")],
    runHistory: history,
  });

  const reason = mainHealthEscalationDecision(observation).reason;

  assert.match(reason, /first red main push run: 12ead908aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(reason, /PR #4552/);
  assert.match(reason, /after green0000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa was green/);
  assert.doesNotMatch(reason, new RegExp(`first red main push run: ${HEAD_SHA}`));
});

test("a run history window with no success reports exhaustion instead of blaming the oldest observed failure", () => {
  const oldest = "oldfailaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const observation = enrichMainHealthObservation(baseObservation(), {
    ciFailures: [failure("not ok 1 - failing census assertion")],
    runHistory: [
      { headSha: HEAD_SHA, conclusion: "failure" },
      { headSha: oldest, conclusion: "failure" },
    ],
  });

  const reason = mainHealthEscalationDecision(observation).reason;

  assert.match(reason, /main push run history window exhausted before a successful run/);
  assert.match(reason, /no first-red commit named/);
  assert.doesNotMatch(reason, new RegExp(`first red main push run: ${oldest}`));
});

test("an unreadable log or unreadable run history still escalates and names the unreadable half", () => {
  const observation = enrichMainHealthObservation(baseObservation(), {
    ciFailures: [failure("", { logUnavailable: { kind: "fetch-failed", detail: "HTTP 403" } })],
    runHistoryUnavailable: "HTTP 502",
  });

  const decision = mainHealthEscalationDecision(observation);

  assert.equal(decision.escalate, true);
  assert.match(decision.reason, /required check\(s\) concluded failing on main: ci-shard \(4\/4\)/);
  assert.match(decision.reason, /failing test log NOT read for ci-shard \(4\/4\)/);
  assert.match(decision.reason, /HTTP 403/);
  assert.match(decision.reason, /main push run history NOT read: HTTP 502/);
});

test("the escalation class stays MANUAL with the existing options and recommendation", () => {
  const observation = enrichMainHealthObservation(baseObservation(), {
    ciFailures: [failure("not ok 1 - failing census assertion")],
    runHistory: [
      { headSha: HEAD_SHA, conclusion: "failure" },
      { headSha: "green0000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", conclusion: "success" },
    ],
  });

  const escalation = escalationFor(observation, "main");

  assert.equal(escalation.class, "MANUAL");
  assert.equal(escalation.recommendation, "let automatic repair continue");
  assert.deepEqual(
    escalation.options.map((option) => option.label),
    ["let automatic repair continue", "place a queue hold"],
  );
});
