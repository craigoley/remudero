/**
 * W1-T1286 — THE UNION RESOLVER'S COVERAGE GUARD WATCHED ONLY WHAT ITS OWN ENUMERATOR ALREADY
 * MATCHED. `unread` (ledger-grep.ts) is built by iterating `ledgerRotationEntries`' OUTPUT, so a
 * `ledger.*` name whose suffix the enumerator does not recognise (neither `.ndjson.gz` nor
 * `.ndjson`) was filtered out one step before the guard ever saw it — invisible to `unread`,
 * invisible to `ok`, invisible to every consumer. `ok` could read `true` over a corpus the
 * enumerator never fully enumerated.
 *
 * THE FIX NAMES IT WITHOUT REFUSING ON IT. `resolveLedgerUnion` already holds `names` from its
 * own `readdirSync`; `unclassified` is the (cheap, zero-extra-I/O) set-difference between
 * `ledger.*` candidates and what `ledgerRotationEntries` actually classified. It is surfaced as
 * its own field, distinct from `unread`, and deliberately does NOT flip `ok` false by itself: a
 * stray `.bak`/`.tmp`/half-written download from the same out-of-band process that produces the
 * `.gz` half is a real, undocumented possibility, and refusing outright on it would bind on an
 * otherwise-healthy state dir — the exact failure mode this repo has already lived through once
 * (see this module's own doc). `ok` keeps refusing on `archiveCount === 0` and on any genuinely
 * unread (found-but-unopenable) rotation, unchanged.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { resolveLedgerUnion } from "../src/lib/ledger-grep.js";

function tmpStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeGzArchive(stateDir: string, name: string, lines: string[]): void {
  writeFileSync(join(stateDir, name), gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8")));
}

function basenames(paths: string[]): string[] {
  return paths.map((p) => p.split("/").pop()!);
}

// ── (1) a file matching no known form is NAMED, not silently skipped ───────────────────────────

test("a ledger.* file matching neither rotation form is named in unclassified, not silently dropped", () => {
  const dir = tmpStateDir("rmd-ledger-unclassified-named-");
  try {
    writeGzArchive(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz", [
      '{"ts":"2026-07-01T00:00:00.000Z","step":"run.start","task":"W1-T1"}',
    ]);
    // Neither `.ndjson.gz` nor `.ndjson` — a decoy the enumerator returns `undefined` for.
    writeFileSync(join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.bak"), "irrelevant\n");

    const result = resolveLedgerUnion(dir, "run\\.start");

    assert.deepEqual(
      basenames(result.unclassified ?? []),
      ["ledger.2026-07-01T00-00-00-000Z.ndjson.bak"],
      "the decoy is named in unclassified rather than vanishing before the coverage guard sees it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (2) a fully-classified state dir reports nothing unclassified ──────────────────────────────

test("a state dir whose every ledger file classifies reports unclassified: []", () => {
  const dir = tmpStateDir("rmd-ledger-unclassified-none-");
  try {
    writeGzArchive(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz", ['{"step":"run.start"}']);
    writeFileSync(join(dir, "ledger.2026-08-10T00-00-00-000Z.ndjson"), '{"step":"run.start"}\n');
    writeFileSync(join(dir, "ledger.ndjson"), '{"step":"run.start"}\n');

    const result = resolveLedgerUnion(dir, "run\\.start");

    assert.deepEqual(result.unclassified, [], "gz rotation, plain rotation and the live file all classify");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (3) a non-corpus artefact does not silently take the whole union down ──────────────────────

test("an unclassified ledger artefact does not take the whole union down — ok and matches are unaffected", () => {
  const dir = tmpStateDir("rmd-ledger-unclassified-safe-");
  try {
    writeGzArchive(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz", [
      '{"ts":"2026-07-01T00:00:00.000Z","step":"run.start","task":"W1-T1"}',
    ]);
    writeFileSync(
      join(dir, "ledger.2026-08-10T00-00-00-000Z.ndjson"),
      '{"ts":"2026-08-10T00:00:00.000Z","step":"run.start","task":"W1-T2"}\n',
    );
    // A stray artefact sitting right next to two perfectly good rotations.
    writeFileSync(join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.tmp"), "half-written\n");

    const result = resolveLedgerUnion(dir, "run\\.start");

    assert.equal(result.ok, true, "an unclassified artefact alone must not flip ok false");
    assert.equal(result.archiveCount, 2, "only the two real rotations count as archives");
    assert.ok(result.matches.some((l) => l.includes("W1-T1")));
    assert.ok(result.matches.some((l) => l.includes("W1-T2")));
    assert.deepEqual(
      basenames(result.unclassified ?? []),
      ["ledger.2026-07-01T00-00-00-000Z.ndjson.tmp"],
      "the artefact is still named, just not fatal",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (4) a matched-but-unreadable rotation still refuses exactly as today ───────────────────────

test("a matched but unreadable rotation still refuses exactly as it does today, independent of unclassified", () => {
  const dir = tmpStateDir("rmd-ledger-unclassified-unread-");
  try {
    // Present, correctly named, and undecompressable — reported via `unread`, never `unclassified`.
    writeFileSync(join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz"), "not gzip data");
    // An unrelated decoy sitting alongside it must not change this verdict either way.
    writeFileSync(join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.bak"), "irrelevant\n");
    writeFileSync(join(dir, "ledger.ndjson"), '{"ts":"2026-08-01T00:00:00.000Z","step":"run.start"}\n');

    const result = resolveLedgerUnion(dir, "run\\.start");

    assert.equal(result.archiveCount, 1, "the corrupt file is still FOUND and counted as an archive");
    assert.deepEqual(
      basenames(result.unread),
      ["ledger.2026-07-01T00-00-00-000Z.ndjson.gz"],
      "the unreadable rotation is named in unread, not unclassified",
    );
    assert.equal(result.ok, false, "coverage, not readability — refuses exactly as before");
    assert.deepEqual(result.matches, [], "the partial answer is still withheld");
    assert.deepEqual(
      basenames(result.unclassified ?? []),
      ["ledger.2026-07-01T00-00-00-000Z.ndjson.bak"],
      "the decoy is named separately and does not merge into unread",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (5) the zero-archive refusal still refuses and never falls back to the live file ───────────

test("the zero-archive refusal still refuses and never falls back to the live file, even with an unclassified file present", () => {
  const dir = tmpStateDir("rmd-ledger-unclassified-zero-");
  try {
    // No file here classifies as a rotation — only a decoy and the live file.
    writeFileSync(join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.bak"), "irrelevant\n");
    writeFileSync(
      join(dir, "ledger.ndjson"),
      '{"ts":"2026-08-01T00:00:00.000Z","step":"run.start","task":"W1-T4"}\n',
    );

    const result = resolveLedgerUnion(dir, "run\\.start");

    assert.equal(result.archiveCount, 0);
    assert.equal(result.ok, false, "the zero-archive refusal is unchanged by unclassified files existing");
    assert.deepEqual(result.matches, [], "must never answer from the live file alone");
    assert.deepEqual(
      basenames(result.unclassified ?? []),
      ["ledger.2026-07-01T00-00-00-000Z.ndjson.bak"],
      "the decoy is still named even while the whole union refuses",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (6) both rotation forms still classify from the name before any read ───────────────────────

test("both rotation forms still classify from the name before any read, unaffected by the unclassified filter", () => {
  const dir = tmpStateDir("rmd-ledger-unclassified-bothforms-");
  try {
    writeGzArchive(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz", [
      '{"ts":"2026-07-01T00:00:00.000Z","step":"run.start","marker":"only-in-gzip"}',
    ]);
    writeFileSync(
      join(dir, "ledger.2026-08-10T00-00-00-000Z.ndjson"),
      '{"ts":"2026-08-10T00:00:00.000Z","step":"run.start","marker":"only-in-plain"}\n',
    );
    writeFileSync(
      join(dir, "ledger.ndjson"),
      '{"ts":"2026-08-12T00:00:00.000Z","step":"run.start","marker":"only-in-live"}\n',
    );

    const result = resolveLedgerUnion(dir, "run\\.start");

    assert.equal(result.ok, true);
    assert.equal(result.archiveCount, 2, "both the gzip and the plain rotation are classified as archives");
    assert.ok(result.matches.some((l) => l.includes("only-in-gzip")), "the gzip form was decompressed and read");
    assert.ok(result.matches.some((l) => l.includes("only-in-plain")), "the plain form was read without gunzip");
    assert.ok(result.matches.some((l) => l.includes("only-in-live")));
    assert.deepEqual(result.unclassified, [], "no decoy exists in this corpus, so unclassified is empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
