import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AUTONOMY_CLAUSE,
  candidateShardFiles,
  DISTRUST_RULE,
  LearningsError,
  loadLearnings,
  loadLearningsCorpus,
  loadLearningsForTaskFiles,
  loadLearningsIndex,
  renderDoctrinePreamble,
  renderLearningsContext,
  renderMatchedLearnings,
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
    lifecycle: "active",
    files: ["src/lib/worker.ts", "src/lib/containment.ts"],
    fact: "ZDOTDIR is IGNORED; set CLAUDE_CODE_SHELL for worker shell isolation.",
    src: "PR#8",
    cited: "2026-07-14",
  },
  {
    id: "settings-silent-drop",
    subsystem: "settings",
    lifecycle: "active",
    files: ["src/lib/settings.ts", "src/lib/worker.ts"],
    fact: "Invalid worker settings are silently ignored under `claude -p`.",
    src: "WS-0",
    cited: "2026-07-10",
  },
  {
    id: "skipped-check-deadlock",
    subsystem: "ci",
    lifecycle: "active",
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
    risk: "medium",
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
  const prompt = renderImplementPrompt(task({ files: ["src/lib/worker.ts"] }), "", "RUN-1", renderMatchedLearnings(selected));
  assert.ok(prompt.includes(DISTRUST_RULE), "distrust rule injected");
  assert.ok(prompt.includes(AUTONOMY_CLAUSE), "autonomy clause injected");
  assert.match(prompt, /ZDOTDIR is IGNORED.*\[src: learnings#shell-isolation\]/, "a provenance-tagged learning line");
});

// ── Provenance stays clean (acceptance §2) ───────────────────────────────────

test("injected LEARNINGS context passes the provenance linter", () => {
  const { selected } = selectLearnings(CORPUS, ["src/lib/worker.ts"]);
  const prompt = renderImplementPrompt(task({ files: ["src/lib/worker.ts"] }), "", "RUN-1", renderMatchedLearnings(selected));
  assert.doesNotThrow(() => assertProvenance(prompt));
  assert.equal(lintPrompt(prompt).ok, true);
});

// ── CACHE-AWARE ASSEMBLY: stable Tier-0 preamble first, volatile Tier-1
// matched learnings last (MASTER-PLAN §8A / W1-T35) ─────────────────────────

test("the rendered prompt places the doctrine preamble BEFORE the matched-learnings block", () => {
  const { selected } = selectLearnings(CORPUS, ["src/lib/worker.ts"]);
  const prompt = renderImplementPrompt(
    task({ files: ["src/lib/worker.ts"] }),
    "some recon observation",
    "RUN-1",
    renderMatchedLearnings(selected),
  );
  const doctrineIdx = prompt.indexOf(DISTRUST_RULE);
  const learningIdx = prompt.indexOf("ZDOTDIR is IGNORED");
  assert.ok(doctrineIdx >= 0, "doctrine preamble must be present");
  assert.ok(learningIdx >= 0, "matched-learnings block must be present");
  assert.ok(doctrineIdx < learningIdx, "the invariant preamble must precede the matched-learnings block");
});

test("the stable prefix (# CONTEXT + doctrine preamble) is BYTE-IDENTICAL across two different tasks/recon/matched-learnings — the cacheable prefix", () => {
  const promptA = renderImplementPrompt(
    task({ id: "T-A", files: ["a.ts"], prompt: "task A body" }),
    "recon observation for A",
    "RUN-1",
    "",
  );
  const promptB = renderImplementPrompt(
    task({ id: "T-B", files: ["b.ts"], prompt: "an entirely different task B body" }),
    "a totally different recon observation for B",
    "RUN-2",
    renderMatchedLearnings(selectLearnings(CORPUS, ["src/lib/worker.ts"]).selected),
  );
  const stablePrefix = ["# CONTEXT", renderDoctrinePreamble()].join("\n");
  assert.equal(promptA.slice(0, stablePrefix.length), stablePrefix);
  assert.equal(promptB.slice(0, stablePrefix.length), stablePrefix);
  assert.equal(
    promptA.slice(0, stablePrefix.length),
    promptB.slice(0, stablePrefix.length),
    "an early edit to per-task content must never move/alter the stable doctrine prefix",
  );
});

test("renderMatchedLearnings carries ONLY the matched facts, never the doctrine lines", () => {
  const { selected } = selectLearnings(CORPUS, ["src/lib/worker.ts"]);
  const matched = renderMatchedLearnings(selected);
  assert.ok(!matched.includes(DISTRUST_RULE), "doctrine must not leak into the matched-learnings block");
  assert.ok(!matched.includes(AUTONOMY_CLAUSE), "doctrine must not leak into the matched-learnings block");
  assert.match(matched, /ZDOTDIR is IGNORED/);
});

test("renderMatchedLearnings([]) is empty — an empty selection injects no matched-learnings block", () => {
  assert.equal(renderMatchedLearnings([]), "");
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
    lifecycle: "active" as const,
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

test("the shipped learnings/ corpus loads (across every shard) and matches worker.ts to shell-isolation, not CI", () => {
  const entries = loadLearningsCorpus(join(REPO_ROOT, "learnings"));
  assert.ok(entries.length > 0, "the shipped corpus is non-empty");
  const { selected } = selectLearnings(entries, ["src/lib/worker.ts"]);
  const ids = selected.map((e) => e.id);
  assert.ok(ids.includes("shell-isolation"), "worker.ts inherits the shell-isolation learning");
  assert.ok(!ids.includes("skipped-check-deadlock"), "worker.ts does not inherit the CI-only learning");
});

// ── SPLIT + INDEX + SUPERSESSION (W1-T33) ────────────────────────────────────

test("loadLearningsCorpus: a MISSING directory is not an error (returns [])", () => {
  assert.deepEqual(loadLearningsCorpus(join(tmpdir(), "does-not-exist-learnings-dir")), []);
});

test("loadLearningsCorpus merges entries from every shard file in a directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "learnings-corpus-"));
  writeFileSync(join(dir, "a.yaml"), "- id: from-a\n  files: [a.ts]\n  fact: fact a\n  src: PR#1\n");
  writeFileSync(join(dir, "b.yaml"), "- id: from-b\n  files: [b.ts]\n  fact: fact b\n  src: PR#2\n");
  const entries = loadLearningsCorpus(dir);
  assert.deepEqual(
    entries.map((e) => e.id).sort(),
    ["from-a", "from-b"],
  );
});

test("loadLearningsCorpus rejects a duplicate id ACROSS two different shard files", () => {
  const dir = mkdtempSync(join(tmpdir(), "learnings-corpus-dup-"));
  writeFileSync(join(dir, "a.yaml"), "- id: dup\n  files: [a.ts]\n  fact: fact a\n  src: PR#1\n");
  writeFileSync(join(dir, "b.yaml"), "- id: dup\n  files: [b.ts]\n  fact: fact b\n  src: PR#2\n");
  assert.throws(() => loadLearningsCorpus(dir), /duplicate learnings id 'dup'/);
});

test("a bare entry (no lifecycle:) defaults to active", () => {
  const path = writeCorpus("- id: bare\n  files: [a.ts]\n  fact: a fact\n  src: PR#1\n");
  const [entry] = loadLearnings(path);
  assert.equal(entry.lifecycle, "active");
});

test("loadLearnings rejects an invalid lifecycle value", () => {
  const path = writeCorpus("- id: bad\n  files: [a.ts]\n  fact: a fact\n  src: PR#1\n  lifecycle: retired\n");
  assert.throws(() => loadLearnings(path), /'lifecycle' must be 'active', 'superseded', or 'quarantined'/);
});

test("loadLearnings rejects superseded_by set without lifecycle: superseded", () => {
  const path = writeCorpus(
    "- id: bad\n  files: [a.ts]\n  fact: a fact\n  src: PR#1\n  superseded_by: other\n",
  );
  assert.throws(() => loadLearnings(path), /'superseded_by' is set but 'lifecycle' is not 'superseded'/);
});

// ── SELF-VERIFICATION (W1-T34): assertion + quarantine lifecycle ────────────

test("loadLearnings accepts an optional 'assertion' string", () => {
  const path = writeCorpus("- id: x\n  files: [a.ts]\n  fact: a fact\n  src: PR#1\n  assertion: 'exit 0'\n");
  const [entry] = loadLearnings(path);
  assert.equal(entry.assertion, "exit 0");
});

test("loadLearnings rejects an empty-string assertion", () => {
  const path = writeCorpus("- id: x\n  files: [a.ts]\n  fact: a fact\n  src: PR#1\n  assertion: ''\n");
  assert.throws(() => loadLearnings(path), /'assertion' must be a non-empty string/);
});

test("loadLearnings rejects quarantined_reason set without lifecycle: quarantined", () => {
  const path = writeCorpus(
    "- id: bad\n  files: [a.ts]\n  fact: a fact\n  src: PR#1\n  quarantined_reason: 'why'\n",
  );
  assert.throws(() => loadLearnings(path), /'quarantined_reason' is set but 'lifecycle' is not 'quarantined'/);
});

test("loadLearnings accepts lifecycle: quarantined with a quarantined_reason", () => {
  const path = writeCorpus(
    "- id: q\n  files: [a.ts]\n  fact: a fact\n  src: PR#1\n  lifecycle: quarantined\n  quarantined_reason: 'assertion failed'\n",
  );
  const [entry] = loadLearnings(path);
  assert.equal(entry.lifecycle, "quarantined");
  assert.equal(entry.quarantinedReason, "assertion failed");
});

test("QUARANTINE: a quarantined entry is NEVER selected, even when its files: match exactly (acceptance §2)", () => {
  const entries: LearningEntry[] = [
    {
      id: "flaky-fact",
      subsystem: "platform",
      lifecycle: "quarantined",
      quarantinedReason: "assertion failed (exit 1): exit 1",
      assertion: "exit 1",
      files: ["src/lib/worker.ts"],
      fact: "A fact whose self-check no longer holds.",
      src: "PR#1",
    },
    {
      id: "still-good",
      subsystem: "platform",
      lifecycle: "active",
      files: ["src/lib/worker.ts"],
      fact: "A fact that still holds.",
      src: "PR#1",
    },
  ];
  const { selected, dropped } = selectLearnings(entries, ["src/lib/worker.ts"]);
  const selectedIds = selected.map((e) => e.id);
  assert.deepEqual(selectedIds, ["still-good"], "a matching task gets ONLY the active entry");
  assert.ok(!selectedIds.includes("flaky-fact"), "the quarantined entry must never be selected");
  assert.ok(
    !dropped.map((e) => e.id).includes("flaky-fact"),
    "quarantined is filtered before ranking, not dropped for budget",
  );
});

test("SUPERSESSION: a superseded entry is NEVER selected, even when its files: match exactly (acceptance §2, the ZDOTDIR live example)", () => {
  const entries: LearningEntry[] = [
    {
      id: "shell-isolation",
      subsystem: "containment",
      lifecycle: "active",
      files: ["src/lib/env.ts"],
      fact: "ZDOTDIR is IGNORED; set CLAUDE_CODE_SHELL for worker shell isolation.",
      src: "PR#8",
      cited: "2026-07-14",
    },
    {
      id: "zdotdir-alone-isolates-shells",
      subsystem: "containment",
      lifecycle: "superseded",
      supersededBy: "shell-isolation",
      files: ["src/lib/env.ts"],
      fact: "ZDOTDIR alone isolates worker shells.",
      src: "pre-PR#8 assumption, disproven",
      cited: "2026-07-14",
    },
  ];
  const { selected, dropped } = selectLearnings(entries, ["src/lib/env.ts"]);
  const selectedIds = selected.map((e) => e.id);
  assert.deepEqual(selectedIds, ["shell-isolation"], "a worker touching env.ts gets ONLY the active entry");
  assert.ok(!selectedIds.includes("zdotdir-alone-isolates-shells"), "the superseded entry must never be selected");
  // Confirmed excluded at the candidacy stage, not merely budget-dropped.
  assert.ok(
    !dropped.map((e) => e.id).includes("zdotdir-alone-isolates-shells"),
    "superseded is filtered before ranking, not dropped for budget",
  );
});

test("SUPERSESSION over the REAL shipped corpus: a task touching src/lib/env.ts gets shell-isolation and never the superseded zdotdir entry", () => {
  const entries = loadLearningsCorpus(join(REPO_ROOT, "learnings"));
  const superseded = entries.find((e) => e.id === "zdotdir-alone-isolates-shells");
  assert.ok(superseded, "the shipped corpus carries the superseded ZDOTDIR fixture entry");
  assert.equal(superseded!.lifecycle, "superseded");
  const { selected } = selectLearnings(entries, ["src/lib/env.ts"]);
  const ids = selected.map((e) => e.id);
  assert.ok(ids.includes("shell-isolation"), "env.ts inherits the active shell-isolation learning");
  assert.ok(!ids.includes("zdotdir-alone-isolates-shells"), "env.ts NEVER inherits the superseded learning");
});

test("candidateShardFiles: repo-wide (no taskFiles) candidates every shard in the index", () => {
  const index = {
    files: {
      "a.yaml": { entries: ["x"], globs: ["src/a.ts"] },
      "b.yaml": { entries: ["y"], globs: ["src/b.ts"] },
    },
    bySubsystem: {},
  };
  assert.deepEqual(candidateShardFiles(index, undefined), ["a.yaml", "b.yaml"]);
});

test("candidateShardFiles: a task file matching only b.yaml's globs candidates b.yaml alone (a LOOKUP, not a scan)", () => {
  const index = {
    files: {
      "a.yaml": { entries: ["x"], globs: ["src/a.ts"] },
      "b.yaml": { entries: ["y"], globs: ["src/b.ts"] },
    },
    bySubsystem: {},
  };
  assert.deepEqual(candidateShardFiles(index, ["src/b.ts"]), ["b.yaml"]);
});

test("loadLearningsIndex: a missing/malformed index returns null (non-fatal)", () => {
  assert.equal(loadLearningsIndex(join(tmpdir(), "does-not-exist-index.json")), null);
  const dir = mkdtempSync(join(tmpdir(), "bad-index-"));
  const badPath = join(dir, "index.json");
  writeFileSync(badPath, "not json");
  assert.equal(loadLearningsIndex(badPath), null);
});

test("loadLearningsForTaskFiles: an index-narrowed lookup yields the SAME selection as a full-corpus scan (the lookup loses nothing)", () => {
  const dir = join(REPO_ROOT, "learnings");
  const taskFiles = ["src/lib/worker.ts"];
  const viaLookup = selectLearnings(loadLearningsForTaskFiles(dir, taskFiles), taskFiles).selected.map((e) => e.id).sort();
  const viaFullScan = selectLearnings(loadLearningsCorpus(dir), taskFiles).selected.map((e) => e.id).sort();
  assert.deepEqual(viaLookup, viaFullScan);
});

test("loadLearningsForTaskFiles: a MISSING learnings directory returns [] (no corpus yet)", () => {
  assert.deepEqual(loadLearningsForTaskFiles(join(tmpdir(), "does-not-exist-learnings-dir"), ["a.ts"]), []);
});

test("loadLearningsForTaskFiles: falls back to a full scan when the index is absent, without losing entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "learnings-no-index-"));
  writeFileSync(join(dir, "a.yaml"), "- id: from-a\n  files: [a.ts]\n  fact: fact a\n  src: PR#1\n");
  const entries = loadLearningsForTaskFiles(dir, ["a.ts"]);
  assert.deepEqual(entries.map((e) => e.id), ["from-a"]);
});

// ── Further parseLearningsDoc validation branches ────────────────────────────

test("loadLearnings: an empty file (parses to `undefined`, not a list) is zero entries, not an error", () => {
  const path = writeCorpus("");
  assert.deepEqual(loadLearnings(path), []);
});

test("loadLearnings rejects a YAML document that is not a list", () => {
  const path = writeCorpus("id: not-a-list\n");
  assert.throws(() => loadLearnings(path), /must be a YAML list of entries/);
});

test("loadLearnings rejects a list entry that is not a mapping", () => {
  const path = writeCorpus("- just-a-string\n");
  assert.throws(() => loadLearnings(path), /must be a mapping/);
});

test("loadLearnings rejects an entry missing string 'id' specifically", () => {
  const path = writeCorpus("- files: [a.ts]\n  fact: a fact\n  src: PR#1\n");
  assert.throws(() => loadLearnings(path), /missing string 'id'/);
});

test("loadLearnings rejects an entry missing 'src' specifically", () => {
  const path = writeCorpus("- id: x\n  files: [a.ts]\n  fact: a fact\n");
  assert.throws(() => loadLearnings(path), /missing string 'src'/);
});

test("loadLearnings rejects an entry whose 'files' is not a list of strings", () => {
  const path = writeCorpus("- id: x\n  files: not-a-list\n  fact: a fact\n  src: PR#1\n");
  assert.throws(() => loadLearnings(path), /'files' must be a list of globs/);
});

test("loadLearnings rejects an entry whose 'files' list contains a non-string glob", () => {
  const path = writeCorpus("- id: x\n  files: [a.ts, 5]\n  fact: a fact\n  src: PR#1\n");
  assert.throws(() => loadLearnings(path), /'files' must be a list of globs/);
});

test("loadLearnings rejects malformed YAML (not valid syntax at all)", () => {
  const path = writeCorpus("- id: x\n  files: [a.ts\n  fact: unterminated flow sequence\n");
  assert.throws(() => loadLearnings(path), /is not valid YAML/);
});

test("loadLearningsCorpus rejects malformed YAML in one shard, naming that shard's path", () => {
  const dir = mkdtempSync(join(tmpdir(), "learnings-corpus-badyaml-"));
  writeFileSync(join(dir, "a.yaml"), "- id: x\n  files: [a.ts\n  fact: unterminated\n");
  assert.throws(() => loadLearningsCorpus(dir), /is not valid YAML/);
});

test("candidateShardFiles: an explicit empty taskFiles array is treated the same as repo-wide (every shard candidates)", () => {
  const index = {
    files: {
      "a.yaml": { entries: ["x"], globs: ["src/a.ts"] },
      "b.yaml": { entries: ["y"], globs: ["src/b.ts"] },
    },
    bySubsystem: {},
  };
  assert.deepEqual(candidateShardFiles(index, []), ["a.yaml", "b.yaml"]);
});
