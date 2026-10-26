import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resolveProjectPreflight, runProjectPreflight } from "#src/lib/ci-project-preflight.js";
import { preflightCommand } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import type { PreflightSpawn } from "#src/lib/commit-message.js";
import { unwrapLowPriority, type TestSlotOptions } from "#src/lib/test-slot.js";

const consoleScripts = {
  typecheck: "tsc --noEmit", "test:unit": "vitest run tests/unit",
  build: "next build", "test:e2e": "playwright test",
};
const wreckterraScripts = {
  typecheck: "tsc --noEmit", test: "vitest run --maxWorkers=1",
  "test:coverage": "vitest run --coverage --maxWorkers=1",
  build: "tsc --noEmit && vite build", security: "npm audit --audit-level=low",
};
const consoleChecks = ["check-plan-dependencies", "check-core-contract-compatibility", "check-core-write-parity", "check-core-read-contract"];
const passing: PreflightSpawn = () => ({ status: 0, stdout: "", stderr: "" });

function fixture(repo = "remudero-console") {
  const f = gitRepo({ kind: "project-preflight" });
  f.addRemote("origin", `https://github.com/craigoley/${repo}.git`);
  const scripts = repo === "wreckterra" ? wreckterraScripts : consoleScripts;
  const put = (path: string, text: string) => {
    mkdirSync(join(f.dir, path, ".."), { recursive: true });
    writeFileSync(join(f.dir, path), text);
  };
  put("package.json", JSON.stringify({ type: "module", scripts }));
  put("tsconfig.json", "{}");
  const commands = Object.keys(scripts).map(name => `npm run ${name}`);
  if (repo !== "wreckterra") commands.push(...consoleChecks.map(name => `node scripts/${name}.mjs`), "npm audit --audit-level=high");
  put(".github/workflows/ci.yml", `jobs:\n  quality:\n    steps:\n${commands.map(run => `      - run: ${run}`).join("\n")}\n`);
  const record = `import {appendFileSync} from 'node:fs'; appendFileSync('commands.ndjson', JSON.stringify({file:process.argv[1],args:process.argv.slice(2),cwd:process.cwd()})+'\\n');`;
  for (const name of consoleChecks) put(`scripts/${name}.mjs`, record);
  for (const name of ["tsc", "vitest", "vite", "next", "playwright"]) {
    put(`node_modules/.bin/${name}`, `#!${process.execPath}\n${record}`);
    chmodSync(join(f.dir, "node_modules/.bin", name), 0o755);
  }
  const testSlot: TestSlotOptions = {
    dir: join(f.dir, "slots"), slots: 1, memoryBytes: 512 * 1024 ** 2,
    memoryHeadroom: () => 4 * 1024 ** 3, load: () => ({ cores: 1, load1: 0 }), waitBoundMs: 0,
  };
  return { ...f, put, testSlot };
}

test("W1-T10674: consumer preflight runs the target checkout declared quality commands", async t => {
  for (const repo of ["remudero-console", "wreckterra"]) {
    const f = fixture(repo);
    t.after(() => f.cleanup());
    const profile = resolveProjectPreflight(f.dir);
    assert.equal(profile.kind, "consumer");
    const calls: string[][] = [];
    const result = runProjectPreflight(profile, { testSlot: f.testSlot, spawn: (file, args, opts) => {
      assert.equal(opts?.cwd, f.dir);
      const command = unwrapLowPriority(file, args);
      calls.push([command.file, ...command.args]);
      return passing(file, args, opts);
    } });
    assert.equal(result.ok, true);
    const flat = calls.map(call => call.join(" ")).join("\n");
    assert.match(flat, /run typecheck/);
    if (repo === "remudero-console") {
      for (const check of consoleChecks) assert.ok(flat.includes(`scripts/${check}.mjs`));
      assert.match(flat, /run test:unit/);
    } else {
      for (const name of ["test", "build", "security"]) assert.ok(calls.some(call => call.join(" ") === `npm run ${name}`));
    }
    assert.ok(calls.some(call => call.includes(join(REPO_ROOT, "node_modules/.bin/commitlint"))));
    assert.ok(calls.some(call => call.includes(join(REPO_ROOT, "commitlint.config.mjs"))));
    const full = resolveProjectPreflight(f.dir, { ciParity: true });
    assert.equal(full.kind, "consumer");
    if (full.kind === "consumer") {
      assert.deepEqual(full.commands.map(command => command.name), repo === "wreckterra"
        ? ["typecheck", "test:coverage", "build", "security"]
        : [...consoleChecks, "typecheck", "test:unit", "build", "test:e2e", "security"]);
    }
    if (repo === "wreckterra") {
      const coverage = resolveProjectPreflight(f.dir, { coverage: true });
      assert.equal(coverage.kind, "consumer");
      if (coverage.kind === "consumer") assert.ok(coverage.commands.some(command => command.name === "test:coverage"));
    }
  }
  const f = fixture();
  t.after(() => f.cleanup());
  // The quality children use the production bounded subprocess, not a recording fake.
  f.git("commit", "--allow-empty", "-m", "test(preflight): verify target commands");
  const range = { from: "HEAD^", to: "HEAD" };
  const result = runProjectPreflight(resolveProjectPreflight(f.dir), { range, testSlot: f.testSlot });
  assert.equal(result.ok, true, result.steps.map(step => step.detail).join("\n"));
  const records = readFileSync(join(f.dir, "commands.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records.length, 6);
  assert.ok(records.every(row => row.cwd === f.dir));
  assert.ok(records.some(row => row.file === join(f.dir, "node_modules/.bin/vitest") && row.args.join(" ") === "run tests/unit --maxWorkers=1"));
  f.put("scripts/check-core-read-contract.mjs", "process.stderr.write('fixture read failure'); process.exitCode = 1;");
  const failed = runProjectPreflight(resolveProjectPreflight(f.dir), { range, testSlot: f.testSlot });
  assert.equal(failed.ok, false);
  assert.match(failed.steps.find(step => step.name === "project:check-core-read-contract")!.detail, /fixture read failure/);
});

test("W1-T10674: Core and unknown targets preserve their quality boundaries", async t => {
  assert.equal(resolveProjectPreflight(REPO_ROOT).kind, "core");
  const unknown = fixture("unregistered");
  t.after(() => unknown.cleanup());
  assert.equal(resolveProjectPreflight(unknown.dir).kind, "unavailable");
  unknown.git("remote", "set-url", "origin", "https://github.com/someone/remudero-console.git");
  assert.equal(resolveProjectPreflight(unknown.dir).kind, "unavailable");
  unknown.put("package.json", JSON.stringify({ name: "remudero", browser: true, scripts: consoleScripts }));
  assert.equal(resolveProjectPreflight(unknown.dir).kind, "unavailable");
  unknown.git("remote", "set-url", "origin", "https://github.com/craigoley/remudero.git");
  assert.equal(resolveProjectPreflight(unknown.dir).kind, "core");
  const f = fixture();
  t.after(() => f.cleanup());
  const calls: string[][] = [];
  const log = console.log;
  console.log = () => {};
  try {
    const summary = join(f.dir, "summary.json");
    assert.equal(await preflightCommand(["--summary-file", summary], { projectRoot: f.dir, projectTestSlot: f.testSlot, spawn: (file, args, opts) => {
      const command = unwrapLowPriority(file, args);
      calls.push([command.file, ...command.args]);
      return passing(file, args, opts);
    } }), 0);
    assert.ok(calls.some(call => call.join(" ") === "npm run test:unit -- --maxWorkers=1"));
    assert.equal(calls.some(call => call.some(arg => /census|console-parity|diff-coverage/.test(arg))), false);
    assert.equal(JSON.parse(readFileSync(summary, "utf8")).qualityProfile, "craigoley/remudero-console");
    calls.length = 0;
    assert.equal(await preflightCommand(["--no-fast"], { spawn: (file, args, opts) => {
      calls.push([file, ...args]);
      return passing(file, args, opts);
    } }), 0);
    assert.ok(calls.some(call => call.includes(join(REPO_ROOT, "node_modules/.bin/tsc"))));
  } finally { console.log = log; }
});

test("W1-T10674: consumer failures and unavailable checks never become success", async t => {
  const f = fixture();
  t.after(() => f.cleanup());
  for (const response of [
    { status: 7, stdout: "", stderr: "fixture failure" },
    { status: null, stdout: "", stderr: "", error: "ENOENT" },
    { status: null, stdout: "", stderr: "", signal: "SIGKILL" },
  ]) {
    const result = runProjectPreflight(resolveProjectPreflight(f.dir), { testSlot: f.testSlot, spawn: (file, args, opts) => args.includes("typecheck") ? response : passing(file, args, opts) });
    assert.equal(result.ok, false);
    assert.equal(result.steps.find(step => step.name === "project:typecheck")?.ok, false);
    assert.equal(result.steps.find(step => step.name === "project:test:unit")?.ok, true);
  }
  const thrown = runProjectPreflight(resolveProjectPreflight(f.dir), { testSlot: f.testSlot, spawn: () => { throw new Error("fixture thrown spawn"); } });
  assert.equal(thrown.ok, false);
  assert.ok(thrown.steps.some(step => /fixture thrown spawn/.test(step.detail)));
  for (const options of [{ coverage: true }, { proofs: true }]) {
    assert.equal(runProjectPreflight(resolveProjectPreflight(f.dir, options), { spawn: passing }).ok, false);
  }
  const memoryUnknown = runProjectPreflight(resolveProjectPreflight(f.dir), { spawn: passing, testSlot: { memoryHeadroom: () => undefined } });
  assert.equal(memoryUnknown.ok, false);
  assert.match(memoryUnknown.steps.at(-1)!.detail, /memory headroom unavailable/);
  for (const memory of [NaN, Infinity, 0]) {
    const result = runProjectPreflight(resolveProjectPreflight(f.dir), { spawn: passing, testSlot: { ...f.testSlot, memoryHeadroom: () => memory } });
    assert.equal(result.ok, false);
    assert.match(result.steps.at(-1)!.detail, /memory/);
    assert.equal(result.steps.some(step => step.name === "project:typecheck"), false);
  }
  const slotRefused = runProjectPreflight(resolveProjectPreflight(f.dir), {
    spawn: passing, testSlot: { ...f.testSlot, dir: join(f.dir, "absent-parent"), privateCoordinationRequired: true, privateParentPolicy: "require-entry-protection" },
  });
  assert.equal(slotRefused.ok, false);
  assert.match(slotRefused.steps.at(-1)!.detail, /resource admission refused/);
  const slotThrows = runProjectPreflight(resolveProjectPreflight(f.dir), { spawn: passing, testSlot: { ...f.testSlot, maxConcurrency: 0 } });
  assert.equal(slotThrows.ok, false);
  assert.match(slotThrows.steps.at(-1)!.detail, /worker ceiling/);
  assert.equal(runProjectPreflight(resolveProjectPreflight(REPO_ROOT), { spawn: passing }).ok, false);
  rmSync(join(f.dir, "node_modules/.bin/vitest"));
  assert.equal(resolveProjectPreflight(f.dir).kind, "unavailable");
  f.put("node_modules/.bin/vitest", "stub");
  chmodSync(join(f.dir, "node_modules/.bin/vitest"), 0o755);
  f.put("package.json", "{");
  assert.equal(resolveProjectPreflight(f.dir).kind, "unavailable");
  f.put("package.json", JSON.stringify({ scripts: { ...consoleScripts, typecheck: "echo skipped" } }));
  assert.equal(resolveProjectPreflight(f.dir).kind, "unavailable");
  f.put("package.json", JSON.stringify({ scripts: consoleScripts }));
  f.put(".github/workflows/ci.yml", "jobs: {}");
  assert.equal(resolveProjectPreflight(f.dir).kind, "unavailable");
  f.put(".github/workflows/ci.yml", "jobs: [");
  assert.equal(resolveProjectPreflight(f.dir).kind, "unavailable");
  rmSync(join(f.dir, ".git"), { recursive: true, force: true });
  const unavailable = resolveProjectPreflight(f.dir);
  assert.equal(unavailable.kind, "unavailable");
  let calls = 0;
  const result = runProjectPreflight(unavailable, { spawn: () => { calls++; return passing("", []); } });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.match(result.steps[0]!.detail, /unavailable/i);
});
