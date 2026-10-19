// test/the-run-child-plan-snapshot-is-handed-over-not-kept.test.ts — the seams behind a run child's setup release:
// the plan snapshot it hands to runTask once, and the measurement around its agent-wait collection.
// The end-to-end falsifier is test/a-run-child-releases-its-setup-before-the-agent-wait.test.ts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { collectAtAgentWait } from "#src/lib/agent-wait-heap.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { planSnapshotHandOver } from "#src/run-child-main.js";

const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}plan-hand-over-`));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the plan snapshot is handed over once, read again on a later ask, and an unreadable file is named", () => {
  const path = join(dir, "snapshot.json");
  writeFileSync(path, JSON.stringify({ schema: 1, tasks: [{ id: "T-1" }, { id: "T-2" }] }));
  const handOver = planSnapshotHandOver(path);
  assert.ok("planSnapshot" in handOver);
  const first = handOver.planSnapshot({});
  assert.deepEqual([...first.plan.byId.keys()], ["T-1", "T-2"]);
  assert.equal(first.staleDispatch, false);
  writeFileSync(path, JSON.stringify({ schema: 1, tasks: [{ id: "T-3" }] }));
  assert.deepEqual(handOver.planSnapshot({}).plan.tasks, [{ id: "T-3" }], "a second ask reads the file, it kept nothing");
  rmSync(path);
  assert.throws(() => handOver.planSnapshot({}), /plan snapshot .* unreadable/);
  assert.match((planSnapshotHandOver(path) as { error: string }).error, /unreadable/, "a first read that fails is the caller's to report");
});

test("the agent-wait collection measures the heap around one collection", async () => {
  const used = [300, 120];
  let collected = 0;
  const clock = [10, 55];
  const heap = await collectAtAgentWait({
    heap: () => ({ used_heap_size: used.shift() ?? 0, total_heap_size: 200 }),
    collect: async () => { collected += 1; },
    clock: () => clock.shift() ?? 0,
    rss: () => 400,
    maxRssBytes: () => 900,
  });
  assert.equal(collected, 1);
  assert.deepEqual(heap, {
    heap_used_before_bytes: 300, heap_used_after_bytes: 120, heap_total_after_bytes: 200, rss_after_bytes: 400, max_rss_bytes: 900, collect_ms: 45,
  });
  await assert.rejects(collectAtAgentWait({ collect: () => Promise.reject(new Error("no measure")) }), /no measure/);
});
