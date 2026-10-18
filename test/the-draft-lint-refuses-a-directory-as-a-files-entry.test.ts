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
  task.design = "CREATES: test/plan/future.test.ts";
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
