/**
 * lib/ledger-grep.ts — the union `state/ledger.*.ndjson.gz` + `state/ledger.ndjson` that nothing
 * in this repo builds correctly today, with the ONE property that matters: it FAILS LOUD instead
 * of quietly answering from the live file alone.
 *
 * THE FAILURE THIS REPLACES. The idiom every operator brief has used —
 * `grep -h '<pat>' state/ledger.*.ndjson state/ledger.ndjson | sort -u` — glob-matches ZERO
 * archives, because every rotation on this host is `ledger.<ts>.ndjson.gz`, not `.ndjson`. Under
 * bash the non-matching glob passes through literally and grep silently skips it (no
 * `2>/dev/null` catches a plausible-looking non-error); under zsh the same command errors
 * outright. Either way the caller gets a live-file-only count that looks entirely reasonable —
 * `readLedgerLines` (status.ts) opens exactly ONE path, by design, so nothing upstream can tell
 * the difference between "the pattern is rare" and "the archives were never read". `run.start`
 * measured 223 live against 696 over the true union — a 3.1x undercount that published wrong
 * before being retracted.
 *
 * WHY A ZERO-ARCHIVE VERDICT AND NOT JUST A WORKING GLOB. A working glob still returns a
 * plausible non-zero number when pointed at a state root with no archives (a fresh checkout, an
 * unmounted archive volume, a typo'd `--state-dir`) — the SAME silent shape as today's bug, one
 * layer down. `resolveLedgerUnion` treats "the live file matched but no archive file was even
 * read" as an ERROR, not a smaller answer, because that is exactly the case a plausible-but-wrong
 * count is made of.
 */

import { readdirSync as nodeReaddirSync, readFileSync as nodeReadFileSync, existsSync as nodeExistsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync as nodeGunzipSync } from "node:zlib";
import { NEVER_ROTATE_FILENAME } from "./log-rotation.js";

/**
 * The minimal fs surface {@link resolveLedgerUnion} needs — deliberately injectable (same
 * discipline as status.ts's `LedgerFsDeps`) so a test can drive both the "archives present" and
 * "archives absent" branches against a synthetic state root instead of this host's real one.
 */
export interface LedgerGrepFsDeps {
  readdirSync: (dir: string) => string[];
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => Buffer;
  gunzipSync: (buf: Buffer) => Buffer;
}

const realLedgerGrepFs: LedgerGrepFsDeps = {
  readdirSync: (dir) => nodeReaddirSync(dir),
  existsSync: (path) => nodeExistsSync(path),
  readFileSync: (path) => nodeReadFileSync(path),
  gunzipSync: (buf) => nodeGunzipSync(buf),
};

/** What {@link resolveLedgerUnion} resolved and found. */
export interface LedgerUnionResult {
  /** The directory that was globbed — echoed back so a caller can name it in an error. */
  stateDir: string;
  /** Every `<stateDir>/ledger.*.ndjson.gz` matched, sorted — the archive half of the union. */
  archiveFiles: string[];
  /** `archiveFiles.length`, named separately because it IS the positive control. */
  archiveCount: number;
  /** Whether `<stateDir>/ledger.ndjson` (the live file) existed and was read. */
  liveFileRead: boolean;
  /** False when `archiveCount === 0` — the zero-archive verdict this module exists to compute. */
  ok: boolean;
  /**
   * Deduplicated lines matching `pattern`, archives first (sorted order) then the live file.
   * Deliberately EMPTY when `!ok` — a live-only match count is exactly the wrong-but-plausible
   * number this module refuses to hand back; see the module doc.
   */
  matches: string[];
}

/**
 * Resolve the archive + live-ledger union for `pattern` under `stateDir`, PURE apart from the
 * injected fs (no spawn, no temp file — matches are held in memory and deduplicated by exact
 * line text, never written to disk, the same "stream and dedupe" discipline the manual
 * `grep | sort -u` idiom this replaces already carries). `pattern` is compiled as a `RegExp`, the
 * same "pattern" vocabulary `rmd ledger-grep <pattern>` exposes on the CLI.
 *
 * THE WHOLE POINT: when zero archive files are found, this returns `ok: false` and an EMPTY
 * `matches` array without opening the live file's contents for pattern-matching at all — the
 * caller (`ledgerGrepCommand`) exits non-zero naming `stateDir` rather than printing a
 * live-file-only result that could be mistaken for a real count.
 */
export function resolveLedgerUnion(
  stateDir: string,
  pattern: string | RegExp,
  fsDeps: LedgerGrepFsDeps = realLedgerGrepFs,
): LedgerUnionResult {
  let names: string[];
  try {
    names = fsDeps.readdirSync(stateDir);
  } catch {
    // An unreadable/absent state dir is "zero archives", never a throw — same discipline as
    // run-task.ts's `ledgerCorpusFiles`.
    names = [];
  }
  const archiveFiles = names
    .filter((n) => n.startsWith("ledger.") && n.endsWith(".ndjson.gz"))
    .map((n) => join(stateDir, n))
    .sort();

  const livePath = join(stateDir, NEVER_ROTATE_FILENAME);
  const liveFileRead = fsDeps.existsSync(livePath);

  if (archiveFiles.length === 0) {
    return { stateDir, archiveFiles, archiveCount: 0, liveFileRead, ok: false, matches: [] };
  }

  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const seen = new Set<string>();
  const matches: string[] = [];
  const addMatchingLines = (text: string): void => {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || seen.has(line) || !re.test(line)) continue;
      seen.add(line);
      matches.push(line);
    }
  };

  for (const file of archiveFiles) {
    try {
      addMatchingLines(fsDeps.gunzipSync(fsDeps.readFileSync(file)).toString("utf8"));
    } catch {
      // A corrupt/unreadable archive is skipped, never a crash — the archive count already read
      // (archiveFiles.length) is what the zero-archive verdict is keyed on, not read success.
    }
  }
  if (liveFileRead) {
    try {
      addMatchingLines(fsDeps.readFileSync(livePath).toString("utf8"));
    } catch {
      // Best-effort: the live file is the smaller, secondary half of the union; the archives are
      // the part this module exists to guarantee got read at all.
    }
  }

  return { stateDir, archiveFiles, archiveCount: archiveFiles.length, liveFileRead, ok: true, matches };
}
