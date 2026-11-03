/**
 * W1-T9435: an explicit, read-only registry binding, not worker admission or a writer.
 * The legacy parser remains unchanged. Selected failures never consult a legacy path.
 * Filesystem work is awaited and allocation is capped; cancellation bounds the caller's
 * wait, not every OS request. Late operations still close their own handle.
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
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
}
const stamp = (s: Awaited<ReturnType<typeof lstat>>): RegistryFileStamp => ({
  regular: s.isFile(), size: Number(s.size), dev: Number(s.dev), ino: Number(s.ino),
  mtimeMs: Number(s.mtimeMs), ctimeMs: Number(s.ctimeMs),
});
export const registryFileIO: RegistryFileIO = {
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
  /** Private byte-bound host comparison; never infers a container mount from a matching name. */
  matchesLifecycleTarget?(name: string, stateRoot: string, containerName?: string): boolean;
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
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function requireFile(s: RegistryFileStamp, maxBytes: number): void {
  if (!s.regular) throw new ReadRefusal("not_regular");
  if (!Number.isSafeInteger(s.size) || s.size < 0 || s.size > maxBytes) throw new ReadRefusal("oversized");
}
function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new ReadRefusal("cancelled");
}

async function readBounded(path: string, maxBytes: number, signal: AbortSignal, io: RegistryFileIO): Promise<{ kind: "bytes"; bytes: Buffer } | Unknown> {
  let handle: RegistryFileHandle | undefined;
  let phase: UnknownReason = "lstat_failed";
  let result: { kind: "bytes"; bytes: Buffer } | Unknown;
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
    result = { kind: "bytes", bytes: bytes.subarray(0, length) };
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

async function readWithDeadline(path: string, maxBytes: number, timeoutMs: number, external: AbortSignal | undefined, io: RegistryFileIO): Promise<{ kind: "bytes"; bytes: Buffer } | Unknown> {
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
function supportedFields(text: string, lifecycle: Map<string, Record<string, string>>): boolean {
  let inInstances = false;
  let instance: Record<string, string> | undefined;
  return text.split(/\r?\n/).every((raw) => {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) return true;
    if (/^\S/.test(line)) {
      inInstances = line === "instances:";
      instance = undefined;
      return inInstances || /^version:\s*1$/.test(line);
    }
    if (!inInstances) return true;
    const name = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (name) { instance = {}; lifecycle.set(name[1], instance); }
    const field = /^ {4}([A-Za-z_]+):/.exec(line);
    if (instance && field && (field[1] === "state_dir" || field[1] === "container_name")) {
      instance[field[1]] = line.slice(line.indexOf(":") + 1).trim();
    }
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
  const lifecycle = new Map<string, Record<string, string>>();
  if (!supportedFields(text, lifecycle)) return { kind: "refused", reason: "unsupported_field" };
  const instances = Object.freeze(parsed.instances.map(instance => Object.freeze({ ...instance })));
  const binding: SelectedRegistryBinding = Object.freeze({
    source, contractVersion, capabilities, digest, instances, publicationPermission: "not-granted" as const,
    publicProjection: () => projectRegistry({ instances: instances.map(instance => ({ ...instance })) }),
    matchesLifecycleTarget: (name: string, stateRoot: string, containerName?: string) => {
      const row = lifecycle.get(name);
      return row !== undefined && row.state_dir === stateRoot && stateRoot.startsWith("/")
        && (containerName === undefined || row.container_name === containerName);
    },
    recheck: async (signal?: AbortSignal): Promise<RegistryRecheck> => {
      const current = await readSelectedInstanceRegistry({ cliPath: path, contractVersion, maxBytes, timeoutMs, signal }, io);
      if (current.kind === "ready") return { kind: current.binding.digest === digest ? "unchanged" : "changed" };
      // The closed-over absolute selection cannot become legacy; retain any actual unknown/refusal.
      return current as Unknown | Refused;
    },
  });
  return { kind: "ready", binding };
}
