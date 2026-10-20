// src/lib/agent-wait-heap.ts — a run child collects its heap at the start of each agent wait, and says what it freed.
//
// WHY: OBSERVED 2026-10-19 (logs-8864/mempress-*), the W1-T9338 run child peaked at 915 MB, then sat 1 h waiting on its
// agent with 48 MB resident and 565 MB in swap, 29 s of CPU. A wait allocates almost nothing, so no GC comes to take the
// setup garbage, and the kernel swaps it out instead. runTask drops its setup plan before the first wait (releasePlan in
// src/run-task.ts); this module then starts one full collection through `vm.measureMemory` with `execution: "eager"`,
// the documented Node API whose eager mode starts a GC at once. It never sets `--expose-gc`.
//
// FALSIFIER: test/worker/a-run-child-releases-its-setup-before-the-agent-wait.test.ts.
import { getHeapStatistics } from "node:v8";
import { measureMemory } from "node:vm";

/** The row a run child writes at the start of each agent wait: the heap before and after its collection. */
export const RUN_AGENT_WAIT_HEAP_STEP = "run.agent_wait_heap";

export interface AgentWaitHeap {
  heap_used_before_bytes: number;
  heap_used_after_bytes: number;
  heap_total_after_bytes: number;
  rss_after_bytes: number;
  /** The process's resident high-water mark so far. */
  max_rss_bytes: number;
  collect_ms: number;
}

export interface AgentWaitHeapIo {
  heap?: () => { used_heap_size: number; total_heap_size: number };
  collect?: () => Promise<unknown>;
  rss?: () => number;
  maxRssBytes?: () => number;
  clock?: () => number;
}

/** Collects once and measures around it. Rejects only when the collection itself does; the caller ledgers that. */
export async function collectAtAgentWait(io: AgentWaitHeapIo = {}): Promise<AgentWaitHeap> {
  const heap = io.heap ?? getHeapStatistics;
  const clock = io.clock ?? (() => performance.now());
  const before = heap().used_heap_size;
  const start = clock();
  await (io.collect ?? (() => measureMemory({ mode: "summary", execution: "eager" })))();
  const collectMs = Math.round(clock() - start);
  const after = heap();
  return {
    heap_used_before_bytes: before,
    heap_used_after_bytes: after.used_heap_size,
    heap_total_after_bytes: after.total_heap_size,
    rss_after_bytes: (io.rss ?? (() => process.memoryUsage.rss()))(),
    max_rss_bytes: (io.maxRssBytes ?? (() => process.resourceUsage().maxRSS * 1024))(),
    collect_ms: collectMs,
  };
}
