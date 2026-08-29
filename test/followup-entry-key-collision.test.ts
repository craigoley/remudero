import assert from "node:assert/strict";
import { test } from "node:test";
import { mineFollowups, parseLedger, recordFollowupHarvest } from "../src/lib/retro.js";

// ── W1-T2252: THE FOLLOW-UP HARVEST KEY IS NOT UNIQUE ───────────────────────────────────────
//
// `mineFollowups` (retro.ts) keyed each entry on `${run_id}:${index}`, where `index` is the
// entry's position WITHIN one `report.followups` row. One run emits `report.followups` from up
// to five call sites (run-task.ts's `harvestFollowupsFromReport`), so a run with more than one
// row had its second row's entry 0 collide onto the SAME id as the first row's entry 0 — and
// `processed.has(entryId)` silently dropped it, never surfacing it to the Architect. Measured
// over the real ledger union: 521 of 1,426 declared entries, 36.5%.
//
// The fix is reader-side: the key now also carries the source row's own `ts`
// (`${run_id}:${ts}:${index}`). `ts` is written by the ledger appender on every row without
// exception and, per the task's rationale, is never repeated across one run's multiple
// `report.followups` rows — so the composite needs no writer change and no backfill.

test("W1-T2252: two entries declared in different reports of the same run get different keys, and both are considered", () => {
  const records = parseLedger(
    [
      // SAME run_id, DIFFERENT rows (as if emitted by two of harvestFollowupsFromReport's four
      // call sites under one run), each numbering its own entry from index 0.
      `{"ts":"2026-05-10T00:00:00.000Z","run_id":"R-COLLIDE","task_id":"W1-T500","step":"report.followups","entries":[{"type":"task","text":"first row's entry zero"}]}`,
      `{"ts":"2026-05-10T00:05:00.000Z","run_id":"R-COLLIDE","task_id":"W1-T500","step":"report.followups","entries":[{"type":"research","text":"second row's entry zero — collided under the old key"}]}`,
    ].join("\n"),
  );
  const harvest = mineFollowups(records);
  assert.equal(harvest.candidates.length, 2, "both entries must be considered, not just the first row's");
  const ids = harvest.candidates.map((c) => c.entryId);
  assert.notEqual(ids[0], ids[1], "the two entries must be given DIFFERENT harvest keys");
  assert.equal(new Set(ids).size, 2, "no accidental collision between the two keys");
});

test("W1-T2252: the key is derived only from fields a report.followups row already carries", () => {
  // No field beyond what `report.followups` already ledgers (`run_id`, `ts`, entry position) is
  // required — no phase/label, no extra producer-side write. This is exactly the shape
  // `harvestFollowupsFromReport` already ledgers today, verbatim.
  const records = parseLedger(
    `{"ts":"2026-05-11T00:00:00.000Z","run_id":"R-PLAIN","task_id":"W1-T501","step":"report.followups","entries":[{"type":"action","text":"an entry with no extra provenance field"}]}`,
  );
  const harvest = mineFollowups(records);
  assert.equal(harvest.candidates.length, 1);
  assert.equal(harvest.candidates[0]!.entryId, "R-PLAIN:2026-05-11T00:00:00.000Z:0");
});

test("W1-T2252: an entry marked under the NEW key is still skipped — re-mining the same ledger twice yields the same result", () => {
  const base = `{"ts":"2026-05-12T00:00:00.000Z","run_id":"R-IDEMPOTENT","task_id":"W1-T502","step":"report.followups","entries":[{"type":"task","text":"an entry that gets harvested once"}]}`;
  const records = parseLedger(base);
  const first = mineFollowups(records);
  assert.equal(first.candidates.length, 1, "sanity: fresh before any mark exists");

  // Simulate a real retro: append the harvest marks (recordFollowupHarvest's job), then re-mine.
  const written: unknown[] = [];
  recordFollowupHarvest(first, { ledgerPath: "/dev/null/unused", writeLedger: (_path, line) => written.push(line) });
  assert.equal(written.length, 1);

  const updated = parseLedger([base, ...written.map((l) => JSON.stringify({ ts: "2026-05-12T00:01:00.000Z", ...(l as object) }))].join("\n"));
  const second = mineFollowups(updated);
  assert.deepEqual(second, { candidates: [], deduped: [], harvestLines: [] }, "re-mining must be a true no-op");

  // Idempotent over repeated passes with no new events, too.
  const third = mineFollowups(updated);
  assert.deepEqual(third, second);
});

test("W1-T2252: a mark written under the OLD key spelling does not crash or silently match — it names a one-time re-surfacing", () => {
  const sourceTs = "2026-05-13T00:00:00.000Z";
  const source = `{"ts":"${sourceTs}","run_id":"R-OLDMARK","task_id":"W1-T503","step":"report.followups","entries":[{"type":"task","text":"an entry harvested before this fix, under the old key"}]}`;
  // The OLD spelling this entry was actually marked under, pre-fix: `${run_id}:${index}`, with
  // no `ts` component at all.
  const oldMark = `{"ts":"2026-05-13T01:00:00.000Z","run_id":"R-OLDMARK","task_id":"W1-T503","step":"followup.harvested","entry_id":"R-OLDMARK:0","type":"task","text":"an entry harvested before this fix, under the old key"}`;

  const records = parseLedger([source, oldMark].join("\n"));
  // Must not throw — an old-spelling mark is just a string that never matches the new key,
  // never a malformed input the miner chokes on.
  const harvest = mineFollowups(records);

  // The one-time cost the task names explicitly: the old mark does not suppress the entry, so it
  // re-surfaces as a fresh candidate exactly once (not lost, not double-counted, not a crash).
  assert.equal(harvest.candidates.length, 1, "the old-spelled mark must not silently match the new key");
  assert.equal(harvest.candidates[0]!.entryId, `R-OLDMARK:${sourceTs}:0`);
  assert.notEqual(harvest.candidates[0]!.entryId, "R-OLDMARK:0", "the new key must not coincide with the old spelling");

  // And it is a ONE-TIME re-surfacing, not a loop: recording the new mark and re-mining again
  // over the union of old-mark + new-mark yields nothing further.
  const written: unknown[] = [];
  recordFollowupHarvest(harvest, { ledgerPath: "/dev/null/unused", writeLedger: (_path, line) => written.push(line) });
  const reharvested = parseLedger(
    [source, oldMark, ...written.map((l) => JSON.stringify({ ts: "2026-05-13T02:00:00.000Z", ...(l as object) }))].join("\n"),
  );
  assert.deepEqual(mineFollowups(reharvested), { candidates: [], deduped: [], harvestLines: [] });
});

test("W1-T2252: mineFollowups still writes nothing itself — a dry-run preview stays side-effect-free", () => {
  const records = parseLedger(
    `{"ts":"2026-05-14T00:00:00.000Z","run_id":"R-PURE","task_id":"W1-T504","step":"report.followups","entries":[{"type":"research","text":"an entry a dry run only previews"}]}`,
  );
  // Calling mineFollowups repeatedly over the SAME unmodified records must yield the SAME
  // candidates every time — proof it appended nothing to the corpus it read (an appending miner
  // would make its own second pass see its own first pass's marks and mint zero on the second
  // call; here every call sees a clean, unmarked `records` array).
  const pass1 = mineFollowups(records);
  const pass2 = mineFollowups(records);
  assert.deepEqual(pass1, pass2);
  assert.equal(pass1.candidates.length, 1);
  // Only recordFollowupHarvest, called explicitly and separately, writes — never the miner.
  let writeCalls = 0;
  recordFollowupHarvest(pass1, { ledgerPath: "/dev/null/unused", writeLedger: () => { writeCalls++; } });
  assert.equal(writeCalls, 1, "the write happens only via the explicit, separate recordFollowupHarvest call");
});

test("W1-T2252: recovering skipped entries produces candidates only — no path files a task", () => {
  // Two rows for the SAME run_id — the exact collision shape this task fixes — both entries now
  // recovered as CANDIDATES rather than tasks — mineFollowups mints proposal candidates and never
  // a task itself, which is its own scope. W1-T2456: this cited "rule 15", which carries no such
  // doctrine; §12 rule 27 permits automatic filing.
  const records = parseLedger(
    [
      `{"ts":"2026-05-15T00:00:00.000Z","run_id":"R-CANDIDATE-ONLY","task_id":"W1-T505","step":"report.followups","entries":[{"type":"task","text":"row one's declaration"}]}`,
      `{"ts":"2026-05-15T00:10:00.000Z","run_id":"R-CANDIDATE-ONLY","task_id":"W1-T505","step":"report.followups","entries":[{"type":"task","text":"row two's declaration, previously dropped"}]}`,
    ].join("\n"),
  );
  const harvest = mineFollowups(records);
  assert.equal(harvest.candidates.length, 2);
  // The return shape is exactly {candidates, deduped, harvestLines} — no "filed"/"taskId minted"
  // field anywhere, and every harvest line's step is one of the two harvest-mark steps, never a
  // task-filing step.
  assert.deepEqual(Object.keys(harvest).sort(), ["candidates", "deduped", "harvestLines"]);
  for (const line of harvest.harvestLines) {
    assert.ok(line.step === "followup.harvested" || line.step === "followup.deduped", `unexpected harvest line step: ${line.step}`);
  }
});

test("W1-T2252: the accepted entry types stay task, research and action — any other type is still ignored", () => {
  const records = parseLedger(
    `{"ts":"2026-05-16T00:00:00.000Z","run_id":"R-TYPES","task_id":"W1-T506","step":"report.followups","entries":[{"type":"task","text":"a task entry"},{"type":"research","text":"a research entry"},{"type":"action","text":"an action entry"},{"type":"note","text":"an entry of a kind mineFollowups has never accepted"}]}`,
  );
  const harvest = mineFollowups(records);
  assert.equal(harvest.candidates.length, 3, "exactly the three recognized types mint — the fourth, unrecognized type is still ignored");
  assert.deepEqual(
    harvest.candidates.map((c) => c.type).sort(),
    ["action", "research", "task"],
  );
});
