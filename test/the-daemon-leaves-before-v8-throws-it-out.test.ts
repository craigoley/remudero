import assert from "node:assert/strict";
import test from "node:test";

import {
  DAEMON_EXIT_STALE,
  HEAP_PRESSURE_RESTART_FRACTION,
  daemonExitCode,
  heapPressureDetail,
  v8HeapStatistics,
} from "../src/lib/daemon.js";

// ── W1-T3335 — THE DAEMON LEAVES BEFORE V8 THROWS IT OUT ──────────────────────────────────────
//
// MEASURED on the fleet host 2026-09-10, from `docker logs` and `docker inspect`:
//
//   FATAL ERROR: Ineffective mark-compacts near heap limit
//   Mark-Compact (reduce) 8184.4 (8213.4) -> 8183.8 (8205.9) MB   at 197,561 ms
//   Mark-Compact (reduce) 8188.7 (8212.3) -> 8187.7 (8209.0) MB   at 184,391 ms
//   rmd-entrypoint: exited 134 — sleeping 120s before exiting
//   RestartCount=21   NODE_OPTIONS=--max-old-space-size=8192   RMD_RESTART_THROTTLE_S=120
//
// So the process lived 184-197 SECONDS and then paid 120 more asleep. Any pass needing longer than
// three minutes could not finish, which is why the queue advanced in fragments and PRs took hours.
// This does NOT fix the leak. It changes an abort that loses in-flight work into a restart taken at
// a tick boundary, on the exit code the entrypoint already treats as a non-crash.

const LIMIT = 8_589_934_592; // what --max-old-space-size=8192 reports back

test("W1-T3335: a heap at the fleet's own death point asks for a restart, naming what it saw", () => {
  const detail = heapPressureDetail({ used_heap_size: 8_188 * 1e6, heap_size_limit: LIMIT });
  assert.ok(detail, "8,188 MB against an 8,589 MB limit is exactly the state that aborted 21 times");
  assert.match(detail, /heap at 9\d% of V8's 8590 MB limit/, "the detail must carry the numbers an operator would check");
  assert.match(detail, /tick boundary/, "and must say the restart was taken deliberately, not suffered");
});

test("W1-T3335: an idle heap does NOT ask for a restart — the guard must not degrade into 'always restart'", () => {
  // The control that matters. An arm that fired unconditionally would satisfy the test above and
  // turn the daemon into a boot loop that never dispatches anything at all.
  assert.equal(heapPressureDetail({ used_heap_size: 200 * 1e6, heap_size_limit: LIMIT }), undefined);
  assert.equal(heapPressureDetail({ used_heap_size: LIMIT * (HEAP_PRESSURE_RESTART_FRACTION - 0.01), heap_size_limit: LIMIT }), undefined);
});

test("W1-T3335: the boundary is inclusive, and is read from the limit rather than a byte literal", () => {
  assert.ok(heapPressureDetail({ used_heap_size: LIMIT * HEAP_PRESSURE_RESTART_FRACTION, heap_size_limit: LIMIT }));
  // A DIFFERENT cap must move the trigger with it. A megabyte literal would fail this: the same
  // used-bytes figure is pressure under a small cap and nothing under a large one.
  const small = 1_000_000_000;
  assert.ok(heapPressureDetail({ used_heap_size: 800 * 1e6, heap_size_limit: small }), "800MB of a 1GB cap is pressure");
  assert.equal(heapPressureDetail({ used_heap_size: 800 * 1e6, heap_size_limit: LIMIT }), undefined, "the same 800MB of an 8.5GB cap is not");
});

test("W1-T3335: an unreadable heap limit is NOT pressure — failing the other way is a permanent boot loop", () => {
  for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(heapPressureDetail({ used_heap_size: 5e9, heap_size_limit: limit }), undefined, `limit ${limit} must not trigger`);
  }
  assert.equal(heapPressureDetail({ used_heap_size: Number.NaN, heap_size_limit: LIMIT }), undefined);
});

test("W1-T3335: the restart is spent from the NON-CRASH budget, and a real crash still is not", () => {
  assert.equal(daemonExitCode("heap_pressure"), DAEMON_EXIT_STALE, "75 is the code the entrypoint restarts in-container, without the 120s throttle");
  // The control: this must not have made everything a non-crash. A genuine error stays countable.
  assert.equal(daemonExitCode("error"), 1);
});

test("W1-T3335: the default reader returns V8's real numbers, so the seam cannot be wired to nothing", () => {
  const s = v8HeapStatistics();
  assert.ok(Number.isFinite(s.heap_size_limit) && s.heap_size_limit > 0, "a real limit");
  assert.ok(Number.isFinite(s.used_heap_size) && s.used_heap_size > 0, "a real usage");
  assert.ok(s.used_heap_size < s.heap_size_limit, "this test process is not itself at the limit");
});
