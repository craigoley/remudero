/**
 * Bounded local host bridge for the existing native coding owner.
 *
 * The only admitted data crossing this boundary is fixed synthetic stdin, bounded source,
 * binding IDs, and bounded candidate output/readbacks. No argv, executable, path, oracle,
 * auth, model configuration, cgroup property, or profile comes from the wire.
 *
 * Crucial: Node's core net.Socket does not expose Linux SO_PEERCRED. Production must supply
 * a real host-native peer-credential adapter and claimed-slot authority; this module has no
 * such adapter and therefore cannot start/qualify a server by itself.
 */
import { createHash, randomUUID } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmodSync, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CodingControlBindingV1, CodingConfiguredBounds, CodingExecutionDispositionV1,
  CodingExecutionReason, CodingObservedResources } from "./model-canary-coding.js";
import type { CodingAttemptConsumptionCapability, CanarySlotOwner, ClaimedCodingRequestBinding } from "./model-canary-owner.js";
import { codingAttemptConsumptionBinding } from "./model-canary-coding-capabilities.js";

export const HOST_CODING_PROTOCOL = "rmd-coding-host-bridge-v1" as const;
export const HOST_CODING_REQUEST_MAX = 20_480; // PRIMARY CONTROL: caps the framed host request before socket write.
export const HOST_CODING_RESPONSE_MAX = 12_288; // PRIMARY CONTROL: caps bytes accepted from the host bridge.
export const HOST_CODING_SOURCE_MAX = 8_192; // PRIMARY CONTROL: caps source transported to the host.
export const HOST_CODING_STDIN_MAX = 4_096; // PRIMARY CONTROL: caps candidate stdin at the bridge boundary.
export const HOST_CODING_STDOUT_MAX = 4_096; // PRIMARY CONTROL: caps candidate stdout returned by the host.
export const HOST_CODING_STDERR_MAX = 4_096; // PRIMARY CONTROL: caps candidate stderr returned by the host.
// sun_path includes a terminating NUL: macOS provides 104 bytes, Linux 108.
const MAX_UNIX_SOCKET_PATH_BYTES = process.platform === "linux" ? 107 : 103;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[a-f0-9]{64}$/;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export type CodingHostBindingV1 = CodingControlBindingV1;
export type CodingHostRequestBindingV1 = ClaimedCodingRequestBinding;
export interface CodingHostRequestV1 {
  version: typeof HOST_CODING_PROTOCOL;
  kind: "execute";
  requestId: string;
  binding: CodingHostRequestBindingV1;
  source: string;
  sourceDigest: string;
  /** Synthetic task input only. Expected answer is scorer-owned and never crosses IPC. */
  stdin: string;
}
export type CodingHostResultV1 =
  | { version: typeof HOST_CODING_PROTOCOL; kind: "result"; requestId: string; state: "unavailable";
      reason: "bridge-disabled" | "peer-identity-unavailable" | "slot-authority-unavailable"
        | "profile-unavailable" | "backend-unavailable" | "request-refused";
      binding?: CodingHostRequestBindingV1; execution: CodingExecutionDispositionV1 }
  | { version: typeof HOST_CODING_PROTOCOL; kind: "result"; requestId: string; state: "uncertain";
      reason: "execution-outcome-unknown"; binding: CodingHostRequestBindingV1; execution: CodingExecutionDispositionV1 }
  | { version: typeof HOST_CODING_PROTOCOL; kind: "result"; requestId: string; state: "closed-unavailable";
      reason: CodingExecutionReason; binding: CodingHostBindingV1; execution: CodingExecutionDispositionV1;
      configured: CodingConfiguredBounds | null; observed: CodingObservedResources | null;
      candidateOutput: { candidateExitCode: number; stdout: string; stderr: string } | null }
  | { version: typeof HOST_CODING_PROTOCOL; kind: "result"; requestId: string; state: "complete" | "cancelled";
      binding: CodingHostBindingV1; sourceDigest: string; candidateExitCode: number;
      stdout: string; stderr: string; /** Opaque ID, never an executable command. */
      hostExecutionId: string; hostReceiptId: string; receiptDigest: string; execution: CodingExecutionDispositionV1 };

export interface HostPeerIdentityV1 { uid: number; gid: number; pid: number; cgroup: string }
const peerTokenState = new WeakMap<object, HostPeerIdentityV1>();
export interface AuthenticatedHostPeerV1 { readonly kind: "authenticated-host-peer-v1" }
/** Internal host OS adapter only. Peer identity must be kernel-derived, never decoded from payload. */
export function bindAuthenticatedHostPeer(identity: HostPeerIdentityV1): AuthenticatedHostPeerV1 {
  if (![identity.uid, identity.gid, identity.pid].every(n => Number.isSafeInteger(n) && n >= 0)
    || identity.pid < 1 || !identity.cgroup.startsWith("/")) throw new Error("host-peer-identity-invalid");
  const token = Object.freeze(Object.create(null)) as AuthenticatedHostPeerV1;
  peerTokenState.set(token, Object.freeze({ ...identity }));
  return token;
}
export interface HostQualifiedBackendV1 { readonly kind: "host-qualified-coding-backend-v1" }
export interface HostBackendExecutionV1 {
  /**
   * Must observe signal and settle only after candidate descendants are closed, native counters are
   * captured, and the exact unit is empty. A rejection/lost completion is uncertain: owner state
   * stays consumed and no new execution may be started for this attempt.
   */
  execute: (input: { binding: CodingHostBindingV1; attempt: CodingAttemptConsumptionCapability;
    source: string; stdin: string; signal: AbortSignal }) => Promise<{
    state?: "complete" | "unavailable";
    reason?: CodingExecutionReason;
    sourceDigest: string; candidateExitCode: number; stdout: string; stderr: string;
    hostExecutionId: string; hostReceiptId: string; receiptDigest: string; closureProved: true; limitsReadBack: true;
    configured?: CodingConfiguredBounds | null; observed?: CodingObservedResources | null;
  }>;
}
const backendTokenState = new WeakMap<object, HostBackendExecutionV1>();
/** Mint only in the existing native host owner after actual fixed-profile qualification. */
export function bindHostQualifiedBackend(input: HostBackendExecutionV1): HostQualifiedBackendV1 {
  if (typeof input?.execute !== "function") throw new Error("host-backend-invalid");
  const token = Object.freeze(Object.create(null)) as HostQualifiedBackendV1;
  backendTokenState.set(token, input);
  return token;
}

export interface HostBridgeNativePortsV1 {
  /** Implemented from kernel SO_PEERCRED and cgroup/proc identity, not socket message fields. */
  authenticate(socket: Socket, signal: AbortSignal): Promise<AuthenticatedHostPeerV1 | null>;
  /** Same existing durable owner handles initial claim, resolution, one-shot consume and terminal. */
  owner: Pick<CanarySlotOwner, "consumeCodingAttempt" | "resolveClaimedCodingSlot">;
  /** Process-local capability from trusted host qualification, never a config boolean. */
  backend: HostQualifiedBackendV1 | null;
  /** Exact caller uid and cgroup are host deployment state, never request data. */
  expectedPeer: Readonly<{ uid: number; cgroup: string }>;
}
export interface HostBridgeServerConfigV1 {
  enabled?: boolean; // must be literal true, supplied by host owner deployment code, never wire
  socketPath: string; // trusted owner configuration, never wire
  operations: HostBridgeNativePortsV1 | null;
  /** Owner profile deadline including candidate execution; finite and out of band. */
  executionTimeoutMs: number;
}
export interface HostBridgeServerHandleV1 { close(): Promise<void> }

function assertBinding(b: CodingHostBindingV1): void {
  if (!obj(b) || typeof b.caseId !== "string" || b.caseId.length < 1 || b.caseId.length > 128
    || Object.keys(b).sort().join(",") !== "canaryAttemptId,caseId,codingExecutionAttemptId,runId,slotId,sourceDigest,suiteHash,workerSpawnAttemptId"
    || !HEX.test(b.suiteHash) || !UUID.test(b.runId) || !UUID.test(b.canaryAttemptId)
    || !UUID.test(b.workerSpawnAttemptId) || !UUID.test(b.codingExecutionAttemptId)
    || new Set([b.runId, b.canaryAttemptId, b.workerSpawnAttemptId, b.codingExecutionAttemptId]).size !== 4
    || !HEX.test(b.slotId) || !HEX.test(b.sourceDigest))
    throw new Error("host-bridge-binding-invalid");
}
function assertRequestBinding(b: CodingHostRequestBindingV1): void {
  if (!obj(b) || typeof b.caseId !== "string" || b.caseId.length < 1 || b.caseId.length > 128
    || Object.keys(b).sort().join(",") !== "canaryAttemptId,caseId,runId,slotId,sourceDigest,suiteHash,workerSpawnAttemptId"
    || !HEX.test(b.suiteHash) || !UUID.test(b.runId) || !UUID.test(b.canaryAttemptId)
    || !UUID.test(b.workerSpawnAttemptId) || new Set([b.runId, b.canaryAttemptId, b.workerSpawnAttemptId]).size !== 3
    || !HEX.test(b.slotId) || !HEX.test(b.sourceDigest))
    throw new Error("host-bridge-binding-invalid");
}
export function decodeCodingHostRequest(line: string): CodingHostRequestV1 {
  if (Buffer.byteLength(line, "utf8") > HOST_CODING_REQUEST_MAX) throw new Error("host-bridge-request-bound");
  let x: unknown;
  try { x = JSON.parse(line); } catch { throw new Error("host-bridge-json-invalid"); }
  if (!obj(x) || !obj(x.binding) || x.version !== HOST_CODING_PROTOCOL || x.kind !== "execute" || !UUID.test(String(x.requestId)))
    throw new Error("host-bridge-envelope-invalid");
  const binding = x.binding as unknown as CodingHostRequestBindingV1;
  assertRequestBinding(binding);
  if (Object.keys(x).sort().join(",") !== "binding,kind,requestId,source,sourceDigest,stdin,version"
    || typeof x.source !== "string" || Buffer.byteLength(x.source, "utf8") < 1
    || Buffer.byteLength(x.source, "utf8") > HOST_CODING_SOURCE_MAX || x.source.includes("\0")
    || typeof x.stdin !== "string" || Buffer.byteLength(x.stdin, "utf8") > HOST_CODING_STDIN_MAX
    || typeof x.sourceDigest !== "string" || !HEX.test(x.sourceDigest) || sha256(x.source) !== x.sourceDigest
    || binding.sourceDigest !== x.sourceDigest)
    throw new Error("host-bridge-request-shape-invalid");
  return x as unknown as CodingHostRequestV1;
}
function unavailable(requestId: string, reason: Extract<CodingHostResultV1, { state: "unavailable" }>["reason"],
  binding?: CodingHostRequestBindingV1): CodingHostResultV1 {
  return { version: HOST_CODING_PROTOCOL, kind: "result", requestId, state: "unavailable", reason,
    ...(binding ? { binding } : {}), execution: { hostStarted: "no", closure: "proven", hostExecutionId: null } };
}
function uncertain(requestId: string, binding: CodingHostRequestBindingV1,
  execution: CodingExecutionDispositionV1 = { hostStarted: "unknown", closure: "unavailable", hostExecutionId: null }): CodingHostResultV1 {
  return { version: HOST_CODING_PROTOCOL, kind: "result", requestId, state: "uncertain", reason: "execution-outcome-unknown",
    binding, execution };
}
function encode(result: CodingHostResultV1): string {
  const line = JSON.stringify(result);
  if (Buffer.byteLength(line, "utf8") > HOST_CODING_RESPONSE_MAX) return JSON.stringify(
    "binding" in result && result.binding
      ? uncertain(result.requestId, result.binding) : unavailable(result.requestId, "backend-unavailable"));
  return line;
}
function writeLine(socket: Socket, value: CodingHostResultV1): void { socket.end(encode(value) + "\n"); }

/**
 * Inert unless explicitly enabled AND all three native owner ports exist. This draft does not
 * create a Unix socket during module import. Production still needs real SO_PEERCRED, existing
 * owner-claim readback, and qualified backend bindings; absent any one, requests return unavailable.
 */
export async function startCodingHostBridge(config: HostBridgeServerConfigV1): Promise<HostBridgeServerHandleV1 | null> {
  if (config.enabled !== true || !config.operations || !config.operations.backend
    || typeof config.operations.authenticate !== "function"
    || typeof config.operations.owner?.consumeCodingAttempt !== "function"
    || typeof config.operations.owner?.resolveClaimedCodingSlot !== "function")
    return null;
  if (!Number.isSafeInteger(config.executionTimeoutMs) || config.executionTimeoutMs < 100
    || config.executionTimeoutMs > 120_000) throw new Error("host-bridge-execution-timeout-invalid");
  const { socketPath, operations } = config;
  if (!socketPath.startsWith("/") || socketPath.length > 256
    || Buffer.byteLength(socketPath, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES)
    throw new Error("host-bridge-socket-path-invalid");
  const socketDirectory = dirname(socketPath), directoryInfo = lstatSync(socketDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid !== process.getuid?.()
    || (directoryInfo.mode & 0o077) !== 0 || realpathSync(socketDirectory) !== resolve(socketDirectory))
    throw new Error("host-bridge-private-socket-directory-required");
  try {
    const st = lstatSync(socketPath);
    if (!st.isSocket() || st.uid !== process.getuid?.()) throw new Error("host-bridge-existing-path-refused");
    throw new Error("host-bridge-will-not-replace-existing-socket");
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }

  const active = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const server: Server = createServer(socket => {
    const work = serveOne(socket, operations, config.executionTimeoutMs, controllers);
    active.add(work);
    void work.finally(() => active.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(socketPath, 0o600);
  return { close: async () => {
    const serverClosed = new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    for (const controller of controllers) controller.abort(new Error("coding-host-shutdown"));
    await serverClosed;
    // Includes work whose client disconnected. Do not finish host shutdown before backend closure.
    await Promise.allSettled([...active]);
  } };
}

async function serveOne(socket: Socket, operations: HostBridgeNativePortsV1, executionTimeoutMs: number,
  activeControllers: Set<AbortController>): Promise<void> {
  await new Promise<void>(resolve => {
  socket.setTimeout(3_000, () => socket.destroy());
  const chunks: Buffer[] = [];
  let bytes = 0, done = false;
  let controller: AbortController | null = null, finalized = false, dispatchWork: Promise<void> | null = null, settled = false;
  const finish = () => { if (!settled) { settled = true; resolve(); } };
  socket.on("close", () => {
    if (!finalized) controller?.abort(new Error("coding-client-disconnected"));
    if (!dispatchWork) finish();
  });
  socket.on("data", chunk => {
    // Exactly one bounded request frame is accepted per connection. Extra bytes after dispatch
    // starts cancel this connection; they are never interpreted as a second request.
    if (done) { socket.destroy(); return; }
    bytes += chunk.length;
    if (bytes > HOST_CODING_REQUEST_MAX + 1) { done = true; socket.destroy(); return; }
    chunks.push(Buffer.from(chunk));
    const all = Buffer.concat(chunks), newline = all.indexOf(10);
    if (newline < 0) return;
    done = true;
    if (newline !== all.length - 1) { socket.destroy(); return; }
    socket.setTimeout(0);
    controller = new AbortController();
    activeControllers.add(controller);
    const deadline = setTimeout(() => controller?.abort(new Error("coding-host-deadline")), executionTimeoutMs);
    dispatchWork = dispatch(Buffer.from(all.subarray(0, newline)).toString("utf8"), socket, operations, controller.signal)
      .then(result => {
        clearTimeout(deadline);
        if (result === null) { socket.destroy(); return; } // consumed attempt, unknown closure: client must hold
        if (socket.destroyed) return;
        finalized = true;
        writeLine(socket, result);
      }, () => {
        clearTimeout(deadline);
        // No success-shaped response on owner/backend failure. The durable attempt remains consumed.
        socket.destroy();
      }).finally(() => {
        clearTimeout(deadline);
        if (controller) activeControllers.delete(controller);
        finish();
      });
  });
  socket.on("error", () => {});
  });
}
async function dispatch(line: string, socket: Socket, ports: HostBridgeNativePortsV1,
  signal: AbortSignal): Promise<CodingHostResultV1 | null> {
  let requestId: string = randomUUID();
  let attemptConsumptionStarted = false;
  let requestBinding: CodingHostRequestBindingV1 | null = null;
  try {
    const request = decodeCodingHostRequest(line); requestId = request.requestId; requestBinding = request.binding;
    const peer = await ports.authenticate(socket, signal);
    const peerInfo = peer && peerTokenState.get(peer as object);
    if (!peerInfo || peerInfo.uid !== ports.expectedPeer.uid || peerInfo.cgroup !== ports.expectedPeer.cgroup) {
      return unavailable(requestId, "peer-identity-unavailable", request.binding);
    }
    const backend = ports.backend && backendTokenState.get(ports.backend as object);
    if (!backend) return unavailable(requestId, "profile-unavailable", request.binding);
    if (signal.aborted) return unavailable(requestId, "request-refused", request.binding);
    const slot = ports.owner.resolveClaimedCodingSlot(request.binding);
    if (!slot || slot.id !== request.binding.slotId || slot.caseId !== request.binding.caseId
      || slot.pin.suiteHash !== request.binding.suiteHash)
      return unavailable(requestId, "slot-authority-unavailable", request.binding);
    attemptConsumptionStarted = true;
    const consumption = ports.owner.consumeCodingAttempt(slot, { runId: request.binding.runId,
      canaryAttemptId: request.binding.canaryAttemptId, workerSpawnAttemptId: request.binding.workerSpawnAttemptId,
      sourceDigest: request.binding.sourceDigest });
    if (consumption.state !== "consumed") {
      if (consumption.state === "already-consumed") return uncertain(requestId, request.binding);
      return unavailable(requestId, "slot-authority-unavailable", request.binding);
    }
    const consumed = consumption.capability;
    const consumedBinding = codingAttemptConsumptionBinding(consumed);
    // An invalid capability after the durable CAS is ambiguous and must not look like a refusal.
    if (!consumedBinding || !sameRequestBinding(request.binding, consumedBinding)) return uncertain(requestId, request.binding);
    try { assertBinding(consumedBinding); } catch { // After durable consumption, invalid binding evidence is uncertain, never retryable.
      return uncertain(requestId, request.binding); }
    // Consumption is durable and one-shot. Abort after this point must never make the attempt retryable.
    if (signal.aborted) return uncertain(requestId, request.binding,
      { hostStarted: "no", closure: "proven", hostExecutionId: null });
    const result = await backend.execute({ binding: consumedBinding, attempt: consumed,
      source: request.source, stdin: request.stdin, signal });
    // Backend resolution itself is its closure barrier; a false/missing proof never finalizes.
    if (!sameBinding(consumedBinding, codingAttemptConsumptionBinding(consumed)!)
      || result.sourceDigest !== request.sourceDigest || !result.closureProved || !result.limitsReadBack
      || Buffer.byteLength(result.stdout, "utf8") > HOST_CODING_STDOUT_MAX
      || Buffer.byteLength(result.stderr, "utf8") > HOST_CODING_STDERR_MAX
      || !result.hostExecutionId || result.hostExecutionId.length > 256
      || !UUID.test(result.hostReceiptId) || !HEX.test(result.receiptDigest)
      || !Number.isSafeInteger(result.candidateExitCode)) {
      return uncertain(requestId, request.binding);
    }
    if (result.state === "unavailable") {
      if (!result.reason || !validConfigured(result.configured) || !validObserved(result.observed)
        || !Number.isSafeInteger(result.candidateExitCode) || result.candidateExitCode < 0 || result.candidateExitCode > 255)
        return uncertain(requestId, request.binding);
      return { version: HOST_CODING_PROTOCOL, kind: "result", requestId, state: "closed-unavailable",
        reason: result.reason, binding: consumedBinding,
        execution: { hostStarted: "yes", closure: "proven", hostExecutionId: result.hostExecutionId },
        configured: result.configured, observed: result.observed,
        candidateOutput: { candidateExitCode: result.candidateExitCode, stdout: result.stdout, stderr: result.stderr } };
    }
    return { version: HOST_CODING_PROTOCOL, kind: "result", requestId,
      state: signal.aborted ? "cancelled" : "complete",
      binding: consumedBinding, sourceDigest: request.sourceDigest, candidateExitCode: result.candidateExitCode,
      stdout: result.stdout, stderr: result.stderr, hostExecutionId: result.hostExecutionId,
      hostReceiptId: result.hostReceiptId, receiptDigest: result.receiptDigest,
      execution: { hostStarted: "yes", closure: "proven", hostExecutionId: result.hostExecutionId } };
  } catch {
    // Once consumption may have committed, even an exception is uncertain and may not be retried.
    if (attemptConsumptionStarted) return requestBinding ? uncertain(requestId, requestBinding) : null;
    if (signal.aborted) return null;
    return unavailable(requestId, "request-refused");
  }
}
function sameBinding(a: CodingHostBindingV1, b: CodingHostBindingV1): boolean {
  return a.caseId === b.caseId && a.suiteHash === b.suiteHash && a.runId === b.runId
    && a.canaryAttemptId === b.canaryAttemptId && a.workerSpawnAttemptId === b.workerSpawnAttemptId
    && a.codingExecutionAttemptId === b.codingExecutionAttemptId && a.slotId === b.slotId
    && a.sourceDigest === b.sourceDigest;
}
function sameRequestBinding(a: CodingHostRequestBindingV1, b: CodingHostBindingV1): boolean {
  return a.caseId === b.caseId && a.suiteHash === b.suiteHash && a.runId === b.runId
    && a.canaryAttemptId === b.canaryAttemptId && a.workerSpawnAttemptId === b.workerSpawnAttemptId
    && a.slotId === b.slotId && a.sourceDigest === b.sourceDigest;
}

function validConfigured(value: CodingConfiguredBounds | null | undefined): value is CodingConfiguredBounds | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  if (Object.keys(value).sort().join(",") !== "binaryDigest,cpuQuotaMicros,heapMaxBytes,memoryMaxBytes,profileDigest,profileId,runtimeId,scratchMaxBytes,stderrMaxBytes,stdoutMaxBytes,swapMaxBytes,tasksMax,wallMaxMs") return false;
  return typeof value.profileId === "string" && value.profileId.length > 0 && value.profileId.length <= 128
    && HEX.test(value.profileDigest) && HEX.test(value.binaryDigest)
    && value.runtimeId === "node-source-stdin-stdout-v1"
    && [value.cpuQuotaMicros, value.memoryMaxBytes, value.tasksMax, value.scratchMaxBytes, value.wallMaxMs,
      value.stdoutMaxBytes, value.stderrMaxBytes, value.heapMaxBytes].every(n => Number.isSafeInteger(n) && n > 0)
    && Number.isSafeInteger(value.swapMaxBytes) && value.swapMaxBytes >= 0;
}
function validObserved(value: CodingObservedResources | null | undefined): value is CodingObservedResources | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  if (Object.keys(value).sort().join(",") !== "cpuUsec,heapPeakBytes,memoryPeakBytes,pidsPeak,scratchPeakBytes,stderrBytes,stdoutBytes,swapPeakBytes,wallMs") return false;
  return [value.cpuUsec, value.memoryPeakBytes, value.swapPeakBytes, value.pidsPeak, value.scratchPeakBytes,
    value.wallMs, value.stdoutBytes, value.stderrBytes, value.heapPeakBytes]
    .every(n => n === null || Number.isSafeInteger(n) && n >= 0);
}

export interface HostBridgeClientV1 { execute(input: Omit<CodingHostRequestV1, "version" | "kind" | "requestId">,
  signal: AbortSignal): Promise<CodingHostResultV1> }
export interface HostBridgeClientConfigV1 { enabled?: boolean; socketPath: string; timeoutMs: number }
/** Socket path and enablement are trusted native owner inputs; a request cannot select either. */
export function createCodingHostBridgeClient(config: HostBridgeClientConfigV1 | null): HostBridgeClientV1 | null {
  if (!config || config.enabled !== true || !config.socketPath.startsWith("/")
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 180_000) return null;
  return { execute: (input, signal) => clientRequest(config, input, signal) };
}
function clientRequest(config: HostBridgeClientConfigV1, input: Omit<CodingHostRequestV1, "version" | "kind" | "requestId">,
  signal: AbortSignal): Promise<CodingHostResultV1> {
  if (signal.aborted) return Promise.resolve(unavailable(randomUUID(), "request-refused", input.binding));
  assertRequestBinding(input.binding);
  if (Buffer.byteLength(input.source, "utf8") > HOST_CODING_SOURCE_MAX || Buffer.byteLength(input.stdin, "utf8") > HOST_CODING_STDIN_MAX
    || sha256(input.source) !== input.sourceDigest || input.binding.sourceDigest !== input.sourceDigest)
    return Promise.resolve(unavailable(randomUUID(), "request-refused", input.binding));
  const request: CodingHostRequestV1 = { version: HOST_CODING_PROTOCOL, kind: "execute", requestId: randomUUID(), ...input };
  const line = JSON.stringify(request) + "\n";
  if (Buffer.byteLength(line, "utf8") > HOST_CODING_REQUEST_MAX)
    return Promise.resolve(unavailable(request.requestId, "request-refused", request.binding));
  return new Promise(resolve => {
    let settled = false;
    const decoder = new StringDecoder("utf8");
    let response = "";
    const finish = (value: CodingHostResultV1) => { if (!settled) { settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(value); } };
    const socket = createConnection({ path: config.socketPath });
    const timer = setTimeout(() => { socket.destroy(); finish(uncertain(request.requestId, request.binding)); }, config.timeoutMs);
    const abort = () => { socket.destroy(); finish(uncertain(request.requestId, request.binding)); };
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => socket.write(line));
    socket.on("data", chunk => {
      response += decoder.write(chunk);
      if (Buffer.byteLength(response, "utf8") > HOST_CODING_RESPONSE_MAX + 1) {
        socket.destroy(); finish(uncertain(request.requestId, request.binding)); return;
      }
    });
    socket.once("end", () => {
      try {
        response += decoder.end();
        const index = response.indexOf("\n");
        if (index < 0 || index !== response.length - 1) throw new Error("response-frame-invalid");
        const parsed: unknown = JSON.parse(response.slice(0, index));
        if (!validResult(parsed, request)) throw new Error("response-invalid");
        finish(parsed);
      } catch { // Malformed/truncated host replies cannot prove the consumed attempt's outcome.
        finish(uncertain(request.requestId, request.binding)); }
    });
    socket.once("error", () => finish(uncertain(request.requestId, request.binding)));
    socket.once("close", () => { if (!settled) finish(uncertain(request.requestId, request.binding)); });
  });
}
function validResult(value: unknown, request: CodingHostRequestV1): value is CodingHostResultV1 {
  if (!obj(value) || value.version !== HOST_CODING_PROTOCOL || value.kind !== "result" || value.requestId !== request.requestId) return false;
  if (value.state === "closed-unavailable") {
    return Object.keys(value).sort().join(",") === "binding,candidateOutput,configured,execution,kind,observed,reason,requestId,state,version"
      && value.binding !== null && obj(value.binding)
      && Object.keys(value.binding).sort().join(",") === "canaryAttemptId,caseId,codingExecutionAttemptId,runId,slotId,sourceDigest,suiteHash,workerSpawnAttemptId"
      && sameRequestBinding(request.binding, value.binding as unknown as CodingHostBindingV1)
      && validDisposition(value.execution) && value.execution.hostStarted === "yes" && value.execution.closure === "proven"
      && typeof value.execution.hostExecutionId === "string" && value.execution.hostExecutionId.length > 0
      && value.execution.hostExecutionId.length <= 256
      && ["native-backend-unavailable", "owner-profile-unavailable", "isolation-unavailable",
        "resource-readback-incomplete", "candidate-timeout", "candidate-cancelled",
        "descendant-closure-unproved", "native-executor-error", "worker-spawn-identity-unavailable",
        "coding-response-invalid", "owner-attempt-already-consumed", "coding-tool-request-denied",
        "coding-case-binding-mismatch"].includes(String(value.reason))
      && validConfigured(value.configured as CodingConfiguredBounds | null)
      && validObserved(value.observed as CodingObservedResources | null)
      && (value.candidateOutput === null || obj(value.candidateOutput)
        && Object.keys(value.candidateOutput).sort().join(",") === "candidateExitCode,stderr,stdout"
        && Number.isSafeInteger(value.candidateOutput.candidateExitCode)
        && Number(value.candidateOutput.candidateExitCode) >= 0 && Number(value.candidateOutput.candidateExitCode) <= 255
        && typeof value.candidateOutput.stdout === "string" && Buffer.byteLength(value.candidateOutput.stdout, "utf8") <= HOST_CODING_STDOUT_MAX
        && typeof value.candidateOutput.stderr === "string" && Buffer.byteLength(value.candidateOutput.stderr, "utf8") <= HOST_CODING_STDERR_MAX);
  }
  if (value.state === "uncertain" || value.state === "unavailable") {
    if (!validDisposition(value.execution)) return false;
    const hasBinding = value.binding !== undefined;
    if (hasBinding && (!obj(value.binding)
      || !sameRequestBinding(request.binding, value.binding as unknown as CodingHostBindingV1))) return false;
    const keys = hasBinding ? "binding,execution,kind,reason,requestId,state,version"
      : "execution,kind,reason,requestId,state,version";
    if (Object.keys(value).sort().join(",") !== keys) return false;
    if (value.state === "uncertain") return hasBinding && value.reason === "execution-outcome-unknown"
      && (value.execution.hostStarted === "unknown"
        || value.execution.hostStarted === "no" && value.execution.closure === "proven");
    return value.execution.hostStarted === "no" && value.execution.closure === "proven"
      && ["bridge-disabled", "peer-identity-unavailable", "slot-authority-unavailable",
        "profile-unavailable", "backend-unavailable", "request-refused"].includes(String(value.reason));
  }
  if (Object.keys(value).sort().join(",") !== "binding,candidateExitCode,execution,hostExecutionId,hostReceiptId,kind,receiptDigest,requestId,sourceDigest,state,stderr,stdout,version") return false;
  return (value.state === "complete" || value.state === "cancelled")
    && validDisposition(value.execution) && value.execution.hostStarted === "yes" && value.execution.closure === "proven"
    && typeof value.hostExecutionId === "string" && value.hostExecutionId.length > 0 && value.hostExecutionId.length <= 256
    && value.execution.hostExecutionId === value.hostExecutionId
    && obj(value.binding) && Object.keys(value.binding).sort().join(",") === "canaryAttemptId,caseId,codingExecutionAttemptId,runId,slotId,sourceDigest,suiteHash,workerSpawnAttemptId"
    && sameRequestBinding(request.binding, value.binding as unknown as CodingHostBindingV1)
    && value.sourceDigest === request.sourceDigest && Number.isSafeInteger(value.candidateExitCode)
    && Number(value.candidateExitCode) >= 0 && Number(value.candidateExitCode) <= 255
    && typeof value.stdout === "string" && Buffer.byteLength(value.stdout, "utf8") <= HOST_CODING_STDOUT_MAX
    && typeof value.stderr === "string" && Buffer.byteLength(value.stderr, "utf8") <= HOST_CODING_STDERR_MAX
    && value.binding.sourceDigest === value.sourceDigest
    && typeof value.hostReceiptId === "string" && UUID.test(value.hostReceiptId)
    && typeof value.receiptDigest === "string" && HEX.test(value.receiptDigest);
}

function validDisposition(value: unknown): value is CodingExecutionDispositionV1 {
  if (!obj(value) || Object.keys(value).sort().join(",") !== "closure,hostExecutionId,hostStarted") return false;
  if (!(value.hostStarted === "no" || value.hostStarted === "yes" || value.hostStarted === "unknown")
    || !(value.closure === "proven" || value.closure === "unavailable")) return false;
  if (value.hostStarted === "no") return value.closure === "proven" && value.hostExecutionId === null;
  if (value.hostStarted === "unknown") return value.closure === "unavailable" && value.hostExecutionId === null;
  return typeof value.hostExecutionId === "string" && value.hostExecutionId.length > 0 && value.hostExecutionId.length <= 256;
}
