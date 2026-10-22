// W1-T10236: the contract census (test/every-served-route-is-in-the-contract.test.ts) counts the SSE
// route buildStatusStream assembles as a served path. Pin that path here, so a rename in board.ts
// fails at the route's own definition rather than as a contract-drift round in an unrelated PR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStatusStream } from "#src/lib/board.js";

test("W1-T10236: check:test:test/every-served-route-is-in-the-contract.test.ts is prevented, not retried", () => {
  const route = buildStatusStream({ plan: { version: 1, tasks: [] }, ledgerPath: "unused", github: {} } as never);
  assert.equal(route.path, "/v1/status/stream");
  assert.equal(route.scope, "read");
  assert.equal(typeof route.subscribe, "function");
});
