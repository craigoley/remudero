/**
 * W1-T1267: THE CITATION STAMPER HAS NO BASELINE CHECK.
 *
 * `citationStampPassFor` decides which entries are eligible from a corpus snapshot read out of
 * a private retro worktree — branched from `origin/main` at worktree-cut time and never
 * refreshed for the rest of the pass (`retroCommand` runs the Architect worker, potentially
 * minutes, BEFORE `citationStampPassFor` ever reads `learnings/`). `stampCitationInShardText`
 * writes only `cited`/`cited_count`, lines disjoint from `lifecycle:`, so a concurrent lane that
 * quarantines the SAME entry on the real `origin/main` during that span merges cleanly alongside
 * a fresh (invalid) citation stamp — git never sees a conflict because the two edits never
 * overlap.
 *
 * This file exercises the fix: `captureCitationBaselines` snapshots each changed id's block at
 * plan time, and `stampCitationsAndCommit` compares it to a FRESH read (injected here — design
 * vi: "drive it by mutating the shard on disk between the two halves") immediately before
 * writing, refusing (never retrying) any id whose block moved outside the two stamped lines.
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
  captureCitationBaselines,
  compareCitationBaseline,
  extractEntryBlock,
  stampCitationsAndCommit,
  type CitationStamp,
} from "../src/lib/retro.js";

function gitEnv() {
  return { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
}

const SHARD_A = [
  "- id: entry-a",
  "  subsystem: test",
  "  lifecycle: active",
  "  files: [x]",
  "  fact: fact for entry-a",
  "  src: test",
  '  cited: "2026-07-14"',
  "",
].join("\n");

const SHARD_A_QUARANTINED = SHARD_A.replace("lifecycle: active", "lifecycle: quarantined");

const SHARD_B = [
  "- id: entry-b",
  "  subsystem: test",
  "  lifecycle: active",
  "  files: [y]",
  "  fact: fact for entry-b",
  "  src: test",
  '  cited: "2026-07-14"',
  "",
].join("\n");

const STAMP_A: CitationStamp = { cited: "2026-08-23T00:00:00.000Z", citedCount: 4 };
const STAMP_B: CitationStamp = { cited: "2026-08-23T00:00:00.000Z", citedCount: 9 };

/** A real temp git repo (`learnings/a.yaml` [+ `learnings/b.yaml`]) — a real corpus on real
 *  disk, the same fixture shape citation-stamp-wiring.test.ts's own `makeCorpusWorktree` uses,
 *  so `captureCitationBaselines`/`stampCitationsAndCommit` operate on real files, not stubs. */
function makeWorktree(shards: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rmd-citation-baseline-")));
  const env = gitEnv();
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8", env });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "learnings"), { recursive: true });
  for (const [filename, text] of Object.entries(shards)) writeFileSync(join(dir, "learnings", filename), text);
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed corpus");
  return dir;
}

// ── claim: "an entry whose block is unchanged between the eligibility decision and the write is
//    still stamped" ────────────────────────────────────────────────────────────────────────────

test("an entry whose block is unchanged between the eligibility decision and the write is still stamped", () => {
  const dir = makeWorktree({ "a.yaml": SHARD_A });
  const changed = new Map([["entry-a", STAMP_A]]);
  // "at plan time" (design ii) — captured from the exact same on-disk state changed was decided
  // from, before any drift.
  const baselines = captureCitationBaselines(join(dir, "learnings"), changed.keys());
  assert.equal(baselines.size, 1);

  const result = stampCitationsAndCommit({
    worktreePath: dir,
    learningsDir: join(dir, "learnings"),
    changed,
    baselines,
    readFreshShardText: () => SHARD_A, // origin/main reports the identical block — no drift
  });
  assert.equal(result.committed, true);
  assert.deepEqual(result.stampedIds, ["entry-a"]);
  assert.deepEqual(result.refused, []);

  const after = readFileSync(join(dir, "learnings", "a.yaml"), "utf8");
  assert.match(after, /cited_count: 4/);
  assert.match(after, /cited: "2026-08-23T00:00:00\.000Z"/);
});

// ── claim: "an entry whose lifecycle flipped after the eligibility decision is refused and left
//    byte-identical on disk" ───────────────────────────────────────────────────────────────────

test("an entry whose lifecycle flipped after the eligibility decision is refused and left byte-identical on disk", () => {
  const dir = makeWorktree({ "a.yaml": SHARD_A });
  const changed = new Map([["entry-a", STAMP_A]]);
  const baselines = captureCitationBaselines(join(dir, "learnings"), changed.keys());
  const before = readFileSync(join(dir, "learnings", "a.yaml"), "utf8");

  const result = stampCitationsAndCommit({
    worktreePath: dir,
    learningsDir: join(dir, "learnings"),
    changed,
    baselines,
    // Simulates a concurrent lane quarantining this entry on the REAL origin/main during the
    // worker span — design (vi)'s "mutate the shard on disk between the two halves", driven here
    // via the injected reader rather than a real remote.
    readFreshShardText: () => SHARD_A_QUARANTINED,
  });
  assert.equal(result.committed, false, "no commit — the only changed id was refused");
  assert.deepEqual(result.stampedIds, []);
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].id, "entry-a");

  const after = readFileSync(join(dir, "learnings", "a.yaml"), "utf8");
  assert.equal(after, before, "a refused entry must be left byte-identical on disk");
});

// ── claim: "the refusal names the id and the field that moved, not merely that something
//    changed" ──────────────────────────────────────────────────────────────────────────────────

test("the refusal names the id and the field that moved, not merely that something changed", () => {
  const dir = makeWorktree({ "a.yaml": SHARD_A });
  const changed = new Map([["entry-a", STAMP_A]]);
  const baselines = captureCitationBaselines(join(dir, "learnings"), changed.keys());

  const result = stampCitationsAndCommit({
    worktreePath: dir,
    learningsDir: join(dir, "learnings"),
    changed,
    baselines,
    readFreshShardText: () => SHARD_A_QUARANTINED,
  });
  assert.equal(result.refused.length, 1);
  const [refusal] = result.refused;
  assert.equal(refusal.id, "entry-a");
  assert.equal(refusal.field, "lifecycle", "must name the SPECIFIC field, not a generic 'entry changed'");
  assert.equal(refusal.before, "lifecycle: active");
  assert.equal(refusal.after, "lifecycle: quarantined");

  // A different field moving is named correctly too — the comparator isn't hardcoded to
  // "lifecycle" specifically (exercised directly against compareCitationBaseline, no I/O).
  const baseline = extractEntryBlock(SHARD_A, "entry-a")!;
  const freshWithSubsystemMoved = extractEntryBlock(SHARD_A.replace("subsystem: test", "subsystem: other"), "entry-a");
  const subsystemMismatch = compareCitationBaseline("entry-a", baseline, freshWithSubsystemMoved);
  assert.ok(subsystemMismatch);
  assert.equal(subsystemMismatch!.field, "subsystem");
  assert.equal(subsystemMismatch!.before, "subsystem: test");
  assert.equal(subsystemMismatch!.after, "subsystem: other");

  // And an unchanged block never produces a refusal at all — this isn't a comparator that always
  // fires.
  assert.equal(compareCitationBaseline("entry-a", baseline, extractEntryBlock(SHARD_A, "entry-a")), undefined);
});

// ── claim: "a refused entry drops for the cycle without retrying, waiting, or blocking the other
//    stamps in the same pass" ─────────────────────────────────────────────────────────────────

test("a refused entry drops for the cycle without retrying, waiting, or blocking the other stamps in the same pass", () => {
  const dir = makeWorktree({ "a.yaml": SHARD_A, "b.yaml": SHARD_B });
  const changed = new Map([
    ["entry-a", STAMP_A],
    ["entry-b", STAMP_B],
  ]);
  const baselines = captureCitationBaselines(join(dir, "learnings"), changed.keys());
  assert.equal(baselines.size, 2);

  let calls = 0;
  const result = stampCitationsAndCommit({
    worktreePath: dir,
    learningsDir: join(dir, "learnings"),
    changed,
    baselines,
    readFreshShardText: (relPath) => {
      calls++;
      // entry-a's shard: quarantined on origin/main mid-span. entry-b's shard: untouched.
      return relPath.endsWith("a.yaml") ? SHARD_A_QUARANTINED : SHARD_B;
    },
  });

  assert.equal(calls, 2, "one fresh read per shard file that needed a baseline check — no retry loop");
  assert.equal(result.committed, true, "entry-b's stamp still commits despite entry-a's refusal");
  assert.deepEqual(result.stampedIds, ["entry-b"]);
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].id, "entry-a");

  const aAfter = readFileSync(join(dir, "learnings", "a.yaml"), "utf8");
  assert.equal(aAfter, SHARD_A, "the refused shard is untouched");
  const bAfter = readFileSync(join(dir, "learnings", "b.yaml"), "utf8");
  assert.match(bAfter, /cited_count: 9/, "the unrefused shard still stamps in the SAME pass");

  // A second call with the identical (still-mismatched) baseline/fresh pair refuses again rather
  // than blocking or looping — nothing here waits or retries within stampCitationsAndCommit
  // itself; the next retro cycle is what re-derives fresh evidence (design iv).
  const second = stampCitationsAndCommit({
    worktreePath: dir,
    learningsDir: join(dir, "learnings"),
    changed: new Map([["entry-a", STAMP_A]]),
    baselines,
    readFreshShardText: () => SHARD_A_QUARANTINED,
  });
  assert.equal(second.committed, false);
  assert.equal(second.refused.length, 1);
});

// ── claim: "the stamper's on-disk output format is unchanged for the entries that do stamp, and
//    no entry is added, removed or relifecycled" ─────────────────────────────────────────────

test("the stamper's on-disk output format is unchanged for the entries that do stamp, and no entry is added, removed or relifecycled", () => {
  const dir = makeWorktree({ "a.yaml": SHARD_A, "b.yaml": SHARD_B });
  const changed = new Map([
    ["entry-a", STAMP_A],
    ["entry-b", STAMP_B],
  ]);
  const baselines = captureCitationBaselines(join(dir, "learnings"), changed.keys());

  const result = stampCitationsAndCommit({
    worktreePath: dir,
    learningsDir: join(dir, "learnings"),
    changed,
    baselines,
    readFreshShardText: (relPath) => (relPath.endsWith("a.yaml") ? SHARD_A_QUARANTINED : SHARD_B),
  });
  assert.equal(result.committed, true);

  // entry-b: surgical two-line edit, exactly stampCitationInShardText's own documented format —
  // present the same guard doesn't change the write shape for an entry it lets through.
  const bAfter = readFileSync(join(dir, "learnings", "b.yaml"), "utf8");
  assert.match(
    bAfter,
    /- id: entry-b\n {2}subsystem: test\n {2}lifecycle: active\n {2}files: \[y\]\n {2}fact: fact for entry-b\n {2}src: test\n {2}cited: "2026-08-23T00:00:00\.000Z"\n {2}cited_count: 9\n/,
  );

  // entry-a: refused, so its shard — including its (still-locally-active) lifecycle line — is
  // completely untouched; the guard never itself writes a lifecycle change, promotion, or
  // retirement, only ever a refusal.
  const aAfter = readFileSync(join(dir, "learnings", "a.yaml"), "utf8");
  assert.equal(aAfter, SHARD_A);
  assert.match(aAfter, /lifecycle: active/);

  // No entry added or removed from either shard — same two `- id:` blocks, nothing more.
  assert.equal((aAfter.match(/^- id: /gm) ?? []).length, 1);
  assert.equal((bAfter.match(/^- id: /gm) ?? []).length, 1);
});

// ── control: deleting the guard (no baselines supplied) makes the SAME "quarantined on main"
//    fixture stamp anyway — proving the refusal above is load-bearing, not a fixture testing
//    itself (design vi) ────────────────────────────────────────────────────────────────────────

test("without a baseline, the identical mid-span mutation is stamped anyway — the guard, not incidental plumbing, is what refuses", () => {
  const dir = makeWorktree({ "a.yaml": SHARD_A });
  const changed = new Map([["entry-a", STAMP_A]]);

  const result = stampCitationsAndCommit({
    worktreePath: dir,
    learningsDir: join(dir, "learnings"),
    changed,
    // No `baselines` at all — the exact same "fresh" reader that triggered a refusal above is
    // wired up here too, but with nothing to compare it against the guard never engages.
    readFreshShardText: () => SHARD_A_QUARANTINED,
  });
  assert.equal(result.committed, true);
  assert.deepEqual(result.stampedIds, ["entry-a"]);
  assert.deepEqual(result.refused, []);
});
