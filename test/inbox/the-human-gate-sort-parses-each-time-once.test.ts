/**
 * W1-T13876: projectHumanGates sorted with a comparator that parsed both gates' openedAt on every comparison,
 * about 1.2 s of serve's main thread per minute with the Console open. It now parses each gate's time once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectHumanGates, type HumanGateObservation } from "#src/lib/human-gate.js";

const T0 = Date.parse("2026-11-19T12:00:00.000Z");

function gate(subject: string, openedAt: string | null): HumanGateObservation {
  return { kind: "task_question", subject, ownerSurface: "inbox", openedAt, url: null, reason: "asked", resolutionVerb: "answer" } as HumanGateObservation;
}

test("W1-T13876 criterion 2: the human-gate sort parses each gate's opened time once and keeps oldest-first, key-tied order", (t) => {
  const gates = Array.from({ length: 64 }, (_, i) => gate(`W1-T${1000 + ((i * 37) % 64)}`, i % 9 === 0 ? null : new Date(T0 - ((i * 53) % 64) * 60_000).toISOString()));
  const parse = t.mock.method(Date, "parse");
  const projection = projectHumanGates([{ name: "task-questions", instance: "core", state: "complete", gates }]);
  const parses = parse.mock.callCount();
  parse.mock.restore();
  assert.equal(projection.gates.length, 64, "positive control: every gate is projected");
  assert.ok(parses <= gates.length, `W1-T13876 sort: ${parses} Date.parse calls for ${gates.length} gates`);
  const time = (openedAt: string | null) => (openedAt === null ? Number.POSITIVE_INFINITY : Date.parse(openedAt));
  for (let i = 1; i < projection.gates.length; i++) {
    const [a, b] = [projection.gates[i - 1]!, projection.gates[i]!];
    assert.ok(time(a.openedAt) < time(b.openedAt) || (time(a.openedAt) === time(b.openedAt) && a.key < b.key), `${a.key} sorts before ${b.key}`);
  }
});
