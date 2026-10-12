import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const SCRIPT = "deploy/install-host-units.sh";
const HOST_KB = 16371996; // the fleet host's MemTotal, read 2026-10-09 (15988 MiB)

function withTree(body: (root: string, run: (args: string[], env?: Record<string, string>) => ReturnType<typeof spawnSync>) => void): void {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}slice-cap-`));
  try {
    writeFileSync(join(root, "meminfo"), `MemTotal:       ${HOST_KB} kB\nMemFree:          100000 kB\n`);
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync("bash", [SCRIPT, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          RMD_UNIT_DIR: join(root, "systemd"),
          RMD_BIN_DIR: join(root, "bin"),
          RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"),
          RMD_REVIVAL_LOG: join(root, "revivals.log"),
          RMD_NODE_MAX_OLD_SPACE_MB: "8192",
          RMD_SERVICE_UID: "1000",
          RMD_MEMINFO_PATH: join(root, "meminfo"),
          ...env,
        },
      });
    body(root, run);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const dropinOf = (root: string) => join(root, "systemd", "user-1000.slice.d", "50-rmd-cap.conf");
const directives = (text: string) => text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));

test("the installer renders the session slice cap from host RAM, MemoryHigh only and never MemoryMax", () => {
  withTree((root, run) => {
    const check = run([]);
    assert.equal(check.status, 1);
    assert.match(String(check.stdout), new RegExp(`MISSING ${dropinOf(root).replace(/[.]/g, "\\.")}`), "a host without the cap is drift");
    const install = run(["--install"]);
    assert.equal(install.status, 0, String(install.stderr));
    const text = readFileSync(dropinOf(root), "utf8");
    assert.deepEqual(directives(text), ["[Slice]", "CPUWeight=30", "MemoryHigh=6G"], "weight 24/55 of the 13940 MiB budget, rounded to 256 MiB");
    assert.doesNotMatch(text, /MemoryMax/, "a hard ceiling would kill a session");
    assert.equal((statSync(dropinOf(root)).mode & 0o777).toString(8), "644");
    assert.equal(run([]).status, 0, "check after install is clean");
    // A larger host gets a larger cap from the same weights.
    writeFileSync(join(root, "meminfo"), "MemTotal:       65536000 kB\n");
    assert.equal(run([]).status, 1);
    run(["--install"]);
    assert.deepEqual(directives(readFileSync(dropinOf(root), "utf8")), ["[Slice]", "CPUWeight=30", "MemoryHigh=27136M"]);
  });
});

test("a current session slice cap is never rewritten, even the operator's hand-written one", () => {
  withTree((root, run) => {
    mkdirSync(join(root, "systemd", "user-1000.slice.d"), { recursive: true });
    const hand = "[Slice]\nCPUWeight=30\nMemoryHigh=6G\n";
    writeFileSync(dropinOf(root), hand);
    const before = statSync(dropinOf(root)).mtimeMs;
    const install = run(["--install"]);
    assert.equal(install.status, 0, String(install.stderr));
    assert.match(String(install.stdout), /ok {6}.*50-rmd-cap\.conf/);
    assert.equal(readFileSync(dropinOf(root), "utf8"), hand, "byte-identical: the current file was left alone");
    assert.equal(statSync(dropinOf(root)).mtimeMs, before);
    // A hand edit that drifts IS converged.
    writeFileSync(dropinOf(root), "[Slice]\nCPUWeight=100\nMemoryMax=4G\n");
    const drifted = run([]);
    assert.equal(drifted.status, 1);
    assert.match(String(drifted.stdout), /DRIFTED .*50-rmd-cap\.conf/);
    run(["--install"]);
    assert.deepEqual(directives(readFileSync(dropinOf(root), "utf8")), ["[Slice]", "CPUWeight=30", "MemoryHigh=6G"]);
  });
});

test("an unreadable MemTotal or an unknown service uid skips the cap rather than guessing it", () => {
  withTree((root, run) => {
    for (const env of <Array<Record<string, string>>>[{ RMD_MEMINFO_PATH: join(root, "absent") }, { RMD_SERVICE_UID: "", RMD_SERVICE_USER: "no-such-user-rmd-fixture" }]) {
      const install = run(["--install"], env);
      assert.equal(install.status, 0, String(install.stderr));
      assert.match(String(install.stdout), /skipped session slice cap/);
      assert.equal(existsSync(dropinOf(root)), false);
    }
  });
});
