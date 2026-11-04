import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { issueLinuxCodingProfilePreflight, readLinuxCodingProfilePreflight,
  type LinuxCodingProfilePreflightV1 } from "#src/lib/model-canary-linux-profile-preflight-capabilities.js";
import { probeNativeLinuxCodingProfile } from "#src/lib/model-canary-systemd-bwrap-backend.js";

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

test("native profile probe refuses forged capabilities and mismatched canonical host digests", async () => {
  assert.deepEqual(await probeNativeLinuxCodingProfile({ kind: "linux-coding-profile-preflight-capability-v1" }),
    { state: "unavailable", phase: "preflight", reason: "linux-profile-preflight-capability-invalid" });

  const preflight = validPreflight();
  preflight.hostIdentity.uid = process.getuid!();
  preflight.hostIdentity.userManagerControlGroup = `/user.slice/user-${preflight.hostIdentity.uid}.slice/user@${preflight.hostIdentity.uid}.service`;
  const mismatched = await probeNativeLinuxCodingProfile(issueLinuxCodingProfilePreflight(preflight));
  assert.equal(mismatched.state, "unavailable");
  if (mismatched.state !== "unavailable") assert.fail("a mismatched host digest must refuse the probe");
  assert.equal(mismatched.phase, "controls");
  assert.equal(mismatched.reason, "linux-profile-host-digest-invalid");
  assert.deepEqual(mismatched.diagnostic?.controls, []);
  assert.deepEqual(mismatched.diagnostic?.heldUnitIds, []);

  // This independently serialized flat identity includes both controller arrays.
  const canonicalHost = JSON.stringify(preflight.hostIdentity, Object.keys(preflight.hostIdentity).sort());
  preflight.hostIdentityDigest = createHash("sha256").update(canonicalHost).digest("hex");
  const matched = await probeNativeLinuxCodingProfile(issueLinuxCodingProfilePreflight(preflight));
  assert.equal(matched.state, "unavailable");
  if (matched.state !== "unavailable") assert.fail("synthetic binary digests cannot qualify a host");
  assert.equal(matched.phase, "controls");
  assert.equal(matched.reason, "linux-profile-binary-or-runtime-validation-failed",
    "a matching canonical host digest must reach binary validation without starting controls");
  assert.deepEqual(matched.diagnostic?.controls, []);
  assert.deepEqual(matched.diagnostic?.heldUnitIds, []);
});
