// A step-filtered openLedgerUnion (readEscalationAnswers' history read, every full pass) parsed every line of the
// corpus and put every line into its replay-dedupe Set BEFORE asking whether the row was wanted, so the Set held
// the whole corpus (3.97 M lines, 1.78 GB on the fleet host, 2026-10-10) to yield a handful of rows. The filter
// now runs first, and a line naming no wanted step is never parsed.
import assert from "node:assert/strict";
import { appendFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { openLedgerUnion, type LedgerMalformedRowFinding } from "../src/lib/ledger-union.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const WANTED = ["escalation_answer.ignored", "panel.question_answered"];

function corpus() {
  const noise = (prefix: string, n: number) => Array.from({ length: n }, (_, i) =>
    ({ ts: `2026-10-0${1 + (i % 5)}T00:00:${String(i % 60).padStart(2, "0")}.000Z`, step: "heartbeat.tick", note: `${prefix}-${i}` }));
  const wanted = [
    { ts: "2026-10-02T00:00:00.000Z", step: "escalation_answer.ignored", task_id: "W1-T1", reason: "bot" },
    { ts: "2026-10-03T00:00:00.000Z", step: "panel.question_answered", task_id: "W1-T2" },
    // Names a wanted step only in a field: read, parsed, and then dropped by the exact step match.
    { ts: "2026-10-03T00:00:01.000Z", step: "heartbeat.tick", note: "escalation_answer.ignored" },
  ];
  const fixture = writeLedger([...noise("live", 30), wanted[1]], {
    rotations: [
      { at: "2026-10-02T12:00:00.000Z", gz: true, rows: [...noise("a", 40), wanted[0], wanted[2]] },
      // A later rotation replays the earlier one's rows, as retention does.
      { at: "2026-10-03T12:00:00.000Z", gz: false, rows: [...noise("a", 40), wanted[0], ...noise("b", 25)] },
    ],
  });
  appendFileSync(fixture.path, "{not json\n");
  return fixture;
}

async function collect(dir: string, opts: Parameters<typeof openLedgerUnion>[1]) {
  const rows: Array<Record<string, unknown>> = [];
  for await (const row of openLedgerUnion(dir, opts)) rows.push(row);
  return rows;
}

test("a step-filtered ledger stream yields the unfiltered stream's rows with only its own rows in the dedupe Set", async (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const reference = (await collect(fixture.dir, {})).filter((row) => WANTED.includes(row.step as string));
  assert.equal(reference.length, 2, "the positive control finds each wanted row once across the replay");

  const add = Set.prototype.add;
  const parse = JSON.parse;
  let sightings = 0;
  let parses = 0;
  Set.prototype.add = function (this: Set<unknown>, value: unknown) {
    if (typeof value === "string" && value.startsWith("{")) sightings += 1;
    return add.call(this, value);
  } as typeof Set.prototype.add;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => (parses += 1, parse(...args))) as typeof JSON.parse;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await collect(fixture.dir, { step: WANTED });
  } finally {
    Set.prototype.add = add;
    JSON.parse = parse;
  }
  assert.deepEqual(rows, reference);
  assert.equal(sightings, rows.length, "the dedupe Set holds the stream's own rows, not every line of the corpus");
  assert.equal(parses, 4, "only the four lines naming a wanted step are parsed (two of them replays)");
});

test("a step-filtered stream with a malformed-row audit still reports every malformed line", async (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const findings: LedgerMalformedRowFinding[] = [];
  const rows = await collect(fixture.dir, { step: WANTED, onMalformedRow: (finding) => findings.push(finding) });
  assert.deepEqual(rows.map((row) => row.step), ["escalation_answer.ignored", "panel.question_answered"]);
  assert.deepEqual(findings.map((finding) => finding.kind), ["invalid-json"], "a malformed line naming no wanted step is still audited");
});
