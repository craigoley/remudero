/**
 * A TEST PROCESS NEVER PLANS A BIND UNDER THE HOST'S REAL SCRATCH ROOT.
 *
 * W1-T5631 (#9136) pointed RMD_SCRATCH_SWITCH at a dead path in test/setup/no-live-remote.ts, but that
 * setup only runs when the suite is started with `--import ./test/setup/tmp-hygiene.ts`. A bare
 * `node --import tsx --test test/recycle-container.test.ts` on the fleet host skips it, reads the host's
 * real switch file and /proc/mounts, and deploy/scratch-mounts.sh resolves the DEFAULT root
 * /mnt/scratch: on 2026-10-05/06 that left 68 `recycle-state-*` dirs (plus state-root, state-volume,
 * state_dir, brand-new-host, ...) under the real /mnt/scratch/rmd, after #9136 merged.
 *
 * The guard now lives in the lib itself: under the node test runner (NODE_TEST_CONTEXT) only an
 * explicit RMD_SCRATCH_ROOT is used. These probes call scratch_plan (which changes nothing on disk)
 * and --restore against a state dir with no manifest, so even the base tree writes nothing under
 * /mnt/scratch while it shows the leak.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const LIB = join(import.meta.dirname, "..", "deploy", "scratch-mounts.sh");
const REAL_ROOT = "/mnt/scratch";

interface LeakyHost {
  root: string;
  state: string;
  fixtureScratch: string;
  /** The env of a test process that never ran the shared setup, on a host whose /mnt/scratch is mounted. */
  env: NodeJS.ProcessEnv;
}

/** A host as a setup-less test process sees it: its switch file exists and the mounts table lists the
 *  REAL scratch root. RMD_SCRATCH_ROOT is unset, exactly as in the recycle fixtures that leaked. */
function leakyHost(t: { after: (fn: () => void) => void }): LeakyHost {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scratch-leak-host-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = mkdtempSync(join(root, "recycle-state-"));
  const fixtureScratch = join(root, "fixture-scratch");
  mkdirSync(fixtureScratch);
  const switchFile = join(root, "scratch-mounts.on");
  writeFileSync(switchFile, "");
  const mounts = join(root, "mounts");
  writeFileSync(mounts, `/dev/nvme1n1 ${REAL_ROOT} ext4 rw,noatime 0 0\n/dev/nvme1n1 ${fixtureScratch} ext4 rw 0 0\n`);
  return {
    root, state, fixtureScratch,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_TEST_CONTEXT: "child-v8",
      RMD_SCRATCH_SWITCH: switchFile,
      RMD_SCRATCH_MOUNTS_FILE: mounts,
    },
  };
}

function plan(env: NodeJS.ProcessEnv, state: string): { status: number; args: string[]; note: string } {
  const script = `. '${LIB}'; scratch_plan "$1" remudero-daemon; s=$?; printf '%s\\n' "\${SCRATCH_ARGS[@]+"\${SCRATCH_ARGS[@]}"}"; echo "NOTE $SCRATCH_NOTE"; echo "STATUS $s"`;
  const r = spawnSync("bash", ["-c", script, "plan", state], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  return {
    status: Number(lines.find((l) => l.startsWith("STATUS "))?.slice(7)),
    args: lines.filter((l) => l !== "" && !l.startsWith("NOTE ") && !l.startsWith("STATUS ")),
    note: lines.find((l) => l.startsWith("NOTE ")) ?? "",
  };
}

test("a setup-less test process plans no scratch bind under the host's real /mnt/scratch", (t) => {
  const host = leakyHost(t);
  const leak = plan(host.env, host.state);
  assert.equal(leak.status, 1, `the plan must refuse: ${JSON.stringify(leak)}`);
  assert.deepEqual(leak.args, [], "no bind under the real scratch root");
  assert.match(leak.note, /NODE_TEST_CONTEXT/);
  assert.match(leak.note, /RMD_SCRATCH_ROOT/);
});

test("a test naming its own RMD_SCRATCH_ROOT still plans its binds, and production keeps the default", (t) => {
  const host = leakyHost(t);
  // Positive control 1: the refusal is about the DEFAULT root only — a fixture root is honoured.
  const own = plan({ ...host.env, RMD_SCRATCH_ROOT: host.fixtureScratch }, host.state);
  assert.equal(own.status, 0, own.note);
  assert.ok(own.args.includes(`${host.fixtureScratch}/rmd/${host.state.split("/").pop()}/worktrees:/home/node/Remudero/worktrees`), JSON.stringify(own.args));
  // Positive control 2: outside the test runner (a real recycle) the default root still plans, so the
  // probe above can see a bind under /mnt/scratch when one would be made.
  const prod = { ...host.env };
  delete prod.NODE_TEST_CONTEXT;
  const real = plan(prod, host.state);
  assert.equal(real.status, 0, real.note);
  assert.ok(real.args.some((a) => a.startsWith(`${REAL_ROOT}/rmd/recycle-state-`)), JSON.stringify(real.args));
  assert.deepEqual(readdirSync(host.fixtureScratch), [], "planning creates nothing");
});

test("a setup-less test process restores nothing under the host's real /mnt/scratch", (t) => {
  const host = leakyHost(t);
  const r = spawnSync("bash", [LIB, "--restore", host.state], { encoding: "utf8", env: host.env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NODE_TEST_CONTEXT.*nothing restored/);
  assert.doesNotMatch(r.stdout, /no .*\.scratch-mounts; nothing to restore/, "it must not reach the manifest read");
});
