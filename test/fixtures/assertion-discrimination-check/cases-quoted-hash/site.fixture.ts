// Fixture "test file" for assertion-discrimination-check's falsifier suite (W1-T1051).
// Named *.fixture.ts -- see cases-comment-only/site.fixture.ts for why.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const TARGET = join(REPO_ROOT, "targets", "quoted-hash.yml");

test("fixture: asserts a literal that follows a hash inside a quoted string", () => {
  const raw = readFileSync(TARGET, "utf8");
  assert.ok(raw.includes("TOTALLY-UNIQUE-LITERAL-C"));
});
