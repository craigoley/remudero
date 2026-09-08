// @source-text-subject - this suite's subject is the source text that may spawn the GitHub CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// W1-T2896 CI-log round: a static `with { type: "json" }` import synthesizes its OWN v8-covered
// module record for the baseline file — the coverage-ratchet diff gate then sees
// `scripts/gh-transport-baseline.json:1` as an added, never-hit line with no test that could ever
// "call" a JSON literal. `readFileSync` + `JSON.parse` (every other baseline consumer's own idiom
// — e.g. test/a-source-file-cannot-outgrow-its-baseline.test.ts's `source-size-baseline.json`
// read) carries no such record.
const baseline = JSON.parse(
  readFileSync(new URL("../scripts/gh-transport-baseline.json", import.meta.url), "utf8"),
) as { directGhSpawnsOutsideTransport: number };

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
  const ghBinary = String.raw`(?:"gh"|'gh'|[A-Za-z_$][\w$]*\.ghBin(?:\s*\?\?\s*(?:"gh"|'gh'))?)`;
  const directGh = new RegExp(String.raw`\b(?:execFileSync|execFile|spawnSync)\(\s*${ghBinary}`, "g");
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
