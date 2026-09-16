/**
 * W1-T3709 — THE SECOND TIER MUST STAY OUT OF THE PROMPT.
 *
 * `evidence` lets a learning keep the measurement that earned it WITHOUT charging every matching
 * task for prose it does not need in order to act. That only holds while nothing renders it, and the
 * saving is INVISIBLE in normal use — a worker cannot tell it was spared. So if a later change
 * starts injecting `evidence`, the corpus quietly doubles and nothing looks wrong until the budget
 * ratchet goes red for reasons nobody can place. This suite is what notices.
 *
 * The split is the one CLAUDE.md already has with `doctrine/`: the headline IS the rule, the pointer
 * holds the proof. MEASURED on the live corpus before this shipped: the actionable rule was 7-19% of
 * the injected line on the longest entries.
 *
 * SYNTHETIC ENTRIES ON PURPOSE. These assertions are about the MECHANISM, so they must not depend on
 * whether the live corpus has been migrated yet — a test that needed a migrated entry would go
 * vacuous the moment the corpus changed, and would pass for the wrong reason before it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import yaml from "yaml";

import {
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  entryBudgetWeight,
  loadLearnings,
  renderMatchedLearnings,
  selectLearnings,
} from "../src/lib/learnings.js";

const RULE = "Trace the runtime value from source before editing the config you were told to change.";
const PROOF =
  "MEASURED 2026-09-16: the mounts `architect:` row looked authoritative but spawns resolved from " +
  "architectModel(config)'s `?? \"opus\"` default, so a row-only edit would have shipped green and " +
  "changed nothing observable. Repeated across three more producers whose values are computed and " +
  "then discarded at the call site, which is the cheapest fix class in this repo and the easiest " +
  "to miss because nothing fails when a value is dropped.";

const withEvidence = {
  id: "synthetic-two-tier", subsystem: "testing", lifecycle: "active" as const,
  files: ["src/lib/learnings.ts"], fact: RULE, evidence: PROOF, src: "W1-T3709", cited: "2026-09-16",
};
const withoutEvidence = { ...withEvidence, id: "synthetic-one-tier", evidence: undefined };

test("an entry's evidence is never charged to the prompt budget", () => {
  // EXACT, not a slack bound: the rendered line is `- <fact> [src: learnings#<id>]`, so its length
  // is the fact plus the id plus a fixed frame. Anything beyond that means something else rendered.
  const frame = "-  [src: learnings#]".length;
  assert.equal(entryBudgetWeight(withEvidence as never), RULE.length + withEvidence.id.length + frame);

  // AND THE DECISIVE COMPARISON: 300+ chars of evidence must cost exactly the same as none.
  assert.ok(PROOF.length > 300, "the fixture's evidence must be substantial, or this proves nothing");
  assert.equal(
    entryBudgetWeight(withEvidence as never) - withEvidence.id.length,
    entryBudgetWeight(withoutEvidence as never) - withoutEvidence.id.length,
    "an entry carrying evidence must weigh the same as one carrying none",
  );
});

test("evidence never reaches a selected prompt line", () => {
  // BEHAVIOURAL: drive the real selector and read what a task would actually be shown.
  const { selected } = selectLearnings(
    [withEvidence] as never,
    ["src/lib/learnings.ts"],
    DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  );
  assert.equal(selected.length, 1, "the entry must be selected by its own files, or the check is vacuous");
  // THE INJECTION SURFACE ITSELF, not the entry objects: `renderMatchedLearnings` is what reaches a
  // prompt. Stringifying the selected ENTRIES would "find" the evidence and prove nothing, since the
  // field is obviously present on the object — the claim is that the RENDERER never emits it.
  const shown = renderMatchedLearnings(selected);
  assert.match(shown, /Trace the runtime value/, "the RULE must reach the worker");
  assert.doesNotMatch(shown, /MEASURED 2026-09-16/, "the EVIDENCE must not");
  assert.doesNotMatch(shown, /shipped green/, "nor any of its prose");
});

test("a fact stays actionable on its own", () => {
  // The other direction, and the one that makes the budget saving honest: a fact reduced to a
  // pointer ("see the evidence") would satisfy the ratchet and teach nothing. Checked across the
  // LIVE corpus, because this property must hold for every entry a worker is ever shown.
  const entries: Array<Record<string, unknown>> = [];
  for (const f of readdirSync("learnings").filter((f) => f.endsWith(".yaml"))) {
    for (const e of (yaml.parse(readFileSync(`learnings/${f}`, "utf8")) ?? [])) {
      if ((e.lifecycle ?? "active") === "active") entries.push(e);
    }
  }
  assert.ok(entries.length > 20, "the live corpus must actually load, or this is vacuous");
  for (const e of entries) {
    const fact = String(e.fact).replace(/\s+/g, " ").trim();
    assert.ok(fact.length >= 60, `${String(e.id)}: fact is too short to be a rule (${fact.length} chars)`);
    assert.doesNotMatch(fact, /\bsee (the )?evidence\b/i, `${String(e.id)}: defers to evidence instead of stating the rule`);
  }
});

test("evidence survives the YAML loader, so a shard that records it is not silently stripped", () => {
  // THE HOLE A FALSIFIER FOUND. The assertions above hand synthetic objects straight to the
  // renderer, so they pass even if the LOADER drops `evidence` entirely — deleting the field from
  // the entry construction left them green. Then a shard could record its proof and have it
  // silently discarded at parse time, which is the worst shape: the YAML looks right and the
  // knowledge is gone. This drives the real loader over a real file.
  const dir = mkdtempSync(join(tmpdir(), "rmd-evidence-loader-"));
  try {
    const shard = join(dir, "probe.yaml");
    writeFileSync(shard, [
      "- id: loader-probe",
      "  subsystem: testing",
      "  lifecycle: active",
      "  files: [src/lib/learnings.ts]",
      "  fact: >-",
      "    Trace the runtime value from source before editing the config you were told to change.",
      "  evidence: >-",
      "    MEASURED 2026-09-16 against the live mounts table and three producers that discard a value.",
      '  src: "W1-T3709"',
      '  cited: "2026-09-16"',
      "",
    ].join("\n"), "utf8");

    const [entry] = loadLearnings(shard);
    assert.ok(entry, "the probe shard must load");
    assert.match(String(entry.evidence ?? ""), /MEASURED 2026-09-16/, "the loader must carry `evidence` through");
    assert.match(String(entry.fact), /Trace the runtime value/);

    // And it STILL must not reach the prompt — the loader carrying it and the renderer omitting it
    // are two separate properties, and this pins them together on one real round-trip.
    assert.doesNotMatch(renderMatchedLearnings([entry]), /MEASURED 2026-09-16/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-string evidence field is refused by name, not silently dropped", () => {
  // THE REFUSAL ARM. Validating `evidence` like any other field is what stops a typo — `evidence:`
  // given a list, or a number — from silently discarding the proof behind a rule while the shard
  // still loads green. An unexercised refusal is how a refusal quietly stops refusing.
  const dir = mkdtempSync(join(tmpdir(), "rmd-evidence-bad-"));
  try {
    const shard = join(dir, "bad.yaml");
    writeFileSync(shard, [
      "- id: bad-evidence",
      "  subsystem: testing",
      "  lifecycle: active",
      "  files: [src/lib/learnings.ts]",
      "  fact: >-",
      "    Trace the runtime value from source before editing the config you were told to change.",
      "  evidence:",
      "    - a list, which is a typo for a block scalar",
      '  src: "W1-T3709"',
      "",
    ].join("\n"), "utf8");

    assert.throws(
      () => loadLearnings(shard),
      (e: unknown) => {
        assert.match(String((e as Error).message), /'evidence' must be a string/, "the refusal must name the field");
        assert.match(String((e as Error).message), /bad-evidence/, "and the entry it came from");
        return true;
      },
      "a non-string evidence must refuse at load",
    );

    // DISCRIMINATION: the same shard with a STRING evidence loads, so the refusal is about the type
    // and not about something else in the fixture.
    writeFileSync(shard, readFileSync(shard, "utf8").replace(
      "  evidence:\n    - a list, which is a typo for a block scalar\n",
      "  evidence: >-\n    a proper block scalar\n",
    ), "utf8");
    assert.equal(loadLearnings(shard).length, 1, "the string form must load");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
