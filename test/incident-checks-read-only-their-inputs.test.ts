/**
 * W1-T13828: after a restart on 2026-11-19, serve's top main-loop stall frames were incident-invariants.ts
 * evaluateIncidentInvariants, rowsSince and rowTimeMs: every minute, each of the eight rules filtered the whole live
 * tail twice and parsed every row's time again, and the tail held and parsed every ledger line, not only the steps
 * the rules read.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateIncidentInvariants, INCIDENT_INPUT_LINE, INCIDENT_RULE_INPUTS } from "#src/lib/incident-invariants.js";
import { createLiveLedgerTail } from "#src/lib/live-ledger-tail.js";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

/** Rows that trip the loop-lag rule in both windows, and many rows no rule reads. */
function rows(noise: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let m = 14; m >= 0; m--) out.push({ ts: at(m), step: "runtime.loop_lag", p99Ms: 5_000 });
  for (let i = 0; i < noise; i++) out.push({ ts: at(i % 600), step: "spawn.routed", via: "helper" });
  return out;
}

function parses(t: { mock: { method: typeof import("node:test").mock.method } }, fn: () => void): number {
  const spy = t.mock.method(Date, "parse");
  try { fn(); return spy.mock.callCount(); } finally { spy.mock.restore(); }
}

test("W1-T13828: a rule reads only its inputs, and a row's time is parsed once across evaluations", (t) => {
  const plain = rows(0), noisy = rows(5_000);
  const expected = evaluateIncidentInvariants(plain, NOW).map((finding) => finding.ruleId);
  assert.ok(expected.includes("loop-lag"), "positive control: the loop-lag rule fires");
  let first: string[] = [];
  const cold = parses(t as never, () => { first = evaluateIncidentInvariants(noisy, NOW).map((finding) => finding.ruleId); });
  assert.deepEqual(first, expected, "rows no rule reads change no finding");
  assert.ok(cold <= plain.length + 5, `only the rules' input rows had their time parsed (${cold} for ${noisy.length} rows)`);
  const warm = parses(t as never, () => evaluateIncidentInvariants(noisy, NOW));
  assert.equal(warm, 0, "a second evaluation over the same rows parses no time again");
});

test("W1-T13828: invariant:inputs-kept — the tail's line filter keeps every input of every rule", () => {
  for (const [rule, inputs] of Object.entries(INCIDENT_RULE_INPUTS)) {
    for (const input of inputs) {
      const step = input.startsWith("*") ? `pr.merge${input.slice(1)}` : input.endsWith("*") ? `${input.slice(0, -1)}tick` : input;
      assert.ok(INCIDENT_INPUT_LINE.test(JSON.stringify({ ts: at(0), step })), `${rule} input ${input} (${step}) is kept`);
    }
  }
  assert.equal(INCIDENT_INPUT_LINE.test(JSON.stringify({ ts: at(0), step: "spawn.routed" })), false);
});

test("W1-T13828: a tail with a line filter parses and holds only the kept lines, and parses each time once", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-incident-tail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, rows(2_000).map((row) => `${JSON.stringify(row)}\n`).join(""));
  const tail = createLiveLedgerTail(path, 24 * 60 * 60_000, { keepLine: INCIDENT_INPUT_LINE });
  const parse = t.mock.method(JSON, "parse");
  const held = tail(NOW);
  const parsedLines = parse.mock.callCount();
  parse.mock.restore();
  assert.equal(held.length, 15, "only the loop-lag rows are held");
  assert.ok(held.every((row) => row.step === "runtime.loop_lag"));
  assert.ok(parsedLines <= 16, `only the kept lines were parsed (${parsedLines})`);
  appendFileSync(path, `${JSON.stringify({ ts: at(0), step: "runtime.loop_lag", p99Ms: 1 })}\n`);
  const again = parses(t as never, () => assert.equal(tail(NOW).length, 16));
  assert.ok(again <= 2, `only the new row's time was parsed (${again})`);
});
