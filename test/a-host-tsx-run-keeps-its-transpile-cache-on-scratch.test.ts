// tsx keeps its transpile cache in os.tmpdir()/tsx-<uid> and has no cache-dir setting. The fleet
// launcher (rmd-relaunch.sh, run by rmd-fleet.service and the five-minute watchdog timer) is the
// HOST process that runs tsx: every tick execs bin/rmd progress-watchdog and bin/rmd deploy-run.
// systemd gives it no TMPDIR, so on 2026-10-06 /tmp/tsx-1000 held 2.7 GB on the 29 GB root disk
// (root at 91%) and grew ~2 GB/day. These cases run the RENDERED launcher's healthy tick with a
// stub bin/rmd that records the TMPDIR each tsx run would see.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = "deploy/install-host-units.sh";

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

interface Tick {
  status: number | null;
  stderr: string;
  /** One line per bin/rmd call: its verb and the TMPDIR it saw. */
  calls: string[];
}

/** Render the launcher into `root`, then run its healthy (daemon running), non-boot tick. */
function runHealthyTick(root: string, env: Record<string, string>): Tick {
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "remudero", "bin"), { recursive: true });
  const rmdLog = join(root, "rmd-calls.log");
  writeExecutable(
    join(stateDir, "remudero", "bin", "rmd"),
    `#!/usr/bin/env bash\necho "$1 TMPDIR=\${TMPDIR-unset}" >> "${rmdLog}"\nexit 0\n`,
  );
  const stubDir = join(root, "stubbin");
  mkdirSync(stubDir, { recursive: true });
  writeExecutable(
    join(stubDir, "docker"),
    `#!/usr/bin/env bash\nif [ "\${1:-}" = "ps" ]; then echo fake-container-id; fi\nexit 0\n`,
  );
  const render = spawnSync("bash", [SCRIPT, "--install"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_UNIT_DIR: join(root, "systemd"),
      RMD_BIN_DIR: join(root, "bin"),
      RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"),
      RMD_REVIVAL_LOG: join(root, "revivals.log"),
      RMD_NODE_MAX_OLD_SPACE_MB: "8192",
      RMD_STATE_DIR: stateDir,
    },
  });
  assert.equal(render.status, 0, `render failed: ${render.stderr}`);

  // systemd starts the launcher with no TMPDIR; macOS and some CI shells set one.
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "TMPDIR") base[k] = v;
  const r = spawnSync("bash", [join(root, "rmd-relaunch.sh")], {
    encoding: "utf8",
    env: { ...base, PATH: `${stubDir}:${process.env.PATH}`, ...env },
  });
  const calls = existsSync(rmdLog) ? readFileSync(rmdLog, "utf8").trim().split("\n") : [];
  return { status: r.status, stderr: r.stderr, calls };
}

function withRoot(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rmd-tsx-tmpdir-"));
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A /proc/mounts-shaped file listing `/` and, when given, the scratch root. */
function mountsFile(root: string, scratchRoot?: string): string {
  const path = join(root, "mounts");
  const lines = ["/dev/root / ext4 rw,relatime 0 0"];
  if (scratchRoot) lines.push(`/dev/nvme1n1 ${scratchRoot} ext4 rw,relatime 0 0`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

test("a host tsx run exports TMPDIR=/mnt/scratch/tmp only while scratch is a mounted filesystem", () => {
  withRoot((root) => {
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const callLog = join(root, "rmd-calls.log");

    // NOT MOUNTED: a bare directory at the scratch path sits on the root disk, and a missing
    // mounts file is unknown. Both keep the default and neither may fail the tick.
    for (const mounts of [mountsFile(root), join(root, "no-such-mounts-file")]) {
      rmSync(callLog, { force: true });
      const tick = runHealthyTick(root, { RMD_SCRATCH_ROOT: scratch, RMD_SCRATCH_MOUNTS_FILE: mounts });
      assert.equal(tick.status, 0, `scratch absence must never fail the tick: ${tick.stderr}`);
      assert.deepEqual(tick.calls, ["progress-watchdog TMPDIR=unset", "deploy-run TMPDIR=unset"], mounts);
      assert.equal(existsSync(join(scratch, "tmp")), false, "nothing is created on an unmounted scratch path");
    }

    // MOUNTED: both tsx runs of the tick, so a check that only the last one moved cannot pass.
    rmSync(callLog, { force: true });
    const tick = runHealthyTick(root, {
      RMD_SCRATCH_ROOT: scratch,
      RMD_SCRATCH_MOUNTS_FILE: mountsFile(root, scratch),
    });
    assert.equal(tick.status, 0, `launcher failed: ${tick.stderr}`);
    assert.deepEqual(tick.calls, [
      `progress-watchdog TMPDIR=${scratch}/tmp`,
      `deploy-run TMPDIR=${scratch}/tmp`,
    ]);
    // A wiped scratch disk has no tmp dir; the launcher makes it sticky and world-writable like /tmp.
    assert.equal(statSync(join(scratch, "tmp")).mode & 0o7777, 0o1777);
  });
});

test("a host tsx run keeps an explicitly set TMPDIR even with scratch mounted", () => {
  withRoot((root) => {
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const chosen = join(root, "chosen-tmp");
    mkdirSync(chosen);
    const tick = runHealthyTick(root, {
      RMD_SCRATCH_ROOT: scratch,
      RMD_SCRATCH_MOUNTS_FILE: mountsFile(root, scratch),
      TMPDIR: chosen,
    });
    assert.equal(tick.status, 0, `launcher failed: ${tick.stderr}`);
    assert.deepEqual(tick.calls, [`progress-watchdog TMPDIR=${chosen}`, `deploy-run TMPDIR=${chosen}`]);
  });
});
