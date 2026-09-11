/**
 * W1-T3381 — a cadence liveness row reaches no operator surface, until this task wires it.
 *
 * W1-T3236 (#4811) built `cadenceMarkerRows`, the nine-row `CADENCE_MARKERS` table, and the
 * three-state fresh/stale/never discipline — and plumbed it into nothing. `StatusBoardModel`
 * declared no cadence field, `buildStatusBoard` never called `cadenceMarkerRows`, and
 * `renderStatusBoardText` never rendered a row. All three of that task's own acceptance proofs
 * are `unit test:` titles against `cadenceMarkerRows` ITSELF — true of the pure function, and
 * silent on whether a single byte of its judgment ever reached an operator's screen.
 *
 * THIS SUITE IS THE FALSIFIER FOR THAT GAP, and every assertion below runs against
 * `buildStatusBoard`'s returned `StatusBoardModel` and `renderStatusBoardText`'s rendered TEXT —
 * never against `cadenceMarkerRows` directly. Deleting the plumb (the `cadence` field, the
 * `buildStatusBoard` wiring, or `renderCadenceBlock`) must redden this file even though
 * `cadenceMarkerRows` itself, and its own W1-T3236 suite, stay green throughout.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildStatusBoard,
  CADENCE_DEFAULT_INTERVAL_MINUTES,
  CADENCE_MARKERS,
  renderStatusBoardText,
  type StatusBoardDeps,
} from "../src/lib/status-board.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cadence-board-`));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

const NOW_ISO = "2026-09-11T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const HOUR = 3_600_000;
const LEDGER_PATH = join(tmpdir(), "a-cadence-liveness-row-reaches-no-operator-surface-does-not-exist.ndjson");

/** A never-running, never-fetchable, offline-safe default deps bundle — no `resolveCadenceIntervalMinutes` is
 *  injected anywhere in this file, so every marker is judged against {@link CADENCE_DEFAULT_INTERVAL_MINUTES}: the
 *  plumb this task adds must work with that seam left at its safe, config-free default. */
function baseDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    ...overrides,
  };
}

// ── ACCEPTANCE 1: a stale cadence marker appears on the RENDERED status board ────────────────────

test("W1-T3381: a stale cadence marker appears on the RENDERED status board, not merely in cadenceMarkerRows' return value", () => {
  const root = tmpRoot();
  // "retro" carries no `minIntervalMinutes` of its own in plan/policy.yaml (its gate is
  // mergesThreshold/daysThreshold, not a plain interval) so, with no resolveCadenceIntervalMinutes
  // injected, it is judged against CADENCE_DEFAULT_INTERVAL_MINUTES — a day, three intervals is 72h.
  const staleAt = new Date(NOW_MS - 100 * HOUR).toISOString();
  writeFileSync(join(root, "state", "last-retro.json"), JSON.stringify({ at: staleAt }));

  const model = buildStatusBoard(root, LEDGER_PATH, baseDeps());
  const row = model.cadence.rows.find((r) => r.name === "retro");
  assert.ok(row, "the retro cadence row must reach StatusBoardModel.cadence.rows");
  assert.equal(row!.state, "stale");
  assert.equal(row!.intervalMinutes, CADENCE_DEFAULT_INTERVAL_MINUTES);

  // The falsifier: assert against the RENDERED TEXT, so deleting renderCadenceBlock (or its call
  // site in renderStatusBoardText) reddens THIS assertion even though model.cadence.rows above,
  // and cadenceMarkerRows' own W1-T3236 suite, would both stay green.
  const text = renderStatusBoardText(model, { colourEnabled: false });
  assert.match(text, /── CADENCE/, "the board must render a CADENCE section at all");
  assert.match(text, /retro, stale/, "the stale retro row must be a line an operator actually reads");
  assert.match(text, /firing and failing, or not firing/, "the row's consequence text must reach the board, not just the model");
});

// ── ACCEPTANCE 2: an absent marker reaches the board as never-fired, not as silence ──────────────

test("W1-T3381: a marker that has never been written reaches the board as never-fired, so an absent marker is not rendered as silence", () => {
  const root = tmpRoot(); // nothing under state/ — every one of the nine markers is absent
  const model = buildStatusBoard(root, LEDGER_PATH, baseDeps());

  // Every marker is a row — none is skipped for being absent (the STATIC_LATCHES `if
  // (!existsSync) continue` trap this task's own rationale names and refuses to repeat).
  assert.equal(model.cadence.rows.length, CADENCE_MARKERS.length);
  assert.ok(model.cadence.rows.every((r) => r.state === "never"));

  const text = renderStatusBoardText(model, { colourEnabled: false });
  for (const marker of CADENCE_MARKERS) {
    assert.match(
      text,
      new RegExp(`${marker.name}, never \\(never fired\\)`),
      `${marker.name} must render as never-fired, not silently dropped from the board`,
    );
  }
  // The negative control this criterion is about: the empty-table message only renders when
  // there are zero rows to show — an absent marker must still BE a row, not collapse the table.
  assert.doesNotMatch(text, /no cadence markers tracked/, "an absent marker must render a row, not the empty-table message");
});

// ── ACCEPTANCE 3: StatusBoardModel carries a cadence section ─────────────────────────────────────

test("W1-T3381: StatusBoardModel carries a cadence section, so the judge has a seat on the model rather than a call site the board never makes", () => {
  const model = buildStatusBoard(tmpRoot(), LEDGER_PATH, baseDeps());

  assert.ok("cadence" in model, "StatusBoardModel must declare a cadence field");
  assert.ok(Array.isArray(model.cadence.rows), "cadence.rows must be an array of CadenceMarkerRow");
  assert.equal(model.cadence.rows.length, CADENCE_MARKERS.length);

  // Populated FROM the existing table, not a second, drifted copy of it — every declared marker
  // is represented by name.
  const names = new Set(model.cadence.rows.map((r) => r.name));
  for (const marker of CADENCE_MARKERS) {
    assert.ok(names.has(marker.name), `${marker.name} is missing from model.cadence.rows`);
  }
});
