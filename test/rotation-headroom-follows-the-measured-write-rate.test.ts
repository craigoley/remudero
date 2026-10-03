/**
 * W1-T4393 — rotation headroom follows the measured write rate.
 *
 * MEASURED on the fleet host 2026-09-24: the retained decision core alone filled the fixed 4 MiB
 * ceiling, so every rotation ended in the W1-T244 convergence shed and the next ~420 KB of appends
 * tripped it again (~4.2 rotations an hour). The fix keeps the core whole and raises the EFFECTIVE
 * ceiling to the carried core plus one hour of the measured append rate, capped at the backstop
 * multiple of the fixed ceiling, persisted in the carried-prefix sidecar.
 *
 * The rate is measured against the newest archive's real mtime, so each test backdates that mtime
 * to a known age instead of sleeping.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  LEDGER_ROTATION_BACKSTOP_MULTIPLIER,
  ledgerCarriedPrefixPath,
  ledgerExceedsRotationCeiling,
  rotateLedger,
} from "../src/lib/ledger.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const T0 = Date.parse("2026-09-23T10:00:00.000Z");
const CEILING = 4000;
const HALF_HOUR_MS = 30 * 60_000;

function row(step: string, id: string, tsMs: number, pad = ""): string {
  return JSON.stringify({ ts: new Date(tsMs).toISOString(), run_id: id, task_id: id, step, ...(pad ? { pad } : {}) });
}

/** `count` rows of `step`, each tagged `tag-i`, padded so the byte totals are easy to reason about. */
function rows(step: string, tag: string, tsMs: number, count: number, pad = ""): string[] {
  return Array.from({ length: count }, (_, i) => row(step, `${tag}-${i}`, tsMs + i, pad));
}

function append(path: string, lines: string[]): void {
  writeFileSync(path, lines.join("\n") + "\n", { flag: "a" });
}

/** Append one padded row that brings the live file to exactly `target` bytes. */
function growTo(path: string, target: number, tag: string, tsMs: number): void {
  const shell = Buffer.byteLength(row("worker.progress", tag, tsMs, "-") + "\n", "utf8") - 1;
  const need = target - readFileSync(path).length - shell;
  assert.ok(need >= 1, `sanity: room to grow to ${target} bytes`);
  append(path, [row("worker.progress", tag, tsMs, "x".repeat(need))]);
  assert.equal(readFileSync(path).length, target, "sanity: grew to the exact target");
}

interface Sidecar {
  bytes: number;
  sha256: string;
  rateBytesPerHour?: number;
  effectiveCeilingBytes?: number;
}

function sidecar(path: string): Sidecar {
  return JSON.parse(readFileSync(ledgerCarriedPrefixPath(path), "utf8")) as Sidecar;
}

function liveRows(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

/** Age every archive in `dir` to `ageMs` before the real now — the clock the rate is measured on. */
function ageArchives(dir: string, ageMs: number): void {
  const at = new Date(Date.now() - ageMs);
  const archives = readdirSync(dir).filter((n) => /^ledger\..+\.ndjson(\.gz)?$/.test(n));
  assert.ok(archives.length > 0, "sanity: a prior rotation left an archive to measure against");
  for (const name of archives) utimesSync(join(dir, name), at, at);
}

function inTempState(fn: (path: string, dir: string) => void): void {
  const fixture = writeLedger();
  try {
    fn(fixture.path, fixture.dir);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

// The cadence window is not under test; the measured rate and the ceiling it chooses are.
const rotate = (path: string, atMs: number) =>
  rotateLedger(path, { ceilingBytes: CEILING, now: () => new Date(atMs), smoothingWindowMs: 0 });

/** A first rotation that carries a small core and leaves one archive with no measured rate. */
function firstRotation(path: string, dir: string): Sidecar {
  writeFileSync(path, [...rows("run.start", "core", T0, 10), ...rows("worker.progress", "noise", T0 + 100, 40)].join("\n") + "\n");
  assert.equal(rotate(path, T0 + 60_000).rotated, true, "sanity: the first rotation ran");
  ageArchives(dir, HALF_HOUR_MS);
  return sidecar(path);
}

test("W1-T4393: the rotation ceiling rises to the retained core plus an hour of the measured append rate", () => {
  inTempState((path, dir) => {
    const before = firstRotation(path, dir);
    // Half an hour of archive-only appends, enough to cross the fixed ceiling.
    append(path, rows("worker.progress", "late", T0 + 120_000, 40, "x".repeat(20)));
    const appended = readFileSync(path).length - before.bytes;
    assert.ok(before.bytes + appended > CEILING, "sanity: the live file crossed the fixed ceiling");

    assert.equal(rotate(path, T0 + 180_000).rotated, true);
    const after = sidecar(path);
    // `appended` bytes in ~30 min is ~2x that an hour; real elapsed time runs a hair past 30 min.
    assert.ok(typeof after.rateBytesPerHour === "number", "the sidecar records the measured rate");
    const rate = after.rateBytesPerHour as number;
    assert.ok(rate > appended * 1.9 && rate <= appended * 2, `rate ${rate} is an hour of ${appended} bytes per half hour`);

    const expected = Math.ceil(after.bytes + rate);
    assert.ok(expected > CEILING, "sanity: the core plus an hour of appends exceeds the fixed ceiling");
    assert.equal(after.effectiveCeilingBytes, expected, "effective ceiling = retained core + one hour of the measured rate");
    const headroom = liveRows(path).map((r) => JSON.parse(r) as Record<string, unknown>).find((r) => r.step === "ledger.rotation_headroom");
    assert.deepEqual(
      headroom && { rate: headroom.rate_bytes_per_hour, ceiling: headroom.ceiling_bytes },
      { rate, ceiling: expected },
      "the rotation ledgers the measured rate and the chosen ceiling",
    );

    // The per-append check honours the raised ceiling: above the fixed ceiling is no longer over.
    growTo(path, expected, "at", T0 + 240_000);
    assert.equal(ledgerExceedsRotationCeiling(path, CEILING), false, "at the raised ceiling, above the fixed one: no rotation");
    append(path, ["{}"]);
    assert.equal(ledgerExceedsRotationCeiling(path, CEILING), true, "past the raised ceiling: rotation is due");
  });
});

test("W1-T4393: a rotation under the raised ceiling sheds no retained decision row", () => {
  inTempState((path, dir) => {
    firstRotation(path, dir);
    // Decision rows a live-only reader keeps, together already bigger than the fixed ceiling,
    // arriving amid enough appends that an hour of them raises the ceiling well above the core.
    const decisions = rows("review.posted", "decision", T0 + 120_000, 30, "r".repeat(90));
    append(path, [...decisions, ...rows("worker.progress", "burst", T0 + 130_000, 60, "n".repeat(60))]);
    const decisionBytes = Buffer.byteLength(decisions.join("\n") + "\n", "utf8");
    assert.ok(decisionBytes > CEILING, `sanity: the decision rows alone (${decisionBytes} B) exceed the fixed ceiling`);

    const result = rotate(path, T0 + 180_000);
    assert.equal(result.rotated, true);
    const live = liveRows(path);
    const missing = decisions.filter((d) => !live.includes(d));
    assert.deepEqual(missing, [], "every retained decision row is still in the live file");
    assert.equal(live.some((r) => r.includes("\"ledger.rotation_shed\"")), false, "no convergence shed ran");
    const effective = sidecar(path).effectiveCeilingBytes as number;
    assert.ok(effective > CEILING && readFileSync(path).length < effective, "the core sits under the raised ceiling");
  });
});

test("W1-T4393: a first rotation with no measured rate keeps the fixed ceiling", () => {
  inTempState((path) => {
    // No archive exists yet, so there is nothing to measure a rate against. The decision core alone
    // exceeds the fixed ceiling: with no rate the W1-T244 shed must still bring it under that ceiling.
    writeFileSync(path, [...rows("review.posted", "first", T0, 30, "r".repeat(90)), ...rows("worker.progress", "noise", T0 + 100, 20)].join("\n") + "\n");
    assert.equal(rotate(path, T0 + 60_000).rotated, true);

    assert.ok(readFileSync(path).length < CEILING, "the live file converged under the FIXED ceiling");
    assert.ok(liveRows(path).some((r) => r.includes("\"ledger.rotation_shed\"")), "the convergence shed ran against the fixed ceiling");
    assert.equal(liveRows(path).some((r) => r.includes("\"ledger.rotation_headroom\"")), false, "no rate was claimed");
    const after = sidecar(path);
    assert.equal(after.rateBytesPerHour ?? 0, 0, "no measured rate is recorded");
    assert.equal(after.effectiveCeilingBytes ?? CEILING, CEILING, "the recorded ceiling is the fixed one");
    growTo(path, CEILING + 1, "pad", T0 + 120_000);
    assert.equal(ledgerExceedsRotationCeiling(path, CEILING), true, "the per-append check uses the fixed ceiling");
  });
});

test("W1-T4393: the raised ceiling never exceeds the backstop multiple of the fixed ceiling", () => {
  const backstop = CEILING * LEDGER_ROTATION_BACKSTOP_MULTIPLIER;
  inTempState((path, dir) => {
    firstRotation(path, dir);
    // Half an hour of appends worth far more than the backstop over an hour.
    append(path, rows("worker.progress", "flood", T0 + 120_000, 20, "f".repeat(400)));
    assert.equal(rotate(path, T0 + 180_000).rotated, true);
    const after = sidecar(path);
    assert.ok((after.rateBytesPerHour as number) + after.bytes > backstop, "sanity: uncapped, the ceiling would pass the backstop");
    assert.equal(after.effectiveCeilingBytes, backstop, "the raised ceiling is capped at the backstop");

    // Even a sidecar claiming a far larger ceiling cannot lift the per-append check past the backstop.
    writeFileSync(ledgerCarriedPrefixPath(path), JSON.stringify({ ...after, effectiveCeilingBytes: backstop * 10 }));
    growTo(path, backstop, "fill", T0 + 240_000);
    assert.equal(ledgerExceedsRotationCeiling(path, CEILING), false, "at the backstop: within the raised ceiling");
    append(path, ["{}"]);
    assert.equal(ledgerExceedsRotationCeiling(path, CEILING), true, "past the backstop: rotation is due whatever the sidecar says");
  });
});
