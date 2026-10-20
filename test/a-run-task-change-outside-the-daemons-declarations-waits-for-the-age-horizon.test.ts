// test/a-run-task-change-outside-the-daemons-declarations-waits-for-the-age-horizon.test.ts — #11861, repointed by W1-T9089.
//
// #11861 weighed a src/run-task.ts change by the declarations it touched: the daemon's own entry declarations took full
// restart weight, any other run-task.ts change waited for the age horizon. That stop-gap refined the self-path list, and
// both are retired with the in-process restart drain (ADR 0007 A.10). Every src/run-task.ts change now waits for the
// age horizon alike, and the declaration reader is gone.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as judge from "#src/lib/deploy-judge.js";

const state = () => ({ total: 0, scoredShas: [] as string[] });

test("W1-T9089: a src/run-task.ts change waits for the age horizon whatever it declares", () => {
  for (const declarations of [undefined, ["daemonCommand"], ["someOtherHelper"]]) {
    const change = { sha: "d".repeat(40), subject: "fix: run-task", files: ["src/run-task.ts"], ...(declarations ? { declarations } : {}) };
    const early = judge.decideFreshnessRestart({ changes: [change], busy: true, staleSinceMs: 0, nowMs: 60_000, state: state() });
    assert.equal(early.action, "defer", `${declarations?.join(",") ?? "no declarations"} does not restart a busy daemon early`);
    assert.equal(early.weight, 1);
    const horizon = judge.decideFreshnessRestart({
      changes: [change], busy: true, staleSinceMs: 0, nowMs: judge.DEPLOY_RESTART_RATE_CEILING_MS, state: state(),
    });
    assert.equal(horizon.action, "restart");
    assert.equal(horizon.restartTrigger, "age");
  }
});

test("W1-T9089: the declaration reader and the outside-the-daemon test are gone", async () => {
  await assert.rejects(import("#src/lib/advance-declarations.js" as string), (error: NodeJS.ErrnoException) =>
    error.code === "ERR_MODULE_NOT_FOUND");
  assert.equal("entryChangeOutsideTheDaemon" in judge, false);
});
