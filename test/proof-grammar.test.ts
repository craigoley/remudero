import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCEPTANCE_PROOF_GRAMMAR } from "../src/lib/proof-grammar.js";
import { triagePrompt } from "../src/lib/triage.js";
import { planArchitectPrompt, type PlanMode } from "../src/lib/plan-architect.js";
import { parseWhitelistedProof } from "../src/lib/review.js";
import { breMetacharsIn, lintTask } from "../src/lib/task-linter.js";
import type { FeedbackEntry } from "../src/lib/feedback.js";
import type { Task } from "../src/lib/plan.js";

// ── WHAT THIS SUITE DOES AND DOES NOT PROVE. Read this before adding to it.
//
// A PROMPT'S EFFECTIVENESS IS NOT UNIT-TESTABLE. Whether a worker actually complies with these
// lines can only be measured by spawning one ($1.48 a fire, up to four a day), and nothing here
// simulates a worker. What IS mechanically checkable is the thing that failed on PR #1102: not
// that the prompt says something, but that WHAT IT SAYS IS TRUE OF THE REAL GATE.
//
// So this suite deliberately does NOT assert that a given sentence appears. A wording assertion
// pins the phrasing, breaks on the next legitimate reword, and proves nothing about the gate — the
// prompt could tell workers something confidently wrong and still pass. Instead:
//
//   (1) INSTANTIATE the grammar's own two forms the way a worker would, and require the REAL
//       parser to accept them — the same function review.ts runs at review time.
//   (2) Feed those instantiated proofs to the REAL linter as a task, and require ZERO BLOCKING
//       violations — i.e. "a worker who follows this text files something CI will not refuse."
//       This is the assertion that would have caught the W1-T286 incident.
//   (3) Require both filing prompts to actually CARRY the text, which is what makes (1) and (2)
//       relevant to a live fire rather than to a string nobody reads.
//
// (3) is the only part that a revert of the wiring trips; (1) and (2) are properties of the
// grammar itself and survive any rewording that stays true.

/** The placeholders the grammar's two forms use, filled the way a worker filling them would. */
const PLACEHOLDERS: ReadonlyArray<[string, string]> = [
  ["<name>", "fs-safe"],
  ["<pattern>", "readFileIfExists("],
  ["<path>", "src/lib/fs-safe.ts"],
];

/** The FeedbackEntry shape `triagePrompt` reads — mirrors test/triage.test.ts's own fixture. */
const ENTRY: FeedbackEntry = {
  id: "fb-1700000000000-abc123",
  ts: "2026-07-19T00:00:00.000Z",
  raw: "can we get a --dry-run flag on rmd triage",
  attachments: [],
  origin: "cli",
  status: "new",
  proposal_pr: null,
};

function instantiate(template: string): string {
  return PLACEHOLDERS.reduce((acc, [from, to]) => acc.split(from).join(to), template);
}

/**
 * Every proof form the grammar shows, lifted OUT OF THE PROMPT TEXT ITSELF rather than
 * re-declared here — so a rewrite of the text is checked, and a stale copy cannot pass while the
 * real text drifts.
 */
function proofFormsInGrammar(): string[] {
  const forms: string[] = [];
  for (const line of ACCEPTANCE_PROOF_GRAMMAR) {
    const m = /proof:\s*"((?:unit test|grep):[^"]+)"/.exec(line);
    if (m) forms.push(m[1]);
  }
  return forms;
}

test("every proof form the grammar shows parses under the real parseWhitelistedProof", () => {
  const forms = proofFormsInGrammar();
  // Guard against a vacuous pass: if a reword drops the quoted forms, this suite must fail rather
  // than silently verify an empty list.
  assert.equal(forms.length, 2, `expected the grammar to show both proof forms, found ${forms.length}`);

  for (const form of forms) {
    const filled = instantiate(form);
    const parsed = parseWhitelistedProof(filled);
    assert.ok(parsed, `the grammar teaches a proof the real parser REFUSES: "${filled}"`);
    if (parsed.kind === "grep") {
      const pattern = parsed.label.slice(0, parsed.label.lastIndexOf(" in "));
      const { blocking } = breMetacharsIn(pattern);
      assert.deepEqual(blocking, [], `the grammar's grep pattern carries blocking BRE metacharacters: "${pattern}"`);
    }
  }
});

test("a task whose proofs follow the grammar lints with ZERO blocking violations", () => {
  // The shape W1-T286 was filed in — verify:auto, a real acceptance list — but with proofs written
  // the way this prompt teaches. W1-T286's own version produced SIX blocking violations here.
  const task = {
    id: "W1-T999",
    title: "a task filed by a worker that followed the acceptance-proof grammar",
    repo: "remudero",
    verify: "auto",
    risk: "medium",
    // One subsystem, and an `origin:` — otherwise `sizing`/`provenance` fire on the FIXTURE and
    // mask the thing under test. Everything else about the task is deliberately ordinary.
    files: ["src/lib/fs-safe.ts", "test/fs-safe.test.ts"],
    origin: "feedback#fb-1700000000000-abc123",
    acceptance: proofFormsInGrammar().map((form, i) => ({
      claim: `criterion ${i + 1} written the way the grammar teaches`,
      proof: instantiate(form),
    })),
  } as unknown as Task;

  const result = lintTask(task);
  const blocking = result.violations.filter((v) => v.severity === "block");
  assert.deepEqual(
    blocking.map((v) => `${v.check}: ${v.message.slice(0, 90)}`),
    [],
    "a worker following this prompt must produce a task CI will not refuse",
  );
  assert.equal(result.ok, true);
});

test("both filing prompts carry the acceptance-proof grammar verbatim", () => {
  const prompts: Array<[string, string]> = [
    ["triagePrompt", triagePrompt(ENTRY, "run-1", "W1-T999")],
    ...(["create", "clarify", "expand"] as PlanMode[]).map(
      (mode) => [`planArchitectPrompt --mode=${mode}`, planArchitectPrompt(mode, "a brief", "run-1")] as [string, string],
    ),
  ];

  for (const [label, prompt] of prompts) {
    for (const line of ACCEPTANCE_PROOF_GRAMMAR) {
      assert.ok(
        prompt.includes(line),
        `${label} does not carry the acceptance-proof grammar — missing line: ${line.trim().slice(0, 70)}`,
      );
    }
  }
});

test("the triage prompt no longer points at the W1-T278 exemplar for proofs", () => {
  // The exemplar is legitimate for STRUCTURE and stays. What broke was the AXIS: "matching
  // <file>" was read as covering shape only, so proofs were written in natural prose. The prompt
  // must therefore name the exemplar AND still state the grammar, not lean on the exemplar alone.
  const prompt = triagePrompt(ENTRY, "run-1", "W1-T999");
  assert.ok(prompt.includes("W1-T278"), "the structural exemplar should still be named");
  assert.ok(
    /unit test:/.test(prompt) && /grep:/.test(prompt),
    "the prompt must state the dialect outright, not delegate it to the exemplar",
  );
});
