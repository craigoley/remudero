import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { boardMessageFooter, renderStatusBoardText, type StatusBoardModel } from "../src/lib/status-board.js";

// ── W1-T2826 ────────────────────────────────────────────────────────────────────────────────────
// checkBoardSectionSafe's doc promises "a checker failure must never reach the operator as a broken
// board". It takes an ALREADY PROJECTED OperatorMessage, so its try covered checkOperatorMessage
// and nothing else; the projection ran one frame out, in the argument expression feeding
// boardMessageFooter, inside a renderStatusBoardText with no try of its own.
//
// This suite is the falsifier for closing that. It lives in its own file rather than appended to
// test/status-board-operator-message.test.ts, which is W1-T2806's falsifier and carries
// coverage-load-bearing assertions — one suite answering for two tasks is what the house rule
// refuses.

const NOW_ISO = "2026-08-30T12:00:00.000Z";

function quietModel(overrides: Partial<StatusBoardModel> = {}): StatusBoardModel {
  return {
    generatedAt: NOW_ISO,
    liveness: {
      services: [{ service: "daemon", running: true, pid: 4242 }],
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

/** A section object whose `nextAction` throws when read. `cacheHit`, `learningsInjection` and
 *  `needsMe` are the three sections whose BLOCK RENDERERS never read `nextAction`, so the throw
 *  lands during PROJECTION with the render already complete — which is the only way to exercise
 *  the gap this task closes rather than a rendering fault. */
function sectionThatThrowsOnProjection<T extends object>(base: T): T {
  const section = { ...base };
  Object.defineProperty(section, "nextAction", {
    get() {
      throw new Error("projection read blew up");
    },
    enumerable: true,
  });
  return section;
}

// ── the board still renders in full ─────────────────────────────────────────────────────────────

test("a section whose PROJECTION throws leaves the board rendered in full — every block still present", () => {
  const poisoned = quietModel({ cacheHit: sectionThatThrowsOnProjection({ found: false }) });

  let rendered = "";
  assert.doesNotThrow(() => {
    rendered = renderStatusBoardText(poisoned, { colourEnabled: false });
  }, "a throw during projection reached the operator as a broken board");

  // Every one of the ten section rules is present, the poisoned section's own included.
  for (const header of [
    "── LIVENESS",
    "── LATCHES",
    "── LAST CLOSED CYCLE",
    "── BLOCKERS BY CLASS",
    "── QUEUE HEAD",
    "── INBOX",
    "── HEADROOM",
    "── CACHE HIT",
    "── LEARNINGS INJECTION",
    "── NEEDS ME",
  ]) {
    assert.ok(rendered.includes(header), `the board dropped ${header}`);
  }
  assert.ok(rendered.includes("no cache-token data in this window"), "the poisoned section lost its body");
});

test("the guard covers projection and check together — no throw on that path escapes the renderer", () => {
  // All three renderer-blind sections poisoned at once: if any single one escaped, this throws.
  const poisoned = quietModel({
    cacheHit: sectionThatThrowsOnProjection({ found: false }),
    learningsInjection: sectionThatThrowsOnProjection({ found: false }),
    needsMe: sectionThatThrowsOnProjection({ costAnomaly: [], mergeHeld: [], uncreditedBuilds: [] }),
  });
  assert.doesNotThrow(() => renderStatusBoardText(poisoned, { colourEnabled: false }));

  // POSITIVE CONTROL: the poison really does throw when read, so the three passes above are the
  // guard working and not a getter that never fired.
  const probe = sectionThatThrowsOnProjection({ found: false }) as { nextAction?: unknown };
  assert.throws(() => probe.nextAction, /projection read blew up/);
});

// ── omitted, not reported as incomplete ─────────────────────────────────────────────────────────

test("a section the guard could not project is OMITTED from the footer, never counted as incomplete", () => {
  const poisoned = quietModel({ cacheHit: sectionThatThrowsOnProjection({ found: false }) });
  const footer = renderStatusBoardText(poisoned, { colourEnabled: false }).split("\n").at(-1) ?? "";

  // Nine examined, not ten — the denominator counts what was actually read.
  assert.match(footer, /^_operator-message: 9 of 9 section\(s\) incomplete/);
  assert.ok(!footer.includes("cache hit"), "an unprojectable section was reported as incomplete");
  // CONTROL: the same board with nothing poisoned reads ten.
  assert.match(
    renderStatusBoardText(quietModel(), { colourEnabled: false }).split("\n").at(-1) ?? "",
    /^_operator-message: 10 of 10 section\(s\) incomplete/,
  );
});

test("boardMessageFooter's own contract is unchanged — an already-projected throwing message is still skipped", () => {
  const footer = boardMessageFooter([
    {
      label: "liveness",
      message: {
        speaker: "liveness",
        get whatHappened(): string {
          throw new Error("checker read blew up");
        },
      },
    },
    { label: "inbox", message: { speaker: "inbox", whatHappened: "ready: 0" } },
  ]);
  assert.ok(footer !== undefined);
  assert.match(footer, /1 of 2 section\(s\) incomplete/);
  assert.match(footer, /\(inbox\)/);
});

// ── nothing else moves ──────────────────────────────────────────────────────────────────────────

test("the rendered board is byte-identical for a model where every section projects normally", () => {
  const before = renderStatusBoardText(quietModel(), { colourEnabled: false });
  const after = renderStatusBoardText(quietModel(), { colourEnabled: false });
  assert.equal(before, after);
  // The guard is invisible on the healthy path: the footer still names all ten sections.
  assert.match(before.split("\n").at(-1) ?? "", /10 of 10 section\(s\) incomplete/);
  assert.ok(before.startsWith("### rmd status — 2026-08-30T12:00:00.000Z"));
});

test("the guard introduces no readability, length or vocabulary score", () => {
  const source = readFileSync(new URL("../src/lib/status-board.ts", import.meta.url), "utf8");
  for (const token of [
    "fleschKincaid",
    "flesch",
    "gunningFog",
    "readingLevel",
    "readabilityScore",
    "gradeLevel",
    "syllable",
    "wordCount",
    "sentenceLength",
  ]) {
    assert.ok(!source.includes(token), `status-board.ts introduced a prose score (${token})`);
  }
  // Positive control for the nine zeros: the scan can read the file and sees the guard it added.
  assert.ok(source.includes("projectBoardSectionSafe"), "forbidden-token scan could not read status-board.ts");
});

test("the projection is called from INSIDE the guard, not from the footer's argument expression", () => {
  const source = readFileSync(new URL("../src/lib/status-board.ts", import.meta.url), "utf8");
  // Asserted at the source because it is invisible in the output: an edit moving the projection
  // back into the argument would pass every behavioural test above on a healthy board.
  const guard = source.slice(source.indexOf("function projectBoardSectionSafe("));
  const guardBody = guard.slice(0, guard.indexOf("\n}"));
  const tryAt = guardBody.indexOf("try {");
  const projectAt = guardBody.indexOf("projectBoardSection(");
  assert.ok(tryAt > 0 && projectAt > tryAt, "projectBoardSection is not inside the guard's try");
  // ...and the renderer no longer projects inline.
  const render = source.slice(source.indexOf("export function renderStatusBoardText("));
  const renderBody = render.slice(0, render.indexOf("\n}"));
  assert.ok(renderBody.includes("projectBoardSectionSafe("), "the renderer does not use the guarded projection");
  assert.ok(
    !renderBody.includes("projectBoardSection(block.label"),
    "the renderer still projects in the footer's argument expression",
  );
});
