import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { boundFailureLine, defaultGateContainment, defaultRunGate, SANDBOX_FAILURE_TEXT_MAX } from "#src/lib/preopen-gate.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const bwrapLine = "bwrap: Can't bind mount /oldroot/home/node/Remudero/remudero/node_modules on " +
  "/newroot/home/node/Remudero/state/engines/" + "a".repeat(64) +
  "/node_modules: Unable to mount source on destination: No such file or directory";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t10044-`)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [cwd, home, harnessRoot] = ["work", "home", "harness"].map((name) => join(root, name));
  for (const dir of [cwd, home, harnessRoot]) mkdirSync(dir);
  return { root, input: { cwd, home, harnessRoot, env: {} } };
}

async function failureReason(t: { after: (fn: () => void) => void }, line: string) {
  const { root, input } = fixture(t);
  const binary = join(root, "bwrap");
  writeFileSync(binary, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(`\n  ${line}  \nignored later line\n`)});\nprocess.exit(1);\n`, { mode: 0o755 });
  const result = await defaultGateContainment(input, { binary, platform: "linux", parentEnv: {} });
  assert.equal(result.mode, "unavailable");
  if (result.mode !== "unavailable") assert.fail("the failing bwrap must refuse containment");
  const prefix = `${binary} cannot start here (`;
  assert.ok(result.reason.startsWith(prefix));
  assert.ok(result.reason.endsWith(")"));
  return result.reason.slice(prefix.length, -1);
}

test("W1-T10044: a sandbox failure longer than the bound keeps its errno tail", async (t) => {
  assert.equal(bwrapLine.length, 262);
  const reason = await failureReason(t, bwrapLine);
  assert.ok(reason.startsWith("bwrap: Can't bind mount"));
  assert.ok(reason.endsWith("No such file or directory"), reason);
  assert.equal(reason.split("…").length, 2);
  assert.equal(reason.length, 160);
});

test("W1-T10044: a sandbox failure within the bound is kept whole", async (t) => {
  for (const line of ["bwrap: setting up uid map: Permission denied", "x".repeat(159), "y".repeat(160)]) {
    assert.equal(await failureReason(t, line), line);
  }
});

test("W1-T10044: sandbox argv failures keep their errno tail", async (t) => {
  const { input } = fixture(t);
  const missing = join(input.cwd, "missing-" + "x".repeat(180) + "-ENOENT-tail");
  const result = await defaultGateContainment({ ...input, cwd: missing }, { platform: "linux", parentEnv: {} });
  assert.equal(result.mode, "unavailable");
  if (result.mode !== "unavailable") assert.fail("a missing cwd must refuse containment");
  const prefix = "the sandbox argv could not be built: ";
  assert.ok(result.reason.startsWith(prefix + "ENOENT:"), result.reason);
  assert.ok(result.reason.endsWith("ENOENT-tail'"), result.reason);
  assert.ok(result.reason.includes("…"));
  assert.equal(result.reason.length - prefix.length, 160);
});

test("W1-T10044: gate launch failures keep their errno tail", async (t) => {
  const { input } = fixture(t);
  const result = await defaultRunGate(input.cwd, undefined, undefined, {}, {
    harnessRoot: input.harnessRoot,
    contain: () => { throw new Error(bwrapLine); },
    parentEnv: {},
  });
  assert.equal(result.exitCode, null);
  const prefix = "the gate could not start: ";
  const error = result.error;
  assert.ok(error);
  assert.ok(error.startsWith(prefix + "bwrap: Can't bind mount"));
  assert.ok(error.endsWith("No such file or directory"), error);
  assert.ok(error.includes("…"));
  assert.equal(error.length - prefix.length, 160);
});

test("W1-T10044: the named bound is 160 and head and tail share the requested space", () => {
  assert.equal(SANDBOX_FAILURE_TEXT_MAX, 160);
  assert.equal(boundFailureLine(bwrapLine), bwrapLine.slice(0, 80) + "…" + bwrapLine.slice(-79));
  for (const max of [1, 2, 3, 10, 159, 160]) {
    for (const line of ["", "short", " ", "x".repeat(max), bwrapLine]) {
      const bounded = boundFailureLine(line, max);
      assert.equal(bounded.length, Math.min(line.length, max));
      if (line.length <= max) assert.equal(bounded, line);
      else assert.equal(bounded.split("…").length, 2);
    }
  }
});
