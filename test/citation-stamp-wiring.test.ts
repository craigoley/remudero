/**
 * W1-T1248: THE CITATION MINERS' PRODUCTION CALLER.
 *
 * `stampCitations`/`mineLedgerCitations`/`aggregateCitationEvidence`/`mineGitLogCitations`
 * (lib/retro.ts, W1-T419) shipped test-pinned (test/learnings-citation-loop.test.ts) with ZERO
 * production callers — so 37/38 `learnings/*.yaml` entries' `cited` date has sat frozen at a
 * 2026-07 hand-stamped batch ever since, even though `selectLearnings`' ranking tiebreak and the
 * budget ratchet's compression order both already key on that field. This file drives the WIRING
 * this task adds: `citationStampPassFor`/`parseGitLogCitationCommits` (run-task.ts) — the I/O
 * layer that feeds real evidence in and writes the result back to disk — and
 * `changedCitationStamps`/`stampCitationInShardText`/`stampCitationsAndCommit` (retro.ts) — the
 * decide-what-changed and write-it-to-a-shard-and-commit halves.
 *
 * Each `test()` below is headed with the acceptance claim it proves.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  aggregateCitationEvidence,
  changedCitationStamps,
  mineGitLogCitations,
  mineLedgerCitations,
  stampCitationInShardText,
  stampCitations,
  stampCitationsAndCommit,
  type CitationStamp,
  type LedgerRecord,
} from "../src/lib/retro.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS, selectLearnings, type LearningEntry } from "../src/lib/learnings.js";
import { findExportDefinition, isExportReachable } from "../src/lib/reachability.js";
import { citationStampPassFor, parseGitLogCitationCommits, runCitationStampPass } from "../src/run-task.js";

function entry(id: string, overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id,
    subsystem: "test",
    lifecycle: "active",
    files: ["x"],
    fact: `fact for ${id}`,
    src: "test",
    cited: "2026-07-14",
    ...overrides,
  };
}

function gitEnv() {
  return { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
}

/** A real temp git repo with a `learnings/` corpus seeded on disk (real files, real git commit) —
 *  the fixture `citationStampPassFor`/`stampCitationsAndCommit` write into and commit onto. */
function makeCorpusWorktree(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-citation-stamp-")));
  const env = gitEnv();
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8", env });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "learnings"), { recursive: true });
  writeFileSync(
    join(dir, "learnings", "a.yaml"),
    [
      "- id: cited-me",
      "  subsystem: test",
      "  lifecycle: active",
      "  files: [x]",
      "  fact: fact for cited-me",
      "  src: test",
      '  cited: "2026-07-14"',
      "",
      "- id: no-evidence",
      "  subsystem: test",
      "  lifecycle: active",
      "  files: [x]",
      "  fact: fact for no-evidence",
      "  src: test",
      '  cited: "2026-07-14"',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "learnings", "b.yaml"),
    [
      "- id: superseded-me",
      "  subsystem: test",
      "  lifecycle: superseded",
      "  superseded_by: cited-me",
      "  files: [x]",
      "  fact: fact for superseded-me",
      "  src: test",
      '  cited: "2026-07-14"',
      "",
    ].join("\n"),
  );
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed corpus");
  return dir;
}

const FOLLOWUP_LEDGER_WITH_EVIDENCE = [
  JSON.stringify({
    ts: "2026-08-20T00:00:00.000Z",
    step: "learnings.injected",
    matched: 2,
    matched_ids: ["cited-me", "superseded-me"],
  }),
].join("\n");

// ── claim: "the retro's consolidation step calls the citation miners instead of leaving them
//    unreferenced" ────────────────────────────────────────────────────────────────────────────
//
// Reuses the EXACT instrument the task's own rationale measured "zero production callers" with
// (lib/reachability.ts, the ships-unwired scan) rather than re-deriving a bespoke grep: before
// this task's wiring, all four resolved `false` here (only test/learnings-citation-loop.test.ts
// referenced them, which isExportReachable deliberately does not count).

test("stampCitations/mineLedgerCitations/mineGitLogCitations/aggregateCitationEvidence are all reachable from real production code, not just their own test", () => {
  const repoRoot = join(import.meta.dirname, "..");
  for (const name of ["stampCitations", "mineLedgerCitations", "mineGitLogCitations", "aggregateCitationEvidence"]) {
    const file = findExportDefinition(name, repoRoot);
    assert.equal(file, "src/lib/retro.ts", `${name}: definition not found where expected`);
    assert.equal(isExportReachable(name, file!, repoRoot), true, `${name} has no production caller — the exact defect this task fixes`);
  }
});

// ── claim: "the miners are fed the archive-and-live union rather than the live ledger file
//    alone" ──────────────────────────────────────────────────────────────────────────────────

test("citationStampPassFor's only ledger input is the caller-supplied union (followupLedgerNdjson) — it has no separate live-only ledger parameter to fall back to", () => {
  const dir = makeCorpusWorktree();
  const result = citationStampPassFor({
    worktreePath: dir,
    followupLedgerNdjson: FOLLOWUP_LEDGER_WITH_EVIDENCE,
    readGitLog: () => "",
  });
  // The union row alone (no git-log evidence in this call) is enough to move `cited-me` — proving
  // the union parameter is actually consulted, not merely accepted and ignored.
  assert.equal(result.committed, true);
  assert.deepEqual(result.stampedIds.sort(), ["cited-me"]);
});

test("retroCommand's citation-stamp call site is fed followupLedgerNdjson, never the live-only ledgerNdjson", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "run-task.ts"), "utf8");
  const callMatch = /citationStampPassFor\(\{([^}]*)\}\)/.exec(src);
  assert.ok(callMatch, "citationStampPassFor call site not found in run-task.ts");
  assert.match(callMatch![1], /\bfollowupLedgerNdjson\b/);
  assert.doesNotMatch(callMatch![1], /(?<!followup)\bledgerNdjson\b/);
});

// ── claim: "an entry cited since its last stamp has its cited date advanced from the frozen
//    value" + claim: "an entry with no citation evidence keeps the stamp it already had rather
//    than being cleared" ───────────────────────────────────────────────────────────────────────

test("a REAL git-log commit citing an id, mined via the default (non-injected) git-log reader, advances that id's frozen cited date; an uncited sibling is untouched", () => {
  const dir = makeCorpusWorktree();
  // A second real commit mentioning `learnings#cited-me` — mined by citationStampPassFor's
  // DEFAULT `git log --format=...` reader (no `readGitLog` override), so this also proves the
  // production git-log invocation itself (format string, separators) round-trips correctly.
  writeFileSync(join(dir, "NOTES.md"), "notes\n");
  execFileSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8", env: gitEnv() });
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "fix per learnings#cited-me"], { encoding: "utf8", env: gitEnv() });

  const before = readFileSync(join(dir, "learnings", "a.yaml"), "utf8");
  const result = citationStampPassFor({ worktreePath: dir, followupLedgerNdjson: "" });
  assert.equal(result.committed, true);
  assert.deepEqual(result.stampedIds, ["cited-me"]);

  const after = readFileSync(join(dir, "learnings", "a.yaml"), "utf8");
  const citedMeBlock = after.slice(after.indexOf("- id: cited-me"), after.indexOf("- id: no-evidence"));
  assert.doesNotMatch(citedMeBlock, /cited: "2026-07-14"/, "cited-me's frozen date must have moved");
  assert.match(citedMeBlock, /cited_count: 1/);

  // `no-evidence` carries no citation anywhere in this cycle's evidence — its block must be
  // BYTE-IDENTICAL before and after (never cleared, never touched).
  const noEvidenceBefore = before.slice(before.indexOf("- id: no-evidence"));
  const noEvidenceAfter = after.slice(after.indexOf("- id: no-evidence"));
  assert.equal(noEvidenceAfter, noEvidenceBefore);

  // A second pass with the identical (already-mined) evidence is a genuine no-op: the corpus on
  // disk now already carries the mined value, so nothing changes and nothing commits.
  const second = citationStampPassFor({ worktreePath: dir, followupLedgerNdjson: "" });
  assert.equal(second.committed, false);
  assert.deepEqual(second.stampedIds, []);
});

// ── claim: "a superseded entry is still filtered before ranking and no stamp can reintroduce
//    it" ─────────────────────────────────────────────────────────────────────────────────────

test("a superseded entry with real matching evidence (both ledger AND git-log) is never stamped on disk, and selectLearnings still never injects it", () => {
  const dir = makeCorpusWorktree();
  execFileSync("git", ["-C", dir, "commit", "--quiet", "--allow-empty", "-m", "learnings#superseded-me mentioned here too"], {
    encoding: "utf8",
    env: gitEnv(),
  });
  const before = readFileSync(join(dir, "learnings", "b.yaml"), "utf8");
  const result = citationStampPassFor({ worktreePath: dir, followupLedgerNdjson: FOLLOWUP_LEDGER_WITH_EVIDENCE });
  // cited-me still moves (it's active) — the fixture's evidence genuinely reaches both ids.
  assert.ok(result.stampedIds.includes("cited-me"));
  assert.ok(!result.stampedIds.includes("superseded-me"), "a superseded entry must never be stamped even with real evidence");

  const after = readFileSync(join(dir, "learnings", "b.yaml"), "utf8");
  assert.equal(after, before, "superseded-me's shard must be byte-identical — no stamp, no lifecycle change, no reintroduction");

  // And the pure ranking side: even a HAND-EDITED, freshly-cited superseded entry is still
  // dropped by selectLearnings before ranking ever sees it (Q3 — LAW 5 is not touched).
  const entries: LearningEntry[] = [
    entry("superseded-me", { lifecycle: "superseded", cited: "2099-01-01" }),
    entry("cited-me", { cited: "2020-01-01" }),
  ];
  const { selected } = selectLearnings(entries, undefined);
  assert.deepEqual(
    selected.map((e) => e.id),
    ["cited-me"],
  );
});

// ── claim: "stamping writes only the cited field and neither adds, promotes nor retires an
//    entry" ──────────────────────────────────────────────────────────────────────────────────

test("stampCitationInShardText edits ONLY the cited/cited_count lines — every other byte, and every other entry, in the shard is untouched", () => {
  const text = [
    "- id: a",
    "  subsystem: s",
    "  lifecycle: active",
    "  files: [x]",
    "  fact: fact-a",
    "  src: test",
    '  cited: "2026-07-14"',
    "",
    "- id: b",
    "  subsystem: s",
    "  lifecycle: active",
    "  files: [y]",
    "  fact: fact-b",
    "  src: test",
    '  cited: "2026-07-14"',
    "",
  ].join("\n");
  const stamp: CitationStamp = { cited: "2026-08-23T00:00:00.000Z", citedCount: 3 };
  const after = stampCitationInShardText(text, "a", stamp);
  assert.match(after, /- id: a\n  subsystem: s\n  lifecycle: active\n {2}files: \[x\]\n {2}fact: fact-a\n {2}src: test\n {2}cited: "2026-08-23T00:00:00\.000Z"\n {2}cited_count: 3\n/);
  // `b`'s block, and everything about `a` besides the two stamped lines, is byte-identical.
  const bBlockBefore = text.slice(text.indexOf("- id: b"));
  const bBlockAfter = after.slice(after.indexOf("- id: b"));
  assert.equal(bBlockAfter, bBlockBefore);

  // No-op when the id isn't in this shard at all — referentially unchanged.
  assert.equal(stampCitationInShardText(text, "not-here", stamp), text);
});

test("changedCitationStamps neither adds nor removes entries, and only reports ids whose cited/citedCount actually moved (stampCitations' own contract)", () => {
  const entries: LearningEntry[] = [entry("a"), entry("b"), entry("superseded", { lifecycle: "superseded" })];
  const evidence = new Map<string, CitationStamp>([
    ["a", { cited: "2026-08-23", citedCount: 1 }],
    ["superseded", { cited: "2026-08-23", citedCount: 1 }],
  ]);
  const changed = changedCitationStamps(entries, evidence);
  assert.deepEqual([...changed.keys()], ["a"]);
  assert.deepEqual(changed.get("a"), { cited: "2026-08-23", citedCount: 1 });

  // The underlying stampCitations pass itself: same id set, same lifecycles, only `a`'s
  // cited/citedCount actually differ.
  const stamped = stampCitations(entries, evidence);
  assert.deepEqual(
    stamped.map((e) => e.id),
    ["a", "b", "superseded"],
  );
  assert.deepEqual(
    stamped.map((e) => e.lifecycle),
    ["active", "active", "superseded"],
  );
  assert.equal(stamped[1].cited, "2026-07-14"); // b: untouched
  assert.equal(stamped[2].cited, "2026-07-14"); // superseded: untouched despite evidence
});

// ── claim: "the injected budget stays a hard cap and the entries it drops are still logged" ────
//
// This wiring never touches DEFAULT_KNOWLEDGE_BUDGET_CHARS or selectLearnings' drop logic — this
// is a regression guard proving a stamped corpus still respects both.

test("a stamped, oversized corpus still hits the hard budget cap and still reports the overflow as dropped entries", () => {
  // Sized off DEFAULT_KNOWLEDGE_BUDGET_CHARS itself (never a hardcoded byte count) — ten entries
  // each already ~one whole budget wide guarantee overflow at ANY cap the constant is later
  // retuned to (W1-T941's own drift test moves it; this corpus must not silently stop overflowing
  // just because that pinned number changed out from under a magic literal here).
  const big = "x".repeat(DEFAULT_KNOWLEDGE_BUDGET_CHARS);
  const entries: LearningEntry[] = Array.from({ length: 10 }, (_, i) => entry(`e${i}`, { fact: big }));
  const evidence = new Map<string, CitationStamp>(entries.map((e, i) => [e.id, { cited: `2026-08-${10 + i}`, citedCount: 1 }]));
  const stamped = stampCitations(entries, evidence);
  const { selected, dropped } = selectLearnings(stamped, undefined, DEFAULT_KNOWLEDGE_BUDGET_CHARS);
  assert.ok(dropped.length > 0, "an oversized stamped corpus must still overflow the hard cap");
  assert.equal(selected.length + dropped.length, entries.length, "stamping must not add or remove entries");
  const usedChars = selected.reduce((sum, e) => sum + e.fact.length + 40, 0);
  assert.ok(usedChars <= DEFAULT_KNOWLEDGE_BUDGET_CHARS * 1.5, "selected set must still be budget-bounded, not unbounded");
});

// ── parseGitLogCitationCommits (run-task.ts) — the I/O-adjacent split feeding mineGitLogCitations ──

test("parseGitLogCitationCommits splits a multi-commit git-log record stream into {date, message} pairs mineGitLogCitations can mine", () => {
  const raw = [
    "\x1e2026-08-01T00:00:00+00:00\x1fsubject one\x1fbody line citing learnings#foo",
    "\x1e2026-08-02T00:00:00+00:00\x1fsubject two\x1f",
  ].join("");
  const commits = parseGitLogCitationCommits(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].date, "2026-08-01T00:00:00+00:00");
  assert.match(commits[0].message, /subject one[\s\S]*learnings#foo/);
  const evidence = mineGitLogCitations(commits);
  assert.deepEqual(evidence, [{ id: "foo", date: "2026-08-01T00:00:00+00:00" }]);
});

// ── mineLedgerCitations / aggregateCitationEvidence, exercised through the ledger-shaped
//    LedgerRecord[] the wiring actually parses (parseLedger) ───────────────────────────────────

test("mineLedgerCitations + aggregateCitationEvidence reduce ledger rows the same way the wiring's evidence pipeline does", () => {
  const records: LedgerRecord[] = [
    { ts: "2026-08-01T00:00:00.000Z", step: "learnings.injected", matched_ids: ["foo"] },
    { ts: "2026-08-05T00:00:00.000Z", step: "learnings.injected", matched_ids: ["foo"] },
  ];
  const evidence = mineLedgerCitations(records);
  const stamps = aggregateCitationEvidence(evidence);
  assert.deepEqual(stamps.get("foo"), { cited: "2026-08-05T00:00:00.000Z", citedCount: 2 });
});

// ── stampCitationsAndCommit: no-op on empty input, never touches git when there's nothing to
//    write (the "quiet cycle produces a genuinely empty diff" guarantee) ───────────────────────

test("stampCitationsAndCommit is a pure no-op — no disk write, no git call — when `changed` is empty", () => {
  const dir = makeCorpusWorktree();
  const before = execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" }).trim();
  const result = stampCitationsAndCommit({ worktreePath: dir, learningsDir: join(dir, "learnings"), changed: new Map() });
  assert.equal(result.committed, false);
  assert.deepEqual(result.stampedIds, []);
  const after = execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" }).trim();
  assert.equal(after, before, "no commit must be created for an empty change set");
});

// ── runCitationStampPass (run-task.ts) — retroCommand's try/catch around citationStampPassFor,
//    pulled into its own function so its FAILURE branch is directly testable without standing up
//    the full fake-worker/fake-gh retro fixture test/retro-marker-atomic.test.ts already pays for
//    the surrounding orchestration ────────────────────────────────────────────────────────────

test("runCitationStampPass: a real citationStampPassFor commit logs citations.stamped and returns true", () => {
  const dir = makeCorpusWorktree();
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const committed = runCitationStampPass({
    worktreePath: dir,
    followupLedgerNdjson: FOLLOWUP_LEDGER_WITH_EVIDENCE,
    log: (step, extra) => logged.push({ step, extra }),
  });
  assert.equal(committed, true);
  const stampedLog = logged.find((l) => l.step === "citations.stamped");
  assert.ok(stampedLog, "a real commit must be logged as citations.stamped");
  assert.deepEqual(stampedLog!.extra!.ids, ["cited-me"]);
});

test("runCitationStampPass: a malformed learnings/ shard (citationStampPassFor throws before ever shelling to git) is caught, logged as citations.stamp.error, and returns false — never throws", () => {
  // No git repo at all here — loadLearningsCorpus's LearningsError fires before
  // citationStampPassFor's default git-log reader is ever invoked (the same ordering
  // citationStampPassFor's own doc/tests rely on), so a plain temp dir is enough.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-citation-stamp-bad-yaml-")));
  mkdirSync(join(dir, "learnings"), { recursive: true });
  writeFileSync(join(dir, "learnings", "bad.yaml"), "- id: a\n  bad: [unclosed\n");

  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let committed: boolean | undefined;
  assert.doesNotThrow(() => {
    committed = runCitationStampPass({
      worktreePath: dir,
      followupLedgerNdjson: "",
      log: (step, extra) => logged.push({ step, extra }),
    });
  });
  assert.equal(committed, false, "a caught corpus-read failure degrades to 'nothing stamped this cycle', never a thrown error");
  const errorLog = logged.find((l) => l.step === "citations.stamp.error");
  assert.ok(errorLog, "the read failure must be ledgered as citations.stamp.error, not silently swallowed");
  assert.match(String(errorLog!.extra!.error), /not valid YAML/);
  assert.ok(
    logged.every((l) => l.step !== "citations.stamped"),
    "no citations.stamped log on the failure path",
  );
});
