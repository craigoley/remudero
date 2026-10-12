import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { typecheckStep } from "../src/lib/commit-message.js";
import { mergedHeadTypechecks } from "../src/lib/merge-probe.js";
import * as buildInfo from "../src/lib/typecheck-buildinfo.js";
import * as testSlots from "../src/lib/test-slot.js";
import { spawnOpenWeightWorker } from "../src/lib/worker-provider.js";
import type { Config } from "../src/lib/config.js";
import { gitRepo } from "./helpers/git-repo.js";

const modules = resolve("node_modules");
const version = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("typescript/package.json"), "utf8")).version;
const config = JSON.stringify({ compilerOptions: { types: [], noEmit: true }, include: ["*.ts"] });

function fixture(t: TestContext): { root: string; slots: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-cold-typecheck-"));
  const slots = join(root, "slots");
  mkdirSync(slots);
  const keys = ["RMD_TEST_SLOT_DIR", "RMD_TEST_SLOTS", "RMD_TEST_SLOT_PARENT"];
  const saved = keys.map((key) => process.env[key]);
  process.env.RMD_TEST_SLOT_DIR = slots;
  process.env.RMD_TEST_SLOTS = "1";
  delete process.env.RMD_TEST_SLOT_PARENT;
  t.after(() => {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    rmSync(root, { recursive: true, force: true });
  });
  return { root, slots };
}

function labels(slots: string): string[] {
  return readdirSync(slots).map((name) => JSON.parse(readFileSync(join(slots, name), "utf8")).label);
}

function tree(root: string): void {
  mkdirSync(join(root, ".git"));
  symlinkSync(modules, join(root, "node_modules"));
  writeFileSync(join(root, "tsconfig.json"), config);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
}

function probeTree(t: TestContext, root: string): string {
  const repo = gitRepo({ kind: "cold-typecheck-probe" });
  t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "tsconfig.json"), config);
  writeFileSync(join(repo.dir, "a.ts"), "export const a = 1;\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base");
  const lane = repo.addWorktree(join(root, "lane"), "lane", "main");
  symlinkSync(modules, join(lane.dir, "node_modules"));
  writeFileSync(join(lane.dir, "b.ts"), "export const b = 1;\n");
  lane.git("add", "b.ts");
  lane.git("commit", "-qm", "lane");
  writeFileSync(join(repo.dir, "c.ts"), "export const c = 1;\n");
  repo.git("add", "c.ts");
  repo.git("commit", "-qm", "main");
  return lane.dir;
}

test("W1-T7392: a cold fleet typecheck takes a host test slot and a warm one does not", async (t) => {
  await t.test("preflight owns a lease during cold tsc and releases it before the warm check", (t) => {
    const fx = fixture(t);
    tree(fx.root);
    const observed: string[][] = [];
    const run = () => typecheckStep(fx.root, (file, args, options) => {
      observed.push(labels(fx.slots));
      const res = spawnSync(file, [...args], { cwd: options?.cwd, encoding: "utf8" });
      return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    });
    assert.equal(run().ok, true);
    assert.deepEqual(labels(fx.slots), []);
    assert.equal(run().ok, true);
    assert.deepEqual(observed, [["typecheck:preflight"], []]);
  });
  await t.test("merge-probe owns a cold lease and bypasses it after publishing a seed", async (t) => {
    const fx = fixture(t);
    const lane = probeTree(t, fx.root);
    const observed: string[][] = [];
    for (let i = 0; i < 2; i += 1) {
      const result = await mergedHeadTypechecks(lane, { mainRef: "main", spawn: (file, args, options) => {
        observed.push(labels(fx.slots));
        return spawn(file, [...args], options);
      } });
      assert.equal(result.outcome, "passes", JSON.stringify(result));
      assert.deepEqual(labels(fx.slots), []);
    }
    assert.deepEqual(observed, [["typecheck:merge-probe"], []]);
  });
  await t.test("bwrap's tool loop owns the cold lease at the runner boundary and bypasses it warm", async (t) => {
    const fx = fixture(t);
    tree(fx.root);
    const observed: string[][] = [];
    let turn = 0;
    await spawnOpenWeightWorker({
      cwd: fx.root, workerHome: join(fx.root, "home"), prompt: "typecheck twice", tools: ["RunCheck"], maxTurns: 4,
      env: { RMD_OPENWEIGHT_API_KEY: "fixture" },
      runCheck: ({ argv, cwd }) => {
        observed.push(labels(fx.slots));
        const res = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" });
        assert.equal(res.status, 0, res.stdout + res.stderr);
        return res.stdout;
      },
      fetchImpl: async () => {
        turn += 1;
        const message = turn <= 2
          ? { tool_calls: [{ id: `c${turn}`, type: "function", function: { name: "run_check", arguments: '{"check":"typecheck"}' } }] }
          : { content: "done" };
        return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
      },
    }, { root: fx.root, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } } as Config,
    { model: "gpt-oss-120b", effort: "low" });
    assert.deepEqual(observed, [["typecheck:bwrap"], []]);
    assert.deepEqual(labels(fx.slots), []);
  });
});

test("preflight treats corrupt and different-version buildinfo as cold and releases a failed check", (t) => {
  const fx = fixture(t);
  tree(fx.root);
  const observed: string[][] = [];
  for (const text of ["{broken", JSON.stringify({ version: "other", fileNames: ["a.ts"], fileInfos: ["hash"] })]) {
    writeFileSync(join(fx.root, ".git", buildInfo.TYPECHECK_BUILDINFO_NAME), text);
    const res = typecheckStep(fx.root, () => {
      observed.push(labels(fx.slots));
      throw new Error("spawn failed");
    });
    assert.equal(res.ok, false);
    assert.match(res.detail, /spawn failed/);
    assert.deepEqual(labels(fx.slots), []);
  }
  assert.deepEqual(observed, [["typecheck:preflight"], ["typecheck:preflight"]]);
});

test("a cold merge-probe queues behind a suite while the event loop keeps running", async (t) => {
  const fx = fixture(t);
  const lane = probeTree(t, fx.root);
  const holder = testSlots.acquireTestSlot("suite", { dir: fx.slots, slots: 1 });
  t.after(() => holder.release());
  assert.equal(holder.outcome, "acquired");
  let announce!: () => void;
  const waiting = new Promise<void>((resolve) => { announce = resolve; });
  let spawned = false;
  const pending = mergedHeadTypechecks(lane, {
    mainRef: "main", testSlot: { dir: fx.slots, slots: 1, pollMs: 5, waitBoundMs: 1_000, log: () => announce() },
    spawn: (file, args, options) => {
      spawned = true;
      assert.deepEqual(labels(fx.slots), ["typecheck:merge-probe"]);
      return spawn(file, [...args], options);
    },
  });
  await waiting;
  await delay(20);
  assert.equal(spawned, false);
  assert.deepEqual(labels(fx.slots), ["suite"]);
  holder.release();
  assert.equal((await pending).outcome, "passes");
  assert.equal(spawned, true);
  assert.deepEqual(labels(fx.slots), []);
});

test("cold admission remains never-refusing at the wait bound and with an unusable slot directory", async (t) => {
  const fx = fixture(t);
  tree(fx.root);
  const holder = testSlots.acquireTestSlot("suite", { dir: fx.slots, slots: 1 });
  t.after(() => holder.release());
  const logs: string[] = [];
  const options = { dir: fx.slots, slots: 1, pollMs: 1, waitBoundMs: 5, log: (line: string) => logs.push(line) };
  const bounded = await testSlots.acquireTestSlotAsync("typecheck:bounded", options);
  assert.equal(bounded.outcome, "wait_bound_exceeded");
  assert.ok(bounded.waitedMs >= 5);
  bounded.release();
  let ran = false;
  const result = typecheckStep(fx.root, () => { ran = true; return { status: 0, stdout: "", stderr: "" }; }, { ...options, waitBoundMs: 0 });
  assert.equal(result.ok, true);
  assert.equal(ran, true);
  assert.deepEqual(labels(fx.slots), ["suite"]);
  assert.ok(logs.some((line) => JSON.parse(line).step === "test_slot.wait_bound_exceeded"));
  const unusable = join(fx.root, "file");
  writeFileSync(unusable, "a file is not a slot directory");
  const lease = await testSlots.acquireTestSlotAsync("typecheck:unavailable", { dir: unusable });
  assert.equal(lease.outcome, "slot_unavailable");
  lease.release();
  assert.equal(typecheckStep(fx.root, () => ({ status: 0, stdout: "", stderr: "" }), { dir: unusable }).ok, true);
});

test("merge-probe releases cold admission after synchronous and asynchronous spawn failures", async (t) => {
  const fx = fixture(t);
  const lane = probeTree(t, fx.root);
  for (const synchronous of [true, false]) {
    const observed: string[][] = [];
    const result = await mergedHeadTypechecks(lane, { mainRef: "main", spawn: () => {
      observed.push(labels(fx.slots));
      if (synchronous) throw new Error("fixture spawn failure");
      return spawn("/rmd-missing-typecheck-executable");
    } });
    assert.equal(result.outcome, "skipped");
    assert.deepEqual(observed, [["typecheck:merge-probe"]]);
    assert.deepEqual(labels(fx.slots), []);
  }
});

test("bwrap's tool loop releases cold admission and returns the failing check's result", async (t) => {
  const fx = fixture(t);
  tree(fx.root);
  const observed: string[][] = [];
  let turn = 0;
  let output: Record<string, unknown> | undefined;
  await spawnOpenWeightWorker({
    cwd: fx.root, workerHome: join(fx.root, "home"), prompt: "typecheck", tools: ["RunCheck"], maxTurns: 3,
    env: { RMD_OPENWEIGHT_API_KEY: "fixture" },
    runCheck: async () => {
      observed.push(labels(fx.slots));
      await delay(1);
      assert.deepEqual(labels(fx.slots), ["typecheck:bwrap"]);
      throw Object.assign(new Error("compiler timed out"), { status: 124, killed: true, stderr: "fixture diagnostics" });
    },
    fetchImpl: async (_input, init) => {
      turn += 1;
      if (turn > 1) {
        const request = JSON.parse(String(init?.body));
        output = JSON.parse(request.messages.find((message: { role: string }) => message.role === "tool").content);
        assert.deepEqual(labels(fx.slots), []);
      }
      const message = turn === 1
        ? { tool_calls: [{ id: "c1", type: "function", function: { name: "run_check", arguments: '{"check":"typecheck"}' } }] }
        : { content: "done" };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    },
  }, { root: fx.root, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } } as Config,
  { model: "gpt-oss-120b", effort: "low" });
  assert.deepEqual(observed, [["typecheck:bwrap"]]);
  assert.equal(output?.exitCode, 124);
  assert.equal(output?.output, "fixture diagnostics");
  assert.deepEqual(labels(fx.slots), []);
});

test("only readable buildinfo with matching compiler version and file state bypasses cold admission", (t) => {
  const fx = fixture(t);
  const info = join(fx.root, "state.tsbuildinfo");
  assert.equal(buildInfo.hasUsableTypecheckBuildInfo(undefined, version), false);
  assert.equal(buildInfo.hasUsableTypecheckBuildInfo(info, undefined), false);
  assert.equal(buildInfo.hasUsableTypecheckBuildInfo(info, version), false);
  assert.equal(buildInfo.hasUsableTypecheckBuildInfo(fx.slots, version), false);
  for (const text of ["null", "broken", "[]", JSON.stringify({ version }), JSON.stringify({ version, fileNames: [1], fileInfos: ["hash"] }),
    JSON.stringify({ version, fileNames: ["a.ts"], fileInfos: [] })]) {
    writeFileSync(info, text);
    assert.equal(buildInfo.hasUsableTypecheckBuildInfo(info, version), false, text);
  }
  writeFileSync(info, JSON.stringify({ version, fileNames: ["a.ts"], fileInfos: ["hash"] }));
  assert.equal(buildInfo.hasUsableTypecheckBuildInfo(info, version), true);
});
