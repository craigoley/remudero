/**
 * W1-T1273 — THE DOCKET RUNG READ A SLIVER OF ITS OWN CORPUS.
 *
 * `runFeedbackDocketRung` took its ledger input from `readLedgerLines(ledgerPath)` — a single
 * `readFileSync` of the LIVE `state/ledger.ndjson` — while `rotateLedger` keeps only the 200
 * newest rows per step there and archives the rest into `state/ledger.*.ndjson.gz`. Two of the
 * docket's five capture surfaces are ledger-derived (`reframe` via `ratify.reframed`, and
 * `operator_feedback`), so any feedback older than the live file's retention window was invisible
 * to the weekly gather — and `counts_by_source`, the per-surface number the operator reads to
 * decide whether a channel is alive, was PRODUCED BY THAT READ.
 *
 * WHY THE OBVIOUS FALSIFIER IS VACUOUS, AND THIS ONE IS NOT. On the daemon host both
 * ledger-derived surfaces measure ZERO over the full union today (`"step":"ratify.reframed"` and
 * `"step":"operator_feedback"` each read 0 across 919 archives, against a control of 44 on
 * `"step":"ratify.approved"`). A test asserting "the union count equals the live count" would
 * therefore pass with the fix and pass without it — the vacuous-pass family. The discriminator has
 * to be a row that exists ONLY in an archive: the live-file read misses it, the union read finds
 * it. This fixture seeds exactly that, in its own temp state dir. No real archive is read,
 * written, moved or deleted — they are not cumulative snapshots and hold unique history.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { appendLedger } from "../src/lib/ledger.js";
import { parseProposalRegistry } from "../src/lib/inbox.js";
import { makeTempDir } from "../src/lib/tmp.js";

/** A `ratify.reframed` row as the ratify path really writes one. */
function reframeRow(taskId: string, feedback: string, ts: string): string {
  return JSON.stringify({ run_id: "archived", task_id: taskId, step: "ratify.reframed", feedback, ts });
}

/** Seed a gzipped rotation archive — the half a live-file read cannot see. */
function writeGzArchive(stateDir: string, name: string, rows: string[]): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, name), gzipSync(Buffer.from(rows.join("\n") + "\n", "utf8")));
}

test("W1-T1273: feedback rotated into an archive still reaches the docket — the live file alone misses it", async () => {
  const { runFeedbackDocketRung } = await import("../src/run-task.js");
  const instanceRoot = makeTempDir("fd-union-instance");
  const repo = makeTempDir("fd-union-repo");
  try {
    const config = { root: instanceRoot } as never;
    const stateDir = join(instanceRoot, "state");
    const ledgerPath = join(stateDir, "ledger.ndjson");
    const now = new Date("2026-08-10T00:00:00.000Z");

    // THE DISCRIMINATOR: three same-referent reframes that exist ONLY in a rotated archive.
    writeGzArchive(stateDir, "ledger.2026-08-04T00-00-00-000Z.ndjson.gz", [
      reframeRow("P1", "first correction about the retry banner [CLAUDE.md#7]", "2026-08-04T00:00:00.000Z"),
      reframeRow("P2", "second, same rule, different words [CLAUDE.md#7]", "2026-08-05T00:00:00.000Z"),
      reframeRow("P3", "third time typing the same correction [CLAUDE.md#7]", "2026-08-06T00:00:00.000Z"),
    ]);

    // The LIVE file exists and is healthy — it simply no longer holds those rows, which is what
    // rotation does. An absent live file would prove nothing: the read would be degraded, not
    // narrow, and this test is about NARROW.
    appendLedger(ledgerPath, { run_id: "r9", task_id: "T9", step: "run.start", ts: "2026-08-09T00:00:00.000Z" });

    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const log = (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra });

    const outcome = runFeedbackDocketRung(config, ledgerPath, "run-1", log, { root: repo, now: () => now });

    const empty = lines.find((l) => l.step === "feedback_docket.empty");
    assert.equal(
      empty,
      undefined,
      `the archived reframes must reach the gather; the rung instead reported empty with ${JSON.stringify(empty?.extra?.counts_by_source)}`,
    );
    assert.equal(outcome.fired, true, "a docket carrying three archived reframes must publish");
    assert.equal(lines.filter((l) => l.step === "feedback_docket.published").length, 1);

    const { readFileSync } = await import("node:fs");
    const proposals = parseProposalRegistry(readFileSync(join(stateDir, "inbox-proposals.json"), "utf8"));
    assert.equal(proposals.length, 1, "exactly one proposal");
    // Quoted VERBATIM off the archive — the proof the archived bytes, not a count, reached the draft.
    assert.match(proposals[0].summary, /first correction about the retry banner \[CLAUDE\.md#7\]/);
    assert.match(proposals[0].summary, /third time typing the same correction \[CLAUDE\.md#7\]/);
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W1-T1273: a state dir with NO archives still gathers from the live file — the union read degrades, never blanks", async () => {
  const { runFeedbackDocketRung } = await import("../src/run-task.js");
  const instanceRoot = makeTempDir("fd-union-noarch-instance");
  const repo = makeTempDir("fd-union-noarch-repo");
  try {
    const config = { root: instanceRoot } as never;
    const ledgerPath = join(instanceRoot, "state", "ledger.ndjson");
    const now = new Date("2026-08-10T00:00:00.000Z");

    // No `.gz` at all — a fresh host. `resolveLedgerUnion` refuses this corpus (requireArchives),
    // and refusing must not be read as "no feedback": these live rows still have to be gathered.
    for (const [i, ts] of ["2026-08-04", "2026-08-05", "2026-08-06"].entries()) {
      appendLedger(ledgerPath, {
        run_id: "r1",
        task_id: `L${i}`,
        step: "ratify.reframed",
        feedback: `live-only correction number ${i} [CLAUDE.md#9]`,
        ts: `${ts}T00:00:00.000Z`,
      });
    }

    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const log = (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra });

    const outcome = runFeedbackDocketRung(config, ledgerPath, "run-1", log, { root: repo, now: () => now });

    assert.equal(outcome.fired, true, "an unreadable ARCHIVE half must not blank the live half");
    assert.equal(lines.filter((l) => l.step === "feedback_docket.published").length, 1);
    const { readFileSync } = await import("node:fs");
    const proposals = parseProposalRegistry(readFileSync(join(instanceRoot, "state", "inbox-proposals.json"), "utf8"));
    assert.match(proposals[0].summary, /live-only correction number 0 \[CLAUDE\.md#9\]/);
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── The five properties the swap must NOT disturb (W1-T1273 criteria 2-6) ─────────────────────

test("W1-T1273: the three non-ledger surfaces still reach the gather unchanged by the corpus swap", async () => {
  const { runFeedbackDocketRung } = await import("../src/run-task.js");
  const instanceRoot = makeTempDir("fd-union-nonledger-instance");
  const repo = makeTempDir("fd-union-nonledger-repo");
  try {
    const config = { root: instanceRoot } as never;
    const ledgerPath = join(instanceRoot, "state", "ledger.ndjson");
    const now = new Date("2026-08-10T00:00:00.000Z");

    // An archive exists, so the UNION path (not the fallback) is the one under test here.
    writeGzArchive(join(instanceRoot, "state"), "ledger.2026-08-01T00-00-00-000Z.ndjson.gz", [
      JSON.stringify({ run_id: "a", task_id: "T", step: "run.start", ts: "2026-08-01T00:00:00.000Z" }),
    ]);

    // rejected_feedback — a plan/feedback/*.yaml entry at status: rejected.
    mkdirSync(join(repo, "plan", "feedback"), { recursive: true });
    writeFileSync(
      join(repo, "plan", "feedback", "fb-test-1.yaml"),
      [
        "id: fb-test-1",
        "ts: 2026-08-04T00:00:00.000Z",
        "raw: the retry banner overlaps the status pill [CLAUDE.md#7]",
        "origin: cli",
        "status: rejected",
      ].join("\n") + "\n",
    );
    // question_answer — a questions.ndjson row carrying a non-empty `answer`.
    writeFileSync(
      join(repo, "plan", "questions.ndjson"),
      JSON.stringify({ ts: "2026-08-05T00:00:00.000Z", task: "W1-T1", answer: "answered: the same banner rule [CLAUDE.md#7]" }) + "\n",
    );
    // operator_note — an operator-notes.ndjson row.
    writeFileSync(
      join(repo, "plan", "operator-notes.ndjson"),
      JSON.stringify({ ts: "2026-08-06T00:00:00.000Z", taskId: "W1-T2", note: "noted: still the banner rule [CLAUDE.md#7]" }) + "\n",
    );

    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const log = (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra });
    const outcome = runFeedbackDocketRung(config, ledgerPath, "run-1", log, { root: repo, now: () => now });

    assert.equal(outcome.fired, true, "all three non-ledger surfaces must still be gathered");
    const { readFileSync: rf } = await import("node:fs");
    const proposals = parseProposalRegistry(rf(join(instanceRoot, "state", "inbox-proposals.json"), "utf8"));
    // All three quoted VERBATIM in one cluster — each surface reached the draft through the rung.
    assert.match(proposals[0].summary, /the retry banner overlaps the status pill/, "rejected_feedback");
    assert.match(proposals[0].summary, /answered: the same banner rule/, "question_answer");
    assert.match(proposals[0].summary, /noted: still the banner rule/, "operator_note");
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W1-T1273: the marker still enforces its seven-day interval across the wider corpus", async () => {
  const { runFeedbackDocketRung } = await import("../src/run-task.js");
  const instanceRoot = makeTempDir("fd-union-marker-instance");
  const repo = makeTempDir("fd-union-marker-repo");
  try {
    const config = { root: instanceRoot } as never;
    const stateDir = join(instanceRoot, "state");
    const ledgerPath = join(stateDir, "ledger.ndjson");
    const now = new Date("2026-08-10T00:00:00.000Z");
    writeGzArchive(stateDir, "ledger.2026-08-04T00-00-00-000Z.ndjson.gz", [
      reframeRow("P1", "archived correction [CLAUDE.md#7]", "2026-08-04T00:00:00.000Z"),
    ]);
    appendLedger(ledgerPath, { run_id: "r", task_id: "T", step: "run.start", ts: "2026-08-09T00:00:00.000Z" });

    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const log = (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra });

    assert.equal(runFeedbackDocketRung(config, ledgerPath, "r1", log, { root: repo, now: () => now }).fired, true);
    // Same week: the marker must shut the rung, union corpus or not.
    assert.equal(runFeedbackDocketRung(config, ledgerPath, "r2", log, { root: repo, now: () => now }).fired, false);
    // Six days later is still inside the rolling seven.
    const sixDays = new Date("2026-08-16T00:00:00.000Z");
    assert.equal(runFeedbackDocketRung(config, ledgerPath, "r3", log, { root: repo, now: () => sixDays }).fired, false);
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W1-T1273: an empty window still writes the marker, files nothing, and names every empty surface", async () => {
  const { runFeedbackDocketRung } = await import("../src/run-task.js");
  const { readFeedbackDocketMarker } = await import("../src/lib/feedback-docket.js");
  const instanceRoot = makeTempDir("fd-union-empty-instance");
  const repo = makeTempDir("fd-union-empty-repo");
  try {
    const config = { root: instanceRoot } as never;
    const stateDir = join(instanceRoot, "state");
    const ledgerPath = join(stateDir, "ledger.ndjson");
    const now = new Date("2026-08-10T00:00:00.000Z");
    // A readable union corpus carrying nothing the docket consumes.
    writeGzArchive(stateDir, "ledger.2026-08-01T00-00-00-000Z.ndjson.gz", [
      JSON.stringify({ run_id: "a", task_id: "T", step: "run.start", ts: "2026-08-01T00:00:00.000Z" }),
    ]);

    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const log = (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra });
    const outcome = runFeedbackDocketRung(config, ledgerPath, "run-1", log, { root: repo, now: () => now });

    assert.equal(outcome.fired, false);
    // (criterion: the marker is written BEFORE the empty check — an empty week still costs a week)
    assert.deepEqual(
      readFeedbackDocketMarker(join(stateDir, "last-feedback-docket.json")),
      { lastFireIso: now.toISOString() },
      "the marker is written before the empty check, so an empty gather still records its fire",
    );
    // (criterion: an empty window files nothing)
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(stateDir, "inbox-proposals.json")), false, "an empty window writes no registry at all");
    // (criterion: the empty row names WHICH surfaces were empty — never a bare zero)
    const empty = lines.find((l) => l.step === "feedback_docket.empty");
    assert.ok(empty, "an empty gather ledgers feedback_docket.empty");
    assert.deepEqual(
      empty!.extra.counts_by_source,
      { reframe: 0, operator_feedback: 0, rejected_feedback: 0, question_answer: 0, operator_note: 0 },
      "every one of the five surfaces is NAMED with its own count, so a silent channel is legible",
    );
  } finally {
    rmSync(instanceRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
