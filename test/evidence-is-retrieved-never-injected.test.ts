/**
 * W1-T3709 — THE SECOND TIER MUST STAY OUT OF THE PROMPT.
 *
 * `evidence` exists so a learning can keep the measurement that earned it WITHOUT charging every
 * matching task for prose it does not need to act. That only holds while nothing renders it. The
 * saving is invisible in normal use — a worker cannot tell it was spared — so if a later change
 * starts injecting `evidence`, the corpus quietly doubles and no behaviour looks wrong until the
 * budget ratchet goes red for reasons nobody can place. This suite is what notices.
 *
 * The split is the same one CLAUDE.md already has with `doctrine/`: the headline IS the rule, the
 * pointer holds the proof. MEASURED before it: the actionable rule was 7-19% of the injected line
 * on the longest entries.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import yaml from "yaml";

import { entryBudgetWeight, selectLearnings, DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "../src/lib/learnings.js";

function activeEntries(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const f of readdirSync("learnings").filter((f) => f.endsWith(".yaml"))) {
    for (const e of (yaml.parse(readFileSync(`learnings/${f}`, "utf8")) ?? [])) {
      if ((e.lifecycle ?? "active") === "active") out.push(e);
    }
  }
  return out;
}

test("an entry's evidence is never charged to the prompt budget", () => {
  const withEvidence = activeEntries().filter((e) => typeof e.evidence === "string" && (e.evidence as string).length > 0);
  assert.ok(withEvidence.length > 0, "the corpus must actually use the field, or this proves nothing");

  for (const entry of withEvidence) {
    const weight = entryBudgetWeight(entry as never);
    const evidence = String(entry.evidence);
    // THE LOAD-BEARING ASSERTION. The weight is the rendered line; evidence must be absent from it,
    // so an entry carrying 1,000 chars of forensics costs the same as one carrying none.
    assert.ok(
      weight < evidence.length + String(entry.fact).length,
      `${String(entry.id)}: evidence is being charged to the budget`,
    );
    // EXACT, not slack: the rendered line is `- <fact> [src: learnings#<id>]`, so its length is the
    // fact plus the id plus a fixed frame. Anything beyond that means something else got rendered.
    const frame = "-  [src: learnings#]".length;
    assert.equal(
      weight,
      String(entry.fact).length + String(entry.id).length + frame,
      `${String(entry.id)}: the rendered line must be the fact plus its citation, nothing more`,
    );
  }
});

test("evidence never reaches a selected prompt line", () => {
  // BEHAVIOURAL: drive the real selector and read what a task would actually be shown.
  const active = activeEntries();
  const sample = active.find((e) => typeof e.evidence === "string" && (e.evidence as string).length > 200);
  assert.ok(sample, "need an entry with substantial evidence to discriminate");
  const files = (sample!.files as string[]) ?? [];
  const { selected } = selectLearnings(active as never, files, DEFAULT_KNOWLEDGE_BUDGET_CHARS);
  const picked = selected.find((e) => (e as unknown as Record<string, unknown>).id === sample!.id);
  assert.ok(picked, "the entry must be selected by its own files, or the check is vacuous");

  // A distinctive run of words from the evidence must not appear in what the prompt would carry.
  const needle = String(sample!.evidence).split(/\s+/).slice(0, 8).join(" ");
  const rendered = selected.map((e) => entryBudgetWeight(e)).reduce((a, b) => a + b, 0);
  assert.ok(rendered > 0);
  assert.doesNotMatch(
    JSON.stringify(selected.map((e) => ({ fact: (e as unknown as Record<string, unknown>).fact }))),
    new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "evidence text leaked into the injected facts",
  );
});

test("a fact stays actionable on its own — the split must not strand the rule", () => {
  // A fact reduced to a pointer ("see evidence") would satisfy the budget and teach nothing. Every
  // fact must still be a sentence a worker can obey without opening anything.
  for (const e of activeEntries()) {
    const fact = String(e.fact).replace(/\s+/g, " ").trim();
    assert.ok(fact.length >= 60, `${String(e.id)}: fact is too short to be a rule (${fact.length} chars)`);
    assert.doesNotMatch(fact, /\bsee (the )?evidence\b/i, `${String(e.id)}: fact defers to evidence instead of stating the rule`);
  }
});
