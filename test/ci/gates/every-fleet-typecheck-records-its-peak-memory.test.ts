import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { typecheckStep } from "#src/lib/commit-message.js";
import type { Config } from "#src/lib/config.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { mergedHeadTypechecks } from "#src/lib/merge-probe.js";
import { installSpawnHelper } from "#src/lib/spawn-helper.js";
import {
  measuredTypecheckArgs, readTypecheckRss, recordTypecheckPeak, takeTypecheckObservation, TYPECHECK_BUILDINFO_NAME,
} from "#src/lib/typecheck-buildinfo.js";
import { runTypecheck } from "#src/lib/typecheck-run.js";
import { readRelayedTypecheckPeaks, runOpenWeightCheck, spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function project(t: TestContext) {
  const repo = gitRepo({ kind: "typecheck-peak" });
  t.after(() => repo.cleanup());
  const slots = join(repo.dir, "slots");
  mkdirSync(slots);
  const keys = ["RMD_TEST_SLOT_DIR", "RMD_TEST_SLOTS", "RMD_TEST_SLOT_PARENT"];
  const saved = keys.map(key => process.env[key]);
  process.env.RMD_TEST_SLOT_DIR = slots;
  process.env.RMD_TEST_SLOTS = "1";
  delete process.env.RMD_TEST_SLOT_PARENT;
  t.after(() => {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(repo.dir, "node_modules"));
  writeFileSync(join(repo.dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { types: [], noEmit: true }, include: ["*.ts"],
  }));
  writeFileSync(join(repo.dir, "a.ts"), "export const a = 1;\n");
  repo.git("add", "tsconfig.json", "a.ts");
  repo.git("commit", "-qm", "base");
  return repo;
}

function peaks(root: string): Record<string, unknown>[] {
  const path = ledgerPathFor({ root });
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(row => row.step === "typecheck.peak");
}

const slot = { memoryHeadroom: () => undefined, log: () => {} };

test("W1-T14143 criterion 1 — npm and preflight record each completed compiler, including cold and warm runs", (t) => {
  const repo = project(t);
  assert.equal(runTypecheck(repo.dir, [], { testSlot: slot, log: () => {} }), 0);
  writeFileSync(join(repo.dir, "a.ts"), 'export const a: number = "bad";\n');
  const red = typecheckStep(repo.dir, undefined, slot);
  assert.equal(red.ok, false);
  assert.match(red.detail, /TS2322/);
  const rows = peaks(repo.dir);
  assert.deepEqual(rows.map(row => [row.entry, row.warm]), [["npm", false], ["preflight", true]]);
  for (const row of rows) {
    assert.equal(row.task_id, "CLI");
    if (process.platform === "linux") assert.ok(typeof row.peak_rss_bytes === "number" && row.peak_rss_bytes > 0);
    else assert.equal(row.peak_rss_bytes, "unknown");
    assert.equal(row.rechecked_files, undefined, "the installed tsc does not report a rechecked-file count");
  }
});

test("W1-T14143 criterion 1 — merge-probe records after its compiler child closes", async (t) => {
  const repo = project(t);
  const lane = repo.addWorktree(join(repo.dir, "lane"), "lane", "main");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(lane.dir, "node_modules"));
  writeFileSync(join(lane.dir, "b.ts"), "export const b = 2;\n");
  lane.git("add", "b.ts");
  lane.git("commit", "-qm", "lane");
  writeFileSync(join(repo.dir, "c.ts"), "export const c = 3;\n");
  repo.git("add", "c.ts");
  repo.git("commit", "-qm", "main");
  const result = await mergedHeadTypechecks(lane.dir, {
    mainRef: "main", testSlot: slot,
    spawn: (file, args, options) => {
      assert.deepEqual(peaks(repo.dir), []);
      return spawn(file, args, options);
    },
  });
  assert.equal(result.outcome, "passes", JSON.stringify(result));
  const rows = peaks(repo.dir);
  assert.deepEqual(rows.map(row => [row.entry, row.warm]), [["merge-probe", false]]);
  assert.equal(rows[0]?.task_id, "CLI");
  if (process.platform === "linux") assert.ok(typeof rows[0]?.peak_rss_bytes === "number" && rows[0].peak_rss_bytes > 0);
});

test("W1-T14143 criterion 1 — bwrap's tool loop records both successful and failed compiler calls", async (t) => {
  const { dir } = project(t);
  const workerHome = join(dir, "home");
  mkdirSync(workerHome);
  let turn = 0;
  let calls = 0;
  installSpawnHelper({
    pid: undefined, unhealthy: () => undefined, noteDirect: () => {}, stop: () => {},
    run: async request => {
      assert.equal(peaks(dir).length, calls++);
      assert.equal(request.file, process.execPath);
      assert.ok(request.args?.includes("bwrap"));
      assert.ok(request.args?.includes("--unshare-net"));
      const result = { exitCode: 0, signal: null, stdout: "Files: 83\nFiles rechecked: 4\n",
        stderr: '\nrmd-typecheck-observation:{"peak":123456}\n', via: "helper" as const, sync_ms: 0 };
      if (calls === 2) return { ...result, exitCode: 2, stdout: "Files rechecked: 0\n", stderr: "compiler red\n" };
      writeFileSync(join(workerHome, TYPECHECK_BUILDINFO_NAME), JSON.stringify({
        version: JSON.parse(readFileSync(join(dir, "node_modules/typescript/package.json"), "utf8")).version,
        fileNames: ["a.ts"], fileInfos: ["hash"],
      }));
      return result;
    },
  });
  t.after(() => installSpawnHelper(undefined));
  await spawnOpenWeightWorker({
    cwd: dir, workerHome, prompt: "typecheck twice", tools: ["RunCheck"], maxTurns: 4,
    env: { RMD_OPENWEIGHT_API_KEY: "fixture" },
    runCheck: input => runOpenWeightCheck({ ...input, platform: "linux" }),
    fetchImpl: async () => {
      turn += 1;
      const message = turn <= 2
        ? { tool_calls: [{ id: `c${turn}`, type: "function", function: { name: "run_check", arguments: '{"check":"typecheck"}' } }] }
        : { content: "done" };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    },
  }, { root: dir, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } } as Config,
  { model: "gpt-oss-120b", effort: "low" });
  assert.deepEqual(peaks(dir).map(row => [row.task_id, row.entry, row.warm, row.peak_rss_bytes, row.rechecked_files]), [
    ["HARNESS", "bwrap", false, 123456, 4], ["HARNESS", "bwrap", true, "unknown", 0],
  ]);
});

test("W1-T14143 criterion 2 — a check with no readable peak records unknown and returns its own status", (t) => {
  const { dir } = project(t);
  assert.equal(runTypecheck(dir, [], { testSlot: slot, log: () => {}, spawn: () => ({ status: 3 }) }), 3);
  assert.deepEqual(peaks(dir).map(row => [row.entry, row.peak_rss_bytes]), [["npm", "unknown"]]);
});

test("W1-T14143 criterion 2 — unreadable procfs, zero RSS and a partial observer report yield no sample", () => {
  assert.equal(readTypecheckRss(123, () => { throw new Error("EACCES: procfs hidden"); }), undefined);
  assert.equal(readTypecheckRss(123, path => path.endsWith("/status") ? "Name:\ttsc\nVmHWM:\t0 kB\n" : ""), undefined);
  const stderr = "compiler message\nrmd-typecheck-observation:{\n";
  assert.deepEqual(takeTypecheckObservation(stderr), { stderr });
});

test("W1-T14143 criterion 2 — a closed observation channel preserves the compiler's status", () => {
  const result = spawnSync(process.execPath, measuredTypecheckArgs("capture", process.execPath, ["-e", "process.exitCode = 5"]), {
    encoding: "utf8",
  });
  assert.equal(result.status, 5, result.stderr);
});

test("W1-T14143 criterion 2 — a read-only ledger can relay the same normalized observation to the host", (t) => {
  let diagnostic = "";
  t.mock.method(process.stderr, "write", (chunk: string) => { diagnostic += chunk; return true; });
  recordTypecheckPeak(() => {
    throw Object.assign(new Error("EROFS: state mount is read-only"), { code: "EROFS" });
  }, "npm", true, { peak: 0, rechecked: 0 });
  assert.match(diagnostic, /EROFS/);
  assert.deepEqual(readRelayedTypecheckPeaks(diagnostic), [
    { step: "typecheck.peak", entry: "npm", warm: true, peak_rss_bytes: "unknown", rechecked_files: 0 },
  ]);
  assert.deepEqual(readRelayedTypecheckPeaks('rmd-typecheck-peak:{bad}\nrmd-typecheck-peak:{"step":"other"}\n'), []);
});
