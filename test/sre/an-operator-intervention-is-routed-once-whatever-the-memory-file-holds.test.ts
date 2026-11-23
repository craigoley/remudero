import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { interventionFromLedgerRow, interventionIncidentEvent } from "#src/lib/operator-interventions.js";
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

function pass(stateDir: string, nowMs = NOW, log?: Parameters<typeof routeOperatorInterventions>[0]["log"]) {
  return routeOperatorInterventions({ stateDir, nowMs, detectors: [], log });
}

test("test/sre/an-operator-intervention-is-routed-once-whatever-the-memory-file-holds.test.ts", async (t) => {
  const row = intervention("pr#101@abcdef");
  for (const [name, content] of [
    ["absent", undefined],
    ["empty", ""],
    ["corrupt", "{not json"],
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

      const logs: string[] = [];
      assert.deepEqual(await pass(ledger.dir, NOW + 2 * MINUTE, (step) => logs.push(step)), []);
      assert.deepEqual(logs, name === "corrupt" ? ["sre_lane.routing_memory_unread"] : []);
      assert.equal(readFileSync(ledger.path, "utf8"), before);
    });
  }

  await t.test("keyless intervention events in the live ledger and a gzip rotation suppress writes", async (scope) => {
    const live = intervention("pr#103@abcdef");
    const archived = { ...intervention("pr#104@abcdef"), cause_class: "hand-recycle:actor unrecorded", evidence: { files: ["file with spaces.ts"] } };
    const priorRouting = (source: typeof row) => {
      const action = interventionFromLedgerRow(source);
      assert.ok(action);
      return { ...interventionIncidentEvent(action, NOW - MINUTE), ts: source.ts };
    };
    const ledger = writeLedger([live, archived, priorRouting(live)], {
      scope, rotations: [{ at: archived.ts, rows: [priorRouting(archived)], gz: true }],
    });
    const before = readFileSync(ledger.path, "utf8");

    assert.deepEqual(await pass(ledger.dir), []);
    assert.equal(readFileSync(ledger.path, "utf8"), before);
  });
});

test("W1-T11887 criterion 2: routes distinct actions in one class and suppresses repeats", async (t) => {
  const first = intervention("pr#101@abcdef");
  const second = intervention("pr#102@abcdef");
  const repeatedAction = intervention(first.target, NOW - 30_000);
  const otherActor = { ...first, intervention_actor: "another-operator" };
  const otherCause = { ...first, cause_class: "undisposed:none" };
  const otherAction = { ...first, action: "approve" };
  const otherSurface = { ...first, surface: "control" };
  const distinct = [first, second, otherActor, otherCause, otherAction, otherSurface];
  const source = [...distinct, first, repeatedAction];
  const ledger = writeLedger(source, { scope: t });
  const routed = await pass(ledger.dir);

  assert.deepEqual(routed.map((row) => row.message), distinct.map((row) => interventionIncidentEvent(interventionFromLedgerRow(row)!, NOW).message));
  assert.equal(new Set(routed.map((row) => row.intervention_key)).size, distinct.length);
  assert.equal(new Set(routed.filter((row) => row.name === first.cause_class).map((row) => row.fingerprint)).size, 1);

  const routedAt = new Date(NOW).toISOString();
  const retry = [...distinct.slice(1), repeatedAction];
  writeLedger(retry, { dir: ledger.dir });
  assert.deepEqual(await pass(ledger.dir, NOW + MINUTE), [], "a cached routing also suppresses a repeat with a different timestamp");

  writeFileSync(join(ledger.dir, "operator-interventions.json"), JSON.stringify({ complete: true, routed: [] }));
  writeLedger(retry, { dir: ledger.dir, rotations: [{ at: routedAt, rows: routed.map((row) => ({ ...row, ts: routedAt })), gz: true }] });
  assert.deepEqual(await pass(ledger.dir, NOW + MINUTE), []);
  assert.equal(readFileSync(ledger.path, "utf8").trim().split("\n").length, retry.length);

  await t.test("ledger evidence overrides a bare cache key shared by a different actor", async (scope) => {
    const [prior] = routed;
    assert.ok(prior);
    const ledger = writeLedger([first, otherActor, { ...prior, ts: routedAt }], { scope });
    writeFileSync(join(ledger.dir, "operator-interventions.json"), JSON.stringify({ complete: true, routed: [prior.intervention_key] }));
    const [fresh, ...others] = await pass(ledger.dir, NOW + MINUTE);
    assert.ok(fresh);
    assert.deepEqual(others, []);
    assert.equal(fresh.message, interventionIncidentEvent(interventionFromLedgerRow(otherActor)!, NOW).message);
    assert.notEqual(fresh.intervention_key, prior.intervention_key);
    assert.deepEqual(await pass(ledger.dir, NOW + 2 * MINUTE), []);
  });
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
