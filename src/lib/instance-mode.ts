import { readFileSync } from "node:fs";
import type { SelectedModeSettings } from "./config-schema.js";
export type { SelectedModeSettings } from "./config-schema.js";

import { daemonInstanceRegistryPath } from "./deployer.js";
import { parseInstanceRegistry } from "./instance-registry.js";
import { readSelectedInstanceRegistry, registryFileIO, type RegistryFileIO,
  runtimeInstanceRegistryText, runtimeInstanceRegistryMode, assertInstanceRegistryRuntimeCurrent,
  type RegistrySelectionInput, type SelectedRegistryBinding } from "./instance-registry-selection.js";

/** A missing or malformed registry never invents a shadow declaration. */
export function instanceMode(ownerRepo: string, registryText: string | undefined): "shadow" | "live" {
  const selected = runtimeInstanceRegistryMode(ownerRepo);
  if (selected !== undefined) return selected;
  if (registryText === undefined) return "live";
  try {
    const registry = parseInstanceRegistry(registryText);
    const match = registry.instances.find((instance) => instance.repo.toLowerCase() === ownerRepo.toLowerCase());
    return match?.mode ?? "live";
  } catch {
    // Invalid text grants no shadow declaration. Preserve the documented absent-mode live policy.
    return "live";
  }
}

/** A missing or unreadable registry is unknown text, which resolves to live above. */
export function readInstanceRegistryText(repoRoot: string): string | undefined {
  const selected = runtimeInstanceRegistryText();
  if (selected !== undefined) return selected;
  try {
    return readFileSync(daemonInstanceRegistryPath(repoRoot), "utf8");
  } catch {
    // A missing/unreadable registry cannot establish shadow mode; legacy installs remain live.
    return undefined;
  }
}

export interface SelectedModeInput extends RegistrySelectionInput { instanceName?: string }
export type SelectedModeAction = "run-arm" | "sweep-arm" | "arm" | "direct-merge" | "queue";
type ModeEvidence = {
  selected_outcome: "would-refuse" | "would-shadow" | "would-live";
  reason?: string;
  binding_digest?: string;
};
type BoundMode = { kind: "ready"; mode: "shadow" | "live"; binding: SelectedRegistryBinding }
  | { kind: "unknown"; evidence: ModeEvidence };
export interface SelectedModeQualification {
  observe<T>(action: SelectedModeAction, operation: () => T | Promise<T>, prUrl?: string): Promise<T>;
  observeSync<T>(action: SelectedModeAction, operation: () => T, prUrl?: string): T;
}
const unavailable = (reason: string, digest?: string): ModeEvidence => ({
  selected_outcome: "would-refuse", reason, ...(digest === undefined ? {} : { binding_digest: digest }),
});

function modeTarget(ownerRepo: string, prUrl: string | undefined): {
  fields: Readonly<Record<string, string | number>>; reason?: string;
} {
  const match = typeof prUrl === "string"
    ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(prUrl) : null;
  if (!match || !Number.isSafeInteger(Number(match[3]))) return { fields: Object.freeze({}), reason: "target_unavailable" };
  const repo = `${match[1]}/${match[2]}`.toLowerCase();
  return { fields: Object.freeze({ target_repo: repo, target_pr: Number(match[3]) }),
    ...(repo !== ownerRepo.toLowerCase() ? { reason: "target_mismatch" } : {}) };
}

function immutableModeIO(io: RegistryFileIO): RegistryFileIO {
  const lstat = io.lstat.bind(io), open = io.open.bind(io);
  return Object.freeze({ lstat, open: async (path: string) => {
    const handle = await open(path);
    return Object.freeze({ stat: handle.stat.bind(handle), read: handle.read.bind(handle), close: handle.close.bind(handle) });
  } });
}

async function bindMode(ownerRepo: string, name: string | undefined, input: RegistrySelectionInput, io: RegistryFileIO): Promise<BoundMode> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ownerRepo)) return { kind: "unknown", evidence: unavailable("invalid_repository") };
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) return { kind: "unknown", evidence: unavailable("invalid_instance") };
  const read = await readSelectedInstanceRegistry(input, io);
  if (read.kind !== "ready") return { kind: "unknown", evidence: unavailable(read.kind === "legacy" ? "selection_missing" : read.reason) };
  const matching = read.binding.instances.filter(row => row.name === name && row.repo.toLowerCase() === ownerRepo.toLowerCase());
  if (matching.length !== 1) return { kind: "unknown", evidence: unavailable("instance_missing_or_ambiguous", read.binding.digest) };
  const row = matching[0]!;
  if (!row.live) return { kind: "unknown", evidence: unavailable("instance_retired", read.binding.digest) };
  if (row.mode === undefined) return { kind: "unknown", evidence: unavailable("mode_missing", read.binding.digest) };
  return { kind: "ready", mode: row.mode, binding: read.binding };
}

/** Optional observation only: preserve the independent legacy effect, not selected permission. */
export function createSelectedModeQualification(
  settings: SelectedModeSettings | undefined, ownerRepo: string, input: SelectedModeInput,
  record: (step: string, fields: Record<string, unknown>) => void, io: RegistryFileIO = registryFileIO,
  reading: "async" | "sync" = "async",
): SelectedModeQualification | undefined {
  let initial: Promise<BoundMode>;
  let signal: AbortSignal | undefined;
  try {
    if (settings?.mode !== "shadow") return undefined;
    const name = input.instanceName === undefined ? settings.instanceName : input.instanceName;
    const required = input.requiredCapabilities;
    const snapshot: RegistrySelectionInput = {
      cliPath: input.cliPath, envPath: input.envPath,
      configuredPath: input.configuredPath === undefined ? settings.registryPath : input.configuredPath,
      contractVersion: input.contractVersion ?? settings.contractVersion,
      requiredCapabilities: required === undefined ? ["identity", "mode"] : [...required, "identity", "mode"],
      expectedDigest: input.expectedDigest, maxBytes: input.maxBytes ?? settings.maxBytes,
      timeoutMs: input.timeoutMs ?? settings.timeoutMs, signal: input.signal,
    };
    signal = snapshot.signal;
    initial = reading === "sync" ? Promise.resolve({ kind: "unknown", evidence: unavailable("synchronous_seam") })
      : bindMode(ownerRepo, name, snapshot, immutableModeIO(io));
  } catch {
    // Unreadable inputs/ports cannot establish selected evidence; the legacy effect still runs.
    initial = Promise.resolve({ kind: "unknown", evidence: unavailable("input_unreadable") });
  }
  initial = initial.catch(() => ({ kind: "unknown" as const, evidence: unavailable("read_failed") }));
  const current = async (): Promise<ModeEvidence> => {
    const bound = await initial;
    if (bound.kind === "unknown") return bound.evidence;
    try {
      const recheck = await bound.binding.recheck(signal);
      if (recheck.kind !== "unchanged") return unavailable("reason" in recheck ? recheck.reason : "revision_changed", bound.binding.digest);
      return { selected_outcome: bound.mode === "shadow" ? "would-shadow" : "would-live", binding_digest: bound.binding.digest };
    } catch {
      // A rejected transport is still unknown, never a cached ready mode or a legacy fallback.
      return unavailable("recheck_failed", bound.binding.digest);
    }
  };
  let lastKey: string | undefined, recordFailureReported = false;
  const recordFailed = (): void => {
    if (!recordFailureReported) {
      try { console.error("instance_mode.shadow_observation_unrecorded"); }
      catch {
        // Even an unavailable diagnostic channel cannot replace the independent effect/result.
      }
    }
    recordFailureReported = true;
  };
  const report = (action: SelectedModeAction, evidence: ModeEvidence, result: unknown,
    target: ReturnType<typeof modeTarget>, threw = false): void => {
    let outcome: unknown = result;
    try {
      if (typeof result === "object" && result !== null) outcome = Object.getOwnPropertyDescriptor(result, "outcome")?.value;
    } catch {
      // A hostile result/proxy is unreadable observation data, not a reason to change its effect.
      outcome = "result-unreadable";
    }
    const known = new Set(["armed", "direct-merged", "no-task-id", "head-unavailable", "ledger-refused",
      "direct-merge-failed", "direct-merge-updated", "direct-merge-preflight-refused", "direct-merge-update-failed",
      "arm-error-ignored", "irreversible-refused", "hold-refused", "draft-refused", "stack-parent-refused",
      "plan-pr-held", "shadow-refused", "shadow-instance-refused", "no-merge-boundary-refused", "result-unreadable"]);
    const legacy = threw ? "threw" : typeof outcome === "string" && known.has(outcome) ? outcome : "returned";
    const fields = Object.freeze({ mode: "shadow", action, ...evidence, ...target.fields,
      legacy_outcome: legacy, publication_permission: "not-granted" });
    const key = JSON.stringify(fields);
    if (key === lastKey) return;
    try {
      const pending: unknown = record("instance_mode.shadow_observed", fields);
      lastKey = key; recordFailureReported = false;
      if (pending !== undefined) void Promise.resolve(pending).catch(() => {
        // A rejected receipt is unknown/unrecorded, never durable evidence. Allow a later
        // retry and emit the same bounded, private-safe sink diagnostic; effects stay unchanged.
        if (lastKey === key) lastKey = undefined;
        recordFailed();
      });
    }
    catch {
      // An unavailable observation sink is unknown. SHADOW must not become an effect gate.
      recordFailed();
    }
  };
  return Object.freeze({
    observe: async <T>(action: SelectedModeAction, operation: () => T | Promise<T>, prUrl?: string): Promise<T> => {
      const target = modeTarget(ownerRepo, prUrl);
      const evidence = target.reason === undefined ? await current() : unavailable(target.reason);
      let result: T;
      try { result = await operation(); }
      catch (error) { report(action, evidence, undefined, target, true); throw error; }
      report(action, evidence, result, target); return result;
    },
    observeSync: <T>(action: SelectedModeAction, operation: () => T, prUrl?: string): T => {
      const target = modeTarget(ownerRepo, prUrl);
      let result: T;
      try { result = operation(); }
      catch (error) { report(action, unavailable(target.reason ?? "synchronous_seam"), undefined, target, true); throw error; }
      report(action, unavailable(target.reason ?? "synchronous_seam"), result, target); return result;
    },
  });
}

export async function observeSelectedMode<T>(
  qualification: SelectedModeQualification | undefined, action: SelectedModeAction, operation: () => T | Promise<T>, prUrl?: string,
): Promise<T> {
  if (runtimeInstanceRegistryText() !== undefined) await assertInstanceRegistryRuntimeCurrent();
  return qualification === undefined ? operation() : qualification.observe(action, operation, prUrl);
}
