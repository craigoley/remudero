import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { OPERATOR_MESSAGE_PARTS, type OperatorMessage } from "../src/lib/operator-message.js";
import {
  boardMessageFooter,
  projectBoardSection,
  renderStatusBoardText,
  type BoardSectionMessage,
  type StatusBoardModel,
} from "../src/lib/status-board.js";

// ── W1-T2806 ────────────────────────────────────────────────────────────────────────────────────
// docs/operator-message-standard.md is NORMATIVE and names `renderStatusBoardText` as its FIRST
// surface. Before this task `escalate.ts` was the only module in the repo that ever called
// `checkOperatorMessage`, and `status-board.ts` cited the standard zero times — so the surface an
// operator reads first was the one surface the presence check never saw.
//
// This suite is the falsifier for that wiring. It asserts PRESENCE structure only: the standard
// forbids adding any readability, length or vocabulary score in its name, and the last test here
// is the guard that none was.

const NOW_ISO = "2026-08-30T12:00:00.000Z";

/** A quiet, all-healthy board — every section in its emptiest state, so no `nextAction` rule
 *  fires anywhere and the projection reports the widest gap it ever will. */
function quietModel(overrides: Partial<StatusBoardModel> = {}): StatusBoardModel {
  return {
    generatedAt: NOW_ISO,
    liveness: {
      services: [
        { service: "daemon", running: true, pid: 4242 },
        { service: "serve", running: true, pid: 4243 },
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

// The COMPLETE board `origin/main`'s renderer produced for `quietModel()` — captured from that
// blob and pasted verbatim, NOT re-derived from the wired renderer. That direction is the whole
// point: a regression that rewrote a board line could never silently rewrite this expectation to
// agree with it.
const BOARD_BEFORE_WIRING = [
  "### rmd status — 2026-08-30T12:00:00.000Z",
  "",
  "── LIVENESS ─────────────────────────────────────────────",
  "daemon          : running (pid 4242) — boot unknown (unknown)",
  "serve           : running (pid 4243)",
  "head vs origin/main : fresh",
  "crash-loop           : clear",
  "",
  "── LATCHES ──────────────────────────────────────────────",
  "no active latches",
  "",
  "── LAST CLOSED CYCLE ────────────────────────────────────",
  "no cycle recorded",
  "",
  "── BLOCKERS BY CLASS ────────────────────────────────────",
  "no blockers",
  "",
  "── QUEUE HEAD ───────────────────────────────────────────",
  "nothing dispatchable",
  "",
  "── INBOX ────────────────────────────────────────────────",
  "ready: 0, not ready: 0",
  "",
  "── HEADROOM ─────────────────────────────────────────────",
  "enforcement : OFF",
  "no headroom telemetry yet",
  "",
  "── CACHE HIT ────────────────────────────────────────────",
  "no cache-token data in this window",
  "",
  "── LEARNINGS INJECTION ──────────────────────────────────",
  "no injection rows in this window",
  "",
  "── NEEDS ME ─────────────────────────────────────────────",
  "nothing needs you",
].join("\n");

/** A section list whose every message fills all four slots — the only shape that yields no
 *  footer at all. */
function conformingSections(): BoardSectionMessage[] {
  return [
    {
      label: "liveness",
      message: {
        speaker: "liveness",
        whatHappened: "daemon: not running",
        whatIsAsked: "start the daemon",
        consequenceOfInaction: "no task is dispatched until it is running",
      },
    },
  ];
}

// ── criterion 1: each rendered block is projected onto the four presence slots ──────────────────

test("projectBoardSection maps a rendered block onto exactly the four slots the standard defines — and onto no others", () => {
  const projected = projectBoardSection(
    "liveness",
    ["── LIVENESS ─────", "daemon          : not running", "crash-loop           : BREACHED"],
    "restart the daemon",
  );

  assert.equal(projected.label, "liveness");
  assert.equal(projected.message.speaker, "liveness");
  // The block's own BODY is the observed condition — the section rule line is dropped, every
  // remaining line kept in render order.
  assert.equal(projected.message.whatHappened, "daemon          : not running\ncrash-loop           : BREACHED");
  assert.equal(projected.message.whatIsAsked, "restart the daemon");

  // The projection introduces no key of its own: what it fills is exactly the checker's vocabulary.
  assert.deepEqual(Object.keys(projected.message).sort(), [...OPERATOR_MESSAGE_PARTS].sort());
});

test("projectBoardSection leaves whatHappened absent for a block that rendered no body, rather than inventing an empty string", () => {
  const projected = projectBoardSection("cache hit", ["── CACHE HIT ─────", "   ", ""], undefined);
  assert.equal(projected.message.whatHappened, undefined);
  // ...and an absent next action stays UNDEFINED, never null: `pickNextAction` returns undefined
  // both for a healthy section and for a gap in its rule table, and the standard's part (iv) is
  // precisely about not reporting those two as the same fact. An explicit null would claim
  // "observed absent" on evidence the board does not have.
  assert.equal(projected.message.whatIsAsked, undefined);
  assert.ok(!("consequenceOfInaction" in projected.message) || projected.message.consequenceOfInaction === undefined);
});

test("every section of a real board reaches the checker — the footer's denominator is the board's own section count, not a subset", () => {
  const rendered = renderStatusBoardText(quietModel(), { colourEnabled: false });
  const footer = rendered.split("\n").at(-1) ?? "";
  assert.match(footer, /^_operator-message: 10 of 10 section\(s\) incomplete — /);
});

// ── criterion 2: an incomplete projection marks the row and still renders it ────────────────────

test("a board whose every section is structurally incomplete still renders every section in full — the footer is ADDED, nothing is withheld", () => {
  const rendered = renderStatusBoardText(quietModel(), { colourEnabled: false });

  // Fail-toward-delivery, asserted positively: each block the pre-wiring renderer emitted is still
  // present, in order, byte for byte.
  assert.ok(rendered.startsWith(BOARD_BEFORE_WIRING));
  for (const line of BOARD_BEFORE_WIRING.split("\n")) {
    assert.ok(rendered.includes(line), `board dropped a line it used to render: ${JSON.stringify(line)}`);
  }
  // And the footer is strictly appended: one line, at the end, after a blank separator.
  const lines = rendered.split("\n");
  assert.equal(lines.filter((line) => line.startsWith("_operator-message:")).length, 1);
  assert.ok((lines.at(-1) ?? "").startsWith("_operator-message:"));
  assert.equal(lines.at(-2), "");
});

test("the footer names the incomplete sections and the missing parts, so the reader is told WHICH row is thin rather than that some row is", () => {
  const footer = boardMessageFooter([
    ...conformingSections(),
    { label: "inbox", message: { speaker: "inbox", whatHappened: "ready: 0" } },
  ]);
  assert.ok(footer !== undefined);
  assert.match(footer, /1 of 2 section\(s\) incomplete/);
  assert.match(footer, /missing consequenceOfInaction, whatIsAsked/);
  assert.match(footer, /\(inbox\)/);
  // The conforming section is NOT named — the footer reports gaps, it does not list the board.
  assert.ok(!footer.includes("liveness"));
  // And it says outright that nothing was held back.
  assert.match(footer, /Rendered in full regardless/);
});

test("boardMessageFooter returns undefined when every section conforms — a clean board gains no line at all", () => {
  assert.equal(boardMessageFooter(conformingSections()), undefined);
  assert.equal(boardMessageFooter([]), undefined);
});

// ── criterion 3: a checker failure cannot reach the operator ────────────────────────────────────

test("a section whose message throws when the checker reads it is skipped, not propagated — the board never fails on its own conformance check", () => {
  const exploding: OperatorMessage = {
    speaker: "liveness",
    whatHappened: "daemon: not running",
    get whatIsAsked(): string {
      throw new Error("checker read blew up");
    },
  };

  let footer: string | undefined;
  assert.doesNotThrow(() => {
    footer = boardMessageFooter([{ label: "liveness", message: exploding }]);
  });
  // Swallowed, and not guessed at either: an unreadable section contributes no verdict rather than
  // a fabricated "incomplete" one.
  assert.equal(footer, undefined);
});

test("a throwing section cannot take the rest of the board's footer down with it", () => {
  const exploding: OperatorMessage = {
    speaker: "liveness",
    get whatHappened(): string {
      throw new Error("checker read blew up");
    },
  };
  const footer = boardMessageFooter([
    { label: "liveness", message: exploding },
    { label: "inbox", message: { speaker: "inbox", whatHappened: "ready: 0" } },
  ]);
  assert.ok(footer !== undefined);
  assert.match(footer, /1 of 2 section\(s\) incomplete/);
  assert.match(footer, /\(inbox\)/);
});

// ── criterion 4: no existing board message text changes ─────────────────────────────────────────

test("the wired board is byte-identical to origin/main's board plus the footer — no board message is reworded, reordered or re-spaced by this task", () => {
  const rendered = renderStatusBoardText(quietModel(), { colourEnabled: false });
  const footer = boardMessageFooter(
    // Same ten labels the renderer projects, in render order.
    [
      "liveness",
      "latches",
      "last cycle",
      "blockers",
      "queue head",
      "inbox",
      "headroom",
      "cache hit",
      "learnings injection",
      "needs me",
    ].map((label) => ({ label, message: { speaker: label, whatHappened: "x" } })),
  );
  assert.ok(footer !== undefined);
  assert.equal(rendered, `${BOARD_BEFORE_WIRING}\n\n${footer}`);
});

test("a section that DOES carry a next action drops out of the footer — the projection reads the board's real slot, it does not report a constant", () => {
  const withAction = renderStatusBoardText(
    quietModel({ inbox: { readyCount: 0, notReadyCount: 3, nextAction: "unblock the three not-ready rows" } }),
    { colourEnabled: false },
  );
  const footer = withAction.split("\n").at(-1) ?? "";
  // Still incomplete (no board section carries a consequence slot yet) but the MISSING SET shrank,
  // which is the discriminating half: whatIsAsked is no longer universally absent.
  assert.match(footer, /10 of 10 section\(s\) incomplete/);
  assert.match(footer, /missing consequenceOfInaction, whatIsAsked/);
  // ...and the board still renders that section's own text.
  assert.ok(withAction.includes("unblock the three not-ready rows"));
});

// ── criterion 5: no readability, length or vocabulary score is introduced ───────────────────────

test("the wiring adds no readability, length or vocabulary metric — the standard forbids one being added in its name and this is the guard", () => {
  const source = readFileSync(new URL("../src/lib/status-board.ts", import.meta.url), "utf8");
  const forbidden = [
    "fleschKincaid",
    "flesch",
    "gunningFog",
    "readingLevel",
    "readabilityScore",
    "gradeLevel",
    "syllable",
    "wordCount",
    "sentenceLength",
    "MAX_WORDS",
    "MAX_SENTENCE",
  ];
  for (const token of forbidden) {
    assert.ok(
      !source.includes(token),
      `status-board.ts introduced a prose score (${token}); docs/operator-message-standard.md forbids one being added in its name`,
    );
  }
  // Positive control for the scan above: it CAN see this file's own text, so the eleven zeros are
  // absence and not a broken read.
  assert.ok(source.includes("boardMessageFooter"), "forbidden-token scan could not read status-board.ts");
});

test("the checker the board wires in is the presence check itself — the board holds no second, hand-rolled copy of the parts list", () => {
  const source = readFileSync(new URL("../src/lib/status-board.ts", import.meta.url), "utf8");
  assert.ok(source.includes('from "./operator-message.js"'));
  assert.ok(source.includes("checkOperatorMessage"));
  // A local re-declaration of the vocabulary would let the two drift silently.
  assert.ok(!source.includes("OPERATOR_MESSAGE_PARTS ="));
});
