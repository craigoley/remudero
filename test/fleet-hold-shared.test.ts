import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkSharedPause,
  clearSharedPause,
  consumeStop,
  isPaused,
  isStopped,
  pauseDetail,
  readSharedPause,
  requestPause,
  requestStop,
  resumeFleet,
  sharedPauseRef,
  writeSharedPause,
  type SharedPauseGitDeps,
} from "../src/lib/fleet-control.js";

// ── W1-T1216 — THE FLEET HOLD IS PER-HOST STATE ─────────────────────────────────────────────
//
// `pauseFilePath(root)` is `<root>/state/PAUSE`, and `root` (`config.root`) resolves DIFFERENTLY
// per host — two hosts running identical code land in different directories, and `state/` is
// gitignored so the file can never travel by the one channel every host already shares. A PAUSE
// written on one host was therefore invisible to a daemon checking `pauseDetail` on another.
//
// `checkSharedPause` closes the gap by falling through, ONLY when the local file is silent, to a
// shared ref on `origin` (`refs/rmd-pause/hold`) — mirroring `triageClaimRef`'s namespace family.
// Every test here drives that fall-through against a FAKE remote (an in-memory ref Map), never a
// real network call, so the DECISION logic is proved without I/O flake.

/** An in-memory stand-in for `origin`'s ref store — mirrors `feedback-triage-claim.test.ts`'s own
 *  `fakeRemote` helper, so two "hosts" can be driven against ONE shared remote inside one process.
 *  `calls` records every `run` invocation verbatim, so a test can prove a code path never touched
 *  the network at all (claim 3 below). */
function fakeRemote(): { refs: Map<string, string>; calls: string[][]; deps: SharedPauseGitDeps } {
  const refs = new Map<string, string>();
  const calls: string[][] = [];
  let anchorSeq = 0;
  const deps: SharedPauseGitDeps = {
    mintAnchor() {
      anchorSeq += 1;
      return `fake-anchor-${anchorSeq}`;
    },
    run(args) {
      calls.push(args);
      if (args[0] === "ls-remote") {
        const ref = args[2];
        const sha = refs.get(ref);
        return { status: 0, stdout: sha ? `${sha}\t${ref}\n` : "" };
      }
      if (args[0] === "push") {
        const spec = args[args.length - 1];
        const sep = spec.indexOf(":");
        const anchor = spec.slice(0, sep);
        const ref = spec.slice(sep + 1);
        if (anchor === "") {
          refs.delete(ref);
        } else {
          refs.set(ref, anchor);
        }
        return { status: 0, stdout: "" };
      }
      return { status: 1, stdout: "" };
    },
  };
  return { refs, calls, deps };
}

/** A remote every read/write of which fails — the network-partition arm. */
function unreachableRemote(): { calls: string[][]; deps: SharedPauseGitDeps } {
  const calls: string[][] = [];
  const deps: SharedPauseGitDeps = {
    mintAnchor: () => "fake-anchor-unreachable",
    run(args) {
      calls.push(args);
      return { status: 128, stdout: "" };
    },
  };
  return { calls, deps };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "fleet-hold-shared-"));
}

// ── readSharedPause discriminates the three outcomes rationale (10) measured ───────────────────

test("readSharedPause: an absent ref reads absent (status 0, no stdout)", () => {
  const remote = fakeRemote();
  assert.equal(readSharedPause(remote.deps), "absent");
});

test("readSharedPause: a present ref reads held (status 0, some stdout)", () => {
  const remote = fakeRemote();
  writeSharedPause(remote.deps);
  assert.equal(readSharedPause(remote.deps), "held");
});

test("readSharedPause: a nonzero exit reads unreachable, never absent", () => {
  const remote = unreachableRemote();
  assert.equal(readSharedPause(remote.deps), "unreachable");
});

test("sharedPauseRef is the documented literal ref, under refs/rmd-pause/", () => {
  assert.equal(sharedPauseRef(), "refs/rmd-pause/hold");
});

// ── acceptance claim 1: a daemon whose own host never saw the pause still refuses to dispatch ──

test("a daemon whose own host never saw the pause still refuses to dispatch", () => {
  const remote = fakeRemote();
  // A DIFFERENT host wrote the hold — this host's local root has no PAUSE file at all.
  writeSharedPause(remote.deps);

  const thisHostRoot = tmpRoot();
  assert.equal(pauseDetail(thisHostRoot), undefined, "this host's local file was never written");

  const detail = checkSharedPause(thisHostRoot, remote.deps);
  assert.ok(detail, "the daemon's per-tick supplier must still report paused");
  assert.match(detail!, new RegExp(sharedPauseRef().replace(/\//g, "\\/")));
});

// ── acceptance claim 2: an unreachable origin holds rather than releasing ──────────────────────

test("an unreachable origin holds rather than releasing", () => {
  const remote = unreachableRemote();
  const root = tmpRoot();
  assert.equal(pauseDetail(root), undefined, "no local flag either");

  const detail = checkSharedPause(root, remote.deps);
  assert.ok(detail, "a failed read must never be scored as clear");
  assert.notEqual(detail, undefined);
});

// ── acceptance claim 3: the local file alone still pauses a host that cannot reach origin ──────

test("the local file alone still pauses a host that cannot reach origin", () => {
  const remote = unreachableRemote();
  const root = tmpRoot();
  requestPause(root, "local maintenance, no network needed");

  const detail = checkSharedPause(root, remote.deps);
  assert.match(detail ?? "", /local maintenance, no network needed/);
  assert.deepEqual(remote.calls, [], "the local file already answered — no network call was made");
});

// ── acceptance claim 4: stop stays one-shot and never becomes a persistent hold ────────────────

test("stop stays one-shot and never becomes a persistent hold, even while a shared PAUSE is held", () => {
  const remote = fakeRemote();
  writeSharedPause(remote.deps); // a cross-host PAUSE is in effect
  remote.calls.length = 0; // reset the write above out of the ledger this test checks

  const root = tmpRoot();
  requestStop(root, "accidental run");
  assert.equal(isStopped(root), true);

  const cleared = consumeStop(root);
  assert.equal(cleared, true, "the halting run auto-consumed STOP");
  assert.equal(isStopped(root), false, "STOP is one-shot — never persists across a consume");

  // Nothing about STOP's request/consume cycle ever touched the shared remote — STOP has no
  // cross-host question to answer (design (iii)).
  assert.deepEqual(remote.calls, [], "requestStop/consumeStop must never read or write the shared ref");
  // ...and the shared PAUSE this test set up independently is completely unaffected by it.
  assert.equal(readSharedPause(remote.deps), "held", "STOP's one-shot consume must not clear PAUSE, local or shared");
});

// ── acceptance claim 5: resume is still the only thing that clears a pause ─────────────────────

test("resume is still the only thing that clears a pause — local and shared alike", () => {
  const remote = fakeRemote();
  const root = tmpRoot();

  const info = requestPause(root, "maintenance window", remote.deps);
  assert.equal(isPaused(root), true);
  assert.equal(readSharedPause(remote.deps), "held");
  assert.ok(info.requestedAt, "requestPause still returns the same FleetControlInfo shape");

  // Unrelated activity — repeatedly reading the gate, and a STOP request/consume cycle on the
  // SAME root — must not clear the pause either.
  for (let i = 0; i < 3; i++) checkSharedPause(root, remote.deps);
  requestStop(root, "unrelated");
  consumeStop(root);
  assert.equal(isPaused(root), true, "no read, and no unrelated STOP cycle, ever clears PAUSE");
  assert.equal(readSharedPause(remote.deps), "held");

  const result = resumeFleet(root, remote.deps);
  assert.equal(result.clearedPause, true);
  assert.equal(result.clearedSharedPause, true);
  assert.equal(isPaused(root), false, "resume cleared the local flag");
  assert.equal(readSharedPause(remote.deps), "absent", "resume cleared the shared ref too");
  assert.equal(checkSharedPause(root, remote.deps), undefined, "the daemon's supplier now sees clear");
});

test("resumeFleet called with no deps leaves the existing two-key result shape untouched", () => {
  const root = tmpRoot();
  requestStop(root, "a");
  requestPause(root, "b");
  const r = resumeFleet(root);
  assert.deepEqual(r, { clearedStop: true, clearedPause: true }, "no `deps` ⇒ no `clearedSharedPause` key at all");
});

test("clearSharedPause on an already-absent ref is a harmless no-op", () => {
  const remote = fakeRemote();
  assert.equal(readSharedPause(remote.deps), "absent");
  clearSharedPause(remote.deps);
  assert.equal(readSharedPause(remote.deps), "absent");
});
