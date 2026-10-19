import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import * as learnings from "../src/lib/learnings.js";
import { applyLearningActions, cheapFingerprint, knowledgeGardenSpec } from "../src/lib/knowledge-gardener.js";
import {
  ciLearningGoldenFixtureDir, ciLearningLessonsFile, ciLearningRecordVerdict, ciLearningShardYaml, type CiLearningShardDraft,
} from "../src/lib/measurement-cadence.js";
import { machineShardFilingRefusal } from "../src/lib/machine-filing.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { gitRepo } from "./helpers/git-repo.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const generator = join(root, "scripts/generate-learnings-index.mjs");
const budget = await import("../scripts/learnings-budget-ratchet.mjs" as string);
const assertions = await import("../scripts/learnings-assert-check.mjs" as string);
const symbols = await import("../scripts/learnings-derive-symbols.mjs" as string);

function draft(pr: number, gate = "coverage-ratchet"): CiLearningShardDraft {
  return {
    findingId: `ci-learning:${pr}:${gate}`, title: "carry the measured gate lesson", gate, pr,
    prs: [pr], repairFiles: ["src/example.ts"], dominantRepairFiles: [],
    author_class: "machine", verify: "human", remedySurface: "learnings",
  };
}

function lesson(id: string, extra = {}) {
  return { id, files: ["src/example.ts"], fact: "Check measureLesson before acting.",
    src: "W1-T7954", lifecycle: "active", subsystem: "ci", ...extra };
}

function writeLesson(dir: string, filename: string, id: string, extra = {}) {
  const path = join(dir, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify([lesson(id, extra)]));
}

function generate(dir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [generator, "--dir", dir, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("W1-T7954: two concurrent lesson additions merge without conflict", () => {
  const repo = gitRepo({ kind: "lesson-merge" });
  try {
    const home = join(repo.dir, "learnings");
    writeLesson(home, "ci.yaml", "existing");
    writeFileSync(join(repo.dir, ".gitignore"), readFileSync(join(root, ".gitignore"), "utf8"));
    generate(home);
    repo.git("add", ".");
    repo.git("commit", "-m", "chore: seed lessons");
    for (const pr of [111, 222]) {
      repo.git("checkout", "-b", `lesson-${pr}`, "main");
      const task = loadPlanFromYaml(ciLearningShardYaml(draft(pr), `W1-T${pr}`), "merge fixture").tasks[0]!;
      const file = task.files![0]!;
      const path = join(repo.dir, file);
      if (existsSync(path)) {
        writeFileSync(path, readFileSync(path, "utf8") + stringify([lesson(`lesson-${pr}`)]));
      } else {
        writeLesson(repo.dir, file, `lesson-${pr}`);
      }
      generate(home);
      repo.git("add", ".");
      repo.git("commit", "-m", `chore: add lesson ${pr}`);
    }
    repo.git("checkout", "main");
    repo.git("merge", "--no-edit", "lesson-111");
    repo.git("merge", "--no-edit", "lesson-222");
    assert.deepEqual(learnings.loadLearningsCorpus(home).map((e) => e.id).sort(), ["existing", "lesson-111", "lesson-222"]);
    assert.equal(repo.git("status", "--porcelain", "--ignored", "--", "learnings/index.json"), "!! learnings/index.json");
  } finally {
    repo.cleanup();
  }
});

test("W1-T7954: every learnings reader sees a per-entry file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lesson-readers-"));
  const home = join(dir, "learnings");
  try {
    writeLesson(home, "ci.yaml", "old");
    writeLesson(home, "ci.d/new.yaml", "new", { assertion: "exit 1" });
    writeLesson(home, "testing.d/other.yaml", "other", { assertion: "exit 0" });
    mkdirSync(join(home, "ignored"));
    writeLesson(home, "ignored/hidden.yaml", "hidden");
    const corpus = learnings.loadLearningsCorpus(home);
    assert.deepEqual(corpus.map((e) => e.id).sort(), ["new", "old", "other"]);
    const scriptFiles = await import("../scripts/lib/learnings-files.mjs" as string);
    const runtimeFiles = learnings.learningsSourceFiles;
    assert.deepEqual(runtimeFiles(home), scriptFiles.learningsSourceFiles(home));
    for (const enumerate of [runtimeFiles, scriptFiles.learningsSourceFiles]) {
      assert.deepEqual(enumerate(join(dir, "absent")), []);
      assert.throws(() => enumerate(join(home, "ci.yaml")), /ENOTDIR/);
    }
    assert.deepEqual(scriptFiles.learningsSourceFiles(home), [
      { filename: "ci.d/new.yaml", shard: "ci.yaml" }, { filename: "ci.yaml", shard: "ci.yaml" },
      { filename: "testing.d/other.yaml", shard: "testing.yaml" },
    ]);
    const briefs = learnings.buildShardStandingBriefs(home);
    assert.deepEqual(briefs["ci.yaml"]!.claims.map((c) => c.id).sort(), ["new", "old"]);
    assert.deepEqual(briefs["testing.yaml"]!.claims.map((c) => c.id), ["other"]);
    assert.equal(learnings.buildShardStandingBriefs(home, briefs)["ci.yaml"], briefs["ci.yaml"]);
    assert.equal(budget.computeActiveChars(budget.loadCorpus(home)).activeCount, 3);
    const plan = assertions.planMutations(home, dir);
    assert.deepEqual(plan.results.map((r: { id: string }) => r.id).sort(), ["new", "other"]);
    assert.deepEqual(plan.mutations.map((m: { filename: string }) => m.filename), ["ci.d/new.yaml"]);
    assertions.applyMutations(home, plan.mutations);
    assert.equal(learnings.loadLearningsCorpus(home).find((e) => e.id === "new")!.lifecycle, "quarantined");
    const derived = symbols.planMutations(home, new Set(["measureLesson"]));
    assert.ok(derived.mutations.some((m: { filename: string }) => m.filename === "testing.d/other.yaml"));
    symbols.applyMutations(home, derived.mutations);
    assert.deepEqual(learnings.loadLearningsCorpus(home).find((e) => e.id === "other")!.symbols, ["measureLesson"]);
    writeLesson(home, "testing.d/garden.yaml", "garden");
    const spec = knowledgeGardenSpec({ repoRoot: dir, stateDir: join(dir, "state"),
      openWorkspace: () => { throw new Error("apply already has its workspace"); }, log: () => {} });
    const action = { class: "retire" as const, target: "garden", reason: "fixture retirement" };
    const landed = spec.apply({ root: dir, land: () => undefined, dispose: () => {}, refreshAssertions: () => [] },
      { actions: [action], acting: ["retire"] }, {} as never);
    assert.ok(landed);
    const patch = readFileSync(join(dir, "test/fixtures/golden-verdicts/knowledge-retire/diff.patch"), "utf8");
    assert.match(patch, /--- a\/learnings\/testing\.d\/garden\.yaml/);
    assert.match(patch, /-  lifecycle: active/);
    const before = cheapFingerprint(dir, join(dir, "state"));
    const applied = applyLearningActions(home, [{ class: "retire", target: "other", reason: "fixture retirement" }]);
    assert.deepEqual(applied.paths, ["learnings/testing.d/other.yaml"]);
    assert.equal(applied.located.other, "learnings/testing.d/other.yaml");
    assert.equal(learnings.loadLearningsCorpus(home).find((e) => e.id === "other")!.lifecycle, "superseded");
    assert.notEqual(cheapFingerprint(dir, join(dir, "state")), before);
    generate(home, "--check");
    assert.equal(existsSync(join(home, "index.json")), false);
    writeLesson(home, "ci.d/duplicate.yaml", "old");
    assert.throws(() => learnings.loadLearningsCorpus(home), /duplicate/);
    const invalid = spawnSync(process.execPath, [generator, "--dir", home, "--check"], { encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /duplicate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T7954: a ci-learning filing writes its own entry file", () => {
  const first = ciLearningShardYaml(draft(111), "W1-T111");
  const second = ciLearningShardYaml(draft(222), "W1-T222");
  const task = loadPlanFromYaml(first, "first filing").tasks[0]!;
  assert.deepEqual(task.files, ["learnings/ci.d/ci-learning-111-coverage-ratchet.yaml"]);
  assert.notDeepEqual(task.files, loadPlanFromYaml(second, "second filing").tasks[0]!.files);
  assert.equal(task.acceptance![0]!.proof, `grep: ci-learning:111:coverage-ratchet in ${task.files![0]}`);
  assert.equal(first.includes("learnings/ci.yaml"), false);
  assert.deepEqual(ciLearningRecordVerdict(first, "fixture"), { ok: true, reason: "" });
});

test("a ci-learning filing also asks for the golden verdict prompt-surface-gate needs beside a learnings path", () => {
  const filing = ciLearningShardYaml(draft(111), "W1-T111");
  const task = loadPlanFromYaml(filing, "golden filing").tasks[0]!;
  const lessonsFile = ciLearningLessonsFile("ci-learning:111:coverage-ratchet");
  const fixtureDir = ciLearningGoldenFixtureDir("ci-learning:111:coverage-ratchet");
  assert.equal(basename(fixtureDir), basename(lessonsFile, ".yaml"));
  // The fixture is asked for by a criterion, not declared: a ci-learning record admits exactly one file (W1-T10027).
  assert.deepEqual(task.files, [lessonsFile]);
  assert.deepEqual(task.acceptance![1], {
    claim: "the lesson carries the golden verdict prompt-surface-gate admits for a learnings path",
    proof: `grep: ci-learning:111:coverage-ratchet in ${fixtureDir}/criteria.yaml`,
  });
  assert.ok(task.note!.includes(`golden verdict under ${fixtureDir}/`), task.note);
  assert.deepEqual(ciLearningRecordVerdict(filing, "golden filing"), { ok: true, reason: "" });
  assert.equal(machineShardFilingRefusal(filing, "golden filing", { pathExists: () => false, pathExistsAtBase: () => false }), undefined);
});

test("W1-T7954: selection without a committed index matches the indexed selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lesson-selection-"));
  try {
    writeLesson(dir, "ci.yaml", "old");
    writeLesson(dir, "ci.d/new.yaml", "new", { files: ["other.ts"], symbols: ["measureLesson"] });
    writeLesson(dir, "testing.d/error.yaml", "error", { files: [], error_signatures: ["fixture failure"] });
    writeLesson(dir, "testing.yaml", "unmatched", { files: ["unrelated.ts"] });
    generate(dir);
    const cases = [
      { files: ["src/example.ts"], text: "" }, { files: [], text: "measureLesson" },
      { files: undefined, text: "fixture failure" }, { files: ["missing.ts"], text: "" },
    ];
    const select = ({ files, text }: typeof cases[number]) => learnings.selectLearnings(
      learnings.loadLearningsForTaskFiles(dir, files, { text }), files, 500, { text },
    );
    const indexed = cases.map(select);
    assert.deepEqual(indexed.map((r) => r.selected.map((e) => e.id)), [["old"], ["new"], ["error"], []]);
    rmSync(join(dir, "index.json"));
    assert.deepEqual(cases.map(select), indexed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T7954: an absent index.json is built from the corpus, exactly as the generator would write it", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lesson-built-index-"));
  try {
    writeLesson(dir, "ci.yaml", "old");
    writeLesson(dir, "ci.d/new.yaml", "new", { files: ["other.ts"], symbols: ["measureLesson"] });
    writeLesson(dir, "testing.d/error.yaml", "error", { files: [], error_signatures: ["fixture failure"], subsystem: "testing" });
    generate(dir);
    const written = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as learnings.LearningsIndex;
    rmSync(join(dir, "index.json"));
    assert.deepEqual(learnings.loadLearningsIndex(join(dir, "index.json")), written,
      "a reader of the retired index (the wipe-test cadence) still sees every shard and per-entry file");
    assert.equal(learnings.loadLearningsIndex(join(dir, "other.json")), null, "only the index's own name is built");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const empty = mkdtempSync(join(tmpdir(), "rmd-lesson-no-corpus-"));
  try {
    assert.equal(learnings.loadLearningsIndex(join(empty, "index.json")), null, "no corpus, no index");
    writeLesson(empty, "a.yaml", "dup");
    writeLesson(empty, "b.yaml", "dup");
    assert.equal(learnings.loadLearningsIndex(join(empty, "index.json")), null, "a corpus that does not parse builds none");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  assert.ok(Object.keys(learnings.loadLearningsIndex(join(root, "learnings", "index.json"))?.files ?? {}).length > 0,
    "this repo's own learnings home yields an index with the committed file retired");
});
