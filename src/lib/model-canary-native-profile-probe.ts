/** Bounded native discovery and in-process handoff for fixed Linux profile controls. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, fstatSync, openSync, readSync, closeSync, realpathSync, statfsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLinuxCodingProfileProbeReceipt, probeNativeLinuxCodingProfile,
  qualifyLinuxCodingProfileProbe, readLinuxCodingProfileProbeReceipt, type LinuxCodingProfileProbeSummary,
  type QualifiedLinuxCodingProfile } from "./model-canary-systemd-bwrap-backend.js";
import { issueLinuxCodingProfilePreflight,
  type LinuxCodingProfilePreflightCapabilityV1, type LinuxCodingProfilePreflightV1 } from "./model-canary-linux-profile-preflight-capabilities.js";

const CGROUP2_SUPER_MAGIC = 0x63677270;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_RUNTIME_BYTES = 512 * 1024 * 1024;
const MAX_RUNTIME_FILES = 96;
const ALLOWED_RUNTIME_PATH = /^\/(?:usr\/(?:bin|lib|lib64|libexec)|lib(?:64)?)(?:\/|$)/;
const sourcePath = fileURLToPath(import.meta.url);
const backendPath = fileURLToPath(new URL("./model-canary-systemd-bwrap-backend.ts", import.meta.url));
const preflightCapabilityPath = fileURLToPath(new URL("./model-canary-linux-profile-preflight-capabilities.ts", import.meta.url));
const testPath = fileURLToPath(new URL("../../test/routing/model-canary-native-session.test.ts", import.meta.url));

const fixedBounds = Object.freeze({ cpuQuotaMicros: 100_000, memoryMaxBytes: 268_435_456,
  swapMaxBytes: 0, tasksMax: 16, scratchMaxBytes: 16_777_216, wallMaxMs: 15_000,
  stdoutMaxBytes: 4096, stderrMaxBytes: 4096, heapMaxBytes: 67_108_864,
  controlCallTimeoutMs: 5000, cleanupGraceMs: 10_000 });

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const codeUnitCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort(codeUnitCompare).map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`;
}

function readBoundedRegularFile(path: string, maxBytes = 64 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) throw new Error("native-profile-preflight-file-invalid");
    const buffer = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const n = readSync(fd, buffer, used, buffer.length - used, null);
      if (n === 0) break;
      used += n;
    }
    if (used > maxBytes) throw new Error("native-profile-preflight-file-bound");
    return buffer.subarray(0, used).toString("utf8");
  } finally { closeSync(fd); }
}

function digestRegularFile(path: string, runtimeFile = true): { path: string; sha256: string; size: number } {
  const canonical = realpathSync(path);
  if (canonical !== path || (runtimeFile && (!ALLOWED_RUNTIME_PATH.test(canonical)
    || /\/(?:home|root|proc|sys|dev|run|var|tmp|etc)(?:\/|$)/.test(canonical))))
    throw new Error("native-profile-preflight-runtime-path-invalid");
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > MAX_FILE_BYTES || (before.mode & 0o022) !== 0)
      throw new Error("native-profile-preflight-runtime-file-invalid");
    const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_FILE_BYTES) throw new Error("native-profile-preflight-runtime-file-bound");
      hash.update(chunk.subarray(0, n));
    }
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || total !== after.size || realpathSync(canonical) !== canonical)
      throw new Error("native-profile-preflight-runtime-file-changed");
    return { path: canonical, sha256: hash.digest("hex"), size: total };
  } finally { closeSync(fd); }
}

type PreflightExecStage = "systemd-run-version" | "systemctl-version" | "bubblewrap-version"
  | "systemctl-user-manager" | "systemctl-unit-properties";

function preflightExecFailureKind(error: unknown): "timeout" | "nonzero-exit" | "execution-failure" {
  const detail = error !== null && typeof error === "object"
    ? error as { code?: unknown; killed?: unknown; status?: unknown } : undefined;
  if (detail?.code === "ETIMEDOUT" || detail?.killed === true) return "timeout";
  if (typeof detail?.status === "number" || typeof detail?.code === "number") return "nonzero-exit";
  return "execution-failure";
}

function runPreflightExec(path: string, args: readonly string[], stage: PreflightExecStage): string {
  try {
    return execFileSync(path, [...args], { encoding: "utf8", timeout: 3000,
      maxBuffer: 8192, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    throw new Error(`native-profile-preflight-${stage}-${preflightExecFailureKind(error)}`);
  }
}

function readProfileToolVersion(path: string, args: readonly string[], stage: PreflightExecStage): string {
  const output = runPreflightExec(path, args, stage).trim();
  const line = output.split("\n")[0]?.trim();
  if (!line || line.length > 128) throw new Error(`native-profile-preflight-${stage}-output-invalid`);
  return line;
}

function elfInterpreter(path: string): string | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd), header = Buffer.alloc(64);
    const readHeader = readSync(fd, header, 0, header.length, 0);
    if (readHeader < 52 || header[0] !== 0x7f || header.toString("ascii", 1, 4) !== "ELF")
      throw new Error("native-profile-preflight-node-elf-invalid");
    const elfClass = header[4], encoding = header[5];
    if ((elfClass !== 1 && elfClass !== 2) || (encoding !== 1 && encoding !== 2))
      throw new Error("native-profile-preflight-node-elf-format-unsupported");
    const little = encoding === 1;
    const u16 = (buffer: Buffer, offset: number) => little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    const u32 = (buffer: Buffer, offset: number) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const u64 = (buffer: Buffer, offset: number) => {
      const value = little ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("native-profile-preflight-elf-offset-bound");
      return Number(value);
    };
    const phoff = elfClass === 2 ? u64(header, 32) : u32(header, 28);
    const entrySize = u16(header, elfClass === 2 ? 54 : 42), entryCount = u16(header, elfClass === 2 ? 56 : 44);
    if (!Number.isSafeInteger(phoff) || phoff < 0 || entrySize < (elfClass === 2 ? 56 : 32)
      || entrySize > 1024 || entryCount < 1 || entryCount > 4096
      || phoff + entrySize * entryCount > info.size || phoff + entrySize * entryCount > 4 * 1024 * 1024)
      throw new Error("native-profile-preflight-elf-program-table-invalid");
    for (let index = 0; index < entryCount; index++) {
      const entry = Buffer.alloc(entrySize), n = readSync(fd, entry, 0, entrySize, phoff + index * entrySize);
      if (n !== entrySize) throw new Error("native-profile-preflight-elf-entry-short");
      if (u32(entry, 0) !== 3) continue; // PT_INTERP
      const offset = elfClass === 2 ? u64(entry, 8) : u32(entry, 4);
      const size = elfClass === 2 ? u64(entry, 32) : u32(entry, 16);
      if (size < 2 || size > 4096 || offset + size > info.size) throw new Error("native-profile-preflight-elf-interpreter-invalid");
      const value = Buffer.alloc(size), got = readSync(fd, value, 0, size, offset);
      if (got !== size || value[size - 1] !== 0) throw new Error("native-profile-preflight-elf-interpreter-invalid");
      const interpreter = value.subarray(0, size - 1).toString("utf8");
      if (!interpreter.startsWith("/")) throw new Error("native-profile-preflight-elf-interpreter-invalid");
      return interpreter;
    }
    return null;
  } finally { closeSync(fd); }
}

function runtimeFileManifest(nodePath: string): LinuxCodingProfilePreflightV1["runtimeFiles"] {
  const report = (process as NodeJS.Process & { report?: { getReport(): unknown } }).report;
  if (!report || typeof report.getReport !== "function") throw new Error("native-profile-preflight-node-report-unavailable");
  const reportValue: unknown = report.getReport();
  if (reportValue === null || typeof reportValue !== "object" || Array.isArray(reportValue))
    throw new Error("native-profile-preflight-node-report-invalid");
  const sharedDescriptor = Object.getOwnPropertyDescriptor(reportValue, "sharedObjects");
  if (!sharedDescriptor || !Object.hasOwn(sharedDescriptor, "value"))
    throw new Error("native-profile-preflight-node-report-invalid");
  const shared: unknown = sharedDescriptor.value;
  if (!Array.isArray(shared) || shared.length > MAX_RUNTIME_FILES) throw new Error("native-profile-preflight-shared-object-list-invalid");
  const targets = new Map<string, { path: string; sha256: string; size: number }>();
  const addTarget = (target: string) => {
    const normalized = resolve(target);
    if (normalized !== target || !ALLOWED_RUNTIME_PATH.test(target)
      || /\/(?:home|root|proc|sys|dev|run|var|tmp|etc)(?:\/|$)/.test(target))
      throw new Error("native-profile-preflight-runtime-target-invalid");
    const source = realpathSync(target), file = digestRegularFile(source);
    const prior = targets.get(target);
    if (prior && (prior.path !== source || prior.sha256 !== file.sha256))
      throw new Error("native-profile-preflight-runtime-target-conflict");
    targets.set(target, file);
  };
  addTarget(nodePath);
  for (const value of shared) {
    if (typeof value !== "string" || value.length > 4096) throw new Error("native-profile-preflight-shared-object-invalid");
    if (value.startsWith("/")) addTarget(value);
  }
  const interpreter = elfInterpreter(nodePath);
  if (interpreter) addTarget(interpreter);
  if (targets.size > MAX_RUNTIME_FILES) throw new Error("native-profile-preflight-runtime-file-count-bound");
  let total = 0;
  const rows = [...targets].sort(([a], [b]) => codeUnitCompare(a, b)).map(([target, file]) => {
    total += file.size;
    if (total > MAX_TOTAL_RUNTIME_BYTES) throw new Error("native-profile-preflight-runtime-manifest-bound");
    return Object.freeze({ source: file.path, target, sha256: file.sha256 });
  });
  if (!rows.some(row => row.source === nodePath && row.target === nodePath))
    throw new Error("native-profile-preflight-node-runtime-missing");
  return Object.freeze(rows);
}

function mountIdentity(): string {
  const rows = readBoundedRegularFile("/proc/self/mountinfo", 2 * 1024 * 1024).split("\n");
  for (const row of rows) {
    if (!row) continue;
    const [leftText, rightText] = row.split(" - ");
    if (!leftText || !rightText) continue;
    const left = leftText.split(" "), right = rightText.split(" ");
    if (left[4] === "/sys/fs/cgroup" && right[0] === "cgroup2")
      return [left[0], left[1], left[2], left[3], left[4], right[0], right[1]].join(":");
  }
  throw new Error("native-profile-preflight-cgroup2-mount-unavailable");
}

function keyValues(text: string): Record<string, string> {
  const rows: Record<string, string> = Object.create(null);
  for (const line of text.trim().split("\n")) {
    const at = line.indexOf("=");
    if (at < 1 || Object.hasOwn(rows, line.slice(0, at))) throw new Error("native-profile-preflight-properties-invalid");
    rows[line.slice(0, at)] = line.slice(at + 1);
  }
  return rows;
}

function readCurrentLinuxProfileHostIdentity(): LinuxCodingProfilePreflightV1["hostIdentity"] {
  if (process.platform !== "linux" || typeof process.getuid !== "function")
    throw new Error("native-profile-preflight-linux-required");
  const uid = process.getuid();
  const systemdRunPath = realpathSync("/usr/bin/systemd-run"), systemctlPath = realpathSync("/usr/bin/systemctl");
  const systemdRunVersion = readProfileToolVersion(systemdRunPath, ["--version"], "systemd-run-version");
  const systemdVersion = readProfileToolVersion(systemctlPath, ["--version"], "systemctl-version");
  const bubblewrapVersion = readProfileToolVersion(realpathSync("/usr/bin/bwrap"), ["--version"], "bubblewrap-version");
  const managerState = readProfileToolVersion(systemctlPath, ["--user", "is-system-running"], "systemctl-user-manager");
  if (managerState !== "running") throw new Error("native-profile-preflight-user-manager-not-running");
  const properties = keyValues(runPreflightExec(systemctlPath,
    ["show", "--no-pager", `user@${uid}.service`, "--property=ControlGroup"],
    "systemctl-unit-properties"));
  const managerGroup = `/user.slice/user-${uid}.slice/user@${uid}.service`;
  if (properties.ControlGroup !== managerGroup) throw new Error("native-profile-preflight-manager-properties-unavailable");
  if (statfsSync("/sys/fs/cgroup").type !== CGROUP2_SUPER_MAGIC)
    throw new Error("native-profile-preflight-cgroup2-required");
  const controllers = readBoundedRegularFile("/sys/fs/cgroup/cgroup.controllers", 4096).trim().split(/\s+/).sort(codeUnitCompare);
  const subtreeControllers = readBoundedRegularFile("/sys/fs/cgroup/cgroup.subtree_control", 4096).trim().split(/\s+/).filter(Boolean).sort(codeUnitCompare);
  if (!["cpu", "memory", "pids"].every(name => controllers.includes(name) && subtreeControllers.includes(name)))
    throw new Error("native-profile-preflight-cgroup2-controllers-unavailable");
  const bootId = readBoundedRegularFile("/proc/sys/kernel/random/boot_id", 256).trim();
  if (!/^[0-9a-f-]{36}$/i.test(bootId)) throw new Error("native-profile-preflight-boot-id-invalid");
  return Object.freeze({ kernelRelease: awaitKernelRelease(),
    bootId, systemdVersion, systemdRunVersion, bubblewrapVersion, nodeVersion: process.version,
    cgroup2FsType: CGROUP2_SUPER_MAGIC, cgroupMountIdentity: mountIdentity(),
    controllers: Object.freeze(controllers), subtreeControllers: Object.freeze(subtreeControllers), uid,
    userManagerControlGroup: managerGroup });
}

function awaitKernelRelease(): string {
  const value = readBoundedRegularFile("/proc/sys/kernel/osrelease", 512).trim();
  if (!value || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new Error("native-profile-preflight-kernel-release-invalid");
  return value;
}

function discoverPreflight(): { capability: LinuxCodingProfilePreflightCapabilityV1; identityKey: string } {
  const host = readCurrentLinuxProfileHostIdentity();
  const systemdRun = digestRegularFile(realpathSync("/usr/bin/systemd-run"));
  const systemctl = digestRegularFile(realpathSync("/usr/bin/systemctl"));
  const bubblewrap = digestRegularFile(realpathSync("/usr/bin/bwrap"));
  const node = digestRegularFile(realpathSync(process.execPath));
  const runtimeFiles = runtimeFileManifest(node.path);
  const binaries = Object.freeze({
    systemdRun: Object.freeze({ path: systemdRun.path, sha256: systemdRun.sha256 }),
    systemctl: Object.freeze({ path: systemctl.path, sha256: systemctl.sha256 }),
    bubblewrap: Object.freeze({ path: bubblewrap.path, sha256: bubblewrap.sha256 }),
    node: Object.freeze({ path: node.path, sha256: node.sha256 }),
  });
  const binaryRows = [binaries.systemdRun, binaries.systemctl, binaries.bubblewrap, binaries.node]
    .map(row => ({ path: row.path, sha256: row.sha256 }))
    .concat(runtimeFiles.map(row => ({ path: row.source, sha256: row.sha256 })));
  const binaryDigest = sha256(JSON.stringify(binaryRows));
  const hostIdentityDigest = sha256(stableJson(host));
  const profileId = `native-coding-probe-${hostIdentityDigest.slice(0, 24)}`;
  const preflight: LinuxCodingProfilePreflightV1 = {
    version: "linux-coding-profile-preflight-v1", profileId, runtimeId: "node-source-stdin-stdout-v1",
    bounds: fixedBounds, binaries, runtimeFiles, hostIdentity: host, binaryDigest, hostIdentityDigest,
    backendSourceDigest: digestRegularFile(backendPath, false).sha256,
    producerSourceDigest: digestRegularFile(sourcePath, false).sha256,
    preflightCapabilitySourceDigest: digestRegularFile(preflightCapabilityPath, false).sha256,
    testSourceDigest: digestRegularFile(testPath, false).sha256,
  };
  const identityKey = sha256(stableJson(preflight));
  let capability: LinuxCodingProfilePreflightCapabilityV1;
  try { capability = issueLinuxCodingProfilePreflight(preflight); }
  catch { // Invalid in-process issuance means this exact source contract is not available.
    throw new Error("native-profile-preflight-source-contract-invalid"); }
  return { capability, identityKey };
}

type BackendProbeResult = Awaited<ReturnType<typeof probeNativeLinuxCodingProfile>>;
type BackendProbeDiagnostic = Extract<BackendProbeResult, { state: "unavailable" }> extends { diagnostic?: infer D } ? D : never;
export type NativeLinuxProfileProbeOutcomeV1 =
  | { state: "unavailable"; phase: "preflight" | "controls" | "receipt"; reason: string;
      profileQualification: "unavailable"; executionSource: "synthetic-control-replay"; modelGrade: null;
      diagnostic?: BackendProbeDiagnostic }
  | { state: "observed"; phase: "controls"; profileQualification: "isolation-closure-only";
      executionSource: "synthetic-control-replay"; modelGrade: null; summary: LinuxCodingProfileProbeSummary };

interface CachedProbeEntry {
  preflightCapability: LinuxCodingProfilePreflightCapabilityV1;
  probe: Promise<BackendProbeResult>;
  qualifiedProfile?: Promise<QualifiedLinuxCodingProfile>;
}
const MAX_CACHED_PROBE_TUPLES = 16;
const cachedProbes = new Map<string, CachedProbeEntry>();

function entryFor(preflight: ReturnType<typeof discoverPreflight>): CachedProbeEntry {
  const existing = cachedProbes.get(preflight.identityKey);
  if (existing) return existing;
  if (cachedProbes.size >= MAX_CACHED_PROBE_TUPLES) throw new Error("native-profile-probe-cache-capacity");
  const entry: CachedProbeEntry = {
    preflightCapability: preflight.capability,
    probe: probeNativeLinuxCodingProfile(preflight.capability),
  };
  cachedProbes.set(preflight.identityKey, entry);
  return entry;
}

function probeFor(preflight: ReturnType<typeof discoverPreflight>): Promise<BackendProbeResult> {
  return entryFor(preflight).probe;
}

function qualifiedProfileFor(preflight: ReturnType<typeof discoverPreflight>, probe: BackendProbeResult): Promise<QualifiedLinuxCodingProfile> | null {
  if (probe.state !== "observed" || !isLinuxCodingProfileProbeReceipt(probe.receipt)) return null;
  const entry = entryFor(preflight);
  if (!entry.qualifiedProfile) {
    entry.qualifiedProfile = Promise.resolve().then(() =>
      qualifyLinuxCodingProfileProbe(entry.preflightCapability, probe.receipt));
  }
  return entry.qualifiedProfile;
}

/**
 * Internal in-process capability for the normal coding owner/admission path.
 * It is derived only from this invocation's exact discovered host tuple plus the backend's
 * opaque fixed-control receipt; diagnostic JSON, imported manifests and user values cannot mint it.
 * Both successful and failed probe attempts are cached for the tuple to avoid implicit retries.
 */
export async function qualifiedLinuxCodingProfileForCurrentHost(): Promise<QualifiedLinuxCodingProfile | null> {
  let preflight: ReturnType<typeof discoverPreflight>;
  try { preflight = discoverPreflight(); }
  catch { // Discovery failure and unsupported hosts both fail closed in this capability-only getter.
    return null; }
  let probe: BackendProbeResult;
  try { probe = await probeFor(preflight); } catch { // A failed control run cannot produce an executable capability.
    return null; }
  let qualified: Promise<QualifiedLinuxCodingProfile> | null;
  try { qualified = qualifiedProfileFor(preflight, probe); } catch { // Qualification errors are unavailable to this admission getter.
    return null; }
  if (!qualified) return null;
  try { return await qualified; } catch { // Failed validation never returns a profile capability.
    return null; }
}

/**
 * Discover the current exact native host tuple, run/cache only the backend's fixed controls for
 * that tuple, and return a bounded diagnostic projection. No provider, model worker, canary slot,
 * model owner CAS, production ledger, or imported qualification data participates.
 */
export async function runNativeLinuxProfileProbe(): Promise<NativeLinuxProfileProbeOutcomeV1> {
  let preflight: ReturnType<typeof discoverPreflight>;
  try { preflight = discoverPreflight(); }
  catch (error) {
    const reason = error instanceof Error && /^native-profile-preflight-[a-z-]+$/.test(error.message)
      ? error.message : "native-profile-preflight-unavailable";
    return { state: "unavailable", phase: "preflight", reason, profileQualification: "unavailable",
      executionSource: "synthetic-control-replay", modelGrade: null };
  }
  let probed: BackendProbeResult;
  try { probed = await probeFor(preflight); }
  catch {
    const reason = cachedProbes.size >= MAX_CACHED_PROBE_TUPLES && !cachedProbes.has(preflight.identityKey)
      ? "native-profile-probe-cache-capacity" : "native-profile-probe-execution-failed";
    return { state: "unavailable", phase: "controls", reason,
      profileQualification: "unavailable", executionSource: "synthetic-control-replay", modelGrade: null };
  }
  if (probed.state === "unavailable") return { state: "unavailable", phase: probed.phase,
    reason: probed.reason, profileQualification: "unavailable", executionSource: "synthetic-control-replay",
    modelGrade: null, ...(probed.diagnostic ? { diagnostic: probed.diagnostic } : {}) };
  if (!isLinuxCodingProfileProbeReceipt(probed.receipt)) return { state: "unavailable", phase: "receipt",
    reason: "linux-profile-probe-receipt-unrecognized", profileQualification: "unavailable",
    executionSource: "synthetic-control-replay", modelGrade: null };
  const summary = readLinuxCodingProfileProbeReceipt(probed.receipt);
  if (!summary || summary.version !== "linux-coding-profile-probe-v1")
    return { state: "unavailable", phase: "receipt", reason: "linux-profile-probe-receipt-unreadable",
      profileQualification: "unavailable", executionSource: "synthetic-control-replay", modelGrade: null };
  return { state: "observed", phase: "controls", profileQualification: "isolation-closure-only",
    executionSource: "synthetic-control-replay", modelGrade: null, summary };
}
