import assert from "node:assert/strict";
import { test } from "node:test";
import { landingIdentity, type LandingRepository } from "../src/lib/feedback-landing.js";
import { isDeclaredBranchGuard, planReverseBranchDrift } from "../src/lib/branch-reaper.js";
import { planBranchReap, type BranchFacts } from "../src/lib/status.js";

const coreRepo: LandingRepository = { owner: "craigoley", repo: "remudero" };

function fact(name: string, over: Partial<BranchFacts> = {}): BranchFacts {
  return {
    name,
    prState: "merged",
    tipInMain: true,
    namedInSource: false,
    ...over,
  };
}

test("the branch reaper guards the whole derived landing family", () => {
  const site = landingIdentity({
    targetRepository: { owner: "craigoley", repo: "remudero-site" },
    sourceRepository: coreRepo,
    landingOwner: "site-daemon",
  });

  assert.ok(isDeclaredBranchGuard(site.branch));
  const plan = planBranchReap([fact(site.branch)], ["main"]);
  assert.deepEqual(plan.guarded, [site.branch]);
  assert.deepEqual(plan.deletable, []);
});

test("a guarded-but-undeclared source branch still reports drift", () => {
  const plan = planBranchReap([fact("some-infra-branch", { namedInSource: true })], ["main"]);
  assert.deepEqual(plan.guarded, ["some-infra-branch"]);
  assert.deepEqual(plan.undeclaredGuards, ["some-infra-branch"]);
  assert.deepEqual(plan.deletable, []);
});

test("reverse drift still reports citations that are neither remote nor declared", () => {
  const drift = planReverseBranchDrift(
    [{ file: "src/lib/somewhere.ts", line: 7, name: "vanished-branch" }],
    ["main"],
    ["main"],
    undefined,
  );

  assert.deepEqual(drift.danglingCitations, ["vanished-branch"]);
});
