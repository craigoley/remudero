/**
 * W1-T2268 — THE TWO POLL LOOPS ARE THE LAST GRAPHQL IN THE RUN PATH.
 *
 * `pollToGate` and `waitForCiGreen` (src/run-task.ts) used to spend `gh pr view --json
 * state,statusCheckRollup` / `--json statusCheckRollup` every `everySec` (default 6s) for the
 * whole of a CI/merge wait — a GraphQL read whose point cost scales with the head's check count,
 * against a GraphQL budget that was measured at filing time as fully exhausted (`used 10064,
 * limit 10000, remaining 0`). The composed-rollup read the swap needs — `rollupFor`
 * (`src/lib/open-prs-rest.ts`), which merges `checkRunsRestArgs`'s check-runs with
 * `combinedStatusRestArgs`'s commit statuses into the same shape GraphQL's union reported — was
 * already built and tested for the sweep, just module-private. This file proves: (1) it is now
 * reachable from outside that module, (2)-(4) its composition behaviour, and (5)-(9) that both
 * poll loops now drive it over the REST budget, unchanged in cadence, observation timing, and
 * error propagation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { rollupFor, GhPaceFloorStandDownError, type GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { pollToGate, waitForCiGreen, STALL_WINDOW } from "../src/run-task.js";

const PR_URL = "https://github.com/acme/remudero/pull/42";
const OWNER = "acme";
const REPO = "remudero";
const SHA = "deadbeefcafe";

/** A fake `gh api` fetcher, `rollupFor`'s own shape: routes by argv[1], records every call. */
function fakeFetcher(routes: Record<string, unknown>): GhApiFetcher & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((args: string[]) => {
    calls.push(args);
    const path = args[1];
    if (!(path in routes)) throw new Error(`unrouted gh api path: ${JSON.stringify(args)}`);
    return routes[path];
  }) as GhApiFetcher & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

// ── acceptance 1: reachable from outside the module ─────────────────────────────────────────

test("W1-T2268: rollupFor is exported — a composed per-head rollup read is reachable from outside open-prs-rest.ts", () => {
  assert.equal(typeof rollupFor, "function", "rollupFor must be an importable, callable export");
  const fetch = fakeFetcher({
    [`repos/${OWNER}/${REPO}/commits/${SHA}/check-runs?per_page=100`]: { check_runs: [] },
    [`repos/${OWNER}/${REPO}/commits/${SHA}/status`]: { statuses: [] },
  });
  assert.deepEqual(rollupFor(OWNER, REPO, SHA, fetch), []);
});

// ── acceptance 2: a legacy commit status survives the merge ─────────────────────────────────

test("W1-T2268: a remudero-review commit status (legacy StatusContext) survives into the composed rollup", () => {
  const fetch = fakeFetcher({
    [`repos/${OWNER}/${REPO}/commits/${SHA}/check-runs?per_page=100`]: { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] },
    [`repos/${OWNER}/${REPO}/commits/${SHA}/status`]: { statuses: [{ context: "remudero-review", state: "success" }] },
  });
  const got = rollupFor(OWNER, REPO, SHA, fetch);
  assert.deepEqual(got, [
    { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
    { context: "remudero-review", state: "SUCCESS" },
  ]);
  assert.ok(
    got.some((c) => c.context === "remudero-review"),
    "a check-runs-only read would have dropped this entirely — it is a commit status, not a check run",
  );
});

// ── acceptance 3: a check-runs-only head composes to what GraphQL reported ──────────────────

test("W1-T2268: a head with only modern check runs composes to the same entries the GraphQL rollup reported", () => {
  const fetch = fakeFetcher({
    [`repos/${OWNER}/${REPO}/commits/${SHA}/check-runs?per_page=100`]: {
      check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }, { name: "lint", status: "in_progress" }],
    },
    [`repos/${OWNER}/${REPO}/commits/${SHA}/status`]: { statuses: [] },
  });
  assert.deepEqual(rollupFor(OWNER, REPO, SHA, fetch), [
    { name: "ci", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "lint", status: "IN_PROGRESS" },
  ]);
});

// ── acceptance 4: an empty head composes to an empty rollup, never an invented pending entry ─

test("W1-T2268: an empty head (no check runs, no statuses) composes to an empty rollup", () => {
  const fetch = fakeFetcher({
    [`repos/${OWNER}/${REPO}/commits/${SHA}/check-runs?per_page=100`]: { check_runs: [] },
    [`repos/${OWNER}/${REPO}/commits/${SHA}/status`]: { statuses: [] },
  });
  const got = rollupFor(OWNER, REPO, SHA, fetch);
  assert.deepEqual(got, [], "an empty head must compose to [], never a synthesised pending entry");
});

// ── the shared REST-driven read seam both loops now take ────────────────────────────────────

/**
 * Drives `pollToGate`/`waitForCiGreen`'s new per-iteration shape: a PR-row read
 * (`repos/{o}/{r}/pulls/{n}`), then the composed rollup's own check-runs + combined-status —
 * three REST calls per poll, none of them GraphQL. `prRowFor`/`rollupFor` are keyed by
 * iteration (0-indexed), clamped to the last entry once exhausted, mirroring a real PR settling
 * into a terminal state and staying there.
 */
function restPoll(
  prRowFor: (iteration: number) => { state: string; merged?: boolean; merged_at?: string | null },
  rollupForIter: (iteration: number) => Array<{ name?: string; context?: string; status?: string; conclusion?: string; state?: string }>,
): { readJson: (args: string[]) => Promise<unknown>; calls: string[][]; iterations: () => number } {
  const calls: string[][] = [];
  let iteration = 0;
  let step = 0;
  let current: ReturnType<typeof rollupForIter> = [];
  return {
    calls,
    iterations: () => iteration,
    readJson: async (args: string[]) => {
      calls.push(args);
      const which = step % 3;
      step++;
      if (which === 0) {
        const row = prRowFor(iteration);
        current = rollupForIter(iteration);
        iteration++;
        return { number: 42, state: row.state, merged: row.merged ?? false, merged_at: row.merged_at ?? null, head: { sha: SHA } };
      }
      if (which === 1) {
        return { check_runs: current.filter((c) => c.name !== undefined).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })) };
      }
      return { statuses: current.filter((c) => c.context !== undefined).map((c) => ({ context: c.context, state: c.state })) };
    },
  };
}

// ── acceptance 5: every read is against the budget with headroom, never the point-priced one ─

test("W1-T2268: every pollToGate iteration reads REST (`gh api`), never GraphQL (`gh pr view`)", async () => {
  const { readJson, calls } = restPoll(
    () => ({ state: "MERGED" }),
    () => [],
  );
  const outcome = await pollToGate(PR_URL, () => {}, 6, { readJson });
  assert.equal(outcome.merged, true);
  assert.ok(calls.length > 0, "the fixture was actually reached");
  assert.ok(
    calls.every((c) => c[0] === "api"),
    `every read pollToGate issues must be REST: saw ${JSON.stringify(calls)}`,
  );
  assert.ok(
    calls.every((c) => c[0] !== "pr" && c[1] !== "view"),
    "pollToGate must never shell `gh pr view` any more",
  );
});

test("W1-T2268: every waitForCiGreen iteration reads REST (`gh api`), never GraphQL (`gh pr view`)", async () => {
  const { readJson, calls } = restPoll(
    () => ({ state: "OPEN" }),
    () => [{ name: "ci", status: "completed", conclusion: "success" }],
  );
  const outcome = await waitForCiGreen(PR_URL, () => {}, 6, { readJson });
  assert.equal(outcome, "green");
  assert.ok(calls.length > 0, "the fixture was actually reached");
  assert.ok(
    calls.every((c) => c[0] === "api"),
    `every read waitForCiGreen issues must be REST: saw ${JSON.stringify(calls)}`,
  );
});

// ── acceptance 6: a stand-down still propagates, never swallowed ────────────────────────────

test("W1-T2268: a GhPaceFloorStandDownError thrown by the injected read propagates out of pollToGate rather than being swallowed", async () => {
  const readJson = async (): Promise<unknown> => {
    throw new GhPaceFloorStandDownError({ resource: "core", remaining: 0, limit: 5000 });
  };
  await assert.rejects(() => pollToGate(PR_URL, () => {}, 6, { readJson }), GhPaceFloorStandDownError);
});

test("W1-T2268: a GhPaceFloorStandDownError thrown by the injected read propagates out of waitForCiGreen rather than being swallowed", async () => {
  const readJson = async (): Promise<unknown> => {
    throw new GhPaceFloorStandDownError({ resource: "core", remaining: 0, limit: 5000 });
  };
  await assert.rejects(() => waitForCiGreen(PR_URL, () => {}, 6, { readJson }), GhPaceFloorStandDownError);
});

// ── acceptance 7: a transition to green is observed on the same iteration as before ─────────

test("W1-T2268: waitForCiGreen observes a transition to green on the FIRST iteration it appears, not one iteration late", async () => {
  // Iteration 0: pending. Iteration 1: green. If the migration introduced an extra read or a
  // skipped observation, this would resolve on the wrong iteration or need an extra sleep.
  const { readJson, iterations } = restPoll(
    () => ({ state: "OPEN" }),
    (i) => (i < 1 ? [{ name: "ci", status: "in_progress" }] : [{ name: "ci", status: "completed", conclusion: "success" }]),
  );
  const slept: number[] = [];
  const outcome = await waitForCiGreen(PR_URL, () => {}, 6, { readJson, sleep: async (ms) => void slept.push(ms) });
  assert.equal(outcome, "green");
  assert.equal(iterations(), 2, "green must be observed on the SECOND iteration (index 1), not later");
  assert.deepEqual(slept, [6000], "exactly one sleep between the pending iteration and the green one — no extra wait");
});

// ── acceptance 8: the poll cadence is unchanged — no reduction in observations ───────────────

test("W1-T2268: the poll cadence is unchanged — one sleep per iteration, at everySec * 1000ms, unreduced by the transport swap", async () => {
  const { readJson, iterations } = restPoll(
    () => ({ state: "OPEN" }),
    (i) => (i < 4 ? [{ name: "ci", status: "in_progress" }] : [{ name: "ci", status: "completed", conclusion: "success" }]),
  );
  const slept: number[] = [];
  const outcome = await waitForCiGreen(PR_URL, () => {}, 6, { readJson, sleep: async (ms) => void slept.push(ms) });
  assert.equal(outcome, "green");
  assert.equal(iterations(), 5, "four pending iterations then the green one — every observation still happened");
  assert.deepEqual(slept, [6000, 6000, 6000, 6000], "six seconds between every poll, unchanged by the transport swap");
});

test("W1-T2268: pollToGate's stall bound (STALL_WINDOW consecutive identical polls) still fires — no observations were dropped to get there", async () => {
  const { readJson, iterations } = restPoll(
    () => ({ state: "OPEN" }),
    () => [{ name: "ci", status: "queued" }],
  );
  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  const outcome = await pollToGate(PR_URL, (step, extra) => logs.push({ step, extra }), 6, {
    readJson,
    sleep: async () => {},
  });
  assert.equal(outcome.merged, false);
  assert.match(outcome.reason, new RegExp(`no progress for ${STALL_WINDOW} consecutive polls`));
  assert.equal(iterations(), STALL_WINDOW, "the stall must be concluded off exactly STALL_WINDOW real observations, not fewer");
  assert.ok(logs.some((l) => l.step === "pr.stalled"), "the stall is still logged, not just returned silently");
});

// ── acceptance 9: the injected read and sleep seams stay injectable ─────────────────────────

test("W1-T2268: pollToGate and waitForCiGreen are drivable end to end without a network or a wall clock", async () => {
  // No `gh` on PATH, no real timers — every test above already proves this implicitly (each
  // completes in milliseconds against a nominal 6s cadence), but this test pins it explicitly:
  // an empty PATH still resolves, because the injected readJson/sleep seams are the only thing
  // either loop consults for its reads and delays.
  const savedPath = process.env.PATH;
  process.env.PATH = "";
  const started = Date.now();
  try {
    const gate = restPoll(
      () => ({ state: "MERGED" }),
      () => [],
    );
    const gateOutcome = await pollToGate(PR_URL, () => {}, 6, { readJson: gate.readJson, sleep: async () => {} });
    assert.equal(gateOutcome.merged, true);

    const ci = restPoll(
      () => ({ state: "OPEN" }),
      () => [{ name: "ci", status: "completed", conclusion: "success" }],
    );
    const ciOutcome = await waitForCiGreen(PR_URL, () => {}, 6, { readJson: ci.readJson, sleep: async () => {} });
    assert.equal(ciOutcome, "green");
  } finally {
    process.env.PATH = savedPath;
  }
  assert.ok(Date.now() - started < 5000, "a fully-injected run must cost no real wall-clock time despite a 6s nominal cadence");
});
