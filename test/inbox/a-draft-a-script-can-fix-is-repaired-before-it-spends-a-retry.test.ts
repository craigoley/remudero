import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  inboxDraftExampleFragmentYaml,
  lintDraftedFragment,
  lintDraftedFragmentWithRepair,
  relintRatificationFragment,
  runDraftRung,
  type Proposal,
} from "#src/lib/inbox.js";
import { DRAFT_AUTOFIX_OFF_FILE, draftAutofixOff, repairDraftedFragment, titleWithoutOwnId, type DraftRepairFacts } from "#src/lib/draft-repair.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// The draft rung spent a model retry on every lint failure, including the ones whose remedy the lint message itself
// computes. Measured 2026-11-23..27: 912 draft attempts for 359 proposals, 460 relint rows. These pin the repairs that
// run before a retry, and that a draft the repair cannot fix still retries exactly as before.

const STAMP = "- P9 (tighten the guard) — RATIFIED 2026-01-01 -> NEW-1.";
const BASE = inboxDraftExampleFragmentYaml();
const SLUG_TEST = "test/plan/tighten-the-empty-input-guard-in-parsetasksfromyaml.test.ts";
const facts: DraftRepairFacts = {
  pathExists: (path) => path === "src/lib/plan.ts" || path === "DECISIONS.md" || path === ".github/workflows/ci.yml",
  expectedTestPath: (title) => `test/plan/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.test.ts`,
};
const withFile = (yaml: string, path: string): string => yaml.replace("    - src/lib/plan.ts", `    - src/lib/plan.ts\n    - ${path}`);
const task = (yaml: string): Record<string, unknown> => (parseYaml(yaml) as Record<string, unknown>[])[0];
const checks = (...ids: string[]) => ids.map((check) => ({ check }));

test("repairDraftedFragment strips a draft's own NEW-n placeholder from its title", () => {
  const dirty = BASE.replace('title: "Tighten the empty-input guard in parseTasksFromYaml"', 'title: "NEW-1: Tighten the empty-input guard (NEW-1) in parseTasksFromYaml"');
  assert.deepEqual(lintDraftedFragment(dirty, "P9", STAMP).map((v) => v.check), ["draft-placeholder-title"], "fixture: only the title is dirty");
  const fixed = repairDraftedFragment(dirty, checks("draft-placeholder-title"), facts);
  assert.deepEqual(fixed.repaired, ["title:NEW-1"]);
  assert.equal(task(fixed.fragmentYaml).title, "Tighten the empty-input guard in parseTasksFromYaml");
  assert.deepEqual(lintDraftedFragment(fixed.fragmentYaml, "P9", STAMP), []);
  assert.equal(titleWithoutOwnId("W1-T7 follow-up for W1-T8", "W1-T7"), "follow-up for W1-T8", "another task's real id stays");
  assert.equal(titleWithoutOwnId("NEW-2", "NEW-2"), undefined, "a title that is only a placeholder is no repair");
});

test("repairDraftedFragment renames a misnamed new test to the slug-named path in files, design and criteria", () => {
  const dirty = withFile(BASE, "test/plan/empty-input-guard.test.ts")
    .replace("  design: |\n", "  design: |\n    The new test/plan/empty-input-guard.test.ts pins the guard.\n")
    .replace('"invariant:a-valid-input-parses-as-before — every', '"invariant:a-valid-input-parses-as-before — test/plan/empty-input-guard.test.ts shows every');
  assert.ok(lintDraftedFragment(dirty, "P9", STAMP).some((v) => v.check === "draft-path-missing"), "fixture: the path is missing");
  const fixed = repairDraftedFragment(dirty, checks("draft-path-missing"), facts);
  assert.deepEqual(fixed.repaired, ["test-path:NEW-1"]);
  const repaired = task(fixed.fragmentYaml);
  assert.deepEqual(repaired.files, ["src/lib/plan.ts", SLUG_TEST]);
  assert.match(String(repaired.design), new RegExp(`The new ${SLUG_TEST} pins`));
  assert.ok(!fixed.fragmentYaml.includes("empty-input-guard.test.ts"), "no criterion keeps the old path");
  assert.deepEqual(lintDraftedFragment(fixed.fragmentYaml, "P9", STAMP), []);
  const twice = withFile(withFile(BASE, "test/a.test.ts"), "test/b.test.ts");
  assert.deepEqual(repairDraftedFragment(twice, checks("draft-path-missing"), facts).repaired, [], "two candidates is no repair");
});

test("repairDraftedFragment moves an unplaced new test, its CREATES line included, into its computed folder", () => {
  const dirty = withFile(BASE, "test/empty-input-guard.test.ts").replace("  design: |\n", "  design: |\n    CREATES: test/empty-input-guard.test.ts\n");
  assert.ok(lintDraftedFragment(dirty, "P9", STAMP).some((v) => v.check === "draft-test-unplaced"), "fixture: the test is unplaced");
  const fixed = repairDraftedFragment(dirty, checks("draft-test-unplaced"), facts);
  assert.deepEqual(fixed.repaired, ["test-path:NEW-1"]);
  assert.match(String(task(fixed.fragmentYaml).design), new RegExp(`^CREATES: ${SLUG_TEST}$`, "m"));
  assert.deepEqual(lintDraftedFragment(fixed.fragmentYaml, "P9", STAMP), []);
});

test("repairDraftedFragment moves the slug-named test with a title it repairs", () => {
  const dirty = withFile(BASE.replace('title: "Tighten', 'title: "NEW-1 Tighten'), "test/plan/new-1-tighten-the-empty-input-guard-in-parsetasksfromyaml.test.ts");
  const fixed = repairDraftedFragment(dirty, checks("draft-placeholder-title"), facts);
  assert.deepEqual(fixed.repaired, ["title:NEW-1", "test-path:NEW-1"]);
  assert.deepEqual(task(fixed.fragmentYaml).files, ["src/lib/plan.ts", SLUG_TEST]);
});

test("repairDraftedFragment sets a verify outside the enum to auto, or to human for a workflow-path task", () => {
  const dirty = BASE.replace("verify: auto", "verify: manual");
  assert.deepEqual(lintDraftedFragment(dirty, "P9", STAMP).map((v) => v.check), ["shard-shape"], "fixture: only verify is dirty");
  const fixed = repairDraftedFragment(dirty, checks("shard-shape"), facts);
  assert.deepEqual(fixed.repaired, ["verify:NEW-1"]);
  assert.equal(task(fixed.fragmentYaml).verify, "auto", "the draft prompt files every task verify: auto");
  assert.deepEqual(lintDraftedFragment(fixed.fragmentYaml, "P9", STAMP), []);
  const workflow = repairDraftedFragment(withFile(dirty, ".github/workflows/ci.yml"), checks("shard-shape"), facts);
  assert.equal(task(workflow.fragmentYaml).verify, "human", "a workflow-path task is the prompt's one verify: human exception");
});

test("repairDraftedFragment sets verify: human for a ruling or record-editing task only when it declares a workflow path", () => {
  for (const [path, check] of [["DECISIONS.md", "ruling-verify"], ["plan/tasks.yaml", "rule15-filing"]] as const) {
    const dirty = withFile(BASE, path);
    assert.ok(lintDraftedFragment(dirty, "P9", STAMP).some((v) => v.check === check), `fixture: ${path} raises ${check}`);
    assert.deepEqual(repairDraftedFragment(dirty, checks(check), facts).repaired, [],
      "verify: human is itself refused there (draft-human-ask-repeated), and the split the lint asks for is no script's to choose");
    const workflow = repairDraftedFragment(withFile(dirty, ".github/workflows/ci.yml"), checks(check), facts);
    assert.deepEqual(workflow.repaired, ["verify:NEW-1"]);
    assert.equal(task(workflow.fragmentYaml).verify, "human");
  }
});

test("repairDraftedFragment leaves type manual for a redraft, since no mapping to a dispatched type exists", () => {
  const dirty = BASE.replace("type: implement", "type: manual");
  const violations = lintDraftedFragment(dirty, "P9", STAMP);
  assert.deepEqual(violations.map((v) => v.check), ["draft-undispatched-type"]);
  assert.deepEqual(repairDraftedFragment(dirty, violations, facts), { fragmentYaml: dirty, repaired: [] });
});

test("a draft repair makes approve's own repairs too, so approve's pass over a repaired draft changes nothing", () => {
  const dirty = BASE.replace("risk: medium", "risk: high").replace('title: "Tighten', 'title: "NEW-1: Tighten');
  const linted = lintDraftedFragmentWithRepair(dirty, "P9", STAMP);
  assert.deepEqual(linted.repaired, ["title:NEW-1", "approve-repair"]);
  assert.deepEqual(linted.violations, []);
  assert.equal(task(linted.fragmentYaml).band_meaning, "span");
  const approved = relintRatificationFragment(linted.fragmentYaml, "P9");
  assert.ok(approved.ok);
  assert.equal(approved.fragmentYaml, linted.fragmentYaml, "approve repairs a repaired draft to the same bytes");
  assert.deepEqual(lintDraftedFragmentWithRepair(linted.fragmentYaml, "P9", STAMP).repaired, [], "a second pass repairs nothing");
});

function worker(text: string): WorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success", isError: false,
    apiError: false, permissionDenials: [], childEnvKeys: [], model: "gpt-6-luna", routedModel: "gpt-6-luna", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

const proposal: Proposal = { id: "P9", summary: "tighten the guard", evidenceAnchors: [] };
const answer = (fragment: string) => `=== FRAGMENT START ===\n${fragment}\n=== FRAGMENT END ===\nSTAMP: tighten the guard`;

async function draft(fragment: string, draftAutofix?: boolean) {
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let spawns = 0;
  const [outcome] = await runDraftRung([proposal], "- id: W1-T1\n", {
    spawn: async () => { spawns++; return worker(answer(fragment)); },
    ...(draftAutofix === undefined ? {} : { draftAutofix }),
    log: (step, extra) => events.push({ step, extra }),
  }, "run-autofix");
  return { outcome, events, spawns, steps: events.map((e) => e.step) };
}

const FIXABLE = BASE.replace('title: "Tighten', 'title: "NEW-1: Tighten').replace("verify: auto", "verify: manual");

test("a repaired draft caches without a model retry", async () => {
  const { outcome, events, spawns, steps } = await draft(FIXABLE);
  assert.equal(spawns, 1, "the repair, not a redraft, made the draft clean");
  assert.ok(!steps.includes("inbox.draft_relint"));
  assert.deepEqual(events.find((e) => e.step === "inbox.draft_autofixed")?.extra,
    { proposal_id: "P9", attempt: 1, repaired: ["title:NEW-1", "verify:NEW-1"], remaining: 0 });
  assert.equal(events.find((e) => e.step === "inbox.drafted")?.extra?.lint_clean, true);
  assert.ok(outcome.ok);
  const cached = task(outcome.candidate.fragmentYaml);
  assert.equal(cached.title, "Tighten the empty-input guard in parseTasksFromYaml");
  assert.equal(cached.verify, "auto");
  assert.deepEqual(lintDraftedFragment(outcome.candidate.fragmentYaml, "P9", outcome.candidate.stampLine), [], "the cached fragment is the repaired one");
});

test("an unfixable draft violation still retries as before", async () => {
  const { spawns, steps } = await draft(BASE.replace("type: implement", "type: manual"));
  assert.ok(spawns > 1, "a violation no repair computes still spends a redraft");
  assert.ok(steps.includes("inbox.draft_relint"));
  assert.ok(!steps.includes("inbox.draft_autofixed"), "a repair that changed nothing is not logged");
});

test("the draft autofix kill switch lints each draft as the model wrote it", async () => {
  const { outcome, spawns, steps } = await draft(FIXABLE, false);
  assert.ok(spawns > 1, "with the repair off, a fixable violation spends a redraft again");
  assert.ok(steps.includes("inbox.draft_relint"));
  assert.ok(!steps.includes("inbox.draft_autofixed"));
  assert.ok(outcome.ok && /NEW-1: Tighten/.test(outcome.candidate.fragmentYaml), "the model's fragment is cached unrepaired");
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}draft-autofix-off-`));
  try {
    assert.equal(draftAutofixOff(state), false);
    writeFileSync(join(state, DRAFT_AUTOFIX_OFF_FILE), "");
    assert.equal(draftAutofixOff(state), true, "state/DRAFT_AUTOFIX_OFF turns the repair off");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
