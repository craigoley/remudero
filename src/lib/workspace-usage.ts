/** Bounded metadata observations of declared generated roots. Never follows links, deletes,
 * schedules work or calls a missing measurement zero. APFS path blocks are not unique disk cost. */
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, statfsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
    } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "unrecorded" : "unknown"; }
    finally { if (fd !== undefined) closeSync(fd); }
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown"; }
}

export function sampleWorkspaceUsage(workspace: string, opts: { roots?: readonly string[]; maxEntries?: number;
  maxMs?: number; now?: () => number } = {}): WorkspaceUsageSample {
  const now = opts.now ?? (() => performance.now()), start = now();
  const maxEntries = opts.maxEntries ?? 2000, maxMs = opts.maxMs ?? 20;
  const result: WorkspaceUsageSample = { generatedPathBytes: null, completeness: "unknown", entries: 0, durationMs: 0,
    hostFreeBytes: null, dependencyMethod: "unknown", reasons: [], warning: null };
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxMs) || maxMs <= 0) {
    result.reasons.push("invalid-sampling-bound"); return result;
  }
  let root: string;
  try { root = realpathSync(workspace); }
  catch { result.reasons.push("workspace-unreadable"); return result; }
  try {
    const fs = statfsSync(root), available = fs.bavail * fs.bsize;
    if (Number.isSafeInteger(available) && available >= 0) result.hostFreeBytes = available;
  } catch { result.reasons.push("host-free-unavailable"); }
  result.dependencyMethod = dependencyMethod(root);
  let total = 0, observed = false, incomplete = false;
  const seen = new Set<string>();
  const budget = () => result.entries < maxEntries && now() - start < maxMs;
  for (const name of opts.roots ?? GENERATED_WORKSPACE_ROOTS) {
    if (!budget()) { incomplete = true; result.reasons.push("sampling-bound"); break; }
    const path = resolve(root, name), rel = relative(root, path);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      incomplete = true; result.reasons.push("generated-root-outside-workspace"); continue;
    }
    try {
      let cursor = root, linked = false;
      for (const part of rel.split(sep)) {
        if (!budget()) { incomplete = true; linked = true; break; }
        cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) { linked = true; break; }
      }
      if (linked) { incomplete = true; result.reasons.push(`borrowed-root:${name}`); continue; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { observed = true; continue; }
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
      } catch { incomplete = true; result.reasons.push("entry-unreadable-or-changed"); }
    }
    if (!budget()) break;
  }
  result.generatedPathBytes = observed ? total : null;
  result.completeness = observed ? incomplete ? "lower-bound" : "complete" : "unknown";
  result.durationMs = Math.max(0, now() - start);
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
