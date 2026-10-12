import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import * as shadow from "../src/lib/selector-shadow-gardener.js";
import { ciLearningTaskIdMinter } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const execAsync = promisify(execFile);

function fixture(root = fs.mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-loop-`))) {
  // The filing checkout is its own tree and holds the files a narrow edge declares, as main does:
  // lint-plan's admission reads them there, while the daemon's tree keeps only the suites it walks.
  const checkout = fs.mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selector-loop-checkout-`));
  for (const owner of ["src/lib/affected-suites.ts", shadow.SELECTOR_SHADOW_MISS_TEST_PATH]) {
    fs.mkdirSync(join(checkout, owner, ".."), { recursive: true });
    fs.writeFileSync(join(checkout, owner), "// fixture\n");
  }
  for (const path of ["test/nested", "plan/tasks.d", "state"]) fs.mkdirSync(join(root, path), { recursive: true });
  fs.writeFileSync(join(root, "test/nested/example.test.ts"), "");
  fs.writeFileSync(join(root, "plan/tasks.yaml"), "[]\n");
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const events: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  let disposed = 0;
  const deps = {
    repoRoot: root, stateDir: join(root, "state"),
    log: (step: string, fields?: Record<string, unknown>) => { events.push({ step, fields }); },
    openWorkspace: async () => ({
      root: checkout, branch: "selector-shadow-garden-test",
      land: async (input: { paths: string[]; title: string; body: string }) => {
        await execAsync(process.execPath, ["-e", "setTimeout(() => {}, 30)"]);
        landed.push(input);
        return "https://github.com/example/remudero/pull/1";
      },
      dispose: async () => { disposed++; },
    }),
  };
  return { root, checkout, deps, landed, events, disposed: () => disposed };
}

function miss(): shadow.SelectorShadowRun {
  const log = Array.from({ length: 8 }, (_, i) =>
    `coverage-shard (${i + 1}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify({
      fullRun: false, floorSize: 1, narrowSize: 0,
      failures: i === 0 ? [{ file: "test/nested/example.test.ts", floor: "selected", narrow: "missed" }] : [],
    })}\ncoverage-shard (${i + 1}/8)\tSELECTOR-SHADOW-JOB: conclusion=${i === 0 ? "failure" : "success"}`,
  ).join("\n");
  return { id: 1, headSha: "head", log };
}

test("W1-T5003: a timer keeps firing while a selector-shadow pass files a miss", async () => {
  const h = fixture();
  let ticks = 0;
  let mintTicks = 0;
  let reservedBranch: string | undefined;
  const timer = setInterval(() => { ticks++; }, 2);
  const mint = Object.assign(() => { throw new Error("synchronous mint blocked the loop"); }, {
    async: async (branch: string) => {
      reservedBranch = branch;
      const before = ticks;
      await execAsync(process.execPath, ["-e", "setTimeout(() => {}, 40)"]);
      mintTicks = ticks - before;
      return "W1-T9001";
    },
  });
  try {
    const report = await shadow.runSelectorShadowGardener(h.deps, () => [miss()], async () => ["src/example.ts"], mint);
    assert.equal(report.fullSuiteSize, 1);
    assert.ok(mintTicks > 0, "timers progress during the reservation itself");
    assert.ok(ticks > mintTicks, "timers also progress outside the reservation");
    assert.equal(reservedBranch, "selector-shadow-garden-test");
    assert.equal(h.landed.length, 1);
    assert.equal(h.disposed(), 1);
    assert.equal(h.events.find((e) => e.step === "selector-shadow.miss_filed")?.fields?.task_id, "W1-T9001");
    const task = fs.readFileSync(join(h.checkout, h.landed[0]!.paths[0]!), "utf8");
    assert.match(task, /id: W1-T9001/);
    assert.match(task, /src\/example.ts/);
    await shadow.runSelectorShadowGardener(h.deps, () => [miss()], async () => [], mint);
    assert.equal(h.landed.length, 1, "the filed miss stays deduplicated");
  } finally { clearInterval(timer); }
});

test("W1-T5003: an idle selector-shadow pass does not re-walk an unchanged test tree", async (t) => {
  const repo = gitRepo({ seedCommit: false, kind: "selector-loop" });
  const h = fixture(repo.dir);
  const git = repo.git;
  git("add", "test");
  git("commit", "-qm", "fixture");
  let walks = 0;
  const count = (path: unknown) => { if (String(path) === join(h.root, "test")) walks++; };
  const originalSync = fs.readdirSync;
  const originalAsync = promises.readdir;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    count(args[0]);
    return Reflect.apply(originalSync, fs, args);
  });
  t.mock.method(promises, "readdir", (...args: Parameters<typeof promises.readdir>) => {
    count(args[0]);
    return Reflect.apply(originalAsync, promises, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const idle = () => shadow.runSelectorShadowGardener(h.deps, () => [], () => [], () => "unused",
    () => { throw new Error("idle pass read the plan"); });
  assert.equal((await idle()).fullSuiteSize, 1);
  assert.equal(walks, 1, "positive control: the first count walked test/");
  assert.equal((await idle()).fullSuiteSize, 1);
  assert.equal(walks, 1, "the unchanged tree reused its count");
  fs.writeFileSync(join(h.root, "test/nested/added.test.ts"), "");
  assert.equal((await idle()).fullSuiteSize, 2, "untracked tests invalidate the cached count");
  git("add", "test");
  git("commit", "-qm", "new tree");
  assert.equal((await idle()).fullSuiteSize, 2, "a committed tree change also invalidates the count");
  const afterChange = walks;
  await idle();
  assert.equal(walks, afterChange);
  const { stdout } = await execAsync(process.execPath, ["--import", import.meta.resolve("tsx"),
    "--input-type=module", "--eval", `
      import promises from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { selectorShadowFullSuiteSizeAsync } from ${JSON.stringify(new URL("../src/lib/selector-shadow-gardener.ts", import.meta.url).href)};
      promises.readdir = async () => { throw new Error("new process re-walked the unchanged tree"); };
      syncBuiltinESMExports();
      process.stdout.write(String(await selectorShadowFullSuiteSizeAsync(process.argv[1], process.argv[2])));
    `, h.root, join(h.root, "state/selector-shadow-suite-size.json")]);
  assert.equal(stdout, "2", "the next garden child reuses the persisted count");
});

test("W1-T5003: asynchronous plan reads preserve the validated plan and report invalid data", async () => {
  const h = fixture();
  assert.deepEqual(await shadow.selectorShadowPlanTasksAsync(h.root), shadow.selectorShadowPlanTasks(h.root));
  fs.writeFileSync(join(h.root, "plan/tasks.yaml"), "not a plan\n");
  await assert.rejects(shadow.selectorShadowPlanTasksAsync(h.root), /plan must be a YAML list/);
});

test("W1-T5003: a persisted suite count is reused and a corrupt count is recomputed", async (t) => {
  const repo = gitRepo({ seedCommit: false, kind: "selector-loop" });
  const h = fixture(repo.dir);
  const git = repo.git;
  git("add", "test");
  git("commit", "-qm", "fixture");
  const cachePath = join(h.root, "state/selector-shadow-suite-size.json");
  fs.writeFileSync(cachePath, JSON.stringify({ root: h.root, tree: git("rev-parse", "HEAD:test").trim(), size: 1 }));
  const original = promises.readdir;
  let walks = 0;
  t.mock.method(promises, "readdir", (...args: Parameters<typeof promises.readdir>) => {
    walks++;
    return Reflect.apply(original, promises, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await shadow.selectorShadowFullSuiteSizeAsync(h.root, cachePath), 1);
  assert.equal(walks, 0);
  fs.writeFileSync(cachePath, "invalid json");
  assert.equal(await shadow.selectorShadowFullSuiteSizeAsync(h.root, cachePath), 1);
  assert.ok(walks > 0, "a corrupt cache is replaced by a real tree count");
});

test("W1-T5003: the default asynchronous minter refuses an unreachable reservation without blocking timers", async () => {
  const h = fixture();
  const priorPath = process.env.PATH;
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 2);
  try {
    process.env.PATH = "/nonexistent";
    await assert.rejects(ciLearningTaskIdMinter(h.root).async("selector-shadow-garden-test"));
    assert.ok(ticks > 0);
  } finally {
    process.env.PATH = priorPath;
    clearInterval(timer);
  }
});

test("W1-T5003: a rejected asynchronous mint disposes its workspace and records no filing", async () => {
  const h = fixture();
  await assert.rejects(shadow.runSelectorShadowGardener(h.deps, () => [miss()], () => [],
    async () => { throw new Error("reservation unavailable"); }, async () => []), /reservation unavailable/);
  assert.equal(h.disposed(), 1);
  assert.equal(h.landed.length, 0);
  assert.equal(h.events.filter((e) => e.step === "selector-shadow.miss_filed").length, 0);
});

test("W1-T5003: the asynchronous minter returns the reserved id and carries reservation logs on both outcomes", async (t) => {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const said: unknown[] = [];
  const warnings: unknown[] = [];
  t.mock.method(console, "log", (line: unknown) => { said.push(line); });
  t.mock.method(process.stderr, "write", (line: unknown) => { warnings.push(line); return true; });
  const receipt = { step: "task_id.reserved", fields: { task_id: "W1-T9002" } };
  const log = (step: string, fields: Record<string, unknown>) => { rows.push({ step, fields }); };
  const mint = ciLearningTaskIdMinter("/fixture", log, async (file, args) => {
    assert.equal(file, process.execPath);
    assert.deepEqual(args.slice(-2), ["/fixture", "selector-shadow-garden-test"]);
    return { stdout: JSON.stringify({ id: "W1-T9002", rows: [{ say: "reservation handed off" }, receipt] }), stderr: "mint warning\n" };
  });
  assert.equal(await mint.async("selector-shadow-garden-test"), "W1-T9002");
  assert.deepEqual(rows, [receipt]);
  assert.deepEqual(said, ["reservation handed off"]);
  assert.deepEqual(warnings, ["mint warning\n"]);
  const failed = { step: "task_id.refused", fields: { reason: "remote unavailable" } };
  const refuse = ciLearningTaskIdMinter("/fixture", log, async () => ({
    stdout: JSON.stringify({ error: "remote unavailable", rows: [failed] }),
  }));
  await assert.rejects(refuse.async("selector-shadow-garden-test"), /remote unavailable/);
  assert.deepEqual(rows, [receipt, failed]);
});
