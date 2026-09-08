// @source-text-subject - this suite's subject is the source text that may spawn the GitHub CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import baseline from "../scripts/gh-transport-baseline.json" with { type: "json" };

const TRANSPORT_PATH = "src/lib/github-transport.ts";

function trackedSourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src/**/*.ts", "src/*.ts"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function directGhSpawnHits(): Array<{ file: string; snippet: string }> {
  const directGh = /\b(?:execFileSync|execFile|spawnSync)\(\s*["']gh["']/g;
  const hits: Array<{ file: string; snippet: string }> = [];
  for (const file of trackedSourceFiles()) {
    if (file === TRANSPORT_PATH) continue;
    const code = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    for (const match of code.matchAll(directGh)) {
      hits.push({ file, snippet: code.slice(match.index, match.index + 120).replace(/\s+/g, " ") });
    }
  }
  return hits;
}

test("gh transport census: no tracked source file spawns gh outside src/lib/github-transport.ts", () => {
  const hits = directGhSpawnHits();
  assert.equal(
    hits.length,
    baseline.directGhSpawnsOutsideTransport,
    hits.map((hit) => `${hit.file}: ${hit.snippet}`).join("\n"),
  );
  assert.equal(baseline.directGhSpawnsOutsideTransport, 0, "the post-migration baseline is zero outside transport");
});
