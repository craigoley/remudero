/**
 * W1-T4393 — rotation headroom follows the measured write rate.
 *
 * MEASURED 2026-09-23: the core ledger rotated about every 4 minutes, because every rotation shed its
 * retained core to a fixed 90% of the ceiling and the next ~420 KB of appends tripped it again. The
 * shed target is now the ceiling minus one hour of the measured append rate: the bytes appended since
 * the previous rotation (the carried-prefix delta) over the time since it (the newest archive's name).
 *
 * Every rotation here runs on an injected clock well in the past, so no archive name runs ahead of its
 * file's real mtime and gets healed (W1-T4100) — the elapsed time under test is exactly the clock's.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  LEDGER_ROTATION_HEADROOM_MS,
  ledgerCarriedPrefixPath,
  ledgerExceedsRotationCeiling,
  rotateLedger,
} from "../src/lib/ledger.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const T0 = Date.parse("2025-01-01T00:00:00.000Z");
const CEILING = 20_000;
const MINUTE = 60_000;

function row(step: string, id: string, tsMs: number): string {
  return JSON.stringify({ ts: new Date(tsMs).toISOString(), run_id: id, task_id: id, step, pad: "x".repeat(40) });
}

/** `n` decision-relevant rows (retained by rotation) with ascending `ts` from `tsMs`. */
function coreRows(tag: string, n: number, tsMs: number): string[] {
  return Array.from({ length: n }, (_, i) => row("run.start", `${tag}-${i}`, tsMs + i));
}

/** `n` archive-only rows — appended bytes the rate counts but the core never keeps. */
function noiseRows(tag: string, n: number, tsMs: number): string[] {
  return Array.from({ length: n }, (_, i) => row("worker.progress", `${tag}-${i}`, tsMs + i));
}

const append = (path: string, rows: string[]) => writeFileSync(path, rows.join("\n") + "\n", { flag: "a" });
const liveRows = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);
const rotate = (path: string, atMs: number) =>
  rotateLedger(path, { ceilingBytes: CEILING, now: () => new Date(atMs), smoothingWindowMs: 0 });

function inTempLedger(fn: (path: string) => void): void {
  const fixture = writeLedger();
  try {
    fn(fixture.path);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

function shedPointer(path: string): Record<string, unknown> | undefined {
  const raw = liveRows(path).find((r) => r.includes('"ledger.rotation_shed"'));
  return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
}

/** Seeds a first rotation at `firstAt`: a core over the ceiling, shed to the unmeasured 90%. */
function firstRotation(path: string, firstAt: number): void {
  append(path, coreRows("A", 250, T0));
  assert.equal(rotate(path, firstAt).rotated, true, "sanity: the first rotation ran");
}

test("rotation sheds the retained core to leave an hour of the measured append rate as headroom", () => {
  inTempLedger((path) => {
    const firstAt = T0 + MINUTE;
    firstRotation(path, firstAt);
    const carriedBytes = (JSON.parse(readFileSync(ledgerCarriedPrefixPath(path), "utf8")) as { bytes: number }).bytes;

    append(path, noiseRows("N", 40, T0 + 2 * MINUTE));
    const sizeBefore = statSync(path).size;
    assert.ok(sizeBefore > CEILING, "sanity: the appends crossed the ceiling");
    const secondAt = firstAt + 30 * MINUTE;
    const r = rotate(path, secondAt);
    assert.equal(r.rotated, true);

    const appendedBytes = sizeBefore - carriedBytes;
    const expectedRate = (appendedBytes * 3_600_000) / (secondAt - firstAt);
    const expectedTarget = Math.floor(CEILING - expectedRate * (LEDGER_ROTATION_HEADROOM_MS / 3_600_000));
    assert.equal(r.appendBytesPerHour, expectedRate, "the rate is the bytes since the last rotation over the time since it");
    assert.equal(r.targetBytes, expectedTarget, "the target is the ceiling minus an hour of that rate");
    assert.ok(expectedTarget < CEILING * 0.9 - 2000, "control: the measured target sits well below the old 90%");

    const liveSize = statSync(path).size;
    assert.ok(liveSize < expectedTarget, `the live ledger (${liveSize}) ends below the target (${expectedTarget})`);
    assert.ok(liveSize > expectedTarget - 400, `and it sheds no more than it must (${liveSize} vs ${expectedTarget})`);

    const pointer = shedPointer(path);
    assert.ok(pointer, "the rotation left its shed row");
    assert.equal(pointer.append_bytes_per_hour, Math.round(expectedRate), "the rotation row records the rate");
    assert.equal(pointer.target_bytes, expectedTarget, "the rotation row records the target");

    const kept = liveRows(path)
      .map((raw) => JSON.parse(raw) as { step: string; run_id: string })
      .filter((x) => x.step === "run.start")
      .map((x) => Number(x.run_id.split("-")[1]));
    assert.ok(kept.length > 0, "sanity: part of the core is still live");
    assert.deepEqual(kept, Array.from({ length: kept.length }, (_, i) => 250 - kept.length + i), "the OLDEST rows were shed");

    // The next rotation smooths its own measurement into the rate this one recorded.
    const carried2 = (JSON.parse(readFileSync(ledgerCarriedPrefixPath(path), "utf8")) as { bytes: number }).bytes;
    append(path, noiseRows("M", 120, T0 + 40 * MINUTE));
    const size3 = statSync(path).size;
    const thirdAt = secondAt + 60 * MINUTE;
    const r3 = rotate(path, thirdAt);
    const measured3 = ((size3 - carried2) * 3_600_000) / (thirdAt - secondAt);
    assert.equal(r3.appendBytesPerHour, 0.5 * measured3 + 0.5 * expectedRate, "the rate is smoothed across rotations");
  });
});

test("a first rotation with no measured rate keeps the ninety percent target", () => {
  inTempLedger((path) => {
    append(path, coreRows("A", 250, T0));
    const r = rotate(path, T0 + MINUTE);
    assert.equal(r.rotated, true);
    assert.equal(r.appendBytesPerHour, undefined, "no prior rotation, so no rate");
    assert.equal(r.targetBytes, Math.floor(CEILING * 0.9));
    const liveSize = statSync(path).size;
    assert.ok(liveSize < CEILING * 0.9 && liveSize > CEILING * 0.9 - 400, `shed to just under 90% (${liveSize})`);
    const pointer = shedPointer(path);
    assert.ok(pointer, "the rotation left its shed row");
    assert.equal("append_bytes_per_hour" in pointer, false, "an unmeasured rotation records no rate");
  });
});

test("a rotated ledger is still strictly below its ceiling under the new target", () => {
  const cases: Array<[string, number, number, (target: number) => boolean]> = [
    // [label, core rows appended after the first rotation, minutes until the second, target check]
    ["a near-zero rate puts the target at the ceiling itself", 60, 600_000, (t) => t > CEILING * 0.99],
    ["an hourly rate above the ceiling puts the target at zero", 60, 1, (t) => t === 0],
    ["a mid-range rate", 60, 60, (t) => t > 0 && t < CEILING * 0.9],
  ];
  for (const [label, n, minutes, targetIsInBand] of cases) {
    inTempLedger((path) => {
      const firstAt = T0 + MINUTE;
      firstRotation(path, firstAt);
      append(path, coreRows("B", n, T0 + 2 * MINUTE));
      const r = rotate(path, firstAt + minutes * MINUTE);
      assert.equal(r.rotated, true, `${label}: sanity, it rotated`);
      assert.ok(r.appendBytesPerHour !== undefined, `${label}: sanity, the rate was measured`);
      assert.ok(targetIsInBand(r.targetBytes!), `${label}: sanity, the target (${r.targetBytes}) is in this case's band`);
      assert.equal(ledgerExceedsRotationCeiling(path, CEILING), false, `${label}: live is not over the ceiling`);
      assert.ok(statSync(path).size < CEILING, `${label}: live is STRICTLY below the ceiling`);
    });
  }
});
