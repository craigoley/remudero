/**
 * W1-T13828: after a restart on 2026-11-19, serve's top main-loop stall frames were incident-invariants.ts
 * evaluateIncidentInvariants, rowsSince and rowTimeMs: every minute, each of the eight rules filtered the whole live
 * tail twice and parsed every row's time again, and the tail held and parsed every ledger line, not only the steps
 * the rules read.
 */
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DAEMON_LOOP_SILENT_RULE_ID, evaluateIncidentInvariants, INCIDENT_INPUT_LINE, INCIDENT_RULE_INPUTS } from "#src/lib/incident-invariants.js";
import { createLiveLedgerTail } from "#src/lib/live-ledger-tail.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

/** Rows that trip the loop-lag rule in both windows, and many rows no rule reads. */
function rows(noise: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let m = 14; m >= 0; m--) out.push({ ts: at(m), step: "runtime.loop_lag", p99Ms: 5_000 });
  for (let i = 0; i < noise; i++) out.push({ ts: at(i % 600), step: "spawn.routed", via: "helper" });
  return out;
}

function parses(t: TestContext, fn: () => void): number {
  const spy = t.mock.method(Date, "parse");
  try {
    fn();
    return spy.mock.callCount();
  } finally {
    spy.mock.restore();
  }
}

test("W1-T13828: a rule reads only its inputs, and a row's time is parsed once across evaluations", (t) => {
  const plain = rows(0), noisy = rows(5_000);
  const expected = evaluateIncidentInvariants(plain, NOW).map((finding) => finding.ruleId);
  assert.ok(expected.includes("loop-lag"), "positive control: the loop-lag rule fires");
  let first: string[] = [];
  const cold = parses(t, () => { first = evaluateIncidentInvariants(noisy, NOW).map((finding) => finding.ruleId); });
  assert.deepEqual(first, expected, "rows no rule reads change no finding");
  assert.equal(cold, plain.length, "only the rules' input rows had their time parsed");
  const warm = parses(t, () => evaluateIncidentInvariants(noisy, NOW));
  assert.equal(warm, 0, "a second evaluation over the same rows parses no time again");
});

test("W1-T13828: invariant:inputs-kept — the tail's line filter keeps every input of every rule", () => {
  for (const [rule, inputs] of Object.entries(INCIDENT_RULE_INPUTS)) {
    for (const input of inputs) {
      const step = input.startsWith("*") ? `pr.merge${input.slice(1)}` : input.endsWith("*") ? `${input.slice(0, -1)}tick` : input;
      const compact = JSON.stringify({ ts: at(0), step });
      const spaced = ` { "ts" : "${at(0)}" , "step"\t:\t ${JSON.stringify(step)} } `;
      for (const line of [compact, spaced]) {
        assert.ok(INCIDENT_INPUT_LINE.test(line), `${rule} input ${input} (${step}) is kept in ${line}`);
      }
    }
  }
  assert.equal(INCIDENT_INPUT_LINE.test(JSON.stringify({ ts: at(0), step: "spawn.routed" })), false);
  assert.ok(INCIDENT_INPUT_LINE.test(String.raw`{"st\u0065p":"runtime\u002eloop_lag"}`));
  assert.ok(INCIDENT_INPUT_LINE.test(String.raw`{"step":"daemon.\"\n"}`));
  assert.ok(INCIDENT_INPUT_LINE.test(String.raw`{"step":"escaped\\u1234\t_refused"}`));
  assert.ok(INCIDENT_INPUT_LINE.test('{"step":"spawn.routed","step":"runtime.loop_lag"}'));
  assert.equal(INCIDENT_INPUT_LINE.test('{"step":"runtime.loop_lag","step":null}'), false);
  assert.equal(INCIDENT_INPUT_LINE.test('{"step":"runtime.loop_lag","step":"spawn.routed"}'), false);
  assert.equal(INCIDENT_INPUT_LINE.test('[{"step":"runtime.loop_lag"}]'), false);
});

test("W1-T13828: invariant:inputs-kept — a spaced daemon pulse prevents a false silence finding", (t) => {
  const path = join(ownedFixtureDir(t, "incident-inputs").dir, "ledger.ndjson");
  const loopLag = JSON.stringify(rows(0).at(-1));
  const pulse = `{"data":[{"step":"spawn.routed"}],"ts":"${at(0)}","step": "daemon.pulse"}`;
  const tail = createLiveLedgerTail(path, 60 * 60_000, { keepLine: INCIDENT_INPUT_LINE });
  writeFileSync(path, loopLag + "\n");
  assert.ok(evaluateIncidentInvariants(tail(NOW), NOW).some((f) => f.ruleId === DAEMON_LOOP_SILENT_RULE_ID));
  appendFileSync(path, pulse + "\n");
  assert.deepEqual(evaluateIncidentInvariants(tail(NOW), NOW), evaluateIncidentInvariants(
    [JSON.parse(loopLag), JSON.parse(pulse)], NOW,
  ));
  assert.ok(!evaluateIncidentInvariants(tail(NOW), NOW).some((f) => f.ruleId === DAEMON_LOOP_SILENT_RULE_ID));
});

test("W1-T13828: a tail with a line filter parses and holds only the kept lines, and parses each time once", (t) => {
  const path = join(ownedFixtureDir(t, "incident-tail").dir, "ledger.ndjson");
  const nested = JSON.stringify({ ts: at(0), step: "spawn.routed", data: [{ step: "runtime.loop_lag" }] });
  const quoted = JSON.stringify({ ts: at(0), step: 'spawn."daemon.pulse"', data: '"step":"runtime.loop_lag"' });
  const ledger = rows(2_000).map((row) => JSON.stringify(row));
  writeFileSync(path, [...ledger, quoted, nested, nested].join("\n"));
  const tail = createLiveLedgerTail(path, 24 * 60 * 60_000, { keepLine: INCIDENT_INPUT_LINE });
  const parse = t.mock.method(JSON, "parse");
  const held = tail(NOW);
  const parsedLines = parse.mock.callCount();
  parse.mock.restore();
  assert.equal(held.length, 15, "only the loop-lag rows are held");
  assert.ok(held.every((row) => row.step === "runtime.loop_lag"));
  assert.equal(parsedLines, 15, "nested steps in both complete and pending lines are skipped before parsing");
  const newRow = JSON.stringify({ ts: at(0), step: "runtime.loop_lag", p99Ms: 1 });
  appendFileSync(path, `\n${newRow}\n`);
  const again = parses(t, () => assert.equal(tail(NOW).length, 16));
  assert.equal(again, 1, "only the new row's time was parsed");
});

test("W1-T13828: a tail with a line filter parses and holds only the kept lines with global or sticky flags", (t) => {
  const path = join(ownedFixtureDir(t, "incident-tail-regexp").dir, "ledger.ndjson");
  const row = JSON.stringify({ step: "runtime.loop_lag", ts: at(0) });
  writeFileSync(path, [row, row, row].join("\n"));
  for (const keepLine of [/^\{"step":"runtime\.loop_lag"/g, /^\{"step":"runtime\.loop_lag"/y]) {
    keepLine.lastIndex = 3;
    const tail = createLiveLedgerTail(path, 60 * 60_000, { keepLine });
    assert.deepEqual(tail(NOW), [JSON.parse(row), JSON.parse(row), JSON.parse(row)]);
    assert.equal(keepLine.lastIndex, 3, "the caller's regex state is preserved");
  }
});
