#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const runTaskSource = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
const commandsBlock = runTaskSource.match(/const COMMANDS: readonly CommandSpec\[] = \[([\s\S]*?)\n\] as const/);

// diff-cov: process-boundary — this refusal ends in process.exit(2) and the script is DRIVEN AS A SUBPROCESS by test/help-does-not-load-the-sdk.test.ts (it resolves ../src/run-task.ts from its own URL, so a fixture tree is the only way to reach it); a child process's lines cannot carry DA hits into the parent's coverage, and both refusals — registry absent vs registry present but scanning to zero — are asserted there by exit code and message.
if (!commandsBlock) {
  console.error("rmd help: cannot find COMMANDS registry in src/run-task.ts");
  process.exit(2);
}

const stringLiteral = '"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'';
const entryPattern = new RegExp(`syntax:\\s*(${stringLiteral})\\s*,\\s*summary:\\s*(${stringLiteral})`, "g");
const commands = [...commandsBlock[1].matchAll(entryPattern)].map((m) => ({
  syntax: parseStringLiteral(m[1]),
  summary: parseStringLiteral(m[2]),
}));

function parseStringLiteral(literal) {
  if (literal.startsWith('"')) return JSON.parse(literal);
  return literal.slice(1, -1).replace(/\\([\\'])/g, "$1");
}

// diff-cov: process-boundary — this refusal ends in process.exit(2) and the script is DRIVEN AS A SUBPROCESS by test/help-does-not-load-the-sdk.test.ts (it resolves ../src/run-task.ts from its own URL, so a fixture tree is the only way to reach it); a child process's lines cannot carry DA hits into the parent's coverage, and both refusals — registry absent vs registry present but scanning to zero — are asserted there by exit code and message.
if (commands.length === 0) {
  console.error("rmd help: COMMANDS registry scan found no commands");
  process.exit(2);
}

const footer =
  "An UNKNOWN command, or an unrecognized argument to a command, prints this usage and exits\n" +
  "NON-ZERO, spawning nothing — the control surface never falls through to a drain on bad input.\n" +
  "\n" +
  "A command's own description above is accurate about what ITS BODY does; the CLI ENTRY POINT\n" +
  "can still fast-forward this checkout's main first (git merge --ff-only origin/main) on a\n" +
  "clean, behind, on-main checkout, before almost any command dispatches — see the operator\n" +
  "guide's verb-table preamble for the exact condition. Set RMD_SELF_SYNC_DONE=1 to run any\n" +
  "command provably read-only.";

console.log(`usage:\n${commands.map((c) => `  ${c.syntax}   # ${c.summary}`).join("\n")}\n\n${footer}`);
