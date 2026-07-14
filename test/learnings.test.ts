import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AUTONOMY_CLAUSE,
  DISTRUST_RULE,
  LearningsError,
  loadLearnings,
  renderLearningsContext,
  selectLearnings,
  type LearningEntry,
} from "../src/lib/learnings.js";
import { assertProvenance, lintPrompt } from "../src/lib/provenance.js";
import { renderImplementPrompt } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";

const REPO_ROOT = join(new URL("..", import.meta.url).pathname);

/** A tiny tagged corpus: two containment facts, one CI fact. */
const CORPUS: LearningEntry[] = [
  {
    id: "shell-isolation",
    subsystem: "containment",
    files: ["src/lib/worker.ts", "src/lib/containment.ts"],
    fact: "ZDOTDIR is IGNORED; set CLAUDE_CODE_SHELL for worker shell isolation.",
    src: "PR#8",
    cited: "2026-07-14",
  },
  {
    id: "settings-silent-drop",
    subsystem: "settings",
    files: ["src/lib/settings.ts", "src/lib/worker.ts"],
    fact: "Invalid worker settings are silently ignored under `claude -p`.",
    src: "WS-0",
    cited: "2026-07-10",
  },
  {
    id: "skipped-check-deadlock",
    subsystem: "ci",
    files: [".github/**"],
    fact: "A conditionally-skipped required check deadlocks merge forever.",
    src: "operator-fleet",
    cited: "2026-07-12",
  },
];

/** Build a minimal implement Task for the fixture tests. */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "T-FIX",
    title: "fixture task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    status: "queued",
    attempts: 0,
    prompt: "do the thing",
    ...over,
  };
}

function writeCorpus(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "learnings-"));
  const path = join(dir, "learnings.yaml");
  writeFileSync(path, yaml);
  return path;
}

// ── Deterministic matching (acceptance §3) ──────────────────────────────────

test("matching is DETERMINISTIC by files: a worker.ts task gets the shell learning, NOT the CI one", () => {
  const { selected } = selectLearnings(CORPUS, ["src/lib/worker.ts"]);
  const ids = selected.map((e) => e.id);
  assert.ok(ids.includes("shell-isolation"), "worker.ts must receive the shell-isolation learning");
  assert.ok(ids.includes("settings-silent-drop"), "worker.ts also matches settings-silent-drop");
  assert.ok(!ids.includes("skipped-check-deadlock"), "worker.ts must NOT receive the CI-only learning");
});

test("a .github task gets the CI learning and NOT the containment ones", () => {
  const { selected } = selectLearnings(CORPUS, [".github/workflows/ci.yml"]);
  const ids = selected.map((e) => e.id);
  assert.deepEqual(ids, ["skipped-check-deadlock"]);
});

test("no task files → repo-wide: every entry is a candidate", () => {
  const { selected } = selectLearnings(CORPUS, undefined);
  assert.equal(selected.length, CORPUS.length);
});

test("a non-matching file set injects zero matched entries", () => {
  const { selected } = selectLearnings(CORPUS, ["README.md"]);
  assert.equal(selected.length, 0);
});

// ── The three always-present injections (acceptance §1) ──────────────────────

test("renderLearningsContext always injects the distrust rule and the autonomy clause", () => {
  const ctx = renderLearningsContext([]);
  assert.ok(ctx.includes(DISTRUST_RULE), "distrust rule must be present");
  assert.ok(ctx.includes(AUTONOMY_CLAUSE), "autonomy clause must be present");
});

test("a rendered prompt carries the distrust string, the autonomy string, and a matched LEARNINGS line", () => {
  const { selected } = selectLearnings(CORPUS, ["src/lib/worker.ts"]);
  const prompt = renderImplementPrompt(task({ files: ["src/lib/worker.ts"] }), "", "RUN-1", renderLearningsContext(selected));
  assert.ok(prompt.includes(DISTRUST_RULE), "distrust rule injected");
  assert.ok(prompt.includes(AUTONOMY_CLAUSE), "autonomy clause injected");
  assert.match(prompt, /ZDOTDIR is IGNORED.*\[src: learnings#shell-isolation\]/, "a provenance-tagged learning line");
});

// ── Provenance stays clean (acceptance §2) ───────────────────────────────────

test("injected LEARNINGS context passes the provenance linter", () => {
  const { selected } = selectLearnings(CORPUS, ["src/lib/worker.ts"]);
  const prompt = renderImplementPrompt(task({ files: ["src/lib/worker.ts"] }), "", "RUN-1", renderLearningsContext(selected));
  assert.doesNotThrow(() => assertProvenance(prompt));
  assert.equal(lintPrompt(prompt).ok, true);
});

test("every injected line — doctrine and facts — carries a [src: ...]", () => {
  const ctx = renderLearningsContext(CORPUS);
  for (const line of ctx.split("\n")) {
    assert.match(line, /\[src: learnings#[^\]]+\]/, `uncited injected line: ${line}`);
  }
});

// ── The KNOWLEDGE BUDGET cap (acceptance §4) ─────────────────────────────────

test("the KNOWLEDGE BUDGET caps injected facts and drops the rest, logged", () => {
  const many: LearningEntry[] = Array.from({ length: 10 }, (_, i) => ({
    id: `e${i}`,
    subsystem: "containment",
    files: ["src/lib/worker.ts"],
    fact: `fact number ${i} is a reasonably long durable sentence about worker behaviour.`,
    src: "PR#8",
  }));
  const budget = 200;
  const { selected, dropped } = selectLearnings(many, ["src/lib/worker.ts"], budget);
  assert.ok(dropped.length > 0, "some entries must be dropped");
  assert.equal(selected.length + dropped.length, many.length, "every entry is either selected or dropped");
  const facts = renderLearningsContext(selected)
    .split("\n")
    .filter((l) => /\[src: learnings#e\d+\]/.test(l))
    .join("\n");
  assert.ok(facts.length <= budget, `matched facts (${facts.length}) must fit the ${budget}-char budget`);
});

test("budget always injects at least one entry even if a single fact exceeds it", () => {
  const { selected } = selectLearnings(CORPUS, ["src/lib/worker.ts"], 1);
  assert.equal(selected.length, 1, "never starve to zero — one entry always lands");
});

test("selection is deterministic: higher match count wins, then recency", () => {
  const { selected } = selectLearnings(CORPUS, ["src/lib/worker.ts", "src/lib/settings.ts"]);
  // settings-silent-drop matches both files (count 2) → ranks ahead of shell-isolation (count 1).
  assert.equal(selected[0].id, "settings-silent-drop");
});

// ── Corpus loading ───────────────────────────────────────────────────────────

test("loadLearnings: a MISSING file is not an error (returns [])", () => {
  assert.deepEqual(loadLearnings(join(tmpdir(), "does-not-exist-learnings.yaml")), []);
});

test("loadLearnings rejects an entry missing a required field", () => {
  const path = writeCorpus("- id: x\n  files: [a.ts]\n"); // no fact/src
  assert.throws(() => loadLearnings(path), LearningsError);
});

test("loadLearnings rejects duplicate ids", () => {
  const path = writeCorpus(
    "- id: dup\n  files: [a.ts]\n  fact: one\n  src: PR#1\n- id: dup\n  files: [b.ts]\n  fact: two\n  src: PR#2\n",
  );
  assert.throws(() => loadLearnings(path), /duplicate learnings id/);
});

test("the shipped plan/learnings.yaml loads and matches worker.ts to shell-isolation, not CI", () => {
  const entries = loadLearnings(join(REPO_ROOT, "plan", "learnings.yaml"));
  assert.ok(entries.length > 0, "the shipped corpus is non-empty");
  const { selected } = selectLearnings(entries, ["src/lib/worker.ts"]);
  const ids = selected.map((e) => e.id);
  assert.ok(ids.includes("shell-isolation"), "worker.ts inherits the shell-isolation learning");
  assert.ok(!ids.includes("skipped-check-deadlock"), "worker.ts does not inherit the CI-only learning");
});
