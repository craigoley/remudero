import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { stringify } from "yaml";

import {
  assertRatificationDraftFileable,
  checkoutRepoFacts,
  inboxDraftExampleFragmentYaml,
  inboxDraftPrompt,
  inboxDraftRelintPrompt,
  lintDraftedFragment,
  RatificationDraftRefusedError,
} from "../src/lib/inbox.js";
import { parseTasksFromYaml } from "../src/lib/plan.js";

const ROOT = mkdtempSync(join(tmpdir(), "rmd-w1-t9162-"));
mkdirSync(join(ROOT, "src", "lib"), { recursive: true });
mkdirSync(join(ROOT, "test", "fixtures", "golden-verdicts"), { recursive: true });
writeFileSync(join(ROOT, "src", "lib", "plan.ts"), "export const fixture = true;\n");
writeFileSync(join(ROOT, "test", "example.test.ts"), "fixture\n");
after(() => rmSync(ROOT, { recursive: true, force: true }));

const KNOWN = new Set(["remudero", "none"]);
const PROPOSAL = "followup:directory-draft";
const STAMP = `- ${PROPOSAL} (refuse directory drafts) — RATIFIED 2026-10-13 -> NEW-1.`;
const facts = checkoutRepoFacts(ROOT);
const isDirectory = (path: string) => statSync(join(ROOT, path), { throwIfNoEntry: false })?.isDirectory() === true;

function fragment(files: string[], proof = "unit test: the directory draft is refused"): string {
  const [task] = parseTasksFromYaml(inboxDraftExampleFragmentYaml(), "directory draft fixture");
  // Keep the companion test as this fixture task's own falsifier while varying directory inputs.
  task.title = files.includes("test/plan/future.test.ts") ? "Future" : "Example";
  task.files = files;
  task.design = "CREATES: test/plan/future.test.ts\nNO-INVARIANTS: the fixture drafts one new task only; no prior behavior changes.";
  task.acceptance = [{ claim: "the directory draft is refused", proof }];
  return stringify([task]);
}

function lint(yaml: string) {
  return lintDraftedFragment(yaml, PROPOSAL, STAMP, KNOWN, facts.moduleExists, facts.readGrepProofFile, isDirectory);
}

test("W1-T9162: the draft lint blocks a files entry that is a directory", () => {
  for (const path of ["src/", "src", "test/fixtures/golden-verdicts/", "test/fixtures/golden-verdicts", "future/"]) {
    const violations = lint(fragment([path, "test/plan/example.test.ts"]));
    const violation = violations.find((v) => v.check === "draft-directory-files");
    assert.equal(violation?.severity, "block", JSON.stringify(violations));
    assert.ok(violation);
    assert.ok(violation.message.includes(`NEW-1 files entry ${JSON.stringify(path)} is a directory`));
    assert.match(inboxDraftRelintPrompt({ id: PROPOSAL, summary: "refuse directory drafts", evidenceAnchors: [] },
      fragment([path]), violations), /name the files the task changes, never a directory/);
  }
  assert.deepEqual(lint(fragment(["src/lib/plan.ts", "test/plan/example.test.ts"])), []);
  assert.deepEqual(lint(fragment(["src/lib/plan.ts", "test/plan/future.test.ts"])), [], "declared new files remain legal");
  assert.ok(lintDraftedFragment(fragment(["src", "test/plan/example.test.ts"]), PROPOSAL, STAMP, KNOWN)
    .some((v) => v.check === "draft-directory-files"), "the production stat default also blocks directories");
});

test("W1-T9162: the draft lint blocks a grep proof aimed at a directory", () => {
  for (const path of ["test/fixtures/golden-verdicts/", "test/fixtures/golden-verdicts", "src", "future/"]) {
    const violations = lint(fragment(["src/lib/plan.ts", "test/plan/example.test.ts"], `grep: future verdict in ${path}`));
    const violation = violations.find((v) => v.check === "draft-directory-grep");
    assert.equal(violation?.severity, "block", JSON.stringify(violations));
    assert.ok(violation);
    assert.ok(violation.message.includes(`NEW-1 grep proof target ${JSON.stringify(path)} is a directory`));
    assert.match(violation.message, /name the files the task changes, never a directory/);
  }
  assert.deepEqual(lint(fragment(["src/lib/plan.ts", "test/plan/example.test.ts"],
    "grep: future verdict in test/plan/example.test.ts")), []);
  assert.deepEqual(lint(fragment(["src/lib/plan.ts", "test/plan/future.test.ts"],
    "grep: future verdict in test/plan/future.test.ts")), [], "an absent target is not a directory");
});

test("W1-T9162: approve still refuses a directory files entry", () => {
  for (const path of ["src/", "src", "test/fixtures/golden-verdicts"]) {
    assert.throws(() => assertRatificationDraftFileable(fragment([path, "test/plan/example.test.ts"]),
      PROPOSAL, STAMP, KNOWN, ROOT), (error: unknown) => {
      assert.ok(error instanceof RatificationDraftRefusedError);
      assert.ok(error.message.includes(`[draft-directory-files] NEW-1 files entry ${JSON.stringify(path)} is a directory`));
      return true;
    });
  }
  assert.throws(() => assertRatificationDraftFileable(fragment(["src/lib/plan.ts", "test/plan/example.test.ts"],
    "grep: future verdict in test/fixtures/golden-verdicts"), PROPOSAL, STAMP, KNOWN, ROOT),
  /\[draft-directory-grep\]/);
  assert.doesNotThrow(() => assertRatificationDraftFileable(fragment(["src/lib/plan.ts", "test/plan/example.test.ts"]),
    PROPOSAL, STAMP, KNOWN, ROOT));
});

// 2026-11-18: approving verify-human:W1-T12032 filed W1-T13650 as `verify: human`, which drain holds as verify-not-auto,
// so the work the operator approved could never be dispatched.
test("a draft that answers a human ask may not file another verify: human task", () => {
  const human = fragment(["src/lib/plan.ts", "test/plan/example.test.ts"]).replace("verify: auto", "verify: human");
  assert.ok(human.includes("verify: human"), human);
  for (const asked of ["verify-human:W1-T12032", "verify-human-automate:W1-T12032", "machine-judge:W1-T12032"]) {
    const stamp = `- ${asked} (refuse directory drafts) — RATIFIED 2026-11-18 -> NEW-1.`;
    const violations = lintDraftedFragment(human, asked, stamp, KNOWN, facts.moduleExists, facts.readGrepProofFile, isDirectory);
    const violation = violations.find((v) => v.check === "draft-human-ask-repeated");
    assert.equal(violation?.severity, "block", JSON.stringify(violations));
    assert.ok(violation.message.includes(`approving ${asked} already gives the human judgment`), violation.message);
    assert.deepEqual(lintDraftedFragment(human.replace("verify: human", "verify: auto"), asked, stamp, KNOWN,
      facts.moduleExists, facts.readGrepProofFile, isDirectory), [], "the same task at verify: auto is clean");
  }
  const ask = { id: "verify-human:W1-T12032", summary: "W1-T12032 still needs you", evidenceAnchors: [] };
  const planText = inboxDraftExampleFragmentYaml().replace("NEW-1", "W1-T1");
  assert.match(inboxDraftPrompt(ask, planText, "run-1"), /every task you file is `verify: auto`/);
});

test("an approved follow-up or architect proposal files verify: auto unless it declares a workflow path", () => {
  const human = fragment(["src/lib/plan.ts", "test/plan/example.test.ts"]).replace("verify: auto", "verify: human");
  for (const proposal of ["followup:directory-draft", "architect:directory-draft", "proof-debt:W1-T12032:0"]) {
    const stamp = `- ${proposal} (refuse directory drafts) — RATIFIED 2026-11-25 -> NEW-1.`;
    const violation = lintDraftedFragment(human, proposal, stamp, KNOWN, facts.moduleExists, facts.readGrepProofFile, isDirectory)
      .find((v) => v.check === "draft-human-ask-repeated");
    assert.equal(violation?.severity, "block", proposal);
    assert.ok(violation.message.includes(`approving ${proposal} already gives the human judgment`), violation.message);
    assert.match(violation.message, /unless it declares a \.github\/workflows\/ path/);
  }
  assert.deepEqual(lint(human.replace("verify: human", "verify: auto")).filter((v) => v.check === "draft-human-ask-repeated"), [],
    "the same task at verify: auto is clean");
  const workflow = fragment([".github/workflows/ci.yml", "test/plan/example.test.ts"]).replace("verify: auto", "verify: human");
  assert.deepEqual(lint(workflow).filter((v) => v.check === "draft-human-ask-repeated"), [],
    "a task that declares a workflow path may stay verify: human");
  const planText = inboxDraftExampleFragmentYaml().replace("NEW-1", "W1-T1");
  const prompt = inboxDraftPrompt({ id: PROPOSAL, summary: "refuse directory drafts", evidenceAnchors: [] }, planText, "run-1");
  assert.match(prompt, /every task you file is `verify: auto`/);
  assert.match(prompt, /names a `\.github\/workflows\/` path/);
});
