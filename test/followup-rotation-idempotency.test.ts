import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLedger,
  DECISION_RELEVANT_LEDGER_STEPS,
  ledgerExceedsRotationCeiling,
  rotateLedger,
  type LedgerLine,
} from "../src/lib/ledger.js";
import { mineFollowups, parseLedger, recordFollowupHarvest } from "../src/lib/retro.js";

// ── W1-T964: THE FOLLOW-UP HARVEST'S IDEMPOTENCY RESTS ON TWO LEDGER STEPS THAT ROTATE
// INDEPENDENTLY OF EACH OTHER — mineFollowups (retro.ts:2139) reads `report.followups` (the
// source row, one per dispatched task's declared `## Follow-ups` section) together with
// `followup.harvested`/`followup.deduped` (the harvest marks, one per entry, matched back to
// their source by `entryId`). Before this task, all three read ZERO membership in every
// rotation-retention category and were archived UNCONDITIONALLY on the very next rotation
// regardless of volume — see ledger.ts's DECISION_RELEVANT_LEDGER_STEPS doc for the fix and
// why this is the correct category (not RENDER_RELEVANT_LEDGER_STEPS or isHealthOrDeployStep:
// both are TIME-window-bounded at 30/15 minutes, and mineFollowups's own doc, retro.ts:
// 2131-2134, requires a followup to survive a discovery "from three retros ago"). ─────────────

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-followup-rotation-"));
}

function noiseLine(n: number): string {
  // Realistic non-decision, non-followup traffic — the SAME shape test/ledger-rotation.test.ts's
  // own `noiseLine` uses — a step in NO retention category, archived unconditionally on any
  // rotation regardless of count. The CONTROL for "the pinning is scoped, not blanket".
  return JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) });
}

/** Writes N `report.followups` rows, one entry each, distinctly named so survival/loss of any
 *  single one is directly checkable by text/entryId. Never lets `appendLedger`'s own opportunistic
 *  rotation fire mid-setup — the test drives `rotateLedger` itself, at a moment of its choosing. */
function writeFollowupRows(ledgerPath: string, count: number, label: string): void {
  for (let i = 0; i < count; i++) {
    appendLedger(
      ledgerPath,
      {
        run_id: `${label}-${i}`,
        task_id: "W1-T964-SRC",
        step: "report.followups",
        entries: [{ type: "task", text: `${label} followup entry ${i}` }],
      } as LedgerLine,
      { ceilingBytes: Number.MAX_SAFE_INTEGER },
    );
  }
}

test("W1-T964: a re-mine after rotation yields the same candidate set", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const total = 250; // > MAX_RETAINED_LINES_PER_STEP (200), for BOTH the source step and its mark.

    writeFollowupRows(ledgerPath, total, "harv");

    // Mine and record the harvest for every one of the 250 entries — this is what a real retro
    // does the moment it observes them, well before any rotation. `harvestLines` (and therefore
    // the marks `recordFollowupHarvest` appends) are written in the SAME relative order as their
    // source rows (mineFollowups iterates `records` — and therefore `entries` — in file order).
    const firstMine = mineFollowups(parseLedger(readFileSync(ledgerPath, "utf8")));
    assert.equal(firstMine.candidates.length, total, "sanity: every entry is a fresh candidate before any harvest is recorded");
    assert.equal(firstMine.deduped.length, 0);
    recordFollowupHarvest(firstMine, { ledgerPath });

    // "the candidate set it yielded before the rotation" — re-mining the now-fully-harvested
    // ledger, still pre-rotation, must yield NOTHING new (mineFollowups's own idempotence
    // contract: re-mining with no new events yields the same result).
    const before = mineFollowups(parseLedger(readFileSync(ledgerPath, "utf8")));
    assert.deepEqual(before, { candidates: [], deduped: [], harvestLines: [] }, "sanity: nothing left to mine before rotation");

    // Force a REAL per-step-cap rotation: the ceiling sits between the post-cap core (400 lines:
    // 200 report.followups + 200 followup.harvested) and the full pre-rotation size (500 lines),
    // so PASS 4's cap fires but the convergence/shed pass (which sheds by raw age regardless of
    // step, a global last resort) never needs to — the SAME "measured, not guessed" ceiling
    // discipline test/ledger-rotation.test.ts's own per-step-cap test uses.
    const fullBytes = statSync(ledgerPath).size;
    const ceiling = Math.floor(fullBytes * 0.85);
    assert.ok(ceiling < fullBytes, "sanity: the chosen ceiling must actually be under the pre-rotation size");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true, "sanity: the rotation must actually have fired");

    const liveRecords = parseLedger(readFileSync(ledgerPath, "utf8"));
    const sourceLive = liveRecords.filter((r) => r.step === "report.followups");
    const markLive = liveRecords.filter((r) => r.step === "followup.harvested");

    // BOTH directions of rationale (3), ruled out by direct count: not a blanket "retain
    // everything" (250 survivors) and not the pre-fix "archived unconditionally" (0 survivors) —
    // exactly the newest MAX_RETAINED_LINES_PER_STEP of EACH, in lockstep.
    assert.equal(sourceLive.length, 200, "exactly 200 report.followups rows must survive rotation (the newest, per-step cap)");
    assert.equal(markLive.length, 200, "exactly 200 followup.harvested marks must survive rotation (the newest, per-step cap)");
    // The SAME 200 entries on both sides — the oldest 50 of the source step and the oldest 50 of
    // the mark step are the SAME 50 entries, not an independently-chosen 50 on each side.
    assert.ok(!sourceLive.some((r) => (r.entries as Array<{ text: string }>)?.[0]?.text === "harv followup entry 0"));
    assert.ok(sourceLive.some((r) => (r.entries as Array<{ text: string }>)?.[0]?.text === "harv followup entry 249"));
    // W1-T2252: entry_id is now `run_id:ts:index` — ts is the real wall-clock stamp
    // `appendLedger` gave each source row, unknown ahead of time, so match by prefix/suffix
    // rather than the full literal.
    assert.ok(!markLive.some((r) => typeof r.entry_id === "string" && r.entry_id.startsWith("harv-0:") && r.entry_id.endsWith(":0")));
    assert.ok(markLive.some((r) => typeof r.entry_id === "string" && r.entry_id.startsWith("harv-249:") && r.entry_id.endsWith(":0")));

    // THE ACCEPTANCE CLAIM: a re-mine after rotation yields the SAME candidate set it yielded
    // before the rotation — empty, because every surviving source row's mark survived alongside
    // it. A rotation that dropped the pairing would either RE-MINT (mark gone, source live) or
    // silently strand an orphan mark (source gone, mark live) — this assertion catches the first;
    // the exact-200/exact-200 count assertions above rule out both directions at the ledger level.
    const after = mineFollowups(liveRecords);
    assert.deepEqual(after, { candidates: [], deduped: [], harvestLines: [] }, "re-mine after rotation must match the pre-rotation result: nothing re-minted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T964: a non-pinned step still archives in the same run", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");

    // A handful of follow-up entries — comfortably under the per-step cap, so this run is about
    // proving the PINNING survives at all (the pre-fix defect: even ONE rotation wiped every
    // follow-up line regardless of count), not about the 200-line boundary test/followup-
    // rotation-idempotency.test.ts's sibling test above already covers.
    writeFollowupRows(ledgerPath, 5, "ctrl");
    const mined = mineFollowups(parseLedger(readFileSync(ledgerPath, "utf8")));
    assert.equal(mined.candidates.length, 5);
    recordFollowupHarvest(mined, { ledgerPath });

    // The CONTROL: a realistic non-pinned, non-decision, non-render, non-health step — the
    // rotation must still archive THIS, in the SAME run, or the fix is a blanket "retain
    // everything" rather than a scoped pin (design note (v)'s own trap).
    for (let n = 0; n < 300; n++) {
      writeFileSync(ledgerPath, noiseLine(n) + "\n", { flag: "a" });
    }

    // 4000, not 2000: W1-T2252 lengthened every followup.harvested mark's entry_id from
    // `run_id:index` to `run_id:ts:index`, so the pinned 10-line core (5 report.followups + 5
    // followup.harvested) sits close enough to a 2000-byte ceiling's shed-pass target
    // (ceiling * 0.9) that the convergence invariant (rotateLedger's oldest-by-ts shed, ledger.ts)
    // would evict some of the very rows this test asserts survive — a fixture-sizing artifact of
    // the longer key, not a regression in pinning. 4000 keeps the pinned core comfortably under
    // the shed target while the 300-line noise burst still safely exceeds it (asserted below).
    const ceiling = 4000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling));
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const liveRecords = parseLedger(readFileSync(ledgerPath, "utf8"));
    const sourceLive = liveRecords.filter((r) => r.step === "report.followups");
    const markLive = liveRecords.filter((r) => r.step === "followup.harvested");
    const noiseLive = liveRecords.filter((r) => r.step === "ci.polling");

    assert.equal(sourceLive.length, 5, "every pinned report.followups row survives — well under the per-step cap");
    assert.equal(markLive.length, 5, "every pinned followup.harvested mark survives — well under the per-step cap");
    assert.equal(noiseLive.length, 0, "the non-pinned control step is still archived away by the SAME rotation");

    const after = mineFollowups(liveRecords);
    assert.deepEqual(after, { candidates: [], deduped: [], harvestLines: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T964: all three follow-up steps are pinned together", () => {
  // Direct membership — cheap, and named exactly by the acceptance claim — paired below with a
  // behavioral proof over the THIRD step (`followup.deduped`) the sibling tests above never
  // exercise, so "pinned together" is shown for real, not just asserted of the Set literal.
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("report.followups"), "report.followups must be pinned");
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("followup.harvested"), "followup.harvested must be pinned");
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("followup.deduped"), "followup.deduped must be pinned");

  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const total = 250;
    const openTitle = "an already-open task title every dedup entry below matches closely";

    for (let i = 0; i < total; i++) {
      appendLedger(
        ledgerPath,
        {
          run_id: `dedup-${i}`,
          task_id: "W1-T964-DEDUP",
          step: "report.followups",
          // Deliberately high word-overlap with `openTitle` (followupMatchesTitle's >=60%
          // threshold) so every entry mines as DEDUPED, not a fresh candidate — exercising
          // `followup.deduped` specifically, never `followup.harvested`.
          entries: [{ type: "task", text: `${openTitle} ${i}` }],
        } as LedgerLine,
        { ceilingBytes: Number.MAX_SAFE_INTEGER },
      );
    }

    const firstMine = mineFollowups(parseLedger(readFileSync(ledgerPath, "utf8")), [openTitle]);
    assert.equal(firstMine.candidates.length, 0, "sanity: every entry dedups against the open title");
    assert.equal(firstMine.deduped.length, total);
    recordFollowupHarvest(firstMine, { ledgerPath });

    const before = mineFollowups(parseLedger(readFileSync(ledgerPath, "utf8")), [openTitle]);
    assert.deepEqual(before, { candidates: [], deduped: [], harvestLines: [] }, "sanity: nothing left to mine before rotation");

    const fullBytes = statSync(ledgerPath).size;
    const ceiling = Math.floor(fullBytes * 0.85);
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const liveRecords = parseLedger(readFileSync(ledgerPath, "utf8"));
    const sourceLive = liveRecords.filter((r) => r.step === "report.followups");
    const dedupedMarkLive = liveRecords.filter((r) => r.step === "followup.deduped");
    assert.equal(sourceLive.length, 200, "exactly 200 report.followups rows survive rotation");
    assert.equal(dedupedMarkLive.length, 200, "exactly 200 followup.deduped marks survive rotation, in lockstep with their source rows");

    const after = mineFollowups(liveRecords, [openTitle]);
    assert.deepEqual(after, { candidates: [], deduped: [], harvestLines: [] }, "re-mine after rotation must not re-mint any deduped entry as a fresh candidate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
