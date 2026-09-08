import assert from "node:assert/strict";
import { test } from "node:test";
import { mintReservesById, validateReserveArgs } from "../src/run-task.js";

/**
 * test/a-mint-that-does-not-claim-is-a-collision-waiting.test.ts — W1-T3091.
 *
 * `rmd next-task-id` printed an id and claimed nothing, so two lanes minting in the same window
 * received the same number and one of them renumbered later, after a PR was already open. MEASURED
 * five times on 2026-09-07 alone. Reserving is now the default; not claiming is the opt-out.
 */

test("a bare mint RESERVES — the default is the safe one, not the cheap one", () => {
  assert.equal(mintReservesById([]), true);
  assert.equal(mintReservesById(["--plan", "plan/tasks.yaml"]), true, "an unrelated flag does not disable it");
});

test("--no-reserve is the explicit opt-out, for a peek that must claim nothing", () => {
  assert.equal(mintReservesById(["--no-reserve"]), false);
});

test("--offline IMPLIES the opt-out rather than erroring — it cannot push to what it will not read", () => {
  assert.equal(mintReservesById(["--offline"]), false);
  assert.equal(validateReserveArgs(["--offline"]), undefined, "offline alone is a legitimate invocation");
});

test("an EXPLICIT --reserve with --offline is still refused — that asks for two incompatible things", () => {
  assert.match(String(validateReserveArgs(["--reserve", "--offline"])), /contradictory/);
});

test("--reserve with --no-reserve is refused, and the message says the default already reserves", () => {
  const msg = String(validateReserveArgs(["--reserve", "--no-reserve"]));
  assert.match(msg, /contradictory/);
  assert.match(msg, /the id IS reserved, which is the default/, "the remedy must name the new default");
});

test("--reserve alone stays valid and redundant — an existing caller is not broken", () => {
  assert.equal(validateReserveArgs(["--reserve"]), undefined);
  assert.equal(mintReservesById(["--reserve"]), true);
});
