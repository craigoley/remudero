// @source-text-subject: this suite's subject is the source text that may spell the ledger filename.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set(["src/lib/ledger-path.ts", "src/lib/ledger-union.ts"]);

function ledgerFilenameLiteralViolations(root = REPO_ROOT): string[] {
  const needle = JSON.stringify(LEDGER_FILENAME);
  const files = execFileSync("git", ["ls-files", "src"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => file.endsWith(".ts"));
  return files.filter((file) => !ALLOWED.has(file) && readFileSync(join(root, file), "utf8").includes(needle));
}

test("the ledger filename literal appears only in the ledger owner modules", () => {
  assert.deepEqual(ledgerFilenameLiteralViolations(), []);
});
