/**
 * W1-T11553 criterion 1 — the resource-policy fixture reads its own meminfo and recorded peaks, never the host's.
 *
 * The policy advances each fleet container's recorded memory.peak from the running container's cgroup
 * (docker id -> RMD_CGROUP_ROOT scope). A fixture that leaves RMD_CGROUP_ROOT unset lets a host that
 * runs those containers overwrite the fixture's peaks. These drive the real policy through bash with a
 * fake docker on PATH and a fake cgroup tree holding a huge memory.peak.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ID = "ab".repeat(32);

function memoryMax(pinCgroup: boolean): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-independent-`));
  try {
    mkdirSync(join(root, "deploy"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "cgroup"), { recursive: true });
    const hostScope = join(root, "hostcg", "system.slice", `docker-${ID}.scope`);
    mkdirSync(hostScope, { recursive: true });
    writeFileSync(join(hostScope, "memory.peak"), `${20000 * 1024 * 1024}\n`); // the "host's" 20000 MiB
    copyFileSync(join(REPO_ROOT, "deploy", "resource-policy.sh"), join(root, "deploy", "resource-policy.sh"));
    writeFileSync(join(root, "meminfo"), "MemTotal:       16000000 kB\n");
    for (const [name, mib] of [["remudero-serve", 2048], ["remudero-console-daemon", 2048], ["remudero-site-daemon", 1024]] as const) {
      writeFileSync(join(root, "state", `memory-peak-${name}.json`), `{"container":"${name}","peak_mib":${mib}}\n`);
    }
    writeFileSync(join(root, "bin", "docker"), `#!/bin/sh\necho ${ID}\n`);
    chmodSync(join(root, "bin", "docker"), 0o755);
    const env: NodeJS.ProcessEnv = {
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      RMD_MEMINFO_PATH: join(root, "meminfo"),
      RMD_INSTANCE_REGISTRY: "",
      RMD_MEMORY_HIGH_TUNED_DIR: join(root, "state"),
      // The host's cgroup tree is reachable at hostcg; a pinned fixture points at an empty one instead.
      RMD_CGROUP_ROOT: join(root, pinCgroup ? "cgroup" : "hostcg"),
    };
    const script = `. "${join(root, "deploy", "resource-policy.sh")}"; resource_policy_shared_memory_max remudero-daemon; echo "$RP_MAX"`;
    return execFileSync("bash", ["-c", script], { encoding: "utf8", env }).trim().split("\n").pop()!;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T11553 criterion 1: the drift reader reads the fixture's peaks, not the host's", () => {
  // 15625 MiB - 2048 reserve - 5120 recorded peaks = 8457 MiB.
  assert.equal(memoryMax(true), "8457");
  // CONTROL: with the host's cgroup tree reachable the live peak replaces the fixture's.
  assert.notEqual(memoryMax(false), "8457");
});
