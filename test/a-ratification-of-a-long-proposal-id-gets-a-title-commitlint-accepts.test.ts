/**
 * `rmd approve` titled a single-proposal ratification PR `chore(plan): ratify <id> via rmd approve`, unfitted.
 * The PR title is the squash commit's header, and the approve push preflight runs commitlint over it. Long
 * adoption ids made it 103 to 112 characters, so the push was refused [pr-title] header-max-length on every try.
 * Six refusals were recorded on 2026-10-13..14, among them classifyGhLimitFailure (112), selectSkillsForTask (107),
 * buildPanelSkillsRoutes (108), burnRatePredicate (105) and managedReposPath (103).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CONVENTIONAL_LIMITS, checkCommitMessage } from "../src/lib/commit-message.js";
import { approvePrTitle } from "../src/lib/inbox.js";

const REFUSED_IDS = [
  "adoption:symbol-no-caller:src/lib/github-transport.ts:classifyGhLimitFailure",
  "adoption:symbol-no-caller:src/lib/skill-workshop.ts:selectSkillsForTask",
  "adoption:symbol-no-caller:src/lib/panel-skills.ts:buildPanelSkillsRoutes",
  "adoption:symbol-no-caller:src/lib/flight-signals.ts:burnRatePredicate",
  "adoption:symbol-no-caller:src/lib/managed-repos.ts:managedReposPath",
];

test("a ratification of a long proposal id gets a PR title commitlint accepts", () => {
  for (const id of REFUSED_IDS) {
    const title = approvePrTitle(id);
    assert.ok(title.length <= CONVENTIONAL_LIMITS.headerMaxLength, `${title.length}: ${title}`);
    assert.deepEqual(checkCommitMessage(title).filter((v) => v.rule === "header-max-length"), [], title);
    assert.match(title, /^chore\(plan\): ratify adoption:symbol-no-caller:src\/lib\//, "the type, scope and lead of the id are kept");
  }
});

test("a ratification of a short proposal id keeps its full title", () => {
  assert.equal(approvePrTitle("proof-debt:W1-T4339"), "chore(plan): ratify proof-debt:W1-T4339 via rmd approve");
});
