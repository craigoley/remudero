/**
 * W1-T1013 — `mineFollowups` un-scopes from the retro marker window on purpose (a discovery from
 * three retros ago is still worth surfacing), but `retroCommand` handed `buildGather` nothing but
 * `readFileSync(ledgerPath)` — the LIVE ledger file, post-rotation. Rotation truncates that file
 * per-step long before the marker window ever would, so the un-scoping bought nothing: BOTH the
 * declared follow-ups (`report.followups`) and the marks that make re-mining idempotent
 * (`followup.harvested`/`followup.deduped`) were lost together on every rotation. Measured on the
 * host this task was filed against: 1,231 declared entries and 549 marks sit in the rotation
 * archives while the live file holds 0 of each (plan/tasks.d/W1-T1013's rationale).
 *
 * The fix gives the follow-up harvest `resolveLedgerUnion`'s (lib/ledger-grep.ts) archive∪live
 * UNION instead — via `followupLedgerUnionNdjson` (run-task.ts) feeding `buildGather`'s new
 * `followupLedgerNdjson` input (retro.ts), consumed ONLY by `mineFollowups`, never by the other
 * marker-scoped miners `buildGather` already runs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { followupLedgerUnionNdjson } from "../src/run-task.js";
import { buildGather, mineFollowups, parseLedger } from "../src/lib/retro.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-followup-corpus-"));
}

test("W1-T1013: the follow-up harvest reads the rotation archives not the live file alone", () => {
  const dir = tmpDir();
  try {
    // ONE archived rotation carrying a report.followups row, no report.followups anywhere in the
    // live file (which is deliberately absent here — the archive alone is the whole corpus).
    writeFileSync(
      join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson"),
      `${JSON.stringify({
        ts: "2026-07-01T00:00:00.000Z",
        run_id: "ARCH-1",
        task_id: "W1-T1013-SRC",
        step: "report.followups",
        entries: [{ type: "task", text: "an entry that lives only in a rotation archive" }],
      })}\n`,
    );

    const union = followupLedgerUnionNdjson(dir, { now: () => Date.parse("2026-07-15T00:00:00.000Z") });
    const mined = mineFollowups(parseLedger(union));

    assert.equal(mined.candidates.length, 1, "the archived report.followups row must be mined");
    assert.equal(mined.candidates[0].text, "an entry that lives only in a rotation archive");
    assert.equal(mined.candidates[0].runId, "ARCH-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T1013: a state dir with no archives degrades loudly instead of harvesting silently", () => {
  const dir = tmpDir();
  try {
    // NO rotation archive exists — only the live file, carrying a real report.followups row.
    // The pre-fix behavior silently mined this (a plausible-looking small answer); the fix must
    // neither mine it silently NOR mine it quietly-with-a-log — it must refuse (empty corpus) and
    // say so, the same "an error, never a smaller result" discipline resolveLedgerUnion's own
    // module doc already commits to.
    writeFileSync(
      join(dir, "ledger.ndjson"),
      `${JSON.stringify({
        ts: "2026-08-12T00:00:00.000Z",
        run_id: "LIVE-1",
        task_id: "W1-T1013-SRC",
        step: "report.followups",
        entries: [{ type: "task", text: "an entry that lives only in the live file, no archives exist" }],
      })}\n`,
    );

    const errs: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
    let union: string;
    try {
      union = followupLedgerUnionNdjson(dir);
    } finally {
      console.error = realError;
    }

    assert.equal(union, "", "zero archives must degrade to an EMPTY corpus, never the live file alone");
    assert.ok(
      errs.some((e) => e.includes("### [retro] followups.ledger_union")),
      `a loud, named diagnostic must be printed — got: ${JSON.stringify(errs)}`,
    );

    const mined = mineFollowups(parseLedger(union));
    assert.equal(mined.candidates.length, 0, "the live-only entry must NOT be silently harvested");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T1013: the marker scoped miners keep the corpus they already read", () => {
  // `ledgerNdjson` (the corpus every OTHER miner reads) carries run A only.
  const ledgerNdjson = [
    `{"ts":"2026-01-01T00:00:00.000Z","run_id":"A","task_id":"TA","step":"run.start","type":"implement"}`,
    `{"ts":"2026-01-01T00:01:00.000Z","run_id":"A","task_id":"TA","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/1"}`,
  ].join("\n");

  // `followupLedgerNdjson` (the union) carries a DIFFERENT run B — including its OWN run.start /
  // verdict lines, which must NOT leak into totalRuns/verdicts — plus a report.followups row that
  // only this union corpus holds.
  const followupLedgerNdjson = [
    `{"ts":"2026-02-01T00:00:00.000Z","run_id":"B","task_id":"TB","step":"run.start","type":"implement"}`,
    `{"ts":"2026-02-01T00:01:00.000Z","run_id":"B","task_id":"TB","step":"verdict","verdict":"merged","cost_usd":2.0}`,
    `{"ts":"2026-02-01T00:02:00.000Z","run_id":"B","task_id":"TB","step":"report.followups","entries":[{"type":"task","text":"a follow-up only present in the archive union, never the live file"}]}`,
  ].join("\n");

  const gather = buildGather({ ledgerNdjson, followupLedgerNdjson, learningsMd: "# L\n" });

  // The union's run B must NOT be counted by the marker-scoped miners — they read `ledgerNdjson`
  // exactly as before, unaffected by the second, explicit followup-only input.
  assert.equal(gather.totalRuns, 1, "totalRuns must reflect ledgerNdjson's run A only, not the union's run B");

  // The follow-up harvest, meanwhile, DID read the union — its entry (found nowhere in
  // ledgerNdjson) must be mined.
  assert.equal(gather.followups.candidates.length, 1);
  assert.equal(gather.followups.candidates[0].runId, "B");
  assert.equal(gather.followups.candidates[0].text, "a follow-up only present in the archive union, never the live file");
});

test("W1-T1013: an entry marked in an archived row is not proposed again", () => {
  const dir = tmpDir();
  try {
    // The declaration and its harvest mark live in TWO DIFFERENT rotation archives — neither in
    // the live file — exercising the exact case rotation used to break: a mark that survived only
    // in an archive must still suppress its entry.
    writeFileSync(
      join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson"),
      `${JSON.stringify({
        ts: "2026-07-01T00:00:00.000Z",
        run_id: "ARCH-MARKED",
        task_id: "W1-T1013-SRC",
        step: "report.followups",
        entries: [{ type: "task", text: "an entry already harvested in a prior, now-archived pass" }],
      })}\n`,
    );
    writeFileSync(
      join(dir, "ledger.2026-07-02T00-00-00-000Z.ndjson"),
      `${JSON.stringify({
        ts: "2026-07-02T00:00:00.000Z",
        run_id: "ARCH-MARKED",
        task_id: "W1-T1013-SRC",
        step: "followup.harvested",
        // W1-T2252: keyed on the SOURCE row's own run_id:ts:index — "2026-07-01T00:00:00.000Z"
        // is the report.followups row's own ts above, not this mark line's ts.
        entry_id: "ARCH-MARKED:2026-07-01T00:00:00.000Z:0",
        type: "task",
        text: "an entry already harvested in a prior, now-archived pass",
      })}\n`,
    );

    const union = followupLedgerUnionNdjson(dir, { now: () => Date.parse("2026-07-15T00:00:00.000Z") });
    const mined = mineFollowups(parseLedger(union));

    assert.equal(mined.candidates.length, 0, "an entry whose mark survives only in an archive must not re-mint");
    assert.equal(mined.deduped.length, 0);
    assert.equal(mined.harvestLines.length, 0, "nothing left to append — re-mining is a true no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
