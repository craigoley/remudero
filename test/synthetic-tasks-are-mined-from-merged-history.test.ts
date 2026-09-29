import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mineSyntheticPilotFromMergedHistory, mineSyntheticTasksFromGoldenCorpus, type GoldenCorpusItem } from "../src/lib/golden-corpus.js";
import { gitRepo } from "./helpers/git-repo.js";

function mergedFixture(taskId: string) {
  const repo = gitRepo({ kind: "synthetic-history" });
  writeFileSync(join(repo.dir, "feature.txt"), "broken\n");
  writeFileSync(join(repo.dir, "test-file.test.ts"), "old test\n");
  repo.git("add", "-A");
  repo.git("commit", "-m", "base");
  writeFileSync(join(repo.dir, "feature.txt"), "fixed\n");
  writeFileSync(join(repo.dir, "test-file.test.ts"), "new test\n");
  repo.git("add", "-A");
  repo.git("commit", "-m", `feat: fix ${taskId}`, "-m", `Remudero-Task: ${taskId}`);
  const mainSha = repo.git("rev-parse", "HEAD");
  const item: GoldenCorpusItem = {
    taskId, baseSha: repo.git("rev-parse", "HEAD^"), headSha: mainSha,
    mergedAt: "2026-09-28T00:00:00.000Z", creditSource: "trailer",
    proofs: [{ claim: "the feature works", proof: "unit test: test/feature.test.ts", holdout: true }],
    freshness: { ageDays: 1 }, heldOut: true,
  };
  return { repo, item, mainSha };
}

test("W1-T4666: a reverse-applied merged change is kept only when its own proof goes red", () => {
  const { repo, item, mainSha } = mergedFixture("W1-T9001");
  const observed: string[] = [];
  const report = mineSyntheticTasksFromGoldenCorpus([item], {
    repoDir: repo.dir,
    mainRef: "HEAD",
    execProof: (_proof, cwd) => {
      const state = readFileSync(join(cwd, "feature.txt"), "utf8").trim();
      const testState = readFileSync(join(cwd, "test-file.test.ts"), "utf8").trim();
      observed.push(`${state}/${testState}`);
      return state === "fixed" ? "pass" : "fail";
    },
  });
  assert.deepEqual(observed, ["fixed/new test", "broken/new test"]);
  assert.equal(report.sampled, 1);
  assert.equal(report.kept.length, 1);
  assert.equal(report.keepRate, 1);
  assert.equal(report.kept[0]!.sealed, true);
  assert.equal(report.kept[0]!.dispatchable, false);
  assert.match(report.kept[0]!.id, /^synthetic-W1-T9001-/);
  assert.equal(report.kept[0]!.mainSha, mainSha);
  assert.deepEqual(report.kept[0]!.grading, { main: "pass", candidate: "fail" });
  assert.match(report.kept[0]!.reversePatch, /feature\.txt/);
  assert.doesNotMatch(report.kept[0]!.reversePatch, /test-file\.test\.ts/);
});

test("W1-T4666: a candidate whose proof stays green is discarded", () => {
  const { repo, item } = mergedFixture("W1-T9002");
  const report = mineSyntheticTasksFromGoldenCorpus([item], {
    repoDir: repo.dir, mainRef: "HEAD", execProof: () => "pass",
  });
  assert.equal(report.kept.length, 0);
  assert.equal(report.keepRate, 0);
  assert.match(report.excluded[0]!.reason, /proof stayed green/);
});

test("the default reviewer executor grades an actual unit test on main and the reversed candidate", () => {
  const { repo, item } = mergedFixture("W1-T9004");
  mkdirSync(join(repo.dir, "test"));
  mkdirSync(join(repo.dir, "test", "setup"));
  writeFileSync(join(repo.dir, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(repo.dir, "test", "feature.test.ts"), [
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'import { test } from "node:test";',
    'test("feature is fixed", () => assert.equal(readFileSync("feature.txt", "utf8"), "fixed\\n"));',
  ].join("\n"));
  repo.git("add", "test/feature.test.ts", "test/setup/tmp-hygiene.ts");
  repo.git("commit", "-m", "test: add a proof");
  symlinkSync(join(process.cwd(), "node_modules"), join(repo.dir, "node_modules"), "dir");
  item.headSha = repo.git("rev-parse", "HEAD");
  const report = mineSyntheticTasksFromGoldenCorpus([item], { repoDir: repo.dir, mainRef: "HEAD" });
  assert.equal(report.kept.length, 1, JSON.stringify(report.excluded));
});

test("the pilot is bounded to 30 merged tasks and excludes unmeasurable proof results", () => {
  const { repo, item } = mergedFixture("W1-T9003");
  const items = Array.from({ length: 31 }, (_, i) => ({ ...item, taskId: `W1-T${9003 + i}` }));
  const report = mineSyntheticTasksFromGoldenCorpus(items, {
    repoDir: repo.dir, mainRef: "HEAD", execProof: () => "no-match",
  });
  assert.equal(report.sampled, 30);
  assert.equal(report.kept.length, 0);
  assert.equal(report.excluded.length, 30);
});

test("a failed proof on main or a proof executor error cannot certify a synthetic task", () => {
  const { repo, item } = mergedFixture("W1-T9035");
  const failedMain = mineSyntheticTasksFromGoldenCorpus([item], {
    repoDir: repo.dir, mainRef: "HEAD", execProof: () => "fail",
  });
  assert.equal(failedMain.kept.length, 0);
  assert.match(failedMain.excluded[0]!.reason, /proof on main was fail/);
  const errored = mineSyntheticTasksFromGoldenCorpus([item], {
    repoDir: repo.dir, mainRef: "HEAD", execProof: () => { throw new Error("proof loader unavailable"); },
  });
  assert.equal(errored.kept.length, 0);
  assert.match(errored.excluded[0]!.reason, /proof loader unavailable/);
  const mixedProofs = { ...item, proofs: [...item.proofs,
    { claim: "the marker exists", proof: "grep: missing-marker in feature.txt", holdout: false }] };
  const staleMain = mineSyntheticTasksFromGoldenCorpus([mixedProofs], {
    repoDir: repo.dir, mainRef: "HEAD", execProof: (proof) => proof.kind === "grep" ? "fail" : "pass",
  });
  assert.equal(staleMain.kept.length, 0, "every task proof must be green on main");
  assert.match(staleMain.excluded[0]!.reason, /proof on main was fail/);
});

test("a task without a resolvable merged commit is excluded by name", () => {
  const { repo, item } = mergedFixture("W1-T9036");
  const unknown = { ...item, taskId: "W1-T9999", headSha: "deadbeef" };
  const report = mineSyntheticTasksFromGoldenCorpus([unknown], {
    repoDir: repo.dir, mainRef: "HEAD", execProof: () => "pass",
  });
  assert.deepEqual(report.kept, []);
  assert.deepEqual(report.excluded.map((entry) => entry.taskId), ["W1-T9999"]);
});

test("a reverse patch that no longer applies is excluded rather than graded", () => {
  const { repo, item } = mergedFixture("W1-T9038");
  writeFileSync(join(repo.dir, "feature.txt"), "fixed with later edits\n");
  repo.git("add", "feature.txt");
  repo.git("commit", "-m", "feat: edit the feature again");
  const report = mineSyntheticTasksFromGoldenCorpus([item], {
    repoDir: repo.dir, mainRef: "HEAD", execProof: () => "pass",
  });
  assert.deepEqual(report.kept, []);
  assert.match(report.excluded[0]!.reason, /candidate could not be measured/);
});

test("the pilot derives admitted merged history and reports its keep rate with corpus exclusions", () => {
  const { repo, item } = mergedFixture("W1-T9037");
  const review = {
    step: "review.posted", task_id: item.taskId, ts: "2026-09-28T00:00:00Z",
    merge_base_sha: item.baseSha, head_sha: item.headSha,
    decision_verdict: { criteria: [{ claim: "the feature works", proof: item.proofs[0]!.proof,
      proof_exec: "executed_pass", reason: "the proof discriminates, executed_pass stands" }] },
  };
  const report = mineSyntheticPilotFromMergedHistory({
    reviewLines: [review], merged: new Map([[item.taskId, { mergedAt: "2026-09-28T01:00:00Z", source: "trailer" }]]),
    nowMs: Date.parse("2026-09-29T00:00:00Z"),
  }, { repoDir: repo.dir, mainRef: "HEAD", execProof: (_proof, cwd) =>
    readFileSync(join(cwd, "feature.txt"), "utf8") === "fixed\n" ? "pass" : "fail" });
  assert.equal(report.sampled, 1);
  assert.equal(report.keepRate, 1);
  assert.equal(report.kept[0]!.sourceTaskId, item.taskId);
  assert.deepEqual(report.corpusExcluded, []);
});
