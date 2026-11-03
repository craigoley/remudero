import assert from "node:assert/strict";
import test from "node:test";
import { issueLinuxCodingProfilePreflight, readLinuxCodingProfilePreflight,
  type LinuxCodingProfilePreflightV1 } from "#src/lib/model-canary-linux-profile-preflight-capabilities.js";

const hash = "a".repeat(64);

function validPreflight(): LinuxCodingProfilePreflightV1 {
  return {
    version: "linux-coding-profile-preflight-v1",
    profileId: "native-coding-probe-test",
    runtimeId: "node-source-stdin-stdout-v1",
    bounds: { cpuQuotaMicros: 100_000, memoryMaxBytes: 268_435_456, swapMaxBytes: 0,
      tasksMax: 16, scratchMaxBytes: 16_777_216, wallMaxMs: 15_000, stdoutMaxBytes: 4096,
      stderrMaxBytes: 4096, heapMaxBytes: 67_108_864, controlCallTimeoutMs: 5000, cleanupGraceMs: 10_000 },
    binaries: {
      systemdRun: { path: "/usr/bin/systemd-run", sha256: hash },
      systemctl: { path: "/usr/bin/systemctl", sha256: hash },
      bubblewrap: { path: "/usr/bin/bwrap", sha256: hash },
      node: { path: "/usr/bin/node", sha256: hash },
    },
    runtimeFiles: [{ source: "/usr/bin/node", target: "/usr/bin/node", sha256: hash }],
    hostIdentity: {
      kernelRelease: "6.1.0", bootId: "01234567-89ab-cdef-0123-456789abcdef",
      systemdVersion: "256", systemdRunVersion: "256", bubblewrapVersion: "0.10.0", nodeVersion: "v22.0.0",
      cgroup2FsType: 0x63677270, cgroupMountIdentity: "1:2:0:1:/sys/fs/cgroup:cgroup2:rw",
      controllers: ["cpu", "memory", "pids"], subtreeControllers: ["cpu", "memory", "pids"],
      uid: 1000, userManagerControlGroup: "/user.slice/user-1000.slice/user@1000.service",
    },
    binaryDigest: hash, hostIdentityDigest: hash, backendSourceDigest: hash, producerSourceDigest: hash,
    preflightCapabilitySourceDigest: hash, testSourceDigest: hash,
  };
}

test("W1-T10957: native preflight capability accepts the producer schema and rejects malformed schemas", () => {
  const preflight = validPreflight();
  const capability = issueLinuxCodingProfilePreflight(preflight);
  const snapshot = readLinuxCodingProfilePreflight(capability);
  assert.ok(snapshot);
  assert.equal(snapshot.profileId, preflight.profileId);
  assert.equal(snapshot.binaryDigest, preflight.binaryDigest);
  assert.equal(snapshot.bounds.memoryMaxBytes, preflight.bounds.memoryMaxBytes);
  assert.ok(Object.isFrozen(snapshot));

  assert.throws(() => issueLinuxCodingProfilePreflight({ ...preflight, unexpected: true } as never),
    /linux-profile-preflight-invalid/);
  assert.throws(() => issueLinuxCodingProfilePreflight({ ...preflight, version: "unknown-version" } as never),
    /linux-profile-preflight-invalid/);

  const accessorPreflight = validPreflight();
  Object.defineProperty(accessorPreflight, "profileId", { enumerable: true, get: () => "native-coding-probe-test" });
  assert.throws(() => issueLinuxCodingProfilePreflight(accessorPreflight), /linux-profile-preflight-accessor-invalid/);

  assert.throws(() => issueLinuxCodingProfilePreflight({ ...preflight,
    bounds: { ...preflight.bounds, memoryMaxBytes: preflight.bounds.memoryMaxBytes + 1 },
  }), /linux-profile-preflight-invalid/);
  assert.equal(readLinuxCodingProfilePreflight({ kind: "linux-coding-profile-preflight-capability-v1" }), null);
});
