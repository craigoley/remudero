// W1-T4585: W1-T4563 retired the daemon's console and W1-T4566 deleted apps/dashboard, but live
// references survived both: review.ts kept an apps/dashboard/src/ Vitest proof root that could no
// longer run (core installs no Vitest), the console-parity files still listed the deleted
// `console-url` verb, and scripts/source-size-baseline.json carried rows for five deleted modules.
// Each check below reads the shipped file, so the next retirement cannot leave the same residue.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { COMMANDS } from "../src/run-task.js";
import { parseWhitelistedProof } from "../src/lib/review.js";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("W1-T4585: no live proof root, parity row or size row names a retired console surface", () => {
  assert.equal(parseWhitelistedProof("unit test: apps/dashboard/src/App.test.tsx"), null, "the retired proof root refuses");

  const verbs = new Set(COMMANDS.map((c) => c.name));
  assert.equal(verbs.has("console-url"), false, "precondition: the verb is deleted");
  // Not "every baseline verb is live": a verb may be PRE-REGISTERED as cli-only before it ships
  // (`audit`). The deleted one must not linger.
  const listed = (JSON.parse(read("scripts/console-parity-baseline.json")) as { uncoveredVerbs: string[] }).uncoveredVerbs;
  assert.ok(listed.length > 0, "the parity baseline must be read, not assumed empty");
  assert.equal(listed.includes("console-url"), false, "the deleted console-url verb is not a baselined cli-only verb");
  assert.doesNotMatch(read("scripts/console-parity-ratchet.mjs"), /"console-url":/, "the ratchet's CLI_ONLY table names no deleted verb");

  // GENERAL, not a list of today's names: a size row for a deleted file is dead weight the ratchet
  // can never measure, and it is exactly what a retirement leaves behind.
  const sizes = JSON.parse(read("scripts/source-size-baseline.json")) as Record<string, unknown>;
  const rows = Object.keys(sizes).filter((key) => typeof sizes[key] === "number");
  assert.ok(rows.length > 100, `the size baseline must be read, saw ${rows.length} rows`);
  assert.deepEqual(rows.filter((path) => !existsSync(join(ROOT, path))), [], "every size row names a file that exists");

  assert.doesNotMatch(read("tsconfig.json"), /apps\/dashboard is now|carries its own browser-shaped tsconfig/, "tsconfig no longer describes the dashboard as present");
});
