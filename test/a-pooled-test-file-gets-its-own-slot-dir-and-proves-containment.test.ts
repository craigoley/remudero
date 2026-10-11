import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceUrl = (path: string): string => JSON.stringify(pathToFileURL(join(root, path)).href);
const setup = join(root, "test/setup/tmp-hygiene.ts");

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.RMD_TEST_SLOT_DIR;
  delete env.RMD_TEST_SLOT_PARENT;
  delete env.RMD_ALLOW_LIVE_WRITES;
  env.NODE_V8_COVERAGE = undefined;
  return env;
}

function run(files: string[], env: NodeJS.ProcessEnv, pooled = true, preload = setup) {
  return spawnSync(process.execPath, [
    "--test", "--test-concurrency=1", "--import", "tsx", "--import", preload, "--test-reporter=tap",
    ...(pooled ? ["--experimental-test-isolation=none"] : []), ...files,
  ], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
}

function slotFixtures(dir: string, shared: boolean): string[] {
  const imports = `
    import assert from "node:assert/strict";
    import { test, describe } from "node:test";
    import { readFileSync, writeFileSync } from "node:fs";
    import { resolveTestSlotDir } from ${sourceUrl("src/lib/test-slot.ts")};
    import { publishReviewDemand, readReviewDemand } from ${sourceUrl("src/lib/host-memory-priority.ts")};
    import { openMemoryReservation, readMemoryLedger } from ${sourceUrl("src/lib/host-memory-ledger.ts")};
  `;
  const observation = JSON.stringify(join(dir, "a.json"));
  const a = join(dir, "a.test.mjs");
  const b = join(dir, "b.test.mjs");
  writeFileSync(a, `${imports}
    test("file a writes default state", () => {
      const slot = resolveTestSlotDir();
      const row = publishReviewDemand({ eligible: 1, laneReady: 1, oldestEligibleSince: null });
      assert.ok(row);
      const reservation = openMemoryReservation({ workerClass: "implement" });
      assert.ok(reservation.id);
      assert.equal(readReviewDemand().rows.length, 1);
      assert.equal(readMemoryLedger().entries.length, 1);
      writeFileSync(${observation}, JSON.stringify({ dir: slot.dir, pid: process.pid }));
    });
    describe("file a nested suite", () => {
      test("same file retains its slot state", () => {
        assert.equal(resolveTestSlotDir().dir, JSON.parse(readFileSync(${observation}, "utf8")).dir);
        assert.equal(readReviewDemand().rows.length, 1);
        assert.equal(readMemoryLedger().entries.length, 1);
      });
    });
  `);
  writeFileSync(b, `${imports}
    test("file b reads default state", () => {
      const a = JSON.parse(readFileSync(${observation}, "utf8"));
      const slot = resolveTestSlotDir();
      assert.equal(process.pid ${shared ? "===" : "!=="} a.pid, true, "real process isolation matches the run");
      assert.equal(slot.scope, process.env.RMD_TEST_SLOT_DIR ? "configured" : "test-process");
      assert.equal(readReviewDemand().rows.length, process.env.RMD_TEST_SLOT_DIR ? 1 : 0, "file b sees only its own demand");
      assert.equal(slot.dir === a.dir, Boolean(process.env.RMD_TEST_SLOT_DIR), "only configured storage is shared");
      const ledger = readMemoryLedger();
      assert.ok(ledger);
      assert.equal(ledger.entries.length, process.env.RMD_TEST_SLOT_DIR ? 1 : 0);
    });
  `);
  return [a, b];
}

test("W1-T8047: two pooled files do not share slot-dir state", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-pool-8047-"));
  try {
    const result = run(slotFixtures(dir, true), childEnv());
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 3/);
    assert.match(result.stdout, /# fail 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T8047: a pooled process without containment fails naming what is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-pool-containment-8047-"));
  try {
    const fixture = join(dir, "contained.test.mjs");
    const marker = join(dir, "ran");
    writeFileSync(fixture, `
      import { test } from "node:test";
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "test file loaded");
      test("must never run without containment", () => {});
    `);
    const cases: Array<[string, string[]]> = [
      ['delete process.env.GH_TOKEN;', ["GH_TOKEN"]],
      ['process.env.GH_TOKEN = "wrong-sentinel";', ["GH_TOKEN"]],
      ['delete process.env.GH_CONFIG_DIR;', ["GH_CONFIG_DIR"]],
      ['process.env.GH_CONFIG_DIR = ' + JSON.stringify(dir) + ';', ["GH_CONFIG_DIR"]],
      ['process.env.GH_CONFIG_DIR += "-missing";', ["GH_CONFIG_DIR"]],
      ['process.env.GIT_CONFIG_COUNT = "0";', ["dead push URL config"]],
      ...["https://github.com/", "git@github.com:", "ssh://git@github.com/"].map((prefix): [string, string[]] => [
        `for (let i = 0; i < Number(process.env.GIT_CONFIG_COUNT); i++) {
          if (process.env[\`GIT_CONFIG_VALUE_\${i}\`] === ${JSON.stringify(prefix)}) delete process.env[\`GIT_CONFIG_KEY_\${i}\`];
        }`, ["dead push URL config"],
      ]),
      ['delete process.env.GH_TOKEN; delete process.env.GH_CONFIG_DIR; process.env.GIT_CONFIG_COUNT = "0";',
        ["GH_TOKEN", "GH_CONFIG_DIR", "dead push URL config"]],
    ];
    for (const [withhold, missing] of cases) {
      const preload = join(dir, "withhold.mjs");
      writeFileSync(preload, `
        import ${sourceUrl("test/setup/no-live-remote.ts")};
        ${withhold}
        await import(${sourceUrl("test/setup/tmp-hygiene.ts")});
      `);
      const result = run([fixture], childEnv(), true, preload);
      assert.equal(result.error, undefined, String(result.error));
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      const output = result.stdout + result.stderr;
      const refusal = /Error: pooled test containment missing: ([^\r\n]+)/.exec(output);
      assert.ok(refusal, output);
      for (const piece of missing) assert.ok(refusal[1].includes(piece), output);
      assert.throws(() => readFileSync(marker), { code: "ENOENT" }, "containment fails before loading tests");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T8047: isolated files and configured slot directories retain their behavior", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-pool-preserved-8047-"));
  try {
    const isolated = run(slotFixtures(dir, false), childEnv(), false);
    assert.equal(isolated.status, 0, isolated.stdout + isolated.stderr);
    const configured = run(slotFixtures(dir, true), { ...childEnv(), RMD_TEST_SLOT_DIR: join(dir, "slots") });
    assert.equal(configured.status, 0, configured.stdout + configured.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
