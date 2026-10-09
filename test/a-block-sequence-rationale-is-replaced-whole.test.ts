import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  fileRatificationDraft,
  inboxDraftExampleFragmentYaml,
  type Proposal,
} from "../src/lib/inbox.js";

const proposal: Proposal = {
  id: "followup:DAEMON-1789548928143-PR-5737-task-0",
  summary: "Replace the collection with the follow-up's own words.\nKeep YAML: punctuation and the second line.",
  originatingItemId: "PR-5737",
  evidenceAnchors: [],
};
const fragment = inboxDraftExampleFragmentYaml().replace("NEW-1", "W1-T5845");
const following = "  note: 'keep: this note verbatim' # authored comment\n";

for (const [form, rationale] of [
  ["indented block sequence", "  rationale:\n    - obsolete-first-item\n    - obsolete-second-item\n"],
  ["indentless block sequence", "  rationale:\n  - obsolete-first-item\n  - obsolete-second-item\n"],
  ["flow sequence", "  rationale: [obsolete-first-item, obsolete-second-item]\n"],
] as const) {
  test(`test/a-block-sequence-rationale-is-replaced-whole.test.ts: ${form}`, (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), "rmd-t5845-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(join(root, "MASTER-PLAN.md"), "# Master plan\n");
    fs.mkdirSync(join(root, "src", "lib"), { recursive: true });
    const paths = fileRatificationDraft(root, {
      proposalId: proposal.id,
      fragmentYaml: `${fragment}\n${rationale}${following}`,
      stampLine: `- ${proposal.id} (replace the collection) — RATIFIED 2026-10-03 -> W1-T5845`,
      proposal,
    }, fs, join, new Set(["remudero", "none"]));

    assert.equal(paths.length, 1);
    const written = fs.readFileSync(join(root, paths[0]), "utf8");
    const tasks = parse(written);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].rationale,
      "From the 2026-09-16 follow-up on PR-5737, ratified via rmd approve:\n" + proposal.summary);
    assert.doesNotMatch(written, /obsolete-(first|second)-item/);
    assert.ok(written.startsWith(`${fragment}\n  rationale: >-\n`));
    assert.ok(written.endsWith(following));
    assert.equal(tasks[0].note, "keep: this note verbatim");
  });
}
