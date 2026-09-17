// test/a-trailer-pr-is-judged-against-the-task-it-credits.test.ts
//
// W1-T3658 — A PULL REQUEST'S OWN ACCEPTANCE BLOCK AND ITS TASK'S DECLARED PROOFS CAN DIVERGE
// WITH NOTHING NOTICING. `CONSOLE-T12` shipped and merged while all four of its declared proofs
// named unit tests that did not exist — because the PR that shipped it carried BOTH a
// `Remudero-Task:` trailer (the shape `acceptanceAuthorTimeCheck` resolves criteria from) AND its
// own body-level `## Acceptance` block naming four DIFFERENT proofs. Review judged the trailer's
// shard; a human reading the PR read the body's block; nothing compared the two.
//
// WHAT IS REAL HERE: `evaluateGate`/`trailerBodyProofDivergenceRefusal` are the production
// functions from `scripts/acceptance-author-gate.mjs`, imported directly — no seam, nothing
// mocked. `taskAcceptanceForId` is a plain injected function (the same shape
// `planTaskAcceptanceResolver` produces from the real plan), so these tests never depend on which
// tasks happen to be filed at HEAD.

import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "acceptance-author-gate.mjs");

// `scripts/**` sits outside tsconfig's `include`, so a static import is a TS7016 — same reason
// test/acceptance-author-gate.test.ts reaches this script through a runtime import.
const GATE_URL = pathToFileURL(SCRIPT).href;

type AcceptanceCriterion = { claim: string; proof: string };
type TaskAcceptanceForId = (taskId: string) => readonly AcceptanceCriterion[] | undefined;
type GateInput = {
  body: string;
  authorLogin?: string;
  trailerResolves?: (taskId: string) => boolean;
  taskAcceptanceForId?: TaskAcceptanceForId;
};
type GateVerdict = { ok: boolean; defect?: string; message: string };

const mod = (await import(GATE_URL)) as {
  evaluateGate: (input: GateInput) => GateVerdict;
  trailerBodyProofDivergenceRefusal: (input: {
    body: string;
    taskAcceptanceForId?: TaskAcceptanceForId;
  }) => GateVerdict | undefined;
};
const { evaluateGate, trailerBodyProofDivergenceRefusal } = mod;

const TASK_ID = "CONSOLE-T12";

/** The task's OWN declared criteria — what a human reading the plan, or `remudero-review`
 *  resolving the trailer, sees. Proofs name real, existing tests. */
const TASK_ACCEPTANCE: AcceptanceCriterion[] = [
  { claim: "the now board renders a row per live task", proof: "unit test: renders a row per live task" },
  { claim: "the activity feed renders the verb, task and cost", proof: "unit test: renders verb task and cost" },
  { claim: "one unavailable source does not blank the surface", proof: "unit test: one unavailable source keeps the rest" },
  { claim: "an empty board states that nothing is running", proof: "unit test: empty board states nothing is running" },
];

const taskAcceptanceForId: TaskAcceptanceForId = (taskId) => (taskId === TASK_ID ? TASK_ACCEPTANCE : undefined);

/** The PR's OWN body block — the CONSOLE-T12 shape: a trailer AND a block, naming FOUR proofs of
 *  the SAME COUNT as the task's own, but every one names a test that never existed. Equal count,
 *  disjoint content — the exact shape the task's own falsifier calls out: "compare only proof
 *  COUNTS and ... two different proof sets of equal size merge". */
const DIVERGENT_BODY = [
  "## Acceptance",
  "",
  "- claim: the now board renders a row per live task",
  "  proof: unit test: renders one row per live task ever",
  "- claim: the activity feed renders the verb, task and cost",
  "  proof: unit test: shows verb task and cost inline",
  "- claim: one unavailable source does not blank the surface",
  "  proof: unit test: partial outage still renders",
  "- claim: an empty board states that nothing is running",
  "  proof: unit test: says nothing running when empty",
  "",
  `Remudero-Task: ${TASK_ID}`,
].join("\n");

test("a body block that disagrees with its task's proofs is refused", () => {
  const result = evaluateGate({ body: DIVERGENT_BODY, authorLogin: "a-human", taskAcceptanceForId });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "trailer-body-proof-divergence");

  // Direct-predicate control: the same verdict is reachable off the predicate itself, not just
  // through the gate's composition.
  const direct = trailerBodyProofDivergenceRefusal({ body: DIVERGENT_BODY, taskAcceptanceForId });
  assert.equal(direct?.ok, false);
  assert.equal(direct?.defect, "trailer-body-proof-divergence");

  // NEGATIVE CONTROL — an IDENTICAL body/task proof set (same claims, same proofs, same count) is
  // NOT refused, proving the predicate compares CONTENT and does not simply refuse every
  // trailer+block combination.
  const agreeingBody = [
    "## Acceptance",
    "",
    ...TASK_ACCEPTANCE.map((c) => `- claim: ${c.claim}\n  proof: ${c.proof}`),
    "",
    `Remudero-Task: ${TASK_ID}`,
  ].join("\n");
  const agreeing = evaluateGate({ body: agreeingBody, authorLogin: "a-human", taskAcceptanceForId });
  assert.equal(agreeing.ok, true, agreeing.ok ? "" : agreeing.message);
});

test("a body block with no task trailer is judged exactly as before", () => {
  // Shape 1: a body-level `## Acceptance` block with NO `Remudero-Task:` trailer at all. The new
  // predicate has nothing to compare the block against (no trailer id to resolve), so wiring
  // `taskAcceptanceForId` in must not change the verdict from what the gate returns with it
  // entirely absent.
  const bodyOnly = [
    "## Acceptance",
    "",
    "- claim: a claim with no filed task behind it",
    "  proof: unit test: some test that exists",
    "",
  ].join("\n");
  const withResolver = evaluateGate({ body: bodyOnly, authorLogin: "a-human", taskAcceptanceForId });
  const withoutResolver = evaluateGate({ body: bodyOnly, authorLogin: "a-human" });
  assert.deepEqual(withResolver, withoutResolver);
  assert.equal(withResolver.ok, true, withResolver.message);
  assert.equal(trailerBodyProofDivergenceRefusal({ body: bodyOnly, taskAcceptanceForId }), undefined);

  // Shape 2 (the claim's other half): a trailer with NO body-level block at all — criteria resolve
  // from the plan, so there is no body block to disagree with it. Also unaffected.
  const trailerOnly = `Just prose describing the change.\n\nRemudero-Task: ${TASK_ID}\n`;
  const trailerWithResolver = evaluateGate({
    body: trailerOnly,
    authorLogin: "a-human",
    trailerResolves: (taskId) => taskId === TASK_ID,
    taskAcceptanceForId,
  });
  const trailerWithoutResolver = evaluateGate({
    body: trailerOnly,
    authorLogin: "a-human",
    trailerResolves: (taskId) => taskId === TASK_ID,
  });
  assert.deepEqual(trailerWithResolver, trailerWithoutResolver);
  assert.equal(trailerWithResolver.ok, true, trailerWithResolver.message);
  assert.equal(trailerBodyProofDivergenceRefusal({ body: trailerOnly, taskAcceptanceForId }), undefined);
});

test("the refusal names the proofs that differ", () => {
  const result = evaluateGate({ body: DIVERGENT_BODY, authorLogin: "a-human", taskAcceptanceForId });
  assert.equal(result.ok, false);

  // Every proof the BODY names but the task does not declare.
  const bodyOnlyProofs = [
    "unit test: renders one row per live task ever",
    "unit test: shows verb task and cost inline",
    "unit test: partial outage still renders",
    "unit test: says nothing running when empty",
  ];
  for (const proof of bodyOnlyProofs) {
    assert.ok(result.message.includes(proof), `refusal names body-only proof "${proof}"`);
  }
  // Every proof the TASK declares but the body does not name.
  for (const criterion of TASK_ACCEPTANCE) {
    assert.ok(result.message.includes(criterion.proof), `refusal names task-only proof "${criterion.proof}"`);
  }
  assert.match(result.message, new RegExp(`Remudero-Task: ${TASK_ID}`));
  assert.match(result.message, /## Acceptance/);
});

// ── Supporting coverage beyond the three named proofs (not itself a required proof) ─────────────

test("a task whose acceptance the plan cannot resolve (or that has none) buys no refusal", () => {
  const unresolvable = evaluateGate({
    body: `## Acceptance\n\n- claim: x\n  proof: unit test: y\n\nRemudero-Task: W1-TNOTFOUND\n`,
    authorLogin: "a-human",
    taskAcceptanceForId: () => undefined,
  });
  assert.equal(unresolvable.ok, true, unresolvable.message);

  const throwing = evaluateGate({
    body: `## Acceptance\n\n- claim: x\n  proof: unit test: y\n\nRemudero-Task: ${TASK_ID}\n`,
    authorLogin: "a-human",
    taskAcceptanceForId: () => {
      throw new Error("unreadable plan record");
    },
  });
  assert.equal(throwing.ok, true, throwing.message);

  const emptyAcceptance = evaluateGate({
    body: `## Acceptance\n\n- claim: x\n  proof: unit test: y\n\nRemudero-Task: ${TASK_ID}\n`,
    authorLogin: "a-human",
    taskAcceptanceForId: () => [],
  });
  assert.equal(emptyAcceptance.ok, true, emptyAcceptance.message);
});

test("reordered bullets that name the same proofs are not a divergence", () => {
  const reordered = [
    "## Acceptance",
    "",
    ...[...TASK_ACCEPTANCE].reverse().map((c) => `- claim: ${c.claim}\n  proof: ${c.proof}`),
    "",
    `Remudero-Task: ${TASK_ID}`,
  ].join("\n");
  const result = evaluateGate({ body: reordered, authorLogin: "a-human", taskAcceptanceForId });
  assert.equal(result.ok, true, result.message);
});
