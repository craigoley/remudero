import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import {
  ledgerSelectedRegistryReadTimeouts,
  readSelectedInstanceRegistry,
  setSelectedRegistryReadTimeoutObserver,
  type RegistryFileIO,
  type RegistryFileStamp,
  type SelectedRegistryReadTimeoutTrace,
} from "#src/lib/instance-registry-selection.js";

const PATH = "/fixture-private/selected-registry.yaml";
const TEXT = "instances:\n  fixture:\n    github_repo: owner/private-repo\n    mode: live\n";

function stampOf(size: number): RegistryFileStamp {
  return { regular: true, size, dev: 7, ino: 11, mtimeMs: 1000, ctimeMs: 1000, nlink: 1 };
}

/** A fake file port: every hop settles on the next check phase, one byte per read when asked. */
function fakeIO(bytes: Buffer, opts: { openNeverSettles?: boolean; bytePerRead?: boolean } = {}): RegistryFileIO {
  const later = <T>(value: T) => new Promise<T>((resolve) => setImmediate(() => resolve(value)));
  return {
    lstat: () => later(stampOf(bytes.length)),
    canonicalPath: (path) => later(path),
    open: () => opts.openNeverSettles ? new Promise(() => {}) : later({
      stat: () => later(stampOf(bytes.length)),
      read: (buffer, offset, length, position) => {
        const n = Math.max(0, Math.min(opts.bytePerRead ? 1 : length, bytes.length - position));
        bytes.copy(buffer, offset, position, position + n);
        return later(n);
      },
      close: () => later(undefined),
    }),
  };
}

function captureTraces(t: TestContext): SelectedRegistryReadTimeoutTrace[] {
  const traces: SelectedRegistryReadTimeoutTrace[] = [];
  const previous = setSelectedRegistryReadTimeoutObserver((trace) => { traces.push(trace); });
  t.after(() => { setSelectedRegistryReadTimeoutObserver(previous); });
  return traces;
}

test("W1-T11605 criterion 1: a read whose open never settles times out and names open as its pending hop", async (t) => {
  const traces = captureTraces(t);
  const read = await readSelectedInstanceRegistry({ cliPath: PATH, timeoutMs: 100 }, fakeIO(Buffer.from(TEXT), { openNeverSettles: true }));
  assert.deepEqual(read, { kind: "unknown", reason: "timeout" });
  assert.equal(traces.length, 1, "exactly one trace reaches the sink");
  const trace = traces[0]!;
  assert.ok(Object.isFrozen(trace));
  assert.equal(trace.subject, "registry");
  assert.equal(trace.pending_hop, "open");
  assert.equal(trace.hops_completed, 1);
  assert.equal(trace.hop_ms.length, 1);
  assert.equal(trace.hop_ms[0]!.hop, "lstat");
  assert.equal(typeof trace.hop_ms[0]!.ms, "number");
  assert.ok(Number.isFinite(trace.hop_ms[0]!.ms) && trace.hop_ms[0]!.ms >= 0);
  assert.equal(trace.max_hop_ms, trace.hop_ms[0]!.ms);
  assert.equal(trace.budget_ms, 100);
  assert.ok(trace.wall_ms >= 99, `wall ${trace.wall_ms} spans the budget`);
  assert.ok(trace.concurrent_reads >= 1);
  assert.ok(trace.loop_active_ms >= 0 && trace.loop_idle_ms >= 0);
  assert.ok(trace.loop_active_ms + trace.loop_idle_ms <= trace.wall_ms + 1,
    `active ${trace.loop_active_ms} + idle ${trace.loop_idle_ms} fits inside wall ${trace.wall_ms}`);
  const serialized = JSON.stringify(trace);
  assert.ok(!serialized.includes("fixture-private"), "no private path");
  assert.ok(!serialized.includes("private-repo"), "no registry content");
});

test("W1-T11605 criterion 2: a loop held 10 ms each turn still times the read out, and the trace shows a busy loop", async (t) => {
  const traces = captureTraces(t);
  const bytes = Buffer.from(TEXT.padEnd(600, "#"));
  let holding = true;
  const hold = () => {
    if (!holding) return;
    const end = performance.now() + 10;
    while (performance.now() < end) { /* hold the loop for this turn */ }
    setImmediate(hold);
  };
  setImmediate(hold);
  t.after(() => { holding = false; });
  // 10 ms is below the deadline's budget/20 (20 ms) re-arm threshold for a 400 ms budget.
  const read = await readSelectedInstanceRegistry({ cliPath: PATH, timeoutMs: 400, maxBytes: 1024 }, fakeIO(bytes, { bytePerRead: true }));
  holding = false;
  assert.deepEqual(read, { kind: "unknown", reason: "timeout" });
  assert.equal(traces.length, 1);
  const trace = traces[0]!;
  assert.ok(trace.hops_completed > 3, `hops completed ${trace.hops_completed}`);
  assert.equal(trace.hop_ms.length, trace.hops_completed);
  assert.ok(trace.hop_ms.some((h) => h.hop === "read"), "read hops are timed");
  assert.equal(trace.pending_hop, "read");
  assert.ok(trace.loop_active_ms > trace.loop_idle_ms,
    `active ${trace.loop_active_ms} exceeds idle ${trace.loop_idle_ms}`);
});

test("W1-T11605 criterion 3: ledgerSelectedRegistryReadTimeouts writes one row per timed-out read, none for a ready read, and a throwing sink never changes the outcome", async (t) => {
  const rows: { step: string; extra: Record<string, unknown> }[] = [];
  const restore = ledgerSelectedRegistryReadTimeouts((step, extra = {}) => { rows.push({ step, extra }); });
  t.after(restore);
  const ready = await readSelectedInstanceRegistry({ cliPath: PATH, timeoutMs: 1000 }, fakeIO(Buffer.from(TEXT)));
  assert.equal(ready.kind, "ready");
  assert.equal(rows.length, 0, "a ready read writes no row");
  const timedOut = await readSelectedInstanceRegistry({ cliPath: PATH, timeoutMs: 50 }, fakeIO(Buffer.from(TEXT), { openNeverSettles: true }));
  assert.deepEqual(timedOut, { kind: "unknown", reason: "timeout" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.step, "instance_registry.read_timeout");
  assert.equal(rows[0]!.extra.pending_hop, "open");
  assert.equal(rows[0]!.extra.budget_ms, 50);
  assert.ok(!JSON.stringify(rows).includes("fixture-private"));

  const previous = setSelectedRegistryReadTimeoutObserver(() => { throw new Error("sink down"); });
  t.after(() => { setSelectedRegistryReadTimeoutObserver(previous); });
  const despiteSink = await readSelectedInstanceRegistry({ cliPath: PATH, timeoutMs: 50 }, fakeIO(Buffer.from(TEXT), { openNeverSettles: true }));
  assert.deepEqual(despiteSink, { kind: "unknown", reason: "timeout" });
});
