// test/every-registered-verb-appears-in-rmd-help.test.ts — `rmd --help` is served by
// scripts/rmd-help.mjs, which regex-scans the COMMANDS source for LITERAL `syntax:`/`summary:` pairs so
// help never loads the heavy module graph (#4778). An entry whose syntax was an identifier
// (`PROPOSAL_VERDICT_SYNTAX.decline`) matched nothing and vanished from the help an operator sees, while
// the registry-built USAGE the other help test checks still listed it. Observed 2026-09-24 on the fleet
// host: `rmd --help` printed no `decline` or `restore` line although both verbs worked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PROPOSAL_VERDICT_SYNTAX } from "../src/lib/inbox-verdict-command.js";
import { COMMANDS } from "../src/run-task.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every registered verb appears in the help rmd --help prints", () => {
  const res = spawnSync(process.execPath, [join(repoRoot, "scripts", "rmd-help.mjs")], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const listed = new Set([...res.stdout.matchAll(/^ {2}rmd ([a-z0-9-]+)/gm)].map((m) => m[1]));
  const registered = COMMANDS.map((c) => c.name);
  assert.ok(registered.length > 50, "the registry was read");
  assert.deepEqual(registered.filter((name) => !listed.has(name)), [], "a registered verb is missing from rmd --help");
});

test("the decline and restore help lines match the syntax their errors quote", () => {
  const syntaxOf = (name: string) => COMMANDS.find((c) => c.name === name)?.syntax;
  assert.equal(syntaxOf("decline"), PROPOSAL_VERDICT_SYNTAX.decline);
  assert.equal(syntaxOf("restore"), PROPOSAL_VERDICT_SYNTAX.restore);
});
