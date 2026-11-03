import assert from "node:assert/strict";
import { test } from "node:test";
import { planLintOutcomeFromOutput } from "#src/run-task.js";

// wreckterra#6 (2026-11-03): the host's review posted "lint-plan exited 1 with no summary" and nothing else, so the
// cause of a lint child that crashed before its summary could not be read from the status it posted.

const nodeCrash = [
  "",
  "file:///srv/remudero/dist/run-task.mjs:12",
  "    throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
  "          ^",
  "",
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'example' imported from /srv/remudero/dist/run-task.mjs",
  "    at packageResolve (node:internal/modules/esm/resolve:784:25)",
  "",
  "Node.js v24.22.0",
];

test("plan lint without a summary: a crashed child's error line is in the reason", () => {
  const outcome = planLintOutcomeFromOutput(1, nodeCrash, "abc", true);
  assert.deepEqual(outcome, {
    ran: false,
    reason: "lint-plan exited 1 with no summary: Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'example' imported from /srv/remudero/dist/run-task.mjs",
  });
});

test("plan lint without a summary: with no error line the child's last line is named, clipped", () => {
  const long = `refused: ${"x".repeat(300)}`;
  const outcome = planLintOutcomeFromOutput(1, ["starting", long, ""], "abc", true);
  assert.equal(outcome.ran, false);
  assert.equal(!outcome.ran && outcome.reason, `lint-plan exited 1 with no summary: ${long.slice(0, 160)}`);
});

test("plan lint without a summary: silent output and the lint's own refusal line keep their reasons", () => {
  assert.deepEqual(planLintOutcomeFromOutput(0, [], "abc", true), { ran: false, reason: "lint-plan exited 0 with no summary" });
  assert.deepEqual(planLintOutcomeFromOutput(2, ["### rmd lint-plan: cannot resolve --base abc"], "abc", true),
    { ran: false, reason: "cannot resolve --base abc" });
});
