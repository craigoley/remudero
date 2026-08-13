/**
 * THE SWEEP RE-CREDITED MERGED TASKS FOREVER, AND THE BACKFILL WAS IDEMPOTENT THE WHOLE TIME.
 *
 * `runCreditBackfill` asked `hasMergeCredit` against `readLedgerLines`, WHICH OPENS EXACTLY ONE
 * FILE. Both credit spellings are registered in `DECISION_RELEVANT_LEDGER_STEPS`, and the comment on
 * `isMergeCreditLine` concluded from that "rotation cannot drop either out from under a reader" —
 * which is FALSE, and is the belief that hid this for months. Registration stops a step being shed
 * COMPLETELY; it says nothing about `MAX_RETAINED_LINES_PER_STEP`, which keeps only the newest 200
 * rows PER STEP. Credit older than that left the live file, the check said "not credited", the task
 * was re-credited, and the fresh row evicted another. Self-sustaining.
 *
 * MEASURED on the live corpus 2026-08-13, and the arithmetic is exact:
 *   distinct tasks carrying verdict.merged in the LIVE file : 385
 *   MAX_RETAINED_LINES_PER_STEP                             : 200
 *     => credits rotation drops                             : 185
 *   sweep.credit_backfill rows in the LIVE file             : 185   <- exact match
 * Amplification: 61,903 rows across 386 distinct tasks (160x), many unrelated ancient tasks sitting
 * at EXACTLY 670 rows apiece. Not converging: 6,759 corrections / 4,722 full sweeps = 1.43 each.
 *
 * A TEST THAT USES THE LIVE FILE ALONE CANNOT SEE THIS DEFECT — every fixture below therefore puts
 * the credit in a ROTATION and leaves the live file without it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDIT_SCAN_MAX_ROTATIONS, readLedgerLines, readMergeCreditedTaskIds } from "../src/lib/status.js";
import { runCreditBackfill } from "../src/lib/sweep.js";

const row = (o: Record<string, unknown>): string => JSON.stringify({ ts: "2026-08-12T00:00:00.000Z", ...o });
const credit = (taskId: string) => row({ task_id: taskId, step: "verdict.merged", verdict: "merged" });
/** The OTHER credit spelling — a run that merged its own PR. `isMergeCreditLine` matches both. */
const ownCredit = (taskId: string) => row({ task_id: taskId, step: "verdict", verdict: "merged" });

/** A state dir whose LIVE file deliberately lacks what the rotations hold. */
function corpus(opts: { live?: string[]; rotations?: Record<string, string[]>; gzip?: Record<string, string[]> }): string {
  const dir = mkdtempSync(join(tmpdir(), "credit-union-"));
  const live = opts.live ?? [];
  writeFileSync(join(dir, "ledger.ndjson"), live.length ? live.join("\n") + "\n" : "");
  for (const [name, lines] of Object.entries(opts.rotations ?? {})) writeFileSync(join(dir, name), lines.join("\n") + "\n");
  for (const [name, lines] of Object.entries(opts.gzip ?? {})) writeFileSync(join(dir, name), gzipSync(Buffer.from(lines.join("\n") + "\n")));
  return dir;
}

const candidate = (taskId: string) => ({ taskId, prNumber: 7, prUrl: `https://github.com/o/r/pull/7`, merged: true });

// ── DIRECTION 1: THE TRAP — credit that lives ONLY in an archive must NOT be re-credited ──────

test("a task whose ONLY credit is in a ROTATION is not re-credited — the defect, reproduced", async () => {
  const dir = corpus({
    live: [row({ task_id: "W1-T1", step: "run.start" })], // live file has NO credit for W1-T1
    rotations: { "ledger.2026-08-11T00-00-00-000Z.ndjson": [credit("W1-T1")] },
  });
  const ledgerPath = join(dir, "ledger.ndjson");

  // The defect, reproduced against the OLD reader: one file cannot see it.
  assert.equal(
    readLedgerLines(ledgerPath).some((l) => l.task_id === "W1-T1" && l.step === "verdict.merged"),
    false,
    "this is the bug: the single-file read finds no credit",
  );

  const summary = await runCreditBackfill([candidate("W1-T1")], { ledgerPath, runId: "SWEEP-1" });
  assert.equal(summary.corrected, 0, "a task credited in a rotation must NOT be credited again");
  assert.equal(summary.results[0].alreadyCredited, true);
  const after = readLedgerLines(ledgerPath).filter((l) => l.step === "sweep.credit_backfill");
  assert.equal(after.length, 0, "and no correction row is written — that row is what evicts another");
  rmSync(dir, { recursive: true, force: true });
});

test("a GZIPPED rotation counts too — 666 of this host's 670 rotations are .gz", async () => {
  const dir = corpus({
    live: [row({ task_id: "W1-T2", step: "run.start" })],
    gzip: { "ledger.2026-08-10T00-00-00-000Z.ndjson.gz": [credit("W1-T2")] },
  });
  const summary = await runCreditBackfill([candidate("W1-T2")], { ledgerPath: join(dir, "ledger.ndjson"), runId: "S" });
  assert.equal(summary.corrected, 0, "a reader blind to .gz would re-credit every task in the compressed half");
  rmSync(dir, { recursive: true, force: true });
});

test("the OTHER credit spelling in a rotation also counts — step:verdict + verdict:merged", async () => {
  // A run that merges its OWN pr writes this shape, never `verdict.merged`. Measured on the live
  // corpus: 55,400 such rows. Matching only one spelling would re-credit every self-merged task.
  const dir = corpus({
    live: [row({ task_id: "W1-T3", step: "run.start" })],
    rotations: { "ledger.2026-08-11T00-00-00-000Z.ndjson": [ownCredit("W1-T3")] },
  });
  const summary = await runCreditBackfill([candidate("W1-T3")], { ledgerPath: join(dir, "ledger.ndjson"), runId: "S" });
  assert.equal(summary.corrected, 0);
  rmSync(dir, { recursive: true, force: true });
});

// ── DIRECTION 2: THE SECOND TRAP — genuinely uncredited work must STILL be credited ───────────

test("a GENUINELY uncredited task IS still credited — the fix must not strand real work", async () => {
  // The backfill exists because `pr.opened` never lands for branches that are not
  // `run-<taskId>-<epochMs>` — a recon measured 41 of 70 merges in one day on session-shaped heads.
  // A fix that simply stopped crediting would pass every test above and strand all of it.
  const dir = corpus({
    live: [row({ task_id: "W1-T9", step: "run.start" })],
    rotations: { "ledger.2026-08-11T00-00-00-000Z.ndjson": [credit("W1-T-SOMEONE-ELSE")] },
  });
  const ledgerPath = join(dir, "ledger.ndjson");
  const summary = await runCreditBackfill([candidate("W1-T9")], { ledgerPath, runId: "SWEEP-1" });
  assert.equal(summary.corrected, 1, "an uncredited merged task must still be credited");

  const written = readLedgerLines(ledgerPath).filter((l) => l.task_id === "W1-T9" && l.step === "verdict.merged");
  assert.equal(written.length, 1, "exactly one correction");
  assert.equal(written[0].source, "sweep.credit_backfill");
  rmSync(dir, { recursive: true, force: true });
});

test("a candidate whose PR is NOT merged is never credited, rotation or no rotation", async () => {
  const dir = corpus({ live: [] });
  const ledgerPath = join(dir, "ledger.ndjson");
  const summary = await runCreditBackfill([{ ...candidate("W1-T10"), merged: false }], { ledgerPath, runId: "S" });
  assert.equal(summary.corrected, 0);
  assert.equal(readLedgerLines(ledgerPath).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("two candidates naming the SAME task credit exactly once within one pass", async () => {
  const dir = corpus({ live: [] });
  const ledgerPath = join(dir, "ledger.ndjson");
  const summary = await runCreditBackfill([candidate("W1-T11"), candidate("W1-T11")], { ledgerPath, runId: "S" });
  assert.equal(summary.corrected, 1, "the in-pass set must absorb the duplicate");
  rmSync(dir, { recursive: true, force: true });
});

// ── DIRECTION 3: idempotence across passes, which is what regressed in production ─────────────

test("a SECOND pass writes nothing further — and a THIRD after rotation still writes nothing", async () => {
  const dir = corpus({ live: [] });
  const ledgerPath = join(dir, "ledger.ndjson");

  const first = await runCreditBackfill([candidate("W1-T12")], { ledgerPath, runId: "S1" });
  assert.equal(first.corrected, 1);
  const second = await runCreditBackfill([candidate("W1-T12")], { ledgerPath, runId: "S2" });
  assert.equal(second.corrected, 0, "unchanged state appends nothing");

  // NOW SIMULATE THE ROTATION THAT BROKE IT: move the live file's credit into an archive and empty
  // the live file. Pre-fix this is precisely where the treadmill started.
  const liveText = readFileSync(ledgerPath, "utf8");
  writeFileSync(join(dir, "ledger.2026-08-12T23-00-00-000Z.ndjson"), liveText);
  writeFileSync(ledgerPath, "");

  const third = await runCreditBackfill([candidate("W1-T12")], { ledgerPath, runId: "S3" });
  assert.equal(third.corrected, 0, "THE REGRESSION: rotation must not resurrect a credited task");
  rmSync(dir, { recursive: true, force: true });
});

// ── THE READER ITSELF: the early stop, the cap, and the safe failure direction ────────────────

test("the walk STOPS as soon as every candidate is resolved — older rotations stay shut", () => {
  const opened: string[] = [];
  const dir = corpus({
    live: [],
    rotations: {
      "ledger.2026-08-12T00-00-00-000Z.ndjson": [credit("W1-T20")],
      "ledger.2026-08-01T00-00-00-000Z.ndjson": [credit("W1-T21")],
      "ledger.2026-07-01T00-00-00-000Z.ndjson": [credit("W1-T22")],
    },
  });
  const r = readMergeCreditedTaskIds(join(dir, "ledger.ndjson"), {
    candidates: ["W1-T20"],
    readFileBuffer: (p) => {
      opened.push(p.split("/").pop()!);
      return readFileSync(p);
    },
  });
  assert.equal(r.credited.has("W1-T20"), true);
  assert.deepEqual(opened, ["ledger.2026-08-12T00-00-00-000Z.ndjson"], "NEWEST first, and only one");
  assert.equal(r.complete, true);
  rmSync(dir, { recursive: true, force: true });
});

test("an unresolvable candidate stops at the CAP and reports complete:false — it does not walk 670", () => {
  const rotations: Record<string, string[]> = {};
  for (let i = 1; i <= 30; i++) {
    rotations[`ledger.2026-07-${String(i).padStart(2, "0")}T00-00-00-000Z.ndjson`] = [row({ task_id: "OTHER", step: "run.start" })];
  }
  const opened: string[] = [];
  const dir = corpus({ live: [], rotations });
  const r = readMergeCreditedTaskIds(join(dir, "ledger.ndjson"), {
    candidates: ["NEVER-CREDITED"],
    readFileBuffer: (p) => {
      opened.push(p);
      return readFileSync(p);
    },
  });
  assert.equal(opened.length, CREDIT_SCAN_MAX_ROTATIONS, "the cap is the backstop for a task that is simply not credited");
  assert.equal(r.complete, false, "and it SAYS it did not resolve everything, rather than implying it did");
  rmSync(dir, { recursive: true, force: true });
});

test("the cap failing OPEN re-credits rather than stranding — the safe direction, asserted", async () => {
  // The bound is acceptable ONLY because reading too shallow degrades to today's behaviour. This
  // pins that direction: with a cap of 0 the reader cannot see the archived credit, and the task is
  // re-credited. It must never do the opposite — claim credit it did not observe.
  const dir = corpus({
    live: [],
    rotations: { "ledger.2026-08-11T00-00-00-000Z.ndjson": [credit("W1-T30")] },
  });
  const shallow = readMergeCreditedTaskIds(join(dir, "ledger.ndjson"), { candidates: ["W1-T30"], maxRotations: 0 });
  assert.equal(shallow.credited.has("W1-T30"), false, "unseen credit is never assumed");
  assert.equal(shallow.complete, false);

  const deep = readMergeCreditedTaskIds(join(dir, "ledger.ndjson"), { candidates: ["W1-T30"] });
  assert.equal(deep.credited.has("W1-T30"), true, "and the default cap does find it");
  rmSync(dir, { recursive: true, force: true });
});

test("an unreadable state dir degrades to the live answer, never a throw (W1-T119)", () => {
  const dir = corpus({ live: [credit("W1-T40")] });
  const r = readMergeCreditedTaskIds(join(dir, "ledger.ndjson"), {
    candidates: ["W1-T41"], // unresolved, so it WOULD reach the rotations if it could
    readdirSync: () => {
      throw new Error("EACCES: permission denied");
    },
  });
  assert.equal(r.credited.has("W1-T40"), true, "the live file still answers");
  assert.equal(r.complete, false, "a read that failed is not a read that said no");
  rmSync(dir, { recursive: true, force: true });
});

test("a torn line costs its own credit, never the walk", () => {
  const dir = corpus({
    live: [],
    rotations: { "ledger.2026-08-11T00-00-00-000Z.ndjson": ["{not json", credit("W1-T50")] },
  });
  const r = readMergeCreditedTaskIds(join(dir, "ledger.ndjson"), { candidates: ["W1-T50"] });
  assert.equal(r.credited.has("W1-T50"), true);
  rmSync(dir, { recursive: true, force: true });
});
