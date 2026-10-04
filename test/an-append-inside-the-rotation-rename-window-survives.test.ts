import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as ledger from "../src/lib/ledger.js";

// W1-T5514. `rotateLedgerLocked` catches up on rows appended since its snapshot, then sheds,
// stages ~MBs with an fsync, and only then renames over the live path. A row another process
// appends after the catch-up read lands on the inode the rename replaces. Live incident:
// PR #8887's `review.posted` (17:33:53Z) during a serve rotation (17:33:45–55Z) is in no file.
//
// test/ledger-rotation-is-locked.test.ts injects through `now()`, which fires BEFORE the catch-up
// read, so it never reached this window. This suite injects through `beforeRename`, which fires
// with the stage fully written, immediately before the rename. `beforeRename` is read off the
// options bag, so at a base without the seam the hook never fires and the "hook fired" assertion
// is the red, rather than a link error. The last test covers the appender half: a row written to
// the replaced inode after the rotation's seal, which only its own appender can re-append.

const CEILING = 4096;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-rotation-rename-window-"));
}

function noiseLine(n: number): string {
  return JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) });
}

function writeOversizedLedger(ledgerPath: string): void {
  const lines: string[] = [];
  while (Buffer.byteLength(lines.join("\n") + "\n", "utf8") <= CEILING * 2) lines.push(noiseLine(lines.length));
  writeFileSync(ledgerPath, lines.join("\n") + "\n");
  assert.ok(statSync(ledgerPath).size > CEILING, "fixture: the ledger starts over the ceiling");
}

function archivesText(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f !== "ledger.ndjson" && (f.endsWith(".ndjson") || f.endsWith(".ndjson.gz")))
    .map((f) => {
      const buf = readFileSync(join(dir, f));
      return (f.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
    })
    .join("");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The second process's append, with the exact syscall shape `appendLedger` uses (open by NAME with
 *  O_APPEND, one write). A huge `ceilingBytes` keeps it from trying a nested rotation of its own. */
function appendAsAnotherProcess(ledgerPath: string, runId: string): void {
  ledger.appendLedger(ledgerPath, { step: "review.posted", run_id: runId, task_id: "W1-T5514", pr_number: 8887 }, { ceilingBytes: 1e12 });
}

type RotateOpts = Parameters<typeof ledger.rotateLedger>[1] & { beforeRename?: () => void };

function rotate(ledgerPath: string, opts: RotateOpts): ReturnType<typeof ledger.rotateLedger> {
  return ledger.rotateLedger(ledgerPath, opts as Parameters<typeof ledger.rotateLedger>[1]);
}

test("a row appended between the rotation's staged write and its rename survives in the live ledger, exactly once", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeOversizedLedger(ledgerPath);
    let fired = 0;
    const result = rotate(ledgerPath, {
      ceilingBytes: CEILING,
      smoothingWindowMs: 0,
      beforeRename: () => {
        fired++;
        appendAsAnotherProcess(ledgerPath, "run-in-window");
      },
    });
    assert.equal(fired, 1, "the beforeRename seam fires once, between the staged write and the rename");
    assert.equal(result.rotated, true, "the rotation completed its rename");
    const live = readFileSync(ledgerPath, "utf8");
    assert.equal(occurrences(live, `"run_id":"run-in-window"`), 1, "the in-window row is in the new live ledger exactly once");
    assert.equal(occurrences(archivesText(dir), `"run_id":"run-in-window"`), 0, "and it is not double-counted in the archive");
    for (const line of live.split("\n").filter(Boolean)) JSON.parse(line); // every live row is whole
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rows appended both before the catch-up read and inside the rename window each survive exactly once — the drain never re-copies the catch-up's bytes", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeOversizedLedger(ledgerPath);
    let nowCalls = 0;
    const result = rotate(ledgerPath, {
      ceilingBytes: CEILING,
      smoothingWindowMs: 0,
      // The second `now()` call is after the snapshot and before the catch-up read.
      now: () => {
        nowCalls++;
        if (nowCalls === 2) appendAsAnotherProcess(ledgerPath, "run-before-catch-up");
        return new Date("2026-10-03T17:33:45.000Z");
      },
      beforeRename: () => {
        appendAsAnotherProcess(ledgerPath, "run-in-window-1");
        appendAsAnotherProcess(ledgerPath, "run-in-window-2");
      },
    });
    assert.equal(result.rotated, true);
    const live = readFileSync(ledgerPath, "utf8");
    for (const id of ["run-before-catch-up", "run-in-window-1", "run-in-window-2"]) {
      assert.equal(occurrences(live, `"run_id":"${id}"`), 1, `${id} is live exactly once`);
    }
    assert.ok(live.indexOf("run-in-window-1") < live.indexOf("run-in-window-2"), "drained rows keep their append order");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a row half-written when the catch-up reads is carried whole — the catch-up stops at the last newline and the drain resumes there", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeOversizedLedger(ledgerPath);
    const row = JSON.stringify({ ts: "2026-10-03T17:33:53.000Z", step: "review.posted", run_id: "run-split", task_id: "W1-T5514" });
    const cut = Math.floor(row.length / 2);
    let nowCalls = 0;
    const result = rotate(ledgerPath, {
      ceilingBytes: CEILING,
      smoothingWindowMs: 0,
      now: () => {
        nowCalls++;
        if (nowCalls === 2) appendFileSync(ledgerPath, row.slice(0, cut)); // the first half of a page-straddling write
        return new Date("2026-10-03T17:33:45.000Z");
      },
      beforeRename: () => appendFileSync(ledgerPath, row.slice(cut) + "\n"),
    });
    assert.equal(result.rotated, true);
    const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.filter((l) => l === row).length, 1, "the split row is one whole live line");
    for (const line of lines) JSON.parse(line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn row left on the replaced inode is kept and newline-terminated, so the next append does not glue onto it", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeOversizedLedger(ledgerPath);
    const torn = `{"step":"review.posted","run_id":"run-torn"`;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    let result: ReturnType<typeof ledger.rotateLedger>;
    try {
      result = rotate(ledgerPath, {
        ceilingBytes: CEILING,
        smoothingWindowMs: 0,
        beforeRename: () => appendFileSync(ledgerPath, torn),
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(result.rotated, true);
    assert.ok(errors.some((e) => e.includes("torn") && e.includes(ledgerPath)), `the torn tail is reported loudly: ${errors.join(" | ")}`);
    appendAsAnotherProcess(ledgerPath, "run-after");
    const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    assert.ok(lines.includes(torn), "the torn bytes are kept as their own line");
    assert.equal(JSON.parse(lines[lines.length - 1]!).run_id, "run-after", "the next append is a whole row of its own");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an appender that opened the replaced inode before the rename and writes after the rotation sealed it re-appends that row itself — once, and only that row", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeOversizedLedger(ledgerPath);
    let rotated: ReturnType<typeof ledger.rotateLedger> | undefined;
    // `appendLedger` writes its row, then fstats its OWN descriptor, then writes the future-stamp
    // flag when the kernel mtime lags the row's ts. Rotating inside that fstat puts the row BEFORE
    // the seal (the drain copies it) and the flag AFTER it (only the appender can save it).
    ledger.appendLedger(
      ledgerPath,
      { step: "review.posted", run_id: "run-straddle", task_id: "W1-T5514", pr_number: 8887 },
      {
        ceilingBytes: 1e12,
        fstat: () => {
          rotated = ledger.rotateLedger(ledgerPath, { ceilingBytes: CEILING, smoothingWindowMs: 0 });
          return { mtimeMs: 0 };
        },
      },
    );
    assert.equal(rotated?.rotated, true, "the rotation ran between the appender's open and its last write");
    const live = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const flags = live.filter((r) => r.step === ledger.LEDGER_FUTURE_STAMP_STEP && r.run_id === "run-straddle");
    assert.equal(flags.length, 1, "the row written after the seal is re-appended to the new live ledger exactly once");
    const rows = live.filter((r) => r.step === "review.posted" && r.run_id === "run-straddle");
    assert.equal(rows.length, 1, "the row written before the seal is live once — the drain copied it and the appender did not");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
