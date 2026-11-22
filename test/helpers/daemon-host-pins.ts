import type { DaemonDeps } from "#src/lib/daemon.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";

/** Give each daemon run its own governor and fixed heap, clock and boot checkout readings. */
export function hostIndependentDaemonDeps(): Required<
  Pick<DaemonDeps, "memoryGovernor" | "heapStatistics" | "now" | "selectionTimingNow" | "bootCheckoutBlocked">
> {
  return {
    memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {}, heapUsed: () => 1 }),
    heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
    now: () => new Date(Date.UTC(2026, 0, 1)),
    // W1-T13286: the selection-timing row reads its own clock; pinned so two runs write the same ledger.
    selectionTimingNow: () => 0,
    bootCheckoutBlocked: "",
  };
}
