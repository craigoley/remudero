import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanPrBody } from "../src/lib/plan-pr-emitter.js";
import { gitRepo } from "./helpers/git-repo.js";

const BASE = "0123456789abcdef0123456789abcdef01234567";
const criteria = [{
  claim: "the author-time criterion is written through untouched",
  proof: "grep: a discriminating criterion is written through untouched in test/plan-pr-author-time-proof.test.ts",
}];

test("a criterion that passes at base is refused at author time", () => {
  assert.throws(
    () => buildPlanPrBody({ intro: "A change.", criteria, baseRef: BASE, proofCheck: () => 5 }),
    /passes at both head and base/,
  );
});

test("the author-time refusal executes against base, never a wording heuristic", () => {
  const calls: Array<[string, string]> = [];
  assert.throws(
    () => buildPlanPrBody({
      intro: "The claim does not say unchanged.",
      criteria,
      baseRef: BASE,
      proofCheck: (proof, baseRef) => { calls.push([proof, baseRef]); return 5; },
    }),
    /passes at both head and base/,
  );
  assert.deepEqual(calls, [[criteria[0]!.proof, BASE]]);
});

test("the author-time base is resolved from the checkout whose PR body is being emitted", () => {
  const repo = gitRepo({ kind: "author-proof-cwd" });
  const base = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", base);
  repo.git("commit", "--allow-empty", "-m", "author head");
  const head = repo.git("rev-parse", "HEAD");
  const observed: string[] = [];

  buildPlanPrBody({
    intro: "A change.",
    criteria,
    proofCwd: repo.dir,
    proofCheck: (_proof, baseRef) => {
      observed.push(baseRef);
      return 0;
    },
  });

  assert.notEqual(base, head);
  assert.deepEqual(observed, [base]);
});

test("author-time refuses when the checkout cannot resolve a merge base", () => {
  const repo = gitRepo({ kind: "author-proof-no-base" });
  assert.throws(
    () => buildPlanPrBody({ intro: "A change.", criteria, proofCwd: repo.dir }),
    /cannot resolve the merge base for acceptance proofs; ask for a human ruling/,
  );
});

test("the remedy keeps the test and withdraws the criterion", () => {
  assert.throws(
    () => buildPlanPrBody({ intro: "A change.", criteria, baseRef: BASE, proofCheck: () => 5 }),
    /keep the test, withdraw the criterion, and name why it was withdrawn in the body/,
  );
});

test("a discriminating criterion is written through untouched", () => {
  const body = buildPlanPrBody({ intro: "A change.", criteria, baseRef: BASE, proofCheck: () => 0 });
  assert.equal(
    body,
    "A change.\n\nAcceptance:\n- the author-time criterion is written through untouched | " +
      "grep: a discriminating criterion is written through untouched in test/plan-pr-author-time-proof.test.ts\n",
  );
});

test("a body with no discriminating criterion asks for a human", () => {
  assert.throws(
    () => buildPlanPrBody({
      intro: "A change.",
      criteria: [{ claim: "the behavior is observable", proof: "unit test: a criterion that passes at base is refused at author time" }],
      baseRef: BASE,
      proofCheck: () => 3,
    }),
    /ask for a human ruling: this body has no discriminating criterion/,
  );
});
