/**
 * test/an-inbox-draft-is-linted-with-the-plan-pr-preflights-options.test.ts — W1-T14310.
 *
 * OBSERVED 2026-11-22: drafts the inbox marked lint-clean were refused at the plan PR preflight's lint-plan pass on
 * design-invariant-proof. That rule runs only when LintOpts.requireDesignInvariantDeclaration is set; the preflight
 * sets it for a task its diff adds, re-authors or that already declares, and the inbox self-lint did not.
 * The preflight side is rebuilt here from the SAME exported predicates run-task.ts's lintPlanCommand reads
 * (designContractChanged, declaresDesignInvariant, proofSelfPath "block"): no test importer of src/run-task.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blockingLintMessages,
  filingBlockers,
  inboxDraftExampleFragmentYaml,
  inboxDraftPrompt,
  inboxDraftRelintPrompt,
  lintDraftedFragment,
  type Proposal,
} from "#src/lib/inbox.js";
import { loadPlanFromYaml, parseTasksFromYaml, type Plan } from "#src/lib/plan.js";
import { declaresDesignInvariant, designContractChanged, lintTask } from "#src/lib/task-linter.js";

const KNOWN = new Set(["remudero"]);
const yes = (): boolean => true;
const PROPOSAL: Proposal = { id: "P-14310", summary: "tighten a guard", evidenceAnchors: [] };

interface Shape { type?: string; design?: string | null; extraClaims?: string[]; verify?: string }

/** An inbox-draft-shaped fragment: the shape of the prompt's own example with the design and claims varied. */
function fragment(shape: Shape = {}): string {
  const lines = [
    "- id: NEW-1",
    '  title: "Tighten the empty-input guard in parseTasksFromYaml"',
    "  repo: remudero",
    "  depends_on: []",
    `  type: ${shape.type ?? "implement"}`,
    `  verify: ${shape.verify ?? "auto"}`,
    "  risk: medium",
    "  status: queued",
    "  attempts: 0",
    "  files:",
    "    - src/lib/plan.ts",
  ];
  if (shape.design !== null && shape.design !== undefined) lines.push("  design: |", ...shape.design.split("\n").map((l) => `    ${l}`));
  lines.push(
    "  acceptance:",
    '    - claim: "parseTasksFromYaml rejects an empty input instead of throwing a TypeError"',
    '      proof: "unit test: parseTasksFromYaml rejects an empty input instead of throwing a TypeError"',
    ...(shape.extraClaims ?? []),
    '  origin: "architect"',
  );
  return lines.join("\n");
}

const INVARIANT_DESIGN = "INVARIANT a-valid-input-parses-as-before: every non-empty input parses as before.";
const INVARIANT_CLAIM = [
  '    - claim: "invariant:a-valid-input-parses-as-before — every non-empty input parses as before"',
  '      proof: "unit test: parseTasksFromYaml parses a non-empty input to the same tasks"',
];
const NO_INVARIANTS_DESIGN = "NO-INVARIANTS: only a new guard on the empty input is added; no prior behaviour changes.";

const planOf = (yaml: string): Plan => {
  const tasks = parseTasksFromYaml(yaml, "fixture");
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
};
const EMPTY_BASE: Plan = loadPlanFromYaml("[]", "fixture");

/** What the plan PR preflight blocks on for a task its diff ADDS: lint-plan's own option set for that case. */
function preflightChecks(yaml: string): string[] {
  const out: string[] = [];
  for (const task of parseTasksFromYaml(yaml, "fixture")) {
    const lint = lintTask(task, {
      proofSelfPath: "block", moduleExists: yes, knownRepos: KNOWN,
      requireDesignInvariantDeclaration: designContractChanged(undefined, task) || declaresDesignInvariant(task),
    });
    out.push(...filingBlockers(lint.violations, undefined, true).map((v) => v.check));
  }
  return out.sort();
}

/** The draft self-lint the redraft ladder runs, less the checks only a draft has (`draft-*`). */
function selfLintChecks(yaml: string): string[] {
  return lintDraftedFragment(yaml, "P-14310", undefined, KNOWN, yes, () => undefined, () => false, yes)
    .filter((v) => v.severity === "block" && !v.check.startsWith("draft-")).map((v) => v.check).sort();
}

const readinessMessages = (yaml: string): string[] => blockingLintMessages(EMPTY_BASE, planOf(yaml));

test("W1-T14310 criterion 1: a drafted implement fragment declaring neither form is not lint-clean and redrafts with design-invariant-proof in hand", () => {
  const bare = fragment();
  const violations = lintDraftedFragment(bare, "P-14310", undefined, KNOWN, yes, () => undefined, () => false, yes);
  const refused = violations.filter((v) => v.check === "design-invariant-proof");
  assert.equal(refused.length, 1, JSON.stringify(violations));
  assert.match(refused[0]!.message, /declares neither `INVARIANT <slug>: <statement>` nor `NO-INVARIANTS: <reason>`/);
  // The existing relint ladder carries the message into the redraft prompt.
  assert.ok(inboxDraftRelintPrompt(PROPOSAL, bare, violations).includes("design-invariant-proof") ||
    inboxDraftRelintPrompt(PROPOSAL, bare, violations).includes(refused[0]!.message));
  // The readiness check the console classifies by reads the same verdict.
  assert.ok(readinessMessages(bare).some((m) => m.startsWith("NEW-1: [design-invariant-proof]")), JSON.stringify(readinessMessages(bare)));
  // ...and it is exactly the check the preflight refuses on.
  assert.deepEqual(preflightChecks(bare), ["design-invariant-proof"]);
});

test("W1-T14310 criterion 2: the inbox self-lint and the preflight's changed-task lint agree on every census fragment", () => {
  const census: Record<string, string> = {
    "the prompt's own example": inboxDraftExampleFragmentYaml(),
    "implement, no declaration": fragment(),
    "implement, INVARIANT with its claim": fragment({ design: INVARIANT_DESIGN, extraClaims: INVARIANT_CLAIM }),
    "implement, INVARIANT without its claim": fragment({ design: INVARIANT_DESIGN }),
    "implement, NO-INVARIANTS": fragment({ design: NO_INVARIANTS_DESIGN }),
    "recon, no declaration": fragment({ type: "recon" }),
  };
  assert.equal(Object.keys(census).length, 6, "the census must not shrink to nothing");
  let blocked = 0;
  for (const [name, yaml] of Object.entries(census)) {
    const preflight = preflightChecks(yaml);
    assert.deepEqual(selfLintChecks(yaml), preflight, `self-lint disagrees with the preflight on: ${name}`);
    assert.deepEqual(readinessMessages(yaml).map((m) => /\[([^\]]+)\]/.exec(m)?.[1]).filter((c) => c !== undefined && !c.startsWith("draft-")).sort(),
      preflight, `readiness lint disagrees with the preflight on: ${name}`);
    if (preflight.length > 0) blocked++;
  }
  assert.equal(blocked, 2, "exactly the undeclared and the unmapped implement drafts block");
});

test("W1-T14310 criterion 3: the worked example declares an invariant, maps its claim, and lints clean as a changed task", () => {
  const example = inboxDraftExampleFragmentYaml();
  assert.equal(example.match(/^\s*INVARIANT [a-z0-9-]+:/gm)?.length, 1, "exactly one INVARIANT line");
  assert.match(example, /invariant:[a-z0-9-]+ — /);
  const [task] = parseTasksFromYaml(example, "example");
  assert.ok(declaresDesignInvariant(task!));
  assert.deepEqual(preflightChecks(example), []);
  assert.deepEqual(selfLintChecks(example), []);
  assert.deepEqual(lintDraftedFragment(example, "P-EXAMPLE", undefined, KNOWN, yes, () => undefined, () => false, yes), []);
});

test("W1-T14310 criterion 4: invariant:a-preflight-clean-draft-lints-as-today — a preflight-clean fragment is judged as before, the prompt differs only by the example", () => {
  const cleans = [
    fragment({ design: INVARIANT_DESIGN, extraClaims: INVARIANT_CLAIM }),
    fragment({ design: NO_INVARIANTS_DESIGN }),
    fragment({ type: "recon" }),
  ];
  for (const yaml of cleans) {
    assert.deepEqual(preflightChecks(yaml), []);
    assert.deepEqual(lintDraftedFragment(yaml, "P-14310", undefined, KNOWN, yes, () => undefined, () => false, yes), []);
    assert.deepEqual(readinessMessages(yaml), []);
  }
  // A task already on the base plan, unchanged and declaring nothing, is not asked for a declaration by the preflight,
  // so the readiness check must not ask it either.
  const bare = fragment();
  const shadowing = blockingLintMessages(planOf(bare.replace("NEW-1", "W1-T1")), planOf(bare.replace("NEW-1", "W1-T1")));
  assert.deepEqual(shadowing.filter((m) => m.includes("design-invariant-proof")), []);
  // The prompt: everything but the example is untouched, and the example is still printed verbatim.
  const prompt = inboxDraftPrompt(PROPOSAL, "- id: W1-T1\n", "run-1");
  const example = inboxDraftExampleFragmentYaml();
  assert.ok(prompt.includes(example));
  assert.equal(prompt.replace(example, "").includes("INVARIANT"), false, "no prompt text beyond the example changed");
});
