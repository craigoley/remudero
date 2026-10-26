import assert from "node:assert/strict";
import { basename } from "node:path";
import { test } from "node:test";
import { LEDGER_FILENAME, ledgerPathFor } from "#src/lib/ledger-path.js";

test("W1-T10402: check:test:test/ledger-literal-census.test.ts:flaky is prevented, not retried", () => {
  // The one exported constant is what every module must import instead of spelling the name,
  // and the canonical path is built from it, so the import is always the working route.
  assert.equal(basename(ledgerPathFor({ root: "/r" })), LEDGER_FILENAME);
  assert.equal(ledgerPathFor({ root: "/r" }), `/r/state/${LEDGER_FILENAME}`);
});
