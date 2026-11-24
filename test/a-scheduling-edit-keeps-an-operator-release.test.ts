// W1-T14661: priority and expedite are scheduling, never an approved term, so an operator release survives a queue-judge
// re-rank or an expedite line; a pin recorded by origin/main's formula still qualifies; every contract term stays pinned.
import assert from "node:assert/strict";
import { test } from "node:test";
// Namespace imports: a name this build adds reads as undefined at base instead of failing the load.
import * as release from "#src/lib/operator-release.js";
import * as judge from "#src/lib/machine-filing-judge.js";
import { parseTasksFromYaml, type Task } from "#src/lib/plan.js";
import { taskRulingPin } from "#src/lib/task-linter.js";

const ID = "W1-T9";
const REL = "plan/tasks.d/W1-T9-a-released-record.yaml";
const TEXT = [
  "- id: W1-T9", "  title: a released record", "  repo: remudero", "  type: implement", "  priority: 1",
  "  status: queued", "  verify: human", "  files:", "    - src/a.ts", "  acceptance:",
  "    - claim: it works", "      proof: \"grep: works in src/a.ts\"", "  design: |", "    do the thing", "",
].join("\n");
/** origin/main's (fba7082e64) operatorReleasePin of TEXT, measured before this build: priority 1 was inside it. */
const LEGACY_PIN = "8a466b82c3cb403aa2b1f6419eb7830cca3968d7e66e85ac98ba6f560844ec17";

/** The queue judge's own rewrite (queue-judge-gardener.ts applyQueueJudgeActions): the priority line with its reason,
 *  inserted before `status: queued` when the record had none, and the judge's marker comment beneath that status. */
function reRanked(text: string, to: number): string {
  const line = `  priority: ${to}  # queue-judge-2026-11-24: measured cost of delay`;
  const next = /^ {2}priority:/m.test(text) ? text.replace(/^ {2}priority:.*$/m, line) : text.replace(/^ {2}status: queued$/m, `${line}\n  status: queued`);
  return next.replace(/^ {2}status: queued$/m, `  status: queued\n  # queue judge: priority=${to} evidence=0123456789abcdef`);
}
const EXPEDITE = "operator ask 2026-11-24: release the parked verify: human records";
const expedited = (text: string): string => text.replace(/^ {2}status: queued$/m, `  expedite: "${EXPEDITE}"\n  status: queued`);
const unranked = (text: string): string => text.replace("  priority: 1\n", "");
const load = (text: string): Task => {
  const tasks = parseTasksFromYaml(text, REL);
  assert.equal(tasks.length, 1, "the fixture parses to one record");
  return tasks[0]!;
};
const pinOf = (task: Task): string => release.operatorReleasePin(task);
const ruled = (task: Task, pin: string) =>
  ({ ...task, risk_ruling: { operator_release_pin: pin } }) as Parameters<typeof release.operatorReleaseContractChanged>[0];

const SHAPES = ["ledger row", "durable entry"] as const;
/** The release authority's reading of one recorded release, resolved through the real per-task pin lookup. */
function standing(recorded: string, shape: (typeof SHAPES)[number], reading: Task): { operator: boolean; reapproval: boolean } {
  const lines = shape === "ledger row"
    ? [JSON.stringify({ step: "ratify.approved", task_id: ID, release_pin: recorded, released: "verify-human" })] : [];
  const durable = new Map<string, unknown>(shape === "durable entry" ? [[ID, { at: "2026-11-24T00:00:00.000Z", pin: recorded }]] : []);
  const evidence = release.qualifyReleaseEvidence(lines, durable, release.releaseContractPins([reading]));
  return { operator: evidence.authors.get(ID) === "operator", reapproval: evidence.reapproval.has(ID) };
}
const RELEASED = { operator: true, reapproval: false };
const REAPPROVAL = { operator: false, reapproval: true };

test("W1-T14661 criterion 1: a released task the queue judge re-ranks, or that gains an expedite line, stays released", () => {
  const cases: [string, string, string][] = [
    ["re-ranked", TEXT, reRanked(TEXT, 0.4)],
    ["ranked for the first time", unranked(TEXT), reRanked(unranked(TEXT), 0.4)],
    ["expedited", TEXT, expedited(TEXT)],
    ["re-ranked and expedited", TEXT, expedited(reRanked(TEXT, 0.4))],
  ];
  for (const [edit, before, after] of cases) {
    assert.notEqual(after, before, `${edit}: the fixture really changed`);
    const approved = load(before);
    const reading = load(after);
    assert.ok(reading.priority === 0.4 || reading.expedite === EXPEDITE, `${edit}: the parsed record carries the scheduling edit`);
    for (const shape of SHAPES) {
      assert.deepEqual(standing(pinOf(approved), shape, reading), RELEASED, `${edit} (${shape}): the operator release still stands`);
    }
    assert.equal(release.operatorReleaseContractChanged(ruled(reading, pinOf(approved))), false, `${edit}: the ruling's release pin still holds`);
    // The judge's landing check reads origin/main's re-ranked copy against the release pin it landed with.
    const stale = judge.staleRulingPins([{ id: ID, relPath: REL, pin: "landed", sourcePin: taskRulingPin(reading), operatorReleasePin: pinOf(approved) }],
      new Map([[REL, after]]));
    assert.deepEqual(stale, [], `${edit}: a pending judge landing is not withdrawn as stale`);
  }
});

test("W1-T14661 criterion 2: a release pinned by origin/main's formula still qualifies, and a new release records the new pin", () => {
  const task = load(TEXT);
  assert.notEqual(pinOf(task), LEGACY_PIN, "a new release records the scheduling-free pin, not origin/main's");
  assert.equal(release.releasePinMatches?.(task, LEGACY_PIN), true, "the legacy pin matches the unchanged contract");
  assert.equal(release.releasePinMatches?.(task, pinOf(task)), true, "the new pin matches");
  assert.equal(release.releasePinMatches?.(task, "0".repeat(64)), false, "an unrelated pin does not");
  assert.equal(release.releasePinMatches?.(task, undefined), false, "an absent pin does not");
  for (const recorded of [LEGACY_PIN, pinOf(task)]) {
    for (const shape of SHAPES) assert.deepEqual(standing(recorded, shape, task), RELEASED, `${shape} under ${recorded === LEGACY_PIN ? "the legacy" : "the new"} pin`);
    assert.equal(release.operatorReleaseContractChanged(ruled(task, recorded)), false, "a ruling's recorded release pin holds");
    // A reconciled status flip is bookkeeping: the lifecycle loop matches the legacy pin too.
    assert.equal(release.operatorReleaseContractChanged(ruled({ ...task, status: "merged" }, recorded)), false, "a landed status flip keeps the release");
  }
  const stale = judge.staleRulingPins([{ id: ID, relPath: REL, pin: "landed", sourcePin: taskRulingPin(task), operatorReleasePin: LEGACY_PIN }],
    new Map([[REL, TEXT]]));
  assert.deepEqual(stale, [], "a judge landing recorded under the legacy pin is not withdrawn as stale");
});

test("W1-T14661 criterion 3: an edit to a contract term of a released task still needs reapproval, exactly as on origin/main", () => {
  const approved = load(TEXT);
  const contract: Record<string, string> = {
    title: TEXT.replace("a released record", "a different record"),
    files: TEXT.replace("    - src/a.ts\n", "    - src/b.ts\n"),
    acceptance: TEXT.replace("it works", "it works differently"),
    design: TEXT.replace("do the thing", "do another thing"),
    dispatch_hold: TEXT.replace("  status: queued\n", "  dispatch_hold: true\n  status: queued\n"),
    "title together with a re-rank": reRanked(TEXT.replace("a released record", "a different record"), 0.4),
  };
  for (const [term, text] of Object.entries(contract)) {
    assert.notEqual(text, TEXT, `${term}: the fixture really changed`);
    const reading = load(text);
    for (const recorded of [pinOf(approved), LEGACY_PIN]) {
      for (const shape of SHAPES) assert.deepEqual(standing(recorded, shape, reading), REAPPROVAL, `${term} (${shape}) must read as reapproval required`);
      assert.equal(release.operatorReleaseContractChanged(ruled(reading, recorded)), true, `${term}: the ruling's release pin no longer holds`);
    }
  }
  // origin/main hashes every record at `verify: auto` so the human-to-auto flip cannot void its own approval;
  // this build keeps that exactly: a verify edit reads the same as it does on origin/main.
  const flipped = load(TEXT.replace("  verify: human\n", "  verify: auto\n"));
  assert.equal(flipped.verify, "auto", "the fixture really flipped verify");
  for (const shape of SHAPES) assert.deepEqual(standing(LEGACY_PIN, shape, flipped), RELEASED, `verify flip (${shape}) reads as on origin/main`);
});
