import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext, Script } from "node:vm";
import { LINUX_CODING_PROFILE_CANCEL_CONTROL_SOURCE, LINUX_CODING_PROFILE_KNOWN_GOOD_CONTROL_SOURCE,
  probeDiagnostic, type LinuxCodingProfileProbeControlDiagnostic } from "#src/lib/model-canary-systemd-bwrap-backend.js";

type FixedControlObservation = {
  sum: number;
  ns: Record<string, string>;
  root: { size: number | null };
  tmp: { size: number | null };
  dev: { ro: boolean; regularWriteDenied: boolean; nullWritable: boolean };
  proc: { ro: boolean; type: string };
  devPts: { ro: boolean; type: string };
};

function runFixedControl(rootSize: string, tmpSize = rootSize): FixedControlObservation {
  const mountinfo = [
    `1 0 0:1 / / ro - tmpfs tmpfs rw,size=${rootSize}`,
    `2 1 0:2 / /dev ro - tmpfs tmpfs rw,size=65536k`,
    `3 1 0:3 / /proc ro - proc proc rw`,
    `4 2 0:4 / /dev/pts ro - devpts devpts rw`,
    `5 1 0:5 / /tmp rw - tmpfs tmpfs rw,size=${tmpSize}`,
  ].join("\n");
  let stdout = "";
  const fs = {
    readFileSync(path: string | number) {
      if (path === 0) return "1 2 3 4\n";
      if (path === "/proc/self/mountinfo") return mountinfo;
      throw new Error("unexpected-read");
    },
    readlinkSync(path: string) {
      if (!path.startsWith("/proc/self/ns/")) throw new Error("unexpected-readlink");
      return `namespace:${path.slice("/proc/self/ns/".length)}`;
    },
    openSync(path: string) {
      if (typeof path === "string" && path.startsWith("/dev/.rmd-profile-write-probe-")) {
        const error = new Error("read only") as NodeJS.ErrnoException;
        error.code = "EROFS";
        throw error;
      }
      if (path === "/dev/null") return 17;
      throw new Error("unexpected-open");
    },
    writeSync(fd: number) { assert.equal(fd, 17); return 1; },
    closeSync(fd: number) { assert.equal(fd, 17); },
  };
  runInNewContext(LINUX_CODING_PROFILE_KNOWN_GOOD_CONTROL_SOURCE, {
    Buffer,
    require(name: string) { if (name === "node:fs") return fs; throw new Error("unexpected-require"); },
    process: { pid: 123, env: { HOME: "/nonexistent", LANG: "C", PATH: "/usr/bin", PWD: "/work", TMPDIR: "/tmp" },
      stdout: { write(value: string) { stdout += value; } } },
  });
  return JSON.parse(stdout) as FixedControlObservation;
}

test("W1-T10957: the fixed native control converts tmpfs size=K readbacks to bytes and attests pseudo-mount writes", () => {
  const observed = runFixedControl("8192k");
  assert.equal(observed.sum, 10);
  assert.equal(observed.root.size, 8_388_608);
  assert.equal(observed.tmp.size, 8_388_608);
  assert.equal(observed.ns.user, "namespace:user");
  assert.equal(observed.ns.pid, "namespace:pid");
  assert.equal(observed.dev.ro, true);
  assert.equal(observed.dev.regularWriteDenied, true);
  assert.equal(observed.dev.nullWritable, true);
  assert.deepEqual(observed.proc, { ro: true, type: "proc" });
  assert.deepEqual(observed.devPts, { ro: true, type: "devpts" });

  for (const malformed of ["8192M", "08k", "9007199254740992k", "-1k", "8192"]) {
    assert.equal(runFixedControl(malformed).root.size, null, `reject malformed or overflowing mount size ${malformed}`);
  }
});

test("W1-T10957: the cancellation child uses fixed bounded V8 runtime options", () => {
  assert.doesNotThrow(() => new Script(LINUX_CODING_PROFILE_CANCEL_CONTROL_SOURCE));
  assert.ok(LINUX_CODING_PROFILE_CANCEL_CONTROL_SOURCE.includes("['--v8-pool-size=1','--max-old-space-size=64','-e'"));
});

test("native probe diagnostics freeze observed counters and exact unit readbacks", () => {
  const unitReadbacks = {
    cpuQuotaMicros: { configured: 100_000, readback: 100_000 },
    memoryMaxBytes: { configured: 268_435_456, readback: 268_435_456 },
    swapMaxBytes: { configured: 0, readback: 0 },
    tasksMax: { configured: 16, readback: 16 },
  };
  const isolation = {
    userNamespace: true, pidNamespace: true, networkNamespace: true, ipcNamespace: true,
    utsNamespace: true, mountNamespace: true, cgroupNamespace: true, rootReadOnly: true,
    tmpfsScratch: true, devReadOnly: true, devRegularWriteDenied: true, devNullWritable: true,
    procReadOnly: true, devPtsReadOnly: true, devPtsPseudoFilesystem: true,
    cleanEnvironment: true, parentEnvironmentHidden: true,
  };
  const control: LinuxCodingProfileProbeControlDiagnostic = {
    control: "known-good", controlAttemptId: "control-1", sourceDigest: "a".repeat(64),
    state: "passed", hostExecutionId: "rmd-coding-probe-control-1", exitCode: 0,
    candidateClosed: true, unitClosureBasis: "cgroup-events-empty", unitRetirement: "retired",
    diagnosticDigest: "b".repeat(64),
    observed: { cpuUsec: 12, memoryPeakBytes: 1024, swapPeakBytes: 0, pidsPeak: 2,
      wallMs: 4, stdoutBytes: 3, stderrBytes: 0 },
    unitReadbacks,
    scratchMountReadbacks: { rootConfiguredBytes: 8192, rootReadbackBytes: 8192,
      tmpConfiguredBytes: 8192, tmpReadbackBytes: 8192 },
    isolation, reason: null,
  };
  const diagnostic = probeDiagnostic("probe-1", [control]);
  assert.deepEqual(diagnostic.heldUnitIds, []);
  assert.deepEqual(diagnostic.controls[0]?.observed, control.observed);
  assert.deepEqual(diagnostic.controls[0]?.unitReadbacks, unitReadbacks);
  assert.deepEqual(diagnostic.controls[0]?.scratchMountReadbacks, control.scratchMountReadbacks);
  assert.deepEqual(diagnostic.controls[0]?.isolation, isolation);
  assert.ok(Object.isFrozen(diagnostic.controls[0]?.observed));
  assert.ok(Object.isFrozen(diagnostic.controls[0]?.unitReadbacks?.cpuQuotaMicros));
  assert.ok(Object.isFrozen(diagnostic.controls[0]?.scratchMountReadbacks));
  assert.ok(Object.isFrozen(diagnostic.controls[0]?.isolation));
  control.observed.cpuUsec = 99;
  assert.equal(diagnostic.controls[0]?.observed.cpuUsec, 12);
  const held = probeDiagnostic("probe-2", [{ ...control, candidateClosed: false }]);
  assert.deepEqual(held.heldUnitIds, [control.hostExecutionId]);
});
