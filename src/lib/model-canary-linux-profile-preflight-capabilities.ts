/** In-process handoff from native host discovery to the backend probe runner. */
export interface LinuxCodingProfilePreflightV1 {
  version: "linux-coding-profile-preflight-v1";
  profileId: string;
  runtimeId: "node-source-stdin-stdout-v1";
  bounds: {
    cpuQuotaMicros: number; memoryMaxBytes: number; swapMaxBytes: number; tasksMax: number;
    scratchMaxBytes: number; wallMaxMs: number; stdoutMaxBytes: number; stderrMaxBytes: number;
    heapMaxBytes: number; controlCallTimeoutMs: number; cleanupGraceMs: number;
  };
  binaries: {
    systemdRun: { path: string; sha256: string };
    systemctl: { path: string; sha256: string };
    bubblewrap: { path: string; sha256: string };
    node: { path: string; sha256: string };
  };
  runtimeFiles: readonly { source: string; target: string; sha256: string }[];
  hostIdentity: {
    kernelRelease: string; bootId: string; systemdVersion: string; systemdRunVersion: string;
    bubblewrapVersion: string; nodeVersion: string; cgroup2FsType: number;
    cgroupMountIdentity: string; controllers: readonly string[]; subtreeControllers: readonly string[]; uid: number;
    userManagerControlGroup: string;
  };
  binaryDigest: string;
  hostIdentityDigest: string;
  backendSourceDigest: string;
  producerSourceDigest: string;
  preflightCapabilitySourceDigest: string;
  testSourceDigest: string;
}

export interface LinuxCodingProfilePreflightCapabilityV1 {
  readonly kind: "linux-coding-profile-preflight-capability-v1";
}

const preflightStates = new WeakMap<object, LinuxCodingProfilePreflightV1>();
const digest = /^[a-f0-9]{64}$/;
const PREFLIGHT_KEYS = Object.freeze([
  "backendSourceDigest", "binaries", "binaryDigest", "bounds", "hostIdentity", "hostIdentityDigest",
  "preflightCapabilitySourceDigest", "producerSourceDigest", "profileId", "runtimeFiles", "runtimeId",
  "testSourceDigest", "version",
]);
const plainRecord = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function snapshot(value: unknown, depth = 0, budget = { nodes: 10_000 }): unknown {
  budget.nodes--;
  if (budget.nodes < 0) throw new Error("linux-profile-preflight-node-bound");
  if (depth > 8) throw new Error("linux-profile-preflight-depth-bound");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 8192) throw new Error("linux-profile-preflight-string-bound");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new Error("linux-profile-preflight-number-invalid");
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 128 || Object.getOwnPropertySymbols(value).length)
      throw new Error("linux-profile-preflight-array-invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Object.keys(descriptors)
      .filter(key => key !== "length");
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index)))
      throw new Error("linux-profile-preflight-array-invalid");
    const out = keys.map(key => {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("linux-profile-preflight-accessor-invalid");
      return snapshot(descriptor.value, depth + 1, budget);
    });
    return Object.freeze(out);
  }
  if (!plainRecord(value)) throw new Error("linux-profile-preflight-object-invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value), out: Record<string, unknown> = Object.create(null);
  if (Object.getOwnPropertySymbols(value).length) throw new Error("linux-profile-preflight-object-invalid");
  const keys = Object.keys(descriptors);
  if (keys.length > 128 || Object.getOwnPropertyNames(value).length !== keys.length)
    throw new Error("linux-profile-preflight-record-bound");
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("linux-profile-preflight-accessor-invalid");
    out[key] = snapshot(descriptor.value, depth + 1);
  }
  return Object.freeze(out);
}

function valid(value: unknown): value is LinuxCodingProfilePreflightV1 {
  if (!plainRecord(value) || value.version !== "linux-coding-profile-preflight-v1"
    || Object.keys(value).sort().join(",") !== PREFLIGHT_KEYS.join(",")
    || typeof value.profileId !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(value.profileId)
    || value.runtimeId !== "node-source-stdin-stdout-v1" || !plainRecord(value.bounds)
    || !plainRecord(value.binaries) || !plainRecord(value.hostIdentity)
    || !Array.isArray(value.runtimeFiles) || !digest.test(String(value.binaryDigest))
    || !digest.test(String(value.hostIdentityDigest)) || !digest.test(String(value.backendSourceDigest))
    || !digest.test(String(value.producerSourceDigest)) || !digest.test(String(value.preflightCapabilitySourceDigest))
    || !digest.test(String(value.testSourceDigest))) return false;
  const expectedBounds = { cpuQuotaMicros: 100_000, memoryMaxBytes: 268_435_456, swapMaxBytes: 0,
    tasksMax: 16, scratchMaxBytes: 16_777_216, wallMaxMs: 15_000, stdoutMaxBytes: 4096,
    stderrMaxBytes: 4096, heapMaxBytes: 67_108_864, controlCallTimeoutMs: 5000, cleanupGraceMs: 10_000 };
  const bounds = value.bounds as Record<string, unknown>, binaries = value.binaries as Record<string, unknown>;
  const runtimeFiles = value.runtimeFiles as unknown[], host = value.hostIdentity as Record<string, unknown>;
  const runtimePath = (path: unknown): path is string => typeof path === "string" && path.startsWith("/")
    && path === path.replace(/\/+/g, "/") && !path.split("/").some(part => part === "." || part === "..")
    && !path.endsWith("/");
  const stringSet = (candidate: unknown): candidate is string[] => Array.isArray(candidate)
    && candidate.length <= 32 && candidate.every(item => typeof item === "string" && /^[a-z0-9_]{1,64}$/.test(item))
    && [...candidate].sort().join(",") === candidate.join(",") && new Set(candidate).size === candidate.length;
  if (Object.keys(bounds).sort().join(",") !== Object.keys(expectedBounds).sort().join(",")
    || Object.entries(expectedBounds).some(([key, expected]) => bounds[key] !== expected)) return false;
  if (Object.keys(binaries).sort().join(",") !== "bubblewrap,node,systemctl,systemdRun"
    || [binaries.systemdRun, binaries.systemctl, binaries.bubblewrap, binaries.node]
      .some(item => !plainRecord(item) || Object.keys(item).sort().join(",") !== "path,sha256"
        || !runtimePath(item.path) || !/^\/(?:usr\/(?:bin|lib|lib64|libexec)|lib(?:64)?)(?:\/|$)/.test(item.path as string)
        || !digest.test(String(item.sha256)))) return false;
  if (runtimeFiles.length < 1 || runtimeFiles.length > 96 || runtimeFiles.some(item =>
    !plainRecord(item) || Object.keys(item).sort().join(",") !== "sha256,source,target"
      || !runtimePath(item.source) || !runtimePath(item.target)
      || !/^\/(?:usr\/(?:bin|lib|lib64|libexec)|lib(?:64)?)(?:\/|$)/.test(item.source)
      || !/^\/(?:usr\/(?:bin|lib|lib64|libexec)|lib(?:64)?)(?:\/|$)/.test(item.target)
      || /\/(?:home|root|proc|sys|dev|run|var|tmp|etc)(?:\/|$)/.test(item.source)
      || /\/(?:home|root|proc|sys|dev|run|var|tmp|etc)(?:\/|$)/.test(item.target)
      || !digest.test(String(item.sha256)))) return false;
  return Object.keys(host).sort().join(",") === "bootId,bubblewrapVersion,cgroup2FsType,cgroupMountIdentity,controllers,kernelRelease,nodeVersion,subtreeControllers,systemdRunVersion,systemdVersion,uid,userManagerControlGroup"
    && typeof host.kernelRelease === "string" && host.kernelRelease.length > 0 && host.kernelRelease.length <= 256
    && typeof host.bootId === "string" && /^[0-9a-f-]{36}$/i.test(host.bootId)
    && typeof host.systemdVersion === "string" && host.systemdVersion.length > 0 && host.systemdVersion.length <= 128
    && typeof host.systemdRunVersion === "string" && host.systemdRunVersion.length > 0 && host.systemdRunVersion.length <= 128
    && typeof host.bubblewrapVersion === "string" && host.bubblewrapVersion.length > 0 && host.bubblewrapVersion.length <= 128
    && typeof host.nodeVersion === "string" && host.nodeVersion.length > 0 && host.nodeVersion.length <= 128
    && host.cgroup2FsType === 0x63677270 && stringSet(host.controllers)
    && typeof host.cgroupMountIdentity === "string" && host.cgroupMountIdentity.length > 0 && host.cgroupMountIdentity.length <= 512
    && stringSet(host.subtreeControllers)
    && ["cpu", "memory", "pids"].every(name => (host.controllers as string[]).includes(name)
      && (host.subtreeControllers as string[]).includes(name))
    && Number.isSafeInteger(host.uid) && (host.uid as number) >= 0
    && host.userManagerControlGroup === `/user.slice/user-${host.uid}.slice/user@${host.uid}.service`;
}

/** @internal Issued only by bounded native source discovery after reading the exact host/files tuple. */
export function issueLinuxCodingProfilePreflight(value: LinuxCodingProfilePreflightV1): LinuxCodingProfilePreflightCapabilityV1 {
  const safe = snapshot(value);
  if (!valid(safe)) throw new Error("linux-profile-preflight-invalid");
  const capability = Object.freeze(Object.create(null)) as LinuxCodingProfilePreflightCapabilityV1;
  preflightStates.set(capability, safe);
  return capability;
}

/** Only the fixed-control backend accepts this private in-process handoff. */
export function readLinuxCodingProfilePreflight(value: unknown): LinuxCodingProfilePreflightV1 | null {
  return value !== null && typeof value === "object" ? preflightStates.get(value as object) ?? null : null;
}
