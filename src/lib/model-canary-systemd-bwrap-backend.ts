/**
 * Bounded Linux systemd-cgroup-v2 + bubblewrap coding executor.
 * A profile capability is issued only by the native owner after host-specific
 * readback/isolation qualification; this source alone does not qualify a host.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statfsSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  CodingBackendResult, CodingConfiguredBounds, CodingControlBindingV1, CodingExecutionReason,
} from "./model-canary-coding.js";
import { readLinuxCodingProfilePreflight, type LinuxCodingProfilePreflightCapabilityV1,
  type LinuxCodingProfilePreflightV1 } from "./model-canary-linux-profile-preflight-capabilities.js";

export interface LinuxRuntimeFile {
  /** Exact host file, never a directory, symlink, home/config tree, or candidate path. */
  source: string;
  /** Read-only destination in the isolated root; normally identical to source. */
  target: string;
  sha256: string;
}

export interface LinuxCodingProfileSpec {
  profileId: string;
  profileDigest: string;
  binaryDigest: string;
  /** Exact build/source digest of this backend implementation. */
  backendSourceDigest: string;
  producerSourceDigest: string;
  testSourceDigest: string;
  preflightCapabilitySourceDigest: string;
  /** Exact native host tuple recorded by the fixed provider-free probe. */
  hostIdentityDigest: string;
  /** Digest of the backend-owned three-control program manifest. */
  controlSourceDigest: string;
  runtimeId: "node-source-stdin-stdout-v1";
  bounds: CodingConfiguredBounds;
  systemdRun: { path: string; sha256: string };
  systemctl: { path: string; sha256: string };
  bubblewrap: { path: string; sha256: string };
  node: { path: string; sha256: string };
  /** Complete owner-reviewed ELF loader/runtime files. No directory mounts. */
  runtimeFiles: readonly LinuxRuntimeFile[];
  /** Opaque exact-host isolation proof digest, bound into profileDigest. */
  isolationProofDigest: string;
  /** Unit startup/control timeout, separate from the candidate's hard runtime. */
  controlCallTimeoutMs: number;
  /** Finite owner-authorized time for readback, release and unit closure after candidate wall. */
  cleanupGraceMs: number;
}

export interface QualifiedLinuxCodingProfile { readonly kind: "qualified-linux-coding-profile-v1" }
const profileStates = new WeakMap<object, LinuxCodingProfileSpec>();

export interface LinuxCodingProfileProbeReceipt { readonly kind: "linux-coding-profile-probe-receipt-v1" }
export interface LinuxCodingProfileProbeSummary {
  version: "linux-coding-profile-probe-v1";
  profileProbeId: string;
  profileId: string;
  profileDigest: string;
  binaryDigest: string;
  backendSourceDigest: string;
  producerSourceDigest: string;
  testSourceDigest: string;
  preflightCapabilitySourceDigest: string;
  controlSourceDigest: string;
  hostIdentityDigest: string;
  controls: Record<"known-good" | "known-bad" | "cancel-descendant", {
    controlAttemptId: string;
    sourceDigest: string;
    state: "passed" | "failed" | "unavailable";
    hostExecutionId: string | null;
    exitCode: number | null;
    candidateClosed: boolean;
    unitClosureBasis: "cgroup-events-empty" | "pinned-cgroup-removed" | null;
    unitRetirement: "not-attempted" | "not-needed" | "retired" | "failed";
    diagnosticDigest: string | null;
  }>;
  unitReadbacks: { cpuQuotaMicros: { configured: number | null; readback: number | null };
    memoryMaxBytes: { configured: number | null; readback: number | null };
    swapMaxBytes: { configured: number | null; readback: number | null };
    tasksMax: { configured: number | null; readback: number | null } };
  scratchMountReadbacks: { rootConfiguredBytes: number; rootReadbackBytes: number;
    tmpConfiguredBytes: number; tmpReadbackBytes: number };
  isolation: { userNamespace: boolean | null; pidNamespace: boolean | null; networkNamespace: boolean | null; ipcNamespace: boolean | null; utsNamespace: boolean | null;
    mountNamespace: boolean | null; cgroupNamespace: boolean | null; rootReadOnly: boolean | null;
    tmpfsScratch: boolean | null; devReadOnly: boolean | null; devRegularWriteDenied: boolean | null;
    devNullWritable: boolean | null; procReadOnly: boolean | null; devPtsReadOnly: boolean | null;
    devPtsPseudoFilesystem: boolean | null;
    cleanEnvironment: boolean | null; parentEnvironmentHidden: boolean | null };
  observed: { cpuUsec: number | null; memoryPeakBytes: number | null; swapPeakBytes: number | null;
    pidsPeak: number | null; scratchPeakBytes: null; wallMs: number | null; stdoutBytes: number | null;
    stderrBytes: number | null; heapPeakBytes: null };
  profileQualification: "isolation-closure-only";
}
type InternalProbeReceipt = { summary: LinuxCodingProfileProbeSummary; profile: LinuxCodingProfileSpec;
  preflightDigest: string };
const probeReceiptStates = new WeakMap<object, InternalProbeReceipt>();

function freezeProfile(spec: LinuxCodingProfileSpec): QualifiedLinuxCodingProfile {
  validateProfileSpec(spec);
  const capability = Object.freeze(Object.create(null)) as QualifiedLinuxCodingProfile;
  profileStates.set(capability, Object.freeze({ ...spec,
    bounds: Object.freeze({ ...spec.bounds }), systemdRun: Object.freeze({ ...spec.systemdRun }),
    systemctl: Object.freeze({ ...spec.systemctl }), bubblewrap: Object.freeze({ ...spec.bubblewrap }),
    node: Object.freeze({ ...spec.node }),
    runtimeFiles: Object.freeze(spec.runtimeFiles.map(file => Object.freeze({ ...file }))) }));
  return capability;
}

export function isLinuxCodingProfileProbeReceipt(value: unknown): value is LinuxCodingProfileProbeReceipt {
  return value !== null && typeof value === "object" && probeReceiptStates.has(value as object);
}

export function readLinuxCodingProfileProbeReceipt(value: unknown): LinuxCodingProfileProbeSummary | null {
  const receipt = value !== null && typeof value === "object" ? probeReceiptStates.get(value as object) : undefined;
  return receipt ? snapshotProbeSummary(receipt.summary) : null;
}

/** The exact host/profile and probe evidence must originate from this backend's opaque receipt. */
export function qualifyLinuxCodingProfileProbe(
  preflightCapability: LinuxCodingProfilePreflightCapabilityV1,
  receiptValue: LinuxCodingProfileProbeReceipt,
): QualifiedLinuxCodingProfile {
  const receipt = probeReceiptStates.get(receiptValue as object);
  const preflight = readLinuxCodingProfilePreflight(preflightCapability);
  if (!receipt || !preflight || receipt.preflightDigest !== sha256(stableProbeJson(preflight)))
    throw new Error("linux-coding-profile-probe-receipt-invalid");
  if (receipt.summary.profileDigest !== receipt.profile.profileDigest ||
      Object.keys(receipt.summary.controls).sort().join(",") !== [...PROFILE_CONTROL_NAMES].sort().join(",") ||
      Object.values(receipt.summary.controls).some(control => control.state !== "passed" || !control.candidateClosed ||
        !control.unitClosureBasis || !["not-needed", "retired"].includes(control.unitRetirement) ||
        !control.hostExecutionId || !HEX.test(control.sourceDigest) || !HEX.test(control.diagnosticDigest ?? "")) ||
      Object.values(receipt.summary.isolation).some(value => value !== true) ||
      receipt.summary.scratchMountReadbacks.rootReadbackBytes !== receipt.summary.scratchMountReadbacks.rootConfiguredBytes ||
      receipt.summary.scratchMountReadbacks.tmpReadbackBytes !== receipt.summary.scratchMountReadbacks.tmpConfiguredBytes ||
      receipt.summary.profileQualification !== "isolation-closure-only" ||
      receipt.summary.observed.heapPeakBytes !== null || receipt.summary.observed.scratchPeakBytes !== null)
    throw new Error("linux-coding-profile-probe-controls-incomplete");
  return freezeProfile(receipt.profile);
}

/** A JSON-shaped profile is not a qualified capability; native owners use this for pre-provider admission. */
export function isQualifiedLinuxCodingProfile(value: unknown): value is QualifiedLinuxCodingProfile {
  return value !== null && typeof value === "object" && profileStates.has(value as object);
}

/** Only a native owner-held profile capability exposes limits for pre-provider admission. */
export function getQualifiedLinuxCodingBounds(value: unknown): CodingConfiguredBounds | null {
  if (!isQualifiedLinuxCodingProfile(value)) return null;
  return Object.freeze({ ...profileStates.get(value as object)!.bounds });
}

export const LINUX_CODING_OUTPUT_PROTOCOL = "rmd-coding-result-v1" as const;
export const LINUX_CODING_RESULT_LINE_MAX = 24_576; // PRIMARY CONTROL: caps the supervisor result frame before parsing.
export const LINUX_CODING_REQUEST_MAX = 16_384; // PRIMARY CONTROL: caps each request frame before JSON parsing.
export const CGROUP2_SUPER_MAGIC = 0x63677270;
const HEX = /^[a-f0-9]{64}$/;
const MAX_PROFILE_FILES = 96;
const MAX_PROFILE_JSON_BYTES = 48 * 1024;
const READ_MAX = 4096;
const PROFILE_CONTROL_NAMES = ["known-good", "known-bad", "cancel-descendant"] as const;
const PROFILE_CONTROL_SOURCES = Object.freeze({
  "known-good": "const fs=require('node:fs');const xs=fs.readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);const ns={user:fs.readlinkSync('/proc/self/ns/user'),pid:fs.readlinkSync('/proc/self/ns/pid'),net:fs.readlinkSync('/proc/self/ns/net'),ipc:fs.readlinkSync('/proc/self/ns/ipc'),uts:fs.readlinkSync('/proc/self/ns/uts'),mnt:fs.readlinkSync('/proc/self/ns/mnt'),cgroup:fs.readlinkSync('/proc/self/ns/cgroup')};const rows=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\\n').map(x=>x.split(' '));const mount=path=>rows.find(x=>x[4]===path);const fsType=x=>{const d=x?.indexOf('-')??-1;return d<0?'':x[d+1]};const ro=x=>!!x&&x[5].split(',').includes('ro');const size=x=>{if(!x)return null;const d=x.indexOf('-');const m=(d<0?'':x[d+3]).split(',').find(y=>y.startsWith('size='));if(!m)return null;const raw=m.slice(5);if(!raw.endsWith('k'))return null;const digits=raw.slice(0,-1);if(!/^(0|[1-9][0-9]*)$/.test(digits))return null;const n=Number(digits);if(!Number.isSafeInteger(n)||n>Math.floor(Number.MAX_SAFE_INTEGER/1024))return null;return n*1024};const dev=mount('/dev'),proc=mount('/proc'),pts=mount('/dev/pts'),root=mount('/'),tmp=mount('/tmp');const probe='/dev/.rmd-profile-write-probe-'+process.pid;let denied=false;try{const fd=fs.openSync(probe,'wx');fs.closeSync(fd);fs.unlinkSync(probe)}catch(e){/* EROFS is the expected proof; every other outcome stays false. */ denied=e&&e.code==='EROFS'}let nullWritable=false;try{const fd=fs.openSync('/dev/null','w');fs.writeSync(fd,Buffer.from('x'));fs.closeSync(fd);nullWritable=true}catch{/* A failed /dev/null write is reported as an unproved readback. */}process.stdout.write(JSON.stringify({sum:xs.reduce((a,b)=>a+b,0),ns,root:{ro:ro(root),type:fsType(root),size:size(root)},tmp:{ro:ro(tmp),type:fsType(tmp),size:size(tmp)},dev:{ro:ro(dev),type:fsType(dev),regularWriteDenied:denied,nullWritable},proc:{ro:ro(proc),type:fsType(proc)},devPts:{ro:ro(pts),type:fsType(pts)},env:Object.keys(process.env).sort(),pwd:process.env.PWD})+'\\n')",
  "known-bad": "process.stdout.write('999999\\n')",
  "cancel-descendant": "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['--v8-pool-size=1','--max-old-space-size=64','-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.once('spawn',()=>process.stdout.write('RMD_PROFILE_READY '+c.pid+'\\n'));setInterval(()=>{},1000)",
});
export const LINUX_CODING_PROFILE_KNOWN_GOOD_CONTROL_SOURCE = PROFILE_CONTROL_SOURCES["known-good"];
export const LINUX_CODING_PROFILE_CANCEL_CONTROL_SOURCE = PROFILE_CONTROL_SOURCES["cancel-descendant"];

type UnitRetirementState = "not-attempted" | "not-needed" | "retired" | "failed";

type Properties = Record<string, string>;
type CandidateResult = {
  protocol: typeof LINUX_CODING_OUTPUT_PROTOCOL;
  pid: number;
  exitCode: number;
  stdoutBase64: string;
  stderrBase64: string;
  stdoutBytes: number;
  stderrBytes: number;
  candidateWallMs: number;
  candidateClosedBeforeMetrics: true;
};

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const PROFILE_CONTROL_SOURCE_DIGEST = sha256(JSON.stringify(PROFILE_CONTROL_SOURCES));
let profileProbeBusy = false;
let profileProbeClosureHeld = false;
const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");
function digestFd(fd: number): string {
  const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
  for (;;) { const n = readSync(fd, chunk, 0, chunk.length, null); if (!n) break; hash.update(chunk.subarray(0, n)); }
  return hash.digest("hex");
}

function validateProfileSpec(s: LinuxCodingProfileSpec): void {
  if (!s || s.runtimeId !== "node-source-stdin-stdout-v1" || !s.profileId || s.profileId.length > 128 ||
      !HEX.test(s.profileDigest) || !HEX.test(s.binaryDigest) || !HEX.test(s.backendSourceDigest) ||
      !HEX.test(s.producerSourceDigest) || !HEX.test(s.testSourceDigest) || !HEX.test(s.hostIdentityDigest) ||
      !HEX.test(s.preflightCapabilitySourceDigest) || !HEX.test(s.controlSourceDigest) || !HEX.test(s.isolationProofDigest) ||
      !Number.isSafeInteger(s.controlCallTimeoutMs) || s.controlCallTimeoutMs < 100 || s.controlCallTimeoutMs > 10_000 ||
      !Number.isSafeInteger(s.cleanupGraceMs) || s.cleanupGraceMs < s.controlCallTimeoutMs || s.cleanupGraceMs > 30_000 ||
      !validBounds(s.bounds) || s.bounds.profileId !== s.profileId || s.bounds.profileDigest !== s.profileDigest ||
      s.bounds.binaryDigest !== s.binaryDigest || s.runtimeFiles.length < 1 || s.runtimeFiles.length > MAX_PROFILE_FILES) {
    throw new Error("linux-coding-profile-invalid");
  }
  const pathRows = [s.systemdRun, s.systemctl, s.bubblewrap, s.node].map(item => ({ path: item.path, sha256: item.sha256 }))
    .concat(s.runtimeFiles.map(item => ({ path: item.source, sha256: item.sha256 })));
  for (const item of pathRows) {
    if (!item || !isAbsolute(item.path) || !HEX.test(item.sha256)) throw new Error("linux-coding-profile-path-invalid");
    const path = item.path;
    if (realpathSync(path) !== path) throw new Error("linux-coding-profile-symlink-or-noncanonical-path");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("linux-coding-profile-requires-regular-files");
      const stat = fstatSync(fd);
      if (stat.size < 1 || stat.size > 512 * 1024 * 1024) throw new Error("linux-coding-profile-file-size-invalid");
      if (digestFd(fd) !== item.sha256) throw new Error("linux-coding-profile-digest-mismatch");
    } finally { closeSync(fd); }
  }
  for (const file of s.runtimeFiles) {
    const p = normalize(file.source), target = normalize(file.target);
    // Only exact runtime files in conventional binary/library trees are admitted.
    if (p !== file.source || target !== file.target || !isAbsolute(target) ||
        !(/^\/(?:usr\/(?:bin|lib|lib64|libexec)|lib(?:64)?)(?:\/|$)/.test(p)) ||
        !(/^\/(?:usr\/(?:bin|lib|lib64|libexec)|lib(?:64)?)(?:\/|$)/.test(target)) ||
        /\/(?:home|root|proc|sys|dev|run|var|tmp|etc)(?:\/|$)/.test(p) ||
        /\/(?:home|root|proc|sys|dev|run|var|tmp|etc)(?:\/|$)/.test(target) ||
        target === "/" || target.startsWith("/proc/") || target.startsWith("/sys/") || target.startsWith("/home/")) {
      throw new Error("linux-coding-profile-runtime-file-outside-allowlist");
    }
  }
  if (new Set(s.runtimeFiles.map(file => file.target)).size !== s.runtimeFiles.length)
    throw new Error("linux-coding-profile-runtime-target-duplicate");
  if (!s.runtimeFiles.some(file => file.source === s.node.path && file.target === s.node.path && file.sha256 === s.node.sha256))
    throw new Error("linux-coding-profile-node-not-mounted");
  const binaryManifest = JSON.stringify(pathRows.map(row => ({ path: row.path, sha256: row.sha256 })));
  if (sha256(binaryManifest) !== s.binaryDigest) throw new Error("linux-coding-profile-binary-manifest-mismatch");
  const canonicalProfile = canonicalProfileJson(s);
  if (Buffer.byteLength(canonicalProfile, "utf8") > MAX_PROFILE_JSON_BYTES) throw new Error("linux-coding-profile-bound");
  if (sha256(canonicalProfile) !== s.profileDigest) throw new Error("linux-coding-profile-manifest-mismatch");
}

function canonicalProfileJson(s: LinuxCodingProfileSpec): string {
  const pathRows = [s.systemdRun, s.systemctl, s.bubblewrap, s.node].map(item => ({ path: item.path, sha256: item.sha256 }))
    .concat(s.runtimeFiles.map(item => ({ path: item.source, sha256: item.sha256 })));
  return JSON.stringify({
    profileId: s.profileId, runtimeId: s.runtimeId, hostIdentityDigest: s.hostIdentityDigest,
    controlSourceDigest: s.controlSourceDigest, bounds: { ...s.bounds, profileDigest: "" },
    isolationProofDigest: s.isolationProofDigest, backendSourceDigest: s.backendSourceDigest,
    producerSourceDigest: s.producerSourceDigest, testSourceDigest: s.testSourceDigest,
    preflightCapabilitySourceDigest: s.preflightCapabilitySourceDigest,
    wrapperDigest: sha256(SERVICE_WRAPPER), controlCallTimeoutMs: s.controlCallTimeoutMs,
    cleanupGraceMs: s.cleanupGraceMs, binaries: pathRows,
    runtimeFiles: s.runtimeFiles.map(f => ({ source: f.source, target: f.target, sha256: f.sha256 })),
  });
}

function profileFromPreflight(preflight: LinuxCodingProfilePreflightV1, isolationProofDigest: string): LinuxCodingProfileSpec {
  const systemdRun = { ...preflight.binaries.systemdRun }, systemctl = { ...preflight.binaries.systemctl };
  const bubblewrap = { ...preflight.binaries.bubblewrap }, node = { ...preflight.binaries.node };
  const pathRows = [systemdRun, systemctl, bubblewrap, node].map(row => ({ path: row.path, sha256: row.sha256 }))
    .concat(preflight.runtimeFiles.map(row => ({ path: row.source, sha256: row.sha256 })));
  if (sha256(JSON.stringify(pathRows)) !== preflight.binaryDigest) throw new Error("linux-profile-preflight-binary-digest-mismatch");
  const emptyDigest = "0".repeat(64);
  const bounds: CodingConfiguredBounds = { runtimeId: preflight.runtimeId, profileId: preflight.profileId,
    profileDigest: emptyDigest, binaryDigest: preflight.binaryDigest,
    cpuQuotaMicros: preflight.bounds.cpuQuotaMicros, memoryMaxBytes: preflight.bounds.memoryMaxBytes,
    swapMaxBytes: preflight.bounds.swapMaxBytes, tasksMax: preflight.bounds.tasksMax,
    scratchMaxBytes: preflight.bounds.scratchMaxBytes, wallMaxMs: preflight.bounds.wallMaxMs,
    stdoutMaxBytes: preflight.bounds.stdoutMaxBytes, stderrMaxBytes: preflight.bounds.stderrMaxBytes,
    heapMaxBytes: preflight.bounds.heapMaxBytes };
  const spec: LinuxCodingProfileSpec = { profileId: preflight.profileId, profileDigest: emptyDigest,
    binaryDigest: preflight.binaryDigest, backendSourceDigest: preflight.backendSourceDigest,
    producerSourceDigest: preflight.producerSourceDigest, testSourceDigest: preflight.testSourceDigest,
    preflightCapabilitySourceDigest: preflight.preflightCapabilitySourceDigest,
    hostIdentityDigest: preflight.hostIdentityDigest, controlSourceDigest: PROFILE_CONTROL_SOURCE_DIGEST,
    runtimeId: preflight.runtimeId, bounds, systemdRun, systemctl, bubblewrap, node,
    runtimeFiles: preflight.runtimeFiles.map(file => ({ ...file })),
    isolationProofDigest, controlCallTimeoutMs: preflight.bounds.controlCallTimeoutMs,
    cleanupGraceMs: preflight.bounds.cleanupGraceMs };
  const profileDigest = sha256(canonicalProfileJson(spec));
  spec.profileDigest = profileDigest; spec.bounds.profileDigest = profileDigest;
  return spec;
}

function snapshotProbeSummary(summary: LinuxCodingProfileProbeSummary): LinuxCodingProfileProbeSummary {
  return Object.freeze({ ...summary,
    controls: Object.freeze(Object.fromEntries(PROFILE_CONTROL_NAMES.map(name => [name, Object.freeze({ ...summary.controls[name] })]))),
    unitReadbacks: Object.freeze(Object.fromEntries(Object.entries(summary.unitReadbacks).map(([key, value]) => [key, Object.freeze({ ...value })]))),
    scratchMountReadbacks: Object.freeze({ ...summary.scratchMountReadbacks }),
    isolation: Object.freeze({ ...summary.isolation }), observed: Object.freeze({ ...summary.observed }) }) as LinuxCodingProfileProbeSummary;
}

function validBounds(b: CodingConfiguredBounds): boolean {
  return !!b && b.runtimeId === "node-source-stdin-stdout-v1" && HEX.test(b.profileDigest) && HEX.test(b.binaryDigest)
    && Number.isSafeInteger(b.cpuQuotaMicros) && b.cpuQuotaMicros > 0 && b.cpuQuotaMicros <= 10_000_000
    && Number.isSafeInteger(b.memoryMaxBytes) && b.memoryMaxBytes >= 16 * 1024 * 1024
    && Number.isSafeInteger(b.swapMaxBytes) && b.swapMaxBytes >= 0
    && Number.isSafeInteger(b.tasksMax) && b.tasksMax >= 3 && b.tasksMax <= 4096
    && Number.isSafeInteger(b.scratchMaxBytes) && b.scratchMaxBytes >= 1024 * 1024
    && Number.isSafeInteger(b.wallMaxMs) && b.wallMaxMs >= 100 && b.wallMaxMs <= 60 * 60 * 1000
    && Number.isSafeInteger(b.stdoutMaxBytes) && b.stdoutMaxBytes > 0 && b.stdoutMaxBytes <= 4096
    && Number.isSafeInteger(b.stderrMaxBytes) && b.stderrMaxBytes > 0 && b.stderrMaxBytes <= 4096
    && Number.isSafeInteger(b.heapMaxBytes) && b.heapMaxBytes >= 1024 * 1024 && b.heapMaxBytes <= b.memoryMaxBytes;
}

function capMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new Error("linux-coding-control-timeout-invalid");
  return value;
}

/** Fixed trusted service-side wrapper. Candidate source is input data, never evaluated by this wrapper. */
const SERVICE_WRAPPER = `
const {spawn}=require('node:child_process');
const {readFileSync,readSync,openSync,closeSync,constants,fstatSync,realpathSync}=require('node:fs');
const {createHash}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const plan=JSON.parse(Buffer.from(process.env.RMD_CODING_PLAN_B64||'','base64').toString('utf8'));
let input=Buffer.alloc(0), requestLine='', sourceBytes=0, state='request', release=Buffer.alloc(0), finished=false;
function fail(text){try{process.stderr.write(String(text).slice(0,2048)+'\\n')}catch{/* The nonzero exit is the failure signal when diagnostics cannot be written. */}process.exitCode=125;process.exit()}
function checkFile(f){if(realpathSync(f.path)!==f.path)throw Error('runtime-file-identity-mismatch');const fd=openSync(f.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{if(!fstatSync(fd).isFile())throw Error('runtime-file-not-regular');const h=createHash('sha256'),b=Buffer.alloc(65536);for(;;){const n=readSync(fd,b,0,b.length,null);if(!n)break;h.update(b.subarray(0,n))}if(h.digest('hex')!==f.sha256)throw Error('runtime-file-digest-mismatch')}finally{closeSync(fd)}}
function cgroupPath(){const row=readFileSync('/proc/self/cgroup','utf8').split('\\n').find(x=>x.startsWith('0::'));if(!row)throw Error('self-cgroup-missing');return row.slice(3)}
function verifyOnlySupervisor(path){const rows=readFileSync('/sys/fs/cgroup'+path+'/cgroup.procs','utf8').trim().split(/\\s+/).filter(Boolean).map(Number);if(rows.length!==1||rows[0]!==process.pid)throw Error('candidate-descendant-remains')}
const candidateBootstrap="const fs=require('node:fs'),crypto=require('node:crypto');const chunks=[];let total=0,b=Buffer.alloc(4096),n;try{for(;;){n=fs.readSync(3,b,0,b.length,null);if(!n)break;total+=n;if(total>8192)throw Error('candidate-source-bound');chunks.push(Buffer.from(b.subarray(0,n)))}const source=Buffer.concat(chunks,total).toString('utf8'),expected=process.env.RMD_CODING_SOURCE_DIGEST;delete process.env.RMD_CODING_SOURCE_DIGEST;fs.closeSync(3);if(!/^[a-f0-9]{64}$/.test(expected)||crypto.createHash('sha256').update(source,'utf8').digest('hex')!==expected)throw Error('candidate-source-digest-mismatch');const module={exports:{}};new Function('require','module','exports','__filename','__dirname',source)(require,module,module.exports,'/work/candidate.js','/work')}catch(e){process.stderr.write(('candidate-bootstrap:'+String(e&&e.message||e)+'\\\\n').slice(0,1024));process.exitCode=125}";
function bwrapArgs(req){const rootHalf=Math.floor(plan.bounds.scratchMaxBytes/2), tmpHalf=plan.bounds.scratchMaxBytes-rootHalf;const a=['--unshare-user','--disable-userns','--assert-userns-disabled','--unshare-pid','--unshare-net','--unshare-ipc','--unshare-uts','--hostname','rmd-coding','--unshare-cgroup','--new-session','--die-with-parent','--size',String(rootHalf),'--tmpfs','/','--dir','/dev','--dev','/dev','--dir','/proc','--proc','/proc','--dir','/tmp','--size',String(tmpHalf),'--tmpfs','/tmp','--dir','/work'];const dirs=new Set();for(const f of plan.runtimeFiles){let d=require('node:path').posix.dirname(f.target);while(d!=='/'&&!dirs.has(d)){dirs.add(d);d=require('node:path').posix.dirname(d)}}for(const d of [...dirs].sort((x,y)=>x.length-y.length))a.push('--dir',d);for(const f of plan.runtimeFiles)a.push('--ro-bind',f.source,f.target);a.push('--remount-ro','/dev','--remount-ro','/proc','--remount-ro','/dev/pts','--remount-ro','/','--chdir','/work','--clearenv','--setenv','HOME','/nonexistent','--setenv','TMPDIR','/tmp','--setenv','PATH',require('node:path').posix.dirname(plan.node.path),'--setenv','LANG','C','--setenv','RMD_CODING_SOURCE_DIGEST',req.sourceDigest,'--','--');a[a.length-1]=plan.node.path;a.push('--v8-pool-size=1','--max-old-space-size='+Math.floor(plan.bounds.heapMaxBytes/(1024*1024)),'-e',candidateBootstrap);return a}
function consume(line,source){
let req;try{
if(Buffer.byteLength(line)>16384)throw Error('request-bound');
req=JSON.parse(line);
const isProbe=!!req&&typeof req.profileControl==='string';
const expectedKeys=isProbe?(req.profileControl==='known-good'?'controlGroup,parentSentinel,profileControl,sourceBytes,sourceDigest,stdin':'controlGroup,profileControl,sourceBytes,sourceDigest,stdin'):'controlGroup,sourceBytes,sourceDigest,stdin';
if(!req||Object.keys(req).sort().join(',')!==expectedKeys||(isProbe&&!['known-good','known-bad','cancel-descendant'].includes(req.profileControl))||!Number.isSafeInteger(req.sourceBytes)||req.sourceBytes<1||req.sourceBytes>8192||Buffer.byteLength(source)!==req.sourceBytes||typeof req.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(req.sourceDigest)||typeof req.stdin!=='string'||Buffer.byteLength(req.stdin)>4096)throw Error('request-shape');
if(isProbe&&req.profileControl==='known-good'&&(!/^[a-f0-9]{64}$/.test(req.parentSentinel)||process.env.RMD_PROFILE_PARENT_SENTINEL!==req.parentSentinel))throw Error('profile-parent-sentinel-mismatch');
if(createHash('sha256').update(source,'utf8').digest('hex')!==req.sourceDigest)throw Error('source-digest-mismatch');
if(realpathSync(process.execPath)!==plan.node.path)throw Error('service-node-identity-mismatch');
checkFile(plan.bubblewrap);for(const f of plan.runtimeFiles)checkFile({path:f.source,sha256:f.sha256});
if(isProbe&&req.profileControl==='known-good')process.stdout.write('RMD_PROFILE_PARENT_SENTINEL '+req.parentSentinel+'\\n');
}catch(e){/* Invalid request or runtime validation exits before candidate launch. */return fail(e.message)}
let group;try{group=cgroupPath();if(group!==req.controlGroup||!group.endsWith('/'+plan.unit+'.service'))throw Error('unit-cgroup-mismatch')}catch(e){/* Unknown unit placement is fail-closed before candidate launch. */return fail(e.message)}
const start=performance.now(), child=spawn(plan.bubblewrap.path,bwrapArgs(req),{stdio:['pipe','pipe','pipe','pipe'],env:{PATH:require('node:path').posix.dirname(plan.bubblewrap.path),HOME:'/nonexistent',LANG:'C'}});let out=[],err=[],outN=0,errN=0,overflow=false,markerTail='';function take(list,chunk,which){const max=which==='stdout'?plan.bounds.stdoutMaxBytes:plan.bounds.stderrMaxBytes;let n=which==='stdout'?outN:errN;if(n+chunk.length>max){const keep=Math.max(0,max-n);if(keep)list.push(chunk.subarray(0,keep));overflow=true;try{child.kill('SIGKILL')}catch{/* Best-effort output/kill failure remains covered by explicit closure state. */}return}list.push(chunk);if(which==='stdout')outN+=chunk.length;else errN+=chunk.length;if(which==='stdout'&&req.profileControl==='cancel-descendant'){const text=markerTail+chunk.toString('utf8');const marker=text.match(/RMD_PROFILE_READY ([1-9][0-9]*)\\n/);if(marker){process.stdout.write(marker[0]);markerTail=text.slice(text.indexOf(marker[0])+marker[0].length)}else markerTail=text.slice(-64)}}child.stdout.on('data',x=>take(out,x,'stdout'));child.stderr.on('data',x=>take(err,x,'stderr'));const sourceFd=child.stdio[3];if(!sourceFd){overflow=true;try{child.kill('SIGKILL')}catch{/* Best-effort output/kill failure remains covered by explicit closure state. */}}else{sourceFd.on('error',()=>{overflow=true;try{child.kill('SIGKILL')}catch{/* Best-effort output/kill failure remains covered by explicit closure state. */}});sourceFd.end(source,'utf8')}child.stdin.end(req.stdin);child.once('error',e=>{try{process.stderr.write(('candidate-spawn:'+e.code+'\\n').slice(0,512))}catch{/* Best-effort output/kill failure remains covered by explicit closure state. */}});child.once('close',(code,signal)=>{let closed=false;try{verifyOnlySupervisor(group);closed=true}catch(e){/* Supervisor membership is required before result framing. */return fail(e.message)}const result={protocol:'rmd-coding-result-v1',pid:process.pid,exitCode:Number.isInteger(code)?code:125,stdoutBase64:Buffer.concat(out).toString('base64'),stderrBase64:Buffer.concat(err).toString('base64'),stdoutBytes:outN,stderrBytes:errN,candidateWallMs:Math.ceil(performance.now()-start),candidateClosedBeforeMetrics:closed&&!overflow};if(overflow){result.exitCode=125;result.candidateClosedBeforeMetrics=false}process.stdout.write('RMD_RESULT '+JSON.stringify(result)+'\\n');state='release';});}
function receiveSource(){if(input.length>sourceBytes){finished=true;return fail('source-frame-overrun')}if(input.length<sourceBytes)return;const source=input.toString('utf8');input=Buffer.alloc(0);state='running';consume(requestLine,source)}
process.stdin.on('data',chunk=>{if(finished)return;if(state==='request'){input=Buffer.concat([input,chunk]);if(input.length>16384){finished=true;return fail('request-stream-bound')}const at=input.indexOf(10);if(at>=0){requestLine=input.subarray(0,at).toString('utf8');const rest=input.subarray(at+1);try{const req=JSON.parse(requestLine);sourceBytes=req&&req.sourceBytes;if(!Number.isSafeInteger(sourceBytes)||sourceBytes<1||sourceBytes>8192)throw Error('source-frame-bound')}catch(e){/* An invalid source length fails before any candidate bytes are accepted. */finished=true;return fail(e.message)}input=rest;state='source';receiveSource()}}else if(state==='source'){if(input.length+chunk.length>sourceBytes){finished=true;return fail('source-frame-overrun')}input=Buffer.concat([input,chunk]);receiveSource()}else if(state==='release'){release=Buffer.concat([release,chunk]);if(release.includes(10)){finished=true;process.stdin.pause();process.exit(0)}}});process.stdin.on('end',()=>{if(state!=='release')fail('controller-input-closed-before-result')});
`;
export const LINUX_CODING_SERVICE_WRAPPER_SOURCE = SERVICE_WRAPPER;

const SAFE_WRAPPER_FAILURE_CODES = new Set([
  "candidate-descendant-remains", "controller-input-closed-before-result", "profile-parent-sentinel-mismatch",
  "request-bound", "request-shape", "request-stream-bound", "self-cgroup-missing", "service-node-identity-mismatch",
  "source-digest-mismatch", "source-frame-bound", "source-frame-overrun", "unit-cgroup-mismatch",
  "runtime-file-identity-mismatch", "runtime-file-not-regular", "runtime-file-digest-mismatch",
]);

function safeWrapperFailureCode(stderr: string): string | null {
  const lastLine = stderr.trimEnd().split("\n").at(-1) ?? "";
  return SAFE_WRAPPER_FAILURE_CODES.has(lastLine) ? lastLine : null;
}

function cpuQuotaPercent(microsPer100ms: number): string {
  const milliPercent = microsPer100ms / 1000;
  const whole = Math.floor(milliPercent), fraction = microsPer100ms % 1000;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`;
}

function systemdProperties(profile: LinuxCodingProfileSpec, unit: string): string[] {
  const b = profile.bounds;
  return [
    "Type=exec", "ExitType=cgroup", "Restart=no", "KillMode=control-group", "SendSIGKILL=yes", "Delegate=no",
    "Slice=app.slice", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes",
    "CPUAccounting=yes", "MemoryAccounting=yes", "TasksAccounting=yes",
    "PrivateNetwork=yes", "RuntimeRandomizedExtraSec=0", `CPUQuota=${cpuQuotaPercent(b.cpuQuotaMicros)}%`,
    "CPUQuotaPeriodSec=100ms", `MemoryMax=${b.memoryMaxBytes}`, `MemorySwapMax=${b.swapMaxBytes}`,
    `TasksMax=${b.tasksMax}`, `RuntimeMaxSec=${b.wallMaxMs + profile.cleanupGraceMs}ms`,
  ].map(value => `--property=${value}`);
}

function parseProperties(text: string): Properties {
  const out: Properties = {};
  for (const line of text.trim().split("\n")) {
    const at = line.indexOf("=");
    if (at < 1 || Object.hasOwn(out, line.slice(0, at))) throw new Error("systemd-property-readback-malformed");
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

function showUnit(profile: LinuxCodingProfileSpec, unit: string, timeoutMs = profile.controlCallTimeoutMs): Properties {
  const keys = ["Id", "ActiveState", "SubState", "MainPID", "ControlGroup", "MemoryAccounting", "CPUAccounting",
    "TasksAccounting", "RuntimeMaxUSec"];
  const output = execFileSync(profile.systemctl.path,
    ["--user", "show", "--no-pager", ...keys.flatMap(key => ["--property=" + key]), unit],
    { encoding: "utf8", timeout: capMs(timeoutMs), maxBuffer: 8192, windowsHide: true });
  const props = parseProperties(output);
  if (Object.keys(props).length !== keys.length || keys.some(key => !Object.hasOwn(props, key))) throw new Error("systemd-property-readback-incomplete");
  return props;
}

function expectedControlGroup(uid: number, unit: string): RegExp {
  return new RegExp(`^/user\\.slice/user-${uid}\\.slice/user@${uid}\\.service/app\\.slice/${unit}\\.service$`);
}

function readBounded(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("cgroup-control-not-regular");
    const b = Buffer.alloc(READ_MAX + 1); let used = 0;
    while (used < b.length) { const n = readSync(fd, b, used, b.length - used, null); if (!n) break; used += n; }
    if (used > READ_MAX) throw new Error("cgroup-control-read-bound");
    return b.subarray(0, used).toString("utf8");
  } finally { closeSync(fd); }
}

function exactCgroupDir(group: string, uid: number, unit: string): { path: string; fd: number } {
  if (!expectedControlGroup(uid, unit).test(group) || group.includes("..") || group.includes("//")) throw new Error("unit-cgroup-path-mismatch");
  const path = resolve("/sys/fs/cgroup", "." + group);
  if (!path.startsWith("/sys/fs/cgroup/")) throw new Error("unit-cgroup-root-mismatch");
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (realpathSync(`/proc/self/fd/${fd}`) !== path || statfsSync(`/proc/self/fd/${fd}`).type !== 0x63677270)
      throw new Error("unit-cgroup-filesystem-or-identity-invalid");
    return { path, fd };
  } catch (error) { closeSync(fd); throw error; }
}

function readCounters(dir: { path: string; fd: number }): {
  cpuUsec: number | null; memoryPeakBytes: number | null; swapPeakBytes: number | null; pidsPeak: number | null;
} {
  const base = `/proc/self/fd/${dir.fd}/`;
  const cpu = readBounded(base + "cpu.stat");
  const cpuRows = [...cpu.matchAll(/^usage_usec ([0-9]+)$/gm)];
  const events = readBounded(base + "cgroup.events");
  const population = [...events.matchAll(/^populated ([01])$/gm)];
  if (cpuRows.length !== 1 || population.length !== 1 || population[0]![1] !== "1") throw new Error("cgroup-live-readback-inconsistent");
  const number = (name: string): number => {
    const s = readBounded(base + name).trim();
    if (!/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`cgroup-${name}-malformed`);
    const n = Number(s); if (!Number.isSafeInteger(n) || n < 0) throw new Error(`cgroup-${name}-out-of-range`); return n;
  };
  return { cpuUsec: Number(cpuRows[0]![1]), memoryPeakBytes: number("memory.peak"),
    swapPeakBytes: number("memory.swap.peak"), pidsPeak: number("pids.peak") };
}

function cgroupMembers(dir: { path: string; fd: number }): number[] {
  const text = readBounded(`/proc/self/fd/${dir.fd}/cgroup.procs`).trim();
  if (!text) return [];
  const members = text.split("\n").map(row => {
    if (!/^[1-9][0-9]*$/.test(row)) throw new Error("cgroup-members-malformed");
    const pid = Number(row); if (!Number.isSafeInteger(pid)) throw new Error("cgroup-pid-out-of-range"); return pid;
  });
  if (new Set(members).size !== members.length) throw new Error("cgroup-members-duplicate");
  return members;
}

function hasNamespacePidInCgroup(dir: { path: string; fd: number }, namespacePid: number): boolean {
  for (const pid of cgroupMembers(dir)) {
    try {
      const rows = [...readBounded(`/proc/${pid}/status`).matchAll(/^NSpid:\s+([0-9\s]+)$/gm)];
      if (rows.length !== 1) continue;
      const ids = rows[0]![1]!.trim().split(/\s+/).map(Number);
      if (ids.at(-1) === namespacePid && ids.length > 1) return true;
    } catch { /* process may exit between cgroup and status reads */ }
  }
  return false;
}

function parseResultLine(text: string): CandidateResult {
  if (Buffer.byteLength(text, "utf8") > LINUX_CODING_RESULT_LINE_MAX) throw new Error("candidate-result-line-bound");
  const rows = text.split("\n").filter(x => x.startsWith("RMD_RESULT "));
  if (rows.length !== 1) throw new Error("candidate-result-line-missing-or-duplicate");
  let value: unknown;
  try { value = JSON.parse(rows[0]!.slice("RMD_RESULT ".length)); } catch { throw new Error("candidate-result-json-invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("candidate-result-shape-invalid");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "candidateClosedBeforeMetrics,candidateWallMs,exitCode,pid,protocol,stderrBase64,stderrBytes,stdoutBase64,stdoutBytes" ||
      v.protocol !== LINUX_CODING_OUTPUT_PROTOCOL || v.candidateClosedBeforeMetrics !== true ||
      !Number.isSafeInteger(v.pid) || !Number.isSafeInteger(v.exitCode) ||
      !Number.isSafeInteger(v.stdoutBytes) || !Number.isSafeInteger(v.stderrBytes) ||
      !Number.isSafeInteger(v.candidateWallMs) || (v.candidateWallMs as number) < 0 ||
      typeof v.stdoutBase64 !== "string" || typeof v.stderrBase64 !== "string") throw new Error("candidate-result-fields-invalid");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.stdoutBase64) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.stderrBase64)) throw new Error("candidate-output-base64-invalid");
  const stdout = Buffer.from(v.stdoutBase64, "base64"), stderr = Buffer.from(v.stderrBase64, "base64");
  if (stdout.toString("base64") !== v.stdoutBase64 || stderr.toString("base64") !== v.stderrBase64 ||
      stdout.length !== v.stdoutBytes || stderr.length !== v.stderrBytes) throw new Error("candidate-output-count-mismatch");
  return { protocol: v.protocol, pid: v.pid as number, exitCode: v.exitCode as number,
    stdoutBase64: stdout.toString("base64"), stderrBase64: stderr.toString("base64"),
    stdoutBytes: stdout.length, stderrBytes: stderr.length, candidateWallMs: v.candidateWallMs as number,
    candidateClosedBeforeMetrics: true };
}

function utf8Strict(base64: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(base64, "base64"));
}

interface RunningUnit {
  child: ChildProcess;
  unit: string;
  output: Buffer[];
  outputBytes: number;
  errors: Buffer[];
  errorBytes: number;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  send(text: string): void;
  kill(reason: "cancel" | "timeout" | "failure"): void;
  reason?: "cancel" | "timeout" | "failure";
}

function startUnit(profile: LinuxCodingProfileSpec, unit: string, profileParentSentinel?: string): RunningUnit {
  const plan = { unit, bounds: profile.bounds, bubblewrap: profile.bubblewrap, node: profile.node,
    runtimeFiles: profile.runtimeFiles };
  const planText = JSON.stringify(plan);
  if (Buffer.byteLength(planText, "utf8") > MAX_PROFILE_JSON_BYTES) throw new Error("linux-coding-launch-plan-bound");
  const env = { ...process.env };
  // The candidate never sees this environment; bwrap applies --clearenv. Keep the
  // ordinary native manager rendezvous env so systemd-run can reach the current user manager.
  const child = spawn(profile.systemdRun.path,
    ["--quiet", "--user", `--unit=${unit}`, "--wait", "--pipe", ...systemdProperties(profile, unit),
      ...(profileParentSentinel ? [`--setenv=RMD_PROFILE_PARENT_SENTINEL=${profileParentSentinel}`] : []),
      `--setenv=RMD_CODING_PLAN_B64=${b64(planText)}`, "--", profile.node.path, "--v8-pool-size=1", "--eval", SERVICE_WRAPPER],
    { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true, detached: false });
  const running: RunningUnit = { child, unit, output: [], outputBytes: 0, errors: [], errorBytes: 0,
    closed: new Promise(resolvePromise => child.once("close", (code, signal) => resolvePromise({ code, signal }))),
    send: (text: string) => {
      const input = child.stdin;
      if (!input) throw new Error("systemd-run-stdin-unavailable");
      if (!input.writable) throw new Error("systemd-run-stdin-unavailable");
      input.write(text);
    },
  kill: reason => { running.reason = reason; try { killExact(profile, unit); } catch { /* closure is checked by caller */ } } };
  child.stdout?.on("data", (chunk: Buffer) => {
    running.outputBytes += chunk.length;
    if (running.outputBytes <= LINUX_CODING_RESULT_LINE_MAX) running.output.push(Buffer.from(chunk));
    else running.kill("failure");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    running.errorBytes += chunk.length;
    if (running.errorBytes <= 4096) running.errors.push(Buffer.from(chunk));
    else running.kill("failure");
  });
  child.once("error", () => { running.kill("failure"); });
  return running;
}

function killExact(profile: LinuxCodingProfileSpec, unit: string): void {
  execFileSync(profile.systemctl.path,
    ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit],
    { timeout: profile.controlCallTimeoutMs, maxBuffer: 4096, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
}

async function retireFailedProbeUnit(profile: LinuxCodingProfileSpec, unit: string): Promise<UnitRetirementState> {
  if (!/^rmd-coding-probe-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(unit)) return "failed";
  const deadline = performance.now() + profile.controlCallTimeoutMs;
  while (performance.now() < deadline) {
    const remaining = Math.max(1, Math.floor(deadline - performance.now()));
    let props: Properties;
    try { props = showUnit(profile, unit, remaining); } catch { // Cannot prove a failed unit's exact state, so retirement remains failed.
      return "failed"; }
    if (props.Id !== `${unit}.service`) return "failed";
    if (["inactive", "failed"].includes(props.ActiveState) && props.MainPID === "0" && props.SubState !== "running") {
      if (props.ActiveState !== "failed") return "not-needed";
      if (props.ControlGroup === "") {
        try {
          execFileSync(profile.systemctl.path, ["--user", "reset-failed", unit],
            { timeout: remaining, maxBuffer: 4096, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
          return "retired";
        } catch { // A failed exact-unit reset keeps the profile unavailable.
          return "failed"; }
      }
    }
    const pause = Math.min(25, Math.max(0, deadline - performance.now()));
    if (pause > 0) await new Promise(resolvePromise => setTimeout(resolvePromise, pause));
  }
  return "failed";
}

async function waitForActive(profile: LinuxCodingProfileSpec, unit: string, signal: AbortSignal): Promise<Properties> {
  const deadline = performance.now() + profile.controlCallTimeoutMs;
  let last: unknown;
  while (performance.now() < deadline) {
    if (signal.aborted) throw new Error("candidate-cancelled");
    try {
      const p = showUnit(profile, unit);
      if (p.Id !== `${unit}.service`) throw new Error("systemd-unit-id-mismatch");
      if (p.ActiveState === "active" && p.ControlGroup) return p;
      if (p.ActiveState === "failed" || p.SubState === "dead") throw new Error("systemd-unit-failed-before-start");
      last = undefined;
    } catch (error) { // Preserve the last systemd read failure for the bounded timeout result.
      last = error; }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  throw last instanceof Error ? last : new Error("systemd-unit-start-timeout");
}

const SYSTEMD_DISPLAY_TIME_UNITS = Object.freeze([
  { suffix: "y", micros: 31_557_600_000_000n },
  { suffix: "month", micros: 2_630_016_000_000n },
  { suffix: "w", micros: 604_800_000_000n },
  { suffix: "d", micros: 86_400_000_000n },
  { suffix: "h", micros: 3_600_000_000n },
  { suffix: "min", micros: 60_000_000n },
  { suffix: "s", micros: 1_000_000n },
  { suffix: "ms", micros: 1_000n },
  { suffix: "us", micros: 1n },
]);

/** Parse the canonical, finite timespan text emitted by systemd's show formatter. */
export function parseSystemdDisplayTimeSpanMicros(value: string): number | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) return null;
  if (value === "0") return 0;
  const parts = value.split(" ");
  if (parts.some(part => !part)) return null;
  let total = 0n, previousUnit = -1;
  for (const part of parts) {
    const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?(y|month|w|d|h|min|s|ms|us)$/.exec(part);
    if (!match) return null;
    const unitIndex = SYSTEMD_DISPLAY_TIME_UNITS.findIndex(unit => unit.suffix === match[3]);
    if (unitIndex <= previousUnit) return null;
    previousUnit = unitIndex;
    const unit = SYSTEMD_DISPLAY_TIME_UNITS[unitIndex]!;
    const whole = BigInt(match[1]!);
    const fraction = match[2];
    if (fraction && (parts.length !== 1 ||
      (unit.suffix === "s" && (whole < 1n || whole >= 60n)) ||
      (unit.suffix === "ms" && (whole < 1n || whole >= 1000n)) ||
      (unit.suffix !== "s" && unit.suffix !== "ms") ||
      (unit.suffix === "s" && fraction.length !== 6) ||
      (unit.suffix === "ms" && fraction.length !== 3))) return null;
    total += whole * unit.micros;
    if (fraction) total += BigInt(fraction) * unit.micros / (10n ** BigInt(fraction.length));
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  }
  return Number(total);
}

export function systemdDisplayTimeSpanMatchesLimit(value: string, configuredMicros: number): boolean {
  if (!Number.isSafeInteger(configuredMicros) || configuredMicros < 0) return false;
  const observedMicros = parseSystemdDisplayTimeSpanMicros(value);
  return observedMicros !== null && observedMicros === configuredMicros;
}

function verifyEffectiveProperties(p: Properties, profile: LinuxCodingProfileSpec, uid: number, unit: string): void {
  const b = profile.bounds;
  const configuredRuntimeMaxMicros = (b.wallMaxMs + profile.cleanupGraceMs) * 1000;
  if (p.Id !== `${unit}.service` || !expectedControlGroup(uid, unit).test(p.ControlGroup ?? "") ||
      p.CPUAccounting !== "yes" || p.MemoryAccounting !== "yes" || p.TasksAccounting !== "yes" ||
      !systemdDisplayTimeSpanMatchesLimit(p.RuntimeMaxUSec ?? "", configuredRuntimeMaxMicros)) {
    throw new Error("systemd-effective-limit-readback-mismatch");
  }
}

function verifyKernelBounds(dir: { path: string; fd: number }, b: CodingConfiguredBounds): void {
  const base = `/proc/self/fd/${dir.fd}/`;
  const cpu = readBounded(base + "cpu.max").trim().split(/\s+/);
  if (cpu.length !== 2 || cpu[0] !== String(b.cpuQuotaMicros) || cpu[1] !== "100000")
    throw new Error("kernel-cpu-max-readback-mismatch");
  for (const [file, expected] of [["memory.max", b.memoryMaxBytes], ["memory.swap.max", b.swapMaxBytes], ["pids.max", b.tasksMax]] as const) {
    if (readBounded(base + file).trim() !== String(expected)) throw new Error(`kernel-${file}-readback-mismatch`);
  }
}

type UnitClosureBasis = "cgroup-events-empty" | "pinned-cgroup-removed";

function verifyRemovedPinnedCgroup(profile: LinuxCodingProfileSpec, unit: string, dir: { path: string; fd: number }): boolean {
  try {
    if (!fstatSync(dir.fd).isDirectory() || statfsSync(`/proc/self/fd/${dir.fd}`).type !== 0x63677270 ||
        readlinkSync(`/proc/self/fd/${dir.fd}`) !== `${dir.path} (deleted)`) return false;
    try { lstatSync(dir.path); return false; }
    catch (error) { // Only absence of the original pinned cgroup path can prove removal.
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return false; }
    const p = showUnit(profile, unit);
    return p.Id === `${unit}.service` && (p.ActiveState === "inactive" || p.ActiveState === "failed") &&
      p.MainPID === "0" && p.ControlGroup === "" && p.SubState !== "running";
  } catch { // Any failed pinned-cgroup readback means removal is unproved.
    return false; }
}

async function waitUnitEmpty(profile: LinuxCodingProfileSpec, unit: string, dir: { path: string; fd: number }, timeoutMs: number): Promise<UnitClosureBasis | null> {
  const deadline = performance.now() + capMs(timeoutMs);
  while (performance.now() < deadline) {
    try {
      const p = showUnit(profile, unit);
      const expectedGroup = dir.path.slice("/sys/fs/cgroup".length);
      if (p.Id === `${unit}.service` && (p.ActiveState === "inactive" || p.ActiveState === "failed") &&
          p.MainPID === "0" && (p.ControlGroup === "" || p.ControlGroup === expectedGroup) && p.SubState !== "running") {
        let events: string;
        try { events = readBounded(`/proc/self/fd/${dir.fd}/cgroup.events`); }
        catch (error) {
          /* Only verified removal is a closure basis; other read failures remain pending. */
          if (error instanceof Error && "code" in error && error.code === "ENOENT" && verifyRemovedPinnedCgroup(profile, unit, dir))
            return "pinned-cgroup-removed";
          await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
          continue;
        }
        const values = [...events.matchAll(/^populated ([01])$/gm)];
        if (values.length === 1 && values[0]![1] === "0") return "cgroup-events-empty";
      }
    } catch { // An unknown unit/cgroup readback cannot establish closure.
      return null; }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  return null;
}

async function waitProcessClosed(running: RunningUnit, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([running.closed.then(() => true), new Promise<boolean>(resolvePromise => {
      timer = setTimeout(() => resolvePromise(false), capMs(timeoutMs));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function partialResult(input: {
  binding: CodingControlBindingV1; hostExecutionId: string; candidateDigest: string; exitCode: number; stdout: string; stderr: string;
  observed: { cpuUsec: number | null; memoryPeakBytes: number | null; swapPeakBytes: number | null;
    pidsPeak: number | null; scratchPeakBytes: number | null; wallMs: number | null;
    stdoutBytes: number | null; stderrBytes: number | null; heapPeakBytes: number | null };
}, unitEmptyAfterStop: boolean): Extract<CodingBackendResult, { state: "unavailable" }>["partial"] {
  return { ...input, candidateClosedBeforeMetrics: true, metricsCapturedBeforeCollection: true, unitEmptyAfterStop };
}

/**
 * Returns an executor suitable for the existing opaque process-local coding
 * authority. It never chooses limits, bypasses `spawnWorker`, or writes the
 * oracle into candidate input. Complete scoring remains unavailable while any
 * required resource peak is unknown.
 */
export function createSystemdBwrapCodingExecutor(profileHandle: QualifiedLinuxCodingProfile): (
  input: { binding: CodingControlBindingV1; source: string; stdin: string; signal: AbortSignal; limits: CodingConfiguredBounds },
) => Promise<CodingBackendResult> {
  const profile = profileStates.get(profileHandle as object);
  if (!profile) throw new Error("linux-coding-profile-capability-invalid");
  return async input => runSystemdBwrap(profile, input);
}

export interface LinuxCodingProfileProbeControlDiagnostic {
  control: typeof PROFILE_CONTROL_NAMES[number];
  controlAttemptId: string;
  sourceDigest: string;
  state: "passed" | "failed" | "unavailable";
  hostExecutionId: string | null;
  exitCode: number | null;
  candidateClosed: boolean;
  unitClosureBasis: UnitClosureBasis | null;
  unitRetirement: UnitRetirementState;
  diagnosticDigest: string | null;
  observed: { cpuUsec: number | null; memoryPeakBytes: number | null; swapPeakBytes: number | null;
    pidsPeak: number | null; wallMs: number | null; stdoutBytes: number | null; stderrBytes: number | null };
  unitReadbacks: LinuxCodingProfileProbeSummary["unitReadbacks"] | null;
  scratchMountReadbacks: LinuxCodingProfileProbeSummary["scratchMountReadbacks"] | null;
  isolation: LinuxCodingProfileProbeSummary["isolation"] | null;
  reason: string | null;
}

type ProfileControlRun = LinuxCodingProfileProbeControlDiagnostic;

export interface LinuxCodingProfileProbeDiagnostic {
  profileProbeId: string;
  controls: readonly LinuxCodingProfileProbeControlDiagnostic[];
  heldUnitIds: readonly string[];
}

let profileProbeActiveDiagnostic: LinuxCodingProfileProbeDiagnostic | null = null;
let profileProbeStickyDiagnostic: LinuxCodingProfileProbeDiagnostic | null = null;

function controlUnitReadbacks(dir: { path: string; fd: number }, bounds: CodingConfiguredBounds): LinuxCodingProfileProbeSummary["unitReadbacks"] {
  const base = `/proc/self/fd/${dir.fd}/`;
  const cpu = readBounded(base + "cpu.max").trim().split(/\s+/);
  if (cpu.length !== 2 || cpu[1] !== "100000") throw new Error("profile-probe-cpu-readback-invalid");
  const readNumber = (name: string): number => {
    const text = readBounded(base + name).trim();
    if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new Error(`profile-probe-${name}-readback-invalid`);
    const value = Number(text); if (!Number.isSafeInteger(value)) throw new Error(`profile-probe-${name}-readback-invalid`);
    return value;
  };
  return {
    cpuQuotaMicros: { configured: bounds.cpuQuotaMicros, readback: Number(cpu[0]) },
    memoryMaxBytes: { configured: bounds.memoryMaxBytes, readback: readNumber("memory.max") },
    swapMaxBytes: { configured: bounds.swapMaxBytes, readback: readNumber("memory.swap.max") },
    tasksMax: { configured: bounds.tasksMax, readback: readNumber("pids.max") },
  };
}

function namespaceAndMountObservation(stdout: string, parentSentinelAttested: boolean, scratchMaxBytes: number): {
  isolation: LinuxCodingProfileProbeSummary["isolation"];
  scratchMountReadbacks: LinuxCodingProfileProbeSummary["scratchMountReadbacks"];
} {
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("profile-probe-known-good-json-invalid");
  const row = value as Record<string, unknown>;
  const namespaces = row.ns as Record<string, unknown> | null;
  const root = row.root as Record<string, unknown> | null;
  const tmp = row.tmp as Record<string, unknown> | null;
  const dev = row.dev as Record<string, unknown> | null;
  const proc = row.proc as Record<string, unknown> | null;
  const devPts = row.devPts as Record<string, unknown> | null;
  if (!namespaces || !root || !tmp || !dev || !proc || !devPts || !Array.isArray(row.env))
    throw new Error("profile-probe-known-good-observation-invalid");
  const expectedEnv = ["HOME", "LANG", "PATH", "PWD", "TMPDIR"];
  const cleanEnvironment = row.pwd === "/work" && row.env.length === expectedEnv.length
    && row.env.every((item, index) => item === expectedEnv[index]);
  const hostNs = { user: readlinkSync("/proc/self/ns/user"), pid: readlinkSync("/proc/self/ns/pid"),
    net: readlinkSync("/proc/self/ns/net"), ipc: readlinkSync("/proc/self/ns/ipc"),
    uts: readlinkSync("/proc/self/ns/uts"), mnt: readlinkSync("/proc/self/ns/mnt"),
    cgroup: readlinkSync("/proc/self/ns/cgroup") };
  const isolated = (key: keyof typeof hostNs): boolean | null =>
    typeof namespaces[key] === "string" ? namespaces[key] !== hostNs[key] : null;
  const rootConfiguredBytes = Math.floor(scratchMaxBytes / 2);
  const tmpConfiguredBytes = scratchMaxBytes - rootConfiguredBytes;
  const rootReadbackBytes = root.size;
  const tmpReadbackBytes = tmp.size;
  const sizeReadbacksValid = Number.isSafeInteger(rootReadbackBytes) && Number.isSafeInteger(tmpReadbackBytes) &&
    rootReadbackBytes === rootConfiguredBytes && tmpReadbackBytes === tmpConfiguredBytes;
  if (!sizeReadbacksValid) throw new Error("profile-probe-scratch-mount-size-readback-mismatch");
  const isolation = { userNamespace: isolated("user"), pidNamespace: isolated("pid"), networkNamespace: isolated("net"),
    ipcNamespace: isolated("ipc"), utsNamespace: isolated("uts"),
    mountNamespace: isolated("mnt"), cgroupNamespace: isolated("cgroup"),
    rootReadOnly: typeof root.ro === "boolean" && root.type === "tmpfs" && sizeReadbacksValid ? root.ro : null,
    tmpfsScratch: tmp.type === "tmpfs" && tmp.ro === false && sizeReadbacksValid,
    devReadOnly: (dev.type === "tmpfs" || dev.type === "devtmpfs") && dev.ro === true ? true : null,
    devRegularWriteDenied: dev.regularWriteDenied === true ? true : null,
    devNullWritable: dev.nullWritable === true ? true : null,
    procReadOnly: proc.type === "proc" && proc.ro === true ? true : null,
    devPtsReadOnly: devPts.type === "devpts" && devPts.ro === true ? true : null,
    devPtsPseudoFilesystem: devPts.type === "devpts" ? true : null,
    cleanEnvironment, parentEnvironmentHidden: parentSentinelAttested && !row.env.includes("RMD_PROFILE_PARENT_SENTINEL") };
  return { isolation, scratchMountReadbacks: { rootConfiguredBytes, rootReadbackBytes: Number(rootReadbackBytes),
    tmpConfiguredBytes, tmpReadbackBytes: Number(tmpReadbackBytes) } };
}

async function runProfileControl(
  profile: LinuxCodingProfileSpec, profileProbeId: string, control: typeof PROFILE_CONTROL_NAMES[number], controlAttemptId: string,
): Promise<ProfileControlRun> {
  if (!/^[a-f0-9-]{36}$/i.test(profileProbeId)) throw new Error("linux-profile-probe-id-invalid");
  const unit = `rmd-coding-probe-${controlAttemptId}`;
  const source = PROFILE_CONTROL_SOURCES[control], stdin = control === "known-good" ? "1 2 3 4\n" : "";
  const parentSentinel = control === "known-good" ? sha256(`${profileProbeId}:${controlAttemptId}`) : undefined;
  const controller = new AbortController();
  let running: RunningUnit | undefined, dir: { path: string; fd: number } | undefined;
  let hostStarted: "no" | "yes" | "unknown" = "no";
  let props: Properties | undefined;
  let counters: ReturnType<typeof readCounters> | null = null;
  let readbacks: LinuxCodingProfileProbeSummary["unitReadbacks"] | null = null;
  let scratchMountReadbacks: LinuxCodingProfileProbeSummary["scratchMountReadbacks"] | null = null;
  let candidate: CandidateResult | undefined;
  let stdout = "", stderr = "", closed = false, processClosed = false;
  let unitClosureBasis: UnitClosureBasis | null = null, unitRetirement: UnitRetirementState = "not-attempted";
  let reason: string | null = null;
  let controllerDiagnosticDigest: string | null = null;
  const started = performance.now();
  try {
    running = startUnit(profile, unit, parentSentinel); hostStarted = "unknown";
    props = await waitForActive(profile, unit, controller.signal); hostStarted = "yes";
    dir = exactCgroupDir(props.ControlGroup!, process.getuid?.() ?? -1, unit);
    verifyEffectiveProperties(props, profile, process.getuid?.() ?? -1, unit);
    verifyKernelBounds(dir, profile.bounds); readbacks = controlUnitReadbacks(dir, profile.bounds);
    const mainPid = Number(props.MainPID);
    if (!Number.isSafeInteger(mainPid) || mainPid < 1 || cgroupMembers(dir).length !== 1 || cgroupMembers(dir)[0] !== mainPid)
      throw new Error("profile-probe-main-process-membership-mismatch");
    const request = JSON.stringify({ controlGroup: props.ControlGroup, profileControl: control,
      ...(parentSentinel ? { parentSentinel } : {}),
      sourceBytes: Buffer.byteLength(source, "utf8"), sourceDigest: sha256(source), stdin });
    if (Buffer.byteLength(request, "utf8") > LINUX_CODING_REQUEST_MAX) throw new Error("profile-probe-request-bound");
    running.send(request + "\n"); running.send(source);
    const deadline = performance.now() + (control === "cancel-descendant" ? profile.bounds.wallMaxMs : profile.bounds.wallMaxMs + profile.controlCallTimeoutMs);
    let outputText = "", descendantObserved = false;
    while (performance.now() < deadline) {
      if (control === "cancel-descendant") {
        outputText = Buffer.concat(running.output).toString("utf8");
        const ready = outputText.match(/RMD_PROFILE_READY ([1-9][0-9]*)\n/);
        if (ready) {
          descendantObserved = hasNamespacePidInCgroup(dir, Number(ready[1]));
          if (descendantObserved) break;
        }
        const earlyResultLine = outputText.split("\n").find(line => line.startsWith("RMD_RESULT "));
        if (earlyResultLine) {
          candidate = parseResultLine(earlyResultLine);
          try { counters = readCounters(dir); } catch { /* unavailable counter files remain unknown */ }
          controllerDiagnosticDigest = sha256(candidate.stdoutBase64 + "\n" + candidate.stderrBase64);
          throw new Error("profile-probe-descendant-not-observed");
        }
      } else {
        outputText = Buffer.concat(running.output).toString("utf8");
        if (outputText.includes("RMD_RESULT ") && outputText.includes("\n")) break;
      }
      const closedResult = await Promise.race([running.closed.then(() => true), new Promise<boolean>(resolvePromise => setTimeout(() => resolvePromise(false), 20))]);
      if (closedResult) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    }
    if (control === "cancel-descendant") {
      if (descendantObserved) {
        counters = readCounters(dir);
        killExact(profile, unit);
        processClosed = await waitProcessClosed(running, profile.cleanupGraceMs);
        if (!processClosed) throw new Error("profile-probe-supervisor-closure-unproved");
        unitClosureBasis = await waitUnitEmpty(profile, unit, dir, profile.controlCallTimeoutMs);
        closed = processClosed && unitClosureBasis !== null;
        if (closed) unitRetirement = await retireFailedProbeUnit(profile, unit);
        if (unitRetirement === "failed") throw new Error("profile-probe-unit-retirement-failed");
        return { control, controlAttemptId, sourceDigest: sha256(source), state: descendantObserved && closed ? "passed" : "failed", hostExecutionId: unit,
          exitCode: null, candidateClosed: closed, unitClosureBasis, unitRetirement, diagnosticDigest: sha256(outputText), observed: {
            ...counters, wallMs: Math.ceil(performance.now() - started),
            stdoutBytes: Buffer.byteLength(outputText.match(/RMD_PROFILE_READY [1-9][0-9]*\n/)?.[0] ?? "", "utf8"),
            stderrBytes: running.errorBytes },
          unitReadbacks: readbacks, scratchMountReadbacks: null, isolation: null,
          reason: closed ? null : "profile-probe-descendant-closure-unproved" };
      }
      throw new Error("profile-probe-descendant-not-observed");
    }
    const resultLine = outputText.split("\n").find(line => line.startsWith("RMD_RESULT "));
    if (!resultLine) {
      const wrapperStderr = Buffer.concat(running.errors).toString("utf8");
      controllerDiagnosticDigest = outputText || wrapperStderr
        ? sha256(outputText + "\n" + wrapperStderr) : null;
      const wrapperCode = safeWrapperFailureCode(wrapperStderr);
      throw new Error(wrapperCode ? `profile-probe-wrapper-${wrapperCode}` : "profile-probe-result-missing");
    }
    candidate = parseResultLine(resultLine);
    if (candidate.pid !== mainPid || !candidate.candidateClosedBeforeMetrics || cgroupMembers(dir).length !== 1)
      throw new Error("profile-probe-candidate-closure-invalid");
    counters = readCounters(dir);
    stdout = utf8Strict(candidate.stdoutBase64); stderr = utf8Strict(candidate.stderrBase64);
    running.send("release\n");
    processClosed = await waitProcessClosed(running, profile.cleanupGraceMs);
    if (!processClosed) throw new Error("profile-probe-supervisor-closure-unproved");
    unitClosureBasis = await waitUnitEmpty(profile, unit, dir, profile.controlCallTimeoutMs);
    closed = processClosed && unitClosureBasis !== null;
    if (!closed) throw new Error("profile-probe-unit-not-empty");
    unitRetirement = await retireFailedProbeUnit(profile, unit);
    if (unitRetirement === "failed") throw new Error("profile-probe-unit-retirement-failed");
    const parentSentinelAttested = !!parentSentinel && outputText.includes(`RMD_PROFILE_PARENT_SENTINEL ${parentSentinel}\n`);
    const mountObservation = control === "known-good"
      ? namespaceAndMountObservation(stdout, parentSentinelAttested, profile.bounds.scratchMaxBytes) : null;
    const isolation = mountObservation?.isolation ?? null;
    scratchMountReadbacks = mountObservation?.scratchMountReadbacks ?? null;
    const goodIsolation = !isolation || Object.values(isolation).every(value => value === true);
    const expectedPassed = control === "known-good"
      ? (() => { const value = JSON.parse(stdout) as { sum?: unknown }; return value.sum === 10 && goodIsolation; })()
      : stdout === "999999\n";
    return { control, controlAttemptId, sourceDigest: sha256(source), state: candidate.exitCode === 0 && expectedPassed ? "passed" : "failed", hostExecutionId: unit,
      exitCode: candidate.exitCode, candidateClosed: closed, unitClosureBasis, unitRetirement, diagnosticDigest: sha256(stdout + "\n" + stderr),
      observed: { ...counters, wallMs: candidate.candidateWallMs, stdoutBytes: candidate.stdoutBytes,
        stderrBytes: candidate.stderrBytes }, unitReadbacks: readbacks, scratchMountReadbacks, isolation,
      reason: candidate.exitCode === 0 && expectedPassed ? null : "profile-probe-control-output-mismatch" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "profile-probe-control-error";
    reason = /^[a-z0-9-]{1,96}$/.test(message) ? message : "profile-probe-control-error";
    if (!counters && dir && running) {
      try { counters = readCounters(dir); } catch { /* counters require a live exact controller cgroup */ }
    }
    if (running) { try { killExact(profile, unit); } catch { /* exact closure checked below */ }
      processClosed = await waitProcessClosed(running, profile.cleanupGraceMs)
        .catch(() => { /* A failed process-close observation remains unproved. */ return false; }); }
    if (dir && running && processClosed)
      unitClosureBasis = await waitUnitEmpty(profile, unit, dir, profile.controlCallTimeoutMs)
        .catch(() => { /* A failed unit/cgroup closure readback remains unknown. */ return null; });
    closed = processClosed && unitClosureBasis !== null;
    if (closed && unitRetirement === "not-attempted") unitRetirement = await retireFailedProbeUnit(profile, unit);
    return { control, controlAttemptId, sourceDigest: sha256(source), state: "unavailable", hostExecutionId: unit, exitCode: candidate?.exitCode ?? null,
      candidateClosed: closed, unitClosureBasis, unitRetirement,
      diagnosticDigest: controllerDiagnosticDigest ?? (stdout || stderr ? sha256(stdout + "\n" + stderr) : null),
      observed: { ...(counters ?? { cpuUsec: null, memoryPeakBytes: null, swapPeakBytes: null, pidsPeak: null }),
        wallMs: candidate?.candidateWallMs ?? null, stdoutBytes: candidate?.stdoutBytes ?? null, stderrBytes: candidate?.stderrBytes ?? null },
      unitReadbacks: readbacks, scratchMountReadbacks, isolation: null, reason };
  } finally { if (dir) closeSync(dir.fd); }
}

export type LinuxCodingProfileProbeOutcome =
  | { state: "unavailable"; phase: "preflight" | "controls" | "receipt"; reason: string;
      diagnostic?: LinuxCodingProfileProbeDiagnostic }
  | { state: "observed"; receipt: LinuxCodingProfileProbeReceipt };

function probeDiagnostic(profileProbeId: string, controls: readonly ProfileControlRun[]): LinuxCodingProfileProbeDiagnostic {
  const safeControls = controls.map(control => Object.freeze({ ...control,
    observed: Object.freeze({ ...control.observed }),
    unitReadbacks: control.unitReadbacks ? Object.freeze(Object.fromEntries(Object.entries(control.unitReadbacks)
      .map(([key, value]) => [key, Object.freeze({ ...value })]))) as LinuxCodingProfileProbeSummary["unitReadbacks"] : null,
    scratchMountReadbacks: control.scratchMountReadbacks ? Object.freeze({ ...control.scratchMountReadbacks }) : null,
    isolation: control.isolation ? Object.freeze({ ...control.isolation }) : null,
  }));
  const heldUnitIds = safeControls.filter(control => control.hostExecutionId && !control.candidateClosed)
    .map(control => control.hostExecutionId!);
  return Object.freeze({ profileProbeId, controls: Object.freeze(safeControls), heldUnitIds: Object.freeze(heldUnitIds) });
}

function stableProbeJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableProbeJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableProbeJson(row[key])}`).join(",")}}`;
}

/** Runs only the three backend-owned controls; callers cannot choose source, args, paths, or limits. */
export async function probeNativeLinuxCodingProfile(
  preflightCapability: LinuxCodingProfilePreflightCapabilityV1,
): Promise<LinuxCodingProfileProbeOutcome> {
  if (profileProbeBusy || profileProbeClosureHeld) {
    const diagnostic = profileProbeActiveDiagnostic ?? profileProbeStickyDiagnostic ?? undefined;
    return { state: "unavailable", phase: "controls", reason: "linux-profile-probe-prior-closure-unproved", ...(diagnostic ? { diagnostic } : {}) };
  }
  const profileProbeId = randomUUID();
  profileProbeBusy = true;
  profileProbeActiveDiagnostic = probeDiagnostic(profileProbeId, []);
  try { return await performNativeLinuxCodingProfileProbe(preflightCapability, profileProbeId); }
  finally {
    if (profileProbeClosureHeld && profileProbeActiveDiagnostic) profileProbeStickyDiagnostic = profileProbeActiveDiagnostic;
    profileProbeBusy = false; profileProbeActiveDiagnostic = null;
  }
}

async function performNativeLinuxCodingProfileProbe(
  preflightCapability: LinuxCodingProfilePreflightCapabilityV1,
  profileProbeId: string,
): Promise<LinuxCodingProfileProbeOutcome> {
  const reject = (phase: "controls" | "receipt", reason: string): LinuxCodingProfileProbeOutcome => ({
    state: "unavailable", phase, reason,
    ...(profileProbeActiveDiagnostic ? { diagnostic: profileProbeActiveDiagnostic } : {}),
  });
  const preflight = readLinuxCodingProfilePreflight(preflightCapability);
  if (!preflight) return { state: "unavailable", phase: "preflight", reason: "linux-profile-preflight-capability-invalid" };
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== preflight.hostIdentity.uid)
    return reject("controls", "linux-profile-host-identity-changed");
  if (sha256(stableProbeJson(preflight.hostIdentity)) !== preflight.hostIdentityDigest)
    return reject("controls", "linux-profile-host-digest-invalid");
  let provisional: LinuxCodingProfileSpec;
  try { provisional = profileFromPreflight(preflight, "0".repeat(64)); validateProfileSpec(provisional); }
  catch { // Untrusted or stale runtime metadata cannot enter any fixed control.
    return reject("controls", "linux-profile-binary-or-runtime-validation-failed"); }

  const runs = {} as Record<typeof PROFILE_CONTROL_NAMES[number], ProfileControlRun>;
  const attempted: ProfileControlRun[] = [];
  for (const control of PROFILE_CONTROL_NAMES) {
    const controlAttemptId = randomUUID();
    try { runs[control] = await runProfileControl(provisional, profileProbeId, control, controlAttemptId); }
    catch { // Preserve unknown closure and hold admission when a control throws before a receipt exists.
      const uncertain: ProfileControlRun = { control, controlAttemptId, sourceDigest: sha256(PROFILE_CONTROL_SOURCES[control]),
        state: "unavailable", hostExecutionId: `rmd-coding-probe-${controlAttemptId}`, exitCode: null,
        candidateClosed: false, unitClosureBasis: null, unitRetirement: "not-attempted", diagnosticDigest: null,
        observed: { cpuUsec: null, memoryPeakBytes: null, swapPeakBytes: null, pidsPeak: null,
          wallMs: null, stdoutBytes: null, stderrBytes: null }, unitReadbacks: null, scratchMountReadbacks: null, isolation: null,
        reason: "profile-probe-control-error" };
      profileProbeClosureHeld = true; attempted.push(uncertain);
      profileProbeActiveDiagnostic = probeDiagnostic(profileProbeId, attempted);
      return reject("controls", `linux-profile-control-${control}-failed`); }
    attempted.push(runs[control]!);
    profileProbeActiveDiagnostic = probeDiagnostic(profileProbeId, attempted);
    if (runs[control]!.hostExecutionId && !runs[control]!.candidateClosed) profileProbeClosureHeld = true;
    if (runs[control]!.state !== "passed")
      return reject("controls", `linux-profile-control-${control}-${runs[control]!.reason ?? runs[control]!.state}`);
  }
  const controls = Object.fromEntries(PROFILE_CONTROL_NAMES.map(name => [name, {
    controlAttemptId: runs[name]!.controlAttemptId, sourceDigest: runs[name]!.sourceDigest,
    state: runs[name]!.state, hostExecutionId: runs[name]!.hostExecutionId, exitCode: runs[name]!.exitCode,
    candidateClosed: runs[name]!.candidateClosed, unitClosureBasis: runs[name]!.unitClosureBasis,
    unitRetirement: runs[name]!.unitRetirement,
    diagnosticDigest: runs[name]!.diagnosticDigest,
  }])) as LinuxCodingProfileProbeSummary["controls"];
  const unitReadbacks = runs["known-good"]!.unitReadbacks;
  const scratchMountReadbacks = runs["known-good"]!.scratchMountReadbacks;
  const isolation = runs["known-good"]!.isolation;
  if (!unitReadbacks || !scratchMountReadbacks || !isolation || Object.values(isolation).some(value => value !== true))
    return reject("receipt", "linux-profile-required-readback-missing");
  const observedValues = PROFILE_CONTROL_NAMES.map(name => runs[name]!.observed);
  const allObserved = (key: keyof typeof observedValues[number]): number[] | null => {
    const values = observedValues.map(value => value[key]);
    return values.every(value => Number.isSafeInteger(value) && (value as number) >= 0) ? values as number[] : null;
  };
  const sumObserved = (key: keyof typeof observedValues[number]): number | null => {
    const values = allObserved(key); return values ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const maxObserved = (key: keyof typeof observedValues[number]): number | null => {
    const values = allObserved(key); return values ? Math.max(...values) : null;
  };
  const proof = { version: "linux-coding-profile-isolation-proof-v1", hostIdentityDigest: preflight.hostIdentityDigest,
    controlSourceDigest: PROFILE_CONTROL_SOURCE_DIGEST, controls: PROFILE_CONTROL_NAMES.map(name => ({
      name, state: runs[name]!.state, candidateClosed: runs[name]!.candidateClosed,
      unitClosureBasis: runs[name]!.unitClosureBasis, unitRetirement: runs[name]!.unitRetirement,
      exitCode: runs[name]!.exitCode,
      diagnosticDigest: runs[name]!.diagnosticDigest, sourceDigest: runs[name]!.sourceDigest,
    })), unitReadbacks, scratchMountReadbacks, isolation };
  const isolationProofDigest = sha256(stableProbeJson(proof));
  let profile: LinuxCodingProfileSpec;
  try { profile = profileFromPreflight(preflight, isolationProofDigest); validateProfileSpec(profile); }
  catch { // Invalid profile derivation makes this probe receipt unavailable.
    return reject("receipt", "linux-profile-receipt-profile-invalid"); }
  const summary: LinuxCodingProfileProbeSummary = {
    version: "linux-coding-profile-probe-v1", profileProbeId, profileId: profile.profileId, profileDigest: profile.profileDigest,
    binaryDigest: profile.binaryDigest, backendSourceDigest: profile.backendSourceDigest,
    producerSourceDigest: preflight.producerSourceDigest, testSourceDigest: preflight.testSourceDigest,
    preflightCapabilitySourceDigest: preflight.preflightCapabilitySourceDigest,
    controlSourceDigest: profile.controlSourceDigest,
    hostIdentityDigest: profile.hostIdentityDigest, controls, unitReadbacks, scratchMountReadbacks, isolation,
    observed: { cpuUsec: sumObserved("cpuUsec"), memoryPeakBytes: maxObserved("memoryPeakBytes"),
      swapPeakBytes: maxObserved("swapPeakBytes"), pidsPeak: maxObserved("pidsPeak"),
      scratchPeakBytes: null, wallMs: sumObserved("wallMs"), stdoutBytes: sumObserved("stdoutBytes"),
      stderrBytes: sumObserved("stderrBytes"), heapPeakBytes: null },
    profileQualification: "isolation-closure-only",
  };
  const receipt = Object.freeze(Object.create(null)) as LinuxCodingProfileProbeReceipt;
  probeReceiptStates.set(receipt, { summary, profile, preflightDigest: sha256(stableProbeJson(preflight)) });
  return { state: "observed", receipt };
}

async function runSystemdBwrap(profile: LinuxCodingProfileSpec, input: {
  binding: CodingControlBindingV1; source: string; stdin: string; signal: AbortSignal; limits: CodingConfiguredBounds;
}): Promise<CodingBackendResult> {
  const b = profile.bounds;
  if (!validBounds(b) || JSON.stringify(b) !== JSON.stringify(input.limits)
      || !/^[0-9a-f-]{36}$/i.test(input.binding.workerSpawnAttemptId) || !/^[a-f0-9]{64}$/.test(input.binding.sourceDigest)
      || sha256(input.source) !== input.binding.sourceDigest ||
      Buffer.byteLength(input.source, "utf8") < 1 || Buffer.byteLength(input.source, "utf8") > 8192 ||
      input.source.includes("\0") || Buffer.byteLength(input.stdin, "utf8") > 4096) {
    return { state: "refused", reason: "owner-profile-unavailable",
      execution: { hostStarted: "no", closure: "proven", hostExecutionId: null } };
  }
  if (input.signal.aborted) return { state: "refused", reason: "candidate-cancelled",
    execution: { hostStarted: "no", closure: "proven", hostExecutionId: null } };
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (process.platform !== "linux" || uid < 0) return { state: "refused", reason: "isolation-unavailable",
    execution: { hostStarted: "no", closure: "proven", hostExecutionId: null } };

  // Re-hash exact executable/runtime files immediately before use; a profile
  // token for an old path digest cannot silently follow a replaced binary.
  try { validateProfileSpec(profile); }
  catch { return { state: "unavailable", reason: "owner-profile-unavailable", configured: b,
    execution: { hostStarted: "no", closure: "proven", hostExecutionId: null } }; }

  const unit = `rmd-coding-${randomUUID()}`;
  let running: RunningUnit | undefined, dir: { path: string; fd: number } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  let properties: Properties | undefined;
  let observed = { cpuUsec: null as number | null, memoryPeakBytes: null as number | null,
    swapPeakBytes: null as number | null, pidsPeak: null as number | null,
    scratchPeakBytes: null as number | null, wallMs: null as number | null,
    stdoutBytes: null as number | null, stderrBytes: null as number | null, heapPeakBytes: null as number | null };
  let candidate: CandidateResult | undefined;
  let stdout = "", stderr = "", exitCode = 125;
  let unitEmptyAfterStop = false;
  let hostStarted: "no" | "yes" | "unknown" = "no";
  let failureReason: CodingExecutionReason | undefined;
  let cleanupDeadline: number | null = null;
  const beginCleanup = (): void => { cleanupDeadline ??= performance.now() + profile.cleanupGraceMs; };
  const cleanupRemainingMs = (): number => {
    beginCleanup(); return Math.max(0, Math.floor(cleanupDeadline! - performance.now()));
  };
  const stopAndProveEmpty = async (): Promise<boolean> => {
    if (!running || !dir) return false;
    const processBudget = cleanupRemainingMs();
    if (processBudget < 1 || !await waitProcessClosed(running, processBudget)) return false;
    const unitBudget = Math.min(cleanupRemainingMs(), profile.controlCallTimeoutMs);
    return unitBudget > 0 && (await waitUnitEmpty(profile, unit, dir, unitBudget)) !== null;
  };
  try {
    running = startUnit(profile, unit);
    hostStarted = "unknown";
    properties = await waitForActive(profile, unit, input.signal);
    hostStarted = "yes";
    dir = exactCgroupDir(properties.ControlGroup!, uid, unit);
    verifyEffectiveProperties(properties, profile, uid, unit);
    verifyKernelBounds(dir, b);
    const initialEvents = [...readBounded(`/proc/self/fd/${dir.fd}/cgroup.events`).matchAll(/^populated ([01])$/gm)];
    if (initialEvents.length !== 1 || initialEvents[0]![1] !== "1")
      throw new Error("unit-not-populated-before-request");
    const mainPid = Number(properties.MainPID);
    if (!Number.isSafeInteger(mainPid) || mainPid < 1 || cgroupMembers(dir).length !== 1 || cgroupMembers(dir)[0] !== mainPid)
      throw new Error("unit-main-process-membership-mismatch");

    const sourceBytes = Buffer.byteLength(input.source, "utf8");
    const request = JSON.stringify({ controlGroup: properties.ControlGroup, sourceBytes,
      sourceDigest: createHash("sha256").update(input.source, "utf8").digest("hex"), stdin: input.stdin });
    if (Buffer.byteLength(request, "utf8") > LINUX_CODING_REQUEST_MAX) throw new Error("coding-request-bound");
    running.send(request + "\n");
    running.send(input.source);
    timer = setTimeout(() => { failureReason = "candidate-timeout"; beginCleanup(); try { killExact(profile, unit); } catch { /* missing kill proof is handled below */ } }, b.wallMaxMs);
    abortHandler = () => { failureReason = "candidate-cancelled"; beginCleanup(); try { killExact(profile, unit); } catch { /* exact closure check below */ } };
    input.signal.addEventListener("abort", abortHandler, { once: true });

    // Wrapper retains the service cgroup after the bwrap PID namespace init exits.
    // It reports only after its cgroup.procs contains that trusted wrapper PID alone.
    const resultDeadline = performance.now() + b.wallMaxMs;
    let allText = "";
    while (performance.now() < resultDeadline) {
      if (input.signal.aborted) { failureReason = "candidate-cancelled"; break; }
      const available = Buffer.concat(running.output).toString("utf8");
      if (available.includes("RMD_RESULT ") && available.includes("\n")) { allText = available; break; }
      if (running.reason || (await Promise.race([running.closed.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 20))]))) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    }
    if (!allText) {
      if (!failureReason) failureReason = "candidate-timeout";
      beginCleanup();
      try { killExact(profile, unit); } catch { /* no release without closure proof */ }
      unitEmptyAfterStop = await stopAndProveEmpty();
      return { state: "unavailable", reason: unitEmptyAfterStop ? failureReason : "descendant-closure-unproved", configured: b,
        execution: { hostStarted, closure: unitEmptyAfterStop ? "proven" : "unavailable", hostExecutionId: unit } };
    }
    const line = allText.split("\n").find(row => row.startsWith("RMD_RESULT "))!;
    candidate = parseResultLine(line);
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (candidate.candidateWallMs > b.wallMaxMs) throw new Error("candidate-wall-bound-exceeded");
    if (failureReason) {
      beginCleanup();
      try { killExact(profile, unit); } catch { /* exact closure check below */ }
      unitEmptyAfterStop = await stopAndProveEmpty();
      return { state: "unavailable", reason: unitEmptyAfterStop ? failureReason : "descendant-closure-unproved", configured: b,
        execution: { hostStarted, closure: unitEmptyAfterStop ? "proven" : "unavailable", hostExecutionId: unit } };
    }
    if (candidate.stdoutBytes > b.stdoutMaxBytes || candidate.stderrBytes > b.stderrMaxBytes)
      throw new Error("candidate-output-bound-exceeded");
    if (!candidate.candidateClosedBeforeMetrics || candidate.pid !== mainPid ||
        cgroupMembers(dir).length !== 1 || cgroupMembers(dir)[0] !== mainPid) {
      failureReason = "descendant-closure-unproved";
      beginCleanup();
      try { killExact(profile, unit); } catch { /* checked below */ }
      unitEmptyAfterStop = await stopAndProveEmpty();
      return { state: "unavailable", reason: "descendant-closure-unproved", configured: b,
        execution: { hostStarted, closure: "unavailable", hostExecutionId: unit } };
    }

    // Read high-water counters before releasing the wrapper and before systemd
    // can collect the unit. The unit remains populated by this trusted wrapper.
    const native = readCounters(dir);
    observed = { ...observed, ...native,
      wallMs: candidate.candidateWallMs, stdoutBytes: candidate.stdoutBytes,
      stderrBytes: candidate.stderrBytes };
    try { stdout = utf8Strict(candidate.stdoutBase64); stderr = utf8Strict(candidate.stderrBase64); }
    catch { // Invalid candidate bytes are an incomplete readback, not an empty response.
      failureReason = "resource-readback-incomplete"; }
    exitCode = candidate.exitCode;
    if (running.errorBytes > 4096 || running.outputBytes > LINUX_CODING_RESULT_LINE_MAX) throw new Error("controller-output-bound");

    // Parent-controlled release. The wrapper can exit only after sending the
    // result; service lifetime is independently bounded by RuntimeMaxSec.
    beginCleanup();
    running.send("release\n");
    unitEmptyAfterStop = await stopAndProveEmpty();
    const out = { binding: input.binding, candidateDigest: sha256(input.source), exitCode, stdout, stderr,
      observed };
    if (!unitEmptyAfterStop) return { state: "unavailable", reason: "descendant-closure-unproved", configured: b,
      execution: { hostStarted, closure: "unavailable", hostExecutionId: unit }, partial: partialResult({ ...out, hostExecutionId: unit }, false) };

    // The host cgroup does not report scratch bytes attributable to this run or
    // V8 heap high-water. They stay null; no configured cap is copied as a peak.
    // Consequently this version preserves output for diagnosis but never emits
    // state=complete or a correctness score.
    return { state: "unavailable", reason: "resource-readback-incomplete", configured: b,
      execution: { hostStarted, closure: "proven", hostExecutionId: unit }, partial: partialResult({ ...out, hostExecutionId: unit }, true) };
  } catch (error) {
    if (!failureReason) failureReason = "native-executor-error";
    if (running) {
      beginCleanup();
      try { killExact(profile, unit); } catch { /* exact cgroup proof below */ }
      unitEmptyAfterStop = await stopAndProveEmpty()
        .catch(() => { /* Cleanup failure cannot prove the unit empty. */ return false; });
    }
    return { state: "unavailable", reason: unitEmptyAfterStop ? failureReason : "descendant-closure-unproved", configured: b,
      execution: { hostStarted, closure: unitEmptyAfterStop ? "proven" : "unavailable",
        hostExecutionId: hostStarted === "no" ? null : unit } };
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler) input.signal.removeEventListener("abort", abortHandler);
    if (dir) closeSync(dir.fd);
  }
}
