import { AsyncLocalStorage } from "node:async_hooks";
import type { SelectedModeSettings } from "./config-schema.js";
import { readSelectedInstanceRegistry, registryFileIO, type RegistryFileIO,
  type RegistrySelectionInput, type SelectedRegistryBinding } from "./instance-registry-selection.js";

export type RegistryConsumerAction = "serve-registry" | "serve-readiness" | "serve-go-live" | "serve-shadow-evidence" | "serve-topology"
  | "serve-liveness" | "repositories-view" | "repo-dashboard" | "benchmark-discovery" | "inbox-discovery"
  | "deploy-restart" | "deploy-recycle" | "deploy-rollback" | "serve-policy-replace" | "pause-target" | "pause" | "resume" | "sre-target";
export interface RegistryConsumerTarget {
  repository?: string;
  instanceName?: string;
  stateRoot?: string;
  containerName?: string;
  namespace?: "host" | "container";
}
export type RegistryObservationSink = (step: string, fields: Readonly<Record<string, unknown>>) => unknown;
export type RegistryConsumerRead = typeof readSelectedInstanceRegistry;
/** Trusted composition only. Neither this context nor its selected input belongs in a public body. */
export interface SelectedRegistryConsumerOptions {
  settings?: SelectedModeSettings;
  input?: RegistrySelectionInput;
  record?: RegistryObservationSink;
  io?: RegistryFileIO;
}
export interface SelectedRegistryObserver {
  observe<T>(action: RegistryConsumerAction, target: RegistryConsumerTarget, operation: () => T | Promise<T>): Promise<T>;
  observeSync<T>(action: RegistryConsumerAction, target: RegistryConsumerTarget, operation: () => T): T;
  settled(): Promise<void>;
  close(): void;
}
type Evidence = { selected_state: "ready" | "absent" | "retired" | "unknown"; reason?: string; binding_digest?: string;
  selection_source?: SelectedRegistryBinding["source"]; contract_version?: number; capabilities?: readonly string[] };
type Bound = { kind: "ready"; binding: SelectedRegistryBinding } | { kind: "unknown"; reason: string };
type Captured = { kind: "off" } | { kind: "unknown"; record?: RegistryObservationSink }
  | { kind: "selected"; input: RegistrySelectionInput; io: RegistryFileIO; name?: string; record?: RegistryObservationSink; transferable: boolean };
export type SelectedRegistryIntent = { readonly kind: "unknown"; readonly version: 1 }
  | { readonly kind: "shadow"; readonly version: 1; readonly input: Omit<RegistrySelectionInput, "signal">; readonly instanceName?: string };
const unavailableIntent = (): SelectedRegistryIntent => Object.freeze({ kind: "unknown", version: 1 });
const unknown = (reason: string, digest?: string): Evidence => ({ selected_state: "unknown", reason,
  ...(digest === undefined ? {} : { binding_digest: digest }) });
const LIMIT = 32;
const isLifecycleAction = (action: RegistryConsumerAction): boolean => action.startsWith("deploy-")
  || ["serve-policy-replace", "pause-target", "pause", "resume", "sre-target"].includes(action);
interface ConsumerScope { observer: SelectedRegistryObserver | undefined; active: boolean }
const consumerScope = new AsyncLocalStorage<ConsumerScope>();

/** Invocation-owned diagnostics only. An absent nested invocation masks, rather than inherits, opt-in. */
export function selectedRegistryObserverInContext(): SelectedRegistryObserver | undefined {
  const scope = consumerScope.getStore();
  return scope?.active ? scope.observer : undefined;
}

export async function withSelectedRegistryContext<T>(observer: SelectedRegistryObserver | undefined,
  operation: () => Promise<T>): Promise<T> {
  const scope: ConsumerScope = { observer, active: true };
  try { return await consumerScope.run(scope, operation); }
  finally { scope.active = false; observer?.close(); }
}

/** Sync consumers stay sync; this neither waits for selected IO nor grants fresh authority. */
export function withSelectedRegistryContextSync<T>(observer: SelectedRegistryObserver | undefined, operation: () => T): T {
  const scope: ConsumerScope = { observer, active: true };
  try { return consumerScope.run(scope, operation); }
  finally { scope.active = false; observer?.close(); }
}

function capture(options: SelectedRegistryConsumerOptions | undefined): Captured {
  if (options === undefined) return { kind: "off" };
  let record: RegistryObservationSink | undefined;
  try {
    const settings = options.settings;
    if (settings?.mode !== "shadow") return { kind: "off" };
    record = options.record;
    const { cliPath, envPath, configuredPath, contractVersion, requiredCapabilities, expectedDigest,
      maxBytes, timeoutMs, signal } = options.input ?? {};
    const providedIO = options.io;
    const io = providedIO ?? registryFileIO, lstat = io.lstat.bind(io), open = io.open.bind(io);
    const ports: RegistryFileIO = Object.freeze({ lstat, open: async (path: string) => {
      const handle = await open(path);
      return Object.freeze({ stat: handle.stat.bind(handle), read: handle.read.bind(handle), close: handle.close.bind(handle) });
    } });
    return { kind: "selected", record, name: settings.instanceName, transferable: providedIO === undefined && signal === undefined,
      input: Object.freeze({ cliPath, envPath,
        configuredPath: configuredPath === undefined ? settings.registryPath : configuredPath,
        contractVersion: contractVersion ?? settings.contractVersion,
        requiredCapabilities: Object.freeze([...(requiredCapabilities ?? [])]),
        expectedDigest, maxBytes: maxBytes ?? settings.maxBytes,
        timeoutMs: timeoutMs ?? settings.timeoutMs, signal }), io: ports };
  } catch {
    // Unreadable selection/ports cannot establish authority. Retain unknown without exposing their exception.
    return { kind: "unknown", record };
  }
}

/** Data for trusted projector/view threads only, never a public body or untrusted worker argument. */
export function copySelectedRegistryIntent(value: unknown): SelectedRegistryIntent | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "object" || value === null) return unavailableIntent();
    const candidate = value as SelectedRegistryIntent;
    if (candidate.version !== 1 || candidate.kind !== "shadow") return unavailableIntent();
    const { input, instanceName } = candidate;
    if (!input || typeof input !== "object" || Array.isArray(input)) return unavailableIntent();
    const { cliPath, envPath, configuredPath, expectedDigest, contractVersion, requiredCapabilities, maxBytes, timeoutMs } = input;
    const capabilities = requiredCapabilities === undefined ? undefined : Array.isArray(requiredCapabilities) ? [...requiredCapabilities] : null;
    if ([cliPath, envPath, configuredPath, expectedDigest, instanceName].some(v => v !== undefined && typeof v !== "string")
      || [contractVersion, maxBytes, timeoutMs].some(v => v !== undefined && typeof v !== "number")
      || capabilities === null || capabilities?.some(v => typeof v !== "string")) return unavailableIntent();
    return Object.freeze({ kind: "shadow", version: 1, instanceName, input: Object.freeze({ cliPath, envPath, configuredPath,
      expectedDigest, contractVersion, maxBytes, timeoutMs,
      ...(capabilities === undefined ? {} : { requiredCapabilities: Object.freeze(capabilities) }) }) });
  } catch {
    // Malformed/unreadable transport cannot establish identity; never serialize its exception or substitute a real port.
    return unavailableIntent();
  }
}

export function captureSelectedRegistryIntent(options: SelectedRegistryConsumerOptions | undefined): SelectedRegistryIntent | undefined {
  const captured = capture(options);
  if (captured.kind === "off") return undefined;
  if (captured.kind !== "selected" || !captured.transferable) return unavailableIntent();
  const { signal: _signal, ...input } = captured.input;
  return copySelectedRegistryIntent({ kind: "shadow", version: 1, input, instanceName: captured.name });
}

export function selectedRegistryObserverFromIntent(intent: unknown, record: RegistryObservationSink): SelectedRegistryObserver | undefined {
  const copied = copySelectedRegistryIntent(intent);
  if (copied === undefined) return undefined;
  if (copied.kind === "unknown") return consumerObserver({ kind: "unknown", record }, readSelectedInstanceRegistry, "transport_unavailable");
  return createSelectedRegistryObserver({ settings: { mode: "shadow", instanceName: copied.instanceName }, input: copied.input, record });
}

function targetSnapshot(target: RegistryConsumerTarget, name: string | undefined, lifecycle = false): {
  fields: Readonly<Record<string, string>>; repository?: string; instanceName?: string; reason?: string;
  stateRoot?: string; containerName?: string; namespace?: "host" | "container";
} {
  try {
    const repository = target.repository, selectedName = target.instanceName;
    const stateRoot = target.stateRoot, containerName = target.containerName, namespace = target.namespace;
    if (stateRoot !== undefined && (typeof stateRoot !== "string" || !stateRoot.startsWith("/") || stateRoot.includes("\0"))) {
      return { fields: {}, reason: "invalid_state_root" };
    }
    if (containerName !== undefined && (typeof containerName !== "string" || !/^[A-Za-z0-9_.-]+$/.test(containerName))) {
      return { fields: {}, reason: "invalid_container" };
    }
    if (namespace !== undefined && namespace !== "host" && namespace !== "container") return { fields: {}, reason: "namespace_unverified" };
    const instanceName = lifecycle || Object.hasOwn(target, "instanceName") ? selectedName : selectedName ?? name;
    if (Object.hasOwn(target, "instanceName") && instanceName === undefined && repository === undefined) return { fields: {}, reason: "target_unavailable" };
    if (repository !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return { fields: {}, reason: "invalid_repository" };
    if (instanceName !== undefined && !/^[A-Za-z0-9_-]+$/.test(instanceName)) return { fields: {}, reason: "invalid_instance" };
    return { repository: repository?.toLowerCase(), instanceName, stateRoot, containerName, namespace,
      fields: Object.freeze({ ...(repository === undefined ? {} : { target_repo: repository.toLowerCase() }),
        ...(instanceName === undefined ? {} : { target_instance: instanceName }) }) };
  } catch {
    // A hostile target is unknown identity, not arbitrary text for the receipt or a fallback target.
    return { fields: {}, reason: "target_unreadable" };
  }
}

/** Bounded SHADOW observations, independent of the result, exception and timing of the legacy effect. */
export function createSelectedRegistryObserver(options: SelectedRegistryConsumerOptions | undefined,
  reader: RegistryConsumerRead = readSelectedInstanceRegistry): SelectedRegistryObserver | undefined {
  return consumerObserver(capture(options), reader);
}

function consumerObserver(captured: Captured, reader: RegistryConsumerRead, unavailableReason = "input_unreadable"): SelectedRegistryObserver | undefined {
  if (captured.kind === "off") return undefined;
  const controller = new AbortController();
  let signal = controller.signal, invalidCancellation = false;
  try {
    if (captured.kind === "selected" && captured.input.signal) signal = AbortSignal.any([controller.signal, captured.input.signal]);
  } catch {
    // Invalid cancellation evidence is unknown, not a constructor failure that blocks the legacy consumer.
    invalidCancellation = true;
  }
  let closed = false, diagnosticSent = false, sinkPending = 0;
  const pending = new Set<Promise<void>>(), keys = new Set<string>();
  const lifecycleFailures = new Map<string, Evidence>();
  const unavailable = (): void => {
    if (diagnosticSent) return;
    diagnosticSent = true;
    try { console.error("instance_registry.consumer_shadow_unrecorded"); }
    catch {
      // A failed diagnostic channel is still unrecorded; it must never replace the legacy effect.
    }
  };
  const read = async (): Promise<Bound> => {
    if (invalidCancellation) return { kind: "unknown", reason: "invalid_cancellation" };
    if (captured.kind !== "selected") return { kind: "unknown", reason: unavailableReason };
    try {
      const result = await reader({ ...captured.input, signal }, captured.io);
      if (result.kind !== "ready") return { kind: "unknown", reason: result.kind === "legacy" ? "selection_missing" : result.reason };
      // Preserve the reader's input bounds; require our identity capability on its returned contract, not by growing caller input.
      if (!result.binding.capabilities.includes("identity")) return { kind: "unknown", reason: "identity_capability_missing" };
      return result;
    } catch {
      // A rejected custom port remains unknown, never cached/legacy selected authority.
      return { kind: "unknown", reason: "source_read_rejected" };
    }
  };
  let held: Promise<Bound> | undefined, lifecycleHeld: Promise<Bound> | undefined, retryNeeded = false;
  const current = async (original: Promise<Bound>, target: ReturnType<typeof targetSnapshot>, action: RegistryConsumerAction): Promise<Evidence> => {
    if (target.reason) return unknown(target.reason);
    const bound = await original;
    if (bound.kind !== "ready") {
      // Retry only at the NEXT real consumer event, never an inbox scan or timer. No ready identity existed to pin.
      if (held === original) retryNeeded = true;
      return unknown(bound.reason);
    }
    const digest = bound.binding.digest;
    const identity = Object.freeze({ binding_digest: digest, selection_source: bound.binding.source,
      contract_version: bound.binding.contractVersion, capabilities: Object.freeze([...bound.binding.capabilities]) });
    try {
      const checked = await bound.binding.recheck(signal);
      if (checked.kind !== "unchanged") return { ...unknown("reason" in checked ? checked.reason : "revision_changed", digest), ...identity };
    } catch {
      // A failed final recheck is unknown; the original ready digest is not permission to borrow a healthy cache.
      return { ...unknown("recheck_failed", digest), ...identity };
    }
    const rows = bound.binding.instances.filter(row => (target.instanceName === undefined || row.name === target.instanceName)
      && (target.repository === undefined || row.repo.toLowerCase() === target.repository));
    if (rows.length === 0) return { selected_state: "absent", reason: "target_absent", ...identity };
    if (rows.every(row => !row.live)) return { selected_state: "retired", reason: "target_retired", ...identity };
    const lifecycle = isLifecycleAction(action);
    if (lifecycle && (target.stateRoot === undefined || target.instanceName === undefined)) {
      return { ...unknown("target_unavailable", digest), ...identity };
    }
    if (action === "deploy-recycle" && target.containerName === undefined) return { ...unknown("target_unavailable", digest), ...identity };
    if (lifecycle && rows.length !== 1) return { ...unknown("target_ambiguous", digest), ...identity };
    if (target.stateRoot !== undefined) {
      if (target.namespace !== "host") return { ...unknown("namespace_unverified", digest), ...identity };
      if (target.instanceName === undefined || bound.binding.matchesLifecycleTarget === undefined) {
        return { ...unknown("lifecycle_binding_unavailable", digest), ...identity };
      }
      if (!bound.binding.matchesLifecycleTarget(target.instanceName, target.stateRoot, target.containerName)) {
        return { ...unknown("state_root_unverified", digest), ...identity };
      }
    }
    return { selected_state: "ready", ...identity };
  };
  const report = (action: RegistryConsumerAction, target: ReturnType<typeof targetSnapshot>, evidence: Evidence, threw: boolean): void => {
    if (closed) return;
    const fields = Object.freeze({ mode: "shadow", action, ...target.fields, ...evidence,
      legacy_outcome: threw ? "threw" : "returned", publication_permission: "not-granted" });
    const key = JSON.stringify(fields);
    if (keys.has(key)) return;
    if (typeof captured.record !== "function" || sinkPending >= LIMIT) return unavailable();
    try {
      const result = captured.record("instance_registry.consumer_shadow_observed", fields);
      if (keys.size >= LIMIT) keys.delete(keys.values().next().value!);
      keys.add(key);
      sinkPending++;
      void Promise.resolve(result).catch(() => {
        // A rejected sink is unrecorded/unknown, not durable success. Allow a later consumer to retry this key.
        keys.delete(key); unavailable();
      }).finally(() => { sinkPending--; });
    } catch {
      // A throwing sink is unrecorded. SHADOW never converts it into a public error or effect gate.
      unavailable();
    }
  };
  const queue = (action: RegistryConsumerAction, target: ReturnType<typeof targetSnapshot>, threw: boolean, original: Promise<Bound>): void => {
    if (closed) return;
    if (pending.size >= LIMIT) { report(action, target, unknown("observation_capacity"), threw); return; }
    const work = current(original, target, action).catch(() => {
      // A failed observation is pinned unknown just like a failed read or final recheck.
      return unknown("observation_failed");
    }).then(evidence => {
      if (isLifecycleAction(action)) {
        const key = JSON.stringify([target.instanceName, target.repository, target.stateRoot, target.containerName, target.namespace]);
        const prior = lifecycleFailures.get(key);
        if (prior) evidence = prior;
        else if (lifecycleFailures.size >= LIMIT) evidence = unknown("observation_capacity");
        else if (evidence.selected_state !== "ready") lifecycleFailures.set(key, evidence);
      }
      report(action, target, evidence, threw);
    }).finally(() => pending.delete(work));
    pending.add(work);
  };
  return Object.freeze({
    observe: async <T>(action: RegistryConsumerAction, target: RegistryConsumerTarget, operation: () => T | Promise<T>): Promise<T> => {
      const capturedTarget = targetSnapshot(target, captured.kind === "selected" ? captured.name : undefined, isLifecycleAction(action));
      let original: Promise<Bound>;
      if (isLifecycleAction(action)) {
        // Recovery belongs to the original invocation. A later healthy registry cannot repair its unknown evidence.
        original = lifecycleHeld ??= read();
      } else {
        if (held === undefined || retryNeeded) { held = read(); retryNeeded = false; }
        original = held;
      }
      let result: T;
      try { result = await operation(); }
      catch (error) { queue(action, capturedTarget, true, original); throw error; }
      queue(action, capturedTarget, false, original); return result;
    },
    observeSync: <T>(action: RegistryConsumerAction, target: RegistryConsumerTarget, operation: () => T): T => {
      const snapshot = targetSnapshot(target, captured.kind === "selected" ? captured.name : undefined, isLifecycleAction(action));
      try { const result = operation(); report(action, snapshot, unknown(snapshot.reason ?? "synchronous_seam"), false); return result; }
      catch (error) { report(action, snapshot, unknown(snapshot.reason ?? "synchronous_seam"), true); throw error; }
    },
    settled: async (): Promise<void> => { await Promise.all([...pending]); },
    close: (): void => { closed = true; controller.abort(); keys.clear(); lifecycleFailures.clear(); },
  });
}

export function observeSelectedRegistry<T>(observer: SelectedRegistryObserver | undefined, action: RegistryConsumerAction,
  target: RegistryConsumerTarget, operation: () => T, synchronous: true): T;
export function observeSelectedRegistry<T>(observer: SelectedRegistryObserver | undefined, action: RegistryConsumerAction,
  target: RegistryConsumerTarget, operation: () => T | Promise<T>): Promise<T>;
export function observeSelectedRegistry<T>(observer: SelectedRegistryObserver | undefined, action: RegistryConsumerAction,
  target: RegistryConsumerTarget, operation: () => T | Promise<T>, synchronous?: true): T | Promise<T> {
  if (synchronous) return observeSelectedRegistrySync(observer, action, target, operation);
  return (async () => observer === undefined ? operation() : observer.observe(action, target, operation))();
}

export function observeSelectedRegistrySync<T>(observer: SelectedRegistryObserver | undefined, action: RegistryConsumerAction,
  target: RegistryConsumerTarget, operation: () => T): T {
  return observer === undefined ? operation() : observer.observeSync(action, target, operation);
}
