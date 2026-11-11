import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "#src/lib/plan.js";
import { runDrain, type DrainDeps, type DrainSummary } from "#src/lib/drain.js";
import type { RunResult } from "#src/lib/run-result.js";

const ok = (id: string): RunResult => ({ taskId: id, runId: `${id}-test`, merged: true, verdict: "merged", costUsd: 0.5 });

/** Tasks in natural (file) order; `files` maps an id to its `files:` scope (default: a private file). */
function fixturePlan(t: TestContext, ids: string[], files: Record<string, string> = {}): Plan {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-curated-lanes-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "tasks.yaml");
  writeFileSync(
    path,
    ids
      .map(
        (id) =>
          `- id: ${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  status: queued\n  depends_on: []\n  files: [${files[id] ?? `src/${id.toLowerCase()}.ts`}]\n`,
      )
      .join(""),
  );
  return loadPlan(path);
}

async function drain(plan: Plan, curated: string[], laneCount: number): Promise<{ summary: DrainSummary; started: string[] }> {
  const merged = new Set<string>();
  const started: string[] = [];
  const deps: DrainDeps = {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      started.push(id);
      merged.add(id);
      return ok(id);
    },
  };
  const summary = await runDrain(plan, deps, { laneCount, curated, max: curated.length });
  return { summary, started };
}

test("multi-lane curated dispatch preserves selection order and excludes unselected tasks", async (t) => {
  // Natural order A, B, C, D, E; the operator curated E, C, B (a different order and a subset).
  const plan = fixturePlan(t, ["A", "B", "C", "D", "E"], { E: "src/shared.ts", C: "src/shared.ts" });
  const { summary, started } = await drain(plan, ["E", "C", "B"], 2);
  assert.deepEqual([...started].sort(), ["B", "C", "E"]);
  assert.ok(started.indexOf("E") < started.indexOf("C"), "curated order E before C survives the overlap deferral");
  assert.deepEqual([...summary.attempted].sort(), ["B", "C", "E"]);
  for (const id of ["A", "D"]) {
    assert.ok(!started.includes(id), `${id} is not curated and never reaches runOne`);
    assert.ok(!summary.attempted.includes(id), `${id} is not in the summary's attempted list`);
  }
});

test("depth-one curation ignores naturally earlier runnable tasks", async (t) => {
  const plan = fixturePlan(t, ["A", "B", "C"]);
  const { summary, started } = await drain(plan, ["C"], 2);
  assert.deepEqual(started, ["C"]);
  assert.deepEqual(summary.attempted, ["C"]);
  assert.deepEqual(summary.merged, ["C"]);
});

test("two disjoint curated tasks run concurrently at the configured lane count", async (t) => {
  const plan = fixturePlan(t, ["A", "B", "C"]);
  const merged = new Set<string>();
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let bothStarted!: () => void;
  const both = new Promise<void>((resolve) => { bothStarted = resolve; });
  const deps: DrainDeps = {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      started.push(id);
      if (started.length === 2) bothStarted();
      await gate;
      merged.add(id);
      return ok(id);
    },
  };
  const work = runDrain(plan, deps, { laneCount: 2, curated: ["C", "B"], max: 2 });
  t.after(async () => { release(); await work; });
  // Both are in flight at once BEFORE either settles: one concurrent pass, not two serial ones.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("lanes were serialised")), 1500); });
  try { await Promise.race([both, timeout]); } finally { clearTimeout(timer); }
  assert.deepEqual(started, ["C", "B"]);
  release();
  const summary = await work;
  assert.deepEqual(summary.attempted, ["C", "B"]);
  assert.deepEqual(summary.merged, ["C", "B"]);
});
