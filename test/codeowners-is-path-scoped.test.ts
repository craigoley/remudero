import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const OWNER = "@cao825";
const GATE_CONFIG_PATTERNS = [
  "/CODEOWNERS",
  "/.github/workflows/",
  "/plan/policy.yaml",
  "/plan/claims.yaml",
  "/plan/alert-policy.yaml",
  "/scripts/claude-md-budget-baseline.json",
  "/scripts/coverage-baseline.json",
  "/scripts/mutation-baseline.json",
  "/scripts/cycle-baseline.json",
  "/scripts/learnings-budget-baseline.json",
  "/scripts/mutation-relevant-paths.json",
] as const;

type CodeownersEntry = { pattern: string; owners: string[] };

function readCodeowners(): CodeownersEntry[] {
  return readFileSync(join(import.meta.dirname, "..", "CODEOWNERS"), "utf8")
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const fields = line.split(/\s+/);
      return { pattern: fields[0]!, owners: fields.slice(1) };
    });
}

function ownsPath(entries: CodeownersEntry[], path: string): string[] {
  const matching = entries.filter(({ pattern }) => {
    if (pattern.endsWith("/")) return path.startsWith(pattern.slice(1));
    return path === pattern.slice(1);
  });
  return matching.at(-1)?.owners ?? [];
}

test("every gate config path has a code owner", () => {
  const entries = readCodeowners();
  const patterns = entries.map(({ pattern }) => pattern);

  assert.equal(patterns.includes("*"), false, "a blanket wildcard would put the owner on every autonomous merge");
  assert.deepEqual(new Set(patterns), new Set(GATE_CONFIG_PATTERNS));
  for (const pattern of GATE_CONFIG_PATTERNS) {
    assert.deepEqual(ownsPath(entries, pattern.slice(1)), [OWNER], `${pattern} must be owned by the maintainer`);
  }
});

test("an ordinary source path has no code owner", () => {
  const entries = readCodeowners();
  assert.deepEqual(ownsPath(entries, "src/run-task.ts"), []);
  assert.deepEqual(ownsPath(entries, "test/worker.test.ts"), []);
});
