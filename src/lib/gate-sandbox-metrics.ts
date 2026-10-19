import { closeSync, constants, fstatSync, openSync, opendirSync, readFileSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export interface GateSandboxCost {
  tmp_peak_bytes: number;
  tmp_peak_scope: "boundary-sampled";
  compile_cache: { files_start: number; files_end: number; bytes_start: number; bytes_end: number; start_scope: "after-module-load" };
  max_rss_kb: number;
  cpu_ms: number;
  resource_scope: "preflight-process";
}
export type GateSandboxMeasurement = { sandbox: GateSandboxCost } | { sandbox_unmeasured: string };
type CacheSize = { files: number; bytes: number };
export interface GateSandboxSources {
  tmp: () => number;
  cache: () => CacheSize;
  usage: () => Pick<NodeJS.ResourceUsage, "maxRSS" | "userCPUTime" | "systemCPUTime">;
}
const finiteSize = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const reason = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 220);

/** Only the dedicated, unshared tmpfs mount the trusted gate requested is a sandbox /tmp reading. */
export function privateTmpBytes(
  root = tmpdir(),
  mountInfo = () => readFileSync("/proc/self/mountinfo", "utf8"),
  statistics = () => statfsSync(root, { bigint: true }),
): number {
  if (root !== "/tmp") throw Error("temporary directory is not the private sandbox /tmp");
  const mounts = mountInfo();
  if (mounts.length > 256 * 1024) throw Error("mount table exceeds measurement budget");
  const mount = mounts.split("\n").find(line => line.split(" ")[4] === "/tmp");
  const [left, right] = (mount ?? "").split(" - ");
  if (!left || left.split(" ")[3] !== "/" || right === undefined || !right.startsWith("tmpfs ") || left.split(" ").slice(6).some(field => /^(shared|master|propagate_from):/.test(field))) {
    throw Error("/tmp is not a dedicated private tmpfs mount");
  }
  const stat = statistics();
  if (stat.type !== 0x01021994n) throw Error("/tmp filesystem is not tmpfs");
  const bytes = Number((stat.blocks - stat.bfree) * stat.bsize);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error("invalid /tmp filesystem reading");
  return bytes;
}

/** Enumerate only this uid's tsx cache. A partial or symlinked tree is unknown, never a smaller total. */
export function compileCacheSize(
  root = join(tmpdir(), `tsx-${process.geteuid?.() ?? 0}`), maxEntries = 10_000, now = () => performance.now(),
  platform: NodeJS.Platform = process.platform,
): CacheSize {
  if (platform !== "linux") throw Error("cache measurement requires Linux descriptor-backed directories");
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let first: number;
  try { first = openSync(root, flags, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: 0, bytes: 0 }; throw error; }
  const started = now(), pending = [first];
  const fdPath = (fd: number) => `/proc/self/fd/${fd}`;
  let entries = 0, files = 0, bytes = 0;
  try {
    while (pending.length) {
      const fd = pending.pop()!;
      try {
        // The kernel descriptor path pins the directory even if a child replaces its pathname.
        const dir = opendirSync(fdPath(fd));
        try {
          for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
            if (++entries > maxEntries || now() - started > 100) throw Error("compile cache enumeration exceeds measurement budget");
            if (entry.isSymbolicLink()) throw Error("compile cache contains a symlink; enumeration incomplete");
            // Open once without creating or following links; nonblocking also bounds a replaced FIFO.
            const child = openSync(join(fdPath(fd), entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
            let queued = false;
            try {
              const stat = fstatSync(child);
              if (stat.isDirectory()) { pending.push(child); queued = true; }
              else if (stat.isFile()) { files++; bytes += stat.size; }
              else throw Error("compile cache contains a non-file; enumeration incomplete");
            } finally { if (!queued) closeSync(child); }
          }
        } finally { dir.closeSync(); }
      } finally { closeSync(fd); }
    }
  } finally { for (const fd of pending) closeSync(fd); }
  return { files, bytes };
}

/** Boundary samples do not claim to observe transient peaks inside a synchronous child. */
export function createGateSandboxMetrics(sources: Partial<GateSandboxSources> = {}) {
  const source = { tmp: privateTmpBytes, cache: compileCacheSize, usage: () => process.resourceUsage(), ...sources };
  let unknown: string | undefined, peak = 0, start: CacheSize | undefined;
  const sample = () => {
    try {
      const bytes = source.tmp();
      if (!finiteSize(bytes)) throw Error("invalid /tmp boundary sample");
      peak = Math.max(peak, bytes);
    } catch (error) { const unreadable = reason(error); unknown ??= unreadable; }
  };
  sample();
  try { start = source.cache(); } catch (error) { const unreadable = reason(error); unknown ??= unreadable; }
  return {
    boundary: sample,
    observe<T>(run: () => T): T { try { return run(); } finally { sample(); } },
    finish(): GateSandboxMeasurement {
      sample();
      try {
        const end = source.cache(), usage = source.usage();
        if (!start || ![start.files, start.bytes, end.files, end.bytes, usage.maxRSS, usage.userCPUTime, usage.systemCPUTime].every(finiteSize)) {
          throw Error("incomplete compile cache or process resource reading");
        }
        if (unknown !== undefined) return { sandbox_unmeasured: unknown };
        return { sandbox: {
          tmp_peak_bytes: peak, tmp_peak_scope: "boundary-sampled",
          compile_cache: { files_start: start.files, files_end: end.files, bytes_start: start.bytes, bytes_end: end.bytes, start_scope: "after-module-load" },
          max_rss_kb: usage.maxRSS, cpu_ms: (usage.userCPUTime + usage.systemCPUTime) / 1000, resource_scope: "preflight-process",
        } };
      } catch (error) { const unreadable = unknown ?? reason(error); return { sandbox_unmeasured: unreadable }; }
    },
  };
}

/** Validate the trusted child's transport; missing, partial and non-finite data are not zeroes. */
export function parseGateSandboxMeasurement(value: unknown): GateSandboxMeasurement {
  const missing = { sandbox_unmeasured: "the child wrote no complete sandbox measurement" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return missing;
  const data = value as Record<string, unknown>;
  if (typeof data.sandbox_unmeasured === "string" && data.sandbox_unmeasured.trim() && data.sandbox === undefined) {
    return { sandbox_unmeasured: data.sandbox_unmeasured.slice(0, 220) };
  }
  const s = data.sandbox as Partial<GateSandboxCost> | undefined, c = s?.compile_cache;
  if (data.sandbox_unmeasured !== undefined || !s || !c || s.tmp_peak_scope !== "boundary-sampled" || c.start_scope !== "after-module-load" || s.resource_scope !== "preflight-process" ||
      ![s.tmp_peak_bytes, c.files_start, c.files_end, c.bytes_start, c.bytes_end, s.max_rss_kb, s.cpu_ms].every(finiteSize)) return missing;
  return { sandbox: {
    tmp_peak_bytes: s.tmp_peak_bytes!, tmp_peak_scope: "boundary-sampled",
    compile_cache: { files_start: c.files_start, files_end: c.files_end, bytes_start: c.bytes_start, bytes_end: c.bytes_end, start_scope: "after-module-load" },
    max_rss_kb: s.max_rss_kb!, cpu_ms: s.cpu_ms!, resource_scope: "preflight-process",
  } };
}
