/**
 * test/a-fact-shows-its-freshness.test.ts — W1-T4681.
 *
 * "65 of 85 learnings can never be re-verified": most entries carry neither an `assertion:` a
 * gardener can re-run nor a `origin:` span `attestLearningOrigin` can hash-compare, so most facts
 * have no deterministic way to confirm they still hold. Rather than invent a fixed cutoff (an
 * arbitrary "N days old" or "N commits" rule — wrong in either direction for a quiet file vs. a
 * churny one), `computeEntryChurn`/`computeCorpusChurn` count commits touching a fact's own
 * `files:` since the date it was last `cited` (its earned date), and `renderFreshnessNote` ranks
 * that count against the rest of the corpus. A fact is NEVER dropped or down-weighted for churn —
 * only annotated — so a worker who reads it knows to verify first.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  computeCorpusChurn,
  computeEntryChurn,
  renderFreshnessNote,
  renderMatchedLearnings,
  VERIFY_FIRST_NOTE,
  type ChurnCommitReader,
  type LearningEntry,
} from "../src/lib/learnings.js";
import { gitRepo } from "./helpers/git-repo.js";

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

test('W1-T4681: a fact whose files changed since it was earned carries a verify-first note', () => {
  const touched = entry("touched");
  const readChurnCommits: ChurnCommitReader = (_repoDir, files) =>
    files.includes("src/lib/x.ts") ? 3 : 0;

  const churn = computeEntryChurn(touched, "/repo", readChurnCommits);
  assert.equal(churn, 3);

  const corpusChurn = computeCorpusChurn([touched], "/repo", readChurnCommits);
  assert.equal(corpusChurn["touched"], 3);

  const note = renderFreshnessNote("touched", corpusChurn);
  assert.match(note, new RegExp(VERIFY_FIRST_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const rendered = renderMatchedLearnings([touched], corpusChurn);
  assert.match(rendered, new RegExp(VERIFY_FIRST_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(rendered, /\[src: learnings#touched\]/);
});

test('W1-T4681: a fact untouched since it was earned carries none', () => {
  const untouched = entry("untouched");
  const readChurnCommits: ChurnCommitReader = () => 0;

  const churn = computeEntryChurn(untouched, "/repo", readChurnCommits);
  assert.equal(churn, 0);

  const corpusChurn = computeCorpusChurn([untouched], "/repo", readChurnCommits);
  const note = renderFreshnessNote("untouched", corpusChurn);
  assert.equal(note, "");

  const rendered = renderMatchedLearnings([untouched], corpusChurn);
  assert.doesNotMatch(rendered, /verify first/);
  assert.equal(rendered, `- ${untouched.fact} [src: learnings#untouched]`);
});

test("W1-T4681: churn is ranked against the rest of the corpus, never a fixed cutoff", () => {
  const low = entry("low");
  const high = entry("high");
  const readChurnCommits: ChurnCommitReader = (_repoDir, files) =>
    files[0] === "src/lib/x.ts" ? 1 : 0;
  // Both entries share the same glob here on purpose: give them distinct counts directly instead.
  const corpusChurn = { low: 1, high: 9 };

  const lowNote = renderFreshnessNote("low", corpusChurn);
  const highNote = renderFreshnessNote("high", corpusChurn);
  assert.match(lowNote, /verify first/);
  assert.match(highNote, /verify first/);
  // The high-churn fact ranks above the one other changed fact; the low-churn one ranks above none.
  assert.match(highNote, /higher churn than 1\/1 other changed facts/);
  assert.match(lowNote, /higher churn than 0\/1 other changed facts/);
  void readChurnCommits;
});

test("W1-T4681: an entry with no cited date has unknowable churn, not zero-guessed danger", () => {
  const neverCited = entry("never-cited", { cited: undefined });
  const readChurnCommits: ChurnCommitReader = () => 7; // would be "high" if consulted at all
  const churn = computeEntryChurn(neverCited, "/repo", readChurnCommits);
  assert.equal(churn, 0);
});

test("W1-T4681: the default churn reader counts real commits on a fact's files since it was earned", () => {
  const repo = gitRepo({ seedCommit: false, kind: "churn" });
  mkdirSync(join(repo.dir, "src"));
  for (const file of ["src/x.ts", "src/x.ts", "src/other.ts"]) {
    writeFileSync(join(repo.dir, file), `${Math.random()}\n`);
    repo.git("add", file);
    repo.git("commit", "--quiet", "-m", `touch ${file}`);
  }
  const earlier = entry("earlier", { files: ["src/x.ts"], cited: "2000-01-01" });
  assert.equal(computeEntryChurn(earlier, repo.dir), 2);
  assert.deepEqual(computeCorpusChurn([earlier], repo.dir), { earlier: 2 });
  const untouched = entry("untouched", { files: ["src/never-committed.ts"], cited: "2000-01-01" });
  assert.equal(computeEntryChurn(untouched, repo.dir), 0);
});

test("W1-T4681: the default churn reader reads an unreadable repository as unknowable churn, zero", () => {
  const missing = join(tmpdir(), "churn-no-such-repo-w1-t4681");
  assert.equal(computeEntryChurn(entry("unreadable"), missing), 0);
});
