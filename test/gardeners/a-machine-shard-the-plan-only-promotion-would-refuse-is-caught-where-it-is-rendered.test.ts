// @source-text-subject: the call sites of the shared machine-shard writer, counted across src/ by the census suite's scan.
// @census-reads: src/ — every module that calls renderMachineShard or machineShardHeaderLines.
/**
 * W1-T13035. A plan-only filing promotes six lint warnings to blocks when its shard is new
 * (`promoteIntroducedPlanOnlyDiagnostics`, W1-T3814). A machine filing is always a new plan-only shard, so a
 * template that renders one of those warnings opens a plan pull request the preflight refuses every time. Two did:
 * the selector-shadow miss record (two claims behind one proof, `shared-proof`) and the CI-learning draft (a proof
 * on a path the record does not declare, `proof-scope`).
 *
 * The shared machine-shard lint (W1-T12833) did not apply the promotion, so its census could not see the class.
 * These tests read the promoted checks from the linter itself, beside the shared lint, and walk the census
 * suite's own member list, so there is one enumeration of machine templates and not two.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { MACHINE_SHARD_LINT_OPTIONS, machineShardLintRefusal, renderMachineShard, type MachineShardSpec } from "#src/lib/machine-filing.js";
import {
  ciLearningGoldenFixtureDir, ciLearningLessonsFile, ciLearningRecordVerdict, ciLearningShardYaml, fileCiLearningShards,
  type CiLearningShardDraft,
} from "#src/lib/measurement-cadence.js";
import { loadPlanFromYaml, type Task } from "#src/lib/plan.js";
import { selectorShadowMissTask } from "#src/lib/selector-shadow-gardener.js";
import { lintTask, PLAN_ONLY_NEW_TASK_DIAGNOSTIC_CHECKS, promoteIntroducedPlanOnlyDiagnostics } from "#src/lib/task-linter.js";
import {
  CENSUS, writerCallSites, type CensusMember,
} from "#test/gardeners/every-machine-shard-generator-passes-the-changed-task-plan-lint.test.js";

const SOURCE = "plan/tasks.d/w1-t998360-promotion-fixture.yaml";
const PROMOTED = "(plan-only promotion)";

const parsed = (text: string): Task => loadPlanFromYaml(text, SOURCE).tasks[0]!;

/** The checks the plan pull request preflight blocks on a NEW shard and the unpromoted lint only warns about. Read
 *  from the linter, not from the shared lint under test. No checkout is passed, so a promoted check that needs base
 *  files reports nothing here, as it reports nothing where a template is rendered. */
function promotedAtThePreflight(text: string): string[] {
  const raw = lintTask(parsed(text), MACHINE_SHARD_LINT_OPTIONS).violations;
  return promoteIntroducedPlanOnlyDiagnostics(raw, undefined, true)
    .filter((v, i) => v.severity === "block" && raw[i]!.severity === "warn").map((v) => v.check);
}

const SPEC: MachineShardSpec = {
  taskId: "W1-T998360",
  title: "Read the widened row without dropping the rows already written",
  origin: "fix-lane:promotion-fixture",
  files: ["src/lib/machine-filing.ts", "test/gardeners/the-widened-row-is-read.test.ts"],
  acceptance: [{ claim: "the reader accepts the widened row", proof: "unit test: W1-T998360: the reader accepts the widened row" }],
  invariants: { none: "the fixture adds a reader and changes no existing one" },
};
/** Two claims behind one proof: `shared-proof`. */
const SHARED_PROOF: MachineShardSpec = { ...SPEC,
  acceptance: [...SPEC.acceptance, { claim: "a row written before the change still reads", proof: SPEC.acceptance[0]!.proof }] };
/** A proof on a path the record does not declare: `proof-scope`. */
const UNDECLARED_PATH: MachineShardSpec = { ...SPEC,
  acceptance: [...SPEC.acceptance, { claim: "the fixture names the widened row", proof: "grep: widened in test/fixtures/rows/widened.json" }] };

test("W1-T13035 criterion 1: the shared machine-shard lint applies the plan-only promotion and names the promoted check it refuses", () => {
  const clean = renderMachineShard(SPEC);
  assert.deepEqual(promotedAtThePreflight(clean.text), [], "control: the fixture record carries no promoted check");
  assert.equal(clean.refused, undefined, "control: and the shared lint admits it");

  for (const [check, spec] of [["shared-proof", SHARED_PROOF], ["proof-scope", UNDECLARED_PATH]] as const) {
    const rendered = renderMachineShard(spec);
    // Control: without the promotion the check is only a warning, which is why the lint read these records as clean.
    const unpromoted = lintTask(parsed(rendered.text), MACHINE_SHARD_LINT_OPTIONS);
    assert.deepEqual(unpromoted.violations.map((v) => `${v.severity}:${v.check}`), [`warn:${check}`]);
    assert.equal(unpromoted.ok, true);
    assert.deepEqual(promotedAtThePreflight(rendered.text), [check], `the plan preflight blocks a new shard for ${check}`);
    assert.equal(rendered.refused, `${check} ${PROMOTED}`, `the writer refuses the record where it is rendered, naming ${check}`);
    assert.equal(machineShardLintRefusal(rendered.text, SOURCE), `${check} ${PROMOTED}`, "and a filer that assembles its own text gets the same answer");
  }

  // shard-shape reads the record's verify value. A machine record that is not parked at verify: human is already
  // blocked by machine-author-verify, so the promoted check is named beside that block, never alone.
  const misshapen = clean.text.replace("  verify: human", "  verify: sometimes");
  assert.notEqual(misshapen, clean.text, "the fixture changed the verify value");
  assert.deepEqual(promotedAtThePreflight(misshapen), ["shard-shape"]);
  assert.equal(machineShardLintRefusal(misshapen, SOURCE), `machine-author-verify, shard-shape ${PROMOTED}`);

  // A check that blocks without the promotion is named without the mark.
  assert.equal(renderMachineShard({ ...SPEC, invariants: { declared: [] } }).refused, "design-invariant-proof");
  // The three checks a record's own text decides are in the set the preflight promotes: this suite follows that set.
  for (const check of ["shared-proof", "proof-scope", "shard-shape"] as const) assert.ok(PLAN_ONLY_NEW_TASK_DIAGNOSTIC_CHECKS.has(check), check);
});

const MISS = { runId: 1, headSha: "abc", selection: "narrow" as const, file: "test/prompt-render.test.ts" };

test("W1-T13035 criterion 2: the selector-shadow miss record gives each acceptance claim its own proof and passes the shared lint with the promotion applied", () => {
  const records: Array<[string, string]> = [
    ["with its recorded changed paths", selectorShadowMissTask(MISS, "W1-T998361", ["src/run-task.ts"])],
    ["with no changed path read", selectorShadowMissTask(MISS, "W1-T998361")],
  ];
  for (const [label, text] of records) {
    assert.deepEqual(promotedAtThePreflight(text), [], `${label}: the record carries no check the plan preflight promotes`);
    const task = parsed(text);
    const proofs = (task.acceptance ?? []).map((c) => c.proof ?? "");
    assert.equal(proofs.length, 3, `${label}: two claims and the template's declared invariant`);
    assert.equal(new Set(proofs).size, proofs.length, `${label}: each claim has its own proof (${proofs.join(" | ")})`);
    for (const proof of proofs.slice(0, 2)) {
      assert.match(proof, /^unit test: W1-T998361: \S/, `${label}: a named test the build adds`);
      const title = proof.slice("unit test: ".length);
      assert.ok(task.design?.includes(`"${title}"`), `${label}: the design names the test "${title}"`);
      assert.ok(task.note?.includes(`"${title}"`), `${label}: the note tells the worker to add the test "${title}"`);
    }
    assert.equal(machineShardLintRefusal(text, SOURCE), undefined, `${label}: the shared lint admits it`);

    // Control: with one proof behind both claims again, the same record is refused by name.
    const oneProof = text.replace(`proof: ${JSON.stringify(proofs[1])}`, `proof: ${JSON.stringify(proofs[0])}`);
    assert.notEqual(oneProof, text, "the fixture changed the second proof");
    assert.equal(machineShardLintRefusal(oneProof, SOURCE), `shared-proof ${PROMOTED}`);
  }
});

const FINDING = "ci-learning:4283:coverage-ratchet";

function ciLearningDraft(): CiLearningShardDraft {
  return {
    findingId: FINDING,
    title: "THE coverage-ratchet GATE WENT RED ON #4283 AND WAS REPAIRED — carry the lesson to the lane that hit it",
    gate: "coverage-ratchet", prs: [4283], dominantRepairFiles: [], pr: 4283, repairFiles: ["src/lib/rule-efficacy.ts"],
    author_class: "machine", verify: "human", remedySurface: "learnings/*.yaml",
  } as CiLearningShardDraft;
}

test("W1-T13035 criterion 3: the CI-learning draft's proofs read only the path its record declares and it passes the shared lint with the promotion applied", () => {
  const text = ciLearningShardYaml(ciLearningDraft(), "W1-T998362", [1]);
  assert.deepEqual(promotedAtThePreflight(text), [], "the draft carries no check the plan preflight promotes");
  const task = parsed(text);
  const lessonsFile = ciLearningLessonsFile(FINDING);
  const fixtureDir = ciLearningGoldenFixtureDir(FINDING);
  // Machine-filing admission takes a CI-learning record with exactly one declared path (W1-T10027), so the golden
  // fixture cannot join files: and each proof reads the lessons file instead.
  assert.deepEqual(task.files, [lessonsFile]);
  const proofs = (task.acceptance ?? []).map((c) => c.proof ?? "");
  assert.deepEqual(proofs, [`grep: ${FINDING} in ${lessonsFile}`, `grep: ${fixtureDir} in ${lessonsFile}`], "each proof reads the declared lessons file, and each is its own");
  // The golden verdict is still asked for: the worker is told where to build it and to name it in the entry.
  assert.ok(task.note?.includes(`golden verdict under ${fixtureDir}/`), task.note);
  assert.ok(task.note?.includes(`Name ${fixtureDir} in the entry`), task.note);

  assert.equal(machineShardLintRefusal(text, SOURCE), undefined, "the shared lint admits the draft");
  assert.deepEqual(ciLearningRecordVerdict(text, "ci-learning:W1-T998362"), { ok: true, reason: "" });
  const written: string[] = [];
  const fs = { mkdirSync: () => undefined, writeFileSync: (path: string, data: string) => void written.push(`${path}\n${data}`) };
  const out = fileCiLearningShards([ciLearningDraft()], "/wt", { mintTaskId: () => "W1-T998362", fs, join: (...p) => p.join("/"), planOrigins: [] });
  assert.deepEqual(out.refused, [], "the filer writes the draft");
  assert.equal(written.length, 1);
  assert.equal(machineShardLintRefusal(written[0]!.slice(written[0]!.indexOf("\n") + 1), SOURCE), undefined, "and what it wrote passes the shared lint");

  // Control: pointed back at the fixture the record does not declare, the filer's verdict refuses it by name.
  const undeclared = text.replace(`proof: ${JSON.stringify(proofs[1])}`, `proof: ${JSON.stringify(`grep: ${FINDING} in ${fixtureDir}/criteria.yaml`)}`);
  assert.notEqual(undeclared, text, "the fixture changed the second proof");
  assert.equal(machineShardLintRefusal(undeclared, SOURCE), `proof-scope ${PROMOTED}`);
  assert.deepEqual(ciLearningRecordVerdict(undeclared, "ci-learning:W1-T998362"), { ok: false, reason: `block:proof-scope ${PROMOTED}` });
});

/** Every record of every member through the shared lint: one line per refused record, and one per promoted check
 *  the shared lint did not name. */
async function walk(t: TestContext, members: readonly CensusMember[]): Promise<{ records: number; refused: string[] }> {
  const refused: string[] = [];
  let records = 0;
  for (const member of members) {
    let texts: string[];
    try {
      texts = await member.render(t);
    } catch (error) {
      refused.push(`${member.name}: ${String((error as Error)?.message ?? error)}`);
      continue;
    }
    assert.ok(texts.length > 0, `${member.name} rendered no record`);
    for (const [index, text] of texts.entries()) {
      records += 1;
      const refusal = machineShardLintRefusal(text, SOURCE);
      if (refusal !== undefined) refused.push(`${member.name} #${index + 1}: ${refusal}`);
      for (const check of promotedAtThePreflight(text)) {
        if (!(refusal ?? "").includes(`${check} ${PROMOTED}`)) refused.push(`${member.name} #${index + 1}: the shared lint does not name ${check}, which the plan preflight promotes`);
      }
    }
  }
  return { records, refused };
}

test("W1-T13035 criterion 4: every machine template in the census is walked through the shared lint with the promotion applied, and a refused one fails by name", async (t) => {
  const all = await walk(t, CENSUS);
  assert.ok(all.records >= CENSUS.length && CENSUS.length >= 15, `positive control: the walk rendered ${all.records} records from ${CENSUS.length} members`);
  assert.deepEqual(all.refused, [], "no machine template renders a record its own plan pull request would be refused for");

  // The walk is every template: each call site of the shared writer in src/ is one member of the list walked above.
  const expected: Record<string, number> = {};
  for (const member of CENSUS) expected[`${member.module}:${member.writer}`] = (expected[`${member.module}:${member.writer}`] ?? 0) + 1;
  const found = writerCallSites();
  assert.ok(Object.keys(found).length > 0, "positive control: the scan found writer call sites");
  assert.deepEqual(found, expected, "a template left out of the walk is a call site with no member");

  // A template that would be refused fails the walk by its name and its promoted check.
  const planted: CensusMember = { name: "planted template", module: "src/lib/machine-filing.ts", writer: "renderMachineShard",
    render: () => [renderMachineShard(SHARED_PROOF).text, renderMachineShard(SPEC).text, renderMachineShard(UNDECLARED_PATH).text] };
  assert.deepEqual((await walk(t, [planted])).refused, [`planted template #1: shared-proof ${PROMOTED}`, `planted template #3: proof-scope ${PROMOTED}`]);
});
