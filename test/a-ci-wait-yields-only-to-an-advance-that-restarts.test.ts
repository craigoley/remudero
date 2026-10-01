import assert from "node:assert/strict";
import { test } from "node:test";
import type { DaemonFreshness } from "../src/lib/daemon.js";
import { ciWaitFreshness, waitForCiGreen, type PollDeps } from "../src/run-task.js";

// W1-T5037 — MEASURED 2026-09-28..30: ~31 of 113 build verdicts were freshness_yield handoffs of a CI wait.
// Since W1-T4945 a busy daemon defers a low-weight advance until idle, and a run waiting on CI makes it busy,
// so a run that yielded to such an advance gave up its CI wait with no restart following. The daemon-built
// closure now yields only to an advance that ALONE would restart a busy daemon on W1-T4945's own scoring.

const PR_URL = "https://github.com/acme/remudero/pull/1";
const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);

function stale(files?: string[]): Extract<DaemonFreshness, { stale: true }> {
  return {
    stale: true,
    oldSha: OLD_SHA,
    newSha: NEW_SHA,
    ...(files ? { changes: [{ sha: NEW_SHA, subject: "advance", files }] } : {}),
  };
}

function pollDeps(polls: { count: number }): PollDeps {
  return {
    readJson: async (args) => {
      const request = args.join(" ");
      if (request.includes("/pulls/1")) {
        polls.count++;
        return { number: 1, state: "open", merged: false, merged_at: null, head: { sha: HEAD_SHA } };
      }
      if (request.includes("/check-runs")) {
        return polls.count < 3
          ? { check_runs: [{ name: "ci", status: "in_progress" }] }
          : { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] };
      }
      if (request.includes("/status")) return { statuses: [] };
      throw new Error(`unexpected REST request: ${request}`);
    },
    sleep: async () => {},
    requiredContexts: () => ["ci"],
  };
}

test("W1-T5037: a low-weight advance does not end the CI wait of a build run", async () => {
  const polls = { count: 0 };
  const steps: string[] = [];
  const outcome = await waitForCiGreen(PR_URL, (step) => steps.push(step), 0, {
    ...pollDeps(polls),
    externalWaitFreshness: ciWaitFreshness(() => stale(["src/lib/views.ts"])),
  });
  assert.equal(outcome.state, "green", "the run keeps waiting and sees its CI finish");
  assert.equal(steps.includes("run.freshness_handoff"), false);
  assert.ok(polls.count >= 3, "the wait polled past the advance instead of yielding at the first boundary");
});

test("W1-T5037: an advance to the daemon loop still hands the CI wait off", async () => {
  const outcome = await waitForCiGreen(PR_URL, () => {}, 0, {
    ...pollDeps({ count: 0 }),
    externalWaitFreshness: ciWaitFreshness(() => stale(["src/lib/daemon.ts"])),
  });
  assert.equal(outcome.state, "freshness_handoff");
});

test("W1-T5037: an advance whose commits could not be read still hands the CI wait off", async () => {
  const outcome = await waitForCiGreen(PR_URL, () => {}, 0, {
    ...pollDeps({ count: 0 }),
    externalWaitFreshness: ciWaitFreshness(() => stale()),
  });
  assert.equal(outcome.state, "freshness_handoff", "an unknown advance counts as full weight");
});

test("W1-T5037: a reading that is not stale never yields", () => {
  assert.equal(ciWaitFreshness(() => ({ stale: false, notStale: { arm: "up_to_date" } }))(), undefined);
});
