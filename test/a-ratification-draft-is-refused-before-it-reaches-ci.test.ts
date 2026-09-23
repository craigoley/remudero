import assert from "node:assert/strict";
import { test } from "node:test";

import {
  anchorFingerprint,
  blockingLintMessages,
  classifyProposal,
  inboxDraftPrompt,
  lintDraftedFragment,
  stampLineViolations,
  type Proposal,
  type ReadinessContext,
} from "../src/lib/inbox.js";
import { loadPlanFromYaml, parseTasksFromYaml, type Plan } from "../src/lib/plan.js";

// A RATIFICATION DRAFT CI IS CERTAIN TO REFUSE MUST NOT READ AS READY. Observed 2026-09-23: one
// `rmd approve` batch opened 15 ratify PRs and every one was red. Ten carried a whole-file proof
// shared by several criteria, which `rmd lint-plan --base` BLOCKS on a new plan-only shard
// (W1-T3814) while the draft rung and the readiness check only read plain-lint blocks. Four were
// junk whose stamp claimed "P25 … RATIFIED" for a different proposal, and one such stamp ("P44")
// had already merged. These pin the readiness-side refusal for both shapes.

const BASE_PLAN = loadPlanFromYaml(
  `
- id: W1-T1
  title: "already-merged dependency"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: merged
  attempts: 0
  origin: architect
`,
  "fixture",
);

/** The #6776 shape: several criteria answered by ONE whole-file unit-test proof in the task's own files:. */
const SHARED_PROOF_FRAGMENT = `
- id: NEW-1
  title: "a drafted task whose criteria share one whole-file proof"
  repo: remudero
  depends_on: [W1-T1]
  type: implement
  verify: auto
  risk: high
  status: queued
  attempts: 0
  origin: architect
  files: [src/lib/example.ts, test/example.test.ts]
  acceptance:
    - claim: "the first behaviour"
      proof: "unit test: test/example.test.ts"
    - claim: "the second behaviour"
      proof: "unit test: test/example.test.ts"
`;

/** The same task with one discriminating proof per criterion — the operator-filed W1-T4330 pattern. */
const DISTINCT_PROOF_FRAGMENT = SHARED_PROOF_FRAGMENT.replace(
  'proof: "unit test: test/example.test.ts"\n    - claim: "the second behaviour"\n      proof: "unit test: test/example.test.ts"',
  `proof: 'grep: test("NEW-1: the first behaviour" in test/example.test.ts'\n    - claim: "the second behaviour"\n      proof: 'grep: test("NEW-1: the second behaviour" in test/example.test.ts'`,
);

const proposal: Proposal = { id: "proof-debt:W1-T4048", summary: "repair the proof debt", evidenceAnchors: [] };
const GOOD_STAMP = "- proof-debt:W1-T4048 (repair the proof debt) — RATIFIED 2026-09-23 -> NEW-1.";

function ctx(): ReadinessContext {
  return {
    plan: BASE_PLAN as Plan,
    isMerged: (t) => t.status === "merged",
    grepAnchorTrue: () => true,
    openProposalIds: new Set(),
    isRatified: () => false,
  };
}

function classify(fragmentYaml: string, stampLine: string) {
  return classifyProposal(proposal, { proposalId: proposal.id, fragmentYaml, stampLine, anchorFingerprint: anchorFingerprint([]) }, ctx());
}

test("a drafted task whose criteria share one whole-file proof is a blocking draft violation, as lint-plan --base makes it", () => {
  const shared = lintDraftedFragment(SHARED_PROOF_FRAGMENT, proposal.id);
  assert.ok(
    shared.some((v) => v.check === "shared-proof" && v.severity === "block" && /W1-T3814/.test(v.message)),
    `expected a promoted shared-proof block, got ${JSON.stringify(shared)}`,
  );
  // Control: the SAME task with one discriminating proof per criterion is clean, so the refusal is the sharing.
  assert.deepEqual(lintDraftedFragment(DISTINCT_PROOF_FRAGMENT, proposal.id), []);
});

test("the readiness check refuses a new shared-proof task but leaves an inherited warning on an existing task advisory", () => {
  const planOf = (yaml: string): Plan => ({ ...BASE_PLAN, tasks: parseTasksFromYaml(yaml, "fragment") }) as Plan;
  assert.ok(blockingLintMessages(BASE_PLAN, planOf(SHARED_PROOF_FRAGMENT)).some((m) => m.startsWith("NEW-1: [shared-proof]")));

  // An amendment to a task that ALREADY carried the same warning at base inherits it: W1-T3814
  // promotes only what the filing introduces, so the base task's own warning must not block here.
  const amended = SHARED_PROOF_FRAGMENT.replace("id: NEW-1", "id: W1-T50");
  const base = { ...BASE_PLAN, tasks: [...BASE_PLAN.tasks, ...parseTasksFromYaml(amended, "base")] } as Plan;
  assert.deepEqual(blockingLintMessages(base, planOf(amended)).filter((m) => m.includes("[shared-proof]")), []);
});

test("a stamp that names another proposal or other tasks is refused, and a stamp naming this proposal and its tasks is not", () => {
  // The #6791 stamp, verbatim in shape: a P-number the proposal never had.
  const wrongProposal = stampLineViolations(proposal.id, "- P25 (MASTER-PLAN §7/P25) — RATIFIED 2026-09-23 -> NEW-1/NEW-2.", ["NEW-1"]);
  assert.equal(wrongProposal.length, 2, JSON.stringify(wrongProposal));
  assert.match(wrongProposal[0].message, /must open with "- proof-debt:W1-T4048 \("/);
  assert.match(wrongProposal[1].message, /name exactly this fragment's tasks \(NEW-1\); it names NEW-1\/NEW-2/);
  assert.deepEqual(stampLineViolations(proposal.id, GOOD_STAMP, ["NEW-1"]), []);
  // Comma-separated lists are in real stamps too; order is not the question, membership is.
  assert.deepEqual(stampLineViolations(proposal.id, "- proof-debt:W1-T4048 (two) — RATIFIED 2026-09-23 -> NEW-2, NEW-1.", ["NEW-1", "NEW-2"]), []);
  assert.equal(stampLineViolations(proposal.id, "- proof-debt:W1-T4048 (no task list) — RATIFIED 2026-09-23.", ["NEW-1"]).length, 1);
});

test("classifyProposal holds a draft with a misnamed stamp NOT-READY, naming the stamp", () => {
  const good = classify(DISTINCT_PROOF_FRAGMENT, GOOD_STAMP);
  assert.equal(good.state, "ready", JSON.stringify(good.reasons));

  const bad = classify(DISTINCT_PROOF_FRAGMENT, "- P44 (proof-debt: repair) — RATIFIED 2026-09-15 -> NEW-1.");
  assert.equal(bad.state, "not_ready");
  assert.ok(bad.reasons.some((r) => r.predicate === "lint_clean" && /stamp: the STAMP line must open with/.test(r.detail)), JSON.stringify(bad.reasons));
});

test("the draft prompt spells the stamp with the proposal's own id and keeps the process name out of task titles", () => {
  const prompt = inboxDraftPrompt(proposal, "- id: W1-T1\n", "RUN-1");
  assert.ok(prompt.includes("`- proof-debt:W1-T4048 (<one-line summary>) — RATIFIED <YYYY-MM-DD> -> <task ids>.`"));
  assert.ok(prompt.includes("never another P-number"));
  assert.ok(prompt.includes('"RATIFICATION CANDIDATE" and "§7/P25" above name this PROCESS: never put them in a task title.'));
  assert.ok(!prompt.includes("- P## (...)"), "the old P-number template taught the model to invent a P-number");
});
