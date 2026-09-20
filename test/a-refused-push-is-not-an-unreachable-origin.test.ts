import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyReservationPushFailure,
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

// W1-T3844: the shape an egress policy produces. The origin is REACHABLE -- the
// `info/refs?service=git-receive-pack` GET immediately before this returned 200 -- and only the
// ref WRITE was declined. Observed 2026-09-20 against a proxy that permits `refs/heads/*` and
// refuses every other namespace. Before this arm existed it fell through to `unknown`, and the
// caller was told nothing it could act on.
const POLICY_REFUSAL = [
  "error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403",
  "send-pack: unexpected disconnect while reading sideband packet",
  "fatal: the remote end hung up unexpectedly",
].join("\n");

test("W1-T3844: a 403 at receive-pack classifies as refused, never unreachable and never unknown", () => {
  assert.throws(reserveAfterPushFailure(POLICY_REFUSAL), (error: unknown) => {
    assert.ok(error instanceof TaskIdReservationError);
    assert.equal(error.outcome, "refused");
    assert.doesNotMatch(error.message, /UNKNOWN push failure/);
    assert.doesNotMatch(error.message, /cannot reach origin/);
    return true;
  });
});

test("W1-T3844: the refusal names --no-reserve as the path that still yields an id", () => {
  assert.throws(reserveAfterPushFailure(POLICY_REFUSAL), (error: unknown) => {
    assert.ok(error instanceof TaskIdReservationError);
    assert.match(error.message, /--no-reserve still yields an id/);
    assert.match(error.message, /refusing to mint/);
    assert.match(error.message, /HTTP 403/);
    return true;
  });
});

// The new arm sits between `taken` and `unreachable`, so it is exactly the placement that could
// have swallowed a neighbour. This pins all four classifications at once.
test("W1-T3844: the other push-failure arms are unchanged", () => {
  assert.equal(classifyReservationPushFailure("pre-push REFUSED.\nrun the tier check"), "local");
  assert.equal(classifyReservationPushFailure("! [remote rejected] already exists"), "taken");
  assert.equal(classifyReservationPushFailure("hint: Updates were rejected (non-fast-forward)"), "taken");
  assert.equal(classifyReservationPushFailure("fatal: Could not resolve host: github.com"), "unreachable");
  assert.equal(classifyReservationPushFailure("ssh: connect to host github.com port 22: Operation timed out"), "unreachable");
  assert.equal(classifyReservationPushFailure("fatal: a future git failure we do not classify"), "unknown");
  assert.equal(classifyReservationPushFailure(POLICY_REFUSAL), "refused");
});
