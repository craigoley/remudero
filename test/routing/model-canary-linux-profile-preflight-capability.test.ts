import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ChildProcess } from "node:child_process";
import { fstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueLinuxCodingProfilePreflight, readLinuxCodingProfilePreflight,
  type LinuxCodingProfilePreflightV1 } from "#src/lib/model-canary-linux-profile-preflight-capabilities.js";
import { probeNativeLinuxCodingProfile, runProfileControl,
  type LinuxCodingProfileSpec } from "#src/lib/model-canary-systemd-bwrap-backend.js";
import { elfInterpreter, runtimeFileManifest } from "#src/lib/model-canary-native-profile-probe.js";

const hash = "a".repeat(64);

test("native runtime manifest hashes real runtime files using the default process report", () => {
  const executable = realpathSync("/usr/bin/env");
  const manifest = runtimeFileManifest(executable);
  assert.ok(Object.isFrozen(manifest));
  assert.ok(manifest.some(row => row.source === executable && row.target === executable));
  const sharedObjects: unknown = Object.getOwnPropertyDescriptor(process.report.getReport(), "sharedObjects")?.value;
  assert.ok(Array.isArray(sharedObjects));
  const sharedPaths = sharedObjects.filter((value): value is string => typeof value === "string" && value.startsWith("/"));
  assert.ok(sharedPaths.length > 0, "the default report must expose real libraries");
  for (const target of sharedPaths) {
    assert.ok(manifest.some(row => row.target === target), `the manifest must include ${target}`);
  }
  for (const row of manifest) {
    assert.equal(row.sha256, createHash("sha256").update(readFileSync(row.source)).digest("hex"));
    assert.equal(realpathSync(row.target), row.source);
    assert.ok(Object.isFrozen(row));
  }
});

test("native runtime manifest refuses malformed reports without evaluating shared-object accessors", t => {
  const accessor = Object.defineProperty({}, "sharedObjects", {
    get() { assert.fail("report accessors must never execute"); },
  });
  const cases = [
    { value: null, reason: "node-report-invalid" },
    { value: "invalid", reason: "node-report-invalid" },
    { value: [], reason: "node-report-invalid" },
    { value: {}, reason: "node-report-invalid" },
    { value: accessor, reason: "node-report-invalid" },
    { value: { sharedObjects: null }, reason: "shared-object-list-invalid" },
    { value: { sharedObjects: "invalid" }, reason: "shared-object-list-invalid" },
    { value: { sharedObjects: Array(97).fill("linux-vdso.so.1") }, reason: "shared-object-list-invalid" },
  ];
  for (const { value, reason } of cases) {
    const report = t.mock.method(process.report, "getReport", () => value);
    try {
      assert.throws(() => runtimeFileManifest("/usr/bin/env"), {
        message: `native-profile-preflight-${reason}`,
      });
      assert.equal(report.mock.callCount(), 1);
    } finally { report.mock.restore(); }
  }
});

test("native known-good control requires supervisor closure and exact unit retirement", async t => {
  for (const mode of ["passed", "wrong-sum", "supervisor-open", "unit-populated", "retirement-failed"] as const) {
    await t.test(mode, async () => {
      const root = mkdtempSync(join(tmpdir(), "rmd-profile-result-"));
      const controlAttemptId = "2b9b3603-a178-4542-a5df-d24d3dc363fa";
      const unit = `rmd-coding-probe-${controlAttemptId}`;
      const preflight = validPreflight();
      const calls = join(root, "calls");
      const systemctl = join(root, "systemctl");
      const properties = { Id: `${unit}.service`, ActiveState: "failed", SubState: "failed",
        MainPID: "0", ControlGroup: "", CPUAccounting: "yes", MemoryAccounting: "yes",
        TasksAccounting: "yes", RuntimeMaxUSec: "15.100000s" };
      writeFileSync(systemctl, `#!/bin/sh
printf '%s\\n' "$2" >> "\${0%/*}/calls"
case "$2" in
show) cat <<'PROPERTIES'
${Object.entries(properties).map(([key, value]) => `${key}=${value}`).join("\n")}
PROPERTIES
;;
reset-failed) exit ${mode === "retirement-failed" ? 1 : 0} ;;
kill) exit 0 ;;
*) exit 2 ;;
esac
`, { mode: 0o700 });
      const profile: LinuxCodingProfileSpec = {
        profileId: preflight.profileId, profileDigest: hash, binaryDigest: hash,
        backendSourceDigest: hash, producerSourceDigest: hash, testSourceDigest: hash,
        preflightCapabilitySourceDigest: hash, hostIdentityDigest: hash, controlSourceDigest: hash,
        runtimeId: preflight.runtimeId,
        bounds: { ...preflight.bounds, profileId: preflight.profileId, profileDigest: hash,
          binaryDigest: hash, runtimeId: preflight.runtimeId },
        systemdRun: preflight.binaries.systemdRun, systemctl: { path: systemctl, sha256: hash },
        bubblewrap: preflight.binaries.bubblewrap, node: preflight.binaries.node,
        runtimeFiles: preflight.runtimeFiles, isolationProofDigest: hash,
        controlCallTimeoutMs: 1000, cleanupGraceMs: 100,
      };
      const files = { "cpu.max": "100000 100000", "memory.max": "268435456",
        "memory.swap.max": "0", "pids.max": "16", "cgroup.procs": "123\n",
        "cgroup.events": "populated 1\n", "cpu.stat": "usage_usec 37\n",
        "memory.peak": "12345", "memory.swap.peak": "0", "pids.peak": "3" };
      for (const [name, value] of Object.entries(files)) writeFileSync(join(root, name), value);
      const halfScratch = profile.bounds.scratchMaxBytes / 2;
      const stdout = JSON.stringify({ sum: mode === "wrong-sum" ? 11 : 10,
        ns: { user: "isolated:user", pid: "isolated:pid", net: "isolated:net", ipc: "isolated:ipc",
          uts: "isolated:uts", mnt: "isolated:mnt", cgroup: "isolated:cgroup" },
        root: { type: "tmpfs", ro: true, size: halfScratch },
        tmp: { type: "tmpfs", ro: false, size: halfScratch },
        dev: { type: "tmpfs", ro: true, regularWriteDenied: true, nullWritable: true },
        proc: { type: "proc", ro: true }, devPts: { type: "devpts", ro: true },
        pwd: "/work", env: ["HOME", "LANG", "PATH", "PWD", "TMPDIR"] });
      let closeSupervisor!: (value: { code: number; signal: null }) => void;
      const closed = new Promise<{ code: number; signal: null }>(resolve => { closeSupervisor = resolve; });
      const sent: string[] = [];
      const fd = openSync(root, "r");
      try {
        const result = await runProfileControl(profile, "a75643cd-65c6-474d-a91d-e6f63bbb0743",
          "known-good", controlAttemptId, {
            startUnit: (_profile, actualUnit, sentinel) => {
              assert.equal(actualUnit, unit);
              const frame = `RMD_PROFILE_PARENT_SENTINEL ${sentinel}\nRMD_RESULT ${JSON.stringify({
                protocol: "rmd-coding-result-v1", pid: 123, exitCode: 0,
                stdoutBase64: Buffer.from(stdout).toString("base64"), stderrBase64: "",
                stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0,
                candidateWallMs: 7, candidateClosedBeforeMetrics: true,
              })}\n`;
              return { child: new ChildProcess(), unit, output: [Buffer.from(frame)],
                outputBytes: Buffer.byteLength(frame), errors: [], errorBytes: 0, closed,
                send(text) {
                  sent.push(text);
                  if (text === "release\n") {
                    if (mode !== "unit-populated") writeFileSync(join(root, "cgroup.events"), "populated 0\n");
                    if (mode !== "supervisor-open") closeSupervisor({ code: 0, signal: null });
                  }
                }, kill() { assert.fail("the pin seam must not replace native cleanup"); } };
            },
            waitForActive: async () => ({ ...properties, ActiveState: "active", SubState: "running",
              MainPID: "123", ControlGroup: `/user.slice/user-${process.getuid!()}.slice/user@${process.getuid!()}.service/app.slice/${unit}.service` }),
            exactCgroupDir: () => ({ path: root, fd }),
          });
        assert.equal(sent.at(-1), "release\n", result.reason ?? "native result must release its supervisor");
        assert.equal(result.hostExecutionId, unit);
        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.observed, { cpuUsec: 37, memoryPeakBytes: 12345, swapPeakBytes: 0,
          pidsPeak: 3, wallMs: 7, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0 });
        const expectedReason = { passed: null, "wrong-sum": "profile-probe-control-output-mismatch",
          "supervisor-open": "profile-probe-supervisor-closure-unproved",
          "unit-populated": "profile-probe-unit-not-empty",
          "retirement-failed": "profile-probe-unit-retirement-failed" }[mode];
        assert.equal(result.reason, expectedReason);
        assert.equal(result.state, mode === "passed" ? "passed" : mode === "wrong-sum" ? "failed" : "unavailable");
        const provedClosed = mode !== "supervisor-open" && mode !== "unit-populated";
        assert.equal(result.candidateClosed, provedClosed);
        assert.equal(result.unitClosureBasis, provedClosed ? "cgroup-events-empty" : null);
        assert.equal(result.unitRetirement, mode === "retirement-failed" ? "failed" : provedClosed ? "retired" : "not-attempted");
        assert.equal(readFileSync(calls, "utf8").includes("reset-failed\n"), provedClosed);
        if (mode === "passed" || mode === "wrong-sum") {
          assert.ok(result.isolation && Object.values(result.isolation).every(value => value === true));
          assert.equal(result.diagnosticDigest, createHash("sha256").update(stdout + "\n").digest("hex"));
          assert.deepEqual(result.scratchMountReadbacks, { rootConfiguredBytes: halfScratch,
            rootReadbackBytes: halfScratch, tmpConfiguredBytes: halfScratch, tmpReadbackBytes: halfScratch });
        }
        assert.throws(() => fstatSync(fd), { code: "EBADF" });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});

test("native ELF inspection reads the real Node binary and refuses a malformed fixture", () => {
  const interpreter = elfInterpreter(process.execPath);
  assert.ok(interpreter === null || interpreter.startsWith("/"));
  const root = mkdtempSync(join(tmpdir(), "rmd-elf-fixture-"));
  try {
    const malformed = join(root, "not-elf");
    writeFileSync(malformed, Buffer.alloc(64));
    assert.throws(() => elfInterpreter(malformed), /native-profile-preflight-node-elf-invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native profile control closes a pinned cgroup descriptor after readback refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-profile-fd-"));
  const pinned = join(root, "pinned");
  writeFileSync(pinned, "synthetic cgroup fixture");
  const fd = openSync(pinned, "r");
  const preflight = validPreflight();
  const profile: LinuxCodingProfileSpec = {
    profileId: preflight.profileId, profileDigest: hash, binaryDigest: hash,
    backendSourceDigest: hash, producerSourceDigest: hash, testSourceDigest: hash,
    preflightCapabilitySourceDigest: hash, hostIdentityDigest: hash,
    controlSourceDigest: hash, runtimeId: preflight.runtimeId,
    bounds: { ...preflight.bounds, profileId: preflight.profileId, profileDigest: hash,
      binaryDigest: hash, runtimeId: preflight.runtimeId },
    systemdRun: preflight.binaries.systemdRun,
    systemctl: { path: join(root, "no-systemctl"), sha256: hash },
    bubblewrap: preflight.binaries.bubblewrap, node: preflight.binaries.node,
    runtimeFiles: preflight.runtimeFiles, isolationProofDigest: hash,
    controlCallTimeoutMs: 1, cleanupGraceMs: 1,
  };
  try {
    const result = await runProfileControl(profile,
      "a75643cd-65c6-474d-a91d-e6f63bbb0743", "known-good",
      "2b9b3603-a178-4542-a5df-d24d3dc363fa", {
        startUnit: (_profile, unit) => ({ child: null as never, unit, output: [], outputBytes: 0,
          errors: [], errorBytes: 0, closed: new Promise(() => {}), send() {}, kill() {} }),
        waitForActive: async () => ({ ControlGroup: "/synthetic" }),
        exactCgroupDir: () => ({ path: pinned, fd }),
      });
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, "systemd-effective-limit-readback-mismatch");
    assert.equal(result.candidateClosed, false, "the fake fixture supplies no process closure proof");
    assert.throws(() => fstatSync(fd), { code: "EBADF" }, "the pinned descriptor must close on refusal");

    const defaultIOResult = await runProfileControl({ ...profile, cleanupGraceMs: 1000,
      systemdRun: { path: "/bin/false", sha256: hash } },
    "a75643cd-65c6-474d-a91d-e6f63bbb0743", "known-bad",
    "35a20df1-efab-4e66-9914-fc0dfc30a722");
    assert.equal(defaultIOResult.state, "unavailable", "the real spawn path must report a failed synthetic controller");
    assert.equal(defaultIOResult.candidateClosed, false,
      "an exited controller without a pinned cgroup readback cannot prove unit closure");
    assert.equal(defaultIOResult.hostExecutionId, "rmd-coding-probe-35a20df1-efab-4e66-9914-fc0dfc30a722");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
