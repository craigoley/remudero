import assert from "node:assert/strict";
import { test } from "node:test";

import { ciFrictionLadder, gitCiFrictionOwnerSearch } from "#src/lib/ci-friction-gardener.js";

const CAUSE = "check:test:test/a-generic-term-locates-no-owner.test.ts";

test("W1-T9417: check:test:test/a-generic-term-locates-no-owner.test.ts is prevented, not retried", () => {
  // A search that finds no owner for the test file.
  const search = gitCiFrictionOwnerSearch((args) => (args[0] === "rev-parse" ? "a".repeat(40) : ""));
  const result = ciFrictionLadder({
    priced: [{ cause: { kind: "check", name: "test:test/a-generic-term-locates-no-owner.test.ts" }, minutes: 43.7, rounds: 12, prs: 12 }],
    rounds: [], tasks: [], receipts: new Set(), escalated: new Set(), ownerSearch: search, nowMs: 0,
  });
  assert.equal(result.ladder.length, 1);
  assert.notEqual(result.ladder[0]?.state, undefined);
  // A second pass over the same evidence reaches the same decision rather than a new fix round.
  const again = ciFrictionLadder({
    priced: [{ cause: { kind: "check", name: "test:test/a-generic-term-locates-no-owner.test.ts" }, minutes: 43.7, rounds: 12, prs: 12 }],
    rounds: [], tasks: [], receipts: new Set(), escalated: new Set(), ownerSearch: search, nowMs: 0,
  });
  assert.equal(again.ladder[0]?.state, result.ladder[0]?.state);
});
