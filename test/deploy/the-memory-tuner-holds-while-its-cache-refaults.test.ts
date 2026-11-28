import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TUNER = join(REPO_ROOT, "deploy/memory-high-tuner.sh");
const MIB = 1024 * 1024;
const LIVE = 19988;
const SWAP_CAP = 2048 * MIB;
const CONTAINER = "remudero-serve";
const ID = "a".repeat(64);
const NOW = 1_800_000_000;

function host(t: TestContext, options: { severe?: boolean; policy?: number; interval?: number } = {}) {
  const { dir } = ownedFixtureDir(t, "memory-high-refaults");
  const bin = join(dir, "bin");
  const cg = join(dir, "cg", "docker", ID);
  const state = join(dir, "state");
  for (const path of [bin, cg, state]) mkdirSync(path, { recursive: true });
  writeFileSync(join(bin, "docker"), [
    "#!/usr/bin/env bash",
    'case "$1" in',
    `  inspect) echo '${ID}' ;;`,
    `  ps) echo '${CONTAINER} ${ID}' ;;`,
    "  *) exit 1 ;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(bin, "date"), `#!/usr/bin/env bash\nprintf '%s\\n' '${NOW}'\n`, { mode: 0o755 });
  writeFileSync(join(dir, "meminfo"), "MemTotal: 33554432 kB\nMemAvailable: 1024000 kB\n");
  writeFileSync(join(dir, "vmstat"), "pswpin 0\nallocstall_normal 0\n");
  writeFileSync(join(dir, "psi"), `full avg10=${options.severe ? "1.00" : "0.00"}\n`);
  const then = NOW - (options.interval ?? 300);
  writeFileSync(join(state, `memory-high-sample-${CONTAINER}.txt`), `v1 ${then} ${ID} 0 0 0 0 0 0\n`);

  const put = (name: string, value: number | string) => writeFileSync(join(cg, name), `${value}\n`);
  const stat = (refaultMib: number, inactive: number | string = 870 * MIB) => put("memory.stat", [
    `anon ${16218 * MIB}`, `file ${870 * MIB}`, `inactive_file ${inactive}`,
    `workingset_refault_file ${refaultMib * 256}`,
  ].join("\n"));
  put("memory.high", LIVE * MIB);
  put("memory.max", 28058 * MIB);
  put("memory.current", LIVE * MIB);
  put("memory.swap.current", SWAP_CAP);
  put("memory.swap.max", SWAP_CAP);
  put("memory.events", "high 1");
  stat(0);
  return {
    cg, put, stat,
    tick() {
      const output = execFileSync("bash", [TUNER, "--container", CONTAINER, "--state-dir", dir], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          RMD_CGROUP_ROOT: join(dir, "cg"),
          RMD_MEMINFO_PATH: join(dir, "meminfo"),
          RMD_VMSTAT_PATH: join(dir, "vmstat"),
          RMD_HOST_PSI_MEMORY_PATH: join(dir, "psi"),
          RMD_MEMORY_HIGH_SUDO: "env",
          RMD_MEMORY_HIGH_STEP_MIB: "256",
          RMD_SERVE_MEMORY_LIMIT_MIB: "28058",
          RMD_HOST_RESERVE_MIB: "2048",
          RMD_MEMORY_HIGH_FLOORS: `${CONTAINER}=${options.policy ?? 15503}`,
        },
      });
      const high = Number(readFileSync(join(cg, "memory.high"), "utf8")) / MIB;
      return { output, high };
    },
  };
}

test("W1-T15182 criterion 1: tier 2 and tier 3 hold a shrink when file refaults reach the reclaim volume", (t) => {
  for (const severe of [false, true]) {
    const h = host(t, { severe });
    h.stat(7913);
    const { output, high } = h.tick();
    assert.match(output, /hold at 19988 MiB/);
    assert.match(output, new RegExp(`tier ${severe ? 3 : 2}`));
    assert.match(output, /7913 MiB (?:of )?file refaults per 5 min/);
    assert.equal(high, LIVE);
  }

  for (const refaultMib of [255, 256]) {
    const h = host(t);
    h.stat(refaultMib);
    const { output, high } = h.tick();
    if (refaultMib === 256) {
      assert.match(output, /hold.*256 MiB (?:of )?file refaults per 5 min/);
      assert.equal(high, LIVE);
    } else {
      assert.match(output, /shrink/);
      assert.equal(high, LIVE - 256);
    }
  }

  const shorterInterval = host(t, { interval: 150 });
  shorterInterval.stat(128);
  assert.equal(shorterInterval.tick().high, LIVE - 256, "128 MiB refaulted over this interval");

  const cacheBound = host(t, { severe: true });
  cacheBound.put("memory.swap.max", "max");
  cacheBound.stat(870);
  const { output, high } = cacheBound.tick();
  assert.match(output, /hold.*870 MiB (?:of )?file refaults per 5 min/);
  assert.equal(high, LIVE, "the file cache is smaller than the tier-3 step");
});

test("W1-T15182 criterion 2: full swap bounds a shrink by inactive file pages and the policy floor", (t) => {
  for (const severe of [false, true]) {
    const h = host(t, { severe });
    h.put("memory.current", 19968 * MIB + 1);
    h.stat(0, 512 * MIB);
    const { output, high } = h.tick();
    assert.match(output, /shrink/);
    assert.equal(high, 19968, "19,712 MiB plus one byte rounds up to the next quantum");
  }

  const policy = host(t, { severe: true, policy: 19800 });
  policy.put("memory.current", 19300 * MIB);
  assert.equal(policy.tick().high, 19800);

  const noRoom = host(t, { severe: true });
  noRoom.stat(0, 0);
  assert.equal(noRoom.tick().high, LIVE);

  for (const swapMax of ["max", SWAP_CAP + 1]) {
    const room = host(t, { severe: true });
    room.put("memory.swap.max", swapMax);
    room.stat(0, 0);
    assert.equal(room.tick().high, 17684, "swap still has room");
  }
});

test("W1-T15182 criterion 3: missing or malformed shrink counters hold the live limit", (t) => {
  for (const counter of ["inactive_file", "memory.swap.current", "memory.swap.max", "memory.current"]) {
    for (const malformed of [false, true]) {
      const h = host(t, { severe: true });
      if (counter === "inactive_file") {
        if (malformed) h.stat(0, "invalid");
        else h.put("memory.stat", `anon ${16218 * MIB}\nfile ${870 * MIB}\nworkingset_refault_file 0`);
      } else if (malformed) {
        h.put(counter, "invalid");
      } else {
        rmSync(join(h.cg, counter));
      }
      const { output, high } = h.tick();
      assert.match(output, /hold.*unreadable/, counter);
      assert.equal(high, LIVE, counter);
    }
  }
});
