// @source-text-subject: the third test pins that the fallback is prompt text only — no run-task.ts call site, one REST-write builder.
/**
 * W1-T4268 — a worker's own `gh pr edit` can fail on the Projects-Classic GraphQL query; the shared
 * PR-authoring contract (implement + fix) names that signature and the `gh api -X PATCH` substitute.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GH_PR_EDIT_FALLBACK_LINES, outputContractLines } from "../src/lib/compaction.js";

const FALLBACK = GH_PR_EDIT_FALLBACK_LINES.join("\n");

async function fixPrompt(): Promise<string> {
  const { renderFixPrompt } = await import("../src/run-task.js");
  return renderFixPrompt({
    task: { id: "W1-T1", title: "t", acceptance: [] } as never,
    branch: "run-W1-T1-1",
    mode: "review",
    evidence: {} as never,
  } as never);
}

test("W1-T4268: the contract names the projectCards failure signature as a transport failure, never a rejected or applied edit", () => {
  assert.match(FALLBACK, /Projects \(classic\)/);
  assert.match(FALLBACK, /repository\.pullRequest\.projectCards/);
  assert.match(FALLBACK, /TRANSPORT failure/);
  assert.match(FALLBACK, /never\s+evidence the edit was rejected or already applied/);
  assert.match(FALLBACK, /gh api -X PATCH repos\/\{owner\}\/\{repo\}\/pulls\/\{number\} -f body=/);
  assert.match(FALLBACK, /`-f`, NEVER `-F`/);
});

test("W1-T4268: the fallback lines render byte-identical across the implement and fix contracts", async () => {
  const implement = outputContractLines("W1-T1").join("\n");
  const fix = await fixPrompt();
  assert.ok(implement.includes(FALLBACK), "the implement contract carries the fallback verbatim");
  assert.ok(fix.includes(FALLBACK), "the fix contract carries the SAME fallback verbatim");
});

test("W1-T4268: the task adds no run-task call site and no second REST-write implementation", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const runTask = read("src/run-task.ts");
  assert.ok(!runTask.includes("GH_PR_EDIT_FALLBACK_LINES"), "run-task.ts does not reference the prompt constant");
  assert.equal((runTask.match(/export function prBodyRestArgs/g) ?? []).length, 1, "one REST-write builder");
  const render = read("src/lib/prompt-render.ts");
  assert.ok((render.match(/GH_PR_EDIT_FALLBACK_LINES/g) ?? []).length >= 2, "prompt-render imports and splices the single constant");
  assert.ok(!/GH_PR_EDIT_FALLBACK_LINES\s*[:=]/.test(render), "prompt-render carries no copy of the wording");
});
