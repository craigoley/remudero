import assert from "node:assert/strict";
import { test } from "node:test";
import { armIfVerdictPermits, armIfVerdictPermitsAsync } from "#src/lib/arm-auto-merge.js";

// W1-T13698. A shadow instance arms and merges nothing on ANY lane: the review lane's post-verdict arm
// is refused like the sweep's (`automerge.shadow_refused`), before any effector runs.

const HEAD_SHA = "13698aaabbbbccccddddeeeeffff000011112222";
const PR_URL = "https://github.com/acme/remudero/pull/13698";
const TASK_ID = "W1-T13698";
const PASS = { state: "success", capped: false, planOnly: false } as const;

type Row = [string, Record<string, unknown>];

function ctxFor(rows: Row[], repoMode?: "shadow" | "live") {
  return {
    prUrl: PR_URL,
    taskId: TASK_ID,
    headSha: HEAD_SHA,
    ledgerPath: "/nonexistent/ledger.ndjson",
    log: (step: string, extra: Record<string, unknown> = {}) => void rows.push([step, extra]),
    ...(repoMode === undefined ? {} : { repoMode }),
  };
}

test("a shadow instance's awaited review arm is refused: the effector is never called and automerge.shadow_refused is ledgered", async () => {
  const rows: Row[] = [];
  const calls: string[] = [];
  const outcome = await armIfVerdictPermitsAsync(PASS, ctxFor(rows, "shadow"), {
    arm: (prUrl) => {
      calls.push(prUrl);
      return "armed" as const;
    },
  });
  assert.equal(outcome, "shadow-refused");
  assert.deepEqual(calls, []);
  const refused = rows.filter(([step]) => step === "automerge.shadow_refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.[1].pr_url, PR_URL);
  assert.ok(rows.some(([, extra]) => extra.outcome === "shadow-refused"), "the refusal outcome is ledgered");
  assert.ok(!rows.some(([step]) => step === "automerge.armed"));
});

test("a shadow instance's synchronous review arm is refused the same way", () => {
  const rows: Row[] = [];
  const calls: string[] = [];
  const outcome = armIfVerdictPermits(PASS, ctxFor(rows, "shadow"), {
    arm: (prUrl) => {
      calls.push(prUrl);
      return "armed" as const;
    },
  });
  assert.equal(outcome, "shadow-refused");
  assert.deepEqual(calls, []);
  assert.equal(rows.filter(([step]) => step === "automerge.shadow_refused").length, 1);
});

test("a live instance's review arm still arms after a passing verdict", async () => {
  for (const mode of ["live", undefined] as const) {
    const rows: Row[] = [];
    const calls: string[] = [];
    const outcome = await armIfVerdictPermitsAsync(PASS, ctxFor(rows, mode), {
      arm: (prUrl) => {
        calls.push(prUrl);
        return "armed" as const;
      },
    });
    assert.equal(outcome, "armed");
    assert.deepEqual(calls, [PR_URL]);
    assert.ok(!rows.some(([step]) => step === "automerge.shadow_refused"));
  }
});
