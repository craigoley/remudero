/**
 * W1-T6084 — EACH SUITE RECORDS THE NON-CODE FILES IT READS, and census membership plus the modelled
 * full-run triggers come from that record.
 *
 * The first half drives test/setup/read-map.ts: on a fake fs (so the patch is observable without
 * recording this very process) and in a REAL child process that loads the suite preload, so the wiring
 * through tmp-hygiene.ts is the thing under test. The second half drives the selector on small maps.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  buildReadMap,
  fullRunTrigger,
  readMapReaders,
  readReadMap,
  readReadMapInput,
  readReadRecords,
  selectAffectedSuites,
  type AffectedSuitesInput,
  type ReadMap,
  type ReadMapInput,
} from "../src/lib/affected-suites.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  createReadRecorder,
  patchFsForReadMap,
  recordFileName,
  repoRelative,
  suiteOfEntry,
} from "./setup/read-map.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = import.meta.resolve("tsx");
const PRELOAD = join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts");
const ROOT = "/repo";
/** A code file under the fake root — held in a constant: a fake read, not a source-text assertion. */
const CODE_PATH = "/repo/lib/code.ts";

const scratch = () => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}read-map-`));

/** A fake fs whose readFile defines its own promisified shape, as fs.exists does in real node. */
function fakeFs() {
  const custom = async () => ({ custom: true });
  const readFile = Object.assign((_p: unknown, cb: (e: null, v: string) => void) => cb(null, "callback"), {
    [promisify.custom]: custom,
  });
  return {
    custom,
    readFile,
    fs: {
      readFile,
      readFileSync: (_p: unknown) => "sync",
      existsSync: (_p: unknown) => true,
      statSync: (_p: unknown) => ({ stat: true }),
      readdirSync: (_p: unknown, _o?: unknown) => [] as string[],
      readdir: (_p: unknown, _o: unknown, cb: (e: null, v: string[]) => void) => cb(null, []),
      opendir: (_p: unknown, cb: (e: null, v: object) => void) => cb(null, {}),
      promises: {
        readFile: async (_p: unknown) => "promise",
        readdir: async (_p: unknown, _o?: unknown) => [] as string[],
      },
    },
  };
}

test("the read hook keeps util.promisify.custom, name and length on every patched function", async () => {
  const { fs, readFile, custom } = fakeFs();
  const recorder = createReadRecorder(ROOT, "test/x.test.ts");
  const restore = patchFsForReadMap(recorder, fs);
  try {
    assert.notEqual(fs.readFile, readFile, "the entry point is patched");
    assert.equal((fs.readFile as unknown as Record<symbol, unknown>)[promisify.custom], custom);
    assert.equal(fs.readFile.name, readFile.name);
    assert.equal(fs.readFile.length, readFile.length);
    // The promisified shape is the original's, not the callback convention's.
    const promisified = promisify(fs.readFile) as unknown as (p: string) => Promise<unknown>;
    assert.deepEqual(await promisified("/repo/openapi/daemon.yaml"), { custom: true });
    assert.equal(fs.readFileSync("/repo/openapi/daemon.yaml"), "sync");
    assert.equal(await fs.promises.readFile("/repo/deploy/a.yaml"), "promise");
  } finally {
    restore();
  }
  assert.equal(fs.readFile, readFile, "restore puts the original back");
});

test("the read hook records repo-relative NON-CODE reads and the directories a suite listed", () => {
  const { fs } = fakeFs();
  const recorder = createReadRecorder(ROOT, "test/x.test.ts");
  const restore = patchFsForReadMap(recorder, fs);
  try {
    fs.readFileSync("/repo/openapi/daemon.yaml");
    fs.existsSync("/repo/package.json");
    fs.statSync("/repo/deploy/unit.service");
    fs.readFileSync(CODE_PATH); // code: the import graph's, never this map's
    fs.readFileSync("/etc/hosts"); // outside the repo
    fs.readFileSync("/repo/node_modules/x/package.json");
    fs.readFileSync(3 as unknown as string); // a file descriptor
    fs.readdirSync("/repo/plan/tasks.d");
    fs.readdirSync("/repo/src", { recursive: true });
    void fs.promises.readdir("/repo/test");
    fs.readdir("/repo/docs", {}, () => undefined);
  } finally {
    restore();
  }
  assert.deepEqual(recorder.snapshot(), {
    format: "rmd-read-record-v1",
    suite: "test/x.test.ts",
    reads: ["deploy/unit.service", "openapi/daemon.yaml", "package.json"],
    listed: ["docs", "plan/tasks.d", "src/**", "test"],
  });
});

test("paths resolve against the root, and only a test suite entry file records", () => {
  assert.equal(repoRelative("openapi/a.yaml", ROOT, ROOT), "openapi/a.yaml");
  assert.equal(repoRelative(new URL("file:///repo/deploy/a.yaml"), ROOT), "deploy/a.yaml");
  assert.equal(repoRelative(Buffer.from("/repo/plan"), ROOT), "plan");
  assert.equal(repoRelative("/repo", ROOT), ".");
  assert.equal(repoRelative("../outside", ROOT, ROOT), undefined);
  assert.equal(repoRelative(new URL("https://example.test/a"), ROOT), undefined);
  assert.equal(suiteOfEntry("/repo/test/a.test.ts", ROOT), "test/a.test.ts");
  assert.equal(suiteOfEntry("/repo/scripts/run.mjs", ROOT), undefined);
  assert.equal(suiteOfEntry(undefined, ROOT), undefined);
  assert.equal(recordFileName("test/a/b.test.ts"), "test__a__b.test.ts.json");
});

test("a test file run under the suite preload writes its record, and an unset directory records nothing", () => {
  const repo = scratch();
  const records = join(repo, "records");
  try {
    mkdirSync(join(repo, "test"), { recursive: true });
    mkdirSync(join(repo, "openapi"));
    mkdirSync(join(repo, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(repo, "openapi", "daemon.yaml"), "openapi: 3\n");
    writeFileSync(join(repo, "helper.ts"), "export const h = 1;\n");
    writeFileSync(
      join(repo, "test", "fx.test.ts"),
      [
        'import { promisify } from "node:util";',
        'import fs, { readFileSync, readdirSync } from "node:fs";',
        'readFileSync("openapi/daemon.yaml", "utf8");',
        'readFileSync("helper.ts", "utf8");',
        'readdirSync("plan/tasks.d");',
        'promisify(fs.readFile)("openapi/daemon.yaml").then(() => undefined);',
        "",
      ].join("\n"),
    );
    const run = (env: Record<string, string>) => {
      const clean = { ...process.env };
      delete clean.NODE_TEST_CONTEXT;
      // Blank, never delete: node re-injects a deleted NODE_V8_COVERAGE into the child.
      clean.NODE_V8_COVERAGE = undefined;
      delete clean.RMD_READ_MAP_DIR;
      return spawnSync(process.execPath, ["--import", TSX, "--import", PRELOAD, "test/fx.test.ts"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...clean, ...env, RMD_READ_MAP_ROOT: repo },
      });
    };
    const off = run({});
    assert.equal(off.status, 0, off.stderr);
    assert.throws(() => readdirOf(records), /ENOENT/, "unset RMD_READ_MAP_DIR writes nothing");

    const on = run({ RMD_READ_MAP_DIR: records });
    assert.equal(on.status, 0, on.stderr);
    const record = JSON.parse(readFileSync(join(records, recordFileName("test/fx.test.ts")), "utf8")) as Record<string, unknown>;
    // Node's own module-type lookup reads package.json through the public fs too: observed, so kept.
    assert.deepEqual((record.reads as string[]).filter((p) => !p.endsWith("package.json")), ["openapi/daemon.yaml"]);
    assert.deepEqual(record.listed, ["plan/tasks.d"]);
    assert.equal(record.suite, "test/fx.test.ts");

    // A second pass (the retry) unions rather than replaces.
    const again = run({ RMD_READ_MAP_DIR: records });
    assert.equal(again.status, 0, again.stderr);
    const merged = readReadRecords(records);
    assert.deepEqual(merged.problems, []);
    assert.equal(merged.records.length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function readdirOf(dir: string): string[] {
  return readReadRecords(dir).records.map((r) => r.suite);
}

// ── the merged map and the selector ───────────────────────────────────────────────────────────────

const SUITES = ["test/a-reads-openapi.test.ts", "test/b-lists-openapi.test.ts", "test/c-reads-other.test.ts", "test/d-census.test.ts"];

function map(): ReadMap {
  return buildReadMap(
    [
      { suite: SUITES[0]!, reads: ["openapi/daemon.yaml"], listed: [] },
      { suite: SUITES[1]!, reads: [], listed: ["openapi"] },
      { suite: SUITES[2]!, reads: ["deploy/unit.service", "package.json"], listed: [] },
      { suite: SUITES[3]!, reads: [], listed: ["src/**"] },
    ],
    { sha: "a".repeat(40) },
  );
}

const usable = (m: ReadMap = map()): ReadMapInput => ({ map: m, drift: { distance: 3, changedSinceMap: [] } });

function input(readMap?: ReadMapInput, extra: Partial<AffectedSuitesInput> = {}): AffectedSuitesInput {
  const files = new Map<string, string>(SUITES.map((s) => [s, "export {};\n"]));
  files.set("src/lib/x.ts", "export const x = 1;\n");
  return { files, pathReaders: [], ...(readMap ? { readMap } : {}), ...extra };
}

test("buildReadMap merges per-suite records and readMapReaders answers reads and listings", () => {
  const m = map();
  assert.deepEqual(m.suites, [...SUITES].sort());
  assert.deepEqual(readMapReaders(m, "openapi/daemon.yaml"), {
    readers: [SUITES[0]],
    listers: [{ suite: SUITES[1], dir: "openapi" }],
  });
  // A recursive listing of src reaches every file below it, however deep.
  assert.deepEqual(readMapReaders(m, "src/lib/deep/x.ts").listers, [{ suite: SUITES[3], dir: "src/**" }]);
  assert.deepEqual(readMapReaders(m, "docs/none.md"), { readers: [], listers: [] });
});

test("a change to openapi/daemon.yaml selects the suites the read map says read or listed it, not the full suite", () => {
  const selection = selectAffectedSuites(["openapi/daemon.yaml"], input(usable()));
  assert.equal(selection.fullRun, false);
  assert.deepEqual(selection.suites, [SUITES[0], SUITES[1]]);
  assert.match(selection.reasons.join("\n"), /read openapi\/daemon\.yaml \(read map\)/);
  assert.match(selection.reasons.join("\n"), /listed openapi \(read map: a census reader of openapi\/daemon\.yaml\)/);
  assert.equal(selection.readMapFallback, undefined);
});

test("deploy/ and json changes are read-mapped too, and a file nobody reads selects nothing and says so", () => {
  const deploy = selectAffectedSuites(["deploy/unit.service"], input(usable()));
  assert.deepEqual(deploy.suites, [SUITES[2]]);
  const json = selectAffectedSuites(["package.json"], input(usable()));
  assert.deepEqual(json.suites, [SUITES[2]]);
  const nobody = selectAffectedSuites(["deploy/orphan.yaml"], input(usable()));
  assert.equal(nobody.fullRun, false);
  assert.deepEqual(nobody.suites, []);
  assert.deepEqual(nobody.reasons, ["deploy/orphan.yaml: read by no suite on the read map"]);
});

test("what the record cannot see is still selected: a spawner naming the file, an unseen suite, an edited suite", () => {
  const files = new Map<string, string>(SUITES.map((s) => [s, "export {};\n"]));
  files.set("test/e-spawns.test.ts", 'import { spawnSync } from "node:child_process";\nspawnSync("node", ["scripts/x.mjs", "openapi/daemon.yaml"]);\n');
  files.set("test/f-spawns-elsewhere.test.ts", 'import { spawnSync } from "node:child_process";\nspawnSync("git", ["status"]);\n');
  files.set("test/g-new.test.ts", "export {};\n");
  const seen = buildReadMap(
    [...SUITES, "test/e-spawns.test.ts", "test/f-spawns-elsewhere.test.ts"].map((suite) => ({
      suite, reads: suite === SUITES[0] ? ["openapi/daemon.yaml"] : [], listed: [],
    })),
    { sha: "b".repeat(40) },
  );
  const selection = selectAffectedSuites(
    ["openapi/daemon.yaml"],
    { files, pathReaders: [], readMap: { map: seen, drift: { distance: 2, changedSinceMap: [SUITES[2]!] } } },
  );
  assert.deepEqual(selection.suites, [SUITES[0], SUITES[2], "test/e-spawns.test.ts", "test/g-new.test.ts"].sort());
  assert.ok(!selection.suites.includes("test/f-spawns-elsewhere.test.ts"));
});

test("without a usable read map a non-code change falls back to the full run and names why", () => {
  const none = selectAffectedSuites(["deploy/unit.service"], input());
  assert.equal(none.fullRun, true);
  assert.match(none.reasons[0]!, /deploy\/unit\.service is outside what the selector models \(the read map cannot speak for it: no read map supplied\)/);
  assert.equal(none.readMapFallback, "no read map supplied");

  const stale = selectAffectedSuites(["deploy/unit.service"], input({ map: map(), drift: { distance: 900, changedSinceMap: [] } }));
  assert.equal(stale.fullRun, true);
  assert.match(stale.readMapFallback!, /stale: 900 commits behind the base, past its bound of 150/);

  const foreign = selectAffectedSuites(["package.json"], input({ map: map(), drift: { changedSinceMap: [], problem: "no ancestry" } }));
  assert.equal(foreign.fullRun, true);
  assert.match(foreign.readMapFallback!, /not an ancestor of the base \(no ancestry\)/);

  const missing = selectAffectedSuites(["package.json"], input({ mapProblem: "file not found", drift: { changedSinceMap: [] } }));
  assert.equal(missing.fullRun, true);
  assert.match(missing.readMapFallback!, /no read map \(file not found\)/);
});

test("paths the map does not observe keep the full run with their reason, map or no map", () => {
  const selection = selectAffectedSuites([".github/workflows/ci.yml", "openapi/daemon.yaml"], input(usable()));
  assert.equal(selection.fullRun, true);
  assert.match(selection.reasons[0]!, /\.github\/workflows\/ci\.yml is outside what the selector models$/);
  assert.equal(fullRunTrigger(["openapi/daemon.yaml"]), undefined);
  assert.equal(fullRunTrigger(["openapi/daemon.yaml"], true), undefined);
  assert.equal(fullRunTrigger(["deploy/unit.service"]), "deploy/unit.service");
  assert.equal(fullRunTrigger(["deploy/unit.service"], true), undefined);
  assert.equal(fullRunTrigger(["openapi/other.yaml"]), "openapi/other.yaml");
  assert.equal(fullRunTrigger(["openapi/other.yaml"], true), "openapi/other.yaml");
  assert.equal(fullRunTrigger([".github/workflows/ci.yml"], true), ".github/workflows/ci.yml");
  assert.equal(fullRunTrigger(["test/helpers/x.ts"], true), "test/helpers/x.ts");
});

test("census membership for a src change is the suites that listed its directory; a missing map falls back and says so", () => {
  const withMap = selectAffectedSuites(["src/lib/x.ts"], input(usable()));
  assert.equal(withMap.fullRun, false);
  assert.ok(withMap.suites.includes(SUITES[3]!), "the suite that listed src/ recursively is a census reader");
  assert.match(withMap.reasons.join("\n"), /test\/d-census\.test\.ts: listed src\/\*\* \(read map: a census reader of src\/lib\/x\.ts\)/);

  // No map asked for: today's rules, unchanged and silent.
  const absent = selectAffectedSuites(["src/lib/x.ts"], input());
  assert.ok(!absent.suites.includes(SUITES[3]!));
  assert.equal(absent.readMapFallback, undefined);

  // A map asked for and unusable: today's rules, with the reason.
  const unusable = selectAffectedSuites(["src/lib/x.ts"], input({ mapProblem: "expired", drift: { changedSinceMap: [] } }));
  assert.ok(!unusable.suites.includes(SUITES[3]!));
  assert.equal(unusable.readMapFallback, "no read map (expired)");
});

test("a read map file round-trips, and a malformed one is a named problem, never an empty map", () => {
  const dir = scratch();
  try {
    const path = join(dir, "read-map.json");
    writeFileSync(path, JSON.stringify(map()));
    assert.deepEqual(readReadMap(path).map, map());
    writeFileSync(path, "{}");
    assert.match(readReadMap(path).problem!, /is not a rmd-read-map-v1 file/);
    assert.match(readReadMap(join(dir, "missing.json")).problem!, /unreadable/);
    writeFileSync(join(dir, "stray.json"), JSON.stringify({ format: "other" }));
    assert.deepEqual(readReadRecords(dir).problems, ["read-map.json is not a read record", "stray.json is not a read record"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readReadMapInput loads a saved map and measures its drift against the requested base", () => {
  const dir = scratch();
  try {
    const path = join(dir, "read-map.json");
    const saved = map();
    writeFileSync(path, JSON.stringify(saved));
    const calls: string[][] = [];
    const loaded = readReadMapInput(dir, path, "base-tip", (cmd, args, opts) => {
      assert.equal(cmd, "git");
      assert.deepEqual(opts, { cwd: dir, encoding: "utf8" });
      calls.push(args);
      return { status: 0, stdout: args[0] === "rev-list" ? "3\n" : args[0] === "diff" ? `${SUITES[2]}\n` : "", stderr: "" };
    });
    assert.deepEqual(calls, [
      ["merge-base", "--is-ancestor", saved.sha, "base-tip"],
      ["rev-list", "--count", `${saved.sha}..base-tip`],
      ["diff", "--name-only", saved.sha, "base-tip"],
    ]);
    assert.deepEqual(loaded, { map: saved, drift: { distance: 3, changedSinceMap: [SUITES[2]] } });
    const selection = selectAffectedSuites(["openapi/daemon.yaml"], input(loaded));
    assert.equal(selection.fullRun, false);
    assert.deepEqual(selection.suites, [SUITES[0], SUITES[1], SUITES[2]]);

    const foreign = readReadMapInput(dir, path, "other-tip", () => ({ status: 1, stdout: "", stderr: "" }));
    assert.deepEqual(foreign, {
      map: saved,
      drift: { changedSinceMap: [], problem: `other-tip does not descend from ${saved.sha}` },
    });
    const fallback = selectAffectedSuites(["deploy/unit.service"], input(foreign));
    assert.equal(fallback.fullRun, true);
    assert.match(fallback.readMapFallback!, /not an ancestor of the base \(other-tip does not descend from/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readReadMapInput preserves missing and malformed map problems without measuring drift", () => {
  const dir = scratch();
  try {
    const path = join(dir, "read-map.json");
    const run = () => assert.fail("an unavailable map must not trigger a drift query");
    const missing = readReadMapInput(dir, path, "base-tip", run);
    assert.deepEqual(missing.drift, { changedSinceMap: [] });
    assert.equal(missing.map, undefined);
    assert.match(missing.mapProblem!, /unreadable: .*ENOENT/);

    writeFileSync(path, "{}");
    const malformed = readReadMapInput(dir, path, "base-tip", run);
    assert.deepEqual(malformed, {
      mapProblem: `read map ${path} is not a rmd-read-map-v1 file`,
      drift: { changedSinceMap: [] },
    });
    for (const loaded of [missing, malformed]) {
      const selection = selectAffectedSuites(["deploy/unit.service"], input(loaded));
      assert.equal(selection.fullRun, true);
      assert.equal(selection.readMapFallback, `no read map (${loaded.mapProblem})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
