/**
 * test/helpers/ledger-fixture.ts — W1-T2903: the shared ledger fixture.
 *
 * WHY THIS EXISTS. Audit recon-2026-09-05 R-41 counted 26 distinct ledger helpers across
 * `test/*.test.ts` — almost all of them the same three lines: mkdtemp a dir, `JSON.stringify`
 * each row onto its own line, `writeFileSync` the result to `<dir>/ledger.ndjson`. This module is
 * that shape, plus the ROTATION form `src/lib/ledger.ts`'s real `rotateLedger` produces (an
 * archive named `ledger.<ISO-stamp>.ndjson[.gz]`, read back by `ledgerRotationEntries` in
 * src/lib/ledger-grep.ts) — a shape no hand-rolled test helper reproduced, because rotation is
 * itself only ever exercised by writing the archive file directly.
 *
 * `NEVER_ROTATE_FILENAME` (src/lib/log-rotation.ts) names the LIVE file this fixture writes to —
 * imported rather than re-typed as the literal `"ledger.ndjson"`, so this fixture cannot drift
 * from the one name every real reader (status.ts, ledger-grep.ts, autonomy.ts) actually opens.
 */
import { gzipSync } from "node:zlib";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NEVER_ROTATE_FILENAME } from "../../src/lib/log-rotation.js";
import { RMD_TMP_PREFIX } from "../../src/lib/tmp.js";

/** One already-rotated archive to seed alongside the live ledger. */
export interface LedgerRotationFixture {
  /** The instant this archive's name is stamped with — mirrors `rotateLedger`'s own
   *  `datedArchivePath` (src/lib/ledger.ts: `now.toISOString().replace(/[:.]/g, "-")`), so a
   *  reader that parses the stamp back out of the name (ledger-grep.ts) sees a real,
   *  round-trippable ISO instant. */
  at: string;
  rows: Array<Record<string, unknown>>;
  /** Write `.ndjson.gz` (gzip-compressed) instead of plain `.ndjson`. Default false. */
  gz?: boolean;
}

export interface LedgerFixtureOpts {
  /** Directory to write into. A fresh `mkdtempSync`'d dir when omitted. */
  dir?: string;
  /** Already-rotated archives to seed alongside the live ledger — see
   *  {@link LedgerRotationFixture}. */
  rotations?: LedgerRotationFixture[];
}

export interface LedgerFixture {
  /** The directory holding the live ledger and any seeded rotations. */
  readonly dir: string;
  /** Absolute path to the live `ledger.ndjson`. */
  readonly path: string;
  /** Append more rows to the live ledger (e.g. simulating a second dispatch cycle). */
  append(rows: Array<Record<string, unknown>>): void;
}

function ndjson(rows: Array<Record<string, unknown>>): string {
  return rows.length > 0 ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
}

function rotatedName(at: string, gz: boolean): string {
  const base = basename(NEVER_ROTATE_FILENAME).replace(/\.ndjson$/, "");
  const stamp = at.replace(/[:.]/g, "-");
  return `${base}.${stamp}.ndjson${gz ? ".gz" : ""}`;
}

/** Build a throwaway ledger: the live `ledger.ndjson` seeded with `rows`, plus any
 *  {@link LedgerFixtureOpts.rotations}. */
export function writeLedger(rows: Array<Record<string, unknown>> = [], opts: LedgerFixtureOpts = {}): LedgerFixture {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ledger-fixture-`));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, NEVER_ROTATE_FILENAME);
  writeFileSync(path, ndjson(rows));
  for (const rotation of opts.rotations ?? []) {
    const name = rotatedName(rotation.at, rotation.gz ?? false);
    const body = ndjson(rotation.rows);
    writeFileSync(join(dir, name), rotation.gz ? gzipSync(Buffer.from(body)) : body);
  }
  return {
    dir,
    path,
    append(more: Array<Record<string, unknown>>): void {
      appendFileSync(path, ndjson(more));
    },
  };
}
