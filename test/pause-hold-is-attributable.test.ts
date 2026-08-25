import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkSharedPause,
  readSharedPauseAnchor,
  sharedPauseRef,
  writeSharedPause,
  type SharedPauseGitDeps,
} from "../src/lib/fleet-control.js";

// ── W1-T2262 — ONE PUSHABLE REF HALTS EVERY LANE AND NAMES NOBODY ──────────────────────────────
//
// Two seams, one concern: (a) `hooks/deny-floor.sh` never named `refs/rmd-pause/hold`, so a plain
// `git push` with the same token every worker holds could set the fleet-wide hold with no gate at
// all; (b) `writeSharedPause`'s anchor already mints pid/host/timestamp into the commit it pushes
// and every reader (`readSharedPause`, `checkSharedPause`) discarded the sha `ls-remote` handed
// back, rendering "(set from another host)" instead of naming who. Both halves of this file prove
// their half against the REAL artifact — the actual hook script for (a), the actual
// fleet-control.ts functions for (b) — never a re-implemented stand-in.

// ═══ (a) THE DENY-FLOOR TRIPWIRE ════════════════════════════════════════════════════════════════

const HOOK_PATH = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

function runDenyFloor(command: string): { status: number | null; stderr: string } {
  const input = JSON.stringify({ tool_input: { command } });
  const result = spawnSync("bash", [HOOK_PATH], { input, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

// acceptance 1: "the deny floor refuses a push whose refspec names the shared pause namespace,
// and leaves an ordinary branch push alone"

test("deny-floor: refuses a push whose refspec creates/updates refs/rmd-pause/hold", () => {
  const { status, stderr } = runDenyFloor("git push origin abc123def:refs/rmd-pause/hold");
  assert.equal(status, 2);
  assert.match(stderr, /rmd-pause/);
});

test("deny-floor: refuses a push whose refspec DELETES refs/rmd-pause/hold too", () => {
  const { status, stderr } = runDenyFloor("git push origin :refs/rmd-pause/hold");
  assert.equal(status, 2);
  assert.match(stderr, /rmd-pause/);
});

test("deny-floor: leaves an ordinary branch push alone", () => {
  const { status } = runDenyFloor("git push origin HEAD:refs/heads/run-W1-T2262-abc");
  assert.equal(status, 0);
});

test("deny-floor: leaves an unrelated refs/ push (e.g. rmd-triage/rmd-id namespaces) alone", () => {
  const triage = runDenyFloor("git push origin abc123:refs/rmd-triage/fb-1");
  assert.equal(triage.status, 0);
  const id = runDenyFloor("git push origin abc123:refs/rmd-id/W1-T1");
  assert.equal(id.status, 0);
});

// acceptance 2: "a refspec assembled indirectly still reaches the remote, and that limitation is
// asserted rather than assumed" — the tripwire greps the LITERAL `command` text the PreToolUse
// hook receives; it never executes or expands shell, so a refspec built from a variable whose
// VALUE (not its assignment) is `refs/rmd-pause/hold` — set in an EARLIER command, or in the
// process environment — never puts that literal text in THIS command string and is NOT caught.
// (A same-command assignment like `ref="refs/rmd-pause/hold"; git push ... "$ref"` is a red
// herring: the literal text is still present in that command's own text, so rule 7 DOES catch it
// — it only fails to catch a value the hook never sees at all.) This is documented in the hook's
// own rule-7 comment as a known, accepted gap (the durable fix is server-side) — this test proves
// the gap is real rather than a claim nobody checked.

test("deny-floor: a refspec built from an already-exported variable (value never in the command text) is NOT caught — documented limitation, not a claim", () => {
  const sameCommand = runDenyFloor('ref="refs/rmd-pause/hold"; git push origin "abc123:$ref"');
  assert.equal(sameCommand.status, 2, "the literal text IS present in this command's own string, so rule 7 still catches it");

  // The gap: a refspec sourced from a variable set OUTSIDE this command — the hook sees only
  // `$PAUSE_REF`, never the value `refs/rmd-pause/hold` it expands to at actual execution time.
  const indirect = runDenyFloor('git push origin "abc123:$PAUSE_REF"');
  assert.equal(indirect.status, 0, "the tripwire greps literal command text and a pre-set env var defeats it — expected, not a bug");
});

// ═══ (b) THE ANCHOR ATTRIBUTION ════════════════════════════════════════════════════════════════

/** Mirrors test/fleet-hold-shared.test.ts's own `fakeRemote` helper, extended with `cat-file`
 *  support (`log`/`show` semantics: recover the message minted for a given sha) — the read this
 *  file exists to prove nothing previously performed. */
function fakeRemote(): {
  refs: Map<string, string>;
  anchors: Map<string, string>;
  calls: string[][];
  deps: SharedPauseGitDeps;
} {
  const refs = new Map<string, string>();
  const anchors = new Map<string, string>(); // sha -> minted commit message
  const calls: string[][] = [];
  let anchorSeq = 0;
  const deps: SharedPauseGitDeps = {
    mintAnchor() {
      anchorSeq += 1;
      const sha = `fake-anchor-${anchorSeq}`;
      anchors.set(sha, `rmd-pause hold ${9000 + anchorSeq}@host-${anchorSeq}.example 2026-08-25T03:27:38.000Z`);
      return sha;
    },
    run(args) {
      calls.push(args);
      if (args[0] === "ls-remote") {
        const ref = args[2];
        const sha = refs.get(ref!);
        return { status: 0, stdout: sha ? `${sha}\t${ref}\n` : "" };
      }
      if (args[0] === "push") {
        const spec = args[args.length - 1]!;
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
      if (args[0] === "cat-file" && args[1] === "-p") {
        const sha = args[2]!;
        const msg = anchors.get(sha);
        // real `git cat-file -p` on a commit prints header lines, a blank line, then the message
        return msg
          ? { status: 0, stdout: `tree deadbeef\nauthor a <a@b> 0 +0000\ncommitter a <a@b> 0 +0000\n\n${msg}\n` }
          : { status: 128, stdout: "" };
      }
      return { status: 1, stdout: "" };
    },
  };
  return { refs, anchors, calls, deps };
}

/** A remote whose ref exists (ls-remote succeeds) but whose object is unreadable — the "held but
 *  unattributable" arm: GC'd object, truncated clone, or an anchor minted by something that never
 *  used the expected message shape. */
function heldButUnreadableAnchorRemote(): { deps: SharedPauseGitDeps } {
  const deps: SharedPauseGitDeps = {
    mintAnchor: () => "unreadable-sha",
    run(args) {
      if (args[0] === "ls-remote") {
        return { status: 0, stdout: "unreadable-sha\trefs/rmd-pause/hold\n" };
      }
      if (args[0] === "cat-file") {
        return { status: 128, stdout: "" }; // object missing/unreadable
      }
      return { status: 1, stdout: "" };
    },
  };
  return { deps };
}

// acceptance 3: "the anchor minted for a hold carries process, host and timestamp fields a reader
// can recover"

test("readSharedPauseAnchor recovers pid/host/timestamp off the anchor commit's message", () => {
  const remote = fakeRemote();
  const sha = remote.deps.mintAnchor();
  const info = readSharedPauseAnchor(sha, remote.deps);
  assert.ok(info, "the payload minted into the anchor must be recoverable");
  assert.equal(info!.pid, "9001");
  assert.equal(info!.host, "host-1.example");
  assert.equal(info!.timestamp, "2026-08-25T03:27:38.000Z");
});

test("readSharedPauseAnchor returns null (never throws) when the object cannot be read", () => {
  const remote = heldButUnreadableAnchorRemote();
  const info = readSharedPauseAnchor("unreadable-sha", remote.deps);
  assert.equal(info, null);
});

// acceptance 4: "a held read renders detail naming the recorded setter instead of an anonymous
// other host"

test("checkSharedPause names the recorded setter (pid@host, timestamp) instead of 'another host'", () => {
  const remote = fakeRemote();
  writeSharedPause(remote.deps);

  const detail = checkSharedPause(`/tmp/does-not-exist-${process.pid}`, remote.deps);
  assert.ok(detail, "a held ref must still produce a detail string");
  assert.doesNotMatch(detail!, /set from another host/, "the anonymous phrasing must be gone");
  assert.match(detail!, /9001@host-1\.example/, "the recorded pid@host must be named");
  assert.match(detail!, /2026-08-25T03:27:38\.000Z/, "the recorded timestamp must be named");
  assert.match(detail!, new RegExp(sharedPauseRef().replace(/\//g, "\\/")));
});

// acceptance 5: "an anchor whose payload cannot be recovered still renders a held detail rather
// than degrading to absent"

test("checkSharedPause: an unrecoverable anchor still renders HELD, never absent/undefined", () => {
  const remote = heldButUnreadableAnchorRemote();
  const detail = checkSharedPause(`/tmp/does-not-exist-${process.pid}-2`, remote.deps);
  assert.notEqual(detail, undefined, "a failed anchor read must not be scored as clear");
  assert.match(detail!, /held/i);
  assert.doesNotMatch(detail!, /\babsent\b/i);
});

// acceptance 6: "an unreachable read stays held and no code path clears the hold on elapsed time
// alone"

test("checkSharedPause: an unreachable origin stays held across repeated reads — no timer clears it", () => {
  const deps: SharedPauseGitDeps = {
    mintAnchor: () => "fake-anchor-unreachable",
    run: () => ({ status: 128, stdout: "" }),
  };
  const root = `/tmp/does-not-exist-${process.pid}-3`;
  for (let i = 0; i < 5; i++) {
    const detail = checkSharedPause(root, deps);
    assert.notEqual(detail, undefined, `iteration ${i}: unreachable must never read as clear`);
  }
});

test("checkSharedPause: a hold minted long ago still reads held — attribution never ages into expiry", () => {
  const remote = fakeRemote();
  // Overwrite the minted anchor's message with a far-past timestamp — nothing in checkSharedPause
  // may compare it against the clock to decide whether the hold still counts.
  const sha = remote.deps.mintAnchor();
  remote.anchors.set(sha, `rmd-pause hold 1@ancient-host 2000-01-01T00:00:00.000Z`);
  remote.deps.run(["push", "origin", `${sha}:${sharedPauseRef()}`]);

  const detail = checkSharedPause(`/tmp/does-not-exist-${process.pid}-4`, remote.deps);
  assert.ok(detail, "an old anchor is still a HELD anchor — no expiry");
  assert.match(detail!, /ancient-host/);
  assert.match(detail!, /run `rmd resume`/, "clearing it remains an explicit act, never automatic");
});
