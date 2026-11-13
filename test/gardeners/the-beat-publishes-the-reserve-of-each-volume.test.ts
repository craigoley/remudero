import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseHeartbeatPayload } from "#src/lib/host-resource-gardener.js";
import { runBeat, type BeatOpts } from "#test/helpers/fleet-heartbeat-harness.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const dfStub = `#!/usr/bin/env bash
target="\${@: -1}"
case "$target" in
  /) dev=/dev/root; total="\${ROOT_TOTAL-100000000}" ;;
  /mnt/rmd) dev=/dev/state; total=200000000 ;;
  "$RMD_ROOT") dev="\${STATE_DEVICE-/dev/state}"; total="\${STATE_TOTAL-200000000}" ;;
  /strict-root) dev=/dev/root; total=100000000 ;;
  /strict-state) dev=/dev/state; total=200000000 ;;
  *) exit 1 ;;
esac
[ "$total" != unreadable ] || exit 1
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n%s %s 1000 500000 90%% %s\\n' "$dev" "$total" "$target"
`;

function beat(env: Record<string, string> = {}, opts: BeatOpts = {}): Record<string, string> {
  const result = runBeat({
    dfStub, unameStub: "#!/bin/sh\necho Linux\n", ...opts,
    env: { HIGH_WATER: "", ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return parseHeartbeatPayload(result.published);
}

test("W1-T12253 criterion 1: published reserves follow distinct devices", () => {
  const distinct = beat();
  assert.equal(distinct.root_fs_reserve_kb, "15000000");
  assert.equal(distinct.state_fs_reserve_kb, "30000000");
  assert.equal(distinct.root_fs_free_kb, "500000");
  assert.equal(distinct.state_fs_free_kb, "500000");
  const shared = beat({ STATE_DEVICE: "/dev/root", STATE_TOTAL: "100000000" });
  assert.equal(shared.root_fs_reserve_kb, "15000000");
  assert.equal(Object.hasOwn(shared, "state_fs_reserve_kb"), false);
});

test("W1-T12253 criterion 2: macOS reserves are unknown regardless of Linux marks", () => {
  const mac = beat({ HIGH_WATER: "50", RMD_CLEANUP_WATCH_FS: "/mnt/rmd:60/40G" }, {
    unameStub: "#!/bin/sh\necho Darwin\n",
  });
  assert.equal(mac.root_fs_reserve_kb, "unknown");
  assert.equal(mac.state_fs_reserve_kb, "unknown");
});

test("W1-T12253 criterion 3: Linux reserves use the stricter percent and free-space marks per device", () => {
  for (const [free, expected] of [["40000000", "40000000"], ["40000000K", "40000000"],
    ["40000M", "40960000"], ["40G", "41943040"], ["1T", "1073741824"], ["1G", "40000000"]]) {
    const marked = beat({ HIGH_WATER: "80", RMD_CLEANUP_WATCH_FS: `/mnt/rmd:80/${free}` });
    assert.equal(marked.root_fs_reserve_kb, "20000000");
    assert.equal(marked.state_fs_reserve_kb, expected, free);
  }
  const aliases = beat({ HIGH_WATER: "99",
    RMD_CLEANUP_WATCH_FS: "/:90/1G /strict-root:75 /mnt/rmd:90/40G /strict-state:70" });
  assert.equal(aliases.root_fs_reserve_kb, "25000000", "an explicit root mark replaces HIGH_WATER");
  assert.equal(aliases.state_fs_reserve_kb, "60000000", "aliases combine their strictest marks");
  assert.equal(beat({ RMD_CLEANUP_WATCH_FS: "" }).state_fs_reserve_kb, "unknown",
    "an unwatched device has no janitor reserve to report");
});

test("W1-T12253 criterion 4: heartbeat defaults equal the host janitor defaults", () => {
  const janitor = readFileSync(join(REPO_ROOT, "deploy/rmd-host-cleanup.sh"), "utf8");
  const highWater = /HIGH_WATER="\$\{HIGH_WATER:-([0-9]+)\}"/.exec(janitor)?.[1];
  const watch = /WATCH_FS="([^"\n]*\/mnt\/rmd:[^"\n]+)"/.exec(janitor)?.[1];
  assert.equal(highWater, "85");
  assert.equal(watch, "/mnt/rmd:85 /mnt/scratch:90/40G");
  const implicit = beat();
  const explicit = beat({ HIGH_WATER: highWater!, RMD_CLEANUP_WATCH_FS: watch! });
  assert.equal(implicit.root_fs_reserve_kb, explicit.root_fs_reserve_kb);
  assert.equal(implicit.state_fs_reserve_kb, explicit.state_fs_reserve_kb);
  const onScratch = { STATE_DEVICE: "/dev/scratch", STATE_TOTAL: "200000000" };
  const scratchDf = dfStub.replace("  /strict-root)", "  /mnt/scratch) dev=/dev/scratch; total=\"${STATE_TOTAL-200000000}\" ;;\n  /strict-root)");
  const scratchImplicit = beat(onScratch, { dfStub: scratchDf });
  const scratchExplicit = beat({ ...onScratch, HIGH_WATER: highWater!, RMD_CLEANUP_WATCH_FS: watch! }, { dfStub: scratchDf });
  assert.equal(scratchImplicit.state_fs_reserve_kb, "41943040");
  assert.equal(scratchImplicit.state_fs_reserve_kb, scratchExplicit.state_fs_reserve_kb);
  const large = { ...onScratch, STATE_TOTAL: "1000000000" };
  const largeImplicit = beat(large, { dfStub: scratchDf });
  const largeExplicit = beat({ ...large, HIGH_WATER: highWater!, RMD_CLEANUP_WATCH_FS: watch! }, { dfStub: scratchDf });
  assert.equal(largeImplicit.state_fs_reserve_kb, "100000000");
  assert.equal(largeImplicit.state_fs_reserve_kb, largeExplicit.state_fs_reserve_kb);
});

test("W1-T12253 criterion 5: an unreadable volume size never borrows another volume's reserve", () => {
  for (const value of ["unreadable", "junk", "0"]) {
    const rootUnknown = beat({ ROOT_TOTAL: value });
    assert.equal(rootUnknown.root_fs_reserve_kb, "unknown", value);
    assert.equal(rootUnknown.state_fs_reserve_kb, "30000000");
    const stateUnknown = beat({ STATE_TOTAL: value });
    assert.equal(stateUnknown.root_fs_reserve_kb, "15000000");
    assert.equal(stateUnknown.state_fs_reserve_kb, "unknown", value);
  }
  const blind = beat({}, { dfStub: "#!/bin/sh\nexit 1\n" });
  assert.equal(blind.root_fs_reserve_kb, "unknown");
  assert.equal(blind.state_fs_reserve_kb, "unknown");
});

test("W1-T12253: malformed Linux marks preserve heartbeat liveness and publish unknown reserves", () => {
  for (const mark of ["oops", "/mnt/rmd:101", "/mnt/rmd:80/bad", "/mnt/rmd:80/1GG"]) {
    const invalid = beat({ RMD_CLEANUP_WATCH_FS: mark });
    assert.equal(invalid.state_fs_reserve_kb, "unknown", mark);
  }
  assert.equal(beat({ HIGH_WATER: "invalid" }).root_fs_reserve_kb, "unknown");
});
