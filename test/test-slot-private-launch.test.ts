import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { systemClock } from "#src/lib/clock.js";
import { typecheckStep } from "#src/lib/commit-message.js";
import { mergedHeadTypechecks } from "#src/lib/merge-probe.js";
import { runRetroPrepublishPreflight } from "#src/lib/retro-preflight.js";
import { runBoundedTest } from "#src/lib/test-run.js";
import { acquireTestSlot } from "#src/lib/test-slot.js";
import { runTypecheck } from "#src/lib/typecheck-run.js";
import { spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import type { Config } from "#src/lib/config.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { makeRuntimeFixture } from "#test/helpers/native-runtime-fixture.js";

const modules = resolve("node_modules");
function occupied(t: TestContext) {
  const repo = gitRepo({ kind: "private-launch" }); t.after(() => repo.cleanup());
  const dir = join(repo.dir, "slots"); mkdirSync(dir);
  const options = { dir, slots: 1, waitBoundMs: 0, log: () => {} };
  const owner = acquireTestSlot("private fixture owner", { ...options, ownershipProtocol: "private-capacity-v1" });
  assert.equal(owner.outcome, "acquired"); t.after(() => owner.release());
  const saved = ["RMD_TEST_SLOT_DIR", "RMD_TEST_SLOTS", "RMD_TEST_SLOT_PARENT"].map(key => [key, process.env[key]] as const);
  process.env.RMD_TEST_SLOT_DIR = dir; process.env.RMD_TEST_SLOTS = "1"; delete process.env.RMD_TEST_SLOT_PARENT;
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  // Only the slot clock advances. No host clock, fixture mtime, timers or author deadline changes.
  let now = Date.now(); t.mock.method(systemClock, "now", () => (now += 60 * 60_000));
  return { repo, options };
}
function tinyTree(root: string) {
  symlinkSync(modules, join(root, "node_modules"));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: [], noEmit: true }, include: ["*.ts"] }));
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
}
test("private NOT_RUN prevents npm tests before admission, heartbeat and spawn", async t => {
  const { options } = occupied(t); const logs: string[] = []; let launched = 0;
  assert.equal(await runBoundedTest(["--test", "test/fixture.test.ts"], { testSlot: options,
    spawn: async () => { launched++; return 0; }, log: line => logs.push(line) }), 75);
  assert.equal(launched, 0); assert(logs.some(line => line.includes("test_run.not_run")));
  assert(!logs.some(line => line.includes("test_run.admitted")));
});
test("private NOT_RUN prevents both cold typecheck entry points from spawning", t => {
  const { repo, options } = occupied(t); tinyTree(repo.dir); let launched = 0;
  assert.equal(runTypecheck(repo.dir, [], { testSlot: options, spawn: () => { launched++; return { status: 0 }; }, log: () => {} }), 75);
  const result = typecheckStep(repo.dir, () => { launched++; return { status: 0, stdout: "", stderr: "" }; }, options);
  assert.equal(result.ok, false); assert.match(result.detail, /NOT_RUN/); assert.equal(launched, 0);
});
test("private NOT_RUN makes the real merge probe skipped rather than a passing compiler run", async t => {
  const { repo, options } = occupied(t); tinyTree(repo.dir);
  repo.git("add", "a.ts", "tsconfig.json"); repo.git("commit", "-qm", "base");
  const lane = repo.addWorktree(join(repo.dir, "lane"), "lane", "main");
  symlinkSync(modules, join(lane.dir, "node_modules"));
  writeFileSync(join(lane.dir, "b.ts"), "export const b = 1;\n"); lane.git("add", "b.ts"); lane.git("commit", "-qm", "lane");
  writeFileSync(join(repo.dir, "c.ts"), "export const c = 1;\n"); repo.git("add", "c.ts"); repo.git("commit", "-qm", "main");
  let launched = 0;
  const result = await mergedHeadTypechecks(lane.dir, { mainRef: "main", testSlot: options,
    spawn: () => { launched++; throw new Error("compiler must not launch"); } });
  assert.equal(launched, 0); assert.equal(result.outcome, "skipped");
  if (result.outcome === "skipped") assert.match(result.reason, /NOT_RUN/);
});
test("private NOT_RUN stops retro after enumeration without launching suites or repair", async t => {
  const { repo, options } = occupied(t); let calls = 0, repairs = 0;
  await assert.rejects(runRetroPrepublishPreflight({ worktreePath: repo.dir,
    provenance: { model: "fixture", effort: "default", sessionId: "private-not-run" }, remotePrExisted: false,
    repair: async () => { repairs++; }, regenerateHarnessArtifacts: () => {}, log: () => {},
    deps: { testSlot: options, run: async () => { calls++; return { status: 0, signal: null, stdout: "test/physical.test.ts\n", stderr: "" }; } },
  }), /NOT_RUN/);
  assert.equal(calls, 1, "only cheap enumeration runs"); assert.equal(repairs, 0);
});
test("private NOT_RUN cannot become a ran or successful result in the worker tool loop", async t => {
  const workerClock = { ...systemClock }; // Keep real worker deadlines while occupied() advances only slot admission.
  const { repo } = occupied(t); tinyTree(repo.dir); let calls = 0, turns = 0;
  await spawnOpenWeightWorker({ cwd: repo.dir, workerHome: join(repo.dir, "home"), prompt: "typecheck", tools: ["RunCheck"], maxTurns: 3,
    clock: workerClock,
    env: { RMD_OPENWEIGHT_API_KEY: "fixture" }, runCheck: async () => { calls++; return "fake success"; },
    fetchImpl: async () => {
      const message = ++turns === 1 ? { tool_calls: [{ id: "c1", type: "function", function: { name: "run_check", arguments: '{"check":"typecheck"}' } }] } : { content: "done" };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    },
  }, { root: repo.dir, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } } as Config,
  { model: "gpt-oss-120b", effort: "low" });
  assert.equal(turns, 2, "positive control: the tool loop executed"); assert.equal(calls, 0);
});
test("private NOT_RUN refuses author static work and native calibration before their heavy children", async t => {
  occupied(t); const f = makeRuntimeFixture(); t.after(() => f.cleanup());
  const author = await import(pathToFileURL(resolve("scripts/preflight-author.mjs")).href);
  const calibrator = await import(pathToFileURL(resolve("scripts/calibrate-author-runtime.mjs")).href);
  const select = () => ({ fullRun: false, suites: ["test/a.test.ts"], reasons: ["physical fixture"] });
  assert.equal(author.main([], { root: f.dir, select }), 1);
  const receipt = JSON.parse(readFileSync(join(f.dir, "coverage/preflight-author.json"), "utf8"));
  assert.equal(receipt.verdict, "refused"); assert.match(receipt.error, /NOT_RUN/);
  assert.deepEqual(receipt.steps.map((step: { name: string }) => step.name), ["census-precheck"]);
  assert.throws(() => calibrator.calibrateAuthorRuntime({ root: f.dir }), /admitted host-wide slot/);
  assert.equal(existsSync(join(f.dir, "coverage/static-started")), false);
});
