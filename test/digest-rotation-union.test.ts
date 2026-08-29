/**
 * test/digest-rotation-union.test.ts — W1-T2388.
 *
 * THE DIGEST RENDERED TEN STEPS AND ONLY THREE SURVIVED A ROTATION. `buildDigest` read ONE live
 * path; `rotateLedger` fires on `statSize(path) > 4 MiB` — a BYTE ceiling, not a clock — measured at
 * 6.1 rotation events a day, landing inside the digest's cadence in 96.7% of windows, with roughly
 * 16% of a day's rows surviving to a daily digest. The three that survived
 * (`escalation.issue_opened`, `run.start`, `verdict`) are in `DECISION_RELEVANT_LEDGER_STEPS`
 * because some DECIDER elsewhere consults them — nothing to do with the digest.
 *
 * THE WINDOW IS THE BOUND. `rotationStampIso` recovers each archive's own instant from its NAME, and
 * that symbol's doc establishes the property this rests on: every line in a rotation is at or before
 * that instant. So an archive stamped before `sinceIso` is skipped WITHOUT BEING OPENED.
 *
 * NOTHING IS REGISTERED. No step is added to `DECISION_RELEVANT_LEDGER_STEPS` — that set's own doc
 * says a step belongs there only while a real DECIDING reader consults it, and the digest is a
 * reporter.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { test } from "node:test";

import { DIGEST_MAX_ROWS, buildDigest, readDigestWindow, renderDigest, summarize } from "../src/lib/digest.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import type { LedgerGrepFsDeps } from "../src/lib/ledger-grep.js";

const SINCE = "2026-08-27T00:00:00.000Z";
const LIVE = "/state/ledger.ndjson";

const row = (ts: string, over: Record<string, unknown>): string =>
  JSON.stringify({ ts, run_id: "R", task_id: "W1-A", ...over });

/** An fs whose files are held in memory, and which RECORDS every path actually opened — the only
 *  way to assert that a skipped archive was never read rather than merely not contributing. */
function fakeFs(files: Record<string, string | Buffer>): LedgerGrepFsDeps & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    readdirSync: () => Object.keys(files).map((p) => p.split("/").pop()!),
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => {
      opened.push(p);
      const v = files[p];
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Buffer.isBuffer(v) ? v : Buffer.from(v, "utf8");
    },
    gunzipSync: (b: Buffer) => gunzipSync(b),
  };
}

// ══ the defect, closed ═════════════════════════════════════════════════════════════════════════

test("W1-T2388: a row written BEFORE a rotation still renders AFTER it", () => {
  // `sweep.repeat_escalated` is one of the seven unretained steps — rotation moves it out of the
  // live file, and before this task the digest simply forgot it.
  const fs = fakeFs({
    "/state/ledger.2026-08-27T06-00-00-000Z.ndjson": row("2026-08-27T05:59:00.000Z", { step: "sweep.repeat_escalated", pr_number: 3039, disposition: "blocked-ambiguous", streak: 50 }),
    [LIVE]: row("2026-08-27T07:00:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-B" }),
  });
  const read = readDigestWindow(LIVE, SINCE, { fs });
  assert.equal(read.archivesRead, 1, "the in-window archive was opened");
  const text = renderDigest({ ...summarize(read.lines, SINCE), read });
  assert.match(text, /3039/, "the rotated-out row is rendered");
  assert.match(text, /W1-B/, "and the live row still is");
});

test("W1-T2388: an archive stamped BEFORE the window is never opened", () => {
  const fs = fakeFs({
    "/state/ledger.2026-08-26T06-00-00-000Z.ndjson": row("2026-08-26T05:00:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-OLD" }),
    "/state/ledger.2026-08-27T06-00-00-000Z.ndjson": row("2026-08-27T05:00:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-NEW" }),
    [LIVE]: "",
  });
  const read = readDigestWindow(LIVE, SINCE, { fs });
  assert.equal(read.archivesSkippedByStamp, 1);
  assert.equal(read.archivesRead, 1);
  assert.equal(
    fs.opened.includes("/state/ledger.2026-08-26T06-00-00-000Z.ndjson"),
    false,
    "PROVABLY IRRELEVANT AND UNOPENED — the bound is free precisely because the file is never read",
  );
  assert.match(renderDigest({ ...summarize(read.lines, SINCE), read }), /W1-NEW/);
});

test("W1-T2388: an archive whose name carries no parseable stamp is READ, never skipped", () => {
  // `rotationStampIso`'s own doc: a caller must treat "cannot decide" as "read it" — skipping
  // would silently drop a real corpus file, which is the failure this module exists to stop.
  const fs = fakeFs({
    "/state/ledger.hand-renamed.ndjson": row("2026-08-27T05:00:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-ODD" }),
    [LIVE]: "",
  });
  const read = readDigestWindow(LIVE, SINCE, { fs });
  assert.equal(read.archivesSkippedByStamp, 0);
  assert.match(renderDigest({ ...summarize(read.lines, SINCE), read }), /W1-ODD/);
});

test("W1-T2388: the gzip half is read too, not only the plain half", () => {
  const fs = fakeFs({
    "/state/ledger.2026-08-27T06-00-00-000Z.ndjson.gz": gzipSync(Buffer.from(row("2026-08-27T05:00:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-GZ" }), "utf8")),
    [LIVE]: "",
  });
  const read = readDigestWindow(LIVE, SINCE, { fs });
  assert.match(renderDigest({ ...summarize(read.lines, SINCE), read }), /W1-GZ/);
});

test("W1-T2388: a window with NO rotation reads exactly what it reads today", () => {
  const live = row("2026-08-27T07:00:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-ONLY" });
  const fs = fakeFs({ [LIVE]: live });
  const read = readDigestWindow(LIVE, SINCE, { fs });
  assert.equal(read.archivesConsidered, 0);
  assert.equal(read.lines.length, 1);
  const withRead = renderDigest({ ...summarize(read.lines, SINCE), read });
  const without = renderDigest(summarize(read.lines, SINCE));
  assert.equal(withRead, without, "a COMPLETE read renders byte-identically to before this task");
});

test("W1-T2388: a quiet board still renders nothing — the union does not invent activity", () => {
  const fs = fakeFs({ "/state/ledger.2026-08-27T06-00-00-000Z.ndjson": "", [LIVE]: "" });
  const read = readDigestWindow(LIVE, SINCE, { fs });
  const text = renderDigest({ ...summarize(read.lines, SINCE), read });
  assert.match(text, /merged: \(none\)/);
  assert.match(text, /blocked: \(none\)/);
  assert.equal(/INCOMPLETE READ/.test(text), false, "quiet is not the same as incomplete, and must not read as it");
});

test("W1-T2388: a TORN line is skipped and the rows around it still render", () => {
  // `readLedgerLines` already skips an unparseable line rather than throwing; the union must too,
  // or one half-written row at a rotation boundary takes a whole digest with it.
  const fs = fakeFs({
    "/state/ledger.2026-08-27T06-00-00-000Z.ndjson": [
      row("2026-08-27T05:00:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-BEFORE" }),
      '{"ts":"2026-08-27T05:30:00.000Z","step":"verdict",',
      row("2026-08-27T05:40:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-AFTER" }),
    ].join("\n"),
    [LIVE]: "",
  });
  const read = readDigestWindow(LIVE, SINCE, { fs });
  assert.equal(read.lines.length, 2, "the torn line contributes nothing and stops nothing");
  const text = renderDigest({ ...summarize(read.lines, SINCE), read });
  assert.match(text, /W1-BEFORE/);
  assert.match(text, /W1-AFTER/);
});

test("W1-T2388: a row present in BOTH an archive and the live file is counted once", () => {
  // Rotations overlap heavily — `run.start` reads 257,438 RAW lines across the `.gz` half and 779
  // DISTINCT over the union — so dedup is what keeps a union from inflating every figure.
  const dup = row("2026-08-27T05:00:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-DUP" });
  const fs = fakeFs({ "/state/ledger.2026-08-27T06-00-00-000Z.ndjson": dup, [LIVE]: dup });
  const read = readDigestWindow(LIVE, SINCE, { fs });
  assert.equal(read.lines.length, 1, "deduplicated by exact line text, archives first then live");
  assert.equal((renderDigest({ ...summarize(read.lines, SINCE), read }).match(/W1-DUP/g) ?? []).length, 1);
});

// ══ incompleteness is stated, never silence ════════════════════════════════════════════════════

test("W1-T2388: an UNREADABLE in-window rotation is rendered as incomplete, never as a quiet board", () => {
  const fs = fakeFs({ "/state/ledger.2026-08-27T06-00-00-000Z.ndjson.gz": Buffer.from("not gzip at all"), [LIVE]: "" });
  const read = readDigestWindow(LIVE, SINCE, { fs });
  assert.equal(read.unread.length, 1);
  const text = renderDigest({ ...summarize(read.lines, SINCE), read });
  assert.match(text, /INCOMPLETE READ/);
  assert.match(text, /1 rotation\(s\) unreadable/);
});

test("W1-T2388: the ROW cap is what binds, and it says how much it dropped", () => {
  // MEASURED: the busiest real 24h window OOM'd a reader that retained every in-window row (4.1 GB
  // heap). The cap bounds memory; the render bounds the surprise.
  const many = Array.from({ length: 6 }, (_, i) => row(`2026-08-27T0${i}:00:00.000Z`, { step: "verdict", verdict: "merged", task_id: `W1-${i}` })).join("\n");
  const fs = fakeFs({ [LIVE]: many });
  const read = readDigestWindow(LIVE, SINCE, { fs, maxRows: 2 });
  assert.equal(read.lines.length, 2);
  assert.equal(read.rowsTruncated, 4);
  assert.match(renderDigest({ ...summarize(read.lines, SINCE), read }), /4 row\(s\) past the 2 row cap/);
});

test("W1-T2388: the ARCHIVE cap is a backstop that names what it dropped", () => {
  const fs = fakeFs({
    "/state/ledger.2026-08-27T06-00-00-000Z.ndjson": row("2026-08-27T05:00:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-A1" }),
    "/state/ledger.2026-08-27T07-00-00-000Z.ndjson": row("2026-08-27T06:30:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-A2" }),
    [LIVE]: "",
  });
  const read = readDigestWindow(LIVE, SINCE, { fs, maxArchives: 1 });
  assert.equal(read.archivesTruncated, 1);
  const text = renderDigest({ ...summarize(read.lines, SINCE), read });
  assert.match(text, /1 rotation\(s\) past the/);
  assert.match(text, /W1-A2/, "newest-first, so the archive kept is the newer one");
});

// ══ what must NOT change ═══════════════════════════════════════════════════════════════════════

test("W1-T2388: no step is added to DECISION_RELEVANT_LEDGER_STEPS by this task", () => {
  for (const step of [
    "board_review.ran", "inbox.polled", "issues.polled", "learnings.injected",
    "ops.alerts_polled", "review.downgrade_suppressed", "sweep.repeat_escalated",
  ]) {
    assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has(step), false, `${step} must stay OUT — a step belongs in that set only while a real DECIDING reader consults it`);
  }
  for (const step of ["escalation.issue_opened", "run.start", "verdict"]) {
    assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has(step), true, `${step} was already a member and stays one`);
  }
});

test("W1-T2388: the digest stays a REPORTER — it files nothing and paces nothing", () => {
  const src = readFileSync(new URL("../src/lib/digest.ts", import.meta.url), "utf8");
  for (const writer of ["captureFeedback", "updateProposalRegistry", "landFeedback"]) {
    assert.equal(src.includes(writer), false, `${writer} must not appear — this rung writes no plan record of its own (W1-T2456: the citation here read "Rule 15", which carries no filing doctrine)`);
  }
  const from = src.indexOf("export function readDigestWindow(");
  const region = src.slice(from, src.indexOf("\n}", from));
  for (const banned of ["setTimeout", "setInterval", "sleep", "Atomics.wait"]) {
    assert.equal(region.includes(banned), false, `${banned} must not appear on this path (W1-T1066)`);
  }
  assert.ok(DIGEST_MAX_ROWS > 0);
});

test("W1-T2388: buildDigest ITSELF reads the union — the production entry point, over a real directory", () => {
  // THE WIRING TEST, AND IT EXISTS BECAUSE ITS ABSENCE WAS CAUGHT: reverting `buildDigest` to the
  // live-only read left every other case in this file green, because they drive `readDigestWindow`
  // directly. That is the shipped-but-unwired shape, so this one goes through the real entry point
  // over a real temp state dir with a real rotation file on disk.
  const dir = mkdtempSync(join(tmpdir(), "rmd-t2388-"));
  const live = join(dir, "ledger.ndjson");
  writeFileSync(
    join(dir, "ledger.2026-08-27T06-00-00-000Z.ndjson"),
    row("2026-08-27T05:59:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-ROTATED" }) + "\n",
  );
  writeFileSync(live, row("2026-08-27T07:00:00.000Z", { step: "verdict", verdict: "merged", task_id: "W1-LIVE" }) + "\n");
  const text = buildDigest(live, SINCE);
  assert.match(text, /W1-ROTATED/, "the row that rotation moved out of the live file is rendered");
  assert.match(text, /W1-LIVE/, "and the live row still is");
});

test("W1-T2388: buildDigest still answers over a real path without a state directory", () => {
  // The production entry point, with an unreadable directory: the live read still answers and the
  // reader never throws in a reporter.
  const text = buildDigest("/nonexistent-dir-w1t2388/ledger.ndjson", SINCE);
  assert.match(text, /Remudero daily digest/);
  assert.match(text, /merged: \(none\)/);
});
