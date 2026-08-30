/**
 * W1-T2482 — THE LEDGER WRITER NEVER COMPRESSED WHAT THE READER WAS ALREADY BUILT TO DECOMPRESS.
 *
 * `ledger-grep.ts`'s `ledgerRotationEntries` has classified `<base>.<stamp>.ndjson.gz` as
 * gzip-form and `<base>.<stamp>.ndjson` as plain-form since W1-T444 — but `rotateLedger`
 * (ledger.ts) never produced the gzip form, so every rotation on a long-lived host accumulated
 * plain. Measured on the incident host: 47 uncompressed rotations, state dir 199M -> 29M after
 * gzip, 11 union-reading modules each paying to scan the uncompressed pile. This file proves
 * the writer now produces the form the reader already expects, WITHOUT the reader changing:
 * `resolveLedgerUnion` is imported here exactly as ledger-grep.ts exports it, untouched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { MAX_RETAINED_LINES_PER_STEP, appendLedger, rotateLedger } from "../src/lib/ledger.js";
import { resolveLedgerUnion } from "../src/lib/ledger-grep.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-ledger-rotation-compression-"));
}

/** Highly-compressible, realistic no-decision-consequence traffic — mirrors
 *  test/ledger-rotation.test.ts's own `noiseLine`, padded so a handful alone cross a small test
 *  ceiling and so the archive is large enough for a compression ratio to be meaningful. */
function noiseLine(n: number, tsMs: number, marker = "noise"): string {
  return JSON.stringify({
    ts: new Date(tsMs).toISOString(),
    step: "ci.polling",
    run_id: `${marker}-${n}`,
    task_id: "W1-NOISE",
    marker,
    detail: "x".repeat(200),
  });
}

function runStartLine(n: number, tsMs: number, taskId: string): string {
  return JSON.stringify({ ts: new Date(tsMs).toISOString(), run_id: `run-${n}`, task_id: taskId, step: "run.start" });
}

/** An `archiveFsDeps` whose `gzipSync` always throws — the injectable seam `rotateLedger` added
 *  for exactly this: proving the plain-archive fallback (and, in the FALSIFIER at the bottom,
 *  standing in for "someone reverted the compression") without monkey-patching `node:zlib`
 *  globally for the whole process. */
const compressionAlwaysFails = { gzipSync: (): Buffer => { throw new Error("forced: compression unavailable"); } };

function readGzip(path: string): string {
  return gunzipSync(readFileSync(path)).toString("utf8");
}

test("a rotation writes a gzipped archive rather than a plain one", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const lines = Array.from({ length: 2000 }, (_, i) => noiseLine(i, Date.now() - 1000 + i));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");
    const rawSize = statSync(ledgerPath).size;

    const result = rotateLedger(ledgerPath, { ceilingBytes: 1000 });
    assert.equal(result.rotated, true);
    assert.ok(result.archivePath, "a rotation that fires must name the archive it wrote");
    const archivePath = result.archivePath as string;

    assert.ok(
      archivePath.endsWith(".ndjson.gz"),
      `archive must land in the gzip form the reader already classifies, got ${archivePath}`,
    );

    // Not merely NAMED .gz — actually a gzip stream: the two-byte magic number every gzip
    // decoder (including ledger-grep.ts's own gunzipSync call) checks for.
    const magic = readFileSync(archivePath).subarray(0, 2);
    assert.equal(magic[0], 0x1f, "archive bytes must start with the gzip magic number (byte 0)");
    assert.equal(magic[1], 0x8b, "archive bytes must start with the gzip magic number (byte 1)");

    const archiveContent = readGzip(archivePath);
    assert.equal(archiveContent.trim().split("\n").length, 2000, "every pre-rotation line survives, verbatim, decompressed");

    const archiveBytes = statSync(archivePath).size;
    assert.ok(
      archiveBytes < rawSize * 0.5,
      `highly-repetitive content must compress substantially (archive ${archiveBytes}B vs raw ${rawSize}B)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the union reader (resolveLedgerUnion, imported unmodified from ledger-grep.ts) consumes a freshly written rotation with no reader change", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const marker = "fresh-rotation-marker";
    const lines = [
      ...Array.from({ length: 300 }, (_, i) => noiseLine(i, Date.now() - 1000 + i)),
      JSON.stringify({ ts: new Date().toISOString(), step: "ci.polling", run_id: "m", task_id: "W1-NOISE", marker }),
    ];
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const result = rotateLedger(ledgerPath, { ceilingBytes: 1000 });
    assert.equal(result.rotated, true);
    assert.ok((result.archivePath as string).endsWith(".ndjson.gz"), "sanity: this rotation produced the gzip form");

    // resolveLedgerUnion is the exact function ledger-grep.ts exports — this task changes only
    // the writer, so proving THIS function (untouched) already reads the freshly written
    // archive is the proof no reader-side change was needed.
    const union = resolveLedgerUnion(dir, `"marker":"${marker}"`);
    assert.equal(union.ok, true, "the union must read the archive it just wrote without error");
    assert.equal(union.archiveCount, 1, "exactly one archive was written");
    assert.deepEqual(union.unread, [], "the freshly gzipped archive must not be reported unreadable");
    assert.equal(union.matches.length, 1, "the marker line, archived by rotation, must be found through the union");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a union over compressed archives returns byte-identical lines to one over plain archives", () => {
  const compressedDir = tmpDir();
  const plainDir = tmpDir();
  try {
    const now = () => new Date("2026-08-30T12:00:00.000Z");
    const buildLines = (marker: string) =>
      Array.from({ length: 300 }, (_, i) => noiseLine(i, Date.parse("2026-08-30T11:00:00.000Z") + i, marker));

    // Identical content, identical clock, into two separate roots — the only difference is
    // whether compression is allowed to succeed.
    for (const [dir, marker] of [
      [compressedDir, "identical-content"],
      [plainDir, "identical-content"],
    ] as const) {
      const ledgerPath = join(dir, "ledger.ndjson");
      writeFileSync(ledgerPath, buildLines(marker).join("\n") + "\n");
    }

    const compressedResult = rotateLedger(join(compressedDir, "ledger.ndjson"), { ceilingBytes: 1000, now });
    const plainResult = rotateLedger(join(plainDir, "ledger.ndjson"), {
      ceilingBytes: 1000,
      now,
      archiveFsDeps: compressionAlwaysFails,
    });

    assert.ok((compressedResult.archivePath as string).endsWith(".ndjson.gz"), "sanity: compressed side landed gzip");
    assert.ok(!(plainResult.archivePath as string).endsWith(".gz"), "sanity: plain side landed plain (compression forced to fail)");

    const compressedUnion = resolveLedgerUnion(compressedDir, `"marker":"identical-content"`);
    const plainUnion = resolveLedgerUnion(plainDir, `"marker":"identical-content"`);

    assert.equal(compressedUnion.ok, true);
    assert.equal(plainUnion.ok, true);
    assert.deepEqual(
      [...compressedUnion.matches].sort(),
      [...plainUnion.matches].sort(),
      "compressing the archive must never change which lines a union read returns",
    );
  } finally {
    rmSync(compressedDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  }
});

test("a state directory holding both forms is read completely and neither form is skipped", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");

    // First rotation: compression succeeds -> a .ndjson.gz archive.
    writeFileSync(
      ledgerPath,
      Array.from({ length: 300 }, (_, i) => noiseLine(i, Date.parse("2026-08-30T10:00:00.000Z") + i, "only-in-gzip-archive")).join(
        "\n",
      ) + "\n",
    );
    const first = rotateLedger(ledgerPath, { ceilingBytes: 1000, now: () => new Date("2026-08-30T10:05:00.000Z") });
    assert.ok((first.archivePath as string).endsWith(".ndjson.gz"), "sanity: first rotation landed gzip");

    // Grow the live ledger back past the ceiling and rotate again, this time forcing
    // compression to fail -> a second, plain .ndjson archive lands beside the first.
    writeFileSync(
      ledgerPath,
      Array.from({ length: 300 }, (_, i) => noiseLine(i, Date.parse("2026-08-30T11:00:00.000Z") + i, "only-in-plain-archive")).join(
        "\n",
      ) + "\n",
      { flag: "a" },
    );
    const second = rotateLedger(ledgerPath, {
      ceilingBytes: 1000,
      now: () => new Date("2026-08-30T11:05:00.000Z"),
      archiveFsDeps: compressionAlwaysFails,
    });
    assert.ok(!(second.archivePath as string).endsWith(".gz"), "sanity: second rotation landed plain");

    const archives = readdirSync(dir).filter((f) => f !== "ledger.ndjson");
    assert.equal(archives.length, 2, "sanity: one gzip archive and one plain archive both exist on disk");

    const gzipHalf = resolveLedgerUnion(dir, `"marker":"only-in-gzip-archive"`);
    const plainHalf = resolveLedgerUnion(dir, `"marker":"only-in-plain-archive"`);
    assert.equal(gzipHalf.ok, true);
    assert.equal(gzipHalf.matches.length, 300, "every line unique to the gzip archive must be found");
    assert.equal(plainHalf.ok, true);
    assert.equal(plainHalf.matches.length, 300, "every line unique to the plain archive must be found");

    const both = resolveLedgerUnion(dir, `"task_id":"W1-NOISE"`);
    assert.equal(both.ok, true);
    assert.deepEqual(both.unread, [], "neither archive form may be reported unreadable");
    assert.equal(both.archiveCount, 2, "both rotation files must be counted as archives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the live ledger is never compressed, so an append-in-progress is untouched", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, Array.from({ length: 300 }, (_, i) => noiseLine(i, Date.now() - 1000 + i)).join("\n") + "\n");

    const result = rotateLedger(ledgerPath, { ceilingBytes: 1000 });
    assert.equal(result.rotated, true);

    const liveBytes = readFileSync(ledgerPath);
    const magic = liveBytes.subarray(0, 2);
    assert.ok(
      liveBytes.length === 0 || magic[0] !== 0x1f || magic[1] !== 0x8b,
      "the live ledger must never carry the gzip magic number — only archives are compressed",
    );

    // An append immediately after rotation must land as plain, appendable NDJSON — the shape
    // appendLedger's own O_APPEND single-writeSync discipline requires.
    appendLedger(ledgerPath, { run_id: "post-rotation", task_id: "W1-LIVE", step: "run.start" }, { ceilingBytes: Number.MAX_SAFE_INTEGER });
    const liveText = readFileSync(ledgerPath, "utf8");
    const parsedLast = JSON.parse(liveText.trim().split("\n").at(-1) as string) as Record<string, unknown>;
    assert.equal(parsedLast.run_id, "post-rotation", "an append right after rotation lands as a plain, readable NDJSON line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rotation that cannot be compressed still lands as a readable archive rather than being lost", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const lines = Array.from({ length: 250 }, (_, i) => noiseLine(i, Date.now() - 1000 + i));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const result = rotateLedger(ledgerPath, { ceilingBytes: 1000, archiveFsDeps: compressionAlwaysFails });
    assert.equal(result.rotated, true, "a rotation must still fire even when compression cannot");
    assert.ok(result.archivePath, "a rotation that fires must still name the archive it wrote");
    const archivePath = result.archivePath as string;
    assert.ok(!archivePath.endsWith(".gz"), "a compression failure must land the archive PLAIN, never silently dropped");

    const archiveContent = readFileSync(archivePath, "utf8");
    assert.equal(archiveContent.trim().split("\n").length, 250, "every pre-rotation line survives, verbatim, in the fallback archive");

    // And the reader still consumes it — the plain form has been classified since W1-T444.
    const union = resolveLedgerUnion(dir, `"task_id":"W1-NOISE"`);
    assert.equal(union.ok, true);
    assert.deepEqual(union.unread, [], "the plain fallback archive is still fully readable through the union");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the retained newest lines per step are unchanged by compression", () => {
  const compressedDir = tmpDir();
  const plainDir = tmpDir();
  try {
    const now = () => new Date("2026-08-30T12:00:00.000Z");
    const base = Date.parse("2026-08-30T11:00:00.000Z");
    const capCount = MAX_RETAINED_LINES_PER_STEP + 100;
    const buildContent = () => Array.from({ length: capCount }, (_, i) => runStartLine(i, base + i, `W1-CAP-${i}`)).join("\n") + "\n";

    writeFileSync(join(compressedDir, "ledger.ndjson"), buildContent());
    writeFileSync(join(plainDir, "ledger.ndjson"), buildContent());

    const compressedResult = rotateLedger(join(compressedDir, "ledger.ndjson"), { ceilingBytes: 5000, now });
    const plainResult = rotateLedger(join(plainDir, "ledger.ndjson"), {
      ceilingBytes: 5000,
      now,
      archiveFsDeps: compressionAlwaysFails,
    });

    assert.equal(compressedResult.rotated, true);
    assert.equal(plainResult.rotated, true);
    assert.equal(
      compressedResult.retainedLineCount,
      plainResult.retainedLineCount,
      "the retention pipeline's decision (how many/which lines survive live) must not depend on whether the archive compressed",
    );

    // Compare the retained content itself, not the shed pointer's own `archive_path` field —
    // that field NAMES the archive (`....ndjson.gz` vs `....ndjson`), so it legitimately differs
    // between the two sides; everything else about what rotation decided to keep must not.
    const normalize = (raw: string): unknown => {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.step === "ledger.rotation_shed") delete parsed.archive_path;
      return parsed;
    };
    const compressedLive = readFileSync(join(compressedDir, "ledger.ndjson"), "utf8").trim().split("\n").map(normalize);
    const plainLive = readFileSync(join(plainDir, "ledger.ndjson"), "utf8").trim().split("\n").map(normalize);
    assert.deepEqual(compressedLive, plainLive, "the exact retained live lines are unchanged whether or not the archive compressed");
  } finally {
    rmSync(compressedDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  }
});

test("FALSIFIER — reverting the compression makes the archive land plain again, and the size assertion above would fail", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const lines = Array.from({ length: 2000 }, (_, i) => noiseLine(i, Date.now() - 1000 + i));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");
    const rawSize = statSync(ledgerPath).size;

    // "Revert the compression" without editing production source: force the one injectable
    // seam rotateLedger added for compression (archiveFsDeps.gzipSync) to fail, the same way a
    // future accidental revert of the gzip call would leave the archive plain.
    const reverted = rotateLedger(ledgerPath, { ceilingBytes: 1000, archiveFsDeps: compressionAlwaysFails });
    assert.equal(reverted.rotated, true);
    const archivePath = reverted.archivePath as string;
    assert.ok(!archivePath.endsWith(".gz"), "reverting compression must land the archive plain, not gzip-named");

    const archiveBytes = statSync(archivePath).size;
    assert.ok(
      !(archiveBytes < rawSize * 0.5),
      "the SAME 'must compress substantially' assertion the first test makes must FAIL once compression is reverted — " +
        "proving that assertion actually tests compression, not merely 'an archive exists'",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
