#!/usr/bin/env node
// test/fixtures/test-with-retry/fake-suite.mjs — deterministic stand-in "test command" for
// test/test-with-retry.test.ts (W1-T255). Never touches the real `node --test` runner or any
// genuinely-flaky Chromium suite -- it just emits realistic TAP output (the format `node --test`
// itself emits on every CI invocation, since stdout there is never a TTY) and an exit code driven
// by --mode, plus a persisted invocation counter, so scripts/test-with-retry.mjs's retry/parse/
// kill-switch behavior can be proven directly.
//
// Modes:
//   deterministic-fail  -- always fails (proves a real break survives both attempts)
//   flake-once          -- fails on invocation 1, passes on invocation 2 (proves the retry
//                           recovers a flake AND names it)
//   always-pass         -- always passes (proves a healthy command is spawned exactly once)
//
// --format tap (default) emits the TAP `not ok N - <name>` shape node --test itself writes when
// stdout isn't a TTY (every CI invocation). --format spec emits the `spec` reporter's `✖ <name>
// (Nms)` shape instead -- the coverage job's dual-reporter step explicitly requests it, so
// scripts/test-with-retry.mjs's parseFailingTestNames must recognize both.
//
// A failing run also writes one line to stderr (real `node --test` runs interleave diagnostics
// there too), so the wrapper's stderr-forwarding path is exercised by the same failing-mode runs
// rather than needing a dedicated fixture mode.
//
// --sleep-ms N (W1-T2433): blocks for N milliseconds before concluding pass/fail, so tests can
// give a "pass 1" a controlled, known duration -- needed to exercise
// scripts/test-with-retry.mjs's TEST_RETRY_BUDGET_SECONDS decline logic (whether the wrapper
// starts pass 2 depends on how long pass 1 actually took). Uses a synchronous busy-wait rather
// than `setTimeout`/async sleep so it also holds up any downstream event-loop-timing assumptions
// the same way a genuinely slow test suite would.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const mode = opt("--mode", "always-pass");
const stateFile = opt("--state-file");
const testName = opt("--test-name", "sample flaky test");
const format = opt("--format", "tap");
const sleepMs = Number(opt("--sleep-ms", "0"));

if (sleepMs > 0) {
  const until = Date.now() + sleepMs;
  while (Date.now() < until) {
    // busy-wait: this fixture stands in for a slow real test suite, not an async delay.
  }
}

let count = 0;
if (stateFile && existsSync(stateFile)) {
  count = Number(readFileSync(stateFile, "utf8").trim() || "0");
}
count += 1;
if (stateFile) writeFileSync(stateFile, String(count));

function fail() {
  console.error(`# fake-suite: ${testName} failed on invocation ${count} (stderr diagnostic)`);
  if (format === "spec") {
    console.log(`  ✖ ${testName} (3ms)`);
  } else {
    console.log("TAP version 13");
    console.log(`# Subtest: ${testName}`);
    console.log(`not ok 1 - ${testName}`);
    console.log("1..1");
    console.log("# tests 1");
    console.log("# pass 0");
    console.log("# fail 1");
  }
  process.exitCode = 1;
}

function pass() {
  console.log("TAP version 13");
  console.log(`# Subtest: ${testName}`);
  console.log(`ok 1 - ${testName}`);
  console.log("1..1");
  console.log("# tests 1");
  console.log("# pass 1");
  console.log("# fail 0");
  process.exitCode = 0;
}

if (mode === "deterministic-fail") {
  fail();
} else if (mode === "flake-once") {
  if (count === 1) fail();
  else pass();
} else {
  pass();
}
