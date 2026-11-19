// AN EXITED PROCESS COSTS THE TREE WALK NOTHING. Every shadow reading walks the reservation trees under one shared cap of
// MAX_TREE_PROCESSES reads; a tree reached after the cap is reported partial and adds an uncertainty margin.
// OBSERVED 2026-11-19 04:36Z inside the Azure core container: 15 reservation files recorded 3270 identities, 68 of them
// alive (one implement entry alone recorded 2406). The exited identities spent the cap, so at 04:25Z nine trees read
// "process cap 1024", and their margins helped drive host_base_available_mib to -957 at 04:24Z (lane target 1).

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TREE_PROCESSES, residentsOf } from "#src/lib/host-memory-shadow.js";

const stat = (pid: number, start: number): string => `${pid} (node) S 1 ${"0 ".repeat(17)}${start} 0 0`;
const status = (rssKb: number): string => `Name:\tnode\nVmRSS:\t ${rssKb} kB\nVmSwap:\t 0 kB\n`;

function world(trees: Array<{ path: string; dead: number; live: number[] }>): (path: string) => string {
  const files: Record<string, string> = {};
  let deadPid = 100_000;
  for (const t of trees) {
    const ids = [...t.live.map((pid) => ({ pid, start: `proc:${pid}` }))];
    for (let i = 0; i < t.dead; i++) ids.push({ pid: deadPid++, start: "proc:1" });
    files[t.path] = JSON.stringify({ roots: ids.slice(0, 1), tree: ids });
    for (const pid of t.live) {
      files[`/proc/${pid}/stat`] = stat(pid, pid);
      files[`/proc/${pid}/status`] = status(100 * 1024);
    }
  }
  return (path) => {
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return text;
  };
}

test("exited processes recorded past the cap leave every later tree complete", () => {
  const read = world([
    { path: "/ledger/old-implement.json", dead: MAX_TREE_PROCESSES * 2 + 358, live: [10, 11] },
    { path: "/ledger/fix.json", dead: 300, live: [20] },
    { path: "/ledger/review.json", dead: 0, live: [30, 31, 32] },
  ]);
  const residents = residentsOf(read, ["/ledger/old-implement.json", "/ledger/fix.json", "/ledger/review.json"]);
  assert.deepEqual(residents, [{ mib: 200, complete: true }, { mib: 100, complete: true }, { mib: 300, complete: true }]);
});

test("live processes past the cap still read partial", () => {
  const live = Array.from({ length: MAX_TREE_PROCESSES + 1 }, (_, i) => 1000 + i);
  const read = world([{ path: "/ledger/wide.json", dead: 0, live }]);
  const [wide] = residentsOf(read, ["/ledger/wide.json"]);
  assert.equal("complete" in wide! && wide.complete, false, "the cap still bounds live reads");
  assert.match(String((wide as { reason?: string }).reason), /process cap/);
});
