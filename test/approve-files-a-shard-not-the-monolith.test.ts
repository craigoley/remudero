import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { approveProposal, ratificationShardFiles, writeRatificationShards } from "../src/lib/inbox.js";
import type { DraftedCandidate, InboxClassification, RatifyGateway } from "../src/lib/inbox.js";

// ── The ratification path filed into the monolith, and lint-plan forbids it ────────────────────
//
// `lint-plan`'s `monolith-filing` rule refuses a NEW id filed into plan/tasks.yaml in as many
// words: "New tasks belong in their own shard". The ratification write site was the last one still
// appending there, and it had NEVER met the gate — no proposal had ever been ratified (0
// `ratify.approved` rows before 2026-08-29), so the very first successful approve came back
// `lint-plan failure` on its own filing, and every READY proposal would have failed identically.
//
// These tests drive the real composer and the real `approveProposal`, and the monolith assertion is
// made by BYTE COMPARISON of plan/tasks.yaml before and after — not by inspecting what the code
// meant to do.

const BOARD_REVIEW_ID = "board-review:escalation:#3039";

function draft(fragmentYaml: string): DraftedCandidate {
  return {
    proposalId: BOARD_REVIEW_ID,
    fragmentYaml,
    stampLine: `- ${BOARD_REVIEW_ID} (plan) — RATIFIED 2026-08-29 -> W1-T2451.`,
    anchorFingerprint: "landed::MASTER-PLAN.md",
  };
}

const ONE_TASK = '- id: W1-T2451\n  title: "Evidence anchors expire and nothing re-reads them"\n  repo: remudero\n';
const TWO_TASKS =
  ONE_TASK + '- id: W1-T2452\n  title: "The second drafted task, filed beside the first"\n  repo: remudero\n';

test("ratificationShardFiles: one drafted task yields one plan/tasks.d shard named <id>-<kebab-slug>.yaml, holding a single-element list", () => {
  const r = ratificationShardFiles(ONE_TASK);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].relPath, "plan/tasks.d/W1-T2451-evidence-anchors-expire-and-nothing-re-reads-them.yaml");
  // A SINGLE-ELEMENT list: exactly one top-level "- " entry, and the authored text is verbatim.
  assert.equal(r.files[0].contents.split("\n").filter((l) => /^- /.test(l)).length, 1);
  assert.match(r.files[0].contents, /^- id: W1-T2451\n {2}title: "Evidence anchors expire/);
});

test("ratificationShardFiles: N drafted tasks yield N shards, one per id — the plural the write site used to collapse into one append", () => {
  const r = ratificationShardFiles(TWO_TASKS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.files.length, 2, "two drafted tasks must produce two files");
  assert.deepEqual(
    r.files.map((f) => f.relPath),
    [
      "plan/tasks.d/W1-T2451-evidence-anchors-expire-and-nothing-re-reads-them.yaml",
      "plan/tasks.d/W1-T2452-the-second-drafted-task-filed-beside-the-first.yaml",
    ],
  );
  // Each file holds ONLY its own task — a shard carrying both would re-create the monolith under
  // a different name and `lint-plan` would refuse the second id just as it refused the first.
  assert.match(r.files[0].contents, /W1-T2451/);
  assert.doesNotMatch(r.files[0].contents, /W1-T2452/);
  assert.doesNotMatch(r.files[1].contents, /W1-T2451/);
});

test("ratificationShardFiles: a block with no readable id REFUSES rather than filing under a guessed name", () => {
  const r = ratificationShardFiles("- title: no id at all\n  repo: remudero\n");
  if (r.ok) {
    assert.fail("a block with no id must refuse, not file a shard under a guessed name");
  }
  assert.match(r.reason, /no readable/);
});

test("ratificationShardFiles: an empty fragment refuses, and a fragment that does not start with a top-level entry refuses too", () => {
  const empty = ratificationShardFiles("   \n");
  assert.equal(empty.ok, false);
  const indented = ratificationShardFiles("  id: W1-T2451\n");
  assert.equal(indented.ok, false);
});

test("ratificationShardFiles: the slug is the SHARED one, so a title with punctuation and case lands on the same rule the 695 existing shards follow", () => {
  const r = ratificationShardFiles('- id: W1-T2451\n  title: "Mixed CASE, punctuation! and   spaces"\n');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.files[0].relPath, "plan/tasks.d/W1-T2451-mixed-case-punctuation-and-spaces.yaml");
});

test("a driven approveProposal writes a plan/tasks.d shard and leaves plan/tasks.yaml BYTE-IDENTICAL", () => {
  const worktree = mkdtempSync(join(tmpdir(), "rmd-approve-shard-"));
  mkdirSync(join(worktree, "plan", "tasks.d"), { recursive: true });
  const monolith = join(worktree, "plan", "tasks.yaml");
  const MONOLITH_BEFORE = "- id: W1-T1\n  title: a pre-existing task\n";
  writeFileSync(monolith, MONOLITH_BEFORE, "utf8");

  const written: string[] = [];
  const gateway: RatifyGateway = {
    // The production wiring, mirrored: run-task.ts's createRatificationBranch composes with
    // ratificationShardFiles and writes each file, and never touches plan/tasks.yaml.
    createRatificationBranch(payload) {
      const shards = ratificationShardFiles(payload.fragmentYaml);
      if (!shards.ok) throw new Error(`the composer refused a valid fragment: ${shards.reason}`);
      for (const f of shards.files) {
        writeFileSync(join(worktree, f.relPath), f.contents, "utf8");
        written.push(f.relPath);
      }
      return "run-APPROVE-board-review-escalation-3039-1-abc123def456";
    },
    openPlanPr() {
      return "https://github.com/craigoley/remudero/pull/9001";
    },
  };

  const classification: InboxClassification = {
    proposalId: BOARD_REVIEW_ID,
    state: "ready",
    reasons: [],
    draft: draft(ONE_TASK),
    draftStale: false,
  };
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-approve-shard-ledger-")), "ledger.ndjson");
  const result = approveProposal(classification, gateway, { ledgerPath, runId: `APPROVE-${BOARD_REVIEW_ID}-1` });

  assert.equal(result.ok, true);
  assert.deepEqual(written, ["plan/tasks.d/W1-T2451-evidence-anchors-expire-and-nothing-re-reads-them.yaml"]);
  // THE ASSERTION THAT MATTERS, made by bytes rather than by intent: the monolith is untouched.
  assert.equal(readFileSync(monolith, "utf8"), MONOLITH_BEFORE, "plan/tasks.yaml must be byte-identical after a ratification");
  assert.match(readFileSync(join(worktree, written[0]), "utf8"), /^- id: W1-T2451/);
});

// ── The write itself, driven through the extracted seam ────────────────────────────────────────
//
// `createRatificationBranch` needs a real worktree, a real mint and real id reservations to run,
// so the write loop is unreachable by a test while it lives inline there. These drive
// `writeRatificationShards` directly, which is the function the gateway now calls.

function recordingFs() {
  const dirs: string[] = [];
  const files: Array<{ path: string; data: string }> = [];
  return {
    dirs,
    files,
    fs: {
      mkdirSync: (d: string) => dirs.push(d),
      writeFileSync: (p: string, data: string) => files.push({ path: p, data }),
    },
  };
}

const joinSlash = (...parts: string[]) => parts.join("/");

test("writeRatificationShards: creates plan/tasks.d and writes one file per drafted task, returning the repo-relative paths", () => {
  const r = recordingFs();
  const paths = writeRatificationShards("/wt", TWO_TASKS, BOARD_REVIEW_ID, r.fs, joinSlash);
  assert.deepEqual(r.dirs, ["/wt/plan/tasks.d"], "the shard directory is created exactly once");
  assert.deepEqual(
    r.files.map((f) => f.path),
    [
      "/wt/plan/tasks.d/W1-T2451-evidence-anchors-expire-and-nothing-re-reads-them.yaml",
      "/wt/plan/tasks.d/W1-T2452-the-second-drafted-task-filed-beside-the-first.yaml",
    ],
  );
  assert.deepEqual(paths, [
    "plan/tasks.d/W1-T2451-evidence-anchors-expire-and-nothing-re-reads-them.yaml",
    "plan/tasks.d/W1-T2452-the-second-drafted-task-filed-beside-the-first.yaml",
  ]);
  // NOT ONE BYTE TO THE MONOLITH — asserted on the write log, so a stray append cannot hide.
  assert.equal(r.files.some((f) => f.path.includes("tasks.yaml")), false);
});

test("writeRatificationShards: a fragment it cannot name THROWS before any write — no partial filing reaches the worktree", () => {
  const r = recordingFs();
  assert.throws(
    () => writeRatificationShards("/wt", "- title: no id\n", BOARD_REVIEW_ID, r.fs, joinSlash),
    /refusing to file board-review:escalation:#3039/,
  );
  assert.deepEqual(r.files, [], "nothing may be written when the composer refuses");
  assert.deepEqual(r.dirs, [], "not even the directory — the refusal precedes every effect");
});
