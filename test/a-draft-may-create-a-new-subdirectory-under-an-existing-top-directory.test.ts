import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "yaml";

import { lintDraftedFragment } from "../src/lib/inbox.js";

const PROPOSAL = "verify-human-automate:W1-T3332";
const KNOWN = new Set(["remudero", "remudero-console", "none"]);

function fragment(files: string[], repo = "remudero"): string {
  return stringify([
    {
      id: "W1-T7000",
      title: "add the newmod module under the library",
      origin: "W1-T5890 test fixture",
      repo,
      depends_on: [],
      type: "implement",
      verify: "auto",
      risk: "low",
      status: "queued",
      attempts: 0,
      files,
      acceptance: [{ claim: "the newmod module exists and is exercised by its unit test", proof: "unit test: test/newmod.test.ts" }],
    },
  ]);
}

// Only `src` and `src/lib` exist in the fake worktree; `src/lib/newmod` does not.
const exists = (path: string): boolean => path === "src" || path === "src/lib" || path === "test";
const missing = (files: string[], repo?: string) =>
  lintDraftedFragment(fragment(files, repo), PROPOSAL, undefined, KNOWN, exists).filter((v) => v.check === "draft-missing-directory");

test("a draft naming src/lib/newmod/x.ts is filed when src/lib exists", () => {
  assert.deepEqual(missing(["src/lib/newmod/x.ts", "test/newmod.test.ts"]), []);
});

test("a draft naming nosuchtop/x.ts is refused with draft-missing-directory naming nosuchtop", () => {
  const found = missing(["nosuchtop/deeper/x.ts"]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /"nosuchtop"/);
  assert.doesNotMatch(found[0].message, /nosuchtop\/deeper"\s*$/);
});

test("a draft whose task.repo is another repo is not refused for a directory this worktree lacks", () => {
  assert.deepEqual(missing(["nosuchtop/x.ts"], "remudero-console"), []);
  assert.equal(missing(["nosuchtop/x.ts"], "remudero").length, 1);
});
