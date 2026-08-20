// Fixture "test file" for assertion-discrimination-check's falsifier suite (W1-T1051).
//
// Named *.fixture.ts (never *.test.ts) so it is NEVER picked up by `npm test`'s own
// "test/**/*.test.ts" glob -- it exists only to be scanned by the checker CLI itself, driven with
// --test-dir pointed at this directory and --suffix .fixture.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const TARGET = join(REPO_ROOT, "targets", "comment-only.yml");

test("fixture: asserts a literal that only a comment in the target satisfies", () => {
  const raw = readFileSync(TARGET, "utf8");
  assert.ok(raw.includes("TOTALLY-UNIQUE-LITERAL-A"));
});
