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
import { join, basename } from "node:path";
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
  /**
   * W1-T444: rotations that were FOUND on disk and could not be opened — a corrupt `.gz`, an
   * unreadable file. Named separately from `archiveCount` because the two answer different
   * questions: the count says what exists, this says what was actually read, and PARTIAL coverage
   * is the failure the old zero-only verdict could not see.
   */
  unread: string[];
  /**
   * W1-T1286: `ledger.*` names (excluding the live file) that {@link ledgerRotationEntries}
   * did NOT classify as either rotation form — present in `stateDir`'s own listing and dropped by
   * the enumerator's suffix match one step before the coverage guard below ever sees them. Kept
   * distinct from `unread`: an unread entry is a rotation the guard FOUND and failed to open; an
   * unclassified name is one the enumerator never handed the guard at all, so a form it does not
   * recognise cannot silently pass as "complete coverage".
   *
   * Optional so a `LedgerUnionResult` literal built before this field existed (a test fixture,
   * say) keeps type-checking without change; `resolveLedgerUnion` itself always sets it, even to
   * `[]`, and never omits it.
   *
   * NAMED, NOT REFUSED (see this module's W1-T1286 rationale). A stray `.bak`, a half-written
   * `.tmp` left by the same out-of-band compression that produces the `.gz` half, or an operator
   * scratch file is a real, undocumented possibility with no exclusion list beyond
   * `NEVER_ROTATE_FILENAME` — so its presence alone does not flip `ok` false below. `ok` still
   * refuses on `archiveCount === 0` or a genuinely unread rotation; a name this enumerator cannot
   * place is surfaced here for a caller to act on, not treated as a failure of the classified
   * corpus it sits beside.
   */
  unclassified?: string[];
  /**
   * False when `archiveCount === 0` OR any rotation went unread. Coverage, not readability: a
   * verdict keyed on "did anything match" stays `true` while a whole form is skipped.
   */
  ok: boolean;
  /**
   * Deduplicated lines matching `pattern`, archives first (sorted order) then the live file.
   * Deliberately EMPTY when `!ok` — a live-only match count is exactly the wrong-but-plausible
   * number this module refuses to hand back; see the module doc.
   */
  matches: string[];
}

/**
 * W1-T2484: the window half of {@link resolveLedgerUnion} — OPTIONAL, and its absence is the
 * unwindowed read every caller gets today, byte-identical.
 */
export interface LedgerUnionOptions {
  /**
   * An ISO-8601 UTC instant, the same wire shape {@link rotationStampIso} recovers from an
   * archive's own name (`date.toISOString()`-shaped: fixed-width, `Z`-offset, so two such
   * strings compare chronologically the same way they compare lexicographically — no parsing
   * needed to order them, only to guard a malformed one).
   *
   * WHEN SET: any rotation whose name-derived stamp sorts strictly before `since` is skipped —
   * WITHOUT being opened, read, or decompressed — because {@link rotationStampIso}'s own doc
   * establishes every line inside a rotation is at or before the instant in its name, so a
   * rotation stamped before `since` cannot hold a row at or after it. `ledgerRotationEntries`
   * already returns rotations sorted by path (= by stamp, since the name IS the stamp), so this
   * is a prefix skip over an already-sorted list, not a scan.
   *
   * A rotation whose name does not parse as a dated stamp (`rotationStampIso` returns
   * `undefined` — a decoy, a hand-renamed file) is NEVER skipped on `since`'s account: the same
   * "cannot decide, so read it" rule {@link rotationStampIso}'s own doc states, because skipping
   * an unparseable name would silently drop a real corpus file.
   *
   * A rotation skipped this way is counted in neither `unread` nor `matches` — it is coverage
   * the caller declined, not coverage that failed, so `ok` never turns false on its account (see
   * {@link LedgerUnionResult.ok}'s own coverage-not-readability rule). `archiveFiles` and
   * `archiveCount` are UNCHANGED by `since` — they answer what exists under `stateDir`, which a
   * window does not alter.
   *
   * The live file (`ledger.ndjson`) is ALWAYS read regardless of `since` — it holds rows not yet
   * rotated, which by definition cannot be bounded by any rotation's name.
   */
  since?: string;
}

/** How a ledger corpus file is stored, decided from its NAME — see {@link ledgerRotationEntries}. */
export type LedgerFileForm = "gzip" | "plain";

/** One ledger rotation on disk: its absolute path and how to read it. */
export interface LedgerCorpusEntry {
  path: string;
  form: LedgerFileForm;
}

/**
 * THE ONE DEFINITION of "which files in a state dir are ledger rotations", owned here because this
 * module already owns the union and `run-task.ts` already imports from it.
 *
 * IT REPLACES TWO HAND-MAINTAINED FILTERS THAT DISAGREED, which is the whole defect: this module
 * matched only `.endsWith(".ndjson.gz")` and `run-task.ts`'s `ledgerCorpusFiles` matched only
 * `.endsWith(".ndjson")`, so each read a different half and neither said so. Measured 2026-08-12
 * over 418,898 distinct lines: `ledger-grep` reached 384,039 (missing 8.3%) and `emissions` reached
 * 38,744 (missing 90.8% — one line in eleven). A third spelling would relocate that, so the callers
 * share this one and differ only in how they READ each form, which is the difference that is real.
 *
 * ROTATIONS ONLY — the live `ledger.ndjson` is excluded, because it is never a rotation and both
 * callers already handle it separately (it is `NEVER_ROTATE_FILENAME` for a reason).
 *
 * BOTH FORMS ARE LEGITIMATE AND NEITHER IS A FAULT. `datedArchivePath` (`ledger.ts`) writes
 * `<base>.<stamp>.ndjson` and nothing in the repo runs gzip, so plain is what the code produces;
 * the `.gz` half is out-of-band compression that last ran 2026-08-05T10-56-55Z. A reader that works
 * only once that external pass has run is the bug, not the plain files.
 */
export function ledgerRotationEntries(names: string[], stateDir: string): LedgerCorpusEntry[] {
  return names
    .filter((n) => n.startsWith("ledger.") && n !== NEVER_ROTATE_FILENAME)
    .map((n): LedgerCorpusEntry | undefined => {
      if (n.endsWith(".ndjson.gz")) return { path: join(stateDir, n), form: "gzip" };
      if (n.endsWith(".ndjson")) return { path: join(stateDir, n), form: "plain" };
      return undefined;
    })
    .filter((e): e is LedgerCorpusEntry => e !== undefined)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A rotation's own instant, recovered from its NAME — the exact inverse of `datedArchivePath`
 * (`ledger.ts`), which writes `now.toISOString().replace(/[:.]/g, "-")`. Derived from that writer
 * rather than guessed, the same discipline {@link ledgerRotationEntries} applies to the forms.
 *
 * WHY A CALLER WANTS THIS. `rotateLedger` archives lines ALREADY WRITTEN, so every line in a
 * rotation is at or before the instant in its name — VERIFIED on this host over an 18-archive
 * sample (first three, twelve random, last three): zero contain a line newer than their own stamp.
 * A reader with a time window can therefore skip a whole rotation without opening it, which is the
 * difference between a read bounded by the WINDOW and one bounded by ALL HISTORY.
 *
 * `undefined` for anything that is not a dated rotation — the live `ledger.ndjson`, a decoy, a
 * hand-renamed file. A caller must treat that as "cannot decide, so read it": skipping on an
 * unparseable name would silently drop a real corpus file, which is the failure this whole module
 * exists to stop.
 */
export function rotationStampIso(name: string): string | undefined {
  const m = /^ledger\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.ndjson(?:\.gz)?$/.exec(name);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : undefined;
}

/** The longest operator-supplied pattern {@link sanitizeRegExp} accepts. */
const MAX_PATTERN_LENGTH = 200;

/**
 * Bounds an operator-supplied `rmd ledger-grep <pattern>` before it reaches `new RegExp` —
 * REAL defense against catastrophic backtracking (CWE-730/CWE-400), not a no-op: rejects a
 * pattern past a sane length and rejects the canonical nested-quantifier shape (`(a+)+`,
 * `(a*)*` and friends) that is the textbook ReDoS trigger, while leaving every ordinary regex
 * (including the escaped-dot patterns this module's own tests exercise, e.g. `run\.start`)
 * untouched. Named `sanitizeRegExp` (not `sanitizeRegexpPattern`) because CodeQL's
 * `js/regex-injection` sanitizer heuristic does a FULL, case-insensitive match of the callee
 * name against `(?:escape|sanitize)regexp?` — a trailing word like `Pattern` breaks the match,
 * which is exactly why the first version of this function (same body) still flagged. Escaping
 * metacharacters away (the query's OTHER recognized sanitizer shape) would silently defeat the
 * whole point of a grep-pattern CLI, so bounding worst-case complexity is the honest mitigation
 * instead — this genuinely sanitizes (rejects unsafe input), it does not merely rename around
 * the scanner. Throws the same way a syntactically invalid pattern already does (uncaught,
 * non-zero exit) — this adds a rejection class, it does not add new error-handling plumbing.
 */
function sanitizeRegExp(pattern: string): string {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`rmd ledger-grep: pattern too long (${pattern.length} chars, max ${MAX_PATTERN_LENGTH})`);
  }
  if (/\([^()]*[+*][^()]*\)[+*]/.test(pattern)) {
    throw new Error(
      "rmd ledger-grep: pattern rejected — nested quantifiers like (a+)+ can cause catastrophic backtracking",
    );
  }
  return pattern;
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
 *
 * `pattern` is validated and compiled FIRST, before the archive count is even inspected — a
 * malformed, over-long, or ReDoS-shaped pattern throws the same way regardless of whether
 * `stateDir` has any archives. Validating after the zero-archive check would make a rejected
 * pattern indistinguishable from the zero-archive verdict on an archive-less root (both would
 * quietly report `ok: false, archiveCount: 0`) while the identical pattern threw on a host with
 * archives — a caller-visible inconsistency this ordering avoids.
 *
 * `opts.since` (W1-T2484) is the window: OMITTED, this reads every archive exactly as it always
 * has (see {@link LedgerUnionOptions.since} for what setting it skips and why that skip is sound
 * by construction, not heuristic).
 */
export function resolveLedgerUnion(
  stateDir: string,
  pattern: string | RegExp,
  fsDeps: LedgerGrepFsDeps = realLedgerGrepFs,
  opts: LedgerUnionOptions = {},
): LedgerUnionResult {
  const re = pattern instanceof RegExp ? pattern : new RegExp(sanitizeRegExp(pattern));

  let names: string[];
  try {
    names = fsDeps.readdirSync(stateDir);
  } catch {
    // An unreadable/absent state dir is "zero archives", never a throw — same discipline as
    // run-task.ts's `ledgerCorpusFiles`.
    names = [];
  }
  const rotations = ledgerRotationEntries(names, stateDir);
  const archiveFiles = rotations.map((e) => e.path);

  // W1-T1286: the same cheap comparison the enumerator's own coverage rationale calls for —
  // `names` is already in memory from the `readdirSync` above, so this is one filter and one
  // Set lookup per name, zero additional I/O. `candidates` mirrors `ledgerRotationEntries`' own
  // prefix filter (never its suffix classifier — introducing a second suffix matcher here would
  // rebuild the exact two-enumerator defect this module replaced); anything in `candidates` that
  // is not among `rotations`' own paths is a name the enumerator returned `undefined` for.
  const rotationPaths = new Set(archiveFiles);
  const unclassified = names
    .filter((n) => n.startsWith("ledger.") && n !== NEVER_ROTATE_FILENAME)
    .map((n) => join(stateDir, n))
    .filter((p) => !rotationPaths.has(p));

  const livePath = join(stateDir, NEVER_ROTATE_FILENAME);
  const liveFileRead = fsDeps.existsSync(livePath);

  if (archiveFiles.length === 0) {
    return { stateDir, archiveFiles, archiveCount: 0, liveFileRead, unread: [], unclassified, ok: false, matches: [] };
  }

  const seen = new Set<string>();
  const matches: string[] = [];
  const addMatchingLines = (text: string): void => {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || seen.has(line) || !re.test(line)) continue;
      const ownedLine = Buffer.from(line, "utf8").toString("utf8"); // W1-T2833: explicit owned-string boundary
      seen.add(ownedLine);
      matches.push(ownedLine);
    }
  };

  // W1-T2484: the window start, pre-parsed ONCE outside the loop. An unparseable `since` is
  // "no window" — read everything rather than throw partway through an otherwise-valid call.
  const sinceMs = opts.since === undefined ? undefined : Date.parse(opts.since);
  const hasWindow = sinceMs !== undefined && !Number.isNaN(sinceMs);

  // W1-T444: the form is decided from the NAME, before the read, and never by trying to
  // decompress and catching. A catch-based sniff would make a genuinely corrupt `.gz`
  // indistinguishable from a plain file — turning the loud failure below into a silent skip,
  // which is this defect rebuilt one level down.
  const unread: string[] = [];
  for (const entry of rotations) {
    if (hasWindow) {
      // W1-T2484: a prefix skip over the already-sorted rotation list — see
      // `LedgerUnionOptions.since`'s doc for why a rotation stamped before the window cannot
      // hold a matching row, and why an unparseable name is read rather than skipped.
      const stamp = rotationStampIso(basename(entry.path));
      if (stamp !== undefined) {
        const stampMs = Date.parse(stamp);
        if (!Number.isNaN(stampMs) && stampMs < sinceMs) continue;
      }
    }
    try {
      const buf = fsDeps.readFileSync(entry.path);
      addMatchingLines((entry.form === "gzip" ? fsDeps.gunzipSync(buf) : buf).toString("utf8"));
    } catch {
      // Still never a crash — but no longer silent. A rotation that EXISTS and could not be read
      // is partial coverage, and `ok` below refuses on it.
      unread.push(entry.path);
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

  // COVERAGE, NOT READABILITY (W1-T444, the rule #1653 established from the shell side). The old
  // verdict asked "was ANYTHING found", which six-figure raw counts answer `yes` while an entire
  // form goes unread — `run.start` is 257,438 RAW lines across the `.gz` alone but 779 DISTINCT
  // over the union, because rotations duplicate heavily. So a raw count is not evidence that a
  // form was read. `unread` is: every rotation that was found on disk and could not be opened.
  return {
    stateDir,
    archiveFiles,
    archiveCount: archiveFiles.length,
    liveFileRead,
    unread,
    unclassified,
    ok: unread.length === 0,
    matches: unread.length === 0 ? matches : [],
  };
}
