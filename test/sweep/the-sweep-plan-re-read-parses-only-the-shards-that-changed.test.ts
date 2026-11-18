import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { loadPlan, loadPlanReusingParses, PlanBlobCache, PlanError } from "#src/lib/plan.js";
import { buildSweepEffects, FIX_PLAN_BLOB_CACHE } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

function shard(id: string, extra = ""): string {
  return `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  status: queued\n  attempts: 0\n  depends_on: []\n${extra}`;
}

function scratch(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13669-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A plan directory: a monolith with one task and `count` one-task shards. Returns the monolith path. */
function planDir(dir: string, count: number): string {
  mkdirSync(join(dir, "tasks.d"), { recursive: true });
  const monolith = join(dir, "tasks.yaml");
  writeFileSync(monolith, shard("W1-T0"));
  for (let i = 1; i <= count; i++) writeFileSync(join(dir, "tasks.d", `W1-T${i}.yaml`), shard(`W1-T${i}`));
  return monolith;
}

const view = (plan: { tasks: Array<{ id: string; sourcePath?: string }> }) => plan.tasks.map((t) => [t.id, t.sourcePath]);

function thrown(fn: () => unknown): PlanError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PlanError, String(err));
    return err;
  }
  assert.fail("expected a PlanError");
}

test("W1-T13669 criterion 1: a second load over one changed shard of 200 parses only that shard", (t) => {
  const path = planDir(scratch(t), 200);
  const cache = new PlanBlobCache();
  const first = loadPlanReusingParses(path, cache);
  assert.equal(first.tasks.length, 201);
  assert.equal(cache.parsedBlobs, 201, "the monolith and all 200 shards are parsed on the first call");
  assert.equal(cache.reusedBlobs, 0);
  writeFileSync(join(path, "..", "tasks.d", "W1-T77.yaml"), shard("W1-T77", "  priority: 2\n"));
  const second = loadPlanReusingParses(path, cache);
  assert.equal(cache.parsedBlobs, 1, "only the changed shard is parsed again");
  assert.equal(cache.reusedBlobs, 200);
  assert.equal(second.byId.get("W1-T77")?.priority, 2, "the changed shard's new content is read");
});

test("W1-T13669 criterion 2: the loader returns loadPlan's plan and throws loadPlan's errors, also on reused parses", (t) => {
  const dir = scratch(t);
  const path = planDir(dir, 5);
  const shards = join(dir, "tasks.d");
  const cache = new PlanBlobCache();
  assert.deepEqual(loadPlanReusingParses(path, cache), loadPlan(path));
  const reused = loadPlanReusingParses(path, cache);
  assert.equal(cache.reusedBlobs, 6);
  assert.deepEqual(reused, loadPlan(path), "a reused parse gives the same tasks, order and sourcePath");
  assert.deepEqual(view(reused), view(loadPlan(path)));

  writeFileSync(join(shards, "W1-T6.yaml"), shard("W1-T3"));
  const duplicate = thrown(() => loadPlan(path)).message;
  assert.match(duplicate, /duplicate task id 'W1-T3'/);
  assert.equal(thrown(() => loadPlanReusingParses(path, cache)).message, duplicate, "a duplicate across shards throws");
  assert.equal(thrown(() => loadPlanReusingParses(path, cache)).message, duplicate, "and throws again when every text was seen before");
  unlinkSync(join(shards, "W1-T6.yaml"));

  writeFileSync(join(shards, "W1-T7.yaml"), "- id: W1-T7\n  title: [unclosed\n");
  const invalid = thrown(() => loadPlan(path)).message;
  assert.equal(thrown(() => loadPlanReusingParses(path, cache)).message, invalid, "a shard that is not valid YAML throws");
  assert.equal(thrown(() => loadPlanReusingParses(path, cache)).message, invalid, "and throws again for the same text");
  unlinkSync(join(shards, "W1-T7.yaml"));

  unlinkSync(join(shards, "W1-T2.yaml"));
  const removed = loadPlanReusingParses(path, cache);
  assert.equal(removed.byId.has("W1-T2"), false, "a removed shard is gone from the result");
  assert.deepEqual(removed, loadPlan(path));

  const torn = join(shards, "W1-T4.yaml");
  const realRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", ((file: fs.PathOrFileDescriptor, options?: unknown) => {
    const text = realRead(file, options as BufferEncoding);
    return file === torn ? String(text).slice(0, 20) : text;
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  try {
    assert.match(thrown(() => loadPlanReusingParses(path, cache)).message, /cannot read plan shard .*short\/torn read/, "a torn read is refused");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(loadPlanReusingParses(path, cache), loadPlan(path));
});

function effectsFor(root: string) {
  return buildSweepEffects({
    owner: "craigoley", repo: "t13669-fixture", config: { root } as never, ledgerPath: join(root, "ledger.ndjson"),
    runId: "RUN-t13669", plan: { tasks: [], byId: new Map() }, log: () => {}, policy: undefined,
    reviewRunner: undefined, spawnImpl: undefined, pushEmptyCommit: undefined, issuesImpl: undefined,
    stallNotice: undefined, armImpl: undefined, armSessionPrsOverride: undefined, updateBranchImpl: undefined,
    captureRepairFeedbackImpl: undefined, ghRunImpl: undefined, spawnWallClockBoundMsOverride: undefined,
    reclaimWorkerImpl: undefined,
  } as never);
}

test("W1-T13669 criterion 3: the sweep's default plan re-read reuses its parses across sweeps and sees a new shard", (t) => {
  const root = scratch(t);
  const planRoot = join(root, "plan");
  const path = planDir(planRoot, 20);
  const first = effectsFor(root).readTaskContractRevision!("W1-T5");
  assert.equal(typeof first, "string", "a task not in the tick's plan is found by the re-read");
  assert.equal(FIX_PLAN_BLOB_CACHE.parsedBlobs, 21, "the first sweep parses the monolith and every shard");
  const second = effectsFor(root).readTaskContractRevision!("W1-T5");
  assert.equal(second, first);
  assert.equal(FIX_PLAN_BLOB_CACHE.parsedBlobs, 0, "the next sweep parses nothing when no file changed");
  assert.equal(FIX_PLAN_BLOB_CACHE.reusedBlobs, 21);

  assert.equal(effectsFor(root).readTaskContractRevision!("W1-T99"), undefined, "a task with no shard is not found");
  writeFileSync(join(path, "..", "tasks.d", "W1-T99.yaml"), shard("W1-T99"));
  assert.equal(typeof effectsFor(root).readTaskContractRevision!("W1-T99"), "string", "a shard added between sweeps is found");
  assert.equal(FIX_PLAN_BLOB_CACHE.parsedBlobs, 1, "only the new shard is parsed");
});
