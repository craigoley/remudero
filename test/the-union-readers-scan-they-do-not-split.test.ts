import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import { readLedgerUnionRawLinesSync, readLedgerUnionRecordsSync } from "../src/lib/ledger-union.js";

// ── W1-T3335 — THE UNION READERS SCAN, THEY DO NOT SPLIT ──────────────────────────────────────
//
// MEASURED on the live corpus (919 files, 3.84 GB decompressed), one call each through
// `resolveLedgerUnion`, before and after:
//
//   sweep uncreditable-head   +585 MB -> +86 MB    323 matches
//   followup harvest        +3,804 MB -> +31 MB  6,485 matches
//   credit timestamps       +3,846 MB -> +7 MB  24,611 matches
//   authority table         +5,470 MB -> +10 MB  9,115 matches
//
// Four callers, ~13.7 GB against an 8 GB heap cap — the daemon's abort. The first row is the tell:
// 323 RETAINED lines still cost 585 MB, so the driver was the per-file whole-string plus its split
// array, not what was kept.
//
// THIS ASSERTS THE STRUCTURE, NOT A BYTE COUNT. A memory threshold on a shared runner is the
// wall-clock-bound shape (W1-T2811) — a red with no defect. The property that actually matters is
// decodable: the reader must never turn a whole corpus file into one string. A Buffer whose
// `toString` records its ranges proves that directly, and fails the moment anyone reverts to
// `.toString("utf8")` + `split("\n")`.

interface Recorded { calls: Array<[unknown, number | undefined, number | undefined]> }

/** A Buffer that remembers every `toString` range asked of it. */
function watched(buf: Buffer, rec: Recorded): Buffer {
  return new Proxy(buf, {
    get(target, prop) {
      if (prop === "toString") {
        return (...args: unknown[]) => {
          rec.calls.push([args[0], args[1] as number | undefined, args[2] as number | undefined]);
          return (target.toString as (...a: never[]) => string)(...(args as never[]));
        };
      }
      // NOT `Reflect.get(target, prop, receiver)`: `length` and friends are TypedArray accessors
      // that require the real buffer as `this`, and handing them the proxy yields a broken length —
      // which silently makes the scan loop below never run.
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? (v as (...a: never[]) => unknown).bind(target) : v;
    },
  }) as Buffer;
}

const ROWS = 400;
function corpus(): { text: string; lines: string[] } {
  const lines: string[] = [];
  for (let i = 0; i < ROWS; i++) {
    lines.push(JSON.stringify({ ts: `2026-09-10T00:00:${String(i % 60).padStart(2, "0")}.000Z`, step: i % 4 === 0 ? "wanted.step" : "other.step", i }));
  }
  return { text: `${lines.join("\n")}\n`, lines };
}

function deps(rec: Recorded, text: string) {
  const live = Buffer.from(text, "utf8");
  const archive = gzipSync(Buffer.from(text, "utf8"));
  return {
    readdirSync: () => ["ledger.2026-09-09T00-00-00-000Z.ndjson.gz", "ledger.ndjson"],
    existsSync: () => true,
    readFileSync: (p: string) => (p.endsWith(".gz") ? archive : watched(live, rec)),
    gunzipSync: (b: Buffer) => watched(Buffer.from(text, "utf8"), rec),
  };
}

test("W1-T3335: the raw-lines reader never decodes a whole corpus file into one string", () => {
  const { text, lines } = corpus();
  const rec: Recorded = { calls: [] };
  const out = readLedgerUnionRawLinesSync("/state", { pattern: /"step":"wanted\.step"/ }, deps(rec, text) as never);

  const expected = lines.filter((l) => /"step":"wanted\.step"/.test(l));
  assert.equal(out.rawLines.length, expected.length, "the matched set must be unchanged");
  assert.deepEqual(out.rawLines, expected, "and it must be the same lines, in order");

  // THE LOAD-BEARING ONE. A whole-file decode is a toString with no range, or a range spanning the
  // buffer. Either means the old shape is back.
  assert.ok(rec.calls.length > 0, "the reader must actually have decoded through the watched buffer");
  const wholeFile = rec.calls.filter(([, start, end]) => start === undefined || (start === 0 && (end === undefined || end >= text.length)));
  assert.deepEqual(wholeFile, [], `no call may decode the whole file; saw ${wholeFile.length} of ${rec.calls.length}`);
  // And it must be scanning per line, not per file.
  assert.ok(rec.calls.length >= ROWS, `expected a decode per line (>=${ROWS}), saw ${rec.calls.length}`);
});

test("W1-T3335: the records reader never decodes a whole corpus file into one string", () => {
  const { text } = corpus();
  const rec: Recorded = { calls: [] };
  const out = readLedgerUnionRecordsSync("/state", { pattern: /"step":"wanted\.step"/ }, deps(rec, text) as never);

  assert.ok(out.rows.length > 0, "the records reader must return the matched rows");
  const wholeFile = rec.calls.filter(([, start, end]) => start === undefined || (start === 0 && (end === undefined || end >= text.length)));
  assert.deepEqual(wholeFile, [], `no call may decode the whole file; saw ${wholeFile.length} of ${rec.calls.length}`);
});

test("W1-T3335: a file with no trailing newline still yields its last row", () => {
  // The scan advances past each newline; a final line with no terminator is the case a naive
  // index walk drops, and dropping the newest row of the live ledger would be silent.
  const rec: Recorded = { calls: [] };
  const line = JSON.stringify({ ts: "2026-09-10T00:00:00.000Z", step: "wanted.step", last: true });
  const out = readLedgerUnionRawLinesSync("/state", { pattern: /"step":"wanted\.step"/ }, deps(rec, line) as never);
  assert.ok(out.rawLines.includes(line), "a final unterminated line must not be lost");
});

test("W1-T3335: blank lines, CRLF and duplicate rows behave as before", () => {
  const rec: Recorded = { calls: [] };
  const a = JSON.stringify({ step: "wanted.step", n: 1 });
  const b = JSON.stringify({ step: "wanted.step", n: 2 });
  const text = `\n${a}\n\n${a}\n${b}\r\n\n`;
  const out = readLedgerUnionRawLinesSync("/state", { pattern: /"step":"wanted\.step"/ }, deps(rec, text) as never);
  // Dedupe is on by default, so the repeated row appears once; \r is trimmed as it always was.
  assert.deepEqual(out.rawLines, [a, b], "blank lines dropped, duplicates deduped, CRLF trimmed");
});
