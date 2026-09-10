/**
 * W1-T3303 — a local full-suite run is hard-bounded and contained.
 *
 * The timeout case deliberately uses real processes. A fake `{ status: 124 }` cannot establish
 * that SIGKILL reaches a child that ignores SIGTERM, and cannot establish that its grandchild is
 * gone rather than reparented to PID 1. Each fixture self-bounds at 20s, so a containment failure
 * is noisy but never turns this test into the unbounded local gate it guards.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { boundedSuiteLeaf, runBoundedSuite } from "../src/lib/ci-parity.js";
import { defaultPreflightSpawn } from "../src/lib/commit-message.js";
import { killProcessGroup } from "../src/lib/worker-containment.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const SPIN_MS = 20_000;
const BOUND_MS = 700;

/** Generous on purpose: these two suites exit immediately, so if either ever reaches this
 *  ceiling the run is wedged and the timeout verdict — which both tests assert is ABSENT — is
 *  the correct, loud answer. */
const AMPLE_BOUND_MS = 60_000;
const HEALTHY_LABEL = "ci:test (test/healthy-leaf.test.ts)";
const FAILING_LABEL = "ci:test (test/failing-leaf.test.ts)";

function blockFor(ms: number): string {
  return `const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ${ms});`;
}

/** Make the actual two-level process tree from the incident: suite runner -> child -> grandchild.
 * Both executable nodes install SIGTERM handlers then block their main threads, so SIGTERM is
 * provably ineffective while SIGKILL must remove the entire detached process group. */
function writeWedgedSuiteFixture(): { dir: string; parentPidPath: string; grandchildPidPath: string; parentScript: string } {
  const dir = makeTempDir("w1-t3303-");
  const parentPidPath = join(dir, "parent.pid");
  const grandchildPidPath = join(dir, "grandchild.pid");
  const grandchildScript = join(dir, "grandchild.cjs");
  const parentScript = join(dir, "parent.cjs");
  writeFileSync(
    grandchildScript,
    [
      'const { writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));`,
      'process.on("SIGTERM", () => {});',
      blockFor(SPIN_MS),
    ].join("\n"),
  );
  writeFileSync(
    parentScript,
    [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));`,
      `spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: "ignore" });`,
      'process.on("SIGTERM", () => {});',
      'process.stdout.write("CURRENT_SUITE: test/wedged-suite.test.ts\\n");',
      blockFor(SPIN_MS),
    ].join("\n"),
  );
  return { dir, parentPidPath, grandchildPidPath, parentScript };
}

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`pid ${pid} survived the timeout's group teardown`);
}

function readPid(path: string): number {
  assert.ok(existsSync(path), `fixture never wrote ${path}`);
  const pid = Number(readFileSync(path, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0, `fixture wrote a valid pid to ${path}`);
  return pid;
}

test("W1-T3303: a SIGTERM-ignoring suite and its grandchild die at the hard wall-clock ceiling", async () => {
  const fixture = writeWedgedSuiteFixture();
  let parentPid: number | undefined;
  try {
    const startedAt = Date.now();
    const leaf = boundedSuiteLeaf(
      defaultPreflightSpawn,
      "ci:test (test/wedged-suite.test.ts)",
      process.execPath,
      [fixture.parentScript],
      { cwd: fixture.dir, stream: true },
      BOUND_MS,
    );
    const elapsedMs = Date.now() - startedAt;
    parentPid = readPid(fixture.parentPidPath);
    const grandchildPid = readPid(fixture.grandchildPidPath);

    assert.equal(leaf.ok, false, "a timeout is a failed, unverified suite—not a green result");
    assert.match(leaf.detail, /ci:test \(test\/wedged-suite\.test\.ts\)/, "the result must name the suite that hung");
    assert.match(leaf.detail, /SIGKILL/, "the timeout must name the untrappable signal it used");
    assert.match(leaf.detail, /UNVERIFIED/, "a killed suite has no complete failure set");
    assert.match(leaf.detail, /CURRENT_SUITE: test\/wedged-suite\.test\.ts/, "the last emitted suite progress must survive in the verdict");
    assertWallClockBound(elapsedMs, SPIN_MS / 2, `the bounded suite returned in ${elapsedMs}ms, not after its ${SPIN_MS}ms fixture self-ceiling`);

    await waitUntilDead(parentPid);
    await waitUntilDead(grandchildPid);
  } finally {
    if (parentPid) killProcessGroup(parentPid);
  }
});

test("W1-T3303: a healthy suite preserves its exact exit status and stdout without a timeout verdict", () => {
  const output = "healthy-suite-output\\n";
  const result = runBoundedSuite(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)})`], {
    label: "ci:test (test/healthy-suite.test.ts)",
    timeoutMs: 5_000,
  });
  assert.equal(result.status, 0, "the supervisor must preserve a healthy suite's own exit code");
  assert.equal(result.stdout, output, "the supervisor must preserve a healthy suite's stdout byte-for-byte");
  assert.equal(result.timeout, undefined, "an in-bound suite must not be labelled as timed out");
});

test("W1-T3303: a suite that finishes in-bound passes through the leaf, not only through the supervisor", () => {
  const leaf = boundedSuiteLeaf(
    defaultPreflightSpawn,
    HEALTHY_LABEL,
    process.execPath,
    ["-e", "process.stdout.write('healthy-leaf-ran')"],
    {},
    AMPLE_BOUND_MS,
  );
  assert.equal(leaf.ok, true, "a suite that exited 0 inside its ceiling is a pass");
  assert.equal(leaf.detail, `PASS \u2014 ${HEALTHY_LABEL}`, "a passing leaf names its suite and says nothing else");
  assert.doesNotMatch(
    leaf.detail,
    /UNVERIFIED|SIGKILL/,
    "a suite that finished on its own carries none of the timeout verdict's language; that text is what tells a reader the failure set is incomplete",
  );
});

test("W1-T3303: a suite that fails on its own merits keeps its output and is not called a timeout", () => {
  const leaf = boundedSuiteLeaf(
    defaultPreflightSpawn,
    FAILING_LABEL,
    process.execPath,
    ["-e", "process.stdout.write('failing-leaf-marker'); process.exit(3);"],
    {},
    AMPLE_BOUND_MS,
  );
  assert.equal(leaf.ok, false, "a nonzero exit is a failed suite");
  assert.match(leaf.detail, /^FAIL \u2014 /, "a failing leaf leads with the verdict");
  assert.match(leaf.detail, new RegExp(FAILING_LABEL.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)), "the verdict must name the suite that failed");
  assert.match(
    leaf.detail,
    /failing-leaf-marker/,
    "a failing suite's own output is the whole diagnostic value; a bare FAIL line strands the reader",
  );
  assert.doesNotMatch(
    leaf.detail,
    /UNVERIFIED/,
    "a suite that ran to completion has a COMPLETE failure set — labelling it unverified sends the reader hunting a hang that never happened",
  );
});
