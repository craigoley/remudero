import assert from "node:assert/strict";
import fs, { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
// @ts-expect-error The census CLI module has no declarations.
import { runCensusSuitesViaChild } from "#scripts/census-precheck.mjs";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { fixtureRetentionReason, retainFixture } from "#test/setup/retained-fixtures.js";

const PREFIX = "rmd-census-capture-";
const SUITE = "reader.test.mjs";
const TIMEOUT = 10_000;

function withCaptureRoot(t: TestContext, check: (root: string, captures: () => string[]) => void) {
  const { dir } = ownedFixtureDir(t, "census-capture-proof");
  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  writeFileSync(join(dir, SUITE), `
    import { test } from "node:test";
    import { existsSync } from "node:fs";
    test("capture fixture", () => {
      if (existsSync("reject")) throw new Error("fixture rejection");
    });
  `);
  const saved = { TMPDIR: process.env.TMPDIR, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE };
  process.env.TMPDIR = scratch;
  process.env.NODE_V8_COVERAGE = "";
  try {
    check(dir, () => readdirSync(scratch).filter(name => name.startsWith(PREFIX)).map(name => join(scratch, name)));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The fixture is plain JavaScript and needs only the census judge's reporter and marker.
const fixturePreloads = new Set([import.meta.resolve("tsx"), pathToFileURL(join(REPO_ROOT, "test/setup/tmp-hygiene.ts")).href]);
const fixturePriority = {
  wrap(file: string, args: string[]) {
    return { file, args: args.filter((arg, index) =>
      !fixturePreloads.has(arg) && !(arg === "--import" && fixturePreloads.has(args[index + 1]))) };
  },
};
const settings = (root: string) => ({ root, files: [SUITE], history: { mode: "shadow" }, priority: fixturePriority });
const run = (root: string, now?: () => number) => runCensusSuitesViaChild({ ...settings(root), timeoutMs: TIMEOUT, now });
const receipt = (dir: string) => JSON.parse(readFileSync(join(dir, "native.json"), "utf8"));

test("W1-T13191 criterion 1: accepted census child removes its capture", (t) => {
  withCaptureRoot(t, (root, captures) => {
    let ticks = 0;
    assert.deepEqual(run(root, () => {
      if (++ticks === 2) {
        const seen = captures();
        assert.equal(seen.length, 1);
        assert.equal(receipt(seen[0]).outputComplete, true);
        assert.match(readFileSync(join(seen[0], "stdout"), "utf8"), /^# tests 1$/m);
      }
      return ticks;
    }), []);
    assert.deepEqual(captures(), []);
  });
});

test("W1-T13191 criterion 2: stopped and rejected children each retain one capture with its reason", (t) => {
  withCaptureRoot(t, (root, captures) => {
    assert.throws(() => runCensusSuitesViaChild({ ...settings(root), timeoutMs: TIMEOUT,
      priority: { wrap: () => ({ file: process.execPath, args: ["-e", 'process.kill(process.pid, "SIGTERM")'] }) },
    }), /SIGTERM|incomplete census capture/);
    const stopped = captures();
    assert.equal(stopped.length, 1);
    assert.equal(receipt(stopped[0]).outputComplete, false);
    assert.equal(receipt(stopped[0]).signal, "SIGTERM");
    assert.match(fixtureRetentionReason(stopped[0]) ?? "", /capture retained at .*child ended by SIGTERM/);
    writeFileSync(join(root, "reject"), "");
    assert.deepEqual(run(root), [SUITE]);
    const rejected = captures().filter(dir => !stopped.includes(dir));
    assert.equal(rejected.length, 1);
    assert.deepEqual(captures().sort(), [...stopped, ...rejected].sort());
    assert.equal(receipt(rejected[0]).outputComplete, true);
    assert.equal(receipt(rejected[0]).status, 1);
    assert.match(fixtureRetentionReason(rejected[0]) ?? "", /rejected complete census measurement: unsuccessful census result/);
  });

  withCaptureRoot(t, (root, captures) => {
    const times = [0, 100, 101, 102, 202, 203, 303];
    const deadlineTap = `not ok 1 - capture fixture
  ---
  failureType: 'testTimeoutFailure'
  error: 'test timed out after ${TIMEOUT}ms'
  ...
# tests 1
`;
    let wraps = 0;
    // Use a closed Node deadline report for the first qualification. Calibration and retry run the real suite.
    assert.deepEqual(runCensusSuitesViaChild({ ...settings(root),
      now: () => times.shift(),
      readContext: () => "stable fixture",
      readerRuntimePolicy: { floorMs: TIMEOUT, multiple: 1, remeasureMargin: 2 },
      priority: { wrap: (file: string, args: string[]) => ++wraps === 3
        ? { file, args: ["-e", "console.log(process.argv[1]); process.exitCode = 1;", deadlineTap] }
        : fixturePriority.wrap(file, args) },
    }), []);
    assert.equal(wraps, 4);
    const timedOut = captures();
    assert.equal(timedOut.length, 1);
    assert.equal(receipt(timedOut[0]).outputComplete, true);
    assert.match(fixtureRetentionReason(timedOut[0]) ?? "", /Node test reached its admitted per-test deadline/);
  });
});

test("W1-T13191 criterion 3: cleanup preserves retained evidence and other owners' directories", (t) => {
  withCaptureRoot(t, (root, captures) => {
    const foreign = join(root, "scratch", `${PREFIX}foreign`);
    mkdirSync(foreign);
    writeFileSync(join(foreign, "payload"), "independently owned");
    const reason = "keep this capture as evidence";
    let retained = "";
    let ticks = 0;
    assert.deepEqual(run(root, () => {
      if (++ticks === 2) {
        const owned = captures().filter(dir => dir !== foreign);
        assert.equal(owned.length, 1);
        [retained] = owned;
        retainFixture(retained, reason);
      }
      return ticks;
    }), []);
    let unknown = "";
    ticks = 0;
    assert.throws(() => run(root, () => {
      if (++ticks === 2) {
        const owned = captures().filter(dir => dir !== foreign && dir !== retained);
        assert.equal(owned.length, 1);
        [unknown] = owned;
        writeFileSync(join(unknown, "native.json"), "{unreadable receipt");
      }
      return ticks;
    }), /capture custody UNKNOWN/);
    assert.deepEqual(run(root), []);
    assert.deepEqual(captures().sort(), [foreign, retained, unknown].sort());
    assert.equal(fixtureRetentionReason(retained), reason);
    assert.equal(receipt(retained).outputComplete, true);
    assert.match(fixtureRetentionReason(unknown) ?? "", /capture custody UNKNOWN/);
    assert.equal(readFileSync(join(unknown, "native.json"), "utf8"), "{unreadable receipt");
    assert.equal(readFileSync(join(foreign, "payload"), "utf8"), "independently owned");
  });

  withCaptureRoot(t, (root, captures) => {
    let nested = "";
    let ticks = 0;
    assert.throws(() => run(root, () => {
      if (++ticks === 2) {
        const [capture] = captures();
        nested = join(capture, "foreign");
        mkdirSync(nested);
        writeFileSync(join(nested, "payload"), "independently owned");
      }
      return ticks;
    }), /capture custody UNKNOWN.*unexpected entries/);
    const [capture] = captures();
    assert.equal(captures().length, 1);
    assert.match(fixtureRetentionReason(capture) ?? "", /unexpected entries/);
    assert.equal(receipt(capture).outputComplete, true);
    assert.equal(readFileSync(join(nested, "payload"), "utf8"), "independently owned");
  });
});

for (const change of ["replace stderr", "add an entry"] as const) {
  test(`W1-T13191 criterion 3: cleanup refuses to remove a foreign directory that appears after inventory (${change})`, (t) => {
    withCaptureRoot(t, (root, captures) => {
      const scratch = join(root, "scratch");
      let payload: string | undefined;
      const inventory = t.mock.method(fs, "readdirSync", new Proxy(fs.readdirSync, {
        apply(readEntries, receiver, args) {
          const entries = Reflect.apply(readEntries, receiver, args);
          const dir: unknown = args[0];
          if (!payload && typeof dir === "string" && dir.startsWith(join(scratch, PREFIX))) {
            const nested = join(dir, change === "replace stderr" ? "stderr" : "foreign");
            if (change === "replace stderr") unlinkSync(nested);
            mkdirSync(nested);
            payload = join(nested, "payload");
            writeFileSync(payload, "independently owned");
          }
          return entries;
        },
      }));
      syncBuiltinESMExports();
      let error: unknown;
      try {
        run(root);
      } catch (cause) {
        error = cause;
      } finally {
        inventory.mock.restore();
        syncBuiltinESMExports();
      }
      assert.ok(payload, "the capture inventory was read before the foreign directory appeared");
      assert.ok(fs.existsSync(payload), "cleanup must leave the foreign directory and its payload in place");
      assert.equal(readFileSync(payload, "utf8"), "independently owned");
      assert.ok(error instanceof Error);
      assert.match(error.message, /capture custody UNKNOWN/);
      const remaining = captures();
      assert.equal(remaining.length, 1);
      assert.equal(fixtureRetentionReason(remaining[0]), error.message);
    });
  });
}
