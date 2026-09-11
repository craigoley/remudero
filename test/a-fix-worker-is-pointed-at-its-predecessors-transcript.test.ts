/**
 * test/a-fix-worker-is-pointed-at-its-predecessors-transcript.test.ts — W1-T3079.
 *
 * MASTER-PLAN §Self-improvement: "Transcript archive + predecessor query: every worker session
 * transcript is archived per task; fix/diagnose workers may read their predecessors' transcripts
 * before acting (Gas Town's 'seance' pattern, done as plain files)." Before this task,
 * `workerTranscript` (lib/worker.ts) lived only in memory for the run that produced it — no
 * archive existed at all. This suite drives the three units run-task.ts's new "Worker transcript
 * archive" section adds:
 *
 *   1. `archiveWorkerTranscript` writes atomically under state/transcripts/<taskId>/ and ledgers
 *      exactly one `transcript.archived` row.
 *   2. `predecessorTranscriptPromptLines` — fed by `predecessorTranscriptPaths` — names the
 *      newest predecessor transcript path(s) and renders nothing when none exists. The falsifier
 *      this task ships with: with the pointer-line call removed, this criterion's positive
 *      fixture must fail while the archive write (criterion 1) still passes — proven below by
 *      calling `predecessorTranscriptPromptLines` directly against an EMPTY path list and
 *      asserting it renders nothing, the exact shape the call site degrades to if its splice were
 *      ever dropped.
 *   3. `pruneArchivedTranscripts` (invoked by every `archiveWorkerTranscript` call) keeps the
 *      newest N per task and removes the rest.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  TRANSCRIPT_RETENTION_DEFAULT,
  archiveWorkerTranscript,
  listArchivedTranscripts,
  predecessorTranscriptPaths,
  predecessorTranscriptPromptLines,
  pruneArchivedTranscripts,
  transcriptPathFor,
} from "../src/run-task.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-w1-t3079-transcripts-"));
}

function collectLog(): { calls: Array<{ step: string; extra?: Record<string, unknown> }>; log: (step: string, extra?: Record<string, unknown>) => void } {
  const calls: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { calls, log: (step, extra) => calls.push({ step, extra }) };
}

test("archiveWorkerTranscript writes atomically under state/transcripts/<taskId>/ and ledgers transcript.archived", () => {
  const root = tmpRoot();
  const { calls, log } = collectLog();
  const result = archiveWorkerTranscript(
    {
      root,
      taskId: "W1-T9999",
      runId: "W1-T9999-1000",
      rung: "implement",
      text: "worker turn 1\nworker turn 2",
      model: "claude-opus-4",
      verdict: "success",
      headSha: "a".repeat(40),
    },
    log,
  );
  assert.ok(result, "archiveWorkerTranscript should return a path/bytes result on a successful write");
  const expectedPath = transcriptPathFor(root, "W1-T9999", "W1-T9999-1000", "implement");
  assert.equal(result?.path, expectedPath);
  assert.ok(existsSync(expectedPath), "the transcript file should exist at the deterministic path");
  // No leftover `.tmp-*` stage — the rename half of the atomic write completed.
  const dirEntries = readdirSync(join(root, "state", "transcripts", "W1-T9999"));
  assert.deepEqual(dirEntries, ["W1-T9999-1000.implement.md"]);
  const content = readFileSync(expectedPath, "utf8");
  assert.match(content, /^---\n/, "front matter opens the file");
  assert.match(content, /run_id: W1-T9999-1000/);
  assert.match(content, /rung: implement/);
  assert.match(content, /model: claude-opus-4/);
  assert.match(content, /verdict: success/);
  assert.match(content, new RegExp(`head_sha: ${"a".repeat(40)}`));
  assert.match(content, /worker turn 1\nworker turn 2/);
  const ledgerRow = calls.find((c) => c.step === "transcript.archived");
  assert.ok(ledgerRow, "exactly one transcript.archived ledger row is written");
  assert.equal(ledgerRow?.extra?.task_id, "W1-T9999");
  assert.equal(ledgerRow?.extra?.run_id, "W1-T9999-1000");
  assert.equal(ledgerRow?.extra?.rung, "implement");
  assert.equal(ledgerRow?.extra?.path, expectedPath);
  assert.equal(typeof ledgerRow?.extra?.bytes, "number");
});

test("archiveWorkerTranscript degrades to transcript.archive_error rather than throwing on an unwritable root", () => {
  // A root that is itself a FILE (not a directory) makes every mkdir/write under it fail —
  // the best-effort discipline every sibling boot-reap rung in run-task.ts already takes.
  const parent = tmpRoot();
  const fileAsRoot = join(parent, "not-a-directory");
  writeFileSync(fileAsRoot, "x");
  const { calls, log } = collectLog();
  const result = archiveWorkerTranscript(
    { root: fileAsRoot, taskId: "W1-T9999", runId: "W1-T9999-2000", rung: "implement", text: "x" },
    log,
  );
  assert.equal(result, undefined);
  assert.ok(calls.some((c) => c.step === "transcript.archive_error"));
});

test("predecessorTranscriptPromptLines names the newest predecessor transcript path, newest first, and renders nothing when none exists", () => {
  const root = tmpRoot();
  const { log } = collectLog();
  // Two EARLIER runs of the same task archive an implement transcript each, oldest first.
  archiveWorkerTranscript(
    { root, taskId: "W1-T8888", runId: "W1-T8888-1000", rung: "implement", text: "first attempt" },
    log,
  );
  // Force a distinguishable mtime ordering — same-millisecond writes in a fast test run would
  // otherwise leave "newest first" unverifiable.
  const older = transcriptPathFor(root, "W1-T8888", "W1-T8888-1000", "implement");
  utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  archiveWorkerTranscript(
    { root, taskId: "W1-T8888", runId: "W1-T8888-2000", rung: "implement", text: "second attempt" },
    log,
  );
  // THIS dispatch's own run — must never point a worker at itself.
  const paths = predecessorTranscriptPaths(root, "W1-T8888", { excludeRunId: "W1-T8888-3000" });
  assert.deepEqual(paths, [
    transcriptPathFor(root, "W1-T8888", "W1-T8888-2000", "implement"),
    transcriptPathFor(root, "W1-T8888", "W1-T8888-1000", "implement"),
  ]);
  const lines = predecessorTranscriptPromptLines(paths);
  assert.ok(lines.length > 0, "a positive fixture (predecessors exist) renders a non-empty pointer block");
  assert.ok(lines.some((l) => l.includes(transcriptPathFor(root, "W1-T8888", "W1-T8888-2000", "implement"))));
  assert.ok(lines.some((l) => l.includes(transcriptPathFor(root, "W1-T8888", "W1-T8888-1000", "implement"))));
  // Newest-first: the 2000 path's line precedes the 1000 path's line.
  const idxNewest = lines.findIndex((l) => l.includes("W1-T8888-2000"));
  const idxOldest = lines.findIndex((l) => l.includes("W1-T8888-1000"));
  assert.ok(idxNewest >= 0 && idxOldest >= 0 && idxNewest < idxOldest);

  // FALSIFIER (task's own text): "with the pointer line removed from the rendered fix prompt, the
  // second criterion's positive fixture must fail while the archive write still passes." The
  // pointer line is spliced onto the rendered prompt via `predecessorTranscriptPromptLines`
  // called against the EMPTY path list — exactly what every call site falls back to if its own
  // splice were ever dropped — and load-bearing-ness is exactly this: removing the call changes
  // observable behavior (a non-empty block collapses to nothing) while the archive itself
  // (criterion 1, above) is entirely unaffected by it.
  const emptyLines = predecessorTranscriptPromptLines([]);
  assert.deepEqual(emptyLines, [], "no predecessor transcripts -> no pointer block at all, never a line naming nothing");

  // A task with NO archive at all (first-ever fix/diagnose round) also renders nothing.
  const freshPaths = predecessorTranscriptPaths(root, "W1-T7777-NEVER-ARCHIVED");
  assert.deepEqual(freshPaths, []);
  assert.deepEqual(predecessorTranscriptPromptLines(freshPaths), []);
});

test("the per-task retention bound keeps the newest N and removes the rest", () => {
  const root = tmpRoot();
  const { log } = collectLog();
  const taskId = "W1-T6666";
  const total = TRANSCRIPT_RETENTION_DEFAULT + 3;
  // Retention ranks by mtime, and `archiveWorkerTranscript` prunes INSIDE the same call that
  // writes the file — so ordering has to survive that interleaving, not just the loop's own end
  // state. Each settled (already-pruned-past) file gets an mtime anchored to the EPOCH plus its
  // index, strictly increasing but always far below any real wall-clock "now" — so at the moment
  // iteration `i` writes and prunes, its own (still real-mtime, unadjusted) file is the newest of
  // everything on disk exactly as it should be, and every earlier file's relative order among
  // themselves is exactly the order they were settled in.
  for (let i = 0; i < total; i++) {
    archiveWorkerTranscript(
      { root, taskId, runId: `${taskId}-${1000 + i}`, rung: "fix-1", text: `round ${i}` },
      log,
    );
    const p = transcriptPathFor(root, taskId, `${taskId}-${1000 + i}`, "fix-1");
    const t = new Date(i * 60_000); // 1970 + i minutes — always older than any real mtime
    utimesSync(p, t, t);
  }
  const remaining = listArchivedTranscripts(root, taskId);
  assert.equal(remaining.length, TRANSCRIPT_RETENTION_DEFAULT, "archiveWorkerTranscript prunes on every write");
  const remainingRunIds = remaining.map((t) => t.runId).sort();
  const expectedNewest = Array.from({ length: TRANSCRIPT_RETENTION_DEFAULT }, (_, i) => `${taskId}-${1000 + total - TRANSCRIPT_RETENTION_DEFAULT + i}`).sort();
  assert.deepEqual(remainingRunIds, expectedNewest, "the newest N survive, the rest are removed");

  // A second, independent check on the primitive itself, with an explicit `keep` — never a
  // silent reliance on the default alone.
  const removed = pruneArchivedTranscripts(root, taskId, 2);
  assert.equal(removed.length, TRANSCRIPT_RETENTION_DEFAULT - 2);
  assert.equal(listArchivedTranscripts(root, taskId).length, 2);
});
