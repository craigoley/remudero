import assert from "node:assert/strict";
import test from "node:test";
import { isQualifiedLinuxCodingProfile } from "#src/lib/model-canary-systemd-bwrap-backend.js";
import { qualifiedLinuxCodingProfileForCurrentHost, runNativeLinuxProfileProbe } from "#src/lib/model-canary-native-profile-probe.js";

const controlNames = ["known-good", "known-bad", "cancel-descendant"] as const;
const namespaceKeys = ["userNamespace", "pidNamespace", "networkNamespace", "ipcNamespace", "utsNamespace", "mountNamespace", "cgroupNamespace"] as const;

test("W1-T10957: the existing private coding executor contains filesystem and credential effects and closes its real descendants", async t => {
  if (process.platform !== "linux") {
    t.skip("native Linux profile probe requires a Linux host");
    return;
  }
  const probe = await runNativeLinuxProfileProbe();
  t.diagnostic(JSON.stringify(probe));
  if (probe.state === "unavailable" && probe.phase === "preflight") {
    t.skip(`native Linux profile prerequisites unavailable: ${probe.reason}`);
    return;
  }
  if (probe.state === "unavailable") assert.ok(probe.diagnostic,
    "post-preflight failures must retain bounded attempted-unit diagnostics");
  assert.equal(probe.state, "observed", probe.state === "unavailable" ? probe.reason : undefined);
  if (probe.state !== "observed") return;
  assert.equal(probe.phase, "controls");
  assert.equal(probe.profileQualification, "isolation-closure-only");
  assert.equal(probe.executionSource, "synthetic-control-replay");
  assert.equal(probe.modelGrade, null);
  assert.ok(isQualifiedLinuxCodingProfile(await qualifiedLinuxCodingProfileForCurrentHost()),
    "only the real backend receipt for this exact host tuple may mint the in-process execution profile");

  const summary = probe.summary;
  assert.equal(summary.version, "linux-coding-profile-probe-v1");
  assert.match(summary.profileProbeId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  for (const digest of [summary.profileDigest, summary.binaryDigest, summary.backendSourceDigest,
    summary.producerSourceDigest, summary.preflightCapabilitySourceDigest, summary.testSourceDigest,
    summary.controlSourceDigest, summary.hostIdentityDigest])
    assert.match(digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(summary.controls).sort(), [...controlNames].sort());
  const hostIds = new Set<string>();
  for (const name of controlNames) {
    const control = summary.controls[name];
    assert.equal(control.state, "passed", `${name} control must have real effective readbacks and closure`);
    assert.equal(control.candidateClosed, true);
    assert.ok(control.unitClosureBasis === "cgroup-events-empty" || control.unitClosureBasis === "pinned-cgroup-removed",
      "unit closure must use an explicit kernel event readback or pinned removed-cgroup proof");
    assert.ok(control.unitRetirement === "not-needed" || control.unitRetirement === "retired",
      "a failed exact probe unit must be retired after closure proof");
    assert.match(control.controlAttemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(control.sourceDigest, /^[a-f0-9]{64}$/);
    assert.match(control.hostExecutionId ?? "", /^rmd-coding-probe-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(!hostIds.has(control.hostExecutionId!), "each fixed control must use a distinct exact transient unit");
    hostIds.add(control.hostExecutionId!);
    assert.match(control.diagnosticDigest ?? "", /^[a-f0-9]{64}$/);
  }
  assert.equal(summary.controls["known-good"].exitCode, 0);
  assert.equal(summary.controls["known-bad"].exitCode, 0);
  assert.equal(summary.controls["cancel-descendant"].exitCode, null);

  for (const key of ["cpuQuotaMicros", "memoryMaxBytes", "swapMaxBytes", "tasksMax"] as const) {
    const value = summary.unitReadbacks[key];
    assert.ok(value.configured !== null && value.readback !== null, `${key} effective limit must be observed`);
    assert.equal(value.readback, value.configured, `${key} effective limit must equal the fixed request`);
  }
  assert.ok(namespaceKeys.every(key => summary.isolation[key] === true), "all candidate namespaces must be observed isolated");
  assert.equal(summary.isolation.rootReadOnly, true);
  assert.equal(summary.isolation.tmpfsScratch, true);
  assert.equal(summary.isolation.devReadOnly, true);
  assert.equal(summary.isolation.devRegularWriteDenied, true);
  assert.equal(summary.isolation.devNullWritable, true);
  assert.equal(summary.isolation.procReadOnly, true);
  assert.equal(summary.isolation.devPtsReadOnly, true);
  assert.equal(summary.isolation.devPtsPseudoFilesystem, true);
  assert.equal(summary.scratchMountReadbacks.rootReadbackBytes, summary.scratchMountReadbacks.rootConfiguredBytes);
  assert.equal(summary.scratchMountReadbacks.tmpReadbackBytes, summary.scratchMountReadbacks.tmpConfiguredBytes);
  assert.equal(summary.isolation.cleanEnvironment, true);
  assert.equal(summary.isolation.parentEnvironmentHidden, true,
    "the fixed harmless parent sentinel must be present in the trusted wrapper and absent in the candidate");

  for (const key of ["cpuUsec", "memoryPeakBytes", "swapPeakBytes", "pidsPeak", "wallMs", "stdoutBytes", "stderrBytes"] as const)
    assert.ok(Number.isSafeInteger(summary.observed[key]) && summary.observed[key]! >= 0,
      `${key} must come from the exact probe unit readback`);
  assert.equal(summary.observed.scratchPeakBytes, null, "tmpfs size is a configured cap, not a measured scratch peak");
  assert.equal(summary.observed.heapPeakBytes, null, "V8 old-space limit is not a measured heap peak");
});
