/**
 * W1-T14425: the catalog-move selector admits an open verify:human record like any other open record. W1-T14345 kept
 * every one out (verify_human) because a move changed the record's release pin; W1-T14408 made the pin exclude the
 * mover's moved_from line, so a release survives the move. The selection runs over two real Git origins
 * (test/helpers/plan-move-world.ts); the release is read through the real check, as
 * test/a-moved-record-keeps-its-operator-release.test.ts reads it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
// Namespace import: a name this build does not change still reads at base without a load-time failure.
import * as release from "#src/lib/operator-release.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { selectPlanTaskMigration, type MigrationSelection } from "#src/lib/plan-task-migration.js";
import { OPS, PUBLIC, moveWorld, record } from "#test/helpers/plan-move-world.js";

/** Every ops-gate rule accepts this record shape (the shared record() carries the gate's required keys). */
const at = (id: string, priority: number, extra = "") => record(id, extra).replace("priority: 1", `priority: ${priority}`);
const human = (id: string, priority: number, status = "queued") => at(id, priority).replace("verify: auto", "verify: human").replace("status: queued", `status: ${status}`);

async function select(t: Parameters<typeof moveWorld>[0], records: Record<string, string>, prepare: (w: ReturnType<typeof moveWorld>) => void = () => undefined): Promise<MigrationSelection> {
  const w = moveWorld(t, records);
  prepare(w);
  for (const side of ["public", "ops"] as const) w.sides[side].clone.git("fetch", "--quiet", "origin");
  const o = { publicRoot: w.pub.clone.dir, publicCommit: w.main("public"), publicRepo: PUBLIC, opsRoot: w.ops.clone.dir, opsCommit: w.main("ops"), opsRepo: OPS };
  const previous = new Map(Object.keys(w.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, w.env);
  try { return await selectPlanTaskMigration(o, async query => w.answer(query)); }
  finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const ids = (s: MigrationSelection) => s.batch.map(member => String(member.id));
const reasons = (s: MigrationSelection) => new Map(s.refused.map(r => [r.id, r.reason]));

test("W1-T14425 criterion 1: an open verify:human record is selected into the batch like any other open record", async t => {
  const selection = await select(t, { "W1-T501": human("W1-T501", 9), "W1-T502": at("W1-T502", 8), "W1-T503": human("W1-T503", 7, "blocked") });
  const refused = reasons(selection);
  for (const id of ["W1-T501", "W1-T503"]) assert.notEqual(refused.get(id), "verify_human", `THE CLAIM: ${id} is not refused verify_human`);
  assert.deepEqual(ids(selection), ["W1-T501", "W1-T502", "W1-T503"], "THE CLAIM: queued and blocked verify:human records are in the batch, in the usual order");
  assert.deepEqual(selection.refused, []);
});

const SHA = "a".repeat(40);
/** The ops copy the mover writes: the public bytes plus one moved_from line after the id line. */
const movedCopy = (text: string, from: string): string => text.replace(/^(- id: .*\n)/, `$1  moved_from: ${from}\n`);
const load = (text: string) => parseTasksFromYaml(text, "fixture")[0]!;
type Contract = Parameters<typeof release.operatorReleasePin>[0];
const pinOf = (task: unknown): string => release.operatorReleasePin(task as Contract);

test("W1-T14425 criterion 2: a release against the public record reads as released from the moved ops copy through the real release check; an unreleased one reads unreleased", async t => {
  const selection = await select(t, { "W1-T511": human("W1-T511", 9), "W1-T512": human("W1-T512", 8) });
  assert.deepEqual(ids(selection), ["W1-T511", "W1-T512"], "both verify:human records are selected first");
  const copies = new Map(selection.batch.map(member => [String(member.id), movedCopy(String(member.yaml), String(member.prospectiveMovedFrom))]));
  const publicRecord = (id: string) => load(String(selection.batch.find(member => String(member.id) === id)!.yaml));
  const reading = (id: string) => {
    const moved = load(copies.get(id)!);
    assert.equal(moved.moved_from, `remudero@${selection.publicCommit}`, "the ops copy really carries the mover's provenance line");
    return release.releaseContractPins([moved as Parameters<typeof release.releaseContractPins>[0][number]]);
  };
  const read = (id: string, rows: string[]) => {
    const evidence = release.qualifyReleaseEvidence(rows, new Map(), reading(id));
    return { released: evidence.authors.get(id) === "operator", reapproval: evidence.reapproval.has(id) };
  };
  const approved = (id: string, against: unknown) => JSON.stringify({ step: "ratify.approved", task_id: id, release_pin: pinOf(against), released: "verify-human" });

  assert.deepEqual(read("W1-T511", [approved("W1-T511", publicRecord("W1-T511"))]), { released: true, reapproval: false }, "THE CLAIM: a released public record stays released at its moved copy");
  assert.deepEqual(read("W1-T512", []), { released: false, reapproval: false }, "THE CLAIM: an unreleased record stays unreleased");
  // Positive control: a release against a different contract does not release this copy.
  assert.deepEqual(read("W1-T512", [approved("W1-T512", publicRecord("W1-T511"))]).released, false);
  assert.ok(SHA.length === 40);
});

// Every record meets each earlier refusal or none; the answer for the machine-verified ones is pinned from origin/main.
const MACHINE: Record<string, string> = {
  "W1-T602": at("W1-T602", 8),
  "W1-T603": at("W1-T603", 7).replace("status: queued", "status: merged"),
  "W1-T604": at("W1-T604", 6),
  "W1-T605": at("W1-T605", 5, "  depends_on: [W1-T606]\n").replace("status: queued", "status: blocked"),
  "W1-T606": at("W1-T606", 4),
  "W1-T607": at("W1-T607", 3),
  "W1-T608": at("W1-T608", 2).replace("status: queued", "status: done"),
};
// W1-T14825: W1-T606, named only by W1-T605 in the same batch, now joins it instead of waiting a round as public_dependants.
const EXPECTED_BATCH = ["W1-T602", "W1-T605", "W1-T606", "W1-T607"];
const EXPECTED_REFUSED = [
  { id: "W1-T603", reason: "not_open" }, { id: "W1-T604", reason: "owned" }, { id: "W1-T608", reason: "not_open" },
];
const HUMAN: Record<string, string> = { "W1-T601": human("W1-T601", 9), "W1-T609": human("W1-T609", 1, "blocked") };
const prepare = (w: ReturnType<typeof moveWorld>) => { w.pub.origin.git("update-ref", "refs/rmd-dispatch/W1-T604", w.main("public")); /* W1-T14993: an unreserved id now moves; a dispatch claim keeps W1-T604 on core */ };
const byId = (list: Array<{ id: string; reason: string }>) => [...list].sort((a, b) => a.id.localeCompare(b.id));

test("W1-T14425 criterion 3: invariant:a-machine-verified-record-is-selected-as-today — for every record whose verify is not human, the batch, its order and the refusals are origin/main's", async t => {
  const today = await select(t, MACHINE, prepare);
  assert.deepEqual(ids(today), EXPECTED_BATCH, "THE CLAIM: the batch and its order are origin/main's");
  assert.deepEqual(byId(today.refused), EXPECTED_REFUSED, "THE CLAIM: the refusals are origin/main's");
  assert.deepEqual(today.batch.map(member => member.yaml), EXPECTED_BATCH.map(id => MACHINE[id]), "byte for byte");
  assert.equal(today.controls.candidateSearches, EXPECTED_BATCH.length);

  // The same records beside verify:human ones: projected onto the machine-verified records, nothing changes.
  const mixed = await select(t, { ...MACHINE, ...HUMAN }, prepare);
  assert.deepEqual(ids(mixed).filter(id => id in MACHINE), EXPECTED_BATCH);
  assert.deepEqual(byId(mixed.refused.filter(r => r.id in MACHINE)), EXPECTED_REFUSED);
});
