import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderQueueHeadBlock, renderStatusBoardText, type StatusBoardModel } from "../src/lib/status-board.js";
import { colourEnabled, DEFAULT_TERMINAL_WIDTH, paint, sectionRule, SEMANTIC_CODES, terminalWidth } from "../src/lib/tty.js";

// ── W1-T2475: the operator console rendered a crash loop, a starved queue and a healthy idle in
// the same undifferentiated grey — zero ANSI escapes anywhere in src, NO_COLOR/FORCE_COLOR read
// nowhere, process.stdout.columns read nowhere, and renderStatusBoardText hand-typed ten
// 57-character section rules (a DRY defect, never an inconsistency — all ten measured the SAME
// width). This suite proves lib/tty.ts's four exports (sectionRule/paint/colourEnabled/
// terminalWidth) and that status-board.ts's text renderer is wired through them WITHOUT moving
// a single byte of the disabled-colour output (Rule 18: every seam is a plain value in, plain
// value out — no test here mutates global `process.env`/`process.stdout`).

const NOW_ISO = "2026-08-30T12:00:00.000Z";

// The ten literals `renderStatusBoardText`'s block renderers hand-typed BEFORE this task —
// copied here verbatim (not re-derived from `sectionRule`) so a regression in the helper's
// output can never silently rewrite this file's own expectation to match it.
const ORIGINAL_SECTION_HEADERS: ReadonlyArray<[string, string]> = [
  ["LIVENESS", "── LIVENESS ─────────────────────────────────────────────"],
  ["LATCHES", "── LATCHES ──────────────────────────────────────────────"],
  ["LAST CLOSED CYCLE", "── LAST CLOSED CYCLE ────────────────────────────────────"],
  ["BLOCKERS BY CLASS", "── BLOCKERS BY CLASS ────────────────────────────────────"],
  ["QUEUE HEAD", "── QUEUE HEAD ───────────────────────────────────────────"],
  ["INBOX", "── INBOX ────────────────────────────────────────────────"],
  ["HEADROOM", "── HEADROOM ─────────────────────────────────────────────"],
  ["CACHE HIT", "── CACHE HIT ────────────────────────────────────────────"],
  ["LEARNINGS INJECTION", "── LEARNINGS INJECTION ──────────────────────────────────"],
  ["NEEDS ME", "── NEEDS ME ─────────────────────────────────────────────"],
];

/** A quiet, all-healthy board — every section in its emptiest/calmest state, INCLUDING a
 *  healthy interval-service idle (the third of the task's own three named examples). */
function baseModel(overrides: Partial<StatusBoardModel> = {}): StatusBoardModel {
  return {
    generatedAt: NOW_ISO,
    liveness: {
      services: [
        { service: "daemon", running: true, pid: 4242 },
        { service: "serve", running: true, pid: 4243 },
        {
          service: "deploy-supervisor",
          running: false,
          pid: null,
          tickAt: NOW_ISO,
          tickAgeMs: 30_000,
          tickStep: "deploy.skip",
          lastExitCode: 0,
        },
      ],
      headVsOriginMain: { status: "fresh" },
      crashLoop: { breached: false, windowBoots: [], windowMs: 900_000, maxBoots: 5 },
    },
    latches: { rows: [] },
    lastCycle: { found: false },
    blockers: { rows: [] },
    queueHead: { rows: [], refused: [], refusedTruncated: 0 },
    inbox: { readyCount: 0, notReadyCount: 0 },
    headroom: { found: false, enforced: false },
    cacheHit: { found: false },
    learningsInjection: { found: false },
    needsMe: { costAnomaly: [], mergeHeld: [], uncreditedBuilds: [] },
    ...overrides,
  };
}

/** The task's other two named examples — a crash-looping daemon and a starved queue — layered
 *  onto the same base model, so ONE render exercises every `paint` call site this task adds. */
function crashLoopAndStarvedQueueModel(): StatusBoardModel {
  const base = baseModel();
  return {
    ...base,
    liveness: {
      services: [
        { service: "daemon", running: true, pid: 9001 },
        { service: "serve", running: false, pid: null },
        {
          service: "deploy-supervisor",
          running: false,
          pid: null,
          lastExitCode: 1,
          tickAt: NOW_ISO,
          tickAgeMs: 999_000_000,
        },
      ],
      headVsOriginMain: {
        status: "stale",
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        originSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      crashLoop: { breached: true, windowBoots: ["t1", "t2", "t3", "t4", "t5"], windowMs: 900_000, maxBoots: 5 },
    },
    queueHead: {
      rows: [],
      refused: [
        {
          taskId: "W1-T1",
          title: "some starved task",
          reason: "circuit-broken",
          dispatchCount: 5,
          maxDispatches: 5,
          resetNote: "resets on a new owned PR",
        },
      ],
      refusedTruncated: 1,
      stall: {
        candidateCount: 3,
        sinceMs: 7_200_000,
        lastDispatchTs: NOW_ISO,
        boundMs: 3_600_000,
        boundDerivation: "p95 of this host's own observed dispatch gaps",
      },
    },
  };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── ACCEPTANCE: with colour disabled the rendered board is byte-identical to what it renders
// today ──────────────────────────────────────────────────────────────────────────────────────

test("renderStatusBoardText: with colour disabled the board carries no ANSI escape at all, and every section header is byte-identical to its pre-task literal", () => {
  const model = crashLoopAndStarvedQueueModel();
  const text = renderStatusBoardText(model, { colourEnabled: false });

  assert.doesNotMatch(text, /\x1b\[/, "colour disabled must never emit an escape sequence");
  for (const [, header] of ORIGINAL_SECTION_HEADERS) {
    assert.ok(text.includes(header), `expected the pre-task header ${JSON.stringify(header)} to appear verbatim`);
  }
});

test("renderStatusBoardText: the default (no opts) call — what every existing test in this suite already exercises — renders identically to an explicit colourEnabled:false in this non-TTY test process", () => {
  const model = baseModel();
  assert.equal(renderStatusBoardText(model), renderStatusBoardText(model, { colourEnabled: false }));
});

// ── ACCEPTANCE: NO_COLOR disables colour even when the stream reports itself a terminal ───────

test("colourEnabled: an explicit NO_COLOR wins even when the stream claims to be a TTY, regardless of its own value", () => {
  assert.equal(colourEnabled({ NO_COLOR: "1" }, { isTTY: true }), false);
  assert.equal(colourEnabled({ NO_COLOR: "" }, { isTTY: true }), false, "NO_COLOR is a PRESENCE check (no-color.org), not a value check");
  assert.equal(colourEnabled({ NO_COLOR: "0" }, { isTTY: true }), false, '"0" is still present — still disables');
});

// ── ACCEPTANCE: FORCE_COLOR enables colour even when the stream is not a terminal ─────────────

test("colourEnabled: an explicit FORCE_COLOR wins even when the stream is not a TTY at all", () => {
  assert.equal(colourEnabled({ FORCE_COLOR: "1" }, { isTTY: false }), true);
  assert.equal(colourEnabled({ FORCE_COLOR: "1" }, {}), true, "an isTTY-less stream (e.g. a piped stdout) counts as not-a-terminal");
});

test("colourEnabled: absent both variables, colour just follows whether the stream is a real TTY", () => {
  assert.equal(colourEnabled({}, { isTTY: true }), true);
  assert.equal(colourEnabled({}, { isTTY: false }), false);
  assert.equal(colourEnabled({}, {}), false);
});

// ── ACCEPTANCE: every escape sequence in the coloured output comes from a semantic wrapper ────

test("renderStatusBoardText: with colour forced on, every SGR code that appears is either a semantic wrapper's own code or the shared reset — never an arbitrary escape", () => {
  const model = crashLoopAndStarvedQueueModel();
  const text = renderStatusBoardText(model, { colourEnabled: true });

  const allowedCodes = new Set(["0", ...Object.values(SEMANTIC_CODES)]);
  const codesFound = [...text.matchAll(/\x1b\[([0-9;]+)m/g)].map((m) => m[1]);

  assert.ok(codesFound.length > 0, "the crash-loop/starved-queue/healthy-idle fixture must actually produce coloured output");
  for (const code of codesFound) {
    assert.ok(allowedCodes.has(code), `escape code ${JSON.stringify(code)} is not one of paint's six semantic codes or the reset`);
  }
});

test("paint: each of the six semantic wrappers emits exactly its own table entry's code, and nothing when disabled", () => {
  for (const name of Object.keys(SEMANTIC_CODES) as Array<keyof typeof SEMANTIC_CODES>) {
    const on = paint[name]("x", true);
    const off = paint[name]("x", false);
    assert.equal(on, `\x1b[${SEMANTIC_CODES[name]}mx\x1b[0m`);
    assert.equal(off, "x");
  }
});

// ── ACCEPTANCE: the ten section rules derive from one helper rather than ten literals ──────────

test("sectionRule: reproduces every one of the ten pre-task literals exactly, at width 57", () => {
  for (const [name, expected] of ORIGINAL_SECTION_HEADERS) {
    assert.equal(sectionRule(name, 57), expected);
  }
});

test("renderStatusBoardText: every section header actually IN the rendered board is exactly sectionRule(name, 57) — proves the renderer calls the helper, not a second copy of the literals", () => {
  const text = renderStatusBoardText(baseModel(), { colourEnabled: false });
  for (const [name, literal] of ORIGINAL_SECTION_HEADERS) {
    assert.equal(sectionRule(name, 57), literal);
    assert.ok(text.includes(sectionRule(name, 57)));
  }
});

// ── ACCEPTANCE: a narrow declared width never yields a rendered line wider than that width ────

test("sectionRule: never returns a line longer than its declared width, even when the name alone would already overrun it", () => {
  for (const width of [0, 1, 2, 3, 4, 5, 10, 20]) {
    const rule = sectionRule("LEARNINGS INJECTION", width);
    assert.ok([...rule].length <= width, `sectionRule("LEARNINGS INJECTION", ${width}) produced ${JSON.stringify(rule)}, longer than ${width}`);
  }
  // and the normal (non-clamped) case still pads out to exactly the declared width
  assert.equal([...sectionRule("X", 30)].length, 30);
});

// ── ACCEPTANCE: an unreadable terminal width falls back to a stated default and never throws ──

test("terminalWidth: an absent, non-numeric, non-finite or non-positive `columns` falls back to the stated default and never throws", () => {
  assert.equal(terminalWidth({}), DEFAULT_TERMINAL_WIDTH);
  assert.equal(terminalWidth({ columns: undefined }), DEFAULT_TERMINAL_WIDTH);
  assert.equal(terminalWidth({ columns: Number.NaN }), DEFAULT_TERMINAL_WIDTH);
  assert.equal(terminalWidth({ columns: -5 }), DEFAULT_TERMINAL_WIDTH);
  assert.equal(terminalWidth({ columns: 0 }), DEFAULT_TERMINAL_WIDTH);
  assert.equal(terminalWidth({ columns: "120" as unknown as number }), DEFAULT_TERMINAL_WIDTH, "a non-number columns is unreadable too");
  assert.equal(terminalWidth({}, 40), 40, "a caller-supplied fallback overrides the module default");
  assert.doesNotThrow(() => terminalWidth(null as unknown as { columns?: number }));
  assert.doesNotThrow(() => terminalWidth(undefined));
});

test("terminalWidth: a genuinely usable columns count is read straight through", () => {
  assert.equal(terminalWidth({ columns: 120 }), 120);
  assert.equal(terminalWidth({ columns: 100.9 }), 100, "floored, never rounded up past the real width");
});

// ── ACCEPTANCE: the json projection of the same model is unchanged by any rendering change ────

test("JSON.stringify(model): rendering the text board — with colour on or off — never mutates the model the JSON projection would also stringify", () => {
  const model = crashLoopAndStarvedQueueModel();
  const before = JSON.stringify(model);

  renderStatusBoardText(model, { colourEnabled: false });
  renderStatusBoardText(model, { colourEnabled: true });

  const after = JSON.stringify(model);
  assert.equal(after, before, "the model must be byte-identical after either render — the text renderer only ever READS it");
  assert.doesNotMatch(after, /\x1b/, "the JSON projection must never carry an ANSI escape regardless of the text renderer's colour state");
});

// ── ACCEPTANCE: no state word the board prints today is replaced by colour alone ───────────────

test("renderStatusBoardText: stripping every ANSI escape out of the coloured render reproduces the disabled render byte-for-byte — colour only ever WRAPS a word, never substitutes for it", () => {
  const model = crashLoopAndStarvedQueueModel();
  const coloured = renderStatusBoardText(model, { colourEnabled: true });
  const plain = renderStatusBoardText(model, { colourEnabled: false });

  assert.equal(stripAnsi(coloured), plain);
  // and the actual state words are still there to strip TO — not vanished along with the colour
  for (const word of ["BREACHED", "STALE", "not running", "STALL:", "REFUSED:"]) {
    assert.ok(plain.includes(word), `expected ${JSON.stringify(word)} in the plain render`);
    assert.ok(stripAnsi(coloured).includes(word), `expected ${JSON.stringify(word)} after stripping colour from the coloured render`);
  }
});

test("renderQueueHeadBlock: exported for test use, colour opt-in via its second argument — every pre-existing single-argument caller keeps reading a REFUSED: line that still literally startsWith('REFUSED:')", () => {
  const q = crashLoopAndStarvedQueueModel().queueHead;
  const plainLines = renderQueueHeadBlock(q); // one-argument call, exactly as every pre-existing caller makes it
  const refusedLine = plainLines.find((l) => l.startsWith("REFUSED:"));
  assert.ok(refusedLine, "a refused row must still render a line literally starting with REFUSED:");

  const colouredLines = renderQueueHeadBlock(q, true);
  const colouredRefused = colouredLines.find((l) => l.includes("REFUSED:"));
  assert.ok(colouredRefused, "the same row, painted, still carries the REFUSED: word");
  assert.match(colouredRefused!, /\x1b\[/, "and this time it is actually coloured");
});

// ── ACCEPTANCE: the status board actually calls the new layer rather than shipping it unreached ──

test("src/lib/status-board.ts calls sectionRule( — the exact grep this task's own acceptance runs", () => {
  const source = readFileSync(new URL("../src/lib/status-board.ts", import.meta.url), "utf8");
  assert.match(source, /sectionRule\(/);
});
