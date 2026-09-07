import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRuleHeadlinesPart, implementPromptParts, renderImplementPrompt } from "../src/run-task.js";
import { renderAnchorBlock } from "../src/lib/compaction.js";
import { assertProvenance } from "../src/lib/provenance.js";
import {
  wipeTestFactorMasksLearnings,
  wipeTestFactorMasksRecon,
  wipeTestFactorMasksRules,
  WIPE_TEST_FACTORS,
} from "../src/lib/wipe-test.js";
import type { Task } from "../src/lib/plan.js";

/**
 * test/the-worker-gets-the-headlines.test.ts — W1-T2761.
 *
 * W1-T2508 shipped `parseRuleHeadlines`/`renderHeadlineOnlyIndex`/`retrieveRuleBodyOrDegrade`
 * with twelve real tests, and its own source said in terms that none of it was wired into
 * `implementPromptParts`/`renderImplementPrompt`. On W1-T2759's corrected premise (a dispatched
 * Claude worker sees NO CLAUDE.md at all — `settingSources: []`), that meant a worker received
 * zero rules, ever. This suite proves the wiring: a policy-gated `rule_headlines` part that is
 * byte-identical-absent by default, carries headlines-never-bodies when the row is on, survives
 * a compaction unchanged (degrading rather than going silent if the source can't be read), and is
 * measurable through a new wipe-test factor.
 */

const FIXTURE_MD = [
  "# Fixture rules",
  "",
  "- **Headline One** body text unique to the first rule, never shown headline-only.",
  "- **Headline Two** body text unique to the second rule, also never shown headline-only.",
  "",
].join("\n");

function readFixture(): string | undefined {
  return FIXTURE_MD;
}

function unreadableSource(): string | undefined {
  return undefined;
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T2761-FIXTURE",
    title: "a fixture task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    acceptance: [{ claim: "a claim", proof: "grep: x in src/lib/x.ts" }],
    ...over,
  } as unknown as Task;
}

// ── acceptance: row absent/off ⇒ byte-identical to today's rendering ───────────────────────────

test("buildRuleHeadlinesPart: enabled=false returns \"\" regardless of the source", () => {
  assert.equal(buildRuleHeadlinesPart(false, "CLAUDE.md", readFixture), "");
  assert.equal(buildRuleHeadlinesPart(false, "CLAUDE.md", unreadableSource), "");
});

test("renderImplementPrompt: an explicit \"\" rule_headlines part renders BYTE-IDENTICAL to the 5-arg call no caller had to change", () => {
  const t = task();
  const withoutArg = renderImplementPrompt(t, "recon text", "RUN-1", "learnings text", "notes text");
  const withExplicitEmpty = renderImplementPrompt(t, "recon text", "RUN-1", "learnings text", "notes text", "");
  const withDisabledBuild = renderImplementPrompt(
    t,
    "recon text",
    "RUN-1",
    "learnings text",
    "notes text",
    buildRuleHeadlinesPart(false, "CLAUDE.md", readFixture),
  );
  assert.equal(withoutArg, withExplicitEmpty);
  assert.equal(withoutArg, withDisabledBuild);
});

test("implementPromptParts: the row off still NAMES rule_headlines (for prompt.manifest), but its value is empty", () => {
  const parts = implementPromptParts(task(), "", "RUN-1");
  const row = parts.find((p) => p.name === "rule_headlines");
  assert.ok(row, "rule_headlines must be a named part even when off");
  assert.equal(row!.value, "");
});

// ── acceptance: row on ⇒ headlines only, in the stable prefix before the volatile tail ──────────

test("buildRuleHeadlinesPart: enabled=true carries every headline and NO body text", () => {
  const part = buildRuleHeadlinesPart(true, "CLAUDE.md", readFixture);
  assert.ok(part.includes("Headline One"), "must carry headline text");
  assert.ok(part.includes("Headline Two"), "must carry headline text");
  assert.equal(part.includes("unique to the first rule"), false, "must NOT carry body text");
  assert.equal(part.includes("unique to the second rule"), false, "must NOT carry body text");
  // The pointer: names where a body is actually read from.
  assert.match(part, /CLAUDE\.md/);
});

test("implementPromptParts: rule_headlines sits DIRECTLY AFTER doctrine — the stable prefix, ahead of every per-task/volatile part", () => {
  const part = buildRuleHeadlinesPart(true, "CLAUDE.md", readFixture);
  const parts = implementPromptParts(task(), "recon text", "RUN-1", "learnings text", "notes text", part);
  const names = parts.map((p) => p.name);
  assert.deepEqual(names, ["doctrine", "rule_headlines", "task_claims", "recon", "operator_notes", "matched_learnings", "task_body"]);
});

test("renderImplementPrompt: with the row on, headlines land BEFORE the task/recon/learnings text, and no body text ever appears", () => {
  const part = buildRuleHeadlinesPart(true, "CLAUDE.md", readFixture);
  const prompt = renderImplementPrompt(task(), "recon text", "RUN-1", "learnings text", "notes text", part);
  assert.ok(prompt.includes("Headline One"));
  const headlineIdx = prompt.indexOf("Headline One");
  const reconIdx = prompt.indexOf("recon text");
  const learningsIdx = prompt.indexOf("learnings text");
  const taskIdx = prompt.indexOf("# TASK");
  assert.ok(headlineIdx < reconIdx, "headline index must precede the recon relay");
  assert.ok(headlineIdx < learningsIdx, "headline index must precede the volatile learnings tail");
  assert.ok(headlineIdx < taskIdx, "headline index must precede # TASK");
  assert.equal(prompt.includes("unique to the first rule"), false, "the rendered prompt must carry no body text");
});

test("renderImplementPrompt: with the row on, the provenance linter still passes clean (every headline line is citeable)", () => {
  const part = buildRuleHeadlinesPart(true, "CLAUDE.md", readFixture);
  const prompt = renderImplementPrompt(task(), "- OBSERVED: a thing [src: recon#W1-T2761-FIXTURE]", "RUN-1", "", "", part);
  assert.doesNotThrow(() => assertProvenance(prompt));
});

// ── acceptance: the anchor repeats the index unchanged, and degrades rather than going silent ──

test("renderAnchorBlock: with no rule_headlines argument, the anchor is unchanged from before this task", () => {
  const t = task();
  const withoutArg = renderAnchorBlock(t, "RUN-1");
  const withExplicitEmpty = renderAnchorBlock(t, "RUN-1", "");
  assert.equal(withoutArg, withExplicitEmpty);
  assert.equal(withoutArg.includes("RULE HEADLINES"), false);
});

test("renderAnchorBlock: repeats the SAME headline index the turn-0 prompt carried, byte-identical", () => {
  const part = buildRuleHeadlinesPart(true, "CLAUDE.md", readFixture);
  const prompt = renderImplementPrompt(task(), "", "RUN-1", "", "", part);
  const anchor = renderAnchorBlock(task(), "RUN-1", part);
  assert.ok(prompt.includes(part));
  assert.ok(anchor.includes(part), "the anchor must repeat the EXACT same string the turn-0 prompt carried");
});

test("buildRuleHeadlinesPart: an unreadable source degrades to the full rule, never to silence", () => {
  const part = buildRuleHeadlinesPart(true, "CLAUDE.md", unreadableSource);
  assert.notEqual(part, "", "an unreadable source must never degrade to silence");
  assert.match(part, /unavailable — could not read rule source CLAUDE\.md/);
});

test("renderAnchorBlock: an unreadable source's degraded text still reaches the re-injected anchor, never silence", () => {
  const part = buildRuleHeadlinesPart(true, "CLAUDE.md", unreadableSource);
  const anchor = renderAnchorBlock(task(), "RUN-1", part);
  assert.ok(anchor.includes("unavailable — could not read rule source CLAUDE.md"));
});

// ── acceptance: a wipe-test pair under the rules factor masks the headline part and NOTHING else ─

test("WIPE_TEST_FACTORS names \"rules\"", () => {
  assert.ok((WIPE_TEST_FACTORS as readonly string[]).includes("rules"));
});

test("wipeTestFactorMasksRules: true only for factor=rules, arm=B — and it masks NOTHING else's mask decision", () => {
  assert.equal(wipeTestFactorMasksRules("rules", "B"), true);
  assert.equal(wipeTestFactorMasksRules("rules", "A"), false);
  assert.equal(wipeTestFactorMasksRules("learnings", "B"), false);
  assert.equal(wipeTestFactorMasksRules("recon", "B"), false);
});

test("a rules-factor pair leaves the learnings/recon mask decisions both false on both arms", () => {
  for (const arm of ["A", "B"] as const) {
    assert.equal(wipeTestFactorMasksLearnings("rules", arm), false);
    assert.equal(wipeTestFactorMasksRecon("rules", arm), false);
  }
});
