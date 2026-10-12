/**
 * W1-T5407 — the full ledger union's newest row was stamped 2027-10-14: five `cli.invoked` rows from
 * a test process whose clock ran 13 months ahead, written through `appendLedger`, which took the
 * process clock on trust. The ledger file's own mtime is the kernel's clock, which a skewed process
 * clock cannot move, so `appendLedger` now follows a row whose `ts` runs past it by more than
 * `LEDGER_FUTURE_STAMP_TOLERANCE_MS` with a `ledger.future_stamp` row stamped from that mtime.
 *
 * Every clock here is relative to the real one (`systemClock.now()` plus an offset), never a fixed
 * date constant, so no case changes meaning as real time passes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { fixedClock, systemClock } from "../src/lib/clock.js";
import {
  LEDGER_FUTURE_STAMP_STEP,
  LEDGER_FUTURE_STAMP_TOLERANCE_MS,
  appendLedger,
} from "../src/lib/ledger.js";
import { captureConsoleError } from "./helpers/captured-console.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const THIRTEEN_MONTHS_MS = 13 * 30 * 24 * 60 * 60_000;

/** Run `body` against an empty throwaway ledger from the shared fixture, then remove it. */
function inTempState(body: (path: string) => void): void {
  const fixture = writeLedger();
  try {
    body(fixture.path);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

function readRows(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const CLI_ROW = { run_id: "CLI-skewed-1", task_id: "CLI", step: "cli.invoked", argv: ["peek"] };

test("an append under a clock 13 months fast is followed by a ledger.future_stamp row stamped from the file's mtime", () => {
  inTempState((path) => {
    const skewedClock = fixedClock(systemClock.now() + THIRTEEN_MONTHS_MS);
    const mtimeMs = systemClock.now();
    appendLedger(path, CLI_ROW, {
      clock: skewedClock,
      identity: () => "8f3e86a35d09",
      actor: () => "operator",
      fstat: () => ({ mtimeMs }),
    });

    const rows = readRows(path);
    assert.equal(rows.length, 2, "the offending row stays and exactly one flag follows it");
    const [offending, flag] = rows;
    assert.equal(offending.step, "cli.invoked");
    assert.equal(offending.ts, skewedClock.iso(), "the ledger is append-only: the skewed row is kept as written");

    assert.equal(flag.step, LEDGER_FUTURE_STAMP_STEP);
    assert.equal(flag.ts, fixedClock(mtimeMs).iso(), "the flag is stamped from the mtime, not the skewed clock");
    assert.equal(flag.claimed_ts, skewedClock.iso());
    assert.equal(flag.skew_ms, skewedClock.now() - mtimeMs);
    assert.equal(flag.run_id, "CLI-skewed-1");
    assert.equal(flag.task_id, "CLI");
    assert.equal(flag.flagged_step, "cli.invoked");
    assert.equal(flag.flagged_actor, "operator");
    assert.equal(flag.flagged_host, "8f3e86a35d09");
  });
});

test("the real fstat default reads the kernel mtime, so a 13-month-fast clock is flagged with no stat injected", () => {
  inTempState((path) => {
    const skewedClock = fixedClock(systemClock.now() + THIRTEEN_MONTHS_MS);
    appendLedger(path, CLI_ROW, { clock: skewedClock });

    const steps = readRows(path).map((row) => row.step);
    assert.deepEqual(steps, ["cli.invoked", LEDGER_FUTURE_STAMP_STEP]);
  });
});

test("an append within the tolerance of the file's mtime writes no ledger.future_stamp row", () => {
  inTempState((path) => {
    const mtimeMs = systemClock.now();
    appendLedger(path, CLI_ROW, {
      clock: fixedClock(mtimeMs + LEDGER_FUTURE_STAMP_TOLERANCE_MS),
      fstat: () => ({ mtimeMs }),
    });
    appendLedger(path, { ...CLI_ROW, run_id: "CLI-real-clock" });

    const steps = readRows(path).map((row) => row.step);
    assert.deepEqual(steps, ["cli.invoked", "cli.invoked"], "a skew of exactly the tolerance, and the real clock, both pass");
  });
});

test("a failing stat never throws: the row is written, no flag follows, and the failure is recorded on stderr", () => {
  inTempState((path) => {
    const captured = captureConsoleError();
    try {
      appendLedger(path, CLI_ROW, {
        clock: fixedClock(systemClock.now() + THIRTEEN_MONTHS_MS),
        fstat: () => {
          throw new Error("EIO: stat refused");
        },
      });
    } finally {
      captured.restore();
    }

    assert.deepEqual(
      readRows(path).map((row) => row.step),
      ["cli.invoked"],
    );
    captured.explains(() => assert.ok(captured.lines.some((line) => line.includes("EIO: stat refused"))));
  });
});
