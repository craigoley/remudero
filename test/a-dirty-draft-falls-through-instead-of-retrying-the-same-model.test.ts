import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  FRAGMENT_JSON_RE,
  inboxDraftExampleFragmentYaml,
  lintDraftedFragment,
  parseDraftedCandidate,
  renderDraftFragmentYaml,
  runDraftRung,
  validateDraftFragmentData,
  MAX_DRAFT_LINT_ATTEMPTS,
} from "../src/lib/inbox.js";
import type { DraftSpawnContext, Proposal } from "../src/lib/inbox.js";
import { parseTasksFromYaml } from "../src/lib/plan.js";
import type { WorkerResult } from "../src/lib/worker.js";

// ── W1-T4864: a lint-dirty inbox draft walks to the next ladder model ─────────────────────────────
//
// MEASURED (docs/recon/openweight-inbox-draft-trial.md, W1-T3570): gpt-5-nano spent 3,311 syntheses for 200 terminal
// drafts because every relint re-rolled the SAME model. The spawn is injected, so the ladder here is a fake that
// honours `avoidModels` exactly as a real ladder-resolving spawn must; the falsifier is a spawn that ignores it.

const proposal = { id: "P9", summary: "a proposal", evidenceAnchors: [] } as unknown as Proposal;
const STAMP = "- P9 (a proposal) — RATIFIED 2026-01-01 -> NEW-1.";

const cleanText = `=== FRAGMENT START ===\n${inboxDraftExampleFragmentYaml()}\n=== FRAGMENT END ===\nSTAMP: ${STAMP}`;
// `acceptance` as a bare string is the exact shape the 2026-09-24 draft-parse failures had.
const dirtyText = `=== FRAGMENT START ===\n- id: NEW-1\n  title: "x"\n  acceptance: not a list\n=== FRAGMENT END ===\nSTAMP: ${STAMP}`;

function worker(model: string, text: string): WorkerResult {
  return {
    sessionId: `S-${model}`, costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model, routedModel: model, effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

test("W1-T4864: a dirty draft falls through to the next ladder model", async () => {
  assert.deepEqual(lintDraftedFragment(inboxDraftExampleFragmentYaml(), "P9", STAMP), [], "fixture: the clean draft must lint clean");
  assert.notEqual(lintDraftedFragment("- id: NEW-1\n  acceptance: not a list", "P9", STAMP).length, 0, "fixture: the dirty draft must lint dirty");

  const ladder = ["gpt-5-nano", "gpt-6-luna", "claude-sonnet-5-5"];
  const tried: string[] = [];
  const seen: DraftSpawnContext[] = [];
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const spawn = async (_p: Proposal, _prompt: string, ctx?: DraftSpawnContext): Promise<WorkerResult> => {
    seen.push(ctx!);
    const model = ladder.find((m) => !(ctx?.avoidModels ?? []).includes(m))!;
    tried.push(model);
    // the lead model is the one that cannot format; the next rung drafts cleanly
    return worker(model, model === "gpt-5-nano" ? dirtyText : cleanText);
  };

  const [outcome] = await runDraftRung([proposal], "- id: W1-T1\n", { spawn, log: (step, extra) => events.push({ step, extra }) }, "run-1");

  assert.deepEqual(tried, ["gpt-5-nano", "gpt-6-luna"], "the redraft must leave the model that produced the dirty draft");
  assert.deepEqual(seen.map((c) => c.avoidModels), [[], ["gpt-5-nano"]]);
  assert.deepEqual(seen.map((c) => c.attempt), [1, 2]);
  const fell = events.filter((e) => e.step === "inbox.draft_fellthrough");
  assert.equal(fell.length, 1);
  assert.equal(fell[0].extra?.from, "gpt-5-nano");
  assert.equal(fell[0].extra?.to, "gpt-6-luna");
  assert.ok(Array.isArray(fell[0].extra?.violations) && (fell[0].extra?.violations as unknown[]).length > 0, "the fall-through names the violations that caused it");
  assert.equal(outcome.ok, true);
  assert.equal(events.find((e) => e.step === "inbox.drafted")?.extra?.lint_clean, true);
});

test("W1-T4864: a clean first draft records no fall-through, and a same-model retry is visible as from === to", async () => {
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  await runDraftRung([proposal], "- id: W1-T1\n", { spawn: async () => worker("gpt-6-luna", cleanText), log: (step, extra) => events.push({ step, extra }) }, "run-2");
  assert.equal(events.filter((e) => e.step === "inbox.draft_fellthrough").length, 0);

  // FALSIFIER: a spawn that ignores avoidModels retries the same model — the record must show it, bounded by the attempts.
  const stuck: typeof events = [];
  await runDraftRung([proposal], "- id: W1-T1\n", { spawn: async () => worker("gpt-5-nano", dirtyText), log: (step, extra) => stuck.push({ step, extra }) }, "run-3");
  const fell = stuck.filter((e) => e.step === "inbox.draft_fellthrough");
  assert.equal(fell.length, MAX_DRAFT_LINT_ATTEMPTS - 1);
  assert.ok(fell.every((e) => e.extra?.from === e.extra?.to));
});

// ── the draft as schema-checked data ─────────────────────────────────────────────────────────────

const HOSTILE = [
  'proof: "quoted: colon" and # hash',
  "- leading dash",
  "multi\nline\ttext",
  "yes",
  "null",
  "0x1F",
  "1e3",
  "{not: a map}",
  "[not, a, list]",
  "&anchor *alias !tag",
  "trailing colon:",
  "ünïcödé ✓ 日本語",
  "  padded  ",
  "'single' \"double\" `tick`",
  "grep: symbol in src/file.ts",
  "a".repeat(400),
];

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "NEW-1",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    files: ["src/lib/widget.ts"],
    acceptance: [{ claim: "c", proof: "p" }],
    origin: "architect",
    ...over,
  };
}

test("W1-T4864: a schema-valid draft always renders to parseable YAML", () => {
  for (const value of HOSTILE) {
    const data = [task({ title: value, origin: value, acceptance: [{ claim: value, proof: value }], files: [value.trim() || "x"] })];
    assert.deepEqual(validateDraftFragmentData(data), [], `fixture must be schema-valid: ${JSON.stringify(value)}`);
    const yaml = renderDraftFragmentYaml(data);
    assert.deepEqual(parseYaml(yaml), data, `round-trips through YAML: ${JSON.stringify(value)}`);
    const tasks = parseTasksFromYaml(yaml, "test"); // the plan's own parser accepts it, whatever the strings hold
    assert.equal(tasks[0].id, "NEW-1");
  }

  // …and end to end: a structured block in worker output becomes the same parseable fragment, next to a STAMP.
  const data = [task({ title: HOSTILE[0], acceptance: [{ claim: HOSTILE[2], proof: HOSTILE[14] }] })];
  const parsed = parseDraftedCandidate(`chatter\n=== FRAGMENT JSON START ===\n${JSON.stringify(data)}\n=== FRAGMENT JSON END ===\nSTAMP: ${STAMP}`);
  assert.ok(parsed);
  assert.deepEqual(parseYaml(parsed.fragmentYaml), data);
  assert.equal(parsed.stampLine, STAMP);

  // data the schema refuses is never rendered: a throw for the renderer, and a lintable fragment for the parser
  assert.throws(() => renderDraftFragmentYaml([task({ type: "bogus" })]), /not schema-valid/);
  assert.notEqual(validateDraftFragmentData([task({ acceptance: "a string" })]).length, 0);
  // an array element that is not a task object is named by index, once each, and never rendered
  assert.deepEqual(validateDraftFragmentData(["a string", null, [1], 7]), [
    "task[0] must be an object",
    "task[1] must be an object",
    "task[2] must be an object",
    "task[3] must be an object",
  ]);
  assert.throws(() => renderDraftFragmentYaml([null]), /task\[0\] must be an object/);
  const bad = parseDraftedCandidate(`=== FRAGMENT JSON START ===\n[{"id": 1}]\n=== FRAGMENT JSON END ===\nSTAMP: ${STAMP}`);
  assert.ok(bad && lintDraftedFragment(bad.fragmentYaml, "P9", bad.stampLine).length > 0);
  const broken = parseDraftedCandidate(`=== FRAGMENT JSON START ===\n[{"id": \n=== FRAGMENT JSON END ===\nSTAMP: ${STAMP}`);
  assert.ok(broken && lintDraftedFragment(broken.fragmentYaml, "P9", broken.stampLine).some((v) => v.check === "draft-parse"));
});

test("W1-T4864: the structured-fragment marker matches a complete block and refuses an unterminated or YAML-marked one", () => {
  assert.equal(FRAGMENT_JSON_RE.test("=== FRAGMENT JSON START ===\n[]\n=== FRAGMENT JSON END ==="), true);
  assert.equal(FRAGMENT_JSON_RE.test("=== FRAGMENT JSON START ===\n[]"), false, "no end marker: not a block");
  assert.equal(FRAGMENT_JSON_RE.test("=== FRAGMENT START ===\n- id: NEW-1\n=== FRAGMENT END ==="), false, "the YAML markers are not the JSON ones");
  assert.equal(parseDraftedCandidate("=== FRAGMENT JSON START ===\n[]\nSTAMP: x"), null, "an unterminated block yields no candidate");
});
