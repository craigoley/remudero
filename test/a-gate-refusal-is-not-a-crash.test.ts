import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DAEMON_EXIT_BLOCKED,
  PER_TASK_FAILURE_RE,
  DAEMON_EXIT_ENVIRONMENTAL,
  DAEMON_EXIT_STALE,
  daemonExitCode,
  daemonExitCodeForSummary,
} from "../src/lib/daemon.js";
import { PushFailedError, defaultPushExec } from "../src/lib/git-push.js";

// ── W1-T3310 — A GATE REFUSAL IS NOT A CRASH ──────────────────────────────────────────────────
//
// MEASURED on the fleet host 2026-09-10: three `exited 1`, three `pre-push REFUSED`, three
// `test-tier-manifest: 1 test file` — 1:1:1 — against RestartPolicy=on-failure:5, while the daemon
// dispatched normally between each exit. At five, docker stops restarting.

/** The banner `hooks/pre-push` really prints, with the surrounding shape a real failure carries. */
const REAL_GATE_DETAIL = [
  "W1-T3274: Command failed: git -C /home/node/Remudero/worktrees/run-W1-T3274-1789006306269 push origin HEAD",
  "test-tier-manifest: 1 test file(s) are not recorded in scripts/test-tier-manifest.json — a test file must be tiered:",
  "  test/a-status-flip-is-not-a-task-edit.test.ts",
  "Record it with: node scripts/test-tier-manifest.mjs --seed",
  "",
  "pre-push REFUSED. These are checks CI runs on this diff; fixing them here costs one",
  "local run, and fixing them after the push costs a red PR and a review cycle.",
].join("\n");

test("W1-T3310: a drain stopped by this repo's own pre-push gate exits BLOCKED, not 1, so docker's crash budget is untouched", () => {
  assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: REAL_GATE_DETAIL }), DAEMON_EXIT_BLOCKED);
  // AND THE CRASH CODE IS STILL 1 FOR A DETAIL THAT NAMES NO TASK — otherwise the assertion above
  // would pass simply because everything became 76. (Under W1-T3319 the discriminator is WHOSE
  // failure it is, not which tool failed, so the control must be an unowned one.)
  assert.equal(
    daemonExitCodeForSummary({ stopReason: "error", stopDetail: "Command failed: git push origin HEAD" }),
    1,
  );
});

test("W1-T3319 SUPERSEDES the narrow rule: a task's push failure routes to 76 for ANY cause, not just a gate refusal", () => {
  // THESE ASSERTIONS ARE DELIBERATELY INVERTED FROM W1-T3310's. That task asked whether the pre-push
  // banner was present; this one asks whose failure it is. A credential outage on ONE task's push is
  // that task's problem, and stopping the fleet for it is the daemon blocking on something it could
  // have routed. The "every task fails" case is handled by the entrypoint's bounded retry (100), not
  // by killing the daemon on the first one.
  for (const detail of [
    "W1-T9: Command failed: git push origin HEAD\nremote: Invalid username or password\nfatal: Authentication failed",
    "W1-T9: Command failed: git push origin HEAD\n ! [rejected] HEAD -> br (non-fast-forward)",
  ]) {
    assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: detail }), DAEMON_EXIT_BLOCKED, detail.slice(0, 50));
  }
  // TWO ARMS KEEP THE BUDGET MEANINGFUL: a detail naming no task, and a task-prefixed IN-PROCESS
  // error — rmd's own defect, which recurs on every task and is what a stop still exists for.
  assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: "TypeError: undefined is not a function" }), 1);
  assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: "W1-T9: TypeError: rmd's own bug" }), 1);
});

test("W1-T3310: an environmental refusal keeps precedence over the gate check, so a network fault stays 77", () => {
  // ORDER IS LOAD-BEARING: a push that died on rate limiting is environmental even if a gate banner
  // is somewhere in the same buffer, because the remedy is to wait rather than to seed a manifest.
  const both = `${REAL_GATE_DETAIL}\nremote: You have exceeded a secondary rate limit`;
  assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: both }), DAEMON_EXIT_ENVIRONMENTAL);
});

test("W1-T3310: the existing stale, blocked and environmental mappings are unchanged, so this is additive", () => {
  assert.equal(daemonExitCode("stopped"), 0);
  assert.equal(daemonExitCode("max_reached"), 0);
  assert.equal(daemonExitCode("stale"), DAEMON_EXIT_STALE);
  assert.equal(daemonExitCode("blocked"), DAEMON_EXIT_BLOCKED);
  assert.equal(daemonExitCode("error"), 1);
  assert.equal(daemonExitCodeForSummary({ stopReason: "stale" }), DAEMON_EXIT_STALE);
  assert.equal(daemonExitCodeForSummary({ stopReason: "blocked" }), DAEMON_EXIT_BLOCKED);
  assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: undefined }), 1);
});

// ── THE PREREQUISITE: the refusal text must REACH the classifier at all ───────────────────────

test("W1-T3310: the push leaf attaches the child's stderr to the error it throws — without this the classifier sees only the argv", () => {
  // MEASURED before this change: `stdio: "inherit"` gave `e.stderr === null` and a message carrying
  // only the command, so stopDetail could never contain the banner and the text rule above would be
  // unimplementable. This drives the REAL leaf, not a fake.
  let thrown: unknown;
  try {
    defaultPushExec("bash", ["-c", "echo 'pre-push REFUSED. banner' >&2; exit 1"], { stdio: "inherit" });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof PushFailedError, `expected PushFailedError, got ${String(thrown)}`);
  const e = thrown as PushFailedError;
  assert.match(e.stderrText, /pre-push REFUSED\. banner/);
  assert.match(e.message, /pre-push REFUSED\. banner/);
  // AND THE END-TO-END CLAIM. The drain prefixes the failing task id onto the message before it
  // becomes a stop detail, which is the shape W1-T3319 keys on — so this composes the two halves
  // exactly as production does, rather than asserting on a message no drain would ever emit.
  const asDrainWouldEmit = `W1-T3274: ${e.message}`;
  assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: asDrainWouldEmit }), DAEMON_EXIT_BLOCKED);
});

test("W1-T3310: a successful push still returns normally and re-emits nothing spurious", () => {
  assert.doesNotThrow(() => defaultPushExec("bash", ["-c", "exit 0"], { stdio: "inherit" }));
  // `stdio: "ignore"` is untouched — the two fix-rung sites asked for silence deliberately, so it
  // must still throw the RAW error rather than a PushFailedError wrapping captured output.
  let ignored: unknown;
  try {
    defaultPushExec("bash", ["-c", "echo x >&2; exit 1"], { stdio: "ignore" });
  } catch (err) {
    ignored = err;
  }
  assert.ok(ignored !== undefined, "an ignore-stdio failure must still throw");
  assert.ok(!(ignored instanceof PushFailedError), "the ignore path must not be rewrapped");
});

test("W1-T3310: the blocked stop detail still NAMES the gate and its remedy, so the cause is legible without docker logs", () => {
  // Design (iv): a quieter exit that hides the cause is worse than the crash it replaced.
  assert.match(REAL_GATE_DETAIL, /test-tier-manifest/);
  assert.match(REAL_GATE_DETAIL, /node scripts\/test-tier-manifest\.mjs --seed/);
  assert.equal(daemonExitCodeForSummary({ stopReason: "error", stopDetail: REAL_GATE_DETAIL }), DAEMON_EXIT_BLOCKED);
  // The banner this classifier keys on is the one the checked-in hook really prints — asserted
  // against the hook itself, so a reworded banner fails here rather than silently stopping the fix.
  // READ FROM THE WORKING TREE, not `git show HEAD:...`: shelling git plumbing is a `live-tree-git`
  // fixture that test/host-capability-fixtures.test.ts refuses by name, and rightly — it depends on
  // the host's git state, which a CI runner's shallow checkout need not provide.
  const hook = readFileSync(new URL("../hooks/pre-push", import.meta.url), "utf8");
  assert.match(hook, /pre-push REFUSED\./, "hooks/pre-push no longer prints the banner this keys on");
});

test("W1-T3310: the captured stderr is RE-EMITTED, so piping it does not hide the refusal from the operator", () => {
  // M6: without this, capturing stderr silently traded one blind spot for another — the classifier
  // could read the reason and the human watching the push could not. `stdio: "inherit"` exists so a
  // push is not silent; this asserts that property survived the change to piping.
  const written: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  try {
    assert.throws(() =>
      defaultPushExec("bash", ["-c", "echo 'pre-push REFUSED. seen by the operator' >&2; exit 1"], { stdio: "inherit" }),
    );
  } finally {
    (process.stderr as { write: unknown }).write = real;
  }
  assert.ok(
    written.some((w) => /pre-push REFUSED\. seen by the operator/.test(w)),
    `the child's stderr must reach the parent's stderr; saw ${JSON.stringify(written)}`,
  );
});

test("W1-T3310: the refusal pattern is driven DIRECTLY, both arms — where it matches and where it stops", () => {
  // negative-reachability-ratchet requires a regex surface to be invoked as `SYMBOL.test(...)` with
  // BOTH a `true` and a `false` asserted. `assert.match` does NOT satisfy it and should not: it never
  // invokes the symbol, so the ratchet cannot see which arms were covered — measured, my first draft
  // used assert.match and still counted as fixture-less.
  //
  // THE STOPPING ARM IS THE LOAD-BEARING ONE. If this fired on a mere mention, an ordinary crash
  // would be reclassified as blocked and the crash budget would stop protecting anything.
  for (const matching of ["W1-T3274: Command failed: git push", "W1-T9: Command failed: x", "W12-T3a: Command failed: y"]) {
    assert.equal(PER_TASK_FAILURE_RE.test(matching), true, `expected a match: ${JSON.stringify(matching)}`);
  }
  for (const stopping of [
    "TypeError: undefined is not a function", // a bare crash names no task
    " W1-T9: leading space breaks the anchor",
    "see W1-T9: mid-string is not the emitter's shape",
    "W1-T9 no colon",
    "W1-T9: TypeError: an in-process defect is rmd's, not the task's",
    "error: something failed",                // NOT "anything with a colon"
    "",
  ]) {
    assert.equal(PER_TASK_FAILURE_RE.test(stopping), false, `expected NO match: ${JSON.stringify(stopping)}`);
  }
});
