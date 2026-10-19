// test/a-serve-slot-builds-its-worker-bundles.test.ts — W1-T9421.
//
// A serve slot is a git worktree plus `npm ci`, so it never held dist/child-entries, and W1-T9370 starts a serve worker
// from a bundle only when the worker's own tree holds a current one. The slot preparer and the cold start now run the
// tree's own scripts/build-child-entries.mjs after the install. These tests drive real git slots and a real child
// process; the fixture's build script stands in for esbuild by writing the manifest where the real one writes it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { hashInstallInputs, installHashMarkerPath } from "../src/lib/install-hash.js";
import { buildSlotChildEntries, CHILD_ENTRY_BUILD_SCRIPT, createSlotPreparer, runCommand, type RunCommand } from "../src/lib/serve-slots.js";
import type { ServeSupervisor } from "../src/lib/serve-supervisor.js";
import { runServeSupervisor } from "../src/lib/serve-supervisor-main.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const BUILDS = [
  'import { mkdirSync, writeFileSync } from "node:fs";',
  'mkdirSync("dist/child-entries", { recursive: true });',
  'writeFileSync("dist/child-entries/manifest.json", JSON.stringify({ builtIn: process.cwd() }));',
].join("\n");
const FAILS = 'process.stderr.write("CHILD-ENTRY BUILD FAILED: boom\\n"); process.exit(1);';

/** Every command runs for real except `npm`, which is answered without the network. */
const run: RunCommand = async (command, args, cwd) => (command === "npm" ? "" : runCommand(command, args, cwd));

function commitScript(origin: ReturnType<typeof gitRepo>, body: string | undefined, message: string): void {
  if (body === undefined) origin.git("rm", "--quiet", CHILD_ENTRY_BUILD_SCRIPT);
  else {
    mkdirSync(join(origin.dir, "scripts"), { recursive: true });
    writeFileSync(join(origin.dir, CHILD_ENTRY_BUILD_SCRIPT), `${body}\n`);
    origin.git("add", "-A");
  }
  origin.git("commit", "--quiet", "-m", message);
}

test("W1-T9421: a prepared serve slot builds its worker bundles", async () => {
  const origin = gitRepo({ kind: "slot-build-origin" });
  writeFileSync(join(origin.dir, "package.json"), '{"name":"slot","type":"module"}\n');
  writeFileSync(join(origin.dir, "package-lock.json"), "lock-1");
  commitScript(origin, BUILDS, "v1");
  const serving = gitRepo({ kind: "slot-build-serving", cloneFrom: origin.dir });
  mkdirSync(join(serving.dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(installHashMarkerPath(serving.dir), hashInstallInputs(serving.dir));
  const gensDir = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gens-`)), "gens");
  const rows: Array<Record<string, unknown>> = [];
  const prepare = createSlotPreparer({ repoDir: serving.dir, gensDir, run, log: (step, extra) => void (step === "serve.slot_child_entries" && rows.push(extra ?? {})) });

  // 1. The slot's own build runs in the slot, after its install, and is ledgered.
  const first = await prepare(serving.dir);
  const manifest = join(first.dir, "dist", "child-entries", "manifest.json");
  assert.ok(existsSync(manifest), "the prepared slot holds its child-entry manifest");
  assert.equal(JSON.parse(readFileSync(manifest, "utf8")).builtIn, first.dir, "the build ran with the slot as its working directory");
  // W1-T10058: the fixture's script exports no validators, so nothing qualifies its build for reuse and it is built.
  assert.deepEqual({ ...rows[0], ms: 0 }, { slot: first.dir, sha: first.sha, outcome: "built", reused: false, stale: "check-unsupported", ms: 0 });

  // 2. A failing build is ledgered with its first line, and the slot is still returned.
  commitScript(origin, FAILS, "v2");
  const second = await prepare(first.dir);
  assert.equal(second.sha, origin.git("rev-parse", "HEAD"));
  assert.equal(rows[1]?.outcome, "failed");
  assert.match(String(rows[1]?.reason), /CHILD-ENTRY BUILD FAILED: boom/);

  // 3. A tree that predates the script: nothing runs.
  commitScript(origin, undefined, "v3");
  const third = await prepare(second.dir);
  assert.equal(third.sha, origin.git("rev-parse", "HEAD"));
  assert.equal(rows[2]?.outcome, "absent");
  assert.equal(rows[2]?.reason, undefined);
});

test("the cold checkout's build is reported with the supervisor's start", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cold-build-`));
  writeFileSync(join(repoDir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(repoDir, "package-lock.json"), "lock");
  mkdirSync(join(repoDir, "scripts"));
  writeFileSync(join(repoDir, CHILD_ENTRY_BUILD_SCRIPT), `${BUILDS}\n`);
  const started: Array<Record<string, unknown>> = [];
  const fake: ServeSupervisor = { start: async () => {}, requestHandoff: async () => {}, shutdown: async () => {}, activeSha: () => undefined };
  await runServeSupervisor(["--", "serve"], {
    env: { RMD_SERVE_GENS_DIR: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gens-`)) },
    cwd: repoDir,
    run: async (command, args, cwd) => (command === "npm" ? (mkdirSync(join(cwd, "node_modules"), { recursive: true }), "") : runCommand(command, args, cwd)),
    headSha: () => "abc123",
    log: (step, extra) => void (step === "serve.supervisor_start" && started.push(extra ?? {})),
    create: () => fake,
    onSignal: () => {},
  });
  assert.equal((started[0]?.coldChildEntries as { outcome?: string } | undefined)?.outcome, "built");
  assert.ok(existsSync(join(repoDir, "dist", "child-entries", "manifest.json")));
});

test("a build that throws a non-Error still reads failed, with its time", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}slot-build-`));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, CHILD_ENTRY_BUILD_SCRIPT), "\n");
  let at = 100;
  const verdict = await buildSlotChildEntries(dir, async () => { at += 40; throw "killed\nby a signal"; }, clockFromMillisFn(() => at));
  // W1-T10058: the time covers the failed reuse check (40) and the failed build (40).
  assert.deepEqual(verdict, { outcome: "failed", reason: "killed", ms: 80 });
});

test("a failed child-entry build keeps stderr ahead of a long command context", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}slot-reason-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "long-slot-".repeat(20));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, CHILD_ENTRY_BUILD_SCRIPT), FAILS);
  assert.ok(`${process.execPath} ${CHILD_ENTRY_BUILD_SCRIPT} failed in ${dir}: `.length > 200);
  const verdict = await buildSlotChildEntries(dir);
  assert.equal(verdict.outcome, "failed");
  assert.equal(verdict.reason, "CHILD-ENTRY BUILD FAILED: boom");
  await assert.rejects(runCommand(process.execPath, [CHILD_ENTRY_BUILD_SCRIPT], dir), (error: Error) => {
    assert.equal(error.message.split("\n")[0], "CHILD-ENTRY BUILD FAILED: boom");
    assert.ok(error.message.includes(`${process.execPath} ${CHILD_ENTRY_BUILD_SCRIPT} failed in ${dir}`), "full command context remains available");
    return true;
  });
});

test("a silent child-entry failure names its exit, spawn error or signal before path context", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}slot-silent-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "long-slot-".repeat(20));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, CHILD_ENTRY_BUILD_SCRIPT), "process.exit(7);\n");
  assert.match(String((await buildSlotChildEntries(dir)).reason), /^7: /);
  await assert.rejects(runCommand(join(dir, "no-such-executable"), [], dir), (error: Error) => {
    assert.match(error.message, /^ENOENT: /);
    assert.ok(error.message.includes(`failed in ${dir}`));
    return true;
  });
  writeFileSync(join(dir, CHILD_ENTRY_BUILD_SCRIPT), 'process.kill(process.pid, "SIGTERM");\n');
  assert.match(String((await buildSlotChildEntries(dir)).reason), /^SIGTERM: /);
});
