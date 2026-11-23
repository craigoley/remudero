import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { planFilingAcceptanceCure, repairMissingAcceptance, type FilingDiffFile, type PlanFilingDiffAtHead } from "#src/lib/body-repair.js";
import { ensureJudgeableBody } from "#src/lib/plan-pr-emitter.js";
import { acceptanceAuthorTimeCheck, parseAcceptanceBlock, parseWhitelistedProof } from "#src/lib/review.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const body = "Files the next two tasks.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n";
const shardDir = "plan/tasks.d";
const shard = (id: string, suffix: string): string => `${shardDir}/${id}-${suffix}.yaml`;
const first = shard("W9-T501", "first-task");
const second = shard("W9-T502", "second-task");
const existing = shard("W9-T400", "existing-task");
const files: FilingDiffFile[] = [
  { path: first, added: true, headText: "- id: W9-T501\n  title: First task\n" },
  { path: second, added: true, headText: "- id: W9-T502\n  title: Second task\n" },
];
const noAddedTests = { kind: "read" as const, files: [] };
const layoutDiff = (diff: FilingDiffFile[]): PlanFilingDiffAtHead => ({ kind: "read", files: diff, shardDir });
const repair = (text: string, addedTests: Parameters<typeof repairMissingAcceptance>[1], diff: PlanFilingDiffAtHead) =>
  repairMissingAcceptance(text, addedTests, diff, acceptanceAuthorTimeCheck, ensureJudgeableBody);

test("W1-T13463 criterion 1: the no-header step returns the shard-derived body and it passes the gate", () => {
  assert.equal(acceptanceAuthorTimeCheck(body).defect, "no-header");
  const cure = planFilingAcceptanceCure(body, files, shardDir, acceptanceAuthorTimeCheck);
  assert.ok(cure);
  const result = repair(body, noAddedTests, layoutDiff(files));
  assert.deepEqual(result, { kind: "cured", repairedBody: cure.repairedBody });
  assert.equal(acceptanceAuthorTimeCheck(cure.repairedBody).ok, true);
  assert.deepEqual(parseAcceptanceBlock(cure.repairedBody).map(({ claim, proof }) => ({ claim, proof })), [
    { claim: "the W9-T501 shard is filed", proof: `grep: id: W9-T501 in ${first}` },
    { claim: "the W9-T502 shard is filed", proof: `grep: id: W9-T502 in ${second}` },
  ]);
});

test("W1-T13463 criterion 2: insufficient evidence gives a reason and an added test retains its cure", () => {
  for (const diff of [
    layoutDiff([...files, { path: "src/lib/sweep.ts", added: false }]),
    layoutDiff([{ path: existing, added: false }]),
  ]) {
    const result = repair(body, noAddedTests, diff);
    assert.equal(result?.kind, "no-cure");
    assert.match(result.reason, /misses at base/);
  }
  const unreadable = { kind: "unreadable", reason: "could not read the added shard at the PR head" } as const;
  const result = repair(body, noAddedTests, unreadable);
  assert.equal(result?.kind, "no-cure");
  assert.ok(result.reason.includes(unreadable.reason), result.reason);
  const unreadableTests = { kind: "unreadable", reason: "could not list added tests" } as const;
  assert.deepEqual(repair(body, unreadableTests, layoutDiff(files)), repair(body, noAddedTests, layoutDiff(files)));

  const addedSuite = "test/fix-lane/a-new-suite.test.ts";
  const addedTestCure = repair(body, { kind: "read", files: [addedSuite] }, unreadable);
  assert.equal(addedTestCure?.kind, "cured");
  assert.equal(acceptanceAuthorTimeCheck(addedTestCure.repairedBody).ok, true);
  assert.deepEqual(parseAcceptanceBlock(addedTestCure.repairedBody).map(({ proof }) => proof), [`unit test: ${addedSuite}`]);
});

test("W1-T13463 criterion 3: only the added shard's id earns a proof and it misses at the base", (t) => {
  const headText = "- id:   W9-T501\n  title: First task\n- id: W9-T888\n  title: Follow-up task\n";
  const diff = layoutDiff([{ path: first, added: true, headText }, { path: existing, added: false }]);
  const result = repair(body, noAddedTests, diff);
  assert.equal(result?.kind, "cured");
  const criteria = parseAcceptanceBlock(result.repairedBody);
  assert.deepEqual(criteria.map(({ claim }) => claim), ["the W9-T501 shard is filed"]);
  const grep = parseWhitelistedProof(criteria[0]?.proof ?? "");
  assert.equal(grep?.kind, "grep");

  const { dir } = ownedFixtureDir(t, "metadata-filing-proof");
  const head = join(dir, "head");
  const base = join(dir, "base");
  mkdirSync(dirname(join(head, first)), { recursive: true });
  mkdirSync(dirname(join(base, existing)), { recursive: true });
  writeFileSync(join(head, first), headText);
  writeFileSync(join(base, existing), "- id: W9-T400\n  title: Existing task\n");
  const headRun = spawnSync(grep.command, grep.args, { cwd: head, encoding: "utf8" });
  assert.equal(headRun.status, 0, headRun.stderr);
  assert.match(headRun.stdout, /- id: +W9-T501\n$/);
  const baseRun = spawnSync(grep.command, grep.args, { cwd: base, encoding: "utf8" });
  assert.ok(baseRun.status !== null && baseRun.status !== 0);
  assert.equal(baseRun.stdout, "");

  for (const existingBody of [
    "## Acceptance\n- an authored claim | grep: an authored proof in README.md\n",
    "## Acceptance\n- an authored claim still missing a proof\n",
    "Already attributed.\n\nRemudero-Task: W9-T400\n",
  ]) {
    assert.equal(repair(existingBody, noAddedTests, diff), undefined);
  }
});
