import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  loadLearningsCorpus,
  selectLearnings,
  type LearningEntry,
} from "../src/lib/learnings.js";

// W1-T2507 — THE PER-SESSION CONTEXT TAX IS PAID ON RULES THE WORKER CANNOT ACT ON.
//
// CLAUDE.md used to inject, in full, into EVERY session: 30-ish bullets naming a concrete repo
// path that learnings/'s glob matcher already scopes, a whole "Operating this host" section a
// containerised worker can never act on, and five dated "Lessons from <date>" append-only
// sections the file's own maintenance rule forbids. This suite proves the three moves that
// closed that gap actually landed and actually reach the reader they were written for — never
// merely that CLAUDE.md got smaller.

const REPO_ROOT = join(fileURLToPath(new URL("../", import.meta.url)));
const CLAUDE_MD = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
const OPERATOR_GUIDE = readFileSync(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");

function migratedEntries(): LearningEntry[] {
  const entries = loadLearningsCorpus(join(REPO_ROOT, "learnings"));
  return entries.filter((e) => /migrated from CLAUDE\.md/.test(e.src));
}

// ── acceptance: "every migrated rule reaches a task whose files it governs" ────────────────────

test("every migrated learnings entry is selected for a task whose files: hit its own glob", () => {
  const corpus = loadLearningsCorpus(join(REPO_ROOT, "learnings"));
  const migrated = migratedEntries();
  assert.ok(migrated.length >= 10, `expected a real batch of migrated entries, got ${migrated.length}`);
  for (const entry of migrated) {
    const governedPath = entry.files.find((f) => !f.includes("*"));
    assert.ok(governedPath, `${entry.id}: expected at least one literal (non-glob) files: entry`);
    const { selected } = selectLearnings(corpus, [governedPath as string]);
    assert.ok(
      selected.some((s) => s.id === entry.id),
      `${entry.id}: a task touching '${governedPath}' must have this migrated fact injected`,
    );
  }
});

// ── acceptance: "removing a migrated entry's glob makes the reachability assertion fail" ───────

test("falsifier: dropping a migrated entry's files: glob removes it from the same task's selection", () => {
  const corpus = loadLearningsCorpus(join(REPO_ROOT, "learnings"));
  const entry = migratedEntries().find((e) => e.files.some((f) => !f.includes("*")));
  assert.ok(entry, "need at least one migrated entry with a literal glob to falsify");
  const governedPath = entry!.files.find((f) => !f.includes("*")) as string;

  const withGlob = selectLearnings(corpus, [governedPath]);
  assert.ok(withGlob.selected.some((s) => s.id === entry!.id), "sanity: the real corpus must reach it");

  const mutated = corpus.map((e) => (e.id === entry!.id ? { ...e, files: [] } : e));
  const withoutGlob = selectLearnings(mutated, [governedPath]);
  assert.ok(
    !withoutGlob.selected.some((s) => s.id === entry!.id),
    "an entry with its files: glob removed must stop reaching the task it used to govern",
  );
});

// ── acceptance: "no rule is dropped in the move — each has a destination" ──────────────────────

test("the dated sections and the host-operations section are gone from CLAUDE.md, with no bare header left behind", () => {
  assert.doesNotMatch(CLAUDE_MD, /^## Lessons from \d{4}-\d{2}-\d{2}/m);
  assert.doesNotMatch(CLAUDE_MD, /^## Operating this host/m);
});

test("migrated learnings entries and the relocated host-operations section are non-empty destinations, not silent drops", () => {
  const migrated = migratedEntries();
  assert.ok(migrated.length > 0);
  for (const entry of migrated) {
    assert.ok(entry.fact.length > 40, `${entry.id}: fact reads as a stub, not a real migrated rule`);
  }
  assert.match(OPERATOR_GUIDE, /## Operating this host \(migrated from CLAUDE\.md, W1-T2507\)/);
  // Spot-check a couple of the host-only rules actually carried their content across, not just the header.
  assert.match(OPERATOR_GUIDE, /Never run an installing package manager/);
  assert.match(OPERATOR_GUIDE, /reapStaleWorktrees/);
});

// ── acceptance: "host-operations rules no longer reach a containerised build worker" ───────────

test("host-only operational hazards are absent from CLAUDE.md (the full-file worker inject) and present in docs/operator-guide.md", () => {
  for (const marker of ["com.remudero.daemon", "launchctl kickstart", "ms-playwright", "reapStaleWorktrees"]) {
    assert.doesNotMatch(CLAUDE_MD, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(OPERATOR_GUIDE, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

// ── acceptance: "a migrated entry carries provenance rather than appearing uncited" ────────────

test("every migrated learnings entry cites both its original CLAUDE.md section and W1-T2507", () => {
  for (const entry of migratedEntries()) {
    assert.match(entry.src, /migrated from CLAUDE\.md/, `${entry.id}: src must record where it came from`);
    assert.match(entry.src, /W1-T2507/, `${entry.id}: src must cite the migrating task`);
    assert.equal(entry.cited, "2026-08-31");
  }
});

// ── acceptance: "the budget cap is lowered to match the smaller file" ──────────────────────────

test("CLAUDE.md's budget cap came DOWN from its pre-migration value and still covers the real file", () => {
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "claude-md-budget-baseline.json"), "utf8"));
  const PRE_MIGRATION_CAP = 67536;
  assert.ok(
    baseline.capBytes < PRE_MIGRATION_CAP,
    `cap must have come down from ${PRE_MIGRATION_CAP}, got ${baseline.capBytes}`,
  );
  const actualBytes = Buffer.byteLength(CLAUDE_MD);
  assert.ok(actualBytes < PRE_MIGRATION_CAP, "the real file must actually be smaller, not just the declared cap");
  assert.ok(actualBytes <= baseline.capBytes, "the real file must still fit under its own (lowered) cap");
  assert.match(String(baseline.bumpRationale ?? ""), /W1-T2507/);
});

// ── acceptance: "the learnings matcher, budget or lifecycle behave exactly as today" ───────────

test("selectLearnings' matching/ranking/budget behavior is untouched by this migration", () => {
  // A hand-seeded fixture, not the real corpus — this pins src/lib/learnings.ts's OWN behavior
  // (which W1-T2507 never edited), independent of whatever the corpus's data happens to hold.
  const fixture: LearningEntry[] = [
    { id: "a", subsystem: "s", lifecycle: "active", files: ["x/one.ts"], fact: "fact a", src: "s" },
    { id: "b", subsystem: "s", lifecycle: "superseded", files: ["x/one.ts"], fact: "fact b", src: "s" },
    { id: "c", subsystem: "s", lifecycle: "active", files: ["x/two.ts"], fact: "fact c", src: "s" },
  ];
  const { selected, dropped } = selectLearnings(fixture, ["x/one.ts"]);
  assert.deepEqual(
    selected.map((e) => e.id),
    ["a"],
    "matching by files: glob and excluding superseded lifecycle must still hold",
  );
  assert.deepEqual(dropped, []);
  assert.equal(DEFAULT_KNOWLEDGE_BUDGET_CHARS, 8148, "the per-task injection budget must be unchanged by this task");
});

test("the learnings corpus this task edited still parses cleanly through the real loader with no id collisions", () => {
  const entries = loadLearningsCorpus(join(REPO_ROOT, "learnings"));
  const ids = new Set<string>();
  for (const e of entries) {
    assert.ok(!ids.has(e.id), `duplicate learnings id: ${e.id}`);
    ids.add(e.id);
  }
  assert.ok(ids.size > 40, "the corpus should still carry its pre-existing entries plus the migrated ones");
});

// ── sanity: the learnings/architecture.yaml shard this task edited is well-formed YAML ─────────

test("learnings/architecture.yaml parses as a YAML list (the file this task's shard declares)", () => {
  const raw = parseYaml(readFileSync(join(REPO_ROOT, "learnings", "architecture.yaml"), "utf8"));
  assert.ok(Array.isArray(raw));
});
