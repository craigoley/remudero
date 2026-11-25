import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { stringify } from "yaml";

import {
  checkoutRepoFacts,
  inboxDraftExampleFragmentYaml,
  inboxDraftPrompt,
  lintDraftedFragment,
} from "#src/lib/inbox.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";

const ROOT = mkdtempSync(join(tmpdir(), "rmd-w1-t14659-"));
mkdirSync(join(ROOT, "src", "lib"), { recursive: true });
writeFileSync(join(ROOT, "src", "lib", "plan.ts"), "export const fixture = true;\n");
writeFileSync(join(ROOT, "test-example.txt"), "fixture\n");
after(() => rmSync(ROOT, { recursive: true, force: true }));

const KNOWN = new Set(["remudero", "none"]);
const facts = checkoutRepoFacts(ROOT);
const isDirectory = (path: string) => statSync(join(ROOT, path), { throwIfNoEntry: false })?.isDirectory() === true;

function fragment(files: string[]): string {
  const [task] = parseTasksFromYaml(inboxDraftExampleFragmentYaml(), "second human ask fixture");
  task.title = "Example";
  task.files = files;
  task.design = "CREATES: test/plan/example.test.ts\nNO-INVARIANTS: the fixture drafts one new task only; no prior behavior changes.";
  task.acceptance = [{ claim: "the draft is filed", proof: "unit test: the draft is filed" }];
  return stringify([task]);
}

function repeated(yaml: string, proposal: string) {
  const stamp = `- ${proposal} (no second human ask) — RATIFIED 2026-11-25 -> NEW-1.`;
  return lintDraftedFragment(yaml, proposal, stamp, KNOWN, facts.moduleExists, facts.readGrepProofFile, isDirectory)
    .filter((v) => v.check === "draft-human-ask-repeated");
}

const PROPOSALS = ["followup:no-second-ask", "architect:no-second-ask", "proof-debt:W1-T12032:0"];

test("W1-T14659 criterion 1: an approved follow-up or architect proposal may not file a verify: human task", () => {
  const human = fragment(["src/lib/plan.ts", "test/plan/example.test.ts"]).replace("verify: auto", "verify: human");
  assert.ok(human.includes("verify: human"), human);
  for (const proposal of PROPOSALS) {
    const [violation] = repeated(human, proposal);
    assert.equal(violation?.severity, "block", proposal);
    assert.ok(violation.message.includes(`approving ${proposal} already gives the human judgment`), violation.message);
    assert.match(violation.message, /unless it declares a \.github\/workflows\/ path/);
  }
});

test("W1-T14659 criterion 2: a workflow-path task stays verify: human, and the drafter prompt names the exception", () => {
  const workflow = fragment([".github/workflows/ci.yml", "test/plan/example.test.ts"]).replace("verify: auto", "verify: human");
  assert.ok(workflow.includes("verify: human"), workflow);
  for (const proposal of PROPOSALS) {
    assert.deepEqual(repeated(workflow, proposal), [], "a task that declares a workflow path may stay verify: human");
  }
  const planText = inboxDraftExampleFragmentYaml().replace("NEW-1", "W1-T1");
  const prompt = inboxDraftPrompt({ id: "followup:no-second-ask", summary: "no second human ask", evidenceAnchors: [] },
    planText, "run-1");
  assert.match(prompt, /every task you file is `verify: auto`/);
  assert.match(prompt, /names a `\.github\/workflows\/` path/);
});

test("W1-T14659 criterion 3: a-verify-auto-draft-is-unchanged — a verify: auto draft never draws the human-ask refusal", () => {
  for (const proposal of [...PROPOSALS, "parked:W1-T1"]) {
    for (const files of [["src/lib/plan.ts", "test/plan/example.test.ts"], [".github/workflows/ci.yml", "test/plan/example.test.ts"]]) {
      const auto = fragment(files);
      assert.ok(auto.includes("verify: auto"), auto);
      assert.deepEqual(repeated(auto, proposal), [], `${proposal} ${files[0]}`);
    }
  }
});
