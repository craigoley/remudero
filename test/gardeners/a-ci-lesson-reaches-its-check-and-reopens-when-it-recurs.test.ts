// W1-T14140 — A CI LESSON IS KEYED ON ITS FAILING CHECK, IS PROVED TO REACH A ROUND THAT FAILS THAT CHECK, AND IS
// REOPENED WHEN ITS GATE KEEPS FAILING. Before this, a machine-filed lesson was proved by `grep: <findingId> in
// <lessonsFile>` (string presence, not reach), most lessons matched by file path only, and a gate that already held a
// lesson was dropped forever (`heldGates`) even when judgeCiLessonEfficacy read that lesson `recurred`.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CiFailureCorpus, CiFailurePair, CiFullyObservedGatePr } from "#src/lib/ci-failure-corpus.js";
import { episodesOf, FLOW_LADDER, ladderOrigin, ownRedCauseKey } from "#src/lib/flow-remedy-gardener.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS, loadLearningsCorpus, selectLearnings } from "#src/lib/learnings.js";
import { machineShardFilingRefusal } from "#src/lib/machine-filing.js";
import {
  CI_LEARNING_ID_RE,
  CI_LEARNING_LADDER_REOPEN,
  CI_LEARNING_REMEDY_SURFACE,
  ciLearningGateOf,
  ciLearningGoldenFixtureDir,
  ciLearningLessonsFile,
  ciLearningRecordVerdict,
  ciLearningReopenOf,
  ciLearningShardYaml,
  ciLessonSelectionTestTitle,
  mintCiLearningShards,
  parseFiledCiLesson,
  type CiLearningShardDraft,
} from "#src/lib/measurement-cadence.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const GENERATED_SUITE = "test/learning/every-ci-lesson-is-selected-for-its-own-check.test.ts";

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

test("W1-T14140 criterion 1: a drafted CI lesson shard tells its worker to write the finding id as src and the gate's check name as an error signature", () => {
  // A comma inside the check name is the case a bare YAML flow list would split into three signatures.
  const gate = "lint-plan (merge the shards, classify)";
  const d = draft(gate);
  const task = loadPlanFromYaml(ciLearningShardYaml(d, "W1-T900001"), "criterion 1").tasks[0]!;
  const note = task.note ?? "";
  assert.ok(note.includes(`src: ${JSON.stringify(d.findingId)}`), note);
  assert.ok(note.includes(`error_signatures: [${JSON.stringify(gate)}]`), note);
  const fields = instructedEntryFields(note);
  assert.deepEqual(fields, { src: d.findingId, errorSignatures: [gate] });

  // Write the entry exactly as instructed into a copy of the real corpus, at the path the shard declares, and run the
  // generated suite's own check: a round whose failing check is the gate selects it.
  const dir = mkdtempSync(join(tmpdir(), "rmd-ci-lesson-reach-"));
  try {
    cpSync(join(REPO_ROOT, "learnings"), join(dir, "learnings"), { recursive: true });
    const lessonPath = join(dir, task.files![0]!);
    mkdirSync(join(dir, "learnings", "ci.d"), { recursive: true });
    writeFileSync(lessonPath, [
      "- id: drafted-ci-lesson",
      "  subsystem: ci",
      "  lifecycle: active",
      '  files: ["src/lib/x.ts"]',
      `  error_signatures: ${JSON.stringify(fields.errorSignatures)}`,
      "  fact: Read the failed step before choosing a remedy.",
      `  src: ${JSON.stringify(fields.src)}`,
      "",
    ].join("\n"));
    const entries = loadLearningsCorpus(join(dir, "learnings"));
    const written = entries.find((e) => e.id === "drafted-ci-lesson")!;
    assert.deepEqual(written.errorSignatures, [gate], "the YAML the note instructs parses to the one check name");
    assert.equal(ciLearningGateOf(written.src), gate);
    const { selected } = selectLearnings(entries, undefined, DEFAULT_KNOWLEDGE_BUDGET_CHARS, { text: gate });
    assert.ok(selected.some((e) => e.id === "drafted-ci-lesson"), "the drafted lesson is selected for its own check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T14140 criterion 3: a drafted CI lesson's first proof is the generated unit test that selects it for its own check, not a grep of its id", () => {
  const d = draft("coverage-ratchet", 111);
  const shard = ciLearningShardYaml(d, "W1-T900003");
  const task = loadPlanFromYaml(shard, "criterion 3").tasks[0]!;
  const lessonsFile = ciLearningLessonsFile(d.findingId);
  const fixturePath = `${ciLearningGoldenFixtureDir(d.findingId)}/criteria.yaml`;
  const [first, second] = task.acceptance!;
  const title = ciLessonSelectionTestTitle(d.findingId);
  assert.equal(title, "ci lesson ci-learning:111:coverage-ratchet is selected for its own check");
  assert.equal(first!.proof, `unit test: ${title}`);
  assert.ok(!first!.proof.startsWith("grep:") && !first!.proof.includes(lessonsFile), first!.proof);
  assert.equal(second!.proof, `grep: ${d.findingId} in ${fixturePath}`, "the golden-fixture proof is kept");

  // The title is the one the generated suite renders for an entry whose src is this finding id.
  const source = readFileSync(join(REPO_ROOT, GENERATED_SUITE), "utf8");
  const template = /test\(`([^`]*)`/.exec(source)?.[1];
  assert.equal(template, "ci lesson ${entry.src} is selected for its own check");
  assert.equal(template!.replace("${entry.src}", d.findingId), title);

  // A `unit test:` title names no path, so the machine shard keeps its two-file scope and passes admission.
  assert.deepEqual(task.files, [lessonsFile, fixturePath]);
  assert.deepEqual(ciLearningRecordVerdict(shard, "criterion 3"), { ok: true, reason: "" });
  assert.equal(machineShardFilingRefusal(shard, "criterion 3", { pathExists: () => false, pathExistsAtBase: () => false }), undefined);
});

test("W1-T14140 criterion 4: a gate whose held lesson recurred is drafted again as a reopen, numbered one past the prior reopens", () => {
  const base = "ci-learning:100:ci-gate";
  // 110 is the lesson's own evidence (at or below its watermark); 130 and 140 came after it landed.
  const first = mintCiLearningShards(corpus([pair(110), pair(130), pair(140)]), [base], undefined,
    [{ findingId: base, gate: "ci-gate", watermarkPr: 120 }]);
  assert.deepEqual(first.drafts.map((d) => [d.findingId, d.gate, d.prs, d.reopen]), [
    ["ci-learning:130:ci-gate#r1", "ci-gate", [130, 140], { n: 1, priorFindingId: base, recurredPrs: [130, 140] }],
  ]);
  assert.deepEqual(first.ladder, []);

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
  assert.equal(task.acceptance![0]!.proof, `unit test: ${ciLessonSelectionTestTitle("ci-learning:130:ci-gate#r1")}`);
  assert.ok(task.note!.includes(base), "the reopen names the lesson that did not hold");

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
});

test("W1-T14140 criterion 5: the third reopen goes to the flow-remedy ladder, and a held or unmeasurable lesson files nothing", () => {
  const filed = ["ci-learning:100:ci-gate", "ci-learning:130:ci-gate#r1", "ci-learning:150:ci-gate#r2"];
  const lessons = [{ findingId: filed[2]!, gate: "ci-gate", watermarkPr: 160 }];
  const third = mintCiLearningShards(corpus([pair(170), pair(171, "commitlint")]), filed, undefined, lessons);
  assert.equal(CI_LEARNING_LADDER_REOPEN, 3);
  assert.deepEqual(third.drafts.map((d) => d.findingId), ["ci-learning:171:commitlint"], "no fourth lesson is drafted for ci-gate");
  const cause = ownRedCauseKey("ci-gate");
  assert.deepEqual(third.ladder, [{
    gate: "ci-gate", findingId: filed[2], reopen: 3, recurredPrs: [170], cause, origin: ladderOrigin(FLOW_LADDER, cause),
  }]);
  assert.equal(third.ladder[0]!.origin, "flow-blocker:own-red:ci-gate failed on <sha>");
  // The cause is the one the flow ladder already prices from the sweep's own-red reason for that check.
  const [episode] = episodesOf([{ step: "sweep.disposed", ts: "2026-11-20T10:00:00.000Z", pr_number: 170, blocker: "own-red",
    blocker_owner: "fix-lane", reason: "ci-gate failed on abcdef1" }], new Map(), Date.parse("2026-11-21T00:00:00.000Z"));
  assert.equal(episode!.key, cause);

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
