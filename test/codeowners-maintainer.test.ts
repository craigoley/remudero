import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("the repository owner entry resolves to the authenticated maintainer", () => {
  const codeowners = readFileSync(join(import.meta.dirname, "..", "CODEOWNERS"), "utf8");
  assert.match(codeowners, /^\*\s+@cao825\s*$/m);
});
