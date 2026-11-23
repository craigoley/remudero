/**
 * W1-T14424: the catalog-move selector leaves out, with the named reason ops_gate_shape, any open record that
 * remudero-ops scripts/ops-gate.rb's moved-live shape rules (OpsGate.rule_problems) would refuse. The mover's COPY
 * carries a whole batch in one ops pull request (W1-T14345), and the gate refuses that pull request for any one such
 * record, so a stale record would otherwise wedge the drain. The selection runs over two real Git origins
 * (test/helpers/plan-move-world.ts); the gate's own problem texts are pinned per rule, and the eight public shapes that
 * cannot be repaired in place are pinned as fixtures.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPlanTaskMigration, type MigrationSelection } from "#src/lib/plan-task-migration.js";
import { OPS, PUBLIC, moveWorld, record, shard } from "#test/helpers/plan-move-world.js";

type Json = Record<string, unknown>;
// Absent on a tree without the check: undefined there, so each claim below reads red for its own reason.
const { opsGateShapeProblems } = await import("#src/lib/plan-task-migration.js") as { opsGateShapeProblems?: (task: Json) => string[] };

// The shared record() carries the gate's required keys (W1-T14424); these fixtures add them one at a time instead.
const GATE_KEYS = /  risk: low\n  attempts: 0\n  acceptance:\n(?:    .*\n)+/;
const bare = (id: string, extra = "") => record(id).replace(GATE_KEYS, "") + extra;
const ITEM = (proof: string) => `    - claim: "the fixture holds"\n      proof: "${proof}"\n`;
const GATED = `  risk: low\n  attempts: 0\n  acceptance:\n${ITEM("grep: fixture in test/fixture.test.ts")}`;
/** A record every ops-gate rule accepts. */
const valid = (id: string, extra = "") => bare(id, GATED + extra);
const without = (text: string, key: string) => text.split("\n").filter(line => !line.startsWith(`  ${key}:`)).join("\n");
const swap = (text: string, key: string, value: string) => text.split("\n").map(line => line.startsWith(`  ${key}:`) ? `  ${key}: ${value}` : line).join("\n");
const PROOF_RULE = (n: number) => `acceptance item ${n} has a 'proof' that does not start with 'unit test:' or 'grep:'`;

/** Select over a world of these public records, as the preview verb does, with the world's git and GitHub model. */
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
const reasons = (s: MigrationSelection) => new Map(s.refused.map(r => [r.id, r.reason]));
const ids = (s: MigrationSelection) => s.batch.map(member => String(member.id));

// Each one breaks one ops-gate rule, and the strict public reader still admits it, so origin/main selects it.
const BROKEN: Record<string, string> = {
  "W1-T101": without(valid("W1-T101"), "verify"),
  "W1-T102": without(valid("W1-T102"), "risk"),
  "W1-T103": without(valid("W1-T103"), "status"),
  "W1-T104": without(valid("W1-T104"), "attempts"),
  "W1-T105": bare("W1-T105", "  risk: low\n  attempts: 0\n"),
  "W1-T106": swap(valid("W1-T106"), "title", '""'),
  "W1-T107": swap(valid("W1-T107"), "verify", '"  "'),
  "W1-T108": swap(valid("W1-T108"), "attempts", '""'),
  "W1-T109": swap(valid("W1-T109"), "priority", "soon"),
  "W1-T110": swap(valid("W1-T110"), "risk", "~"),
  "W1-T111": valid("W1-T111", "  depends_on: W1-T999\n"),
  "W1-T112": bare("W1-T112", "  risk: low\n  attempts: 0\n  acceptance: []\n"),
  "W1-T113": bare("W1-T113", `  risk: low\n  attempts: 0\n  acceptance:\n${ITEM("mutation test: test/fixture.test.ts")}`),
  "W1-T114": bare("W1-T114", `  risk: low\n  attempts: 0\n  acceptance:\n${ITEM("regression test: test/fixture.test.ts")}`),
  "W1-T115": bare("W1-T115", `  risk: low\n  attempts: 0\n  acceptance:\n${ITEM("demonstration: a person watches it")}`),
};
// The gate's tolerances (W1-T14424 reads them from ops-gate.rb TOLERANCES): each of these is accepted.
const ACCEPTED: Record<string, string> = {
  "W1-T201": valid("W1-T201"),
  "W1-T202": without(without(valid("W1-T202"), "priority"), "depends_on"),
  "W1-T203": bare("W1-T203", '  risk: medium\n  attempts: 2\n  acceptance:\n    - claim: "met before"\n      satisfied_by: "#1234"\n'),
  "W1-T204": valid("W1-T204", "  depends_on: []\n").replace("status: queued", "status: blocked"),
};

test("W1-T14424 criterion 1: every ops-gate rule is mirrored with the gate's own problem text", () => {
  assert.equal(typeof opsGateShapeProblems, "function", "THE CLAIM: the selector carries a port of OpsGate.rule_problems");
  const check = opsGateShapeProblems!;
  const base: Json = { title: "t", repo: "remudero", type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0,
    acceptance: [{ claim: "c", proof: "grep: x in y" }] };
  const minus = (key: string): Json => Object.fromEntries(Object.entries(base).filter(([k]) => k !== key));
  assert.deepEqual(check(base), [], "positive control: a whole record has no problem");
  for (const key of ["title", "repo", "type", "verify", "risk", "status", "attempts", "acceptance"]) {
    assert.deepEqual(check(minus(key)), [`is missing the required key '${key}'`], key);
  }
  for (const key of ["title", "repo", "type", "verify", "status", "attempts"]) {
    for (const empty of [null, "", " \t", [], {}]) assert.deepEqual(check({ ...base, [key]: empty }), [`'${key}' is empty`], `${key}=${JSON.stringify(empty)}`);
  }
  assert.deepEqual(check({ ...base, attempts: 0, title: false }), [], "zero and false are not blank, as Ruby's blank? reads them");
  assert.deepEqual(check({ ...base, depends_on: "W1-T1" }), ["'depends_on' is not a list"]);
  assert.deepEqual(check({ ...base, depends_on: ["W1-T1", 7] }), ["'depends_on' holds an item that is not a task id"]);
  assert.deepEqual(check({ ...base, depends_on: [] }), []);
  assert.deepEqual(check({ ...base, priority: "2" }), ["'priority' is not a number"]);
  assert.deepEqual(check({ ...base, priority: 0.5 }), []);
  for (const risk of ["critical", null, "Low"]) assert.deepEqual(check({ ...base, risk }), ["'risk' is not low, medium or high"], String(risk));
  for (const acceptance of [[], "grep: x", { claim: "c" }, null]) {
    assert.deepEqual(check({ ...base, acceptance }), ["'acceptance' is not a non-empty list"], JSON.stringify(acceptance));
  }
  const items = (...list: unknown[]) => check({ ...base, acceptance: list });
  assert.deepEqual(items("text", [1]), ["acceptance item 1 is not a map", "acceptance item 2 is not a map"]);
  assert.deepEqual(items({ proof: "grep: x" }, { claim: "  ", proof: "grep: x" }), ["acceptance item 1 has no 'claim'", "acceptance item 2 has no 'claim'"]);
  assert.deepEqual(items({ claim: "c", satisfied_by: "#1" }), [], "satisfied_by stands in place of a proof");
  assert.deepEqual(items({ claim: "c", satisfied_by: 12 }, { claim: "c", satisfied_by: " ", proof: "grep: x" }),
    ["acceptance item 1 has a 'satisfied_by' that is not text", "acceptance item 2 has a 'satisfied_by' that is not text"]);
  assert.deepEqual(items({ claim: "c" }, { claim: "c", proof: "" }, { claim: "c", proof: 3 }),
    ["acceptance item 1 has no 'proof'", "acceptance item 2 has no 'proof'", "acceptance item 3 has no 'proof'"]);
  assert.deepEqual(items({ claim: "c", proof: "demonstration: watch" }), ["acceptance item 1 has a 'demonstration:' proof on a task that is not 'verify: human'"]);
  assert.deepEqual(check({ ...base, verify: "human", acceptance: [{ claim: "c", proof: "  Demonstration:  watch" }] }), [], "demonstration: only under verify: human");
  assert.deepEqual(items({ claim: "c", proof: "demonstration:   " }), [PROOF_RULE(1)], "a demonstration with nothing after it is just a bad prefix");
  assert.deepEqual(items({ claim: "c", proof: "mutation test: x" }, { claim: "c", proof: "regression test: x" }, { claim: "c", proof: " grep: x" }, { claim: "c", proof: "unit test: x" }),
    [PROOF_RULE(1), PROOF_RULE(2), PROOF_RULE(3)], "the prefix is read from the unstripped proof");
  assert.deepEqual(check({ repo: "remudero", risk: "severe", priority: "high", depends_on: "x", acceptance: [] }), [
    "is missing the required key 'title'", "is missing the required key 'type'", "is missing the required key 'verify'", "is missing the required key 'status'",
    "is missing the required key 'attempts'", "'depends_on' is not a list", "'priority' is not a number", "'risk' is not low, medium or high",
    "'acceptance' is not a non-empty list"], "every problem, in the gate's order, not just the first");
});

test("W1-T14424 criterion 1: a record the gate would refuse is refused ops_gate_shape before any merge-credit lookup, and the batch fills from the next record", async t => {
  const selection = await select(t, { ...BROKEN, ...ACCEPTED });
  const refused = reasons(selection);
  for (const id of Object.keys(BROKEN)) assert.equal(refused.get(id), "ops_gate_shape", `THE CLAIM: ${id} is left out by name (origin/main selects it)`);
  assert.deepEqual([...ids(selection)].sort(), Object.keys(ACCEPTED).sort(), "the batch fills from the records the gate accepts");
  assert.ok(Object.keys(ACCEPTED).every(id => !refused.has(id)), "an accepted record, tolerances included, is never refused");
  assert.equal(selection.controls.candidateSearches, Object.keys(ACCEPTED).length, "a refused shape spends no lookup budget");
  assert.equal(selection.outcome, "candidate");
});

// The eight measured public shapes (b14345/gate-failing.tsv) that cannot be repaired in place, and the seven-record
// missing-attempts shape public #20390 repairs. Each keeps its real item count and the position of its bad proofs.
const UNIT = "unit test: test/fixture.test.ts";
const proofs = (list: string[]) => `  acceptance:\n${list.map(ITEM).join("")}`;
const auto = (id: string, status: string, list: string[]) =>
  bare(id, `  risk: high\n  attempts: 0\n${proofs(list)}`).replace("status: queued", `status: ${status}`);
const human = (id: string, status: string) => bare(id, "  risk: low\n  attempts: 0\n").replace("verify: auto", "verify: human").replace("status: queued", `status: ${status}`);
const SHAPES: Record<string, { text: string; problems: string[] }> = {
  "W1-T301": { text: auto("W1-T301", "blocked", [...Array(6).fill(UNIT), "mutation test: test/fixture.test.ts"]), problems: [PROOF_RULE(7)] },
  "W1-T302": { text: auto("W1-T302", "queued", [...Array(8).fill(UNIT), "regression test: test/fixture.test.ts", "mutation test: test/fixture.test.ts"]), problems: [PROOF_RULE(9), PROOF_RULE(10)] },
  "W1-T303": { text: auto("W1-T303", "queued", [...Array(6).fill(UNIT), "regression test: test/fixture.test.ts", "mutation test: test/fixture.test.ts"]), problems: [PROOF_RULE(7), PROOF_RULE(8)] },
  "W1-T304": { text: human("W1-T304", "queued"), problems: ["is missing the required key 'acceptance'"] },
  "W1-T305": { text: human("W1-T305", "blocked"), problems: ["is missing the required key 'acceptance'"] },
  "W1-T306": { text: human("W1-T306", "blocked"), problems: ["is missing the required key 'acceptance'"] },
  "W1-T307": { text: human("W1-T307", "blocked"), problems: ["is missing the required key 'acceptance'"] },
  "W1-T308": { text: human("W1-T308", "blocked"), problems: ["is missing the required key 'acceptance'"] },
  "W1-T309": { text: without(auto("W1-T309", "blocked", [UNIT]), "attempts"), problems: ["is missing the required key 'attempts'"] },
};

test("W1-T14424 criterion 2: the eight unrepairable public shapes, and the missing-attempts one, read as ops-gate.rb rule_problems reads them, and none reaches the batch", async t => {
  assert.equal(typeof opsGateShapeProblems, "function", "THE CLAIM: the selector carries a port of OpsGate.rule_problems");
  const { parse } = await import("yaml");
  for (const [id, shape] of Object.entries(SHAPES)) {
    const [task] = parse(shape.text, { version: "1.1" }) as Json[];
    assert.deepEqual(opsGateShapeProblems!(task!), shape.problems, `${id} carries the gate's own problems`);
  }
  const selection = await select(t, { ...Object.fromEntries(Object.entries(SHAPES).map(([id, s]) => [id, s.text])), "W1-T201": ACCEPTED["W1-T201"]! });
  const refused = reasons(selection);
  for (const id of Object.keys(SHAPES)) assert.equal(refused.get(id), "ops_gate_shape", `${id} is refused by its shape, before verify_human`);
  assert.deepEqual(ids(selection), ["W1-T201"]);
});

// Every record here passes every ops-gate rule and meets each earlier refusal; the answer is pinned from origin/main.
const at = (id: string, priority: number, extra = "") => valid(id, extra).replace("priority: 1", `priority: ${priority}`);
const INVARIANT: Record<string, string> = {
  "W1-T401": at("W1-T401", 9).replace("verify: auto", "verify: human"),
  "W1-T402": at("W1-T402", 8),
  "W1-T403": at("W1-T403", 7).replace("status: queued", "status: merged"),
  "W1-T404": at("W1-T404", 6),
  "W1-T405": at("W1-T405", 5, "  depends_on: [W1-T406]\n").replace("status: queued", "status: blocked"),
  "W1-T406": at("W1-T406", 4),
  "W1-T407": at("W1-T407", 3),
  "W1-T408": bare("W1-T408", '  risk: high\n  attempts: 1\n  acceptance:\n    - claim: "met before"\n      satisfied_by: "#99"\n').replace("priority: 1", "priority: 2"),
};
const EXPECTED_BATCH = ["W1-T402", "W1-T405", "W1-T407", "W1-T408"];
const EXPECTED_REFUSED = [
  { id: "W1-T401", reason: "verify_human" }, { id: "W1-T403", reason: "not_open" }, { id: "W1-T404", reason: "reservation_absent" }, { id: "W1-T406", reason: "public_dependants" },
];
const prepare = (w: ReturnType<typeof moveWorld>) => { w.pub.origin.git("update-ref", "-d", "refs/rmd-id/W1-T404"); };

test("W1-T14424 criterion 3: invariant:a-record-the-gate-accepts-is-selected-as-today — the batch, its order and the refusals are origin/main's", async t => {
  const today = await select(t, INVARIANT, prepare);
  assert.deepEqual(ids(today), EXPECTED_BATCH, "THE CLAIM: the batch and its order are origin/main's");
  assert.deepEqual([...today.refused].sort((a, b) => a.id.localeCompare(b.id)), EXPECTED_REFUSED, "THE CLAIM: the refusals are origin/main's");
  assert.deepEqual(today.batch.map(member => member.yaml), EXPECTED_BATCH.map(id => INVARIANT[id]), "byte for byte");
  assert.equal(today.controls.candidateSearches, EXPECTED_BATCH.length);
  assert.ok(EXPECTED_BATCH.every(id => today.batch.some(member => member.sourcePath === shard(id))));

  // The same records beside refused shapes: projected onto the accepted records, nothing moves.
  const mixed = await select(t, { ...INVARIANT, ...BROKEN }, prepare);
  assert.deepEqual(ids(mixed).filter(id => id in INVARIANT), EXPECTED_BATCH);
  assert.deepEqual(mixed.refused.filter(r => r.id in INVARIANT).sort((a, b) => a.id.localeCompare(b.id)), EXPECTED_REFUSED);
});
