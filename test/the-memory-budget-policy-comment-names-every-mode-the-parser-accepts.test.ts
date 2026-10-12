// The comment above `sweep.hostMemoryBudget` in plan/policy.yaml is what an operator reads before
// switching the budget's mode, so it must name every mode the parser accepts and never claim one is
// missing. It said "no enforce mode exists" for a day after #10730 added one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { parseHostMemoryBudgetPolicy } from "../src/lib/host-memory-shadow.js";

const POLICY = "plan/policy.yaml";
const CANDIDATE_MODES = ["off", "shadow", "enforce", "block", "defer"];

function budgetComment(text: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line === "  hostMemoryBudget:");
  assert.ok(at > 0, "plan/policy.yaml has a sweep.hostMemoryBudget block");
  const comment: string[] = [];
  for (let i = at - 1; i >= 0 && /^ {2}#/.test(lines[i]); i--) comment.unshift(lines[i].replace(/^ {2}# ?/, ""));
  assert.ok(comment.length > 0, "the hostMemoryBudget block carries a comment");
  return comment.join(" ");
}

function acceptedModes(text: string): string[] {
  const block = (parseYaml(text) as { sweep: { hostMemoryBudget: Record<string, unknown> } }).sweep.hostMemoryBudget;
  return CANDIDATE_MODES.filter((mode) => {
    const raw = { ...block, mode: { ...(block.mode as Record<string, unknown>), value: mode } };
    try {
      parseHostMemoryBudgetPolicy(raw);
      return true;
    } catch {
      return false;
    }
  });
}

test("the memory budget's policy comment names every mode the parser accepts and denies none of them", () => {
  const text = readFileSync(POLICY, "utf8");
  const comment = budgetComment(text);
  const accepted = acceptedModes(text);
  assert.deepEqual(accepted, ["off", "shadow", "enforce"], "the parser's accepted modes");
  for (const mode of accepted) {
    assert.match(comment, new RegExp(`\\b${mode}\\b`), `the comment names the "${mode}" mode`);
    assert.doesNotMatch(comment, new RegExp(`no ${mode} mode exists`, "i"), `the comment does not deny the "${mode}" mode`);
  }
});
