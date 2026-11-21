import assert from "node:assert/strict";
import fs, { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
// @ts-expect-error The census CLI module has no declarations.
import { runCensusSuitesViaChild } from "#scripts/census-precheck.mjs";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { fixtureRetentionReason, retainFixture } from "#test/setup/retained-fixtures.js";

const PREFIX = "rmd-census-capture-";
const EVIDENCE = ["stdout", "stderr", "native.json"];
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
const evidence = (dir: string) => EVIDENCE.map(name => readFileSync(join(dir, name)));

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
    assert.deepEqual(readdirSync(join(root, "scratch")), []);
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
      let original: Buffer[] | undefined;
      const inventory = t.mock.method(fs, "readdirSync", new Proxy(fs.readdirSync, {
        apply(readEntries, receiver, args) {
          const entries = Reflect.apply(readEntries, receiver, args);
          const dir: unknown = args[0];
          if (!payload && typeof dir === "string" && dir.startsWith(join(scratch, PREFIX))) {
            original = evidence(dir);
            const nested = join(dir, change === "replace stderr" ? "stderr" : "foreign");
            if (change === "replace stderr") fs.renameSync(nested, join(root, "original-stderr"));
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
      assert.deepEqual(readdirSync(scratch), [basename(remaining[0])]);
      if (change === "add an entry") {
        assert.match(error.message, /ENOTEMPTY.*rmdir/);
        assert.deepEqual(evidence(remaining[0]), original);
      } else {
        assert.deepEqual([
          readFileSync(join(remaining[0], "stdout")),
          readFileSync(join(root, "original-stderr")),
          readFileSync(join(remaining[0], "native.json")),
        ], original);
      }
    });
  });
}

test("W1-T13191 criterion 3: cleanup binds evidence deletion to the owned capture directory", (t) => {
  withCaptureRoot(t, (root, captures) => {
    const foreign = join(root, "foreign-capture");
    const moved = join(root, "moved-capture");
    mkdirSync(foreign);
    for (const name of EVIDENCE) writeFileSync(join(foreign, name), name);
    const foreignEvidence = evidence(foreign);
    let original: Buffer[] | undefined;
    const unlink = t.mock.method(fs, "unlinkSync", new Proxy(unlinkSync, {
      apply(remove, receiver, args) {
        const path = String(args[0]);
        if (!original && (path === "stdout" || path === join(captures()[0] ?? root, "stdout"))) {
          const [capture] = captures();
          original = evidence(capture);
          fs.renameSync(capture, moved);
          fs.symlinkSync(foreign, capture);
        }
        return Reflect.apply(remove, receiver, args);
      },
    }));
    syncBuiltinESMExports();
    try {
      assert.throws(() => run(root), /capture custody UNKNOWN/);
    } finally {
      unlink.mock.restore();
      syncBuiltinESMExports();
    }
    assert.ok(original, "the capture path was rebound immediately before unlink");
    assert.deepEqual(evidence(foreign), foreignEvidence);
    assert.deepEqual(evidence(moved), original);
    assert.match(fixtureRetentionReason(fs.realpathSync(moved)) ?? "", /capture custody UNKNOWN/);
    assert.equal(captures().length, 1);
    assert.ok(fs.lstatSync(captures()[0]).isSymbolicLink());
  });
});

test("W1-T13191 criterion 3: cleanup retains a full backup when an original name is occupied", (t) => {
  withCaptureRoot(t, (root, captures) => {
    const scratch = join(root, "scratch");
    const remove = t.mock.method(fs, "rmdirSync", new Proxy(fs.rmdirSync, {
      apply(rmdir, receiver, args) {
        const path = String(args[0]);
        if (path === captures()[0]) writeFileSync(join(path, "stdout"), "late evidence", { flag: "wx" });
        return Reflect.apply(rmdir, receiver, args);
      },
    }));
    syncBuiltinESMExports();
    let original: Buffer[] | undefined;
    let ticks = 0;
    try {
      assert.throws(() => run(root, () => {
        if (++ticks === 2) original = evidence(captures()[0]);
        return ticks;
      }), /capture custody UNKNOWN.*original capture files retained at/);
    } finally {
      remove.mock.restore();
      syncBuiltinESMExports();
    }
    const [capture] = captures();
    assert.equal(captures().length, 1);
    assert.equal(readFileSync(join(capture, "stdout"), "utf8"), "late evidence");
    assert.deepEqual(evidence(capture).slice(1), original?.slice(1));
    const backups = readdirSync(scratch).map(name => join(scratch, name)).filter(path => path !== capture);
    assert.equal(backups.length, 1);
    assert.match(fixtureRetentionReason(capture) ?? "", /capture custody UNKNOWN/);
    assert.ok(fixtureRetentionReason(backups[0]));
    assert.deepEqual(evidence(backups[0]), original);
  });
});
