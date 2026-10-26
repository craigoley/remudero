import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { automatedRetroGatherObserver } from "#src/lib/retro-subprocess.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("an automated retro records real memory around one synchronous gather read without retaining its content", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}retro-phase-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input.json");
  writeFileSync(input, JSON.stringify({ secret: "PRIVATE_GATHER_INPUT" }));
  const rows: Record<string, unknown>[] = [];
  const observe = automatedRetroGatherObserver(true, { log: (step, fields) => rows.push({ step, ...fields }) });
  let reads = 0;
  const value = observe("followup-ledger", () => { reads++; return JSON.parse(readFileSync(input, "utf8")); });
  assert.deepEqual(value, { secret: "PRIVATE_GATHER_INPUT" });
  assert.equal(reads, 1);
  assert.deepEqual(rows.map(r => [r.step, r.phase, r.phase_state]), [
    ["retro.gather.phase", "followup-ledger", "entered"], ["retro.gather.phase", "followup-ledger", "returned"],
  ]);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["array_buffers_bytes", "duration_ms", "external_bytes", "heap_total_bytes",
      "heap_used_bytes", "phase", "phase_state", "rss_bytes", "step"]);
    for (const key of ["duration_ms", "rss_bytes", "heap_used_bytes", "heap_total_bytes", "external_bytes", "array_buffers_bytes"])
      assert.ok(typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0, key);
    assert.ok(Number(row.rss_bytes) > 0);
  }
  assert.ok(!JSON.stringify(rows).includes("PRIVATE_GATHER_INPUT"));
});

test("a failed gather read retains its original exception and records threw without error content", () => {
  const rows: Record<string, unknown>[] = [];
  const original = new Error("PRIVATE_FAILURE_CONTENT");
  const observe = automatedRetroGatherObserver(true, { log: (step, fields) => rows.push({ step, ...fields }) });
  assert.throws(() => observe("gather", () => { throw original; }), error => error === original);
  assert.deepEqual(rows.map(r => r.phase_state), ["entered", "threw"]);
  assert.ok(!JSON.stringify(rows).includes("PRIVATE_FAILURE_CONTENT"));
});

test("manual gather bypasses all observation and preserves the original return identity", () => {
  const original = { report: "original" };
  const forbidden = () => { assert.fail("manual read must not enter diagnostics"); };
  const observe = automatedRetroGatherObserver(false, { log: forbidden, now: forbidden, memoryUsage: forbidden, warn: forbidden });
  assert.equal(observe("report", () => original), original);
});

test("a refusing phase recorder never reruns the gather read or replaces its failure", () => {
  const warnings: string[] = [];
  const original = new Error("read failed");
  const observe = automatedRetroGatherObserver(true, {
    log: () => { throw new Error("PRIVATE_LOGGER_FAILURE"); }, warn: message => warnings.push(message),
  });
  let reads = 0;
  assert.throws(() => observe("plan-projection", () => { reads++; throw original; }), error => error === original);
  assert.equal(reads, 1);
  assert.deepEqual(warnings, ["### [retro] gather phase observation unavailable", "### [retro] gather phase observation unavailable"]);
});

test("the real default memory reader can fail without preventing the gather operation", (t) => {
  t.mock.method(process, "memoryUsage", () => { throw new Error("PRIVATE_MEMORY_FAILURE"); });
  const warnings: string[] = [];
  t.mock.method(console, "error", (message: string) => warnings.push(message));
  const observe = automatedRetroGatherObserver(true, { log: () => assert.fail("no snapshot was available") });
  assert.equal(observe("net-state", () => 17), 17);
  assert.deepEqual(warnings, ["### [retro] gather phase observation unavailable", "### [retro] gather phase observation unavailable"]);
});

test("an unavailable default warning sink preserves the original operation result and exception", (t) => {
  t.mock.method(process, "memoryUsage", () => { throw new Error("memory unavailable"); });
  t.mock.method(console, "error", () => { throw new Error("warning sink unavailable"); });
  const observe = automatedRetroGatherObserver(true, { log: () => assert.fail("no snapshot was available") });
  const original = new Error("original read failure");
  assert.equal(observe("gather", () => 23), 23);
  assert.throws(() => observe("gather", () => { throw original; }), error => error === original);
});

test("gather phase duration uses the supplied clock and never reports a negative interval", () => {
  const rows: Record<string, unknown>[] = [], times = [100, 112, 90, 89];
  const observe = automatedRetroGatherObserver(true, { log: (_step, fields) => rows.push(fields!), now: () => times.shift()!,
    memoryUsage: () => ({ rss: 5, heapUsed: 3, heapTotal: 4, external: 1, arrayBuffers: 0 }) });
  observe("gather", () => null);
  observe("report", () => null);
  assert.deepEqual(rows.map(r => r.duration_ms), [0, 12, 0, 0]);
});

test("the automated retro wires stage observation into its real gather calls and excludes dry runs", () => {
  const source = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
  const start = source.indexOf("async function retroCommand("), end = source.indexOf("const report = reportWithoutPromotion", start);
  assert.ok(start >= 0 && end > start, "real retro command population control");
  const command = source.slice(start, end);
  assert.ok(command.includes("automatedRetroGatherObserver(opts.automated !== undefined && !dryRun"));
  for (const [phase, call] of [["followup-ledger", "followupLedgerUnionNdjson"], ["gather", "buildGather"],
    ["net-state", "netStateAdvisorySectionFor"], ["plan-projection", "projectPlan"]])
    assert.ok(command.includes(`observeGather("${phase}", () => ${call}(`), `live ${phase} call`);
  for (const phase of ["plan-inputs", "report"]) assert.ok(command.includes(`observeGather("${phase}",`), phase);
});
