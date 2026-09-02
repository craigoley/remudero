import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T2612: NOTHING STOPS THE NEXT FROZEN CAP FIGURE ────────────────────────────────────────
//
// The CLAUDE.md byte cap has moved six times (61046 -> 62644 -> 62733 -> 65536 -> 67536 -> 44000)
// and every move silently retired every plan shard that had restated the old number as a live
// fact. W1-T2611 corrected the two instances caught at filing time (W1-T2457, W1-T2282); this
// suite is the guard for the CLASS -- a check that reads capBytes from
// scripts/claude-md-budget-baseline.json AT RUNTIME (never a literal) and fails any text that
// makes a LIVE claim about CLAUDE.md's current cap disagreeing with it.
//
// THE HARD PART IS PRECISION: a check matching SURFACE TEXT where it means to match a PROPERTY
// (the W1-T81 / W1-T92 linter-precision family). Measured at HEAD, four real shards must NOT
// fire even though every one of them contains digits that a naive substring/number matcher would
// trip on:
//   - W1-T1233 quotes the ratchet's own bump HISTORY, "(61046 -> 62644 -> 62733 -> 65536)" --
//     narrative about the past, not a claim about today.
//   - W1-T1234 quotes a JSON test-fixture value, `{"capBytes": 65536, "measuredBytes": 1}` -- a
//     literal driven through the CLI in a table of inputs, not a claim about today.
//   - W1-T976 and W1-T970 each contain a PID/timestamp string ending "...344000" (a git-ref nonce)
//     that merely CONTAINS a digit run; neither mentions CLAUDE.md's cap at all.
//
// THE DISCRIMINATOR IS THE CLAIM'S SHAPE, NOT THE PRESENCE OF A NUMBER. checkCapCitations below
// extracts candidate "live cap" claims via a small set of textual shapes (LIVE_CAP_CLAIM_PATTERNS)
// and then asks whether the surrounding context matches one of a second set of shapes that mark a
// citation as NOT a live claim (NON_LIVE_CITATION_SHAPES: bump-history arrow chains, bump-history
// "moved ... from N to N" prose, and JSON-fixture object literals). Both sets are DATA -- arrays of
// {name, pattern} rows -- so a newly observed citation shape is a new row, never a new branch in
// the matcher itself (design rule 2; proven directly below by the "new shape via a data row"
// test). A candidate that matches no non-live shape is a live claim; if its number disagrees with
// the live capBytes, the guard fails, naming the file:line.
//
// THE RUNTIME READ IS ITSELF FALSIFIABLE: readCapBytesFromBaseline reads a baseline PATH, and
// checkCapCitations takes the resulting number as a plain argument rather than closing over a
// literal. The "runtime, not frozen" test below drives the SAME text against two different
// baseline files (the real one and a throwaway fixture with a different capBytes) and asserts the
// verdict MOVES -- a hard-coded 44000 baked into the matcher could not do that.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const LIVE_BASELINE_PATH = join(REPO_ROOT, "scripts", "claude-md-budget-baseline.json");

/** Read `capBytes` out of a claude-md-budget-baseline.json-SHAPED file at the moment this is
 *  called -- never a literal folded into the guard. Throws on a missing/non-numeric field so a
 *  malformed baseline fails loudly rather than silently disarming the guard (the W1-T1233 class). */
export function readCapBytesFromBaseline(baselinePath: string): number {
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, unknown>;
  if (typeof parsed.capBytes !== "number") {
    throw new Error(`${baselinePath} has no numeric capBytes`);
  }
  return parsed.capBytes;
}

export interface CitationShape {
  name: string;
  test: (context: string) => boolean;
}

/** Citation SHAPES that are never a live claim about today's cap -- held as DATA rows so a newly
 *  observed shape (a fifth citation idiom nobody has written yet) is added here, not by editing
 *  checkCapCitations' control flow. */
export const NON_LIVE_CITATION_SHAPES: CitationShape[] = [
  {
    // W1-T1233: "(61046 -> 62644 -> 62733 -> 65536)" -- two or more arrows chain numbers together
    // as a recorded HISTORY of bumps, not an assertion about the cap today.
    name: "bump-history-arrow-chain",
    test: (context) => {
      const arrows = context.match(/->|→/g);
      return (arrows?.length ?? 0) >= 2;
    },
  },
  {
    // W1-T2457 (post W1-T2611 correction): "moved capBytes downward from 67536 to 44000" -- a
    // prose transition naming an old and a new value, not a claim that either is the cap today.
    name: "bump-history-transition-phrase",
    test: (context) =>
      /\b(?:moved|raised|lowered|changed|bumped)\b[\s\S]{0,80}?\bfrom\s+\d[\d,]*\s+(?:down\s+|up\s+)?to\s+\d[\d,]*/i.test(
        context,
      ),
  },
  {
    // W1-T1234: `{"capBytes": 65536, "measuredBytes": 1}` -- a JSON object LITERAL fed to a CLI as
    // a test input, not prose asserting a fact about CLAUDE.md.
    name: "json-fixture",
    test: (context) => /\{\s*"[A-Za-z]\w*"\s*:\s*"?-?\d/.test(context),
  },
];

export interface CapClaimPattern {
  name: string;
  regex: RegExp;
}

/** Shapes of a LIVE claim about CLAUDE.md's cap TODAY -- also DATA. Each pattern's sole capture
 *  group is the asserted number. Deliberately narrow (requires "cap"/"capBytes" plus a connector
 *  or the word "byte") so a bare digit run near the word "cap" in unrelated prose -- e.g. a CLI
 *  log line like `(cap 1000 bytes)` printed with no connector -- is never even a candidate. */
export const LIVE_CAP_CLAIM_PATTERNS: CapClaimPattern[] = [
  { name: "byte-cap-adjective", regex: /(\d{4,6})-byte\s+cap\b/gi },
  { name: "cap-connector-bytes", regex: /\bcap\s*(?:is|of|:|=|was)\s*(\d{4,6})\s*bytes?\b/gi },
  {
    name: "against-cap-parenthetical",
    regex: /\bagainst\s+(?:its\s+|a\s+)?(?:\d{4,6}-byte\s+)?cap\s*\((?:\d{4,6}\s+of\s+)?(\d{4,6})\)/gi,
  },
  { name: "capbytes-field-connector", regex: /\bcapBytes\s*(?:is|:|=|was)\s*(\d{4,6})\b/gi },
];

const CONTEXT_RADIUS = 120;

export interface CapCitationViolation {
  shape: string;
  value: number;
  line: number;
  snippet: string;
}

export interface CapCitationCheckOptions {
  shapes?: CitationShape[];
  patterns?: CapClaimPattern[];
}

/** THE GUARD. Scans `text` for live claims about CLAUDE.md's cap (per LIVE_CAP_CLAIM_PATTERNS,
 *  or `opts.patterns` if supplied) and fails on any whose asserted number disagrees with
 *  `liveCapBytes` -- UNLESS its surrounding context matches a non-live citation shape (per
 *  NON_LIVE_CITATION_SHAPES, or `opts.shapes`), in which case it is a historical/fixture/etc.
 *  citation and is never flagged regardless of whether its number agrees. */
export function checkCapCitations(
  text: string,
  liveCapBytes: number,
  opts: CapCitationCheckOptions = {},
): { ok: boolean; violations: CapCitationViolation[] } {
  const shapes = opts.shapes ?? NON_LIVE_CITATION_SHAPES;
  const patterns = opts.patterns ?? LIVE_CAP_CLAIM_PATTERNS;
  const violations: CapCitationViolation[] = [];

  for (const { name, regex } of patterns) {
    // Patterns are module-level and carry the `g` flag; construct a fresh RegExp per call so
    // concurrent/repeated invocations never share (and corrupt) `lastIndex` state.
    const re = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const value = Number(match[1]);
      const index = match.index;
      const context = text.slice(Math.max(0, index - CONTEXT_RADIUS), index + match[0].length + CONTEXT_RADIUS);
      const isNonLive = shapes.some((shape) => shape.test(context));
      if (isNonLive) continue;
      if (value === liveCapBytes) continue;
      const line = text.slice(0, index).split("\n").length;
      violations.push({ shape: name, value, line, snippet: context.trim().replace(/\s+/g, " ") });
    }
  }

  return { ok: violations.length === 0, violations };
}

function mkTmpBaseline(capBytes: number): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-md-cap-citations-"));
  const p = join(dir, "baseline.json");
  writeFileSync(p, JSON.stringify({ capBytes }));
  return p;
}

// ── acceptance 1: a live claim disagreeing with the runtime cap FAILS ───────────────────────────

test("claude-md-cap-citations: a plan shard asserting a disagreeing CLAUDE.md cap FAILS the guard", () => {
  const liveCapBytes = readCapBytesFromBaseline(LIVE_BASELINE_PATH);
  const staleValue = liveCapBytes + 1;
  const text =
    `Q3(a): CLAUDE.md is injected in full on every session and measures against a ` +
    `${staleValue}-byte cap today.`;
  const result = checkCapCitations(text, liveCapBytes);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]?.value, staleValue);
  assert.equal(result.violations[0]?.shape, "byte-cap-adjective");
});

test("claude-md-cap-citations: the SAME shape agreeing with the runtime cap PASSES", () => {
  const liveCapBytes = readCapBytesFromBaseline(LIVE_BASELINE_PATH);
  const text =
    `Q3(a): CLAUDE.md is injected in full on every session and measures against a ` +
    `${liveCapBytes}-byte cap today.`;
  const result = checkCapCitations(text, liveCapBytes);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

// ── acceptance 2: the precision falsifier -- four real shards must never fire ───────────────────

const PRECISION_CORPUS = [
  // W1-T1233: the ratchet's own bump HISTORY, "(61046 -> 62644 -> 62733 -> 65536)".
  "plan/tasks.d/W1-T1233-a-malformed-capbytes-disarms-the-size-gate.yaml",
  // W1-T1234: a JSON test-fixture value, `{"capBytes": 65536, "measuredBytes": 1}`.
  "plan/tasks.d/W1-T1234-derive-the-claude-md-measurement-stop-storing-it.yaml",
  // W1-T976 / W1-T970: PID/timestamp strings ending "...344000" -- a coincidental digit run
  // inside an unrelated git-ref-nonce identifier, nowhere near a mention of CLAUDE.md's cap.
  "plan/tasks.d/W1-T976-block-reasoning-reads-run-not-pr.yaml",
  "plan/tasks.d/W1-T970-durable-risk-judge-refusal.yaml",
];

for (const relPath of PRECISION_CORPUS) {
  test(`claude-md-cap-citations: ${relPath} does NOT fire the guard`, () => {
    const liveCapBytes = readCapBytesFromBaseline(LIVE_BASELINE_PATH);
    const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
    const result = checkCapCitations(text, liveCapBytes);
    assert.equal(result.ok, true, `${relPath} unexpectedly fired: ${JSON.stringify(result.violations, null, 2)}`);
  });
}

test("claude-md-cap-citations: a coincidental digit run inside an unrelated identifier never fires, even beside the word cap", () => {
  const liveCapBytes = readCapBytesFromBaseline(LIVE_BASELINE_PATH);
  // Modelled on W1-T976/W1-T970's nonce shape, deliberately placed next to "cap" so the only
  // thing stopping a match is that \d{4,6} cannot bound inside a longer contiguous digit run.
  const text = "The reservation used nonce Craigs-Mac-mini-85424-1787020520545944000, under the retry cap.";
  const result = checkCapCitations(text, liveCapBytes);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test("claude-md-cap-citations: a bump-history arrow chain suppresses an otherwise-live-shaped number inside it", () => {
  const liveCapBytes = readCapBytesFromBaseline(LIVE_BASELINE_PATH);
  const staleValue = liveCapBytes + 1;
  const text = `the ratchet moved (61046 -> 62644 -> ${staleValue}-byte cap) across three bumps.`;
  const result = checkCapCitations(text, liveCapBytes);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test("claude-md-cap-citations: a bump-history 'moved ... from N to N' phrase suppresses an otherwise-live-shaped number", () => {
  const liveCapBytes = readCapBytesFromBaseline(LIVE_BASELINE_PATH);
  const text = `the operator moved the cap from 67536 to ${liveCapBytes}-byte cap in one PR.`;
  const result = checkCapCitations(text, liveCapBytes);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test("claude-md-cap-citations: a JSON fixture object literal never fires, agreeing or not", () => {
  const liveCapBytes = readCapBytesFromBaseline(LIVE_BASELINE_PATH);
  const text = 'Given `{"capBytes": 65536, "measuredBytes": 1}` against the committed file the CLI prints OK.';
  const result = checkCapCitations(text, liveCapBytes);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

// ── acceptance 3: the cap is read at runtime, never frozen -- the verdict MOVES with the baseline ──

test("claude-md-cap-citations: driven with a fixture baseline whose capBytes differs from the live one, the verdict MOVES", () => {
  const liveCapBytes = readCapBytesFromBaseline(LIVE_BASELINE_PATH);
  const fixtureBaselinePath = mkTmpBaseline(liveCapBytes + 5000);
  try {
    const fixtureCapBytes = readCapBytesFromBaseline(fixtureBaselinePath);
    assert.notEqual(fixtureCapBytes, liveCapBytes, "fixture baseline must diverge from the live one");

    // The SAME text, asserting the LIVE cap by construction (never a typed-in literal) --
    // agrees with the real baseline and disagrees with the fixture one.
    const text = `CLAUDE.md measures against a ${liveCapBytes}-byte cap.`;

    const verdictAgainstLive = checkCapCitations(text, liveCapBytes);
    const verdictAgainstFixture = checkCapCitations(text, fixtureCapBytes);

    assert.equal(verdictAgainstLive.ok, true, JSON.stringify(verdictAgainstLive.violations));
    assert.equal(verdictAgainstFixture.ok, false, "verdict did not move when driven by a different baseline");
    assert.equal(verdictAgainstFixture.violations[0]?.value, liveCapBytes);

    // A guard whose comparison were a frozen literal (e.g. a hard-coded 44000) could not produce
    // two different verdicts from the identical text -- only reading capBytes fresh from each
    // baseline path can.
  } finally {
    rmSync(dirname(fixtureBaselinePath), { recursive: true, force: true });
  }
});

// ── acceptance 4: discriminating shapes are DATA rows, not code branches ────────────────────────

test("claude-md-cap-citations: NON_LIVE_CITATION_SHAPES and LIVE_CAP_CLAIM_PATTERNS are data tables", () => {
  assert.ok(Array.isArray(NON_LIVE_CITATION_SHAPES) && NON_LIVE_CITATION_SHAPES.length >= 3);
  assert.ok(Array.isArray(LIVE_CAP_CLAIM_PATTERNS) && LIVE_CAP_CLAIM_PATTERNS.length >= 3);
  for (const shape of NON_LIVE_CITATION_SHAPES) {
    assert.equal(typeof shape.name, "string");
    assert.equal(typeof shape.test, "function");
  }
});

test("claude-md-cap-citations: a newly-observed citation shape is added as a DATA row, with no edit to checkCapCitations", () => {
  const liveCapBytes = readCapBytesFromBaseline(LIVE_BASELINE_PATH);
  // A citation idiom none of the current rows recognize -- an explicit "SUPERSEDED" marker.
  const text = "SUPERSEDED CITATION: CLAUDE.md measures against a 12345-byte cap as of the old baseline.";

  const defaultResult = checkCapCitations(text, liveCapBytes);
  assert.equal(defaultResult.ok, false, "expected the unrecognized shape to fail-toward-flagging by default");

  const supersededRow: CitationShape = { name: "superseded-marker", test: (ctx) => /\bSUPERSEDED\b/.test(ctx) };
  const withNewRow = checkCapCitations(text, liveCapBytes, {
    shapes: [...NON_LIVE_CITATION_SHAPES, supersededRow],
  });
  assert.equal(withNewRow.ok, true, JSON.stringify(withNewRow.violations));
  // checkCapCitations itself was never touched between the two calls -- only the DATA passed in.
});
