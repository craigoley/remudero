import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestPause } from "../src/lib/fleet-control.js";
import { recyclePauseDetail } from "../src/lib/recycle-yield.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ciGateState, waitForCiGreen, type PollDeps } from "../src/run-task.js";

// MEASURED 2026-10-01: recycle-container.sh engaged state/PAUSE and then waited for every inflight lock; W1-T5004's
// run (PR #8339, five fix rounds) was only polling CI and held its lock through whole CI cycles, so the fleet
// admitted nothing from 11:05 past 12:20. A recycle is a pending restart: a run in its CI wait hands off at its next
// poll, exactly as a stale-code handoff already does, and the sweep resumes the PR after the new container boots.

const PR_URL = "https://github.com/acme/remudero/pull/1";
const HEAD_SHA = "c".repeat(40);
const RECYCLE_REASON = "container recycle (deploy/recycle-container.sh)";

function pendingCi(polls: { count: number }, recycleAtPoll: number, recycle: () => string | undefined): PollDeps {
  return {
    readJson: async (args) => {
      const request = args.join(" ");
      if (request.includes("/pulls/1")) {
        polls.count++;
        return { number: 1, state: "open", merged: false, merged_at: null, head: { sha: HEAD_SHA } };
      }
      if (request.includes("/check-runs")) return { check_runs: [{ name: "ci", status: "in_progress" }] };
      if (request.includes("/status")) return { statuses: [] };
      throw new Error(`unexpected REST request: ${request}`);
    },
    sleep: async () => {},
    requiredContexts: () => ["ci"],
    externalWaitFreshness: () => undefined,
    externalWaitRecycle: () => (polls.count >= recycleAtPoll ? recycle() : undefined),
  };
}

test("W1-T5127: a run waiting on CI hands off at its next poll when a recycle pause is engaged", async () => {
  const polls = { count: 0 };
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const outcome = await waitForCiGreen(PR_URL, (step, extra) => steps.push({ step, extra }), 0, pendingCi(polls, 3, () => `PAUSE requested: ${RECYCLE_REASON}`));
  assert.equal(ciGateState(outcome), "freshness_handoff");
  assert.equal(polls.count, 3, "the pause engaged after the wait began is seen at the very next poll, not only the first");
  assert.equal((outcome as { recycle?: string }).recycle, `PAUSE requested: ${RECYCLE_REASON}`);
  const handoff = steps.find((s) => s.step === "run.freshness_handoff");
  assert.equal(handoff?.extra?.trigger, "recycle");
  assert.equal(handoff?.extra?.head_sha, HEAD_SHA);
});

test("W1-T5127: an operator pause that is not a recycle does not hand the CI wait off", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-yield-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(recyclePauseDetail(root), undefined, "no PAUSE at all is not a recycle");
  requestPause(root, "investigating an incident");
  assert.equal(recyclePauseDetail(root), undefined, "an operator hold means hold, not hand off");
  requestPause(root, "investigating deploy/recycle-container.sh");
  assert.equal(recyclePauseDetail(root), undefined, "mentioning the script in an operator hold does not authorize a recycle handoff");
  const polls = { count: 0 };
  let stalled = false;
  const deps = pendingCi(polls, 1, () => recyclePauseDetail(root));
  deps.readJson = async (args) => {
    const request = args.join(" ");
    if (request.includes("/pulls/1")) {
      polls.count++;
      return { number: 1, state: "open", merged: false, merged_at: null, head: { sha: HEAD_SHA } };
    }
    if (request.includes("/check-runs")) {
      stalled = polls.count >= 3;
      return { check_runs: [{ name: "ci", status: "completed", conclusion: stalled ? "success" : null }] };
    }
    if (request.includes("/status")) return { statuses: [] };
    throw new Error(`unexpected REST request: ${request}`);
  };
  const outcome = await waitForCiGreen(PR_URL, () => {}, 0, deps);
  assert.equal(ciGateState(outcome), "green", "the run keeps waiting through an operator pause and sees CI finish");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "PAUSE"), JSON.stringify({ reason: RECYCLE_REASON, requestedAt: "2026-10-01T11:59:34.000Z", pid: 1, host: "Remudero" }));
  assert.equal(recyclePauseDetail(root), `PAUSE requested: ${RECYCLE_REASON}`, "the recycle script's own PAUSE is recognised");
});
