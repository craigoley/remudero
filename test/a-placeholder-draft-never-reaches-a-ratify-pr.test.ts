import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";

import {
  fileRatificationDraft,
  inboxDraftExampleFragmentYaml,
  lintDraftedFragment,
  RatificationDraftRefusedError,
} from "../src/lib/inbox.js";
import { parseTasksFromYaml } from "../src/lib/plan.js";
import { lintTask } from "../src/lib/task-linter.js";

const PROPOSAL = "verify-human-automate:W1-T3332";
const KNOWN = new Set(["remudero", "none"]);
const STAMP = `- ${PROPOSAL} (W1-T5640/W1-T5641/W1-T5642) -> W1-T5640/W1-T5641/W1-T5642`;
const FRAGMENT = `
- id: W1-T5640
  title: "RATIFICATION CANDIDATE TASK: draft initial W1-T5640 placeholder for the ratification window"
  origin: "W1-T3332 governance intent"
  repo: remudero
  depends_on: []
  type: recon
  verify: auto
  risk: low
  status: queued
  attempts: 0
  files:
    - plan/ratification/W1-T5640.md
  acceptance:
    - claim: "The W1-T5640 draft establishes the baseline acceptance criteria and links back to W1-T3332's governance intent"
      proof: "unit test: plan/ratification/W1-T5640.md"
- id: W1-T5641
  title: "RATIFICATION CANDIDATE TASK: define migration path and testing for W1-T5641; link to W1-T5640"
  origin: "derived from W1-T5640"
  repo: remudero
  depends_on: [W1-T5640]
  type: implement
  verify: auto
  risk: low
  status: queued
  attempts: 0
  files:
    - plan/ratification/W1-T5641.md
  acceptance:
    - claim: "The W1-T5641 task specifies a concrete migration path and test scaffolding for ratification execution"
      proof: "unit test: plan/ratification/W1-T5641.md"
- id: W1-T5642
  title: "RATIFICATION CANDIDATE TASK: finalize stamp line integration plan for MASTER-PLAN.md"
  origin: "derived from W1-T5641"
  repo: remudero
  depends_on: [W1-T5641]
  type: review
  verify: auto
  risk: low
  status: queued
  attempts: 0
  files:
    - plan/ratification/W1-T5642.md
  acceptance:
    - claim: "The W1-T5642 task defines how the stamp line will finalize the ratification and reflect W1-T5640..W1-T5642"
      proof: "unit test: plan/ratification/W1-T5642.md"
`;
const GOOD = inboxDraftExampleFragmentYaml();
const GOOD_STAMP = `- ${PROPOSAL} (reject empty widget input) — RATIFIED 2026-10-05 -> NEW-1.`;

function amended(change: (task: ReturnType<typeof parse>[number]) => void): string {
  const tasks = parse(GOOD);
  change(tasks[0]);
  return stringify(tasks);
}

test("test/a-placeholder-draft-never-reaches-a-ratify-pr.test.ts", () => {
  const violations = lintDraftedFragment(FRAGMENT, PROPOSAL, STAMP, KNOWN);
  for (const id of ["W1-T5640", "W1-T5641", "W1-T5642"]) {
    assert.ok(violations.some((v) => v.severity === "block" && v.message.includes(id)),
      `${id} must have a blocking finding: ${JSON.stringify(violations)}`);
  }
  assert.deepEqual(lintDraftedFragment(GOOD, PROPOSAL, GOOD_STAMP, KNOWN), []);
});

test("each placeholder form independently blocks a draft while ordinary titles and proofs pass", () => {
  const cases: Array<[string, string]> = [
    [amended((t) => { t.title = "draft NEW-1 placeholder"; }), "draft-placeholder-title"],
    [amended((t) => { t.id = "W1-T7000"; t.title = "implement W1-T7000"; }), "draft-placeholder-title"],
    [amended((t) => { t.title = "draft NEW-2 placeholder"; }), "draft-placeholder-title"],
    [amended((t) => { t.acceptance[0].proof = "unit test: plan/ratification/future.md"; }), "draft-path-proof"],
    [amended((t) => { t.files = ["missing-draft-directory/future.ts"]; }), "draft-missing-directory"],
    [amended((t) => { t.type = "review"; }), "draft-undispatched-type"],
    [amended((t) => { t.type = "manual"; }), "draft-undispatched-type"],
  ];
  for (const [fragment, check] of cases) {
    const violations = lintDraftedFragment(fragment, PROPOSAL, undefined, KNOWN);
    assert.ok(violations.some((v) => v.check === check && v.severity === "block"),
      `${check}: ${JSON.stringify(violations)}`);
  }
  for (const label of ["NEW-1", "W1-T5640/W1-T5641/W1-T5642", "W1-T5640..W1-T5642"]) {
    const stamp = `- ${PROPOSAL} (${label}) -> NEW-1.`;
    assert.ok(lintDraftedFragment(GOOD, PROPOSAL, stamp, KNOWN)
      .some((v) => v.check === "draft-placeholder-stamp" && v.severity === "block"));
  }
  for (const proof of ["unit test: test/future.test.ts", "unit test: widget rejects ../bad.txt input"]) {
    assert.deepEqual(lintDraftedFragment(amended((t) => {
      t.acceptance[0].proof = proof;
      t.files.push("test/future.test.ts");
    }),
      PROPOSAL, GOOD_STAMP, KNOWN), []);
  }
  for (const type of ["recon", "implement", "diagnose"]) {
    assert.deepEqual(lintDraftedFragment(amended((t) => { t.type = type; }), PROPOSAL, GOOD_STAMP, KNOWN), []);
  }
});

test("placeholder findings stay draft-only for inherited plan tasks", () => {
  for (const task of parseTasksFromYaml(FRAGMENT, "legacy")) {
    assert.deepEqual(lintTask(task, { knownRepos: KNOWN }).violations, []);
  }
});

test("directory checks use the injected worktree predicate and permit future files in existing directories", () => {
  const fragment = amended((t) => { t.files = ["plan/ratification/future.md", "MASTER-PLAN.md"]; });
  const seen: string[] = [];
  const lint = (exists: boolean) => lintDraftedFragment(fragment, PROPOSAL, GOOD_STAMP, KNOWN, (path) => {
    seen.push(path);
    return exists;
  });
  assert.ok(lint(false).some((v) => v.check === "draft-missing-directory" && /"plan"/.test(v.message)));
  assert.deepEqual(lint(true), []);
  assert.deepEqual(seen, ["plan", "plan"]);
  assert.deepEqual(lintDraftedFragment(amended((t) => { t.title = "tighten the W1-T7001 input guard"; }),
    PROPOSAL, GOOD_STAMP, KNOWN), []);
});

test("filing refuses placeholders before writing and checks directories in the destination worktree", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "rmd-t5660-"));
  try {
    fs.mkdirSync(join(root, "src", "lib"), { recursive: true });
    const before = `- ${PROPOSAL} (open)\n`;
    fs.writeFileSync(join(root, "MASTER-PLAN.md"), before);
    const payload = { proposalId: PROPOSAL, fragmentYaml: FRAGMENT, stampLine: STAMP };
    assert.throws(() => fileRatificationDraft(root, payload, fs, join, KNOWN), RatificationDraftRefusedError);
    assert.equal(fs.existsSync(join(root, "plan")), false);
    assert.equal(fs.readFileSync(join(root, "MASTER-PLAN.md"), "utf8"), before);
    const absent = amended((t) => { t.files = ["test/future.test.ts"]; });
    assert.throws(() => fileRatificationDraft(root, { ...payload, fragmentYaml: absent, stampLine: GOOD_STAMP },
      fs, join, KNOWN), (e: unknown) => e instanceof RatificationDraftRefusedError && /draft-missing-directory/.test(e.message));
    assert.equal(fs.existsSync(join(root, "plan")), false);
    const written = fileRatificationDraft(root, { ...payload, fragmentYaml: GOOD, stampLine: GOOD_STAMP }, fs, join, KNOWN);
    assert.ok(written.some((path) => path.startsWith("plan/tasks.d/")));
    assert.equal(fs.readFileSync(join(root, "MASTER-PLAN.md"), "utf8"), GOOD_STAMP + "\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
