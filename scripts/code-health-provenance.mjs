#!/usr/bin/env node
// Sanitized evidence from existing measurements; no scanner, network or filing side effects.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export function codeqlProvenance(_input) { return null; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" } } });
  const result = codeqlProvenance(JSON.parse(readFileSync(values.input, "utf8")));
  writeFileSync(values.output, JSON.stringify(result) + "\n", { flag: "wx", mode: 0o600 });
}
