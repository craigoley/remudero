/** Bounded metadata observations of declared generated roots. Never follows links, deletes,
 * schedules work or calls a missing measurement zero. APFS path blocks are not unique disk cost. */
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, statfsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { clockFromMillisFn, type Clock } from "./clock.js";

// Elapsed budgets use a monotonic source through the shared clock port; no wall timestamps escape.
const samplingClock = clockFromMillisFn(() => performance.now());

export interface WorkspaceUsageSample {
  generatedPathBytes: number | null;
  completeness: "complete" | "lower-bound" | "unknown";
  entries: number;
  durationMs: number;
  hostFreeBytes: number | null;
  dependencyMethod: "borrowed-link" | "apfs-clone" | "private-copy" | "readonly-links" | "unrecorded" | "missing" | "unknown";
  reasons: string[];
  warning: "observed-generated-at-least-1GiB" | null;
}
export interface WorkspaceUsageEvidence {
  version: "workspace-usage-v1";
  sampling: "phase-boundaries";
  generatedPeakObservedBytes: number | null;
  completeness: WorkspaceUsageSample["completeness"];
  cleanup: "confirmed" | "failed" | "unknown";
  samples: WorkspaceUsageSample[];
}
export interface WorkspaceScratchRoot { path: string; dev: number; ino: number; uid: number }

/** Register only a producer's existing private directory. This observation grants no deletion authority. */
export function pinWorkspaceScratchRoot(path: string): WorkspaceScratchRoot {
  const original = lstatSync(path), canonical = realpathSync(path), st = lstatSync(canonical);
  if (!original.isDirectory() || original.isSymbolicLink() || canonical === resolve(canonical, "..") ||
      !st.isDirectory() || st.isSymbolicLink() || original.dev !== st.dev || original.ino !== st.ino ||
      (process.getuid && st.uid !== process.getuid())) throw new Error("scratch root is not a private owned directory");
  return { path: canonical, dev: st.dev, ino: st.ino, uid: st.uid };
}
export const GENERATED_WORKSPACE_ROOTS = ["coverage", "dist", ".cache", "test-results", "playwright-report", "node_modules/.cache"] as const;

function dependencyMethod(root: string): WorkspaceUsageSample["dependencyMethod"] {
  try {
    const modules = join(root, "node_modules"), st = lstatSync(modules);
    if (st.isSymbolicLink()) return "borrowed-link";
    if (!st.isDirectory()) return "unknown";
    let fd: number | undefined;
    try {
      fd = openSync(join(modules, ".rmd-dependency-seed.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!fstatSync(fd).isFile()) return "unknown";
      const bytes = Buffer.alloc(65537), size = readSync(fd, bytes, 0, bytes.length, 0);
      if (size === bytes.length) return "unknown";
      const method: unknown = (JSON.parse(bytes.subarray(0, size).toString("utf8")) as { method?: unknown }).method;
      return method === "apfs-clone" || method === "private-copy" || method === "readonly-links" ? method : "unknown";
    } catch (error) {
      // An absent marker is unrecorded; an unreadable marker cannot establish a method.
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "unrecorded" : "unknown";
    }
    finally { if (fd !== undefined) closeSync(fd); }
  } catch (error) {
    // Keep a missing install distinct from an install whose metadata cannot be read.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown";
  }
}

export function sampleWorkspaceUsage(workspace: string, opts: { roots?: readonly string[]; scratchRoots?: readonly WorkspaceScratchRoot[]; maxEntries?: number;
  maxMs?: number; clock?: Clock } = {}): WorkspaceUsageSample {
  const clock = opts.clock ?? samplingClock, start = clock.now();
  const maxEntries = opts.maxEntries ?? 2000, maxMs = opts.maxMs ?? 20;
  const result: WorkspaceUsageSample = { generatedPathBytes: null, completeness: "unknown", entries: 0, durationMs: 0,
    hostFreeBytes: null, dependencyMethod: "unknown", reasons: [], warning: null };
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxMs) || maxMs <= 0) {
    result.reasons.push("invalid-sampling-bound"); return result;
  }
  let root: string;
  try { root = realpathSync(workspace); }
  catch {
    // The unavailable observation and its reason reach the caller; this is never an empty root.
    result.reasons.push("workspace-unreadable"); return result;
  }
  try {
    const fs = statfsSync(root), available = fs.bavail * fs.bsize;
    if (Number.isSafeInteger(available) && available >= 0) result.hostFreeBytes = available;
  } catch {
    // Preserve null free space with its reason, so capacity cannot be admitted from this sample.
    result.reasons.push("host-free-unavailable");
  }
  result.dependencyMethod = dependencyMethod(root);
  let total = 0, observed = false, incomplete = false;
  const seen = new Set<string>();
  const budget = () => result.entries < maxEntries && clock.now() - start < maxMs;
  const declared: Array<{ name: string; path: string; owned?: WorkspaceScratchRoot }> =
    (opts.roots ?? GENERATED_WORKSPACE_ROOTS).map(name => ({ name, path: resolve(root, name) }));
  for (const [index, owned] of (opts.scratchRoots ?? []).entries())
    declared.push({ name: `external-scratch:${index}`, path: owned.path, owned });
  for (const { name, path, owned } of declared) {
    if (!budget()) { incomplete = true; result.reasons.push("sampling-bound"); break; }
    const rel = relative(root, path);
    if (!owned && (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))) {
      incomplete = true; result.reasons.push("generated-root-outside-workspace"); continue;
    }
    try {
      if (owned) {
        const current = lstatSync(path);
        if (!isAbsolute(path) || realpathSync(path) !== path || !current.isDirectory() || current.isSymbolicLink() ||
            current.dev !== owned.dev || current.ino !== owned.ino || current.uid !== owned.uid ||
            (process.getuid && current.uid !== process.getuid())) throw new Error("scratch identity changed");
      } else {
        let cursor = root, linked = false;
        for (const part of rel.split(sep)) {
          if (!budget()) { incomplete = true; linked = true; break; }
          cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) { linked = true; break; }
        }
        if (linked) { incomplete = true; result.reasons.push(`borrowed-root:${name}`); continue; }
      }
    } catch (error) {
      // Only ENOENT proves an empty root; other failures retain a lower bound and their reason.
      if (!owned && (error as NodeJS.ErrnoException).code === "ENOENT") { observed = true; continue; }
      incomplete = true; result.reasons.push(`root-unreadable:${name}`); continue;
    }
    const stack = [path];
    while (stack.length) {
      if (!budget()) { incomplete = true; result.reasons.push("sampling-bound"); break; }
      const item = stack.pop()!;
      try {
        const st = lstatSync(item); result.entries++; observed = true;
        const key = `${st.dev}:${st.ino}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (st.isSymbolicLink()) { incomplete = true; continue; }
        total += st.blocks * 512;
        if (st.isDirectory()) {
          const dir = opendirSync(item);
          try {
            let entry;
            while ((entry = dir.readSync()) !== null) {
              if (!budget() || stack.length + result.entries >= maxEntries) { incomplete = true; break; }
              stack.push(join(item, entry.name));
            }
          } finally { dir.closeSync(); }
        }
      } catch {
        // Partial bytes remain a lower bound and the failed observation is named in the sample.
        incomplete = true; result.reasons.push("entry-unreadable-or-changed");
      }
    }
    if (!budget()) break;
  }
  result.generatedPathBytes = observed ? total : null;
  result.completeness = observed ? incomplete ? "lower-bound" : "complete" : "unknown";
  result.durationMs = Math.max(0, clock.now() - start);
  result.warning = workspaceSizeWarning(total);
  return result;
}

export function workspaceSizeWarning(bytes: number): WorkspaceUsageSample["warning"] {
  return Number.isSafeInteger(bytes) && bytes >= 1024 ** 3 ? "observed-generated-at-least-1GiB" : null;
}

/** Caller supplies the existing profile's floor and reservations. No default cap or live policy change. */
export function assessWorkspaceDiskBudget(availableBytes: number | null, profile: {
  minimumFreeBytes: number; reservedBytes: number; estimatedPeakBytes: number;
}): "admitted" | "not-run-disk-capacity" | "unknown" {
  const values = [availableBytes, profile.minimumFreeBytes, profile.reservedBytes, profile.estimatedPeakBytes];
  if (!values.every((value) => value !== null && Number.isSafeInteger(value) && value >= 0)) return "unknown";
  return availableBytes! - profile.reservedBytes - profile.estimatedPeakBytes >= profile.minimumFreeBytes ? "admitted" : "not-run-disk-capacity";
}

export function workspaceUsageEvidence(samples: WorkspaceUsageSample[], cleanup: WorkspaceUsageEvidence["cleanup"] = "unknown"): WorkspaceUsageEvidence {
  const measured = samples.flatMap((sample) => sample.generatedPathBytes === null ? [] : [sample.generatedPathBytes]);
  return { version: "workspace-usage-v1", sampling: "phase-boundaries", samples, cleanup,
    generatedPeakObservedBytes: measured.length ? Math.max(...measured) : null,
    completeness: samples.length > 0 && samples.every((sample) => sample.completeness === "complete") ? "complete" : measured.length ? "lower-bound" : "unknown" };
}
