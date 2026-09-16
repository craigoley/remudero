import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSharedPause, sharedPauseRef, type SharedPauseGitDeps } from "../src/lib/fleet-control.js";
import { makeTempDir } from "../src/lib/tmp.js";

// ── W1-T3622 — AN UNREACHABLE ANCHOR HOLDS ANONYMOUSLY AND RE-PAYS ITS READ EVERY TICK ─────────
//
// MEASURED ON THE LIVE CONSOLE DAEMON, 2026-09-15 (this task's own rationale): a hold whose
// anchor commit never reached origin (`writeSharedPause` is documented BEST-EFFORT) logged the
// SAME "setter unrecoverable" detail 33 times over nearly eight hours, one failed anchor read per
// tick, for an answer that cannot change until the ref's sha itself changes. W1-T2262 already
// proved the hold survives an unreadable anchor (test/pause-hold-is-attributable.test.ts); this
// file proves the two things that task left open: the read is paid ONCE per sha, not once per
// tick (acceptance 1), and the detail it renders names itself as UNATTRIBUTABLE rather than
// reusing the ordinary "set by pid ..." phrasing an attributed hold gets (acceptance 2) — plus a
// re-check that neither change lets an unverifiable pause stop holding (acceptance 3).

/** A remote whose ref exists (`ls-remote` succeeds) but whose anchor object can never be read
 *  (`cat-file` always fails) — mirrors test/pause-hold-is-attributable.test.ts's own
 *  `heldButUnreadableAnchorRemote`, extended with a call counter per git subcommand so a test can
 *  prove HOW MANY TIMES a given argv shape ran, not just that the outcome was correct. */
function heldButUnreadableAnchorRemote(): {
  deps: SharedPauseGitDeps;
  catFileCalls: string[][];
  lsRemoteCalls: string[][];
} {
  const catFileCalls: string[][] = [];
  const lsRemoteCalls: string[][] = [];
  const deps: SharedPauseGitDeps = {
    mintAnchor: () => "unreadable-sha-3622",
    run(args) {
      if (args[0] === "ls-remote") {
        lsRemoteCalls.push(args);
        return { status: 0, stdout: "unreadable-sha-3622\trefs/rmd-pause/hold\n" };
      }
      if (args[0] === "cat-file") {
        catFileCalls.push(args);
        return { status: 128, stdout: "" }; // object missing/unreadable — e.g. a push that never landed
      }
      return { status: 1, stdout: "" };
    },
  };
  return { deps, catFileCalls, lsRemoteCalls };
}

function tmpRoot(): string {
  return makeTempDir("shared-pause-unreachable-anchor");
}

// ── acceptance 1: "an unreachable anchor is resolved once per ref sha rather than re-read on
// every tick" ────────────────────────────────────────────────────────────────────────────────

test("an unreachable pause anchor is read once per ref sha, not once per tick", () => {
  const remote = heldButUnreadableAnchorRemote();
  const root = tmpRoot();

  // Five simulated daemon ticks against the SAME deps and the SAME held sha.
  for (let i = 0; i < 5; i++) {
    const detail = checkSharedPause(root, remote.deps);
    assert.ok(detail, `tick ${i}: an unreachable anchor must still hold`);
  }

  assert.equal(
    remote.catFileCalls.length,
    1,
    "the cat-file read for this sha must be paid exactly once, memoized for every later tick",
  );
  // ls-remote is cheap and per-tick by design (it is how a NEW sha would ever be noticed) — only
  // the anchor read behind it is meant to stop repeating.
  assert.equal(remote.lsRemoteCalls.length, 5, "ls-remote itself still runs every tick, unmemoized");
});

test("a DIFFERENT held sha is resolved again — the memo is keyed on the sha, not wired open", () => {
  const catFileCalls: string[][] = [];
  let currentSha = "sha-a";
  const deps: SharedPauseGitDeps = {
    mintAnchor: () => currentSha,
    run(args) {
      if (args[0] === "ls-remote") return { status: 0, stdout: `${currentSha}\trefs/rmd-pause/hold\n` };
      if (args[0] === "cat-file") {
        catFileCalls.push(args);
        return { status: 128, stdout: "" };
      }
      return { status: 1, stdout: "" };
    },
  };
  const root = tmpRoot();

  checkSharedPause(root, deps);
  checkSharedPause(root, deps);
  assert.equal(catFileCalls.length, 1, "two ticks on sha-a: one cat-file read");

  currentSha = "sha-b"; // a fresh mint (e.g. the previous push finally landed, or a new hold)
  checkSharedPause(root, deps);
  assert.equal(catFileCalls.length, 2, "a NEW sha must be read again — the memo never blocks a real change");
});

// ── acceptance 2: "an unreachable anchor reports that the pause cannot be attributed, distinctly
// from an ordinary held read" ───────────────────────────────────────────────────────────────────

test("an unreachable anchor names itself as unattributable rather than as a plain hold", () => {
  const remote = heldButUnreadableAnchorRemote();
  const root = tmpRoot();

  const detail = checkSharedPause(root, remote.deps);
  assert.ok(detail);
  assert.match(detail!, /unattributable/i, "the detail must name its own condition, not just say 'held'");
  assert.doesNotMatch(
    detail!,
    /set by pid/i,
    "an unreadable anchor must never be rendered with the ordinary attributed phrasing",
  );
  assert.match(detail!, /held/i, "it must still read as a hold, never as absent");
  assert.match(detail!, new RegExp(sharedPauseRef().replace(/\//g, "\\/")));
  assert.match(detail!, /rmd resume/, "the exit remains an explicit operator act, never automatic");
});

// ── acceptance 3: "an unverifiable pause still holds, so the safety property survives the fix" ─

test("a pause whose anchor cannot be read still refuses to dispatch, across repeated ticks", () => {
  const remote = heldButUnreadableAnchorRemote();
  const root = tmpRoot();

  for (let i = 0; i < 3; i++) {
    const detail = checkSharedPause(root, remote.deps);
    assert.notEqual(detail, undefined, `tick ${i}: a failed anchor read must never be scored as clear`);
  }
});
