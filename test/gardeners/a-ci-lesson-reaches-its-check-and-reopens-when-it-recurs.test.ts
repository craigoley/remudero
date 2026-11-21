// W1-T14140 — A CI LESSON IS KEYED ON ITS FAILING CHECK, IS PROVED TO REACH A ROUND THAT FAILS THAT CHECK, AND IS
// REOPENED WHEN ITS GATE KEEPS FAILING. Before this, a machine-filed lesson was proved only by `grep: <findingId> in
// <lessonsFile>` (string presence, not reach), most lessons matched by file path only, and a gate that already held a
// lesson was dropped forever (`heldGates`) even when judgeCiLessonEfficacy read that lesson `recurred`. Reach is now
// enforced by the generated suite (test/learning/every-ci-lesson-is-selected-for-its-own-check.test.ts), which CI runs
// on every pull request; the template's proofs are unchanged.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectCiFailureCorpus, type CiFailureCorpus, type CiFailurePair, type CiFullyObservedGatePr } from "#src/lib/ci-failure-corpus.js";
import { fixedClock } from "#src/lib/clock.js";
import { CI_LESSON_HANDOFF_STEP, flowGardenSpec } from "#src/lib/flow-remedy-gardener.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import { loadLearningsCorpus } from "#src/lib/learnings.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import {
  CI_LEARNING_ID_RE,
  CI_LEARNING_LADDER_REOPEN,
  CI_LEARNING_REMEDY_SURFACE,
  ciLearningGateOf,
  ciLearningRecordVerdict,
  ciLearningReopenOf,
  ciLearningShardId,
  ciLearningShardYaml,
  ciLessonBindingErrors,
  ciLessonReach,
  mintCiLearningFromPlan,
  mintCiLearningShards,
  parseFiledCiLesson,
  type CiLearningShardDraft,
} from "#src/lib/measurement-cadence.js";
import { loadPlanFromYaml, type Task } from "#src/lib/plan.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const pair = (pr: number, gate = "ci-gate", state: CiFailurePair["state"] = "repaired"): CiFailurePair => ({
  pr, gate, state, redSha: `red${pr}`, greenSha: `green${pr}`, repairFiles: ["src/lib/x.ts"],
});

const corpus = (pairs: CiFailurePair[], fullyObservedGatePrs: CiFullyObservedGatePr[] = []): CiFailureCorpus => ({
  status: pairs.length > 0 ? "populated" : "clear", prsScanned: pairs.length + fullyObservedGatePrs.length,
  unreadableShas: [], pairs, fullyObservedGatePrs,
});

function draft(gate: string, pr = 4321): CiLearningShardDraft {
  return {
    findingId: `ci-learning:${pr}:${gate}`, title: `THE ${gate} GATE REFUSED 1 PULL REQUEST`, gate, pr, prs: [pr],
    repairFiles: ["src/lib/x.ts"], dominantRepairFiles: [], action: "build", author_class: "machine", verify: "human",
    remedySurface: CI_LEARNING_REMEDY_SURFACE,
  };
}

/** What the drafted note tells the worker to write, read back out of the note itself. */
function instructedEntryFields(note: string): { src: string; errorSignatures: string[] } {
  const src = /src: ("ci-learning:[^"]+")/.exec(note)?.[1];
  const signatures = /error_signatures: (\["(?:[^"\\]|\\.)*"(?:, "(?:[^"\\]|\\.)*")*\])/.exec(note)?.[1];
  assert.ok(src, `the note names no src: "<findingId>" for the new entry: ${note}`);
  assert.ok(signatures, `the note names no error_signatures: [<gate>] for the new entry: ${note}`);
  return { src: JSON.parse(src) as string, errorSignatures: JSON.parse(signatures) as string[] };
}

/** A copy of the real corpus with one more lesson file written into learnings/ci.d/, read back as the suite reads it. */
function corpusWithLesson(file: string, lines: string[], tasks: Task[] = [], replacement?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ci-lesson-reach-"));
  try {
    cpSync(join(REPO_ROOT, "learnings"), join(dir, "learnings"), { recursive: true });
    mkdirSync(join(dir, "learnings", "ci.d"), { recursive: true });
    writeFileSync(join(dir, file), [...lines, ""].join("\n"));
    if (replacement) writeFileSync(join(dir, "learnings", "ci.d", "replacement.yaml"), replacement.join("\n"));
    const entries = loadLearningsCorpus(join(dir, "learnings"));
    return { entries, bindingErrors: ciLessonBindingErrors(dir, tasks, entries) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lessonLines = (id: string, src: string, extra: string[] = [], lifecycle = "active") => [
  `- id: ${id}`, "  subsystem: ci", `  lifecycle: ${lifecycle}`, '  files: ["src/lib/x.ts"]', ...extra,
  "  fact: Read the failed step before choosing a remedy.", `  src: ${JSON.stringify(src)}`,
];

test("W1-T14140 criterion 1: a drafted CI lesson shard tells its worker to write the finding id as src and the gate's check name as an error signature", () => {
  // A comma inside the check name is the case a bare YAML flow list would split into three signatures.
  const gate = "lint-plan (merge the shards, classify)";
  const d = draft(gate);
  const shard = ciLearningShardYaml(d, "W1-T900001");
  const task = loadPlanFromYaml(shard, "criterion 1").tasks[0]!;
  const note = task.note ?? "";
  assert.ok(note.includes(`src: ${JSON.stringify(d.findingId)}`), note);
  assert.ok(note.includes(`error_signatures: [${JSON.stringify(gate)}]`), note);
  const fields = instructedEntryFields(note);
  assert.deepEqual(fields, { src: d.findingId, errorSignatures: [gate] });
  assert.deepEqual(ciLearningRecordVerdict(shard, "criterion 1"), { ok: true, reason: "" });

  // Write the entry exactly as instructed, at the path the shard declares, into a copy of the real corpus: the
  // generated suite's own reach check selects it for a round whose failing check is the gate.
  const { entries, bindingErrors } = corpusWithLesson(task.files![0]!,
    lessonLines("drafted-ci-lesson", fields.src, [`  error_signatures: ${JSON.stringify(fields.errorSignatures)}`]), [task]);
  assert.deepEqual(bindingErrors, []);
  const reach = ciLessonReach(entries).find((r) => r.entry.id === "drafted-ci-lesson");
  assert.deepEqual(reach?.entry.errorSignatures, [gate], "the YAML the note instructs parses to the one check name");
  assert.deepEqual([reach?.gate, reach?.selected], [gate, true], "the drafted lesson is selected for its own check");
});

test("W1-T14140 criterion 3: an active ci-learning entry that is not selected for its own check fails the generated suite", () => {
  const drafted = draft("lint-plan (merge the shards, classify)");
  const [task] = loadPlanFromYaml(ciLearningShardYaml(drafted, "W1-T900002"), "filed lesson").tasks;
  const file = task!.files![0]!;
  const { entries, bindingErrors } = corpusWithLesson(file, [
    ...lessonLines("unsigned-ci-lesson", drafted.findingId),
    ...lessonLines("unsigned-superseded-ci-lesson", "ci-learning:4322:lint-plan (merge the shards, classify)", [], "superseded"),
  ], [task!]);
  assert.deepEqual(bindingErrors, [], "the unsigned entry belongs to the filed task");
  const reach = ciLessonReach(entries);
  // The generated suite asserts `selected` for every row: the unsigned active lesson is the one row it would fail on.
  assert.deepEqual(reach.filter((r) => !r.selected).map((r) => [r.entry.id, r.gate]),
    [["unsigned-ci-lesson", "lint-plan (merge the shards, classify)"]]);
  // A superseded entry is never injected, so the suite generates no test for it.
  assert.equal(reach.some((r) => r.entry.id === "unsigned-superseded-ci-lesson"), false);
  // CONTROL: every lesson already on main is selected for its own check, so the red above is the new entry's alone.
  assert.ok(reach.length > 2 && reach.filter((r) => r.entry.id !== "unsigned-ci-lesson").every((r) => r.selected));

  const comment = `# proof cites ${drafted.findingId}`;
  const otherGate = "some-other-check";
  const otherId = ciLearningShardId({ pr: 4321, gate: otherGate });
  const signed = [`  error_signatures: ${JSON.stringify([otherGate])}`];
  const substituted = corpusWithLesson(file, [comment, ...lessonLines("substituted", otherId, signed)], [task!]);
  assert.ok(ciLessonReach(substituted.entries).find((r) => r.entry.id === "substituted")?.selected);
  assert.match(substituted.bindingErrors.join("\n"), /substituted has src .*expected/);
  for (const replacement of ["PR#4321", drafted.findingId.replace(":4321:", ":4320:")]) {
    const renamed = corpusWithLesson(file,
      [comment, ...lessonLines("renamed", replacement, [`  error_signatures: ${JSON.stringify([drafted.gate])}`])], [task!]);
    assert.match(renamed.bindingErrors.join("\n"), /renamed has src .*expected/);
  }
  const empty = corpusWithLesson(file, [comment, "[]"], [task!]);
  assert.match(empty.bindingErrors.join("\n"), /must contain a corpus entry/);
  const retired = lessonLines("retired", drafted.findingId, ['  superseded_by: "replacement"'], "superseded");
  const unlinked = corpusWithLesson(file, retired, [task!]);
  assert.match(unlinked.bindingErrors.join("\n"), /active replacement/);
  const replaced = corpusWithLesson(file, retired, [task!],
    lessonLines("replacement", drafted.findingId, [`  error_signatures: ${JSON.stringify([drafted.gate])}`]));
  assert.deepEqual(replaced.bindingErrors, []);
  assert.equal(ciLessonReach(replaced.entries).some((r) => r.entry.id === "retired"), false);
});

test("W1-T14140 criterion 4: a gate whose held lesson recurred is drafted again as a reopen, numbered one past the prior reopens", () => {
  const base = "ci-learning:100:ci-gate";
  // 110 is the lesson's own evidence (at or below its watermark); 130 and 140 came after it landed.
  const first = mintCiLearningShards(corpus([pair(110), pair(130, "ci-gate", "open"), pair(140), pair(140)]), [base], undefined,
    [{ findingId: base, gate: "ci-gate", watermarkPr: 120 }]);
  assert.deepEqual(first.drafts.map((d) => [d.findingId, d.gate, d.prs, d.reopen]), [
    ["ci-learning:130:ci-gate#r1", "ci-gate", [130, 140], { n: 1, priorFindingId: base, recurredPrs: [130, 140] }],
  ]);
  assert.deepEqual(first.ladder, []);
  assert.deepEqual(first.drafts[0]?.dominantRepairFiles, [], "two repairs on one PR contribute one file hit");

  // The reopen's shard round-trips: its origin carries the suffix, its gate and watermark read back without it.
  const shard = ciLearningShardYaml(first.drafts[0]!, "W1-T900004");
  assert.deepEqual(parseFiledCiLesson(shard), { findingId: "ci-learning:130:ci-gate#r1", gate: "ci-gate", watermarkPr: 140 });
  assert.equal(ciLearningGateOf("ci-learning:130:ci-gate#r1"), "ci-gate");
  assert.equal(ciLearningReopenOf("ci-learning:130:ci-gate#r1"), 1);
  assert.equal(ciLearningReopenOf(base), 0);
  assert.equal(CI_LEARNING_ID_RE.exec("ci-learning:130:ci-gate#r1")?.[2], "1");
  assert.equal(CI_LEARNING_ID_RE.test("ci-learning:hand-fix:ci-gate@src/lib/x.ts#2"), false, "a hand-fix origin names no gate");
  assert.deepEqual(ciLearningRecordVerdict(shard, "criterion 4"), { ok: true, reason: "" });
  const task = loadPlanFromYaml(shard, "criterion 4").tasks[0]!;
  assert.ok(task.note!.includes(base), "the reopen names the lesson that did not hold");
  assert.ok(task.note!.includes("went red again on #130;"), "an open refusal is recorded as open evidence");

  // The next reopen is numbered from the reopens already filed, and judged on the newest lesson.
  const filed = [base, "ci-learning:130:ci-gate#r1"];
  const lessons = [{ findingId: base, gate: "ci-gate", watermarkPr: 120 }, { findingId: filed[1]!, gate: "ci-gate", watermarkPr: 140 }];
  const second = mintCiLearningShards(corpus([pair(130), pair(140), pair(150)]), filed, undefined, lessons);
  assert.deepEqual(second.drafts.map((d) => [d.findingId, d.prs, d.reopen?.n]), [["ci-learning:150:ci-gate#r2", [150], 2]]);

  // A reopen whose own lesson has not been judged yet is never stacked on top of the older lesson's recurrence.
  const pending = mintCiLearningShards(corpus([pair(130), pair(140), pair(150)]), filed, undefined, lessons.slice(0, 1));
  assert.deepEqual(pending.drafts, []);
  // Two first lessons for one gate (the duplicates filed before gate dedup) are judged on the newer watermark only.
  const twins = ["ci-learning:90:ci-gate", base];
  const twinLessons = [{ findingId: twins[0]!, gate: "ci-gate", watermarkPr: 95 }, { findingId: base, gate: "ci-gate", watermarkPr: 120 }];
  assert.deepEqual(mintCiLearningShards(corpus([pair(110)]), twins, undefined, twinLessons).drafts, []);
  assert.deepEqual(mintCiLearningShards(corpus([pair(130)]), twins, undefined, twinLessons).drafts.map((d) => d.reopen),
    [{ n: 1, priorFindingId: base, recurredPrs: [130] }]);
  // Without the judged lessons the rung keeps dropping a held gate, exactly as before.
  assert.deepEqual(mintCiLearningShards(corpus([pair(130)]), [base]).drafts, []);

  const gate = 'verify "target" %23#r1';
  const literal = ciLearningShardId({ pr: 100, gate });
  assert.deepEqual([ciLearningGateOf(literal), ciLearningReopenOf(literal)], [gate, 0]);
  const openWindow = collectCiFailureCorpus({
    prs: [{ number: 130, commits: [{ sha: "red130", rollup: [
      { name: gate, conclusion: "FAILURE" }, { name: "first-time-red", conclusion: "FAILURE" },
    ] }] }],
  });
  const openReopen = mintCiLearningShards(openWindow, [literal], undefined, [{ findingId: literal, gate, watermarkPr: 120 }]);
  assert.deepEqual(openReopen.drafts.map((d) => [d.gate, d.prs, d.repairFiles, d.action]), [[gate, [130], [], "unclear"]]);
  const [openDraft] = openReopen.drafts;
  assert.ok(openDraft?.findingId.endsWith("#r1"));
  assert.deepEqual([ciLearningGateOf(openDraft.findingId), ciLearningReopenOf(openDraft.findingId)], [gate, 1]);
  assert.deepEqual(parseFiledCiLesson(ciLearningShardYaml(openDraft, "W1-T900005")),
    { findingId: openDraft.findingId, gate, watermarkPr: 130 });
  assert.notEqual(literal, ciLearningShardId({ pr: 100, gate: gate.slice(0, -3) }, 1));
});

test("W1-T14140 criterion 5: the third reopen goes to the flow-remedy ladder, and a held or unmeasurable lesson files nothing", () => {
  const filed = ["ci-learning:100:ci-gate", "ci-learning:130:ci-gate#r1", "ci-learning:150:ci-gate#r2"];
  const lessons = [{ findingId: filed[2]!, gate: "ci-gate", watermarkPr: 160 }];
  const third = mintCiLearningShards(corpus([pair(170, "ci-gate", "open"), pair(171, "commitlint")]), filed, undefined, lessons);
  assert.equal(CI_LEARNING_LADDER_REOPEN, 3);
  assert.deepEqual(third.drafts.map((d) => d.findingId), ["ci-learning:171:commitlint"], "no fourth lesson is drafted for ci-gate");
  assert.deepEqual(third.ladder, [{
    gate: "ci-gate", findingId: filed[2], reopen: 3, recurredPrs: [170], redHeads: [{ pr: 170, sha: "red170" }],
  }]);
  const handoff = { step: CI_LESSON_HANDOFF_STEP, gate: "ci-gate", red_heads: third.ladder[0]!.redHeads };
  const inventory = flowInventory([handoff]);
  assert.deepEqual(inventory.candidates.map((p) => p.key), [
    "own-red:required checks red", "own-red:commitlint failed on <sha>; ci-gate failed on <sha>",
  ]);
  assert.equal(inventory.next?.origin, "flow-blocker:own-red:required checks red");
  assert.deepEqual(flowInventory([]).candidates, []);

  // HELD: later PRs met the gate and it did not refuse them.
  const held = mintCiLearningShards(corpus([], [{ pr: 180, gate: "ci-gate" }]), filed, undefined, lessons);
  assert.deepEqual([held.drafts, held.ladder, held.status], [[], [], "clear"]);
  // UNMEASURABLE: nothing came after the lesson, so there is nothing to judge it on.
  const unmeasurable = mintCiLearningShards(corpus([pair(160)]), filed, undefined, lessons);
  assert.deepEqual([unmeasurable.drafts, unmeasurable.ladder], [[], []]);
  // The same held and unmeasurable verdicts on the first lesson file nothing either.
  const once = [{ findingId: filed[0]!, gate: "ci-gate", watermarkPr: 120 }];
  assert.deepEqual(mintCiLearningShards(corpus([], [{ pr: 130, gate: "ci-gate" }]), filed.slice(0, 1), undefined, once).drafts, []);
  assert.deepEqual(mintCiLearningShards(corpus([pair(110)]), filed.slice(0, 1), undefined, once).drafts, []);
});

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const HOUR = 3_600_000;

function flowInventory(records: LedgerRecord[], pr = 170) {
  const iso = (h: number) => new Date(NOW + h * HOUR).toISOString();
  const deps: GardenerDeps = { repoRoot: "/unused", stateDir: "/unused", clock: fixedClock(NOW), log: () => {},
    openWorkspace: () => { throw new Error("unexpected workspace"); } };
  const sweep: LedgerRecord[] = [
    { step: "sweep.disposed", pr_number: pr, ts: iso(-6), blocker: "own-red", reason: "lint failed on abcdef1",
      head_sha: "other-head", blocker_owner: "fix-lane" },
    { step: "sweep.disposed", pr_number: pr, ts: iso(-5), blocker: "own-red", reason: "required checks red",
      head_sha: `red${pr}`, blocker_owner: "fix-lane" },
    { step: "sweep.disposed", pr_number: pr, ts: iso(-2), blocker: "own-red", reason: "commitlint failed on abcdef1; ci-gate failed on abcdef1",
      head_sha: "a-later-head", red_checks: ["commitlint", "ci-gate"], blocker_owner: "fix-lane" },
    { step: "sweep.disposed", pr_number: pr, ts: iso(-1), blocker: "armed-idle", reason: "armed", blocker_owner: "armed-idle-merge" },
    { step: "sweep.disposed", pr_number: 99, ts: iso(-3), blocker: "own-red", reason: "required checks red",
      head_sha: `red${pr}`, red_checks: ["ci-gate"], blocker_owner: "fix-lane" },
    { step: "sweep.disposed", pr_number: 99, ts: iso(-1), blocker: "armed-idle", reason: "armed", blocker_owner: "armed-idle-merge" },
  ];
  const spec = flowGardenSpec(deps, { owner: "acme", repo: "remudero", mintTaskId: () => "W1-T900007",
    ledgerRecords: () => [...sweep, ...records], planState: () => ({ tasks: [] }),
    prOutcomes: () => new Map([pr, 99].map((number) =>
      [number, { state: "merged" as const, at: iso(-0.5), mergedBy: "remudero-fleet" }])),
    ownerSearch: { filesContaining: () => [{ file: "src/lib/sweep.ts", hits: 1 }], fileExists: () => true } });
  return spec.inventory();
}

test("W1-T14140 criterion 6: the measurement cadence hands the filed lessons to the mint, so a recurred gate reopens live", (t) => {
  // mintCiLearningFromPlan is the mint step of both callers in src/run-task.ts (the scheduled rung and `rmd ci-learning`);
  // test/ci-learning-safe-landing.test.ts drives those two callers end to end. This file does not import src/run-task.ts:
  // the affected-suite reach ratchet holds its importer count.
  const stateRoot = mkdtempSync(join(tmpdir(), "rmd-ci-lesson-cadence-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  const base = "ci-learning:100:ci-gate";
  const mint = (origins: string[], lessons: Parameters<typeof mintCiLearningFromPlan>[0]["readLessons"]) =>
    mintCiLearningFromPlan({ corpus: corpus([pair(130)]), alreadyFiledFindingIds: origins, readLessons: lessons, stateRoot, runId: "CI-LEARNING-TEST" });

  // The plan holds a lesson for ci-gate up to #120; #130 was refused after it landed. The mint reopens it.
  const live = mint([base], () => ({ status: "measured", lessons: [{ findingId: base, gate: "ci-gate", watermarkPr: 120 }] }));
  assert.deepEqual(live.result.drafts.map((d) => d.findingId), ["ci-learning:130:ci-gate#r1"]);
  assert.equal(live.filedLessons.status, "measured", "the read is handed back for the recurrence summary");
  // An unreadable plan read hands the mint nothing to judge, so the held gate stays dropped.
  assert.deepEqual(mint([base], () => ({ status: "unreadable" })).result.drafts, []);

  // At the third reopen the mint drafts no lesson and writes the hand-off the flow-remedy ladder reads.
  const filed = [base, "ci-learning:110:ci-gate#r1", "ci-learning:120:ci-gate#r2"];
  const third = mint(filed, () => ({ status: "measured", lessons: [{ findingId: filed[2]!, gate: "ci-gate", watermarkPr: 125 }] }));
  assert.deepEqual(third.result.drafts, []);
  const rows = readFileSync(join(stateRoot, "state", LEDGER_FILENAME), "utf8").trim().split("\n").map((l) => JSON.parse(l) as LedgerRecord);
  const handoffs = rows.filter((r) => r.step === CI_LESSON_HANDOFF_STEP);
  assert.deepEqual(handoffs.map((r) => [r.gate, r.finding_id, r.reopen, r.recurred_prs, r.red_heads]), [
    ["ci-gate", filed[2], 3, [130], [{ pr: 130, sha: "red130" }]],
  ]);
  const inventory = flowInventory(handoffs, 130);
  assert.equal(inventory.candidates.find((candidate) => candidate.key === "own-red:required checks red")?.prs, 1,
    "the handoff selects the matching PR only, even if another PR has the same check, head, and blocker reason");
});
