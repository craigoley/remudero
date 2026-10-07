/**
 * W1-T6090 — every test run in a container takes the host-wide slot, niced and bounded.
 *
 * (1) deploy/scratch-mounts.sh binds ONE host directory, `$(scratch_root)/rmd/test-slots`, into every
 * container at a fixed path and exports RMD_TEST_SLOT_DIR there, so src/lib/test-slot.ts in a daemon,
 * a serve and the host operator's own run all see the same slot files. The derived-env lists name it,
 * so the recycle's "running container carries a name the list does not" refusal stays consistent.
 * (2) the single-file `node --test` spawners — review proofs, the gate gardener's defuse run and the
 * census precheck — start under nice with an explicit --test-concurrency. They take NO slot: each is
 * one file (or a short census set), and a review waiting behind a coverage run is the starvation.
 *
 * The spawner tests run a REAL child whose own test reads its niceness and its runner's argv, so a
 * spawner that drops the wrapper fails here rather than in a fake's bookkeeping.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runSuiteShifted } from "../src/lib/gate-gardener.js";
// A NAMESPACE import, so a tree without proofChildCommand fails the tests below rather than the load.
import * as review from "../src/lib/review.js";
import { resolveTestSlotDir, TEST_RUN_NICENESS } from "../src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
// @ts-ignore the executable .mjs module has no declaration file.
import * as precheck from "../scripts/census-precheck.mjs";

const REPO_ROOT = join(import.meta.dirname, "..");
const LIB = join(REPO_ROOT, "deploy", "scratch-mounts.sh");
const SLOT_DEST = "/home/node/rmd-scratch/test-slots";

function scratch(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}test-slot-bind-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratchRoot = join(root, "mnt", "scratch");
  mkdirSync(scratchRoot, { recursive: true });
  for (const state of ["rmd-state2", "remudero-console-state"]) mkdirSync(join(root, state, "state"), { recursive: true });
  writeFileSync(join(root, "mounts"), `/dev/nvme1n1 ${scratchRoot} ext4 rw,noatime 0 0\n`);
  const env = { RMD_SCRATCH: "on", RMD_SCRATCH_ROOT: scratchRoot, RMD_SCRATCH_MOUNTS_FILE: join(root, "mounts") };
  return { root, scratchRoot, env };
}

/** scratch_plan (+ scratch_prepare when asked) for one state dir and container: its docker args and note. */
function plan(env: Record<string, string | undefined>, state: string, container: string, prepare = false) {
  const script = `. "${LIB}"; scratch_plan "$1" "$2"${prepare ? " && scratch_prepare" : ""}; ` +
    `printf '%s\\n' "\${SCRATCH_ARGS[@]+"\${SCRATCH_ARGS[@]}"}"; echo "NOTE $SCRATCH_NOTE"`;
  const r = spawnSync("bash", ["-c", script, "plan", state, container], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
  const lines = r.stdout.trim().split("\n");
  return { args: lines.filter((l) => !l.startsWith("NOTE ")), note: lines.find((l) => l.startsWith("NOTE ")) ?? "" };
}

/** The `-e NAME=` names in a docker argv. */
const envNames = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "-e" ? [a.split("=")[0]!] : []));

function bashArray(src: string, name: string): string[] {
  const body = src.match(new RegExp(`^${name}=\\(([^)]*)\\)`, "m"))?.[1];
  assert.ok(body !== undefined, `${name} is declared`);
  return body.split(/\s+/).filter(Boolean);
}

test("every container launch binds the shared test-slot directory and sets RMD_TEST_SLOT_DIR, and the derived-env lists name it", (t) => {
  const h = scratch(t);
  const env = { ...process.env, NODE_TEST_CONTEXT: undefined, ...h.env };
  const hostSlots = join(h.scratchRoot, "rmd", "test-slots");
  const daemon = plan(env, join(h.root, "rmd-state2"), "remudero-daemon");
  const serve = plan(env, join(h.root, "remudero-console-state"), "remudero-serve");
  for (const launch of [daemon, serve]) {
    const bind = launch.args.indexOf(`${hostSlots}:${SLOT_DEST}`);
    assert.ok(bind > 0 && launch.args[bind - 1] === "-v", `ONE host dir for every state dir and container: ${launch.args.join(" ")}`);
    assert.ok(launch.args.includes(`RMD_TEST_SLOT_DIR=${SLOT_DEST}`), "the env var names the bind's container side");
  }
  assert.deepEqual(resolveTestSlotDir({ RMD_TEST_SLOT_DIR: SLOT_DEST }), { dir: SLOT_DEST, scope: "configured" }, "inside the container test-slot.ts uses it");

  // Every derived name a launch sets is declared in BOTH copies of the derived list.
  const shared = bashArray(readFileSync(join(REPO_ROOT, "deploy", "runtime-env-vars.sh"), "utf8"), "RMD_DERIVED_RUNTIME_ENV_VARS");
  const fallback = bashArray(readFileSync(join(REPO_ROOT, "deploy", "recycle-container.sh"), "utf8"), "RMD_DERIVED_RUNTIME_ENV_VARS");
  assert.deepEqual(envNames(daemon.args).sort(), [...shared].sort(), "deploy/runtime-env-vars.sh names exactly what a launch derives");
  assert.deepEqual([...fallback].sort(), [...shared].sort(), "recycle-container.sh's fallback copy agrees");

  // #9697's rule holds: a test process without an explicit RMD_SCRATCH_ROOT plans no bind at all.
  const refused = plan({ ...env, RMD_SCRATCH_ROOT: undefined, NODE_TEST_CONTEXT: "child-v8" }, join(h.root, "rmd-state2"), "remudero-daemon");
  assert.deepEqual(refused.args, [], refused.note);
  assert.match(refused.note, /never uses the host's \/mnt\/scratch/);
});

test("the launch creates the shared slot dir open to every uid, a wipe restores it open, and an unwritable one degrades only the slot", (t) => {
  const h = scratch(t);
  const env = { ...process.env, NODE_TEST_CONTEXT: undefined, ...h.env };
  const state = join(h.root, "rmd-state2");
  const hostSlots = join(h.scratchRoot, "rmd", "test-slots");
  const prepared = plan(env, state, "remudero-daemon", true);
  assert.ok(prepared.args.includes(`RMD_TEST_SLOT_DIR=${SLOT_DEST}`), prepared.note);
  assert.equal(statSync(hostSlots).mode & 0o7777, 0o777, "0777 and not sticky: one uid must unlink another's dead record");
  assert.ok(readFileSync(join(state, ".scratch-mounts"), "utf8").split("\n").includes(hostSlots), "recorded for the boot restore");

  rmSync(join(h.scratchRoot, "rmd"), { recursive: true, force: true });
  const restored = spawnSync("bash", [LIB, "--restore", state], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(statSync(hostSlots).mode & 0o7777, 0o777, "a deallocate's restore re-opens it");

  // A slot path this launch cannot use (a FILE there: uid-independent) keeps every other bind.
  rmSync(hostSlots, { recursive: true, force: true });
  writeFileSync(hostSlots, "");
  const degraded = plan(env, state, "remudero-daemon", true);
  assert.match(degraded.note, /test-slots is not a writable directory, so test runs here go unslotted/);
  assert.ok(degraded.args.includes(`${join(h.scratchRoot, "rmd", "rmd-state2")}/worktrees:/home/node/Remudero/worktrees`), "the other binds stand");
});

/** A test file that records its niceness and its runner's argv, and FAILS unless it was niced and bounded. */
function priorityProbe(t: { after: (fn: () => void) => void }): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}test-slot-probe-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "probe.test.mjs");
  const parent = getPriority();
  writeFileSync(file, [
    `import { test } from "node:test";`,
    `import { execFileSync } from "node:child_process";`,
    `import { getPriority } from "node:os";`,
    `test("the runner was niced and bounded", () => {`,
    `  const runner = execFileSync("ps", ["-o", "args=", "-p", String(process.ppid)], { encoding: "utf8" }).trim();`,
    `  console.log("PROBE priority=" + getPriority() + " runner=" + runner);`,
    `  if (getPriority() < Math.min(19, ${parent} + ${TEST_RUN_NICENESS})) throw new Error("not niced: " + getPriority());`,
    `  if (!/--test-concurrency=[1-9]/.test(runner)) throw new Error("no explicit concurrency: " + runner);`,
    `});`,
    "",
  ].join("\n"));
  return { dir, file };
}

test("the review, gate-gardener and census-precheck test spawns start under nice with an explicit test concurrency", async (t) => {
  const { dir, file } = priorityProbe(t);
  const proofArgs = ["--test", "--test-reporter=tap", file];
  const sync = review.defaultProofSpawner(process.execPath, proofArgs, dir, 60_000);
  assert.match(sync, /# pass 1/, sync);
  assert.match(sync, /PROBE priority=\d+ runner=\S*node --test --test-concurrency=\d+/, sync);
  const asyncOut = await review.defaultAsyncProofSpawner(process.execPath, proofArgs, dir, 60_000);
  assert.match(asyncOut, /# pass 1/, asyncOut);

  // The defuse run uses the repo's own setup imports; it passes only when the probe saw nice and a bound.
  assert.equal(runSuiteShifted(REPO_ROOT, file, 0.001), true, "the gate gardener's defuse run is niced and bounded");

  // The census child, through its real default priority (test-slot.ts loaded via tsx's API).
  assert.deepEqual(precheck.runCensusSuitesViaChild({ root: dir, files: ["probe.test.mjs"] }), [], "the census suite child is niced and bounded");
});

test("a proof that is not a node --test run is spawned as given, and a census priority that cannot load says so", async () => {
  const load = { cores: 8, load1: 0 };
  assert.deepEqual(review.proofChildCommand("grep", ["-arn", "--", "x", "f"], load), { file: "grep", args: ["-arn", "--", "x", "f"] });
  assert.deepEqual(review.proofChildCommand("node", ["vitest.mjs", "run", "a.test.ts"], load), { file: "node", args: ["vitest.mjs", "run", "a.test.ts"] });
  const bare = review.proofChildCommand("node", ["--test", "a.test.ts"], load, () => false);
  assert.deepEqual(bare, { file: "node", args: ["--test", "--test-concurrency=3", "a.test.ts"], priority: "none" }, "no nice binary: bounded, and named");

  const unloadable = await precheck.loadTestPriority(async () => {
    throw new Error("no tsx");
  });
  assert.equal(unloadable.priority, "none");
  assert.match(unloadable.reason, /test-slot\.ts did not load \(no tsx\)/);
  assert.deepEqual(unloadable.wrap("node", ["--test"]), { file: "node", args: ["--test"] });
  const calls: string[] = [];
  const errors: string[] = [];
  const realError = console.error;
  console.error = (line: string) => void errors.push(line);
  try {
    precheck.runCensusSuitesViaChild({
      root: "/repo",
      files: ["a.test.ts"],
      priority: unloadable,
      run: (cmd: string) => {
        calls.push(cmd);
        return { status: 0, stdout: "# tests 1\n# pass 1\n# fail 0\n" };
      },
    });
  } finally {
    console.error = realError;
  }
  assert.deepEqual(calls, [process.execPath], "unwrapped when the priority could not load");
  assert.match(errors.join("\n"), /census suites run at default priority - test-slot\.ts did not load/);
});
