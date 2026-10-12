/**
 * test/a-prerequisite-pr-body-carrying-a-task-trailer-is-refused.test.ts — W1-T5809.
 *
 * THE DEFECT. W1-T5779's `prerequisitePrAdmissionRefusal` checked the opened prerequisite PR's body with
 * `acceptanceAuthorTimeCheck(body)` and no options. That call returns ok for ANY `Remudero-Task:` trailer
 * before it looks for an Acceptance block, so a split worker that added a trailer was admitted with no
 * Acceptance section and a false credit: the prerequisite builds no filed task.
 *
 * THE FIX. A body in which `extractTaskTrailerId` finds a trailer is refused, naming the trailer, before
 * `acceptanceAuthorTimeCheck` runs; a trailer-free body is checked exactly as before.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { prerequisitePrAdmissionRefusal } from "../src/run-task.js";
import { acceptanceAuthorTimeCheck } from "../src/lib/review.js";

const PREREQ_URL = "https://github.com/acme/remudero/pull/9206";
const MINTED = "run-unfiled-1791164997643";
const ACCEPTANCE = ["## Acceptance", "- the instrument reads the new field | grep: newField in scripts/diff-coverage.mjs"];

function admit(body: string) {
  return prerequisitePrAdmissionRefusal(PREREQ_URL, MINTED, {
    readLiveHead: () => ({ ok: true, headSha: "abc", headRefName: MINTED }),
    fetchPrBody: async () => body,
  });
}

test("a prerequisite body carrying a Remudero-Task trailer and no Acceptance block is refused naming the trailer", async () => {
  const body = ["Splits the instrument half out of #4242.", "", "Remudero-Task: W1-T4242"].join("\n");
  assert.equal(acceptanceAuthorTimeCheck(body).ok, true, "the bare check alone admits it: the defect this closes");
  const refusal = await admit(body);
  assert.ok(refusal, "a trailered prerequisite body is refused");
  assert.match(refusal, /Remudero-Task: W1-T4242/, "the refusal names the trailer it found");
  assert.match(refusal, /credits no task/, "and says why a prerequisite may not carry one");
  assert.ok(refusal.includes(PREREQ_URL));
});

test("a trailered prerequisite body is refused even beside a valid Acceptance block", async () => {
  const refusal = await admit(["Splits the instrument half.", "", ...ACCEPTANCE, "", "Remudero-Task: W1-T4242"].join("\n"));
  assert.match(String(refusal), /Remudero-Task: W1-T4242/);
});

test("a trailer-free prerequisite body with a valid Acceptance block is admitted", async () => {
  assert.equal(await admit(["Splits the instrument half out of #4242.", "", ...ACCEPTANCE].join("\n")), undefined);
});

test("a trailer-free prerequisite body with no Acceptance block is refused as today", async () => {
  const refusal = await admit("Splits the instrument half out of #4242. No acceptance block at all.");
  assert.match(String(refusal), /no-header/, "the reason still carries acceptanceAuthorTimeCheck's own defect");
  assert.doesNotMatch(String(refusal), /credits no task/, "the trailer refusal fires only on a trailer");
});
