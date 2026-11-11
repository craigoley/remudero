/**
 * W1-T12027 — the memory-budget suites read no running container's limit.
 *
 * OBSERVED 2026-11-10 on the Azure host: test/the-instances-share-one-host-memory-budget.test.ts failed
 * alone on current main with memory.max 25921847296, the limit the live remudero-daemon container runs
 * with, where the fixture's 15.6 GiB host gives 8589934592. The fixture passed the real PATH and set no
 * cgroup root, so the policy's overcommitted branch read the live container. Two more suites read the
 * live peers' recorded peaks through the checkout's instance registry. These drive the real policy
 * through bash with a fake docker, a cgroup tree and a registry that all describe a much larger fleet.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { hostIndependentPolicyEnv } from "#test/helpers/host-independent-policy-env.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ID = "cd".repeat(32);
const FLOOR_MIB = 8192; // remudero-daemon's RMD_MEMORY_HIGH_FLOORS entry
const RUNNING_MIB = 24721; // what the "live" container runs with

/** remudero-daemon's memory.max on a 15.6 GiB fixture host, beside a hostile host; `leak` unpins one input. */
function memoryMax(leak: "none" | "cgroup" | "registry"): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}no-running-limit-`));
  try {
    mkdirSync(join(root, "deploy"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    copyFileSync(join(REPO_ROOT, "deploy", "resource-policy.sh"), join(root, "deploy", "resource-policy.sh"));
    writeFileSync(join(root, "meminfo"), "MemTotal:       16371996 kB\n");
    // The hostile host: docker reports a running container, whose cgroup holds a 24721 MiB memory.max ...
    writeFileSync(join(root, "bin", "docker"), `#!/bin/sh\necho ${ID}\n`);
    chmodSync(join(root, "bin", "docker"), 0o755);
    const scope = join(root, "hostcg", "system.slice", `docker-${ID}.scope`);
    mkdirSync(scope, { recursive: true });
    writeFileSync(join(scope, "memory.max"), `${RUNNING_MIB * 1024 * 1024}\n`);
    // ... and a registry whose core state root records a 20000 MiB peak for the container.
    const peer = join(root, "peer-state");
    mkdirSync(join(peer, "state"), { recursive: true });
    writeFileSync(join(peer, "state", "memory-peak-remudero-daemon.json"), '{"container":"remudero-daemon","peak_mib":20000}\n');
    const registry = join(root, "hostile-registry.yaml");
    writeFileSync(registry, `instances:\n  core:\n    container_name: remudero-daemon\n    state_dir: ${peer}\n`);
    const pins = hostIndependentPolicyEnv(root);
    const env: NodeJS.ProcessEnv = {
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      RMD_MEMINFO_PATH: join(root, "meminfo"),
      ...pins,
      ...(leak === "cgroup" ? { RMD_CGROUP_ROOT: join(root, "hostcg") } : {}),
      ...(leak === "registry" ? { RMD_RESOURCE_POLICY_REGISTRY: registry } : {}),
    };
    const script = `. "${join(root, "deploy", "resource-policy.sh")}"; resource_policy_shared_memory_max remudero-daemon; echo "$RP_MAX"`;
    return execFileSync("bash", ["-c", script], { encoding: "utf8", env }).trim().split("\n").pop()!;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T12027 criterion 1: under the pins the policy answers from the fixture, the floor, beside a running fleet", () => {
  assert.equal(memoryMax("none"), String(FLOOR_MIB));
  // Each suite that failed on the fleet host takes its pins from the one helper.
  for (const suite of [
    "test/the-instances-share-one-host-memory-budget.test.ts",
    "test/the-console-backend-keeps-its-share-of-the-host.test.ts",
    "test/a-squeezed-page-cache-grows-its-memory-high.test.ts",
  ]) {
    assert.match(readFileSync(join(REPO_ROOT, suite), "utf8"), /hostIndependentPolicyEnv\(/, `${suite} pins its policy reads`);
  }
});

test("W1-T12027 criterion 2: unpinned, the same read returns the running container's larger limit or peak", () => {
  // CONTROL: the hostile host is live; each pin removed alone changes the answer.
  assert.equal(memoryMax("cgroup"), String(RUNNING_MIB), "the running memory.max is kept when the cgroup tree is reachable");
  assert.equal(memoryMax("registry"), "20000", "the peer root's recorded peak is kept when the registry is reachable");
});
