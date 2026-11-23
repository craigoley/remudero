import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { routeOperatorInterventions } from "#src/lib/sre-lane.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const NOW = Date.parse("2026-11-23T00:00:00Z");
const MINUTE = 60_000;

function intervention(target: string, at = NOW - MINUTE) {
  const ts = new Date(at).toISOString();
  return {
    ts,
    at: ts,
    step: "operator.intervention",
    surface: "pr",
    action: "push",
    target,
    intervention_actor: "operator",
    cause_class: "own-red",
    source: "fix-lane-gardener",
  };
}

function routingKey(row: ReturnType<typeof intervention>): string {
  return `pr|push|${row.target}|${row.at}`;
}

function pass(stateDir: string, nowMs = NOW) {
  return routeOperatorInterventions({ stateDir, nowMs, detectors: [] });
}

test("test/sre/an-operator-intervention-is-routed-once-whatever-the-memory-file-holds.test.ts", async (t) => {
  const row = intervention("pr#101@abcdef");
  for (const [name, content] of [
    ["absent", undefined],
    ["empty", ""],
    ["stale complete cache", JSON.stringify({ complete: true, routed: [routingKey(intervention("pr#100@abcdef"))] })],
  ] as const) {
    await t.test(name, async (scope) => {
      // A source row can be appended after a pass samples its clock.
      const source = { ...row, ts: new Date(NOW + MINUTE).toISOString() };
      const ledger = writeLedger([source], { scope });
      const [event] = await pass(ledger.dir);
      assert.equal(event?.intervention_key, routingKey(row), "the first pass wrote the routing");

      const before = readFileSync(ledger.path, "utf8");
      const memory = join(ledger.dir, "operator-interventions.json");
      if (content === undefined) rmSync(memory);
      else writeFileSync(memory, content);

      assert.deepEqual(await pass(ledger.dir, NOW + 2 * MINUTE), []);
      assert.equal(readFileSync(ledger.path, "utf8"), before);
    });
  }
});

test("W1-T11887 criterion 2: routes distinct actions in one class and suppresses repeats", async (t) => {
  const first = intervention("pr#101@abcdef");
  const second = intervention("pr#102@abcdef");
  const repeatedAction = intervention(first.target, NOW - 30_000);
  const source = [first, first, second, repeatedAction];
  const ledger = writeLedger(source, { scope: t });
  const routed = await pass(ledger.dir);

  assert.deepEqual(routed.map((row) => row.intervention_key), [first, second, repeatedAction].map(routingKey));
  assert.equal(new Set(routed.map((row) => row.fingerprint)).size, 1);
  assert.equal(routed[0]!.message, routed[2]!.message, "the same action can occur on separate occasions");

  writeFileSync(join(ledger.dir, "operator-interventions.json"), JSON.stringify({ complete: true, routed: [] }));
  const routedAt = new Date(NOW).toISOString();
  writeLedger(source, { dir: ledger.dir, rotations: [{ at: routedAt, rows: routed.map((row) => ({ ...row, ts: routedAt })), gz: true }] });
  assert.deepEqual(await pass(ledger.dir, NOW + MINUTE), []);
  assert.equal(readFileSync(ledger.path, "utf8").trim().split("\n").length, source.length);
});

test("W1-T11887 criterion 3: routes new evidence once and refuses an unreadable ledger", async (t) => {
  const first = intervention("pr#101@abcdef");
  const ledger = writeLedger([first], { scope: t });
  assert.deepEqual((await pass(ledger.dir)).map((row) => row.intervention_key), [routingKey(first)]);

  const fresh = intervention("pr#102@abcdef", NOW + MINUTE);
  ledger.append([fresh]);
  assert.deepEqual((await pass(ledger.dir, NOW + 2 * MINUTE)).map((row) => row.intervention_key), [routingKey(fresh)]);
  assert.deepEqual(await pass(ledger.dir, NOW + 3 * MINUTE), []);

  const broken = writeLedger([fresh], { scope: t });
  const memory = join(broken.dir, "operator-interventions.json");
  const stale = JSON.stringify({ complete: true, routed: [] });
  writeFileSync(memory, stale);
  rmSync(broken.path);
  mkdirSync(broken.path);
  await assert.rejects(pass(broken.dir, NOW + 2 * MINUTE), /Operator-intervention ledger unreadable/);
  assert.equal(readFileSync(memory, "utf8"), stale);
});
