import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { reportWorkerSourceSizeFollowup } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("W1-T2862: the worker-path wrapper reports filing failure and lets verdict processing continue", () => {
  const events: Array<{ step: string; detail?: string }> = [];
  reportWorkerSourceSizeFollowup(
    {} as never,
    (step, extra = {}) => events.push({ step, detail: typeof extra.detail === "string" ? extra.detail : undefined }),
    () => undefined,
    () => {
      throw new Error("feedback write unavailable");
    },
  );
  events.push({ step: "worker.verdict.continued" });
  assert.deepEqual(events.map((event) => event.step), ["source_size.followup.error", "worker.verdict.continued"]);
  assert.match(events[0].detail ?? "", /feedback write unavailable/);
});

test("W1-T2862: production consumes the summary before the first implementation verdict branch removes its worktree", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const workerReturn = source.indexOf("driverResult = await runDiagnoseThenRetry");
  const consumer = source.indexOf("reportWorkerSourceSizeFollowup(", workerReturn);
  const firstVerdict = source.indexOf('failOnWorkerError(impl, "implement")', workerReturn);
  assert.ok(workerReturn >= 0 && consumer > workerReturn, "the production worker path must call the consumer after the worker returns");
  assert.match(source.slice(consumer, firstVerdict), /root:\s*repoDir/, "feedback belongs to the task repository, not the rmd install checkout");
  assert.ok(firstVerdict > consumer, "the consumer must run while the worktree still exists and before verdict cleanup");
});
