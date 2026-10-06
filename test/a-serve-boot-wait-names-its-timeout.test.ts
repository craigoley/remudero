/**
 * test/a-serve-boot-wait-names-its-timeout.test.ts — W1-T6031.
 *
 * waitForServeBanner (test/helpers/serve-boot-banner.ts) is the one wait the real-serve suites use
 * for "listening on". Its three outcomes are proven here against FAKE children and a plain log
 * file — no serve boot — because the defect was that the third one (a child still booting when the
 * deadline passed) read as the first content assertion after the wait, a guard regression.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { type ServeChildState, waitForServeBanner } from "./helpers/serve-boot-banner.js";

function logFixture(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-boot-banner-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "serve.out.log");
}

const BOOTING_LOG = "warning: .nvmrc pins a different node\n";

test("a banner that appears within the bound returns the whole log", async (t) => {
  const logPath = logFixture(t);
  const alive: ServeChildState = { exitCode: null };
  setTimeout(() => appendFileSync(logPath, "listening on http://127.0.0.1:4100\n"), 30);
  const log = await waitForServeBanner(logPath, alive, 60_000, 5);
  assert.match(log, /listening on http:\/\/127\.0\.0\.1:4100/);
});

test("a log file that does not exist yet reads as booting, not as a failure", async (t) => {
  const logPath = logFixture(t);
  const alive: ServeChildState = { exitCode: null, signalCode: null };
  setTimeout(() => writeFileSync(logPath, "listening on http://127.0.0.1:4101\n"), 30);
  assert.match(await waitForServeBanner(logPath, alive, 60_000, 5), /listening on/);
});

test("a child that exits before its banner fails at once as an EXIT, carrying its log", async (t) => {
  const logPath = logFixture(t);
  writeFileSync(logPath, "error: loadPlan failed\n");
  await assert.rejects(
    waitForServeBanner(logPath, { exitCode: 2 }, 60_000, 5),
    (e: Error) => {
      assert.match(e.message, /serve exited \(code 2, signal null\) before printing its banner/);
      assert.match(e.message, /loadPlan failed/);
      assert.doesNotMatch(e.message, /WALL-CLOCK DEPENDENT/, "an exit is a real failure, never a timeout");
      return true;
    },
  );
});

test("a child killed by a signal before its banner also fails as an exit", async (t) => {
  const logPath = logFixture(t);
  writeFileSync(logPath, BOOTING_LOG);
  await assert.rejects(waitForServeBanner(logPath, { exitCode: null, signalCode: "SIGKILL" }, 60_000, 5), /signal SIGKILL\) before printing its banner/);
});

test("a child that prints its banner and exits between two reads returns the banner, not an exit", async (t) => {
  const logPath = logFixture(t);
  writeFileSync(logPath, BOOTING_LOG);
  // The exit is observed only after the first read, and the banner lands just before it.
  const racing: ServeChildState = {
    get exitCode(): number {
      appendFileSync(logPath, "listening on http://127.0.0.1:4102\n");
      return 0;
    },
  };
  assert.match(await waitForServeBanner(logPath, racing, 60_000, 5), /listening on http:\/\/127\.0\.0\.1:4102/);
});

test("a child still booting when the bound passes fails WALL-CLOCK DEPENDENT, naming the missing banner", async (t) => {
  const logPath = logFixture(t);
  writeFileSync(logPath, BOOTING_LOG);
  await assert.rejects(waitForServeBanner(logPath, { exitCode: null }, 20, 5), (e: Error) => {
    assert.equal(e.name, "AssertionError");
    assert.match(e.message, /serve child did not print its banner within 20ms and is still running/);
    assert.match(e.message, /WALL-CLOCK DEPENDENT \(W1-T2811\)/);
    assert.match(e.message, /\.nvmrc pins a different node/, "the timeout carries the log the child had written");
    assert.doesNotMatch(e.message, /serve exited/);
    return true;
  });
});
