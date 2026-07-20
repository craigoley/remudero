import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  computeArtifactHash,
  entryBudgetWeight,
  entryLayer,
  LearningsError,
  loadGlobalArtifact,
  loadLayeredLearnings,
  loadLayeredLearningsForTaskFiles,
  loadLearningsCorpus,
  projectLearningsHome,
  renderMatchedLearnings,
  selectLearnings,
  type GlobalArtifact,
  type LearningEntry,
} from "../src/lib/learnings.js";
import {
  globalArtifactPath,
  globalLearningsHome,
  userOverallLearningsHome,
  type Config,
} from "../src/lib/config.js";
import { assertProvenance } from "../src/lib/provenance.js";
import { renderImplementPrompt } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";

// P32/W1-T145 — layered knowledge: ONE entry schema valid at every layer + the layer homes.
// These tests exercise the three acceptance criteria named in plan/tasks.yaml W1-T145 directly.

function baseConfig(over: Partial<Config> = {}): Config {
  return { claudeBin: "/usr/bin/claude", root: "/tmp/rmd-root", ...over };
}

/** A single well-formed entry, reused across layers to prove ONE shape is valid everywhere. */
function entry(over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: "layered-fact",
    subsystem: "knowledge",
    lifecycle: "active",
    assertion: "true", // shell command that always exits 0 — assertion-carrying
    files: ["src/lib/learnings.ts"],
    fact: "One entry shape is valid at every knowledge layer.",
    src: "W1-T145", // provenance-carrying
    ...over,
  };
}

function writeShard(dir: string, filename: string, entries: LearningEntry[]): void {
  writeFileSync(join(dir, filename), JSON.stringify(entries));
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── Acceptance 1: one entry schema parses and validates identically at all three layers ──────

test("W1-T145: the same entry (assertion + provenance + budget-weight) loads from a project home", () => {
  const projectDir = tmpDir("learnings-project-");
  writeShard(projectDir, "shard.yaml", [entry({ layer: "project" })]);
  const loaded = loadLearningsCorpus(projectDir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].assertion, "true");
  assert.equal(loaded[0].src, "W1-T145");
  assert.equal(entryLayer(loaded[0]), "project");
  assert.ok(entryBudgetWeight(loaded[0]) > 0, "budget weight must be computed for a project-layer entry");
});

test("W1-T145: the same entry shape loads from a user-overall home via the SAME loader", () => {
  const userDir = tmpDir("learnings-user-");
  writeShard(userDir, "shard.yaml", [entry({ layer: "user-overall" })]);
  const loaded = loadLearningsCorpus(userDir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].assertion, "true");
  assert.equal(loaded[0].src, "W1-T145");
  assert.equal(entryLayer(loaded[0]), "user-overall");
  assert.ok(entryBudgetWeight(loaded[0]) > 0, "budget weight must be computed for a user-overall-layer entry");
});

test("W1-T145: the same entry shape loads from a global-artifact home, hash-verified", () => {
  const globalDir = tmpDir("learnings-global-");
  const entries = [entry({ layer: "global" })];
  const artifact: GlobalArtifact = { version: "v1", hash: computeArtifactHash(entries), entries };
  const path = join(globalDir, "artifact.yaml");
  writeFileSync(path, JSON.stringify(artifact));

  const result = loadGlobalArtifact(path);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].assertion, "true");
  assert.equal(result.entries[0].src, "W1-T145");
  assert.equal(entryLayer(result.entries[0]), "global");
  assert.ok(entryBudgetWeight(result.entries[0]) > 0, "budget weight must be computed for a global-layer entry");
});

test("W1-T145: a malformed entry (missing 'fact') is rejected at EVERY layer by the SAME validator", () => {
  const malformed = [{ id: "broken", src: "x", files: [] }]; // no 'fact' — parseLearningsDoc must throw

  // project
  const projectDir = tmpDir("learnings-bad-project-");
  writeFileSync(join(projectDir, "shard.yaml"), JSON.stringify(malformed));
  assert.throws(() => loadLearningsCorpus(projectDir), LearningsError);

  // user-overall (same loader as project — the home is just a different directory)
  const userDir = tmpDir("learnings-bad-user-");
  writeFileSync(join(userDir, "shard.yaml"), JSON.stringify(malformed));
  assert.throws(() => loadLearningsCorpus(userDir), LearningsError);

  // global — the validator runs INSIDE loadGlobalArtifact, so a bad entry surfaces as a refusal
  // carrying the identical LearningsError message, not a different failure shape.
  const globalDir = tmpDir("learnings-bad-global-");
  const path = join(globalDir, "artifact.yaml");
  writeFileSync(path, JSON.stringify({ version: "v1", hash: "irrelevant", entries: malformed }));
  const result = loadGlobalArtifact(path);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /missing string 'fact'/);

  // Confirm it is the SAME message the project/user path throws, not a look-alike.
  let projectMessage = "";
  try {
    loadLearningsCorpus(projectDir);
  } catch (err) {
    projectMessage = err instanceof Error ? err.message : String(err);
  }
  assert.match(projectMessage, /missing string 'fact'/);
});

// ── Acceptance 2: the user-overall home is fleet-readable, outside any single repo ───────────

test("W1-T145: the user-overall home is derived from config.root, not from any repo path", () => {
  const home = userOverallLearningsHome(baseConfig({ root: "/tmp/rmd-root" }));
  assert.equal(home, "/tmp/rmd-root/learnings-user");
  assert.ok(!home.includes("/repos/"), "must not resolve inside a repo checkout under root/repos/<name>");
});

test("W1-T145: two different repo checkouts under the SAME instance resolve to the SAME user-overall home", () => {
  // userOverallLearningsHome takes only a Config — it has no repo/cwd parameter at all, so two
  // "checkouts" (simulated here by two separately-constructed configs sharing root) can only ever
  // agree or disagree via config.root. Assert they agree.
  const configForRepoA = baseConfig({ root: "/tmp/rmd-root" });
  const configForRepoB: Config = { claudeBin: "/usr/bin/claude", root: "/tmp/rmd-root" };
  assert.equal(userOverallLearningsHome(configForRepoA), userOverallLearningsHome(configForRepoB));
});

test("W1-T145: the project home stays PER-REPO while the user-overall home stays PER-INSTANCE", () => {
  const repoA = projectLearningsHome("/tmp/rmd-root/repos/alpha");
  const repoB = projectLearningsHome("/tmp/rmd-root/repos/beta");
  assert.notEqual(repoA, repoB, "project homes differ per repo checkout");

  const userHome = userOverallLearningsHome(baseConfig({ root: "/tmp/rmd-root" }));
  assert.notEqual(userHome, repoA);
  assert.notEqual(userHome, repoB);
});

// ── Acceptance 3: the global layer is a versioned, hash-pinned artifact ──────────────────────

test("W1-T145: the global artifact carries a version + content hash", () => {
  const entries = [entry()];
  const hash = computeArtifactHash(entries);
  assert.equal(typeof hash, "string");
  assert.equal(hash.length, 64, "sha256 hex digest is 64 chars");
  const artifact: GlobalArtifact = { version: "2026-07-20", hash, entries };
  assert.equal(artifact.version, "2026-07-20");
});

test("W1-T145: a tampered/mismatched global artifact is REFUSED, never silently trusted (the falsifier)", () => {
  const dir = tmpDir("learnings-global-tamper-");
  const entries = [entry()];
  const correctHash = computeArtifactHash(entries);
  // Tamper AFTER hashing: mutate the fact but keep the stale hash, like a hand-edited or corrupted pull.
  const tampered = [{ ...entries[0], fact: "This fact was tampered with after hashing." }];
  const path = join(dir, "artifact.yaml");
  writeFileSync(path, JSON.stringify({ version: "v1", hash: correctHash, entries: tampered }));

  const result = loadGlobalArtifact(path);
  assert.equal(result.ok, false, "hash mismatch must refuse the artifact");
  if (result.ok) return;
  assert.match(result.reason, /hash mismatch/);
});

test("W1-T145: a hash-matching global artifact is trusted and its entries load", () => {
  const dir = tmpDir("learnings-global-ok-");
  const entries = [entry({ id: "global-fact-1" })];
  const hash = computeArtifactHash(entries);
  const path = join(dir, "artifact.yaml");
  writeFileSync(path, JSON.stringify({ version: "v1", hash, entries }));

  const result = loadGlobalArtifact(path);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].id, "global-fact-1");
});

// ── Assembled prompt: project + user + global read in precedence, tampered global excluded ───

test("W1-T145: loadLayeredLearnings merges project + user + global in precedence order", () => {
  const projectDir = tmpDir("layered-project-");
  const userDir = tmpDir("layered-user-");
  const globalDir = tmpDir("layered-global-");

  writeShard(projectDir, "shard.yaml", [entry({ id: "p1", layer: "project" })]);
  writeShard(userDir, "shard.yaml", [entry({ id: "u1", layer: "user-overall" })]);
  const globalEntries = [entry({ id: "g1", layer: "global" })];
  const globalPath = join(globalDir, "artifact.yaml");
  writeFileSync(
    globalPath,
    JSON.stringify({ version: "v1", hash: computeArtifactHash(globalEntries), entries: globalEntries }),
  );

  const result = loadLayeredLearnings({
    projectDir,
    userOverallDir: userDir,
    globalArtifactPath: globalPath,
  });

  assert.deepEqual(
    result.entries.map((e) => e.id),
    ["p1", "u1", "g1"],
    "project, then user-overall, then global",
  );
  assert.equal(result.globalRefusedReason, undefined);
});

test("W1-T145: loadLayeredLearnings excludes a tampered global artifact and surfaces WHY", () => {
  const projectDir = tmpDir("layered-project-bad-global-");
  const globalDir = tmpDir("layered-global-bad-");

  writeShard(projectDir, "shard.yaml", [entry({ id: "p1", layer: "project" })]);
  const globalEntries = [entry({ id: "g1", layer: "global" })];
  const globalPath = join(globalDir, "artifact.yaml");
  writeFileSync(globalPath, JSON.stringify({ version: "v1", hash: "not-the-real-hash", entries: globalEntries }));

  const result = loadLayeredLearnings({ projectDir, globalArtifactPath: globalPath });

  assert.deepEqual(
    result.entries.map((e) => e.id),
    ["p1"],
    "tampered global entries must never reach the merged/injectable corpus",
  );
  assert.match(result.globalRefusedReason ?? "", /hash mismatch/);
});

test("W1-T145: a missing user-overall / global home is non-fatal — project-only injection still works", () => {
  const projectDir = tmpDir("layered-project-only-");
  writeShard(projectDir, "shard.yaml", [entry({ id: "p1" })]);
  const result = loadLayeredLearnings({ projectDir });
  assert.deepEqual(result.entries.map((e) => e.id), ["p1"]);
  assert.equal(result.globalRefusedReason, undefined);
});

// ── The global layer home itself (config.ts) ──────────────────────────────────────────────────

test("W1-T145: the global home is also derived from config.root, distinct from the user-overall home", () => {
  const config = baseConfig({ root: "/tmp/rmd-root" });
  assert.equal(globalLearningsHome(config), "/tmp/rmd-root/learnings-global");
  assert.notEqual(globalLearningsHome(config), userOverallLearningsHome(config));
});

// ── "bundled into prompt assemblies": the ASSEMBLED PROMPT itself, not just the merged entry
// list, must carry project+user+global in precedence (the reviewer's non-responsive gap). ──────

/** Minimal implement Task fixture, matching test/learnings.test.ts's shape. */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "T-LAYERED",
    title: "layered-knowledge fixture task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    prompt: "do the layered thing",
    files: ["src/lib/learnings.ts"],
    ...over,
  };
}

test("W1-T145: the ASSEMBLED PROMPT bundles project + user-overall + global facts, in precedence, provenance-clean", () => {
  const root = mkdtempSync(join(tmpdir(), "layered-prompt-root-"));
  const projectDir = join(root, "repos", "remudero", "learnings");
  mkdirSync(projectDir, { recursive: true });
  const userDir = userOverallLearningsHome(baseConfig({ root }));
  mkdirSync(userDir, { recursive: true });
  const globalDir = globalLearningsHome(baseConfig({ root }));
  mkdirSync(globalDir, { recursive: true });

  writeShard(projectDir, "shard.yaml", [
    entry({ id: "p-fact", layer: "project", fact: "PROJECT-LAYER FACT", files: ["src/lib/learnings.ts"] }),
  ]);
  writeShard(userDir, "shard.yaml", [
    entry({ id: "u-fact", layer: "user-overall", fact: "USER-OVERALL-LAYER FACT", files: ["src/lib/learnings.ts"] }),
  ]);
  const globalEntries = [
    entry({ id: "g-fact", layer: "global", fact: "GLOBAL-LAYER FACT", files: ["src/lib/learnings.ts"] }),
  ];
  const path = globalArtifactPath(baseConfig({ root }));
  writeFileSync(path, JSON.stringify({ version: "v1", hash: computeArtifactHash(globalEntries), entries: globalEntries }));

  const t = task();
  const { entries, globalRefusedReason } = loadLayeredLearningsForTaskFiles(
    { projectDir, userOverallDir: userDir, globalArtifactPath: path },
    t.files,
  );
  assert.equal(globalRefusedReason, undefined);
  assert.deepEqual(
    entries.map((e) => e.id),
    ["p-fact", "u-fact", "g-fact"],
    "project, then user-overall, then global — the merge precedence order",
  );

  const { selected } = selectLearnings(entries, t.files);
  const matchedLearnings = renderMatchedLearnings(selected);
  const prompt = renderImplementPrompt(t, "", "run-1", matchedLearnings);

  // The ASSEMBLED PROMPT — not just the merged entry list — carries all three layers' facts.
  const pIdx = prompt.indexOf("PROJECT-LAYER FACT");
  const uIdx = prompt.indexOf("USER-OVERALL-LAYER FACT");
  const gIdx = prompt.indexOf("GLOBAL-LAYER FACT");
  assert.ok(pIdx !== -1, "assembled prompt must include the project-layer fact");
  assert.ok(uIdx !== -1, "assembled prompt must include the user-overall-layer fact");
  assert.ok(gIdx !== -1, "assembled prompt must include the global-layer fact");
  assert.ok(pIdx < uIdx && uIdx < gIdx, "assembled prompt preserves project -> user-overall -> global precedence");

  // Every injected fact is cited (provenance linter passes on the full assembled prompt).
  assert.match(prompt, /PROJECT-LAYER FACT.*\[src: learnings#p-fact\]/);
  assert.match(prompt, /USER-OVERALL-LAYER FACT.*\[src: learnings#u-fact\]/);
  assert.match(prompt, /GLOBAL-LAYER FACT.*\[src: learnings#g-fact\]/);
  assert.doesNotThrow(() => assertProvenance(prompt), "the assembled prompt must pass the provenance gate");
});

test("W1-T145: a TAMPERED global artifact is excluded from the assembled prompt — project+user still bundle (the falsifier)", () => {
  const root = mkdtempSync(join(tmpdir(), "layered-prompt-tamper-root-"));
  const projectDir = join(root, "repos", "remudero", "learnings");
  mkdirSync(projectDir, { recursive: true });
  const userDir = userOverallLearningsHome(baseConfig({ root }));
  mkdirSync(userDir, { recursive: true });
  const globalDir = globalLearningsHome(baseConfig({ root }));
  mkdirSync(globalDir, { recursive: true });

  writeShard(projectDir, "shard.yaml", [
    entry({ id: "p-fact", layer: "project", fact: "PROJECT-LAYER FACT", files: ["src/lib/learnings.ts"] }),
  ]);
  writeShard(userDir, "shard.yaml", [
    entry({ id: "u-fact", layer: "user-overall", fact: "USER-OVERALL-LAYER FACT", files: ["src/lib/learnings.ts"] }),
  ]);
  const goodGlobalEntries = [
    entry({ id: "g-fact", layer: "global", fact: "GLOBAL-LAYER FACT", files: ["src/lib/learnings.ts"] }),
  ];
  const correctHash = computeArtifactHash(goodGlobalEntries);
  // Tamper AFTER hashing, keeping the stale (now-mismatched) hash — a corrupted/forged pull.
  const tamperedEntries = [{ ...goodGlobalEntries[0], fact: "INJECTED GLOBAL FACT (should never inject)" }];
  const path = globalArtifactPath(baseConfig({ root }));
  writeFileSync(path, JSON.stringify({ version: "v1", hash: correctHash, entries: tamperedEntries }));

  const t = task();
  const { entries, globalRefusedReason } = loadLayeredLearningsForTaskFiles(
    { projectDir, userOverallDir: userDir, globalArtifactPath: path },
    t.files,
  );
  assert.match(globalRefusedReason ?? "", /hash mismatch/);
  assert.deepEqual(entries.map((e) => e.id), ["p-fact", "u-fact"], "tampered global never reaches the merged corpus");

  const { selected } = selectLearnings(entries, t.files);
  const matchedLearnings = renderMatchedLearnings(selected);
  const prompt = renderImplementPrompt(t, "", "run-1", matchedLearnings);

  assert.ok(prompt.includes("PROJECT-LAYER FACT"), "project layer still bundles into the assembled prompt");
  assert.ok(prompt.includes("USER-OVERALL-LAYER FACT"), "user-overall layer still bundles into the assembled prompt");
  assert.ok(!prompt.includes("GLOBAL-LAYER FACT"), "a tampered global fact must never reach the assembled prompt");
  assert.ok(
    !prompt.includes("INJECTED GLOBAL FACT"),
    "the falsifier: a hash-mismatched artifact's content must never be silently trusted into a prompt",
  );
  assert.doesNotThrow(() => assertProvenance(prompt), "the assembled prompt (minus the refused layer) is still provenance-clean");
});
