// test/egress-command-reports-its-own-outcome.test.ts — W1-T2344 (Q2 ONLY).
//
// THE TURN THIS SAVES. The containment probe's command 4 discards its body (`-o /dev/null`),
// redirects `-w`'s output into a file, and sends stderr to `/dev/null`, so on the worker's own
// transcript it produced NOTHING — a reached request and a denied one look identical. The worker
// then spent a turn reading the marker files back before it could write an accurate closing
// REPORT. That turn is measured, not supposed: a failing transcript reads "Both curls produced no
// output. Let me verify which marker files were created", which is verbatim the ambiguity
// `PROBE_TURN_ALLOWANCE`'s own doc names as allowance-turn 1.
//
// WHY REMOVING ONE TURN IS ARITHMETICALLY ENOUGH FOR THE POPULATION THAT SPENDS IT: every one of
// the 33 exhausted probes that recorded a count read `num_turns: 11` against `max_turns: 10` —
// exactly one turn over, every time, never five — while succeeding probes ran a median of 9 of 10.
//
// WHAT THIS IS NOT. It is not Q1. `PROBE_TURN_ALLOWANCE` is not touched, `probeTurnBudget` is not
// touched, and no command is added or removed — each of the six proves something and the probe
// grew for reasons. The tests below assert all three, because the value of shipping this alone is
// that the NEXT reading is attributable to this change and nothing else.
//
// AND IT MUST NOT WEAKEN WHAT COMMAND 4 PROVES. Printing an outcome must ACCOMPANY the observation,
// never replace it: a command that prints "denied" without testing anything is the vacuous-pass
// shape. The driven tests below run the real generated command against a stub `curl` and assert
// BOTH directions — a curl that comes back prints `reached` and writes its marker, a curl that
// fails prints `not-reached` and writes none — so the printed word cannot be a constant.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  containmentProbePrompt,
  egressProbeCommand,
  probeArmsReported,
  probeCommandCount,
  probeTurnBudget,
  EGRESS_ALLOWED_MARKER,
  EGRESS_ALLOWED_REMOTE_IP_FILE,
  EGRESS_BLOCKED_HOST,
  EGRESS_BLOCKED_MARKER,
  EGRESS_BLOCKED_REMOTE_IP_FILE,
  EGRESS_RESULT_PREFIX,
  EGRESS_TIMEOUT_SECONDS,
  PROBE_TURN_ALLOWANCE,
  type ContainmentEvidence,
} from "../src/lib/containment.js";

/** Run the REAL generated command 4 in a scratch cwd, with `curl` stubbed to the given exit code. */
function runCommandFour(curlExit: number): { stdout: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-egress-"));
  const bin = mkdtempSync(join(tmpdir(), "rmd-bin-"));
  // The stub writes to stdout exactly as curl's `-w` would, so the `> file` redirection and the
  // `&&`-gating on exit status are both exercised for real.
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nprintf '203.0.113.7'\nexit ${curlExit}\n`);
  chmodSync(join(bin, "curl"), 0o755);
  const cmd = egressProbeCommand("api.github.com").replace(/\s{2,}\(.*$/s, "");
  const stdout = execFileSync("sh", ["-c", cmd], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  rmSync(bin, { recursive: true, force: true });
  return { stdout, dir };
}

// ── THE CHANGE: the command says what it just did ─────────────────────────────────────────────

void test("a curl that COMES BACK prints reached, and still writes the marker the executor reads", () => {
  const { stdout, dir } = runCommandFour(0);
  try {
    assert.match(stdout, new RegExp(`^${EGRESS_RESULT_PREFIX} blocked=reached$`, "m"));
    assert.match(stdout, new RegExp(`^${EGRESS_RESULT_PREFIX} allowed=reached$`, "m"));
    // THE OBSERVATION IS UNTOUCHED: `defaultExecutor` reads these with existsSync, and it still can.
    assert.equal(existsSync(join(dir, EGRESS_BLOCKED_MARKER)), true, "the marker is still written");
    assert.equal(existsSync(join(dir, EGRESS_ALLOWED_MARKER)), true);
    assert.equal(readFileSync(join(dir, EGRESS_BLOCKED_REMOTE_IP_FILE), "utf8"), "203.0.113.7", "and -w still lands in its file");
    assert.equal(readFileSync(join(dir, EGRESS_ALLOWED_REMOTE_IP_FILE), "utf8"), "203.0.113.7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a curl that FAILS prints not-reached and writes no marker — the printed word is not a constant", () => {
  const { stdout, dir } = runCommandFour(7);
  try {
    assert.match(stdout, new RegExp(`^${EGRESS_RESULT_PREFIX} blocked=not-reached$`, "m"));
    assert.match(stdout, new RegExp(`^${EGRESS_RESULT_PREFIX} allowed=not-reached$`, "m"));
    assert.equal(existsSync(join(dir, EGRESS_BLOCKED_MARKER)), false, "no marker, because nothing came back");
    assert.equal(existsSync(join(dir, EGRESS_ALLOWED_MARKER)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("THE ANTI-VACUITY PAIR: the two runs disagree, so the line reports rather than asserts", () => {
  const reached = runCommandFour(0);
  const denied = runCommandFour(7);
  try {
    assert.notEqual(reached.stdout, denied.stdout, "a command that printed a constant would produce identical output");
    assert.ok(reached.stdout.includes("blocked=reached") && denied.stdout.includes("blocked=not-reached"));
  } finally {
    rmSync(reached.dir, { recursive: true, force: true });
    rmSync(denied.dir, { recursive: true, force: true });
  }
});

// ── WHAT COMMAND 4 PROVES IS UNCHANGED ────────────────────────────────────────────────────────

void test("the egress command still makes both requests, at its own timeout, against both hosts", () => {
  const cmd = egressProbeCommand("api.github.com");
  assert.match(cmd, new RegExp(`-m ${EGRESS_TIMEOUT_SECONDS}\\b`));
  assert.ok(cmd.includes(EGRESS_BLOCKED_HOST), "the RFC 2606 blocked target");
  assert.ok(cmd.includes("api.github.com"), "the allowlisted control target");
  assert.equal((cmd.match(/curl /g) ?? []).length, 2, "two requests, still bundled as ONE command");
  // COUNTED, not merely present: `includes` would stay green with the flag stripped from ONE of
  // the two curls, which is exactly the mutation that caught this assertion being too weak.
  assert.equal((cmd.match(/-o \/dev\/null/g) ?? []).length, 2, "the body is STILL discarded on BOTH requests — printing an outcome is not reading a response");
  assert.equal((cmd.match(/%\{remote_ip\}/g) ?? []).length, 2, "and -w still exposes only the address already connected to, on both");
});

// ── THE BUDGET IS NOT TOUCHED. THIS IS Q2, NOT Q1. ────────────────────────────────────────────

void test("the probe still runs six commands on a ten-turn budget with a three-turn allowance", () => {
  const prompt = containmentProbePrompt("tok", "api.github.com");
  assert.equal(probeCommandCount(prompt), 6, "no command added and none removed");
  assert.equal(probeTurnBudget(prompt), 10, "the derived cap is unmoved");
  assert.equal(PROBE_TURN_ALLOWANCE, 3, "the per-probe allowance is Q1's subject and is NOT changed here");
  assert.equal(probeTurnBudget(prompt), probeCommandCount(prompt) + 1 + PROBE_TURN_ALLOWANCE, "still derived, never hand-picked");
});

void test("every one of the six commands is still in the prompt, since none may be dropped to afford a turn", () => {
  const prompt = containmentProbePrompt("tok", "api.github.com");
  const numbered = prompt.split("\n").filter((l) => /^[0-9]+\)/.test(l));
  assert.equal(numbered.length, 6);
  assert.match(numbered[0]!, /OUTSIDE your working directory/);
  assert.match(numbered[1]!, /INSIDE your working directory/);
  assert.match(numbered[2]!, /tripwire a policy hook is expected to refuse/);
  assert.match(numbered[3]!, /curl/);
  assert.match(numbered[4]!, /cat /);
  assert.match(numbered[5]!, /cat /);
});

// ── arms_reported IS NOT A TRANSCRIPT READ, SO IT CANNOT MOVE ─────────────────────────────────

void test("arms_reported is a reduction over evidence booleans, so printing a line cannot move it", () => {
  // The count reads 5-6 on an exhausted probe and 9-10 on a success purely because an exhausted
  // probe got far enough to make fewer positive observations. Nothing in it reads transcript text,
  // which is why this change moves it by zero — asserted here rather than assumed.
  const full: ContainmentEvidence = {
    outsideWriteAttempted: true, osDenialSeen: true, insideWriteCreated: true,
    denyFloorProbeCreated: false, denyFloorDenialSeen: true,
    egressBlockedReached: true, egressAllowedReached: true, egressDenialSeen: true,
    tokenReadSucceeded: true, stateReadSucceeded: true, tokenReadDenialSeen: true,
    operatorHomeReadSucceeded: true, operatorHomeReadDenialSeen: true,
  } as unknown as ContainmentEvidence;
  const before = probeArmsReported(full);
  assert.ok(before >= 9, `a fully-reporting probe counts high, got ${before}`);
  // A partial probe — the exhausted shape — counts lower, from the SAME reduction.
  const partial = { ...full, tokenReadSucceeded: false, stateReadSucceeded: false, tokenReadDenialSeen: false, operatorHomeReadSucceeded: false, operatorHomeReadDenialSeen: false } as ContainmentEvidence;
  assert.ok(probeArmsReported(partial) < before, "fewer positive observations, fewer arms");
});
