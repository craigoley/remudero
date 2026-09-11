import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROOT_MARKDOWN_ALLOWLIST = new Set([
  "README.md",
  "CLAUDE.md",
  "MASTER-PLAN.md",
  "DECISIONS.md",
  "LEARNINGS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
]);

function rootMarkdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

function rootMarkdownCensus(files: string[], allowlist: Set<string> = ROOT_MARKDOWN_ALLOWLIST): string[] {
  return files.filter((file) => !allowlist.has(file));
}

// W1-T2918: root-level markdown census. Dated snapshots such as DIAGNOSIS.md and FINDINGS.md
// belong under docs/archive/, not at the repo root, so this population walk refuses a new one.

test("W1-T2918: the root markdown census names an unallowlisted snapshot", () => {
  assert.deepEqual(rootMarkdownCensus(["README.md", "SNAPSHOT.md"], new Set(["README.md"])), ["SNAPSHOT.md"]);
});

test("W1-T2918: every root-level markdown file is intentionally allowlisted", () => {
  const offenders = rootMarkdownCensus(rootMarkdownFiles(REPO_ROOT));
  assert.deepEqual(
    offenders,
    [],
    `root-level .md not on the allowlist: ${offenders.join(", ")} -- move it under docs/archive/ and repoint citations`,
  );
});

test("W1-T2918: DIAGNOSIS.md and FINDINGS.md are archived away from the repo root", () => {
  const present = new Set(rootMarkdownFiles(REPO_ROOT));
  assert.ok(!present.has("DIAGNOSIS.md"), "DIAGNOSIS.md is still at the repo root");
  assert.ok(!present.has("FINDINGS.md"), "FINDINGS.md is still at the repo root");
});
