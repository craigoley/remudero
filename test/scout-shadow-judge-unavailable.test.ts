import { test } from "node:test";
import assert from "node:assert/strict";
import { runShadowJudge, shadowJudgeSampled } from "#src/lib/shadow-judge.js";
import type { ShadowJudgeRequest } from "#src/lib/shadow-judge.js";
import type { Mount } from "#src/lib/mounts.js";

const mount = (model: string): Mount => ({ model, effort: "high" }) as Mount;

function sampledKey(): string {
  for (let i = 0; i < 1000; i++) if (shadowJudgeSampled(`review:k${i}`)) return `k${i}`;
  throw new Error("no sampled key");
}

async function run(over: Partial<ShadowJudgeRequest<string>>) {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  await runShadowJudge({
    surface: "review", key: sampledKey(), primaryMount: mount("a"), primaryDecision: "pass",
    mounts: [mount("a"), mount("b")], judge: async () => ({ decision: "pass" }),
    log: (step, fields) => rows.push({ step, fields }), ...over,
  });
  return rows;
}

test("W1-T9274: shadow_judge.unavailable no longer recurs", async () => {
  // A healthy configuration pairs instead of recording unavailable.
  const healthy = await run({});
  assert.deepEqual(healthy.map((r) => r.step), ["shadow_judge.paired"]);

  // Every unavailable arm names its cause, so a recurrence is diagnosable, never silent.
  const none = await run({ mounts: [mount("a")] });
  assert.equal(none[0]?.fields.reason, "no-different-configured-model");
  const resolve = await run({ mounts: () => { throw new Error("boom"); } });
  assert.equal(resolve[0]?.fields.reason, "mount-resolution-failed: boom");
  const failed = await run({ judge: async () => { throw new Error("down"); } });
  assert.equal(failed[0]?.fields.reason, "down");
  const same = await run({
    primaryServedModel: "m", judge: async () => ({ decision: "pass", servedModel: "m" }),
  });
  assert.equal(same[0]?.fields.reason, "same-served-model");
});
