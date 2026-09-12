import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gitRemoteRefReserver,
  reserveTaskIdRemote,
  TaskIdReservationError,
} from "../src/lib/task-id-reservation.js";

function reserveAfterPushFailure(stderr: string): () => void {
  const reserver = gitRemoteRefReserver({
    anchor: () => "orphan-anchor",
    run(args) {
      if (args[0] === "ls-remote") return { status: 0, stdout: "", stderr: "" };
      return { status: 1, stdout: "", stderr };
    },
  });
  return () => reserveTaskIdRemote(3343, reserver);
}

test("a local pre-push refusal is named and quoted, while refusing to mint", () => {
  const gate = "pre-push REFUSED.\nrun npm run --silent test:tier:check";
  assert.throws(reserveAfterPushFailure(gate), (error: unknown) => {
    assert.ok(error instanceof TaskIdReservationError);
    assert.equal(error.outcome, "local");
    assert.match(error.message, /local pre-push gate refused/);
    assert.match(error.message, /pre-push REFUSED\./);
    assert.match(error.message, /refusing to mint/);
    return true;
  });
});

test("a genuine network failure remains unreachable and refuses to mint", () => {
  assert.throws(reserveAfterPushFailure("fatal: Could not resolve host: github.com"), (error: unknown) => {
    assert.ok(error instanceof TaskIdReservationError);
    assert.equal(error.outcome, "unreachable");
    assert.match(error.message, /cannot reach origin/);
    assert.match(error.message, /refusing to mint/);
    return true;
  });
});

test("an unrecognised push failure is unknown, quoted, and still refuses to mint", () => {
  const detail = "fatal: a future git failure we do not classify";
  assert.throws(reserveAfterPushFailure(detail), (error: unknown) => {
    assert.ok(error instanceof TaskIdReservationError);
    assert.equal(error.outcome, "unknown");
    assert.match(error.message, /UNKNOWN push failure/);
    assert.match(error.message, /future git failure we do not classify/);
    assert.match(error.message, /refusing to mint/);
    return true;
  });
});
