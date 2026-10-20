import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const YAML = "\n- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n";

async function bootRow(delayMs: number): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}quiet-hours-flaky-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  const merged = new Set<string>();
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDaemon(
    loadPlan(f),
    {
      refreshMerged: () => {
        const until = Date.now() + delayMs;
        while (Date.now() < until) { /* busy-wait: stretch boot time like a loaded runner */ }
        return (id) => merged.has(id);
      },
      runOne: async (id) => {
        merged.add(id);
        return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
      },
      sleep: async () => {},
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
    { max: 1, pollIntervalMs: 5 },
  );
  const row = rows.find((r) => r.step === "daemon.boot_first_dispatch");
  assert.ok(row, "boot_first_dispatch row is logged");
  return row.extra;
}

test("W1-T10184: check:test:test/quiet-hours-dispatch-gate.test.ts:flaky is prevented, not retried", async () => {
  const fast = await bootRow(0);
  const slow = await bootRow(40);
  // Every wall-clock field of the row must be one the equivalence test zeroes; any other field is stable.
  const timed = ["boot_at", "gate_open_ms", "first_selection_ms", "first_run_start_ms"];
  const strip = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => !timed.includes(k)));
  assert.deepEqual(strip(slow), strip(fast));
  for (const k of timed) assert.ok(k in fast, `${k} is present`);
});
