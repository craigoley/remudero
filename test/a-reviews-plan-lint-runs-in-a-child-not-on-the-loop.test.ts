import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { lintPlanCommand, lintPlanForReview, planLintOutcomeFromOutput, spawnCensusChild } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";

function fixture(t: TestContext) {
  const repo = gitRepo({ scope: t });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "[]\n");
  repo.git("add", ".");
  repo.git("commit", "--quiet", "-m", "chore(plan): base");
  const base = repo.git("rev-parse", "HEAD");
  repo.addRemote("origin", repo.dir);
  repo.git("update-ref", "refs/remotes/origin/main", base);
  repo.git("checkout", "--quiet", "-b", "filing");
  writeFileSync(join(repo.dir, "plan", "tasks.d", "T1.yaml"), `- id: T1
  title: "the footer names its revision"
  repo: fixture
  type: implement
  verify: auto
  principles: {tdd: strict}
  budget_usd: 5
  risk: low
  origin: fixture
  files: [src/footer.ts, test/footer.test.ts]
  status: queued
  rationale: "Readers need to identify the running revision."
  acceptance:
    - claim: "the footer names its revision"
      proof: "unit test: the footer names its revision"
  falsifier: "The footer already names its revision."
`);
  repo.git("add", ".");
  repo.git("commit", "--quiet", "-m", "chore(plan): filing");
  return { repo, base };
}

async function capture(run: () => Promise<number>) {
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try { return { code: await run(), lines }; }
  finally { Object.assign(console, saved); }
}

test("W1-T9545: a review plan lint runs in a child with sync spawns trapped in the parent", async (t) => {
  const { repo, base } = fixture(t);
  const output = await capture(() => lintPlanCommand(["--plan", join(repo.dir, "plan/tasks.yaml"), "--base", base],
    { offline: true, repoRoot: repo.dir }));
  const expected = planLintOutcomeFromOutput(output.code, output.lines, base, true);
  assert.equal(expected.ran, true);
  const saved = { execFileSync: childProcess.execFileSync, spawnSync: childProcess.spawnSync, execSync: childProcess.execSync };
  const trap = () => { throw new Error("synchronous spawn on the review loop"); };
  Object.assign(childProcess, { execFileSync: trap, spawnSync: trap, execSync: trap });
  syncBuiltinESMExports();
  try { assert.deepEqual(await lintPlanForReview(repo.dir), expected); }
  finally { Object.assign(childProcess, saved); syncBuiltinESMExports(); }
});

test("W1-T9545: a concurrent timer ticks while the review plan lint runs", async (t) => {
  const { repo } = fixture(t);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const result = await lintPlanForReview(repo.dir, () => "HEAD");
    assert.equal(result.ran, true, JSON.stringify(result));
    assert.ok(ticks > 0, "the awaited lint must yield the parent's loop");
  } finally { clearInterval(timer); }
});

test("W1-T9545: a lint child that dies or prints no summary is not clean", async (t) => {
  const { repo } = fixture(t);
  for (const code of ["process.stdout.write('rmd lint-plan: 0 task(s) checked\\n', () => process.kill(process.pid, 'SIGKILL'))",
    "process.stdout.write('incomplete lint\\n')"]) {
    const result = await lintPlanForReview(repo.dir, () => "HEAD",
      () => spawnCensusChild(process.execPath, ["-e", code], { encoding: "utf8" }));
    assert.equal(result.ran, false, JSON.stringify(result));
    assert.match(result.ran ? "" : result.reason, code.includes("SIGKILL") ? /killed by SIGKILL/ : /no summary/);
  }
});

test("W1-T9545: lint-plan takes offline and repo-root as flags", async (t) => {
  const { repo } = fixture(t);
  const output = await capture(() => lintPlanCommand(["--offline", "--repo-root", repo.dir, "--base", "HEAD"], {
    ghGateway: () => { throw new Error("offline lint reached GitHub"); },
  }));
  assert.equal(output.code, 0, output.lines.join("\n"));
  assert.match(output.lines.join("\n"), /rmd lint-plan: 0 task\(s\) checked/);
});

test("review lint preserves fetch warnings and merge-base failures", async (t) => {
  const { repo } = fixture(t);
  const output = await capture(async () => {
    const result = await lintPlanForReview(repo.dir, async (_cwd, args) => {
      if (args[0] === "fetch") throw new Error("fetch unavailable");
      throw new Error("unrelated histories");
    });
    assert.deepEqual(result, { ran: false, reason: "no merge base: unrelated histories" });
    return 0;
  });
  assert.match(output.lines.join("\n"), /origin\/main not refreshed \(fetch unavailable\)/);
});

test("review lint keeps child failures distinct and records the selected entry", async (t) => {
  const { repo } = fixture(t);
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const result = await lintPlanForReview(repo.dir, async () => "HEAD", async (argv, options) => {
    assert.deepEqual(argv.slice(-7), ["--plan", join(repo.dir, "plan/tasks.yaml"), "--base", "HEAD",
      "--offline", "--repo-root", repo.dir]);
    assert.ok(options.cwd);
    return { status: null, signal: null, stdout: "", stderr: "", error: new Error("spawn refused") };
  }, { log: (step, extra) => rows.push({ step, extra }) });
  assert.deepEqual(result, { ran: false, reason: "lint-plan could not start: spawn refused" });
  assert.ok(rows.some(({ step, extra }) => step === "child_entry.spawned" && extra?.name === "run-task" &&
    extra.verb === "lint-plan" && ["tsx", "bundle"].includes(String(extra.kind)) && typeof extra.reason === "string"));
  const unknown = await lintPlanForReview(repo.dir, () => "HEAD", async () =>
    ({ status: null, signal: null, stdout: "rmd lint-plan: 0 task(s) checked", stderr: "" }));
  assert.deepEqual(unknown, { ran: false, reason: "lint-plan exited without a status" });
  const threw = await lintPlanForReview(repo.dir, () => "HEAD", async () => { throw new Error("launch failed"); });
  assert.deepEqual(threw, { ran: false, reason: "lint-plan threw: launch failed" });
});

test("review lint cancellation kills the child group including descendants", { timeout: 15_000 }, async (t) => {
  const { repo } = fixture(t);
  const controller = new AbortController();
  const realSpawn = childProcess.spawn;
  let detached: boolean | undefined;
  const descendant = "process.stdout.write('ready'); setInterval(() => {}, 1000)";
  const program = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`;
  let child: childProcess.ChildProcess | undefined;
  childProcess.spawn = ((file: string, _argv: string[], options: childProcess.SpawnOptions) => {
    detached = options.detached;
    child = realSpawn(file, ["-e", program], options);
    child.stdout!.once("data", () => controller.abort());
    return child;
  }) as typeof realSpawn;
  syncBuiltinESMExports();
  try {
    const result = await lintPlanForReview(repo.dir, () => "HEAD", undefined, { signal: controller.signal });
    assert.deepEqual(result, { ran: false, reason: "lint-plan aborted" });
    assert.equal(detached, true);
    assert.equal(child?.signalCode, "SIGKILL");
  } finally {
    childProcess.spawn = realSpawn;
    syncBuiltinESMExports();
    if (child?.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); }
    }
  }
});

test("a review cancelled during Git preparation starts no lint child", async (t) => {
  const { repo } = fixture(t);
  const controller = new AbortController();
  const result = await lintPlanForReview(repo.dir, async () => { controller.abort(); return "HEAD"; },
    async () => { assert.fail("an aborted review must not start a child"); }, { signal: controller.signal });
  assert.deepEqual(result, { ran: false, reason: "lint-plan aborted" });
});

test("review lint reports a real child start error", async (t) => {
  const { repo } = fixture(t);
  const realSpawn = childProcess.spawn;
  childProcess.spawn = ((_file: string, argv: string[], options: childProcess.SpawnOptions) =>
    realSpawn(join(repo.dir, "missing-node"), argv, options)) as typeof realSpawn;
  syncBuiltinESMExports();
  try {
    const result = await lintPlanForReview(repo.dir, () => "HEAD");
    assert.equal(result.ran, false);
    assert.match(result.ran ? "" : result.reason, /lint-plan could not start:.*ENOENT/);
  } finally { childProcess.spawn = realSpawn; syncBuiltinESMExports(); }
});
