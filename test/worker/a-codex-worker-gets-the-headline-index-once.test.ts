import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "#src/lib/plan.js";
import { renderImplementPromptWithParts, ruleHeadlinesEnabledForProvider } from "#src/lib/prompt-render.js";

const task: Task = {
  id: "W1-T13768-FIXTURE", title: "implement a fixture", repo: "remudero", depends_on: [],
  type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0,
  files: ["src/x.ts"],
  acceptance: [{ claim: "a claim", proof: "unit test: a claim" }],
};
/** Stands in for the built headline index: "" when disabled, as the real builder returns. (Importing the real
 *  builder from src/run-task.ts would add this suite to the affected-suite reach ceiling.) */
const HEADLINE_PART = "- CLAUDE.md's rule headlines (progressive disclosure) — headlines only\n    Always keep the fixture headline first.";
const buildPart = (enabled: boolean) => (enabled ? HEADLINE_PART : "");

/** The same steps the dispatch makes: gate on the mount's provider, build the part, render. */
function render(provider: string | undefined) {
  const enabled = ruleHeadlinesEnabledForProvider(true, provider);
  return renderImplementPromptWithParts(task, "", "RUN", "", "", buildPart(enabled));
}
const headlines = (r: ReturnType<typeof render>) => r.parts.find((p) => p.name === "rule_headlines")?.value ?? "";

test("W1-T13768 criterion 1: a Codex-routed prompt carries no rule_headlines part", () => {
  const { prompt, parts } = render("codex");
  assert.equal(headlines({ prompt, parts }), "");
  assert.equal(prompt.includes("rule headlines"), false);
});

test("W1-T13768 criterion 2: a Claude-routed prompt keeps the rule_headlines part, byte-identical", () => {
  const claude = render("claude");
  assert.match(headlines(claude), /rule headlines/);
  assert.ok(claude.prompt.includes(headlines(claude)));
  const unpinned = render(undefined);
  assert.equal(unpinned.prompt, claude.prompt);
  const ungated = renderImplementPromptWithParts(task, "", "RUN", "", "", buildPart(true));
  assert.equal(claude.prompt, ungated.prompt);
  assert.equal(ruleHeadlinesEnabledForProvider(false, "claude"), false);
});
