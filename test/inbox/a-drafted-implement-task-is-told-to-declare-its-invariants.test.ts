/**
 * The most common first-attempt draft lint failure (221 of 1,348 relint messages, 2026-11-23..27) was
 * `design-invariant-proof`: a drafted implement task whose design declares neither `INVARIANT <slug>: <statement>`
 * nor `NO-INVARIANTS: <reason>`. The draft prompt's OUTPUT rules never stated the requirement, only the worked
 * example showed one INVARIANT line, and the PREFERRED JSON schema had no `design` field at all. These tests pin the
 * rule to the linter's own wording, so the prompt cannot drift from what invariantSlugViolations parses.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INBOX_DRAFT_FRAGMENT_SCHEMA,
  inboxDraftExampleFragmentYaml,
  inboxDraftPrompt,
  lintDraftedFragment,
  validateDraftFragmentData,
  type Proposal,
} from "#src/lib/inbox.js";
import { parseTasksFromYaml, type Task } from "#src/lib/plan.js";
import { INVARIANT_CLAIM_RE, INVARIANT_DECL_RE, NO_INVARIANTS_RE, invariantSlugViolations } from "#src/lib/task-linter.js";

const PROPOSAL = { id: "P-invariants", summary: "a proposal", reframeHistory: [] } as unknown as Proposal;

function outputSection(prompt: string): string {
  const start = prompt.indexOf("=== OUTPUT");
  const end = prompt.indexOf("=== EXAMPLE FRAGMENT START");
  assert.ok(start >= 0 && end > start, "the prompt keeps its OUTPUT section ahead of the worked example");
  return prompt.slice(start, end);
}

/** The forms the linter itself names when a design declares neither, read from its own refusal message. */
function linterForms(): string[] {
  const [example] = parseTasksFromYaml(inboxDraftExampleFragmentYaml(), "invariant forms fixture");
  const bare: Task = { ...example!, id: "NEW-1", design: "" };
  const [violation] = invariantSlugViolations(bare, { requireDesignInvariantDeclaration: true });
  assert.ok(violation, "a design with no declaration is refused");
  const forms = [...violation.message.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  assert.deepEqual(forms, ["INVARIANT <slug>: <statement>", "NO-INVARIANTS: <reason>"]);
  return forms;
}

test("the draft prompt's OUTPUT rules state the design-invariant rule in the linter's own format", () => {
  const output = outputSection(inboxDraftPrompt(PROPOSAL, "- id: W1-T1\n", "run-1"));
  for (const form of linterForms()) assert.ok(output.includes(`\`${form}\``), `OUTPUT rules quote \`${form}\` verbatim`);
  assert.ok(output.includes("`invariant:<slug>`"), "OUTPUT rules name the acceptance claim shape");
  assert.match(output, /`type: implement` task's design: MUST hold/, "the rule is a requirement on implement tasks, not a hint");
  // The templates, filled in as the prompt says, are exactly what the linter's regexes accept.
  assert.match("INVARIANT a-valid-input-parses: every input parses as before", INVARIANT_DECL_RE);
  assert.match("NO-INVARIANTS: this task adds a new command only", NO_INVARIANTS_RE);
  assert.equal(INVARIANT_CLAIM_RE.exec("invariant:a-valid-input-parses — it parses as before")?.[1], "a-valid-input-parses");
});

test("the draft prompt's worked example still lints clean under the design-invariant check", () => {
  const yaml = inboxDraftExampleFragmentYaml();
  assert.deepEqual(lintDraftedFragment(yaml, "P-invariants"), []);
  const [example] = parseTasksFromYaml(yaml, "worked example");
  assert.deepEqual(invariantSlugViolations(example!, { requireDesignInvariantDeclaration: true }), []);
});

test("the structured draft schema requires a design of an implement task and of no other type", () => {
  const items = INBOX_DRAFT_FRAGMENT_SCHEMA.items as unknown as Record<string, unknown>;
  assert.deepEqual(items["then"], { required: ["design"] });
  assert.deepEqual(items["if"], { properties: { type: { const: "implement" } } });
  const task = (over: Record<string, unknown>) => ({ id: "NEW-1", title: "t", repo: "remudero", depends_on: [], verify: "auto",
    risk: "low", status: "queued", attempts: 0, files: ["src/lib/plan.ts"], acceptance: [{ claim: "c", proof: "p" }],
    origin: "architect", ...over });
  assert.deepEqual(validateDraftFragmentData([task({ type: "implement" })]),
    ["task[0].design must be a non-empty string for an implement task"]);
  assert.deepEqual(validateDraftFragmentData([task({ type: "implement", design: "NO-INVARIANTS: adds a command" })]), []);
  assert.deepEqual(validateDraftFragmentData([task({ type: "recon" })]), []);
});
