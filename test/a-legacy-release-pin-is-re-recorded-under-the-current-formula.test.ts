// W1-T14721: a durable operator release recorded under the legacy pin formula (priority and expedite inside it) is
// re-recorded once by the judge pass under the current formula, keeping its original release time, so the first
// re-rank after W1-T14661 no longer voids it. Nothing else in the durable file moves, and the pass grants nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import * as judge from "#src/lib/machine-filing-judge.js";
import { legacyOperatorReleasePin, operatorReleasePin, qualifyReleaseEvidence, releaseContractPins } from "#src/lib/operator-release.js";
import { loadPlan, type Task } from "#src/lib/plan.js";

const CLOCK = fixedClock(Date.parse("2026-11-24T12:00:00Z"));
const RELEASED_AT = "2026-11-20T08:30:00.000Z";
const LEGACY = "W1-T9801"; // released under the legacy formula: the record to re-record
const CURRENT = "W1-T9802"; // released under the current formula already
const NEITHER = "W1-T9803"; // released against an earlier contract: matches neither formula
const NO_RECORD = "W1-T9804"; // never released
const STRING_FORM = "W1-T9805"; // a pre-pin string entry: proves no contract
const HELD = "W1-T9806"; // a reapproval hold in the judge's state, not in the durable file
const UNRANKED = "W1-T9807"; // no priority or expedite: the legacy and current formulas pin the same
const ORPHAN = "W1-T9899"; // a durable record for a task the plan does not hold

function recordText(id: string, title: string, priority: number | undefined): string {
  return [
    `- id: ${id}`, `  title: ${title}`, "  repo: remudero", "  type: implement",
    ...(priority === undefined ? [] : [`  priority: ${priority}`]),
    "  status: queued", "  verify: auto", "  files:", "    - src/a.ts", "  acceptance:",
    "    - claim: it works", "      proof: \"grep: works in src/a.ts\"", "  design: |", "    do the thing", "",
  ].join("\n");
}

interface Fixture {
  stateDir: string;
  releasesPath: string;
  plan: () => ReturnType<typeof loadPlan>;
  task: (id: string) => Task;
  rerank: (id: string, to: number) => void;
  pass: (ledger?: readonly string[]) => Promise<judge.MachineJudgeReport>;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-legacy-release-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan/tasks.d"), { recursive: true });
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  writeFileSync(join(root, "plan/tasks.yaml"), "[]\n");
  const shard = (id: string): string => join(root, "plan/tasks.d", `${id}-a-released-record.yaml`);
  for (const id of [LEGACY, CURRENT, NEITHER, NO_RECORD, STRING_FORM, HELD]) writeFileSync(shard(id), recordText(id, `record ${id}`, 1));
  writeFileSync(shard(UNRANKED), recordText(UNRANKED, `record ${UNRANKED}`, undefined));
  const plan = () => loadPlan(join(root, "plan/tasks.yaml"));
  const task = (id: string): Task => {
    const found = plan().byId.get(id);
    assert.ok(found, `${id} is in the fixture plan`);
    return found;
  };
  const rerank = (id: string, to: number): void => {
    const before = readFileSync(shard(id), "utf8");
    const after = before.replace(/^ {2}priority:.*$/m, `  priority: ${to}  # queue-judge-2026-11-24: measured cost of delay`);
    assert.notEqual(after, before, `${id}: the re-rank really changed the record`);
    writeFileSync(shard(id), after);
  };
  const pass = (ledger: readonly string[] = []) => judge.runMachineFilingJudge({
    stateDir, plan, writeRoot: root,
    operatorReleases: () => judge.readOperatorReleaseRecords(stateDir),
    releaseLedgerLines: () => ledger,
    riskJudge: async () => { throw new Error("no record in this fixture is due a model ruling"); },
    isMerged: () => false, stageProposal: () => {}, clock: CLOCK, log: () => {},
  });
  return { stateDir, releasesPath: join(stateDir, judge.OPERATOR_RELEASES_FILE), plan, task, rerank, pass };
}

/** The durable file as an operator's earlier `rmd approve` runs left it, pretty-printed so any rewrite shows in its bytes. */
function writeReleases(f: Fixture, releases: Record<string, unknown>): string {
  const text = JSON.stringify({ releases }, null, 2);
  writeFileSync(f.releasesPath, text);
  return text;
}

const releasesOf = (f: Fixture): Record<string, unknown> =>
  (JSON.parse(readFileSync(f.releasesPath, "utf8")) as { releases: Record<string, unknown> }).releases;

/** The release authority's reading, exactly as the judge pass builds it. */
function authority(f: Fixture, ledger: readonly string[] = []) {
  const evidence = qualifyReleaseEvidence(ledger, judge.readOperatorReleaseRecords(f.stateDir), releaseContractPins(f.plan().tasks));
  return { authors: [...evidence.authors].sort(([a], [b]) => a.localeCompare(b)), reapproval: [...evidence.reapproval].sort() };
}

/** Every record shape a durable file can hold beside a legacy release. */
function untouchedRecords(f: Fixture): Record<string, unknown> {
  const earlier = { ...f.task(NEITHER), title: "an earlier contract the operator approved" } as Task;
  return {
    [CURRENT]: { at: "2026-11-24T01:00:00.000Z", pin: operatorReleasePin(f.task(CURRENT)) },
    [NEITHER]: { at: "2026-11-19T00:00:00.000Z", pin: legacyOperatorReleasePin(earlier) },
    [STRING_FORM]: "2026-10-01T00:00:00Z",
    [UNRANKED]: { at: "2026-11-18T00:00:00.000Z", pin: legacyOperatorReleasePin(f.task(UNRANKED)) },
    [ORPHAN]: { at: "2026-11-17T00:00:00.000Z", pin: "a".repeat(64) },
  };
}

test("W1-T14721 criterion 1: a legacy-formula release is re-recorded under the current pin with its original at, and survives a re-rank", async t => {
  const f = fixture(t);
  const legacyPin = legacyOperatorReleasePin(f.task(LEGACY));
  const currentPin = operatorReleasePin(f.task(LEGACY));
  assert.notEqual(legacyPin, currentPin, "the fixture record carries a priority, so the two formulas pin it differently");

  // Without the migration: the same durable record, re-ranked with no pass in between, needs reapproval.
  writeReleases(f, { [LEGACY]: { at: RELEASED_AT, pin: legacyPin } });
  assert.ok(authority(f).authors.some(([id, author]) => id === LEGACY && author === "operator"), "the legacy release qualifies today");
  f.rerank(LEGACY, 0.4);
  assert.ok(authority(f).reapproval.includes(LEGACY), "control: without the migration a re-rank moves the release to reapproval");

  // With the migration: one pass before the re-rank re-records it.
  const g = fixture(t);
  writeReleases(g, { [LEGACY]: { at: RELEASED_AT, pin: legacyPin } });
  const report = await g.pass();
  assert.deepEqual(releasesOf(g)[LEGACY], { at: RELEASED_AT, pin: currentPin, legacy: legacyPin },
    "the record carries the current pin, its old pin as legacy, and its original release time");
  assert.deepEqual(report.rerecorded, [LEGACY], "the pass reports the one record it re-recorded");
  g.rerank(LEGACY, 0.4);
  const after = authority(g);
  assert.ok(after.authors.some(([id, author]) => id === LEGACY && author === "operator"), "after a re-rank the task is still among the operator authors");
  assert.equal(after.reapproval.includes(LEGACY), false, "and needs no reapproval");
  assert.deepEqual([...judge.readOperatorReleases(g.stateDir, g.plan().tasks)].sort(), [LEGACY], "the judge's own release reader agrees");

  const second = await g.pass();
  assert.equal(second.rerecorded, undefined, "a later pass finds nothing left to re-record");
});

test("W1-T14721 criterion 2: a current release, a record matching neither formula, a string entry, a hold and an unreleased task are left byte-identical", async t => {
  const f = fixture(t);
  writeFileSync(join(f.stateDir, judge.MACHINE_JUDGE_STATE_FILE), JSON.stringify({ operatorReapprovalRequired: [HELD] }));
  const bytes = writeReleases(f, untouchedRecords(f));
  const before = statSync(f.releasesPath);
  const report = await f.pass();
  assert.equal(report.rerecorded, undefined, "nothing qualified for re-recording");
  assert.equal(readFileSync(f.releasesPath, "utf8"), bytes, "the durable file is byte-identical");
  assert.equal(statSync(f.releasesPath).mtimeMs, before.mtimeMs, "and was not rewritten");
  assert.equal(NO_RECORD in releasesOf(f), false, "an unreleased task gains no record");
  assert.equal(HELD in releasesOf(f), false, "a reapproval hold is not written into the durable file");
  assert.ok(authority(f).reapproval.includes(HELD), "the hold still stands");

  // Beside a legacy record that is re-recorded, every other record keeps its exact value, its at included.
  const g = fixture(t);
  const others = untouchedRecords(g);
  writeReleases(g, { ...others, [LEGACY]: { at: RELEASED_AT, pin: legacyOperatorReleasePin(g.task(LEGACY)) } });
  const mixed = await g.pass();
  const written = releasesOf(g);
  assert.deepEqual(Object.keys(written).sort(), [...Object.keys(others), LEGACY].sort(), "no record is added or dropped");
  for (const [id, value] of Object.entries(others)) assert.deepEqual(written[id], value, `${id} is left exactly as it was`);
  assert.deepEqual(written[LEGACY], { at: RELEASED_AT, pin: operatorReleasePin(g.task(LEGACY)), legacy: legacyOperatorReleasePin(g.task(LEGACY)) },
    "only the legacy release is re-recorded, and it keeps its original at");
  assert.deepEqual(mixed.rerecorded, [LEGACY]);
  assert.equal(NO_RECORD in written, false);
});

test("W1-T14721 criterion 3: invariant:migration-never-grants — the operator authors are the same immediately before and after the pass", async t => {
  const f = fixture(t);
  writeFileSync(join(f.stateDir, judge.MACHINE_JUDGE_STATE_FILE), JSON.stringify({ operatorReapprovalRequired: [HELD] }));
  writeReleases(f, { ...untouchedRecords(f), [LEGACY]: { at: RELEASED_AT, pin: legacyOperatorReleasePin(f.task(LEGACY)) } });
  const ledger = [JSON.stringify({ step: "ratify.approved", task_id: NO_RECORD, release_pin: "b".repeat(64), released: "verify-human" })];
  const before = authority(f, ledger);
  assert.ok(before.authors.length >= 3, "the fixture holds several operator releases to compare");
  const report = await f.pass(ledger);
  assert.deepEqual(report.rerecorded, [LEGACY], "the pass did re-record, so the comparison is not of an untouched file");
  const after = authority(f, ledger);
  assert.deepEqual(after.authors, before.authors, "the pass grants and revokes no operator release");
  assert.deepEqual(after.reapproval, before.reapproval, "and moves no task into or out of reapproval");
});
