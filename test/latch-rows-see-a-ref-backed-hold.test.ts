/**
 * THE LATCH BLOCK CAN NOW SEE A HOLD THAT IS NOT A FILE (W1-T2264).
 *
 * THE DEFECT. `STATIC_LATCHES` (status-board.ts) declares five entries and every one of them
 * carries a `path:` — the row exists only when `fs.existsSync(path)` is true. The fleet-wide
 * shared PAUSE (fleet-control.ts's `sharedPauseRef`, `refs/rmd-pause/hold`) is a git ref, not a
 * file, so a host that did not itself write `state/PAUSE` renders "no active latches" while the
 * whole fleet is held — the surface an operator runs first to ask why nothing is moving says
 * nothing is wrong.
 *
 * THE FIX. One more row source in `buildLatchRows`, read via exactly one `git ls-remote`
 * (fleet-control.ts's `readSharedPause`, injected here as `StatusBoardDeps.readSharedPauseState`
 * so no test needs a real git remote) — never the anchor lookup `checkSharedPause` also performs,
 * and never `checkSharedPause` itself: that function folds a LOCAL PAUSE read into the same
 * return value, which would render the same operator hold twice on a host that paused itself
 * (once as the existing PAUSE row, once as this one). This module reads the local file and the
 * ref as two independent facts and skips the network read entirely once the local row already
 * answered the question.
 *
 * WHAT MUST NOT CHANGE (Q3 of the task record). `rmd status` stays read-only and cheap: no read
 * performed here may write, and an unreachable remote must read as a row that SAYS it could not
 * tell, never as "clear" and never as a thrown error.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusBoard, type LatchesSection, type StatusBoardDeps } from "../src/lib/status-board.js";
import { sharedPauseRef } from "../src/lib/fleet-control.js";

const NOW_ISO = "2026-08-25T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "shared-pause-latch-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function boardWith(root: string, overrides: Partial<StatusBoardDeps>): LatchesSection {
  const deps: StatusBoardDeps = {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    ...overrides,
  } as StatusBoardDeps;
  return buildStatusBoard(root, join(tmpdir(), "no-such-ledger.ndjson"), deps).latches;
}

const sharedRow = (l: LatchesSection) => l.rows.find((r) => r.name === "SHARED_PAUSE");

// ── claim: a held shared read produces a latch row whose consequence names the ref and the
// remedy verb ───────────────────────────────────────────────────────────────────────────────────

test("a held shared read produces a row naming the ref and the remedy verb", () => {
  const l = boardWith(freshRoot(), { readSharedPauseState: () => "held" });
  const row = sharedRow(l);
  assert.ok(row, "a SHARED_PAUSE row was produced from a held shared read");
  assert.ok(row!.consequence.includes(sharedPauseRef()), "the consequence names the ref itself");
  assert.match(row!.consequence, /rmd resume/, "the consequence names the remedy verb");
});

// ── claim: an absent shared read produces no row, so a clear fleet still reports no active
// latches ───────────────────────────────────────────────────────────────────────────────────────

test("an absent shared read produces no row — a clear fleet still reports no active latches", () => {
  const l = boardWith(freshRoot(), { readSharedPauseState: () => "absent" });
  assert.equal(sharedRow(l), undefined);
  assert.equal(l.rows.length, 0, "nothing else was latched either — the section is genuinely empty");
});

// ── claim: an unreachable shared read produces a row that says so rather than throwing or
// reading as clear ─────────────────────────────────────────────────────────────────────────────

test("an unreachable shared read produces a row that says so, never throws, never reads as clear", () => {
  const root = freshRoot();
  assert.doesNotThrow(() => boardWith(root, { readSharedPauseState: () => "unreachable" }));
  const l = boardWith(root, { readSharedPauseState: () => "unreachable" });
  const row = sharedRow(l);
  assert.ok(row, "unreachable still produces a row — never silently read as clear");
  assert.match(row!.consequence, /cannot reach origin/);
  assert.ok(row!.consequence.includes(sharedPauseRef()));
  // Distinguishable from the CONFIRMED-held wording — an unreachable read must not assert a hold
  // it never actually confirmed.
  assert.doesNotMatch(row!.consequence, /^no new task spawns fleet-wide/);
});

// ── claim: the row renders with an unknown age rather than requiring a second round trip to the
// remote ────────────────────────────────────────────────────────────────────────────────────────

test("the row renders with an unknown age — no second round trip to the remote", () => {
  const held = sharedRow(boardWith(freshRoot(), { readSharedPauseState: () => "held" }));
  assert.equal(held?.ageMs, undefined);
  const unreachable = sharedRow(boardWith(freshRoot(), { readSharedPauseState: () => "unreachable" }));
  assert.equal(unreachable?.ageMs, undefined);
});

// ── claim: building the rows performs no write and removes no marker, including the peek-only
// request marker ───────────────────────────────────────────────────────────────────────────────

test("building the rows performs no write and removes no marker, including the peek-only drain-now marker", () => {
  const root = freshRoot();
  const drainNowPath = join(root, "state", "DRAIN_REQUESTED");
  const stopPath = join(root, "state", "STOP");
  const drainNowBody = JSON.stringify({ at: NOW_ISO, origin: "test-console" });
  const stopBody = JSON.stringify({ at: NOW_ISO, reason: "operator" });
  writeFileSync(drainNowPath, drainNowBody);
  writeFileSync(stopPath, stopBody);

  let reads = 0;
  const l = boardWith(root, {
    readSharedPauseState: () => {
      reads += 1;
      return "held";
    },
  });

  assert.equal(reads, 1, "the shared ref is READ, once — never written, never polled a second time");
  assert.ok(existsSync(drainNowPath), "the peek-only drain-now marker is untouched");
  assert.equal(readFileSync(drainNowPath, "utf8"), drainNowBody, "drain-now marker content is byte-identical");
  assert.ok(existsSync(stopPath), "STOP is untouched");
  assert.equal(readFileSync(stopPath, "utf8"), stopBody, "STOP marker content is byte-identical");
  assert.ok(sharedRow(l), "the render still produced the ref-backed row despite the other markers present");
});

// ── claim: a local file-backed hold on the same host still renders exactly one row rather than
// two ───────────────────────────────────────────────────────────────────────────────────────────

test("a local PAUSE on the same host renders exactly one row, not two, for the same operator hold", () => {
  const root = freshRoot();
  writeFileSync(join(root, "state", "PAUSE"), JSON.stringify({ at: NOW_ISO, reason: "operator" }));
  let called = false;
  const l = boardWith(root, {
    readSharedPauseState: () => {
      called = true;
      return "held"; // `rmd pause` on this host pushes this same ref best-effort — genuinely held
    },
  });
  const pauseLike = l.rows.filter((r) => r.name === "PAUSE" || r.name === "SHARED_PAUSE");
  assert.equal(pauseLike.length, 1, "one row for one operator action, not two");
  assert.equal(pauseLike[0]!.name, "PAUSE", "the existing local row wins — it already tells this host's story");
  assert.equal(called, false, "the ref is not even read once the local file already answered");
});

// ── claim: every file-backed latch keeps the row it renders today, unchanged in name and
// consequence ───────────────────────────────────────────────────────────────────────────────────

test("every file-backed latch keeps the row it renders today, unchanged in name and consequence", () => {
  const root = freshRoot();
  writeFileSync(join(root, "state", "STOP"), JSON.stringify({ at: NOW_ISO, reason: "operator halt" }));
  writeFileSync(join(root, "state", "QUIET_HOURS"), JSON.stringify({ at: NOW_ISO }));
  const l = boardWith(root, { readSharedPauseState: () => "absent" });

  const stop = l.rows.find((r) => r.name === "STOP");
  assert.ok(stop, "STOP still renders exactly as before");
  assert.match(stop!.consequence, /halts within one tick/);

  const quiet = l.rows.find((r) => r.name === "QUIET_HOURS");
  assert.ok(quiet, "QUIET_HOURS still renders exactly as before");
  assert.match(quiet!.consequence, /quiet-hours preference is set/);

  assert.equal(l.rows.length, 2, "no ref-backed row leaked in beside the two file-backed ones");
});

// ── claim: the next-action line fires for a hold the block can now see, and names no releasing
// action ────────────────────────────────────────────────────────────────────────────────────────

test("the next-action line fires for a hold the block can now see, and names no releasing action", () => {
  const heldNext = boardWith(freshRoot(), { readSharedPauseState: () => "held" }).nextAction;
  assert.ok(heldNext, "a next action fired for the held ref-backed row");
  assert.doesNotMatch(heldNext!, /rmd resume/, "no releasing action is named for a hold this host may not own");

  const unreachableNext = boardWith(freshRoot(), { readSharedPauseState: () => "unreachable" }).nextAction;
  assert.ok(unreachableNext, "a next action fired for the unreachable ref-backed row too");
  assert.doesNotMatch(unreachableNext!, /rmd resume/);

  const absentNext = boardWith(freshRoot(), { readSharedPauseState: () => "absent" }).nextAction;
  assert.equal(absentNext, undefined, "nothing latched, so nothing to advise");
});
