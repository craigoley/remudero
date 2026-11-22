/**
 * test/a-fact-shows-its-freshness.test.ts — W1-T4681.
 *
 * "65 of 85 learnings can never be re-verified": most entries carry neither an `assertion:` a
 * gardener can re-run nor a `origin:` span `attestLearningOrigin` can hash-compare, so most facts
 * have no deterministic way to confirm they still hold. Rather than invent a fixed cutoff (an
 * arbitrary "N days old" or "N commits" rule — wrong in either direction for a quiet file vs. a
 * churny one), source-change observations count commits touching a fact's own
 * `files:` since the date it was last cited, and `renderFreshnessNote` ranks
 * that count against other measured facts. A fact is NEVER dropped or down-weighted for churn —
 * only annotated — so a worker who reads it knows to verify first.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LoopBoundedChildTimeout } from "#src/lib/loop-bounded-child.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";

import {
  budgetLearningSourceChangeNotes,
  computeCorpusChurn,
  computeEntryChurn,
  observeLearningSourceChanges,
  renderFreshnessNote,
  renderMatchedLearnings,
  VERIFY_FIRST_NOTE,
  type LearningEntry,
  type LearningSourceChangeInput,
} from "#src/lib/learnings.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

function entry(id: string, overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id,
    subsystem: "t",
    lifecycle: "active",
    files: ["src/lib/x.ts"],
    fact: `fact ${id}`,
    src: "t",
    cited: "2026-01-01",
    ...overrides,
  };
}

test("W1-T4681: a fact whose files changed since it was earned carries a verify-first note", () => {
  const touched = entry("touched");
  const { notes } = budgetLearningSourceChangeNotes([touched], {
    version: "learning-source-change-v1", facts: new Map([["touched", { kind: "measured", commits: 3 }]]),
  }, Buffer.byteLength(renderMatchedLearnings([touched])), 1024);
  const rendered = renderMatchedLearnings([touched], notes);
  assert.ok(rendered.includes(VERIFY_FIRST_NOTE));
  assert.match(rendered, /3 commits since last citation/);
  assert.match(rendered, /\[src: learnings#touched\]/);
});

test("W1-T4681: a fact untouched since it was earned carries none", () => {
  const untouched = entry("untouched");
  const note = renderFreshnessNote("untouched", { untouched: 0 });
  assert.equal(note, "");

  const rendered = renderMatchedLearnings([untouched]);
  assert.doesNotMatch(rendered, /verify first/);
  assert.equal(rendered, `- ${untouched.fact} [src: learnings#untouched]`);
});

test("W1-T4681: churn is ranked against the rest of the corpus, never a fixed cutoff", () => {
  const corpusChurn = { low: 1, high: 9 };

  const lowNote = renderFreshnessNote("low", corpusChurn);
  const highNote = renderFreshnessNote("high", corpusChurn);
  assert.match(lowNote, /verify first/);
  assert.match(highNote, /verify first/);
  // The high-churn fact ranks above the one other changed fact; the low-churn one ranks above none.
  assert.match(highNote, /higher churn than 1\/1 other changed facts/);
  assert.match(lowNote, /higher churn than 0\/1 other changed facts/);
});

test("W1-T4681: an entry with no cited date has unknowable churn, not zero-guessed danger", async () => {
  const neverCited = entry("never-cited", { cited: undefined });
  const observation = await observeLearningSourceChanges([neverCited], {
    repoDir: "/repo", readGit: () => assert.fail("missing anchor started Git"),
  });
  assert.deepEqual(observation.facts.get(neverCited.id), { kind: "unknown", reason: "missing-anchor" });
});

const observationTime = Date.parse("2026-01-06T00:00:00Z");

function commitAt(repo: GitRepo, date: string, message: string): void {
  repo.git("add", "-A");
  childProcess.execFileSync("git", ["-C", repo.dir, "-c", "user.name=Source change fixture",
    "-c", "user.email=fixture@example.invalid", "commit", "-qm", message], {
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

test("W1-T4681: the default churn reader counts real commits on a fact's files since it was earned", async (t) => {
  const repo = gitRepo({ seedCommit: false, kind: "churn" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "src"));
  const files = ["src/x.ts", "src/x.ts", "src/other.ts"];
  for (const [index, file] of files.entries()) {
    writeFileSync(join(repo.dir, file), String(index));
    commitAt(repo, "2026-01-03T12:00:00Z", `touch ${file}`);
  }
  const earlier = entry("earlier", { files: ["src/x.*"] });
  const missing = entry("missing", { files: ["src/never-committed.ts"] });
  assert.deepEqual(computeCorpusChurn([earlier], repo.dir), { earlier: 2 });
  assert.equal(computeEntryChurn(earlier, join(repo.dir, "missing")), null);
  const observed = await observeLearningSourceChanges([earlier, missing], { repoDir: repo.dir, nowMs: observationTime });
  assert.deepEqual(observed.facts.get("earlier"), { kind: "measured", commits: 2 });
  assert.deepEqual(observed.facts.get("missing"), { kind: "unknown", reason: "unresolved-source" });
});

test("learning source-change observation keeps unknown distinct from measured zero", async (t) => {
  const repo = gitRepo({ seedCommit: false, kind: "source-change" });
  t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "old.ts"), "old\n");
  commitAt(repo, "2025-12-31T12:00:00Z", "before citation");
  const facts = [
    entry("zero", { files: ["old.ts"] }),
    entry("missing", { files: ["old.ts"], cited: undefined }),
    entry("invalid", { files: ["old.ts"], cited: "2026-02-30" }),
    entry("unresolved", { files: ["missing.ts"] }),
    entry("foreign", { files: ["old.ts"], layer: "user-overall" }),
  ];
  const observe = (repoDir = repo.dir) => observeLearningSourceChanges(facts, { repoDir, nowMs: observationTime });
  const complete = await observe();
  assert.deepEqual(complete.facts.get("zero"), { kind: "measured", commits: 0 });
  assert.deepEqual(complete.facts.get("missing"), { kind: "unknown", reason: "missing-anchor" });
  assert.deepEqual(complete.facts.get("invalid"), { kind: "unknown", reason: "invalid-anchor" });
  for (const id of ["unresolved", "foreign"]) {
    assert.deepEqual(complete.facts.get(id), { kind: "unknown", reason: "unresolved-source" });
  }
  const unreadable = await observe(join(repo.dir, "no-such-repository"));
  assert.deepEqual(unreadable.facts.get("zero"), { kind: "unknown", reason: "unreadable-history" });
  writeFileSync(join(repo.dir, "old.ts"), "uncommitted\n");
  assert.deepEqual((await observe()).facts.get("zero"), { kind: "unknown", reason: "dirty-source" });
  repo.git("checkout", "--", "old.ts");
  repo.git("update-index", "--assume-unchanged", "old.ts");
  assert.deepEqual((await observe()).facts.get("zero"), { kind: "unknown", reason: "unresolved-source" });
  repo.git("update-index", "--no-assume-unchanged", "old.ts");
  writeFileSync(join(repo.dir, ".git", "shallow"), repo.git("rev-parse", "HEAD") + "\n");
  assert.deepEqual((await observe()).facts.get("zero"), { kind: "unknown", reason: "incomplete-history" });
});

test("learning source-change observation bounds history work and source-compatible cache reuse", async (t) => {
  const facts = ["a", "b", "c"].map((id) => entry(id, { files: ["x.ts"] }));
  const source = { repoDir: "/fixture/source-cache", nowMs: observationTime };
  let head = "a".repeat(40);
  const commit = `\0${Date.parse("2026-01-03T12:00:00Z") / 1000}\0\nx.ts\0`;
  let history = commit;
  let historyReads = 0;
  const readGit: typeof hostWorktreeGitAsync = async (dir, args, opts) => {
    assert.ok((opts?.timeout ?? 0) > 0);
    assert.ok((opts?.maxBuffer ?? 0) > 0);
    switch (args[0]) {
      case "config": return "";
      case "rev-parse": return `false\n${dir}/.git\n${head}\n`;
      case "ls-tree": return `100644 blob ${head}\tx.ts\0`;
      case "ls-files": return "H x.ts\0";
      case "status": return `# branch.oid ${head}\0# branch.head main\0`;
      case "log":
        historyReads++;
        assert.match(args.find((arg) => arg.startsWith("--max-count=")) ?? "", /^--max-count=(4097|2)$/);
        return history;
      default: return assert.fail(`unexpected Git operation ${args[0]}`);
    }
  };
  const observe = (entries = facts, extra: Partial<LearningSourceChangeInput> = {}) =>
    observeLearningSourceChanges(entries, { ...source, readGit, ...extra });
  const spy = t.mock.method(childProcess, "execFileSync");
  syncBuiltinESMExports();
  let first;
  try {
    first = await observe();
    assert.equal(spy.mock.callCount(), 0, "source observation must avoid synchronous Git");
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual([...first.facts.values()], facts.map(() => ({ kind: "measured", commits: 1 })));
  assert.ok(first.captureId);
  assert.equal(historyReads, 1);
  assert.equal((await observe()).captureId, first.captureId);
  assert.equal(historyReads, 1, "same source and applicability should reuse the complete batch");
  const newAnchor = await observe([entry("a", { files: ["x.ts"], cited: "2026-01-04" }), ...facts.slice(1)]);
  assert.ok(newAnchor.captureId);
  assert.notEqual(newAnchor.captureId, first.captureId);
  assert.deepEqual(newAnchor.facts.get("a"), { kind: "measured", commits: 0 });
  const newCorpus = await observe(facts, { applicability: "different corpus revision" });
  assert.ok(newCorpus.captureId);
  assert.notEqual(newCorpus.captureId, first.captureId);
  assert.equal(historyReads, 3);
  head = "b".repeat(40);
  history += commit;
  const changed = await observe();
  assert.notEqual(changed.captureId, first.captureId);
  assert.deepEqual(changed.facts.get("a"), { kind: "measured", commits: 2 });
  const limited = await observe(facts, { commitLimit: 1 });
  assert.deepEqual([...limited.facts.values()], facts.map(() => ({ kind: "unknown", reason: "history-limit" })));

  for (const [error, reason] of [
    [new LoopBoundedChildTimeout("git", 1), "timeout"],
    [Object.assign(new Error("oversized"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), "output-limit"],
  ] as const) {
    const failed = await observe(facts, {
      applicability: reason,
      readGit: (dir: string, args: readonly string[], opts: Parameters<typeof readGit>[2]) =>
        args[0] === "log" ? Promise.reject(error) : readGit(dir, args, opts),
    });
    assert.deepEqual(failed.facts.get("a"), { kind: "unknown", reason });
  }
  const truncated = await observe(facts, {
    applicability: "truncated",
    readGit: (dir, args, opts) => args[0] === "log" ? Promise.resolve(history.slice(0, -1)) : readGit(dir, args, opts),
  });
  assert.deepEqual(truncated.facts.get("a"), { kind: "unknown", reason: "incomplete-history" });
  const stale = await observe(facts, {
    readGit: async (dir: string, args: readonly string[], opts: Parameters<typeof readGit>[2]) => {
      const value = await readGit(dir, args, opts);
      return args[0] === "status" ? value.replace(/^# branch.oid [0-9a-f]+/, "# branch.oid " + "1".repeat(40)) : value;
    },
  });
  assert.deepEqual(stale.facts.get("a"), { kind: "unknown", reason: "stale-source" });
  const mirror = await observe(facts, { repoDir: "/fixture/source-cache-mirror" });
  assert.ok(mirror.captureId);
  assert.notEqual(mirror.captureId, changed.captureId);

  const pending = observe(facts, { applicability: "concurrent capture" });
  assert.deepEqual((await observe()).facts.get("a"), { kind: "unknown", reason: "busy" });
  assert.deepEqual((await pending).facts.get("a"), { kind: "measured", commits: 2 });

  for (let index = 0; index < 8; index++) await observe(facts, { applicability: String(index) });
  const readsBeforeEvicted = historyReads;
  assert.deepEqual((await observe()).facts.get("a"), { kind: "measured", commits: 2 });
  assert.equal(historyReads, readsBeforeEvicted + 1, "evicted captures are measured again");
});
