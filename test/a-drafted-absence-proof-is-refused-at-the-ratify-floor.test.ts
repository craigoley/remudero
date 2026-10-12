import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, stringify } from "yaml";

import { inboxDraftExampleFragmentYaml, lintDraftedFragment } from "../src/lib/inbox.js";

const PROPOSAL = "retro-promotion:W1-T5814";
const KNOWN = new Set(["remudero", "none"]);
const STAMP = `- ${PROPOSAL} (retire promotion proposals from retro) — RATIFIED 2026-10-05 -> NEW-1.`;
const ABSENCE = 'grep: "renderPromotionProposals" not found in docs/forensics/retro.md';

function withProof(proof: string): string {
  const tasks = parse(inboxDraftExampleFragmentYaml());
  tasks[0].title = "retro.md no longer mentions renderPromotionProposals";
  tasks[0].acceptance = [{ claim: "docs/forensics/retro.md no longer mentions renderPromotionProposals", proof }];
  return stringify(tasks);
}

const lint = (proof: string) => lintDraftedFragment(withProof(proof), PROPOSAL, STAMP, KNOWN, () => true);
const absenceFindings = (proof: string) => lint(proof).filter((v) => v.check === "draft-absence-proof");

test("test/a-drafted-absence-proof-is-refused-at-the-ratify-floor.test.ts", () => {
  const blocked = absenceFindings(ABSENCE);
  assert.equal(blocked.length, 1, JSON.stringify(lint(ABSENCE)));
  assert.equal(blocked[0].severity, "block");
  assert.match(blocked[0].message, /criterion 1/);
  assert.match(blocked[0].message, /renderPromotionProposals/);
  assert.match(blocked[0].message, /positive proof/);

  assert.deepEqual(absenceFindings("unit test: retro.md no longer mentions renderPromotionProposals"), []);
  assert.deepEqual(lint("unit test: retro.md no longer mentions renderPromotionProposals"), []);
  assert.deepEqual(absenceFindings('grep: "token not found" in docs/forensics/retro.md'), []);
  assert.deepEqual(absenceFindings("grep: not found handler in docs/forensics/retro.md"), []);
});

test("every absence phrase blocks a drafted grep proof and positive greps pass", () => {
  for (const pattern of ["foo absent", "foo no longer", "foo is gone", "foo removed", "foo not found", 'no "foo"', "not 'foo'"]) {
    assert.equal(absenceFindings(`grep: ${pattern} in docs/forensics/retro.md`).length, 1, pattern);
  }
  for (const pattern of ["renderPromotionProposals", "not found: 404", "Removed entries", "nothing"]) {
    assert.deepEqual(absenceFindings(`grep: ${pattern} in docs/forensics/retro.md`), [], pattern);
  }
});
