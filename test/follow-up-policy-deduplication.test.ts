import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import {
  FOLLOW_UP_POLICY_VERSION,
  appendFollowUpCandidate,
  evaluateFollowUpPolicy,
  readFollowUpHistory,
  type FollowUpCandidate,
} from "../src/lib/follow-up-policy.js";

const candidate = (id: string): FollowUpCandidate => ({
  version: FOLLOW_UP_POLICY_VERSION,
  candidateId: id,
  sourceEvent: "thread.dropped",
  workstream: "repo/workstream",
  reason: "The owner has not chosen the next decision.",
  freshness: "verified",
  dependency: "owner response",
  deduplicationKey: "repo/workstream:decision",
  maxAttempts: 2,
  owner: "operator",
  nextQuestion: "Which bounded next step should be taken?",
  createdAt: "2026-09-21T10:00:00.000Z",
});

test("duplicate candidates coalesce by durable key and do not create a second eligible reminder", () => {
  const first = candidate("follow-up:first");
  const second = candidate("follow-up:second");
  const firstHistory = { ...first, state: "scheduled" as const, attempts: 0, events: [] };
  const evaluation = evaluateFollowUpPolicy(second, {
    now: "2026-09-21T11:00:00.000Z",
    existing: [firstHistory],
  });
  assert.equal(evaluation.state, "suppressed");
  assert.match(evaluation.reason, /coalesced/);
});

test("a terminal candidate blocks a later candidate with the same durable key", () => {
  const terminal = { ...candidate("follow-up:terminal"), state: "accepted" as const, attempts: 1, events: [] };
  const evaluation = evaluateFollowUpPolicy(candidate("follow-up:later"), {
    now: "2026-09-21T11:00:00.000Z",
    existing: [terminal],
  });
  assert.equal(evaluation.state, "suppressed");
  assert.match(evaluation.reason, /terminal receipt/);
});

test("the candidate and dedup state survive a fresh read from the ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-follow-up-dedup-"));
  try {
    const ledgerPath = join(root, "state", "ledger.ndjson");
    appendFollowUpCandidate({ ledgerPath, now: fixedClock(Date.parse("2026-09-21T10:00:00.000Z")) }, candidate("follow-up:persistent"));
    const history = readFollowUpHistory(ledgerPath, Date.parse("2026-09-21T11:00:00.000Z"));
    assert.equal(history[0]?.deduplicationKey, "repo/workstream:decision");
    assert.equal(history[0]?.state, "scheduled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
