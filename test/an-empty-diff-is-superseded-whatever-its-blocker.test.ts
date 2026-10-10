// #10265 (2026-10-09): #10356 closed an empty-diff PR only on the review-failed arm. #10265 then turned
// plan-proof-unrunnable — a plan filing red on a required check — and the plan-scoped round ran first,
// so the close never fired and the PR sat open. An observed empty diff against main is checked before
// any blocker routing: nothing is left to merge, whatever blocked it.
// A proof-discrimination red keeps W1-T4957's own routes (the stack-parent close, or the ci-log round beside
// another red); the close shares the per-pass supersession-close budget.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runSweep, type OpenPrView } from "../src/lib/sweep.js";

const NOW = Date.parse("2026-10-09T15:30:00Z");

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 10265,
    prUrl: "https://github.com/acme/remudero/pull/10265",
    taskId: "TRIAGE-fb-1789927308301-29a363",
    reviewState: "success",
    checksState: "red",
    ciFailures: [{ name: "ci-shard (1/8)", logTail: "not ok 1 - a test" }],
    unmetCriteria: [],
    priorStrikes: 1,
    lastActivityAt: "2026-10-09T15:26:00.000Z", // expiring-fixture: exempt -- compared only against this suite's INJECTED now (NOW), never the wall clock
    headSha: "12812971",
    autoMergeArmed: false,
    changedFiles: [],
    ...over,
  } as OpenPrView;
}

async function sweep(pr: OpenPrView) {
  const seen = { closed: [] as string[], fixed: 0, planRounds: 0, ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-empty-any-")), "ledger.ndjson") };
  await runSweep([pr], {
    arm: () => "armed",
    close: (_pr, reason) => { seen.closed.push(reason); },
    dispatchFix: () => { seen.fixed += 1; },
    dispatchPlanGateRound: async () => { seen.planRounds += 1; return { outcome: "pushed" }; },
    escalate: () => {},
    ledgerPath: seen.ledgerPath,
    runId: "SWEEP-EMPTY-ANY",
    now: () => NOW,
  });
  return seen;
}

test("a red plan filing whose diff against main is empty is closed as superseded before any plan-scoped round", async () => {
  const seen = await sweep(view({ isPlanFiling: true, headRefName: "plan-triage-fb-1789927308301" }));
  assert.equal(seen.planRounds, 0, "a plan round has nothing to repair in an empty diff");
  assert.equal(seen.closed.length, 1);
  assert.match(seen.closed[0]!, /superseded — this PR's diff against main is empty/);
});

test("an own-red code PR whose diff against main is empty is closed, not handed to a fix worker", async () => {
  const seen = await sweep(view());
  assert.equal(seen.fixed, 0);
  assert.equal(seen.closed.length, 1);
  assert.match(seen.closed[0]!, /diff against main is empty/);
});

test("a red PR that still changes something is not closed for an empty diff", async () => {
  const seen = await sweep(view({ changedFiles: ["src/lib/x.ts"] }));
  assert.deepEqual(seen.closed, []);
});

test("an unobserved diff on a red PR is never read as empty", async () => {
  const seen = await sweep(view({ changedFiles: undefined }));
  assert.deepEqual(seen.closed, []);
});
