import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("cash allowance mutation scope names the canonical refusal suite exactly once", () => {
  const config = JSON.parse(readFileSync(join(process.cwd(), "stryker.conf.json"), "utf8"));
  const argv = config.commandRunner.command.split(/\s+/);
  assert.equal(argv.filter((arg: string) => arg === "test/cash-fallback-reads-the-remaining-allowance.test.ts").length, 1);
  assert.ok(argv.includes("test/classify.test.ts"), "the original classification suite remains selected");
  assert.deepEqual(config.mutate, ["src/lib/classify.ts"], "registering a suite never widens the product mutation scope");
});
