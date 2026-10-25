/**
 * W1-T9435: an explicit, read-only registry binding, not worker admission or a writer.
 * The legacy parser remains unchanged. Selected failures never consult a legacy path.
 * Filesystem work is awaited and allocation is capped; cancellation bounds the caller's
 * wait, not every OS request. Late operations still close their own handle.
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import { RmdError } from "./errors.js";
import { SELECTED_INSTANCE_REGISTRY_FIELDS, parseInstanceRegistry, projectRegistry, type RegistryInstance, type RegistryProjection } from "./instance-registry.js";

export interface RegistrySelectionInput {
  cliPath?: string;
  /** The caller's explicit RMD_INSTANCE_REGISTRY value; no ambient environment lookup here. */
  envPath?: string;
  configuredPath?: string;
  legacyPath?: string;
  contractVersion?: number;
  requiredCapabilities?: readonly string[];
  expectedDigest?: string;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RegistryFileStamp {
  regular: boolean;
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink?: number;
}
export interface RegistryFileHandle {
  stat(): Promise<RegistryFileStamp>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
  close(): Promise<void>;
}
/** A narrow async file port shared by the initial read and recheck; no shell or sync adapter. */
export interface RegistryFileIO {
  lstat(path: string): Promise<RegistryFileStamp>;
  open(path: string): Promise<RegistryFileHandle>;
  canonicalPath?(path: string): Promise<string>;
}
interface RegistryBytes {
  kind: "bytes";
  bytes: Buffer;
  identity: Readonly<RegistryFileStamp>;
}
const stamp = (s: Awaited<ReturnType<typeof lstat>>): RegistryFileStamp => ({
  regular: s.isFile(), size: Number(s.size), dev: Number(s.dev), ino: Number(s.ino),
  mtimeMs: Number(s.mtimeMs), ctimeMs: Number(s.ctimeMs), nlink: Number(s.nlink),
});
export const registryFileIO: RegistryFileIO = {
  canonicalPath: realpath,
  lstat: async (path) => stamp(await lstat(path)),
  open: async (path) => {
    // NONBLOCK keeps an intervening FIFO from blocking open; NOFOLLOW refuses a symlink race.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    return {
      stat: async () => stamp(await handle.stat()),
      read: async (buffer, offset, length, position) => (await handle.read(buffer, offset, length, position)).bytesRead,
      close: () => handle.close(),
    };
  },
};

type UnknownReason = "missing" | "not_regular" | "oversized" | "revision_changed"
  | "lstat_failed" | "open_failed" | "stat_failed" | "read_failed" | "close_failed"
  | "cancelled" | "timeout" | "invalid_encoding" | "malformed" | "digest_mismatch";
type RefusalReason = "invalid_path" | "invalid_bounds" | "invalid_digest"
  | "unsupported_contract" | "unsupported_capability" | "unsupported_field";
type Unknown = { kind: "unknown"; reason: UnknownReason };
type Refused = { kind: "refused"; reason: RefusalReason };
export type RegistryRecheck = { kind: "unchanged" | "changed" } | Unknown | Refused;
export interface SelectedRegistryBinding {
  readonly source: "cli" | "environment" | "configuration";
  readonly contractVersion: number;
  readonly capabilities: readonly string[];
  readonly digest: string;
  readonly instances: readonly Readonly<RegistryInstance>[];
  readonly publicationPermission: "not-granted";
  publicProjection(): RegistryProjection;
  recheck(signal?: AbortSignal): Promise<RegistryRecheck>;
}
export type SelectedRegistryRead = { kind: "legacy" } | Unknown | Refused
  | { kind: "ready"; binding: SelectedRegistryBinding };

const MAX_BYTES = 256 * 1024;
const CAPABILITIES = Object.freeze(["identity", "mode", "primary"]);
const FIELDS = new Set(SELECTED_INSTANCE_REGISTRY_FIELDS);
class ReadRefusal extends RmdError {
  constructor(readonly reason: UnknownReason) { super("registry", 1, reason, { reason }); }
}
function sameStamp(a: RegistryFileStamp, b: RegistryFileStamp): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
}
function requireFile(s: RegistryFileStamp, maxBytes: number): void {
  if (!s.regular) throw new ReadRefusal("not_regular");
  if (!Number.isSafeInteger(s.size) || s.size < 0 || s.size > maxBytes) throw new ReadRefusal("oversized");
}
function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new ReadRefusal("cancelled");
}

async function readBounded(path: string, maxBytes: number, signal: AbortSignal, io: RegistryFileIO): Promise<RegistryBytes | Unknown> {
  let handle: RegistryFileHandle | undefined;
  let phase: UnknownReason = "lstat_failed";
  let result: RegistryBytes | Unknown;
  try {
    requireActive(signal);
    const before = await io.lstat(path); requireFile(before, maxBytes);
    requireActive(signal); phase = "open_failed"; handle = await io.open(path);
    requireActive(signal); phase = "stat_failed";
    const opened = await handle.stat(); requireFile(opened, maxBytes);
    if (!sameStamp(before, opened)) throw new ReadRefusal("revision_changed");
    // One bounded buffer, including a one-byte overflow probe. Stat never authorizes allocation.
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0; phase = "read_failed";
    while (length < bytes.length) {
      requireActive(signal);
      const n = await handle.read(bytes, length, bytes.length - length, length);
      if (!Number.isSafeInteger(n) || n < 0 || n > bytes.length - length) throw new ReadRefusal("read_failed");
      if (n === 0) break;
      length += n;
      if (length > maxBytes) throw new ReadRefusal("oversized");
    }
    requireActive(signal); phase = "stat_failed";
    const after = await handle.stat(), current = await io.lstat(path);
    requireFile(after, maxBytes); requireFile(current, maxBytes);
    if (length !== opened.size || !sameStamp(opened, after) || !sameStamp(after, current)) throw new ReadRefusal("revision_changed");
    result = { kind: "bytes", bytes: bytes.subarray(0, length), identity: Object.freeze({ ...after }) };
  } catch (error) {
    // Unknown I/O is not absence or a healthy fallback; never surface OS messages/private paths.
    result = { kind: "unknown", reason: error instanceof ReadRefusal ? error.reason
      : (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : phase };
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch {
        // A close failure is unresolved resource/integrity evidence, not a successful read.
        result = { kind: "unknown", reason: "close_failed" };
      }
    }
  }
  return result!;
}

async function readWithDeadline(path: string, maxBytes: number, timeoutMs: number, external: AbortSignal | undefined, io: RegistryFileIO): Promise<RegistryBytes | Unknown> {
  if (external?.aborted) return { kind: "unknown", reason: "cancelled" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void;
  const stopped = new Promise<Unknown>((resolve) => {
    onAbort = () => { controller.abort(); resolve({ kind: "unknown", reason: "cancelled" }); };
    timer = setTimeout(() => { controller.abort(); resolve({ kind: "unknown", reason: "timeout" }); }, timeoutMs);
    external?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([readBounded(path, maxBytes, controller.signal, io), stopped]);
  } finally {
    clearTimeout(timer!); external?.removeEventListener("abort", onAbort!);
  }
}

/** Selected schema is explicit: unsupported fields cannot masquerade as carried safety data. */
function supportedFields(text: string): boolean {
  return text.split(/\r?\n/).every((raw) => {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) return true;
    if (/^\S/.test(line)) return line === "instances:" || /^version:\s*1$/.test(line);
    const field = /^ {4}([A-Za-z_]+):/.exec(line);
    return field === null || FIELDS.has(field[1]);
  });
}

/** True absence is explicit; an empty/invalid higher-precedence value is never skipped. */
export async function readSelectedInstanceRegistry(input: RegistrySelectionInput, io: RegistryFileIO = registryFileIO): Promise<SelectedRegistryRead> {
  const source = input.cliPath !== undefined ? "cli" : input.envPath !== undefined ? "environment"
    : input.configuredPath !== undefined ? "configuration" : undefined;
  if (source === undefined) return { kind: "legacy" };
  const path = source === "cli" ? input.cliPath : source === "environment" ? input.envPath : input.configuredPath;
  if (typeof path !== "string" || path === "" || path.includes("\0") || !isAbsolute(path)) return { kind: "refused", reason: "invalid_path" };
  const contractVersion = input.contractVersion ?? 1;
  if (contractVersion !== 1 && contractVersion !== 2) return { kind: "refused", reason: "unsupported_contract" };
  const required = input.requiredCapabilities ?? [];
  if (!Array.isArray(required) || required.length > 16 || required.some(c => !CAPABILITIES.includes(c))) return { kind: "refused", reason: "unsupported_capability" };
  const maxBytes = input.maxBytes ?? 64 * 1024, timeoutMs = input.timeoutMs ?? 1500, expectedDigest = input.expectedDigest;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return { kind: "refused", reason: "invalid_bounds" };
  if (expectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(expectedDigest)) return { kind: "refused", reason: "invalid_digest" };
  // Copy every selected value before the first await; caller mutation cannot retarget this read.
  const capabilities = Object.freeze([...CAPABILITIES]);
  const bytes = await readWithDeadline(path, maxBytes, timeoutMs, input.signal, io);
  if (bytes.kind === "unknown") return bytes;
  const digest = createHash("sha256").update(bytes.bytes).digest("hex");
  if (expectedDigest !== undefined && digest !== expectedDigest) return { kind: "unknown", reason: "digest_mismatch" };
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.bytes); }
  catch {
    // Invalid bytes are unknown evidence, not a replacement-character identity.
    return { kind: "unknown", reason: "invalid_encoding" };
  }
  if (text.includes("\0")) return { kind: "unknown", reason: "invalid_encoding" };
  let parsed;
  try { parsed = parseInstanceRegistry(text); }
  catch {
    // Existing parser messages include source values. This contract exposes only the stable outcome.
    return { kind: "unknown", reason: "malformed" };
  }
  if (!supportedFields(text)) return { kind: "refused", reason: "unsupported_field" };
  const instances = Object.freeze(parsed.instances.map(instance => Object.freeze({ ...instance })));
  const binding: SelectedRegistryBinding = Object.freeze({
    source, contractVersion, capabilities, digest, instances, publicationPermission: "not-granted" as const,
    publicProjection: () => projectRegistry({ instances: instances.map(instance => ({ ...instance })) }),
    recheck: async (signal?: AbortSignal): Promise<RegistryRecheck> => {
      const current = await readSelectedInstanceRegistry({ cliPath: path, contractVersion, maxBytes, timeoutMs, signal }, io);
      if (current.kind === "ready") return { kind: current.binding.digest === digest ? "unchanged" : "changed" };
      // The closed-over absolute selection cannot become legacy; retain any actual unknown/refusal.
      return current as Unknown | Refused;
    },
  });
  trustedRegistryBytes.set(binding, { path, text, identity: bytes.identity, io, maxBytes, timeoutMs, contractVersion });
  return { kind: "ready", binding };
}

interface TrustedRegistryBytes {
  readonly path: string;
  readonly text: string;
  readonly identity: Readonly<RegistryFileStamp>;
  readonly io: RegistryFileIO;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly contractVersion: number;
}
const trustedRegistryBytes = new WeakMap<SelectedRegistryBinding, TrustedRegistryBytes>();
export interface InstanceRegistryRuntimeInput extends RegistrySelectionInput { instanceName?: string }
interface InstanceRegistryRuntime {
  readonly binding?: SelectedRegistryBinding;
  readonly instanceName?: string;
  readonly canonicalPath?: string;
  active: boolean;
}
const runtimeRegistry = new AsyncLocalStorage<InstanceRegistryRuntime>();

export class InstanceRegistryRuntimeError extends RmdError {
  constructor(reason: string) { super("registry", 2, `selected instance registry unavailable (${reason})`, { reason }); }
}

function selectedRuntime(): InstanceRegistryRuntime | undefined {
  const current = runtimeRegistry.getStore();
  if (current?.binding === undefined) return undefined;
  if (!current.active) throw new InstanceRegistryRuntimeError("invocation_closed");
  return current;
}

/** Trusted invocation scope only. No private path or raw lifecycle bytes are serialized on a binding. */
export async function withInstanceRegistryRuntime<T>(
  operation: () => T | Promise<T>,
  input: InstanceRegistryRuntimeInput = { envPath: process.env.RMD_INSTANCE_REGISTRY, instanceName: process.env.RMD_INSTANCE_NAME },
  io: RegistryFileIO = registryFileIO,
): Promise<T> {
  let snapshot: InstanceRegistryRuntimeInput, stableIO: RegistryFileIO;
  try {
    snapshot = { ...input, ...(input.requiredCapabilities === undefined ? {} : { requiredCapabilities: [...input.requiredCapabilities] }) };
    const lstat = io.lstat.bind(io), open = io.open.bind(io);
    stableIO = Object.freeze({ lstat, canonicalPath: io.canonicalPath?.bind(io), open: async (path: string) => {
      const handle = await open(path);
      return Object.freeze({ stat: handle.stat.bind(handle), read: handle.read.bind(handle), close: handle.close.bind(handle) });
    } });
  } catch {
    // Unreadable input or transport cannot establish a selected runtime, never a legacy fallback.
    throw new InstanceRegistryRuntimeError("input_unreadable");
  }
  const read = await readSelectedInstanceRegistry(snapshot, stableIO);
  if (read.kind !== "ready" && read.kind !== "legacy") throw new InstanceRegistryRuntimeError(read.reason);
  if (read.kind === "ready" && snapshot.instanceName !== undefined && (typeof snapshot.instanceName !== "string" || !/^[A-Za-z0-9_-]+$/.test(snapshot.instanceName))) {
    throw new InstanceRegistryRuntimeError("invalid_instance");
  }
  let canonicalPath: string | undefined;
  if (read.kind === "ready") {
    const original = trustedRegistryBytes.get(read.binding)!;
    try {
      canonicalPath = await stableIO.canonicalPath?.(original.path);
      if (!canonicalPath || !isAbsolute(canonicalPath) || original.identity.nlink !== 1
        || !sameStamp(original.identity, await stableIO.lstat(canonicalPath))) {
        throw new InstanceRegistryRuntimeError("file_identity_unqualified");
      }
    } catch {
      // A pathname-only denial cannot protect pre-existing hardlink aliases or unknown physical identity.
      throw new InstanceRegistryRuntimeError("file_identity_unqualified");
    }
  }
  const scope: InstanceRegistryRuntime = { active: true,
    ...(read.kind === "ready" ? { binding: read.binding, instanceName: snapshot.instanceName, canonicalPath } : {}) };
  try { return await runtimeRegistry.run(scope, operation); }
  finally { scope.active = false; }
}

export function instanceRegistryRuntimePresent(): boolean { return runtimeRegistry.getStore() !== undefined; }

/** Trusted harness input only: never forward this value to worker env, prompt, argv or diagnostics. */
export function runtimeInstanceRegistryPrivateFile(): string | undefined { return selectedRuntime()?.canonicalPath; }

export function runtimeInstanceRegistryText(): string | undefined {
  const scope = selectedRuntime();
  return scope?.binding === undefined ? undefined : trustedRegistryBytes.get(scope.binding)!.text;
}

export function runtimeInstanceRegistryMode(ownerRepo: string): "shadow" | "live" | undefined {
  const scope = selectedRuntime();
  if (scope?.binding === undefined) return undefined;
  if (typeof ownerRepo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ownerRepo)) {
    throw new InstanceRegistryRuntimeError("target_missing_or_mismatched");
  }
  const matches = scope.binding.instances.filter(row => row.repo.toLowerCase() === ownerRepo.toLowerCase()
    && (scope.instanceName === undefined || row.name === scope.instanceName));
  if (matches.length !== 1 || !matches[0]!.live) throw new InstanceRegistryRuntimeError("target_missing_or_mismatched");
  return matches[0]!.mode ?? "live";
}

/** The initial identity is retained; equal bytes at a replacement inode are still a revised runtime input. */
export async function assertInstanceRegistryRuntimeCurrent(): Promise<void> {
  const scope = selectedRuntime();
  if (scope?.binding === undefined) return;
  const original = trustedRegistryBytes.get(scope.binding)!;
  const read = await readSelectedInstanceRegistry({ cliPath: original.path, expectedDigest: scope.binding.digest,
    contractVersion: original.contractVersion, maxBytes: original.maxBytes, timeoutMs: original.timeoutMs }, original.io);
  if (read.kind !== "ready") throw new InstanceRegistryRuntimeError(read.kind === "legacy" ? "selection_missing" : read.reason);
  const current = trustedRegistryBytes.get(read.binding)!;
  if (!sameStamp(original.identity, current.identity)) throw new InstanceRegistryRuntimeError("revision_changed");
  try {
    if (await original.io.canonicalPath?.(original.path) !== scope.canonicalPath || current.identity.nlink !== 1) {
      throw new InstanceRegistryRuntimeError("revision_changed");
    }
  } catch {
    // Revised/unknown alias evidence never becomes permission for the selected target.
    throw new InstanceRegistryRuntimeError("revision_changed");
  }
  if (!scope.active) throw new InstanceRegistryRuntimeError("invocation_closed");
}
