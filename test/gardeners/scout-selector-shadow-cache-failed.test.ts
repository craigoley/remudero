// W1-T13114: a transient GitHub 5xx on a CI-log read used to land at once as `selector-shadow.cache_failed`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { retryTransientGhRead, selectorShadowGardenPass } from "#src/lib/garden-registry.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-11-17T06:00:00.000Z");
const gh502 = () => Object.assign(new Error("Command failed: gh api jobs\ngh: Server Error (HTTP 502)\n"), { stderr: "" });

/** One pass over a single listed run whose jobs read fails `failures` times with a 502 before it answers. */
async function runPass(failures: number) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shadow-cache-failed-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const rows: Array<{ step: string; message?: string }> = [];
  let jobReads = 0;
  const readJson = async (args: string[]): Promise<unknown> => {
    const url = args[1] ?? "";
    if (url.includes("/actions/workflows/ci.yml/runs?")) {
      return { workflow_runs: [{ id: 1, head_sha: "h1", status: "completed", conclusion: "success", created_at: new Date(Date.now() - 60_000).toISOString(),
        pull_requests: [{ number: 7, base: { sha: "b1" } }] }] };
    }
    if (url.includes("/actions/runs/1/jobs")) {
      if (++jobReads <= failures) throw gh502();
      const jobs = Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, name: `coverage-shard (${i + 1}/8)`, status: "completed", conclusion: "success" }));
      return { total_count: 8, jobs };
    }
    return { workflow_runs: [] };
  };
  const deps = {
    stateDir, repoRoot: root, clock: fixedClock(NOW),
    openWorkspace: (): never => { throw new Error("no filing here"); },
    log: (step: string, extra: Record<string, unknown> = {}) => { rows.push({ step, ...(extra as { message?: string }) }); },
  };
  try {
    await selectorShadowGardenPass(deps as never, "o", "r", () => "W1-T1", { readJson, readText: async () => "", retryDelayMs: 0 })();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { rows, jobReads };
}

test("W1-T13114: selector-shadow.cache_failed no longer recurs", async () => {
  let calls = 0;
  const value = await retryTransientGhRead(async () => { if (++calls < 3) throw gh502(); return "ok"; }, 0);
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  const pass = await runPass(2);
  assert.equal(pass.jobReads, 3, "the jobs read was retried through two 502s");
  assert.deepEqual(pass.rows.filter((r) => r.step === "selector-shadow.cache_failed"), []);
});

test("W1-T13114: the symptom is still recorded when its failure occurs", async () => {
  await assert.rejects(retryTransientGhRead(async () => { throw new Error("invalid cache object"); }, 0), /invalid cache object/);
  const pass = await runPass(99);
  assert.equal(pass.jobReads, 3, "a persistent 502 stops after the bounded retries");
  const failed = pass.rows.filter((r) => r.step === "selector-shadow.cache_failed");
  assert.equal(failed.length >= 1, true);
  assert.match(failed[0]!.message ?? "", /HTTP 502/);
});
