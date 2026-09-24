#!/usr/bin/env node
// scripts/decisions-status.mjs (W1-T4096) — stamps a `Status:` line onto every DECISIONS.md
// entry, via lib/narrative-fold.ts's deriveDecisionStatuses. Prints (to stderr) any entry whose
// supersession language it could not resolve to a named successor, so a human decides those by
// hand rather than the script guessing at one.
//
// Usage: node --import tsx scripts/decisions-status.mjs [--check] [--root <dir>]
// --check: exit 1 if DECISIONS.md is missing a status anywhere, write nothing.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deriveDecisionStatuses } from "../src/lib/narrative-fold.js";
import { isMainModule } from "./lib/argv.mjs";

export function run(argv = process.argv.slice(2)) {
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag >= 0 ? resolve(argv[rootFlag + 1]) : process.cwd();
  const check = argv.includes("--check");
  const path = join(root, "DECISIONS.md");
  const before = readFileSync(path, "utf8");
  const { text, unclassified } = deriveDecisionStatuses(before);
  for (const heading of unclassified) {
    console.error(`decisions-status: unclassified (partial supersession, kept accepted): ${heading}`);
  }
  if (text === before) {
    console.log("decisions-status: every entry already carries a status");
    return 0;
  }
  if (check) {
    console.error("decisions-status: DECISIONS.md is missing a status somewhere — run without --check to write it");
    return 1;
  }
  writeFileSync(path, text, "utf8");
  console.log(`decisions-status: stamped statuses onto DECISIONS.md (${unclassified.length} left unclassified)`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(run());
