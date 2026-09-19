import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const titleWorkflow = readFileSync(join(ROOT, ".github/workflows/pr-title-lint.yml"), "utf8");
const requiredGate = readFileSync(join(ROOT, ".github/workflows/ci-gate.yml"), "utf8");

test("W1-T3781: title edits use a standalone commitlint workflow without widening the expensive CI trigger", () => {
  const ciTrigger = ci.slice(ci.indexOf("on:\n"), ci.indexOf("\npermissions:"));
  assert.doesNotMatch(ciTrigger, /edited/);
  assert.match(titleWorkflow, /types: \[opened, synchronize, reopened, edited\]/);
  assert.match(titleWorkflow, /\n  commitlint:\n\s+name: commitlint/);
  assert.match(requiredGate, /"commitlint"/);
});

test("W1-T3781: the edited-event job reads the live title and diagnoses an empty API read", () => {
  assert.match(titleWorkflow, /gh pr view "\$PR_NUMBER" --repo "\$GITHUB_REPOSITORY" --json title --jq \.title/);
  assert.match(titleWorkflow, /returned an EMPTY title/);
  assert.match(titleWorkflow, /commitlint --config commitlint\.config\.mjs --verbose/);
});
