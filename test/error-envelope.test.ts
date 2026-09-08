// test/error-envelope.test.ts — W1-T2901: the shared typed-error envelope (src/lib/errors.ts).
//
// Proves the one behaviour the envelope exists for: the process boundary (`exitCodeFor`) reads
// an error's OWN declared exit code instead of guessing by `instanceof`. A thrown `PlanError`
// (the first adopter, src/lib/plan.ts) yields its declared code; a foreign `Error` — anything
// that never adopted the envelope — falls through to the generic code unchanged.

import assert from "node:assert/strict";
import { test } from "node:test";
import { GENERIC_EXIT_CODE, RmdError, exitCodeFor, isRmdError, type RmdErrorKind } from "../src/lib/errors.js";
import { PlanError } from "../src/lib/plan.js";

/** A second, independent adopter with its OWN distinct code — proves `exitCodeFor` reads the
 *  envelope generically (any declared code flows through), not a hardcoded PlanError special case. */
class FixtureRefusedError extends RmdError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("usage" as RmdErrorKind, 7, message, details);
    this.name = "FixtureRefusedError";
  }
}

test("a thrown PlanError yields its own declared kind and exit code through exitCodeFor", () => {
  const err = new PlanError("task X: missing required field 'id'");
  assert.ok(isRmdError(err), "PlanError must be recognised as an RmdError");
  assert.equal(err.kind, "plan");
  assert.equal(err.exitCode, 1);
  assert.equal(exitCodeFor(err), 1);
});

test("a foreign Error — one that never adopted the envelope — yields the generic exit code", () => {
  const err = new Error("some unrelated failure");
  assert.equal(isRmdError(err), false);
  assert.equal(exitCodeFor(err), GENERIC_EXIT_CODE);
});

test("exitCodeFor reads whatever code an RmdError declares, not a fixed constant", () => {
  const err = new FixtureRefusedError("bad flag");
  assert.equal(isRmdError(err), true);
  assert.equal(err.exitCode, 7);
  assert.equal(exitCodeFor(err), 7);
  assert.notEqual(exitCodeFor(err), GENERIC_EXIT_CODE);
});

test("exitCodeFor tolerates non-Error thrown values (a thrown string, undefined) with the generic code", () => {
  assert.equal(exitCodeFor("a thrown string"), GENERIC_EXIT_CODE);
  assert.equal(exitCodeFor(undefined), GENERIC_EXIT_CODE);
});

test("details is optional structured context carried alongside message, not required at every call site", () => {
  const bare = new PlanError("no details here");
  assert.equal(bare.details, undefined);
  const withDetails = new PlanError("with details", { taskId: "W1-T1" });
  assert.deepEqual(withDetails.details, { taskId: "W1-T1" });
});
